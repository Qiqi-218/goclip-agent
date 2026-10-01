package visionsearch

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

// fakeAsker answers from a fixed script keyed by frame file name, so a test can
// decide which frames "contain" the subject.
type fakeAsker struct {
	answers map[string]string
	calls   int
	err     error
}

func (f *fakeAsker) Ask(_ context.Context, imagePath, _ string) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	for key, answer := range f.answers {
		if strings.Contains(imagePath, key) {
			return answer, nil
		}
	}
	return "否\n", nil
}

// fakeSampler fabricates frames without touching ffmpeg.
type fakeSampler struct {
	frames []domain.Evidence
}

func (f fakeSampler) Sample(context.Context, media.Tools, domain.MediaAsset, string) ([]domain.Evidence, error) {
	return f.frames, nil
}

func newAsset(t *testing.T, durationUS int64) (*app.App, domain.MediaAsset) {
	t.Helper()
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open app: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	if err := a.Store.CreateProject(domain.Project{ID: "p", Name: "P"}); err != nil {
		t.Fatalf("project: %v", err)
	}
	asset, err := a.Store.PutAsset(domain.MediaAsset{
		ID: "a", ProjectID: "p", Path: "/x.mp4", ContentHash: "h",
		DurationUS: durationUS, Width: 1920, Height: 1080, FPS: "30/1", Status: "ready",
	})
	if err != nil {
		t.Fatalf("asset: %v", err)
	}
	return a, asset
}

func framesAt(windowStart int64, n int, interval int64) []domain.Evidence {
	out := make([]domain.Evidence, 0, n)
	for i := 0; i < n; i++ {
		start := windowStart + int64(i)*interval
		out = append(out, domain.Evidence{
			ID: "f" + string(rune('0'+i)), StartUS: start, EndUS: start + interval,
			FrameRefs: []string{"/frames/frame-000" + string(rune('1'+i)) + ".jpg"},
		})
	}
	return out
}

func TestSearchReportsFramesWhereTheSubjectAppears(t *testing.T) {
	a, asset := newAsset(t, 60_000_000)
	asker := &fakeAsker{answers: map[string]string{
		"frame-0003.jpg": "是\n一个飞碟在摘苹果",
	}}
	svc := Service{
		Store: a.Store,
		Ask:   asker,
		NewSampler: func(int64, int64, int) Sampler {
			return fakeSampler{frames: framesAt(0, 6, 10_000_000)}
		},
	}
	got, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 0, 0, 6)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if got.Scanned != 6 {
		t.Fatalf("expected to scan 6 frames, got %d", got.Scanned)
	}
	if len(got.Matches) != 1 {
		t.Fatalf("expected 1 match, got %+v", got.Matches)
	}
	m := got.Matches[0]
	if m.StartUS != 20_000_000 || m.EndUS != 30_000_000 {
		t.Fatalf("match range wrong: %d..%d", m.StartUS, m.EndUS)
	}
	if !strings.Contains(m.Reason, "飞碟") {
		t.Fatalf("match should carry the model's reason, got %q", m.Reason)
	}
	// Every frame must be looked at: a skipped frame is a missed answer.
	if asker.calls != 6 {
		t.Fatalf("expected 6 vision calls, got %d", asker.calls)
	}
}

// Looking and finding nothing is a valid answer and must say so, because a bare
// empty list reads to the model as a broken tool.
func TestSearchExplainsAnEmptyResult(t *testing.T) {
	a, asset := newAsset(t, 30_000_000)
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{},
		NewSampler: func(int64, int64, int) Sampler {
			return fakeSampler{frames: framesAt(0, 4, 5_000_000)}
		},
	}
	got, err := svc.Search(context.Background(), "p", asset.ID, "独角兽", 0, 0, 4)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got.Matches) != 0 {
		t.Fatalf("expected no matches, got %+v", got.Matches)
	}
	if got.Note == "" || !strings.Contains(got.Note, "独角兽") {
		t.Fatalf("an empty result must explain itself, got %q", got.Note)
	}
}

func TestSearchRequiresAVisionProvider(t *testing.T) {
	a, asset := newAsset(t, 30_000_000)
	svc := Service{Store: a.Store}
	_, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 0, 0, 4)
	if err == nil || !strings.Contains(err.Error(), "vision provider") {
		t.Fatalf("expected a clear provider error, got %v", err)
	}
}

func TestSearchRequiresASubject(t *testing.T) {
	a, asset := newAsset(t, 30_000_000)
	svc := Service{Store: a.Store, Ask: &fakeAsker{}}
	if _, err := svc.Search(context.Background(), "p", asset.ID, "   ", 0, 0, 4); err == nil {
		t.Fatal("expected an empty subject to be rejected")
	}
}

func TestSearchPropagatesProviderFailure(t *testing.T) {
	a, asset := newAsset(t, 30_000_000)
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{err: errors.New("vision provider returned HTTP 500")},
		NewSampler: func(int64, int64, int) Sampler {
			return fakeSampler{frames: framesAt(0, 3, 5_000_000)}
		},
	}
	if _, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 0, 0, 3); err == nil {
		t.Fatal("a provider failure must surface, not be reported as no match")
	}
}

