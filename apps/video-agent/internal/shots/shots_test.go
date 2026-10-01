package shots

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
)

// stubRunner answers with fixed output, and records what it was asked to run.
type stubRunner struct {
	out      string
	err      error
	called   bool
	gotPath  string
	gotInter string
}

func (s *stubRunner) Run(_ context.Context, interpreter, script string, args ...string) ([]byte, error) {
	s.called = true
	s.gotInter = interpreter
	if len(args) > 0 {
		s.gotPath = args[0]
	}
	if s.err != nil {
		return nil, s.err
	}
	return []byte(s.out), nil
}

const realOutput = `{"scene_count": 3, "scenes": [
  {"index": 1, "start_us": 0, "end_us": 182333333},
  {"index": 2, "start_us": 182333333, "end_us": 198566666},
  {"index": 3, "start_us": 198566666, "end_us": 299833313}
]}`

// TestParseReadsTheScriptsOutput is the plain case: the script's object becomes
// the shot list a caller can cut along.
func TestParseReadsTheScriptsOutput(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	if result.SceneCount != 3 || len(result.Scenes) != 3 {
		t.Fatalf("scenes = %d/%d, want 3", result.SceneCount, len(result.Scenes))
	}
	if result.Scenes[1].StartUS != 182333333 || result.Scenes[1].EndUS != 198566666 {
		t.Fatalf("second scene = %+v", result.Scenes[1])
	}
}

// TestParseRejectsAnEmptyAnswer keeps a silent failure from reading as "this
// video has no cuts": every video has at least one shot, so an empty answer can
// only mean the detection did not run.
func TestParseRejectsAnEmptyAnswer(t *testing.T) {
	for _, raw := range []string{"", "   \n", `{"scene_count":0,"scenes":[]}`, "not json at all", `{"scenes":[]}`} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Fatalf("output %q was accepted", raw)
		}
	}
}

// TestParseRejectsImpossibleRanges keeps a malformed scene from becoming
// evidence: a range that runs backwards or overlaps its predecessor would put a
// cut somewhere nothing was measured.
func TestParseRejectsImpossibleRanges(t *testing.T) {
	backwards := `{"scenes":[{"index":1,"start_us":500,"end_us":100}]}`
	if _, err := Parse([]byte(backwards)); err == nil {
		t.Fatal("a backwards range was accepted")
	}
	overlapping := `{"scenes":[{"index":1,"start_us":0,"end_us":1000},{"index":2,"start_us":500,"end_us":2000}]}`
	if _, err := Parse([]byte(overlapping)); err == nil {
		t.Fatal("an overlapping scene was accepted")
	}
}

