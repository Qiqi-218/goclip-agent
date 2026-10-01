package store

import (
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
)

func TestEvidencePersistsAndIsProjectScoped(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, project := range []string{"p1", "p2"} {
		if err := s.CreateProject(domain.Project{ID: project, Name: project}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.PutAsset(domain.MediaAsset{ID: "asset", ProjectID: project, Path: "/" + project + ".mp4", ContentHash: project + "-hash", DurationUS: 10_000_000, Width: 640, Height: 360, FPS: "30/1", Status: "ready"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PutEvidence(domain.Evidence{ID: "ev", ProjectID: "p1", AssetID: "asset", StartUS: 0, EndUS: 1_000_000, Transcript: "p1 only", CacheKey: "cache"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p1, err := s.Evidence("p1", nil)
	if err != nil || len(p1) != 1 || p1[0].AssetContentHash != "p1-hash" {
		t.Fatalf("p1 evidence: %+v, %v", p1, err)
	}
	p2, err := s.Evidence("p2", nil)
	if err != nil || len(p2) != 0 {
		t.Fatalf("p2 isolation: %+v, %v", p2, err)
	}
}
