// Package acoustic measures how loud a recording is over time.
//
// It exists because the evidence layer could only say what was said and what was
// on screen. Loudness is the third axis a cut is judged on: an audience's laugh,
// a crowd's cheer and a score's swell are all energy excursions, and without them
// "find the moment the crowd went wild" has nothing to retrieve.
//
// This is an acoustic measurement, not a semantic one. It reports when the
// recording got loud and by how much; naming that as applause, laughter or a
// goal horn is a later step, and the ranges here are what such a step would read.
package acoustic

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

// SampleRate is the rate the audio is decoded at. Speech energy lives well below
// this, and a fixed rate keeps one window's byte length derivable from its
// index, which is what lets a recording be scanned without holding it.
const SampleRate = 16000

// WindowUS is the width of one measured window. One second is the resolution a
// timeline can show and the resolution a cut can act on.
const WindowUS int64 = 1_000_000

// Floor is the quietest level a window may report, in dBFS. Digital silence is
// minus infinity, which no consumer can compare or display, so it is pinned.
const Floor = -90.0

// bytesPerWindow is how many decoded bytes make one measured window.
const bytesPerWindow = SampleRate * 2

// Analyzer turns an asset's audio track into a loudness curve.
type Analyzer struct {
	// Decode runs ffmpeg and hands the caller its standard output. Production
	// leaves this nil. Tests supply a stub, which is also how the streaming
	// behaviour is exercised without a media file.
	Decode func(ctx context.Context, ffmpeg string, args ...string) (io.ReadCloser, error)
}

// Curve is one asset's measured loudness, plus the levels a reader needs to
// judge whether an excursion matters.
type Curve struct {
	// LevelsDBFS holds one value per window, in order from the asset's start.
	LevelsDBFS []float64
	// FloorDB is the quiet level this recording sits at, estimated as the median
	// of its windows. An excursion is only meaningful relative to it.
	FloorDB float64
	// PeakDB is the loudest window.
	PeakDB float64
	// QuietDB is the level a tenth of the windows fall below. Both ends of the
	// range are read as percentiles rather than as the minimum and maximum, so a
	// single dead second or one clipped sample cannot define the whole scale.
	QuietDB float64
	// LoudDB is the level only a tenth of the windows exceed.
	LoudDB float64
}

// Analyze decodes the asset's audio and measures it window by window.
//
// The decode is consumed as a stream rather than collected: an hour of 16 kHz
// mono is 115 MB, and the shared ffmpeg helper refuses more than 4 MB, which
// silently truncated the first version of this to the asset's opening 131
// seconds. Reading incrementally keeps the measurement correct for any length and
// holds only one partial window at a time.
//
// @param ctx - cancellation for the decode.
// @param tools - the ffmpeg binary to run.
// @param asset - the asset whose audio is measured.
// @returns the measured curve.
// @throws when ffmpeg fails, which includes an asset with no audio track.
func (a Analyzer) Analyze(ctx context.Context, tools media.Tools, asset domain.MediaAsset) (Curve, error) {
	decode := a.Decode
	if decode == nil {
		decode = streamFFmpeg
	}
	// A fixed output format is what makes the byte stream positionally
	// interpretable: 16-bit signed little-endian mono at a known rate.
	out, err := decode(ctx, tools.FFmpeg,
		"-hide_banner", "-v", "error", "-nostdin",
		"-i", asset.Path,
		"-vn", "-ac", "1", "-ar", strconv.Itoa(SampleRate),
		"-f", "s16le", "-",
	)
	if err != nil {
		return Curve{}, fmt.Errorf("decode audio: %w", err)
	}
	defer out.Close()
	curve, err := measureStream(out)
	if err != nil {
		return Curve{}, fmt.Errorf("measure audio: %w", err)
	}
	return curve, nil
}

