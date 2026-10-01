package visual

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

type Sampler struct {
	MaxFrames  int
	IntervalUS int64
	// StartUS and DurationUS restrict sampling to a window of the asset. Zero
	// values mean the whole asset, which is what indexing wants; a visual search
	// sets them to look at one region closely.
	StartUS    int64
	DurationUS int64
}

func (s Sampler) normalized() Sampler {
	if s.MaxFrames <= 0 {
		s.MaxFrames = 48
	}
	if s.IntervalUS <= 0 {
		s.IntervalUS = 10_000_000
	}
	if s.IntervalUS < 1_000_000 {
		s.IntervalUS = 1_000_000
	}
	if s.StartUS < 0 {
		s.StartUS = 0
	}
	return s
}

// Sample extracts deterministic representative frames. A later scene-change
// sampler can replace the filter without changing the Evidence contract.
func (s Sampler) Sample(ctx context.Context, tools media.Tools, asset domain.MediaAsset, dir string) ([]domain.Evidence, error) {
	s = s.normalized()
	if err := asset.Validate(); err != nil {
		return nil, err
	}
	span := asset.DurationUS
	if s.DurationUS > 0 && s.DurationUS < span {
		span = s.DurationUS
	}
	if s.StartUS > 0 && s.StartUS >= asset.DurationUS {
		return nil, fmt.Errorf("sample window starts at %d, past the asset end %d", s.StartUS, asset.DurationUS)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	pattern := filepath.Join(dir, "frame-%04d.jpg")
	// The filter's rate and the labels below must be the same number: ffmpeg
	// decides where a frame is taken, this function only says when. Computing the
	// step once and using it for both is what keeps them from disagreeing.
	step := frameStep(span, s.MaxFrames, s.IntervalUS)
	args := []string{"-hide_banner", "-v", "error", "-nostdin", "-y",
		"-ss", strconv.FormatInt(s.StartUS/1_000_000, 10),
		"-i", asset.Path,
		"-vf", "fps=1/" + formatSeconds(step) + ",scale=1024:1024:force_original_aspect_ratio=decrease",
		"-frames:v", strconv.Itoa(s.MaxFrames), "-q:v", "3", pattern}
	if _, err := media.Run(ctx, tools.FFmpeg, args...); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	// ffmpeg's `fps=1/interval` filter emits its first frame at the window start
	// and then one frame per interval, so frame n sits at StartUS + (n-1)*step.
	out := []domain.Evidence{}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".jpg" {
			continue
		}
		var n int
		if _, err := fmt.Sscanf(entry.Name(), "frame-%d.jpg", &n); err != nil || n < 1 {
			continue
		}
		// Frame n covers [StartUS + (n-1)*step, +step), clipped to the window's
		// end so a range never runs past what was asked for.
		start := s.StartUS + int64(n-1)*step
		if start >= s.StartUS+span {
			continue
		}
		end := start + step
		if end > s.StartUS+span {
			end = s.StartUS + span
		}
		out = append(out, domain.Evidence{ID: fmt.Sprintf("%s-frame-%04d", asset.ID, n), ProjectID: asset.ProjectID, AssetID: asset.ID, StartUS: start, EndUS: end, AssetContentHash: asset.ContentHash, FrameRefs: []string{filepath.Join(dir, entry.Name())}, Provider: "ffmpeg-sampler", AnalyzerVersion: "sample-v1"})
	}
	return out, nil
}

// formatSeconds renders a microsecond gap as the seconds value ffmpeg's
// `fps=1/<value>` filter takes.
//
// The value is often fractional — 300 s split into 61 frames is 4997221.88 µs —
// and rounding it to whole seconds is what made the filter's rate disagree with
// the labels: at `fps=1/4` ffmpeg takes a frame every 4 s while the evidence
// claims 5 s. Six decimal places keeps the two within a microsecond.
//
// @param us - the gap in microseconds.
// @returns the gap in seconds, without trailing zeros.
func formatSeconds(us int64) string {
	text := strconv.FormatFloat(float64(us)/1e6, 'f', 6, 64)
	text = strings.TrimRight(text, "0")
	return strings.TrimSuffix(text, ".")
}

// frameStep is the gap between consecutive sampled frames.
//
// ffmpeg's `fps=1/interval` filter places its first frame at the window start
// and then one frame per interval, so frame n sits at StartUS + (n-1)*step. A
// caller that names both a span and a frame count is asking for that span
// covered *by that many frames*, which needs a step of span/(N-1).
//
// Two measured defects came from not doing that:
//
//   - With a fixed 10 s interval, `MaxFrames` was a cap that went unused. A
//     300 s asset sampled with MaxFrames=48 produced 30 frames — the same sample
//     density a 156 s asset would get — so a corpus of clips was described at a
//     resolution its budget had already paid for and did not use. After the fix
//     the same asset yields 47.
//   - A fractional step was written into the filter as whole seconds
//     (`fps=1/4` for 4.997221 s), so ffmpeg took frames at one spacing while the
//     evidence labels claimed another. See formatSeconds.
//
// The one-second floor keeps ffmpeg from being asked for more frames than a
// short window can hold; below it the configured interval stands.
//
// @param span - the sampled window's length in microseconds.
// @param frames - how many frames the caller asked for.
// @param configured - the gap to use when the span cannot be divided usefully.
// @returns the step between frames in microseconds.
func frameStep(span int64, frames int, configured int64) int64 {
	if span <= 0 || frames <= 1 {
		return configured
	}
	exact := span / int64(frames-1)
	if exact < 1_000_000 {
		return configured
	}
	return exact
}
