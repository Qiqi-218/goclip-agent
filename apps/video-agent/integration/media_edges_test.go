package integration

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

func TestP1MediaBoundaries(t *testing.T) {
	if os.Getenv("VIDEO_AGENT_INTEGRATION") != "1" {
		t.Skip("set VIDEO_AGENT_INTEGRATION=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Store.Close()
	if err = a.Store.CreateProject(domain.Project{ID: "edges", Name: "media boundaries"}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(a.Store.Dir, "red then blue with short audio.mp4")
	// Long GOP + changing colors proves source seeking between keyframes is real.
	_, err = media.Run(ctx, a.Tools.FFmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x180:r=25:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-vf", "drawbox=color=blue:t=fill:enable='gte(t,2)'", "-c:v", "libx264", "-g", "100", "-sc_threshold", "0", "-c:a", "aac", source)
	if err != nil {
		t.Fatal(err)
	}
	asset, err := a.Tools.Import(ctx, a.Store, "edges", source)
	if err != nil {
		t.Fatal(err)
	}
	timeline := domain.TimelineRevision{ID: "edge-tl", ProjectID: "edges", FPSNum: 30000, FPSDen: 1001, Width: 180, Height: 320, Items: []domain.ClipItem{{ID: "late", AssetID: asset.ID, SourceInUS: 2_250_000, SourceOutUS: 3_251_000}, {ID: "early", AssetID: asset.ID, SourceInUS: 250_000, SourceOutUS: 1_251_000}}}
	if _, err = a.CreateTimeline(timeline); err != nil {
		t.Fatal(err)
	}
	j, err := a.Render(ctx, timeline.ID, 0, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if j.Validation.Frames != 60 || j.Validation.DurationUS != 2_002_000 {
		t.Fatalf("rational frame rate: %+v", j.Validation)
	}
	for i, ts := range []string{"0.25", "1.25"} {
		b, e := media.Run(ctx, a.Tools.FFmpeg, "-v", "error", "-ss", ts, "-i", j.Output, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
		if e != nil || len(b) != 3 {
			t.Fatalf("pixels: %v %v", e, b)
		}
		channel := 2
		if i == 1 {
			channel = 0
		}
		if b[channel] < 150 {
			t.Fatalf("non-keyframe source seek wrong at %s: %v", ts, b)
		}
	}
	// A source with no audio at all and variable frame rate still exports with a silent AAC track.
	vfr := filepath.Join(a.Store.Dir, "vfr.mp4")
	_, err = media.Run(ctx, a.Tools.FFmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=60:d=4", "-vf", "select='if(lt(t,2),not(mod(n,2)),1)'", "-fps_mode", "vfr", "-c:v", "libx264", "-an", vfr)
	if err != nil {
		t.Fatal(err)
	}
	asset, err = a.Tools.Import(ctx, a.Store, "edges", vfr)
	if err != nil {
		t.Fatal(err)
	}
	timeline.ID = "vfr-tl"
	timeline.Items = []domain.ClipItem{{ID: "vfr", AssetID: asset.ID, SourceInUS: 123_000, SourceOutUS: 2_125_000}}
	if _, err = a.CreateTimeline(timeline); err != nil {
		t.Fatal(err)
	}
	j, err = a.Render(ctx, timeline.ID, 0, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if j.Validation.Frames != 60 {
		t.Fatal("VFR output frame count")
	}
	// Failure after probing/hashing is persisted and never publishes a partial file.
	a.Tools.FFmpeg = filepath.Join(a.Store.Dir, "nonexistent-ffmpeg")
	failed, err := a.Render(ctx, timeline.ID, 0, false, "")
	if err == nil || failed.Status != "failed" {
		t.Fatalf("renderer failure: %v %+v", err, failed)
	}
	loaded, err := a.Store.Job(failed.ID)
	if err != nil || loaded.Status != "failed" {
		t.Fatal("renderer failure not saved")
	}
	if _, err = os.Stat(failed.Output); !os.IsNotExist(err) {
		t.Fatal("renderer published partial output")
	}
	leftovers, err := filepath.Glob(filepath.Join(a.Store.Dir, "exports", ".video-agent-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary output leak: %v %v", leftovers, err)
	}
}
