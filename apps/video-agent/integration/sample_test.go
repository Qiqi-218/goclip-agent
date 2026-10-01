package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/edit"
	"github.com/zylar06/video-agent/internal/media"
)

// Optional local footage, separate from repeatable synthetic regression fixtures.
// No network access occurs in tests; the caller supplies the source file explicitly.
func TestP1ExternalSample(t *testing.T) {
	source := os.Getenv("VIDEO_AGENT_SAMPLE")
	if os.Getenv("VIDEO_AGENT_INTEGRATION") != "1" || source == "" {
		t.Skip("set VIDEO_AGENT_INTEGRATION=1 and VIDEO_AGENT_SAMPLE to a local video >= 40 seconds")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dir := t.TempDir()
	if parent := os.Getenv("VIDEO_AGENT_ACCEPTANCE_DIR"); parent != "" {
		var err error
		dir, err = os.MkdirTemp(parent, "footage-*")
		if err != nil {
			t.Fatal(err)
		}
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("footage artifacts: %s", dir)
	a, err := app.Open(filepath.Join(dir, "project"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.Close()
	if err = a.Store.CreateProject(domain.Project{ID: "sample", Name: "Real footage P1 acceptance"}); err != nil {
		t.Fatal(err)
	}
	first, err := a.Tools.Import(ctx, a.Store, "sample", source)
	if err != nil {
		t.Fatal(err)
	}
	if first.DurationUS < 40_000_000 {
		t.Fatal("sample must be at least 40 seconds")
	}
	portrait := filepath.Join(dir, "portrait-silent-25fps.mp4")
	_, err = media.Run(ctx, a.Tools.FFmpeg, "-v", "error", "-nostdin", "-y", "-i", first.Path, "-t", "30", "-vf", "crop=trunc(ih*9/16/2)*2:ih,scale=360:640", "-r", "25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", portrait)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.Tools.Import(ctx, a.Store, "sample", portrait)
	if err != nil {
		t.Fatal(err)
	}
	timeline := domain.TimelineRevision{ID: "sample-tl", ProjectID: "sample", Width: 1280, Height: 720, FPSNum: 30, FPSDen: 1, Items: []domain.ClipItem{{ID: "intro", AssetID: first.ID, SourceInUS: 3_000_000, SourceOutUS: 21_000_000}, {ID: "portrait", AssetID: second.ID, SourceInUS: 10_000_000, SourceOutUS: 28_000_000}}}
	if _, err = a.CreateTimeline(timeline); err != nil {
		t.Fatal(err)
	}
	one, err := a.Render(ctx, timeline.ID, 0, false, filepath.Join(dir, "original-36s.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	preview, err := a.Render(ctx, timeline.ID, 0, true, filepath.Join(dir, "preview-36s.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = edit.NewEngine(a.Store).Apply(ctx, domain.EditOperation{ID: "replace", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpReplaceClip, TargetClipID: "intro", AssetID: first.ID, SourceInUS: 22_000_000, SourceOutUS: 40_000_000})
	if err != nil {
		t.Fatal(err)
	}
	two, err := a.Render(ctx, timeline.ID, 0, false, filepath.Join(dir, "replaced-36s.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if one.Validation.Frames != 1080 || two.Validation.Frames != 1080 || one.Validation.SHA256 == two.Validation.SHA256 {
		t.Fatal("replacement did not change real footage")
	}
	for name, ts := range map[string]string{"frame-landscape.png": "5", "frame-portrait.png": "23"} {
		if _, err = media.Run(ctx, a.Tools.FFmpeg, "-v", "error", "-ss", ts, "-i", one.Output, "-frames:v", "1", "-update", "1", filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	report := map[string]any{"passed": true, "source_file": source, "assets": []domain.MediaAsset{first, second}, "jobs": []domain.RenderJob{one, preview, two}, "checks": []string{"real footage 36-second two-source render", "25fps portrait silent derivative mixed with original", "full decode of preview and both exports", "replacement changes output without duration change"}}
	b, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "report.json"), append(b, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}
