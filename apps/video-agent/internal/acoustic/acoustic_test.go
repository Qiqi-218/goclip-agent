package acoustic

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"strings"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

// tone builds one second of PCM at a known amplitude, so a window's expected
// level can be computed rather than guessed.
func tone(seconds int, amplitude float64) []byte {
	out := make([]byte, 0, seconds*SampleRate*2)
	for i := 0; i < seconds*SampleRate; i++ {
		value := int16(amplitude * 32767 * math.Sin(2*math.Pi*440*float64(i)/SampleRate))
		out = binary.LittleEndian.AppendUint16(out, uint16(value))
	}
	return out
}

// flat builds one second at a fixed amplitude.
func flat(seconds int, amplitude float64) []byte {
	out := make([]byte, 0, seconds*SampleRate*2)
	for i := 0; i < seconds*SampleRate; i++ {
		out = binary.LittleEndian.AppendUint16(out, uint16(int16(amplitude*32767)))
	}
	return out
}

// reader is a stub decode that hands back fixed bytes in small chunks, so the
// streaming path is exercised the way a pipe delivers them.
type reader struct {
	data []byte
	at   int
	step int
	err  error
}

func (r *reader) Read(p []byte) (int, error) {
	if r.at >= len(r.data) {
		if r.err != nil {
			return 0, r.err
		}
		return 0, io.EOF
	}
	n := r.step
	if n <= 0 || n > len(p) {
		n = len(p)
	}
	if r.at+n > len(r.data) {
		n = len(r.data) - r.at
	}
	copy(p, r.data[r.at:r.at+n])
	r.at += n
	return n, nil
}

func (r *reader) Close() error { return nil }

