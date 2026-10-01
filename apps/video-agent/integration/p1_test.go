package integration

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

// Explicit opt-in: an acceptance run must fail (never skip) if media tools are missing.
func TestP1EndToEnd(t *testing.T) {
	if os.Getenv("VIDEO_AGENT_INTEGRATION") != "1" {
		t.Skip("set VIDEO_AGENT_INTEGRATION=1 to run real FFmpeg acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	tools := media.Default()
	version, err := media.Run(ctx, tools.FFmpeg, "-version")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = media.Run(ctx, tools.FFprobe, "-version"); err != nil {
		t.Fatal(err)
	}
	dir := os.Getenv("VIDEO_AGENT_ACCEPTANCE_DIR")
	if dir == "" {
		dir = t.TempDir()
	} else {
		if err = os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		dir, err = os.MkdirTemp(dir, "run-*")
		if err != nil {
			t.Fatal(err)
		}
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("acceptance artifacts: %s", dir)
	bin := os.Getenv("VIDEO_AGENT_BIN")
	if bin == "" {
		bin = filepath.Join(dir, "video-agent")
		cmd := exec.CommandContext(ctx, "go", "build", "-o", bin, "./cmd/video-agent")
		cmd.Dir = ".."
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build: %v %s", err, out)
		}
	}
	data := filepath.Join(dir, "工程 data +")
	call := func(input any, out any, args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, bin, append([]string{"--data", data}, args...)...)
		if input != nil {
			b, _ := json.Marshal(input)
			cmd.Stdin = bytes.NewReader(b)
		}
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			t.Fatalf("CLI %v: %v %s", args, err, stderr.String())
		}
		if err := json.Unmarshal(stdout.Bytes(), out); err != nil {
			t.Fatalf("CLI JSON: %v %s", err, stdout.String())
		}
	}
	fail := func(input any, want string, args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, bin, append([]string{"--data", data}, args...)...)
		b, _ := json.Marshal(input)
		cmd.Stdin = bytes.NewReader(b)
		out, err := cmd.CombinedOutput()
		if err == nil || !strings.Contains(string(out), want) {
			t.Fatalf("expected failure %q from %v: %v %s", want, args, err, out)
		}
	}
	write := func(name string, v any) {
		t.Helper()
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name), append(b, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ff := func(args ...string) {
		t.Helper()
		if _, err := media.Run(ctx, tools.FFmpeg, append([]string{"-hide_banner", "-v", "error", "-nostdin", "-y"}, args...)...); err != nil {
			t.Fatal(err)
		}
	}
	red := filepath.Join(dir, "red mono 24.mp4")
	blue := filepath.Join(dir, "blue 静音 29.97.mp4")
	greenBase := filepath.Join(dir, "green-base.mp4")
	green := filepath.Join(dir, "green-rotated.mp4")
	ff("-f", "lavfi", "-i", "color=c=red:s=640x360:r=24:d=20", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-shortest", red)
	ff("-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30000/1001:d=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", blue)
	ff("-f", "lavfi", "-i", "color=c=green:s=640x360:r=60:d=20", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", greenBase)
	ff("-display_rotation", "90", "-i", greenBase, "-c", "copy", green)
	var p domain.Project
	call(nil, &p, "project", "create", "--id", "p1", "--name", "P1 acceptance")
	assets := make([]domain.MediaAsset, 3)
	for i, path := range []string{red, blue, green} {
		call(nil, &assets[i], "assets", "import", "--project", "p1", "--path", path)
	}
	if assets[0].AudioChannels != 1 || assets[1].HasAudio || assets[1].Width >= assets[1].Height || assets[2].AudioChannels != 2 || assets[2].Width >= assets[2].Height || assets[2].Rotation == 0 {
		t.Fatalf("fixture metadata: %+v", assets)
	}
	var duplicate domain.MediaAsset
	call(nil, &duplicate, "assets", "import", "--project", "p1", "--path", red)
	if duplicate.ID != assets[0].ID {
		t.Fatal("duplicate file got another asset id")
	}
	var listing map[string]domain.MediaAsset
	call(nil, &listing, "assets", "list", "--project", "p1")
	if len(listing) != 3 {
		t.Fatal("asset dedup failed")
	}
	// Original file may change after import; the managed snapshot must remain valid.
	if err = os.WriteFile(red, []byte("original changed after import"), 0600); err != nil {
		t.Fatal(err)
	}
	timeline := domain.TimelineRevision{ID: "p1-timeline", ProjectID: "p1", FPSNum: 30, FPSDen: 1, Width: 1280, Height: 720, Items: []domain.ClipItem{{ID: "red", AssetID: assets[0].ID, SourceInUS: 2_000_000, SourceOutUS: 20_000_000}, {ID: "blue", AssetID: assets[1].ID, SourceInUS: 1_000_000, SourceOutUS: 19_000_000}}}
	var current domain.TimelineRevision
	call(timeline, &current, "timeline", "create", "--file", "-")
	if current.Revision != 1 || current.Items[1].StartFrame != 540 {
		t.Fatalf("timeline normalization: %+v", current)
	}
	write("timeline-initial.json", current)
	rendered := []domain.RenderJob{}
	export := func(kind, name string) domain.RenderJob {
		t.Helper()
		var j domain.RenderJob
		call(nil, &j, "render", kind, "--timeline", timeline.ID, "--output", filepath.Join(dir, name))
		if j.Status != "completed" || j.Validation == nil || !j.Validation.ProbePassed || !j.Validation.DecodePassed {
			t.Fatalf("unverified job: %+v", j)
		}
		var loaded domain.RenderJob
		call(nil, &loaded, "jobs", "get", "--id", j.ID)
		if !reflect.DeepEqual(loaded, j) {
			t.Fatal("job did not persist")
		}
		rendered = append(rendered, j)
		return j
	}
	first := export("export", "01-original.mp4")
	if first.Validation.Frames != 1080 || first.Validation.DurationUS != 36_000_000 {
		t.Fatalf("expected 36 seconds: %+v", first.Validation)
	}
	preview := export("preview", "02-preview.mp4")
	if preview.Validation.Width != 640 || preview.Validation.Frames != 1080 {
		t.Fatal("preview changed timeline or resolution")
	}
	color := func(path, ts string, want int) {
		t.Helper()
		b, err := media.Run(ctx, tools.FFmpeg, "-v", "error", "-ss", ts, "-i", path, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
		if err != nil || len(b) != 3 {
			t.Fatalf("pixel read: %v %v", err, b)
		}
		if b[want] < 80 || int(b[want]) < int(b[(want+1)%3])+40 || int(b[want]) < int(b[(want+2)%3])+40 {
			t.Fatalf("wrong content %s @ %s: RGB %v expected channel %d", path, ts, b, want)
		}
	}
	rms := func(path, ts string) float64 {
		t.Helper()
		b, err := media.Run(ctx, tools.FFmpeg, "-v", "error", "-ss", ts, "-i", path, "-t", "0.5", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-")
		if err != nil || len(b) < 100 {
			t.Fatalf("audio read: %v (%d bytes)", err, len(b))
		}
		sum := 0.0
		for i := 0; i+1 < len(b); i += 2 {
			v := float64(int16(binary.LittleEndian.Uint16(b[i:])))
			sum += v * v
		}
		return math.Sqrt(sum / float64(len(b)/2))
	}
	color(first.Output, "1", 0)
	color(first.Output, "20", 2)
	color(preview.Output, "20", 2)
	tone, silent := rms(first.Output, "1"), rms(first.Output, "20")
	if tone < 500 || silent > 2 {
		t.Fatalf("original/silent audio mismatch: %f %f", tone, silent)
	}
	apply := func(op domain.EditOperation) {
		t.Helper()
		op.ID = fmt.Sprintf("op-%d", current.Revision)
		op.TimelineID = timeline.ID
		op.BaseRevision = current.Revision
		call(op, &current, "edit", "apply", "--file", "-")
	}
	apply(domain.EditOperation{Kind: domain.OpMoveClip, TargetClipID: "blue", Index: 0})
	swapped := export("export", "03-swapped.mp4")
	color(swapped.Output, "1", 2)
	color(swapped.Output, "20", 0)
	if rms(swapped.Output, "1") > 2 || rms(swapped.Output, "20") < 500 {
		t.Fatal("audio order did not follow video order")
	}
	apply(domain.EditOperation{Kind: domain.OpReplaceClip, TargetClipID: "blue", AssetID: assets[2].ID, SourceInUS: 1_000_000, SourceOutUS: 19_000_000})
	replaced := export("export", "04-replaced.mp4")
	color(replaced.Output, "1", 1)
	color(replaced.Output, "20", 0)
	apply(domain.EditOperation{Kind: domain.OpTrimClip, TargetClipID: "red", DurationFrames: 480})
	apply(domain.EditOperation{Kind: domain.OpInsertClip, NewClipID: "inserted", AssetID: assets[1].ID, SourceOutUS: 2_000_000, Index: 1})
	apply(domain.EditOperation{Kind: domain.OpDeleteClip, TargetClipID: "inserted"})
	var reloaded domain.TimelineRevision
	call(nil, &reloaded, "timeline", "get", "--id", timeline.ID)
	if current.Revision != 6 || !reflect.DeepEqual(current, reloaded) {
		t.Fatal("five edits did not survive fresh processes")
	}
	edited := export("export", "05-edited-34s.mp4")
	if edited.Validation.Frames != 1020 || edited.Validation.DurationUS != 34_000_000 {
		t.Fatalf("trim/insert/delete did not affect rendered duration: %+v", edited.Validation)
	}
	color(edited.Output, "1", 1)
	color(edited.Output, "20", 0)
	stale := domain.EditOperation{ID: "stale", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpDeleteClip, TargetClipID: "red"}
	fail(stale, "revision_conflict", "edit", "apply", "--file", "-")
	apply(domain.EditOperation{Kind: domain.OpLockClip, TargetClipID: "red"})
	locked := domain.EditOperation{ID: "locked", TimelineID: timeline.ID, BaseRevision: current.Revision, Kind: domain.OpDeleteClip, TargetClipID: "red"}
	fail(locked, "locked", "edit", "apply", "--file", "-")
	apply(domain.EditOperation{Kind: domain.OpRestore, RestoreRevision: 1})
	if current.Items[0].AssetID != assets[0].ID || current.Items[1].StartFrame != 540 {
		t.Fatal("restore failed")
	}
	restored := export("export", "06-restored.mp4")
	color(restored.Output, "1", 0)
	if restored.Validation.SHA256 != first.Validation.SHA256 {
		t.Fatal("same plan did not reproduce identical output on same toolchain")
	}
	// Exact retry returns the stored result; changed payload is rejected.
	replay := domain.EditOperation{ID: "op-7", TimelineID: timeline.ID, BaseRevision: 7, Kind: domain.OpRestore, RestoreRevision: 1}
	var same domain.TimelineRevision
	call(replay, &same, "edit", "apply", "--file", "-")
	if same.Revision != 8 {
		t.Fatal("retry created another revision")
	}
	replay.RestoreRevision = 2
	fail(replay, "operation_id_reuse", "edit", "apply", "--file", "-")
	fail(nil, "already exists", "render", "export", "--timeline", timeline.ID, "--output", first.Output)
	if hash, _ := media.Hash(ctx, first.Output); hash != first.Validation.SHA256 {
		t.Fatal("existing export overwritten")
	}
	// Cross-project references are rejected even for valid assets.
	call(nil, &p, "project", "create", "--id", "other", "--name", "other")
	foreign := timeline
	foreign.ID = "foreign"
	foreign.ProjectID = "other"
	fail(foreign, "unknown asset", "timeline", "create", "--file", "-")
	// A modified snapshot must fail before publication and leave a durable failed job.
	if err = os.WriteFile(assets[0].Path, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	fail(nil, "changed after import", "render", "export", "--timeline", timeline.ID, "--output", filepath.Join(dir, "must-not-exist.mp4"))
	if _, err = os.Stat(filepath.Join(dir, "must-not-exist.mp4")); !os.IsNotExist(err) {
		t.Fatal("invalid output was published")
	}
	// Restore the managed fixture for the delivered demo project.
	ff("-f", "lavfi", "-i", "color=c=red:s=640x360:r=24:d=20", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-shortest", red)
	b, err := os.ReadFile(red)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(assets[0].Path, b, 0600); err != nil {
		t.Fatal(err)
	}
	if hash, _ := media.Hash(ctx, assets[0].Path); hash != assets[0].ContentHash {
		t.Fatal("fixture restoration not reproducible")
	}
	var history []domain.TimelineRevision
	call(nil, &history, "timeline", "history", "--id", timeline.ID)
	if len(history) != 8 {
		t.Fatalf("unexpected history size %d", len(history))
	}
	write("assets.json", assets)
	write("history.json", history)
	write("jobs.json", rendered)
	write("report.json", map[string]any{"passed": true, "ffmpeg": strings.Split(string(version), "\n")[0], "fixture_kind": "generated, real encoded MP4 files; not a subjective creative-quality evaluation", "checks": []string{"mixed frame rates and orientation", "rotation metadata", "mono/stereo/no-audio normalization", "content-addressed import and dedup", "original change isolation", "36-second export and preview", "pixel-verified reorder and replacement", "audio-verified reorder and silence", "five edits across fresh CLI processes", "restore and byte-identical re-export", "stale revision and locks", "idempotency payload check", "cross-project rejection", "no overwrite", "tampered source rejected"}, "original_tone_rms": tone, "silent_segment_rms": silent, "jobs": rendered, "revision_count": len(history)})
}