// streamFFmpeg starts ffmpeg and returns its standard output.
//
// Standard error is captured so a failure can name ffmpeg's own reason; standard
// output is never buffered here, because the caller measures it as it arrives.
//
// @param ctx - cancellation for the process.
// @param ffmpeg - the ffmpeg binary.
// @param args - the arguments to run it with.
// @returns a reader over the decoded bytes.
// @throws when the process cannot start.
func streamFFmpeg(ctx context.Context, ffmpeg string, args ...string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &strings.Builder{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	// The reader owns the process: closing it drains the pipe, which lets the
	// process exit and makes Wait report a real status.
	return &processReader{stdout: stdout, cmd: cmd, stderr: stderr}, nil
}

// processReader is ffmpeg's standard output plus the process behind it.
type processReader struct {
	stdout io.ReadCloser
	cmd    *exec.Cmd
	stderr *strings.Builder
	done   bool
}

// Read passes through to the process's standard output.
// @param p - the caller's buffer.
// @returns the byte count and any read error.
func (r *processReader) Read(p []byte) (int, error) { return r.stdout.Read(p) }

// Close releases the pipe and reports a failed exit as an error, so a caller
// that read to the end still learns that ffmpeg refused the input.
// @returns the process's own failure, or the pipe's.
func (r *processReader) Close() error {
	if r.done {
		return nil
	}
	r.done = true
	err := r.stdout.Close()
	waitErr := r.cmd.Wait()
	if waitErr != nil {
		message := strings.TrimSpace(r.stderr.String())
		if message != "" {
			return fmt.Errorf("%w: %s", waitErr, message)
		}
		return waitErr
	}
	return err
}

// measureStream reads PCM and returns one level per complete window.
//
// A trailing partial window is measured too: the last second of a recording is
// as real as any other, and dropping it would put the curve's end before the
// asset's.
//
// @param r - decoded 16-bit signed little-endian mono samples.
// @returns the measured curve.
func measureStream(r io.Reader) (Curve, error) {
	curve := Curve{LevelsDBFS: []float64{}}
	buf := make([]byte, 64*1024)
	pending := make([]byte, 0, bytesPerWindow*2)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
			for len(pending) >= bytesPerWindow {
				curve.LevelsDBFS = append(curve.LevelsDBFS, windowDB(pending[:bytesPerWindow]))
				pending = pending[bytesPerWindow:]
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return Curve{}, err
		}
	}
	if len(pending) >= 2 {
		curve.LevelsDBFS = append(curve.LevelsDBFS, windowDB(pending))
	}
	curve.FloorDB = median(curve.LevelsDBFS)
	curve.PeakDB = maxOf(curve.LevelsDBFS)
	curve.LoudDB = percentile(curve.LevelsDBFS, 0.90)
	curve.QuietDB = percentile(curve.LevelsDBFS, 0.10)
	return curve, nil
}

// windowDB reports one window's level from its raw samples.
// @param raw - 16-bit signed little-endian mono samples, at least one pair.
// @returns the level in dBFS.
func windowDB(raw []byte) float64 {
	samples := len(raw) / 2
	if samples == 0 {
		return Floor
	}
	sum := 0.0
	for i := 0; i < samples; i++ {
		sample := float64(int16(binary.LittleEndian.Uint16(raw[i*2:]))) / 32768.0
		sum += sample * sample
	}
	return toDBFS(math.Sqrt(sum / float64(samples)))
}

// toDBFS converts a root-mean-square amplitude to decibels, pinned at Floor.
// @param rms - amplitude in 0..1.
// @returns the level in dBFS.
func toDBFS(rms float64) float64 {
	if rms <= 0 {
		return Floor
	}
	db := 20 * math.Log10(rms)
	if db < Floor {
		return Floor
	}
	return db
}

// median returns the middle value, and 0 for an empty set.
// @param values - the measured levels.
// @returns the median.
func median(values []float64) float64 { return percentile(values, 0.50) }

// percentile returns the value at the given fraction of a sorted copy, and 0 for
// an empty set. It interpolates nothing: with one window per second the nearest
// measured second is the honest answer, and a fabricated between-seconds level
// would be presented to the model as a measurement.
// @param values - the measured levels.
// @param fraction - where to read, in 0..1.
// @returns the value at that position.
func percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := make([]float64, len(values))
	copy(sorted, values)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	index := int(fraction * float64(len(sorted)-1))
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}

// maxOf returns the largest value, and 0 for an empty set.
// @param values - the measured levels.
// @returns the maximum.
func maxOf(values []float64) float64 {
	best := 0.0
	for i, value := range values {
		if i == 0 || value > best {
			best = value
		}
	}
	return best
}