// TestMeasureStreamReportsOneWindowPerSecond pins the window mapping: a curve is
// addressable by second, so window i must describe second i and nothing else.
func TestMeasureStreamReportsOneWindowPerSecond(t *testing.T) {
	curve, err := measureStream(&reader{data: tone(5, 0.5), step: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if len(curve.LevelsDBFS) != 5 {
		t.Fatalf("windows = %d, want 5", len(curve.LevelsDBFS))
	}
	// A half-scale sine has RMS 0.5/sqrt(2), which is about -9 dBFS.
	want := 20 * math.Log10(0.5/math.Sqrt2)
	for i, db := range curve.LevelsDBFS {
		if math.Abs(db-want) > 0.5 {
			t.Fatalf("window %d = %.2f dBFS, want about %.2f", i, db, want)
		}
	}
}

// TestMeasureStreamIsChunkBoundaryIndependent is the property that makes a
// stream safe to measure: how the bytes arrive must not change the curve, or the
// same asset would be described differently depending on pipe timing.
func TestMeasureStreamIsChunkBoundaryIndependent(t *testing.T) {
	data := append(append(flat(3, 0.05), tone(2, 0.8)...), flat(3, 0.05)...)
	var reference []float64
	for _, step := range []int{1, 512, 16000, 64000, 1 << 20} {
		curve, err := measureStream(&reader{data: data, step: step})
		if err != nil {
			t.Fatal(err)
		}
		if len(curve.LevelsDBFS) != 8 {
			t.Fatalf("step %d produced %d windows, want 8", step, len(curve.LevelsDBFS))
		}
		if reference == nil {
			reference = curve.LevelsDBFS
			continue
		}
		for i := range curve.LevelsDBFS {
			if math.Abs(curve.LevelsDBFS[i]-reference[i]) > 1e-9 {
				t.Fatalf("step %d changed window %d: %.6f vs %.6f", step, i, curve.LevelsDBFS[i], reference[i])
			}
		}
	}
}

// TestMeasureStreamMeasuresTheWholeRecording is the regression this file exists
// for. The first version collected ffmpeg's output through the shared helper,
// which refuses more than 4 MB — 131 seconds of 16 kHz mono — so a five-minute
// asset was measured only to its second 131 and reported as a complete curve.
func TestMeasureStreamMeasuresTheWholeRecording(t *testing.T) {
	const seconds = 300
	curve, err := measureStream(&reader{data: tone(seconds, 0.4), step: 32768})
	if err != nil {
		t.Fatal(err)
	}
	if len(curve.LevelsDBFS) != seconds {
		t.Fatalf("windows = %d, want %d — the decode was truncated", len(curve.LevelsDBFS), seconds)
	}
}

// TestMeasureStreamKeepsThePartialFinalWindow keeps the curve's end on the
// asset's end: dropping a trailing fraction would make the last second of every
// recording unmeasurable.
func TestMeasureStreamKeepsThePartialFinalWindow(t *testing.T) {
	// Two and a half seconds.
	data := append(tone(2, 0.4), tone(1, 0.4)[:SampleRate]...)
	curve, err := measureStream(&reader{data: data, step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	if len(curve.LevelsDBFS) != 3 {
		t.Fatalf("windows = %d, want 3 (two full plus a half)", len(curve.LevelsDBFS))
	}
}

// TestMeasureStreamPinsDigitalSilence keeps the curve comparable: silence is
// minus infinity in dBFS, which nothing downstream can sort, average or display.
func TestMeasureStreamPinsDigitalSilence(t *testing.T) {
	curve, err := measureStream(&reader{data: make([]byte, bytesPerWindow*3), step: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if len(curve.LevelsDBFS) != 3 {
		t.Fatalf("windows = %d, want 3", len(curve.LevelsDBFS))
	}
	for i, db := range curve.LevelsDBFS {
		if db != Floor {
			t.Fatalf("silent window %d = %v, want the floor %v", i, db, Floor)
		}
	}
}

// TestMeasureStreamReportsAReadFailure keeps a broken decode from looking like a
// recording that simply ended.
func TestMeasureStreamReportsAReadFailure(t *testing.T) {
	boom := errors.New("pipe closed")
	_, err := measureStream(&reader{data: tone(2, 0.4), step: 1024, err: boom})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// TestEvidenceReportsEveryWindow pins why the level is written for all windows
// and not only for peaks: a quiet second is a fact a cut may need, and the
// dimension must be able to answer "how loud was 12:00" as well as "where was it
// loudest".
func TestEvidenceReportsEveryWindow(t *testing.T) {
	data := append(append(flat(4, 0.01), tone(1, 0.9)...), flat(4, 0.01)...)
	curve, err := measureStream(&reader{data: data, step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	asset := domain.MediaAsset{ID: "asset-a", ProjectID: "p", DurationUS: 9 * WindowUS}
	rows := Evidence(asset, Rows(curve))
	if len(rows) != 9 {
		t.Fatalf("rows = %d, want 9", len(rows))
	}

	prominent := 0
	for i, row := range rows {
		if row.AcousticSummary == "" {
			t.Fatalf("window %d has no measurement", i)
		}
		if row.StartUS != int64(i)*WindowUS {
			t.Fatalf("row %d starts at %d, want %d", i, row.StartUS, int64(i)*WindowUS)
		}
		if row.Provider != "acoustic" || row.AssetID != "asset-a" || row.ProjectID != "p" {
			t.Fatalf("row %d is not attributable: %+v", i, row)
		}
		if row.VisualSummary != "" {
			t.Fatalf("row %d wrote a loudness fact into the visual field: %q", i, row.VisualSummary)
		}
		if strings.Contains(row.AcousticSummary, "音量峰值") {
			prominent++
			if i != 4 {
				t.Fatalf("window %d was called a peak but only second 4 is loud: %q", i, row.AcousticSummary)
			}
		}
	}
	if prominent != 1 {
		t.Fatalf("labelled %d windows as peaks, want exactly 1", prominent)
	}
	// The quiet windows must still say something true about themselves.
	if !strings.Contains(rows[0].AcousticSummary, "音量平稳") {
		t.Fatalf("a quiet window reads %q", rows[0].AcousticSummary)
	}
}

// TestEvidenceClipsTheLastWindowToTheAsset keeps a row inside the recording: a
// partial final second must not claim time the asset does not have.
func TestEvidenceClipsTheLastWindowToTheAsset(t *testing.T) {
	curve, err := measureStream(&reader{data: tone(3, 0.4), step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	asset := domain.MediaAsset{ID: "asset-b", ProjectID: "p", DurationUS: 3*WindowUS - 400_000}
	rows := Evidence(asset, Rows(curve))
	last := rows[len(rows)-1]
	if last.EndUS != asset.DurationUS {
		t.Fatalf("last window ends at %d, want the asset end %d", last.EndUS, asset.DurationUS)
	}
	// A window starting past the asset end must not be emitted at all.
	short := Evidence(domain.MediaAsset{ID: "asset-c", ProjectID: "p", DurationUS: 2 * WindowUS}, Rows(curve))
	if len(short) != 2 {
		t.Fatalf("rows = %d for a two-second asset, want 2", len(short))
	}
}

// TestAnalyzeDecodesThroughFfmpeg covers the wiring without ffmpeg: the stub
// asserts the arguments that make the byte stream positionally interpretable,
// because a wrong rate or channel count silently shifts every window.
func TestAnalyzeDecodesThroughFfmpeg(t *testing.T) {
	var got []string
	a := Analyzer{Decode: func(_ context.Context, ffmpeg string, args ...string) (io.ReadCloser, error) {
		got = append([]string{ffmpeg}, args...)
		return &reader{data: tone(2, 0.3), step: 4096}, nil
	}}
	asset := domain.MediaAsset{ID: "asset-d", ProjectID: "p", Path: "/tmp/x.media", DurationUS: 2 * WindowUS}
	curve, err := a.Analyze(context.Background(), media.Tools{FFmpeg: "ffmpeg"}, asset)
	if err != nil {
		t.Fatal(err)
	}
	if len(curve.LevelsDBFS) != 2 {
		t.Fatalf("windows = %d, want 2", len(curve.LevelsDBFS))
	}
	joined := strings.Join(got, " ")
	for _, want := range []string{"-ac 1", "-ar 16000", "-f s16le", "-vn"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("ffmpeg arguments are missing %q: %s", want, joined)
		}
	}
}

// TestAnalyzeReportsADecodeFailure keeps an asset without audio from looking
// like an asset with silent audio: the caller must be able to tell them apart.
func TestAnalyzeReportsADecodeFailure(t *testing.T) {
	a := Analyzer{Decode: func(context.Context, string, ...string) (io.ReadCloser, error) {
		return nil, context.DeadlineExceeded
	}}
	_, err := a.Analyze(context.Background(), media.Tools{FFmpeg: "ffmpeg"},
		domain.MediaAsset{ID: "asset-e", ProjectID: "p", Path: "/tmp/y.media"})
	if err == nil {
		t.Fatal("a decode failure was reported as success")
	}
}
