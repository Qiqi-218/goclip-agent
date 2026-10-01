package visual

import "testing"

func TestSamplerDefaults(t *testing.T) {
	s := (Sampler{}).normalized()
	if s.MaxFrames != 48 || s.IntervalUS != 10_000_000 {
		t.Fatalf("defaults: %+v", s)
	}
}

// TestFrameStepCoversTheRequestedSpan covers the measured defect. A 300 s asset
// sampled with MaxFrames=48 produced only 30 frames under a fixed 10 s interval,
// so the frame budget went half unused and the corpus was described at the
// density a 156 s asset would get. After the fix the same asset yields 47.
func TestFrameStepCoversTheRequestedSpan(t *testing.T) {
	const tenSecond = 10_000_000
	const span = 300_000_000
	const frames = 48

	step := frameStep(span, frames, tenSecond)
	want := span / int64(frames-1)
	if step != want {
		t.Fatalf("step = %d, want %d (span/(frames-1))", step, want)
	}
	if step >= tenSecond {
		t.Fatalf("step %d did not tighten the configured %d", step, tenSecond)
	}
	// Every requested frame must fit inside the window, end to end.
	last := int64(frames-1) * step
	if last > span {
		t.Fatalf("last frame starts at %d, past the window end %d", last, span)
	}
	if span-last > step {
		t.Fatalf("last frame starts at %d, more than one step short of %d", last, span)
	}
}

// TestFrameStepUsesTheTighterGap covers the same defect at search scale: 24
// frames across 60 s must advance ~2.6 s at a time, not 10 s, or the sample
// stops seven frames in and silently skips the remaining 39 seconds.
func TestFrameStepUsesTheTighterGap(t *testing.T) {
	const tenSecond = 10_000_000
	got := frameStep(60_000_000, 24, tenSecond)
	want := int64(60_000_000) / 23
	if got != want {
		t.Fatalf("step = %d, want %d", got, want)
	}
	if got >= tenSecond {
		t.Fatalf("step %d did not tighten the configured %d", got, tenSecond)
	}
	if reach := int64(23) * got; reach < 55_000_000 {
		t.Fatalf("24 frames reach only %d us of a 60 s window", reach)
	}
}

// TestFrameStepKeepsItsFloor covers the degenerate inputs: a window too short
// for the requested frame count, a single-frame request, and an empty window.
// None may produce a step below the one-second floor.
func TestFrameStepKeepsItsFloor(t *testing.T) {
	const tenSecond = 10_000_000
	if got := frameStep(5_000_000, 60, tenSecond); got != tenSecond {
		t.Fatalf("step = %d, want the configured %d when the window is too short", got, tenSecond)
	}
	if got := frameStep(1, 1, tenSecond); got != tenSecond {
		t.Fatalf("single-frame step = %d, want the configured %d", got, tenSecond)
	}
	if got := frameStep(0, 60, tenSecond); got != tenSecond {
		t.Fatalf("zero-span step = %d, want the configured %d", got, tenSecond)
	}
	if got := frameStep(50_000, 51, tenSecond); got != tenSecond {
		t.Fatalf("sub-second step = %d, want %d", got, tenSecond)
	}
}

// TestFormatSecondsKeepsTheFraction pins why the filter value cannot be rounded:
// a 300 s window split into 61 frames is 4.997221 s per frame. Passing `1/4`
// makes ffmpeg take a frame every four seconds while the evidence labels claim
// five, so the rate and the labels disagree by a fifth.
func TestFormatSecondsKeepsTheFraction(t *testing.T) {
	cases := []struct {
		us   int64
		want string
	}{
		{us: 4_997_221, want: "4.997221"},
		{us: 10_000_000, want: "10"},
		{us: 1_000_000, want: "1"},
		{us: 2_608_695, want: "2.608695"},
		{us: 1_500_000, want: "1.5"},
	}
	for _, tc := range cases {
		if got := formatSeconds(tc.us); got != tc.want {
			t.Fatalf("formatSeconds(%d) = %q, want %q", tc.us, got, tc.want)
		}
	}
}