// TestParseFillsAMissingIndex covers the one field a caller cannot reconstruct:
// a scene with no index is numbered by position rather than left as zero, which
// would produce two evidence rows claiming the same identity.
func TestParseFillsAMissingIndex(t *testing.T) {
	result, err := Parse([]byte(`{"scenes":[{"start_us":0,"end_us":1000},{"start_us":1000,"end_us":2000}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.Scenes[0].Index != 1 || result.Scenes[1].Index != 2 {
		t.Fatalf("indices = %d,%d", result.Scenes[0].Index, result.Scenes[1].Index)
	}
	if result.SceneCount != 2 {
		t.Fatalf("scene_count = %d, want 2", result.SceneCount)
	}
}

// TestDetectReportsUnconfiguredSeparately proves an operator can tell "nobody
// configured this" from "this video has no cuts", which need different fixes.
func TestDetectReportsUnconfiguredSeparately(t *testing.T) {
	stub := &stubRunner{out: realOutput}
	detector := Detector{Run: stub}
	if _, err := detector.Detect(context.Background(), "/tmp/x.mp4"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
	if stub.called {
		t.Fatal("an unconfigured detector ran the script anyway")
	}
}

// TestDetectPassesThePathThrough covers the wiring: the script is given the
// media file and nothing else, so the interpreter and the script path both reach
// the runner as configured.
func TestDetectPassesThePathThrough(t *testing.T) {
	stub := &stubRunner{out: realOutput}
	detector := Detector{Interpreter: "/usr/bin/python3", Script: "/opt/shots.py", Run: stub}
	result, err := detector.Detect(context.Background(), "/media/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Scenes) != 3 {
		t.Fatalf("scenes = %d, want 3", len(result.Scenes))
	}
	if stub.gotInter != "/usr/bin/python3" || stub.gotPath != "/media/clip.mp4" {
		t.Fatalf("runner got interpreter=%q path=%q", stub.gotInter, stub.gotPath)
	}
}

// TestDetectCarriesTheScriptsFailure keeps the script's own reason: a missing
// dependency and an unreadable file need different fixes.
func TestDetectCarriesTheScriptsFailure(t *testing.T) {
	boom := errors.New("PySceneDetect is not installed for this interpreter")
	detector := Detector{Interpreter: "python", Script: "shots.py", Run: &stubRunner{err: boom}}
	_, err := detector.Detect(context.Background(), "/tmp/x.mp4")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the script's failure", err)
	}
}

// TestEvidenceDescribesEachShot pins the row a shot produces: it is retrievable
// by the words in it, and it names the run of continuous footage so a cut can be
// aimed at the boundary rather than at an estimated time.
func TestEvidenceDescribesEachShot(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	asset := domain.MediaAsset{
		ID: "asset-s", ProjectID: "p", ContentHash: "h",
		DurationUS: 299833313, Width: 1920, Height: 1080, FPS: "30/1",
	}
	rows := Evidence(asset, result)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	for i, row := range rows {
		if row.Provider != "scenedetect" || row.AssetID != "asset-s" || row.ProjectID != "p" {
			t.Fatalf("row %d is not attributable: %+v", i, row)
		}
		if row.VisualSummary == "" {
			t.Fatalf("row %d has no description", i)
		}
		if row.StartUS != result.Scenes[i].StartUS || row.EndUS != result.Scenes[i].EndUS {
			t.Fatalf("row %d spans %d-%d, want the shot's own range", i, row.StartUS, row.EndUS)
		}
	}
	if !strings.Contains(rows[1].VisualSummary, "镜头 2") {
		t.Fatalf("second row does not name its shot: %q", rows[1].VisualSummary)
	}
}

// TestEvidenceClipsToTheAsset keeps a row inside the recording: a shot detected
// a frame past the measured duration must not claim time the asset lacks.
func TestEvidenceClipsToTheAsset(t *testing.T) {
	result := Result{Scenes: []Scene{{Index: 1, StartUS: 0, EndUS: 5_000_000}}}
	asset := domain.MediaAsset{ID: "a", ProjectID: "p", DurationUS: 4_000_000}
	rows := Evidence(asset, result)
	if len(rows) != 1 || rows[0].EndUS != 4_000_000 {
		t.Fatalf("rows = %+v", rows)
	}
	// A shot entirely past the asset is dropped rather than stored with an
	// inverted range.
	past := Result{Scenes: []Scene{{Index: 2, StartUS: 9_000_000, EndUS: 10_000_000}}}
	if rows := Evidence(asset, past); len(rows) != 0 {
		t.Fatalf("a shot past the asset produced %+v", rows)
	}
}

// TestContainFindsTheShotAroundAnInstant is the snap: a model's estimated
// instant is replaced by the shot it falls in, so the interval handed to a cut
// is bounded by pixels rather than by a guess.
func TestContainFindsTheShotAroundAnInstant(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		at   int64
		want int
		ok   bool
	}{
		{at: 0, want: 1, ok: true},
		{at: 185_000_000, want: 2, ok: true},
		{at: 182_333_332, want: 1, ok: true},
		{at: 182_333_333, want: 2, ok: true},
		{at: 299_833_313, want: 3, ok: true},
		{at: 300_000_000, want: 0, ok: false},
	}
	for _, tc := range cases {
		scene, ok := Contain(result, tc.at)
		if ok != tc.ok {
			t.Fatalf("Contain(%d) ok = %v, want %v", tc.at, ok, tc.ok)
		}
		if ok && scene.Index != tc.want {
			t.Fatalf("Contain(%d) = shot %d, want %d", tc.at, scene.Index, tc.want)
		}
	}
}

// TestSnapWidensAnEstimateToWholeShots is the precision gain the shot layer
// exists for: a soft estimate around the saucer becomes the shot that actually
// contains it.
func TestSnapWidensAnEstimateToWholeShots(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	start, end, covered := Snap(result, 185_000_000, 195_000_000)
	if start != 182333333 || end != 198566666 {
		t.Fatalf("snapped to %d-%d, want the shot 182333333-198566666", start, end)
	}
	if len(covered) != 1 || covered[0].Index != 2 {
		t.Fatalf("covered %+v, want shot 2", covered)
	}
}

// TestSnapSpansEveryShotAnIntervalTouches handles an estimate that crosses a
// cut: the result is every continuous run it overlapped, in order.
func TestSnapSpansEveryShotAnIntervalTouches(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	start, end, covered := Snap(result, 180_000_000, 200_000_000)
	if start != 0 || end != 299833313 {
		t.Fatalf("snapped to %d-%d, want the whole video", start, end)
	}
	if len(covered) != 3 {
		t.Fatalf("covered %d shots, want 3", len(covered))
	}
}

// TestSnapAdmitsAnEstimateThatLandedNowhere keeps the snap honest: substituting
// an unrelated shot would be worse than reporting that the estimate missed.
func TestSnapAdmitsAnEstimateThatLandedNowhere(t *testing.T) {
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	start, end, covered := Snap(result, 400_000_000, 410_000_000)
	if start != 400_000_000 || end != 410_000_000 {
		t.Fatalf("an out-of-range estimate was moved to %d-%d", start, end)
	}
	if len(covered) != 0 {
		t.Fatalf("covered %+v, want nothing", covered)
	}
	if _, _, covered := Snap(result, 5, 5); len(covered) != 0 {
		t.Fatal("an empty interval covered something")
	}
}

// TestSummaryReportsTheShotListShape keeps the one-line report useful: how many
// shots, and how long the longest and shortest are.
func TestSummaryReportsTheShotListShape(t *testing.T) {
	if got := Summary(Result{}); got != "no shots" {
		t.Fatalf("empty summary = %q", got)
	}
	result, err := Parse([]byte(realOutput))
	if err != nil {
		t.Fatal(err)
	}
	got := Summary(result)
	if !strings.Contains(got, "shots=3") || !strings.Contains(got, "shortest=16.2s") {
		t.Fatalf("summary = %q", got)
	}
}