// A window must confine the search: frames carry the asset's absolute
// timestamps, so the caller's range is what gets reported back.
func TestSearchRespectsTheRequestedWindow(t *testing.T) {
	a, asset := newAsset(t, 100_000_000)
	var gotStart, gotEnd int64
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{answers: map[string]string{"frame-0002.jpg": "是\n飞碟"}},
		NewSampler: func(startUS, endUS int64, _ int) Sampler {
			gotStart, gotEnd = startUS, endUS
			return fakeSampler{frames: framesAt(startUS, 3, 5_000_000)}
		},
	}
	got, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 40_000_000, 60_000_000, 3)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if gotStart != 40_000_000 || gotEnd != 60_000_000 {
		t.Fatalf("sampler got window %d..%d", gotStart, gotEnd)
	}
	if len(got.Matches) != 1 || got.Matches[0].StartUS != 45_000_000 {
		t.Fatalf("match should be reported on the asset timeline, got %+v", got.Matches)
	}
	if got.WindowStart != 40_000_000 || got.WindowEnd != 60_000_000 {
		t.Fatalf("result should echo the window, got %+v", got)
	}
}

func TestInterpretReadsVerdicts(t *testing.T) {
	cases := []struct {
		answer string
		hit    bool
		reason string
	}{
		{"是\n一个飞碟在摘苹果", true, "一个飞碟在摘苹果"},
		{"是", true, ""},
		{"**是**\n*飞碟*", true, "飞碟"},
		{"Yes\nsaucer visible", true, "saucer visible"},
		{"否\n", false, ""},
		{"没有出现", false, ""},
		{"No", false, ""},
		{"", false, ""},
	}
	for _, tc := range cases {
		hit, reason := interpret(tc.answer)
		if hit != tc.hit || reason != tc.reason {
			t.Errorf("interpret(%q) = (%v,%q), want (%v,%q)", tc.answer, hit, reason, tc.hit, tc.reason)
		}
	}
}

// The prompt must ask one narrow question so answers stay cheap and checkable.
func TestMatchPromptAsksOneNarrowQuestion(t *testing.T) {
	p := matchPrompt("飞碟")
	if !strings.Contains(p, "飞碟") {
		t.Fatal("prompt must name the subject")
	}
	if !strings.Contains(p, "是") || !strings.Contains(p, "否") {
		t.Fatal("prompt must ask for a yes/no verdict")
	}
}

func TestFramesAreCapped(t *testing.T) {
	a, asset := newAsset(t, 600_000_000)
	var asked int
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{},
		NewSampler: func(_, _ int64, count int) Sampler {
			asked = count
			return fakeSampler{frames: framesAt(0, 1, 1_000_000)}
		},
	}
	// Asking for more than the ceiling must be clamped: each frame is a paid
	// vision call.
	if _, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 0, 0, 5000); err != nil {
		t.Fatalf("search: %v", err)
	}
	if asked != MaxFrames {
		t.Fatalf("expected the request to be clamped to %d, got %d", MaxFrames, asked)
	}
}

// A miss on a coarse scan is not the same claim as a miss on a fine one: a shot
// shorter than the sampling gap falls between two frames and is never examined.
// The result must distinguish the two, or the caller will tell the user the
// subject is absent when it was simply not seen.
func TestSparseMissIsFlagged(t *testing.T) {
	a, asset := newAsset(t, 300_000_000)
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{},
		NewSampler: func(int64, int64, int) Sampler {
			// 12 frames across 300s: a 25-second gap.
			return fakeSampler{frames: framesAt(0, 12, 25_000_000)}
		},
	}
	got, err := svc.Search(context.Background(), "p", asset.ID, "飞碟", 0, 0, 12)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got.Matches) != 0 {
		t.Fatalf("expected a miss, got %+v", got.Matches)
	}
	if !got.Sparse {
		t.Fatalf("a 25s-gap miss must be flagged as sparse, note=%q", got.Note)
	}
	if !strings.Contains(got.Note, "frames") {
		t.Fatalf("the note should say how to look more closely, got %q", got.Note)
	}
}

// A dense scan that misses is a real answer and must not be hedged.
func TestDenseMissIsNotFlagged(t *testing.T) {
	a, asset := newAsset(t, 60_000_000)
	svc := Service{
		Store: a.Store,
		Ask:   &fakeAsker{},
		NewSampler: func(int64, int64, int) Sampler {
			// 60 frames across 60s: a 1-second gap.
			return fakeSampler{frames: framesAt(0, 60, 1_000_000)}
		},
	}
	got, err := svc.Search(context.Background(), "p", asset.ID, "独角兽", 0, 0, 60)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if got.Sparse {
		t.Fatalf("a 1s-gap miss is trustworthy and should not be flagged: %q", got.Note)
	}
}