// Evidence turns measured rows into evidence, so the loudness of a second and
// what it sounds like are retrievable, measurable and prunable exactly like every
// other dimension.
//
// A row always carries its measured level; a row inside a stretch the labeller
// named also carries that name. The two live in separate fields because one is a
// measurement and the other is an inference, and a reader must be able to tell
// which is which.
//
// @param asset - the asset the curve was measured from.
// @param rows - the measured, optionally labelled seconds.
// @returns one evidence row per measured second, in order.
func Evidence(asset domain.MediaAsset, rows []EventRow) []domain.Evidence {
	out := make([]domain.Evidence, 0, len(rows))
	for _, row := range rows {
		start := row.StartUS
		end := start + WindowUS
		if end > asset.DurationUS {
			end = asset.DurationUS
		}
		if end <= start {
			continue
		}
		out = append(out, domain.Evidence{
			ID:               fmt.Sprintf("%s-level-%04d", asset.ID, start/WindowUS+1),
			ProjectID:        asset.ProjectID,
			AssetID:          asset.ID,
			StartUS:          start,
			EndUS:            end,
			AssetContentHash: asset.ContentHash,
			AcousticSummary:  row.Summary,
			EventLabel:       string(row.EventLabel),
			Provider:         "acoustic",
			AnalyzerVersion:  "level-v1",
		})
	}
	return out
}

// Rows measures a curve into rows without naming anything.
//
// It is the measurement half of {@link LabelStretches}, for a caller that wants
// the curve stored even when no model is available to name it.
//
// @param curve - the measured curve.
// @returns one unnamed row per measured second.
func Rows(curve Curve) []EventRow {
	out := make([]EventRow, 0, len(curve.LevelsDBFS))
	for i, db := range curve.LevelsDBFS {
		out = append(out, EventRow{
			StartUS: int64(i) * WindowUS,
			DBFS:    db,
			Summary: describe(db, curve),
		})
	}
	return out
}

// QuietRangeDB is the dynamic range below which a recording has no loud moments
// to find. A single speaker at a fixed desk has a few decibels of range; a sports
// broadcast has tens. Below this the honest answer is that the level is steady,
// and calling any second a peak would invent a moment that is not there.
const QuietRangeDB = 10.0

// PeakShare is how far up the recording's own range a window must sit to be one
// of its loudest. Thresholds are relative because an absolute one cannot serve
// both a lecture and a stadium: measured on one 300 s explainer the whole range
// was 8.4 dB, so a fixed 12 dB margin labelled nothing at all while a fixed 6 dB
// margin would have labelled a third of the recording.
const PeakShare = 0.75

// describe writes a window's row in the same plain Chinese the other analyzers
// use, because the model reads these lines as evidence and matches the user's
// words against them.
//
// The margin over the floor says how far above ordinary this second is; the gap
// to the peak says whether it is the moment or merely a loud moment. A reader
// needs both to rank two candidates.
//
// @param db - the window's level in dBFS.
// @param curve - the whole curve, whose floor, loud level and peak are the
// comparison this window is described against.
// @returns the model-facing description.
func describe(db float64, curve Curve) string {
	top := curve.PeakDB
	if curve.LoudDB > top {
		top = curve.LoudDB
	}
	bottom := curve.FloorDB
	if curve.QuietDB < bottom && curve.QuietDB > Floor {
		bottom = curve.QuietDB
	}
	span := top - bottom
	label := "音量平稳"
	switch {
	case span >= QuietRangeDB && db >= bottom+span*PeakShare:
		label = "音量峰值"
	case span >= QuietRangeDB && db >= bottom+span*0.4:
		label = "音量明显升高"
	}
	return fmt.Sprintf("音频%s：本秒 %.1f dBFS，比本片底噪高 %.1f dB，距全片峰值还差 %.1f dB。",
		label, db, db-curve.FloorDB, curve.PeakDB-db)
}

// Summary reports the curve's shape in one line, for a log or a tool result.
// @param curve - the measured curve.
// @returns a one-line summary.
func Summary(curve Curve) string {
	if len(curve.LevelsDBFS) == 0 {
		return "no audio windows measured"
	}
	loud := 0
	span := curve.LoudDB - curve.QuietDB
	for _, db := range curve.LevelsDBFS {
		if span >= QuietRangeDB && db >= curve.QuietDB+span*PeakShare {
			loud++
		}
	}
	return strings.TrimSpace(fmt.Sprintf(
		"windows=%d floor=%.1fdBFS peak=%.1fdBFS loud=%d",
		len(curve.LevelsDBFS), curve.FloorDB, curve.PeakDB, loud))
}
