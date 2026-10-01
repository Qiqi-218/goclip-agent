package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

func TestFailedAndCancelledRendersPersistWithoutOutput(t *testing.T) {
	a, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.Close()
	if err = a.Store.CreateProject(domain.Project{ID: "p", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.Store.Dir, "input.mp4")
	if err = os.WriteFile(path, []byte("not a media file"), 0600); err != nil {
		t.Fatal(err)
	}
	hash, err := media.Hash(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.Store.PutAsset(domain.MediaAsset{ID: "a", ProjectID: "p", Path: path, ContentHash: hash, DurationUS: 1_000_000, Width: 320, Height: 180})
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.CreateTimeline(domain.TimelineRevision{ID: "t", ProjectID: "p", FPSNum: 30, FPSDen: 1, Width: 320, Height: 180, Items: []domain.ClipItem{{ID: "c", AssetID: "a", SourceOutUS: 1_000_000}}})
	if err != nil {
		t.Fatal(err)
	}
	a.Tools.FFprobe = filepath.Join(a.Store.Dir, "missing-ffprobe")
	job, err := a.Render(context.Background(), "t", 0, false, "")
	if err == nil || job.Status != "failed" {
		t.Fatalf("missing dependency: %+v %v", job, err)
	}
	persisted, err := a.Store.Job(job.ID)
	if err != nil || persisted.Status != "failed" || persisted.Validation != nil {
		t.Fatalf("failure not persisted: %+v %v", persisted, err)
	}
	if _, err = os.Stat(job.Output); !os.IsNotExist(err) {
		t.Fatal("failed job published output")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	job, err = a.Render(ctx, "t", 0, false, "")
	if err == nil || job.Status != "cancelled" {
		t.Fatalf("cancelled: %+v %v", job, err)
	}
	persisted, err = a.Store.Job(job.ID)
	if err != nil || persisted.Status != "cancelled" {
		t.Fatal("cancelled job not persisted")
	}
	// Assets can be registered only under an existing project.
	_, err = a.Store.PutAsset(domain.MediaAsset{ID: "bad", ProjectID: "missing", Path: path, ContentHash: strings.Repeat("0", 64), DurationUS: 1, Width: 2, Height: 2})
	if err == nil {
		t.Fatal("missing project accepted")
	}
}
