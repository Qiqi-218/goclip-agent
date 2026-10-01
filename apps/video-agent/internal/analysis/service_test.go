package analysis

import (
	"context"
	"errors"
	"testing"

	"github.com/zylar06/video-agent/internal/analysis/asr"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
	"github.com/zylar06/video-agent/internal/store"
)

type fakeASR struct {
	calls int
	err   error
}

func (f *fakeASR) Transcribe(context.Context, domain.MediaAsset) ([]asr.Cue, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return []asr.Cue{{Index: 1, StartUS: 0, EndUS: 2_000_000, Text: "开场介绍"}}, nil
}

func testStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateProject(domain.Project{ID: "p", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutAsset(domain.MediaAsset{ID: "a", ProjectID: "p", Path: "/tmp/video.mp4", ContentHash: "hash", DurationUS: 10_000_000, Width: 640, Height: 360, FPS: "30/1", Status: "ready"}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAnalyzeASRIsCachedAndEvidenceBacked(t *testing.T) {
	s := testStore(t)
	defer s.Close()
	fake := &fakeASR{}
	service := NewWithProviders(s, media.Tools{}, fake, nil)
	req := Request{ProjectID: "p", AssetID: "a", Provider: "fake-asr", Parameters: map[string]any{"language": "zh"}}
	first, err := service.Analyze(context.Background(), req)
	if err != nil || first.Run.Status != "completed" || len(first.Evidence) != 1 {
		t.Fatalf("first analysis: %+v, %v", first, err)
	}
	second, err := service.Analyze(context.Background(), req)
	if err != nil || second.Run.Status != "completed" || len(second.Evidence) != 1 {
		t.Fatalf("cached analysis: %+v, %v", second, err)
	}
	if fake.calls != 1 {
		t.Fatalf("provider calls = %d, want 1", fake.calls)
	}
}

func TestAnalyzePersistsFailure(t *testing.T) {
	s := testStore(t)
	defer s.Close()
	fake := &fakeASR{err: errors.New("upstream unavailable")}
	service := NewWithProviders(s, media.Tools{}, fake, nil)
	result, err := service.Analyze(context.Background(), Request{ProjectID: "p", AssetID: "a", Provider: "fake"})
	if err == nil || result.Run.Status != "failed" || result.Run.Stages["subtitle"] != "failed" {
		t.Fatalf("failure result: %+v, %v", result, err)
	}
	runs, err := s.AnalysisRuns("p", "a")
	if err != nil || len(runs) != 1 || runs[0].Status != "failed" {
		t.Fatalf("persisted runs: %+v, %v", runs, err)
	}
}
