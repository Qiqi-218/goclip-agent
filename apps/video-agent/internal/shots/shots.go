// Package shots reads a video's shot boundaries.
//
// A shot boundary is where one continuous camera run ends and the next begins.
// It matters twice over. It is the unit a vision model should be asked about,
// because a description of "a shot" is a description of one thing rather than a
// sample of several. And it is what a model's own time estimate can be snapped
// to: a vision model that says "around 190 seconds" is reporting a guess, while
// the cut it lands in is a fact read off the pixels, so an interval bounded by
// shots is defensible in a way a raw model estimate is not.
//
// Detection itself is delegated to PySceneDetect. It is the maintained
// implementation of exactly this, and reimplementing a frame-difference
// threshold that already has years of tuning behind it would mean owning that
// tuning.
package shots

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/zylar06/video-agent/internal/domain"
)

// Runner executes the detection script and returns its standard output.
//
// It is a seam rather than a direct call so the parsing and the evidence
// construction can be tested without a video or a Python interpreter.
type Runner interface {
	Run(ctx context.Context, interpreter, script string, args ...string) ([]byte, error)
}

// Detector finds a video's shots.
type Detector struct {
	// Interpreter runs the script. Empty means no detection is available, which
	// the caller reports rather than treating as "this video has no cuts".
	Interpreter string
	// Script is the path to the detection script.
	Script string
	// Run executes the script. Nil means exec the interpreter directly.
	Run Runner
}

// Scene is one detected shot.
type Scene struct {
	// Index is the scene's 1-based position in the video.
	Index int `json:"index"`
	// StartUS and EndUS bound the shot.
	StartUS int64 `json:"start_us"`
	EndUS   int64 `json:"end_us"`
}

// Result is one detection run.
type Result struct {
	SceneCount int     `json:"scene_count"`
	Scenes     []Scene `json:"scenes"`
}

// ErrNotConfigured reports that no interpreter or script was named, so the
// caller can say "shot detection is not configured" instead of "no cuts found".
var ErrNotConfigured = errors.New("shot detection is not configured: set the interpreter and script paths")

// configured reports whether detection can run at all.
// @returns true when both the interpreter and the script are named.
func (d Detector) configured() bool {
	return strings.TrimSpace(d.Interpreter) != "" && strings.TrimSpace(d.Script) != ""
}

// Detect finds the asset's shots.
//
// @param ctx - cancellation for the run.
// @param path - the media file to analyse.
// @returns the detected shots.
// @throws ErrNotConfigured when detection cannot run, and the script's own
// failure otherwise.
func (d Detector) Detect(ctx context.Context, path string) (Result, error) {
	if !d.configured() {
		return Result{}, ErrNotConfigured
	}
	run := d.Run
	if run == nil {
		run = execRunner{}
	}
	raw, err := run.Run(ctx, d.Interpreter, d.Script, path)
	if err != nil {
		return Result{}, err
	}
	return Parse(raw)
}

// execRunner runs the script as a child process.
type execRunner struct{}

// Run executes the interpreter and returns its standard output.
//
// Standard error is captured so a failure can name the script's own reason: a
// missing dependency and an unreadable file are different problems and the
// operator has to be able to tell them apart.
//
// @param ctx - cancellation for the process.
// @param interpreter - the Python interpreter to run.
// @param script - the detection script.
// @param args - arguments for the script.
// @returns the script's standard output.
// @throws when the process fails, carrying its standard error.
func (execRunner) Run(ctx context.Context, interpreter, script string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, interpreter, append([]string{script}, args...)...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		reason := strings.TrimSpace(stderr.String())
		if reason == "" {
			reason = err.Error()
		}
		return nil, fmt.Errorf("shot detection failed: %s", reason)
	}
	return []byte(stdout.String()), nil
}

// Parse reads the detection script's output.
//
// An empty or malformed answer is an error rather than an empty result: a video
// always has at least one shot, so "no shots" cannot be true and must not be
// reported as if it were.
//
// @param raw - the script's standard output.
// @returns the parsed shots.
// @throws when the output is not the expected object or names no shots.
func Parse(raw []byte) (Result, error) {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return Result{}, errors.New("shot detection produced no output")
	}
	var result Result
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return Result{}, fmt.Errorf("shot detection output is not the expected JSON: %w", err)
	}
	if len(result.Scenes) == 0 {
		return Result{}, errors.New("shot detection found no shots, which every video has at least one of")
	}
	previous := int64(-1)
	for i, scene := range result.Scenes {
		if scene.EndUS <= scene.StartUS {
			return Result{}, fmt.Errorf("scene %d spans %d-%d, which is not a range", scene.Index, scene.StartUS, scene.EndUS)
		}
		if scene.StartUS < previous {
			return Result{}, fmt.Errorf("scene %d starts at %d, before the previous scene ended at %d", scene.Index, scene.StartUS, previous)
		}
		previous = scene.EndUS
		// A missing index is the one field a caller cannot reconstruct, so it is
		// filled from position rather than left zero.
		if result.Scenes[i].Index == 0 {
			result.Scenes[i].Index = i + 1
		}
	}
	result.SceneCount = len(result.Scenes)
	return result, nil
}

// Evidence turns detected shots into evidence, one row per shot.
//
// A shot's row carries its description, so the whole shot is retrievable by the
// words that describe it and a cut can be aimed at a boundary rather than at a
// time someone estimated.
//
// @param asset - the asset the shots were detected in.
// @param result - the detected shots.
// @returns one evidence row per shot, in order.
func Evidence(asset domain.MediaAsset, result Result) []domain.Evidence {
	out := make([]domain.Evidence, 0, len(result.Scenes))
	for _, scene := range result.Scenes {
		start, end := scene.StartUS, scene.EndUS
		if end > asset.DurationUS {
			end = asset.DurationUS
		}
		if start >= end {
			continue
		}
		out = append(out, domain.Evidence{
			ID:               fmt.Sprintf("%s-shot-%04d", asset.ID, scene.Index),
			ProjectID:        asset.ProjectID,
			AssetID:          asset.ID,
			StartUS:          start,
			EndUS:            end,
			AssetContentHash: asset.ContentHash,
			VisualSummary:    describeShot(scene, asset.DurationUS),
			Provider:         "scenedetect",
			AnalyzerVersion:  "shots-v1",
		})
	}
	return out
}

// describeShot writes a shot's row the way the other analyzers write theirs, so
// the model reads one kind of sentence and matches the user's words against it.
// @param scene - the shot.
// @param durationUS - the asset's length, for framing the shot within it.
// @returns the model-facing description.
func describeShot(scene Scene, durationUS int64) string {
	seconds := float64(scene.EndUS-scene.StartUS) / 1e6
	position := "全片"
	if durationUS > 0 {
		percent := float64(scene.StartUS) / float64(durationUS) * 100
		position = fmt.Sprintf("全片约 %.0f%% 处", percent)
	}
	return fmt.Sprintf("镜头 %d：%s 起，持续 %.1f 秒（%s）。这是一次连续拍摄，画面内容在这里没有切换。",
		scene.Index, clock(scene.StartUS), seconds, position)
}

// clock formats a microsecond offset as `m:ss.s`.
// @param us - the offset in microseconds.
// @returns the formatted time.
func clock(us int64) string {
	if us < 0 {
		us = 0
	}
	total := float64(us) / 1e6
	minutes := int(total) / 60
	seconds := total - float64(minutes*60)
	return fmt.Sprintf("%d:%04.1f", minutes, seconds)
}

// Contain returns the shot containing an instant, and whether one was found.
//
// This is the snap: a model's estimated instant is replaced by the shot it falls
// in, so the interval handed to a cut is bounded by pixels rather than by a
// guess. The last shot includes its own end, because an instant exactly on the
// final boundary belongs to the video rather than to nothing.
//
// @param result - the detected shots.
// @param atUS - the instant to place.
// @returns the containing shot and whether the instant fell inside the video.
func Contain(result Result, atUS int64) (Scene, bool) {
	for i, scene := range result.Scenes {
		last := i == len(result.Scenes)-1
		if atUS >= scene.StartUS && (atUS < scene.EndUS || (last && atUS <= scene.EndUS)) {
			return scene, true
		}
	}
	return Scene{}, false
}

// Snap narrows an interval to the shots it touches.
//
// A model that says "the saucer is around 185 to 200 seconds" has given an
// estimate with soft edges; the shots are hard edges. Returning whole shots that
// the interval overlaps is what makes the answer checkable — every frame in the
// result is inside a run of continuous footage the model was talking about.
//
// When the interval falls outside every shot the original interval is returned
// unchanged, because silently substituting an unrelated shot would be worse than
// admitting the estimate did not land.
//
// @param result - the detected shots.
// @param startUS - the estimated start.
// @param endUS - the estimated end.
// @returns the snapped interval and the shots it covers.
func Snap(result Result, startUS, endUS int64) (int64, int64, []Scene) {
	if endUS <= startUS {
		return startUS, endUS, nil
	}
	covered := []Scene{}
	for _, scene := range result.Scenes {
		if scene.StartUS < endUS && scene.EndUS > startUS {
			covered = append(covered, scene)
		}
	}
	if len(covered) == 0 {
		return startUS, endUS, nil
	}
	return covered[0].StartUS, covered[len(covered)-1].EndUS, covered
}

// Summary reports the shot list's shape in one line.
// @param result - the detected shots.
// @returns a one-line summary.
func Summary(result Result) string {
	if len(result.Scenes) == 0 {
		return "no shots"
	}
	var longest, shortest int64
	for i, scene := range result.Scenes {
		length := scene.EndUS - scene.StartUS
		if i == 0 || length > longest {
			longest = length
		}
		if i == 0 || length < shortest {
			shortest = length
		}
	}
	return fmt.Sprintf("shots=%d longest=%.1fs shortest=%.1fs", len(result.Scenes),
		float64(longest)/1e6, float64(shortest)/1e6)
}

// DefaultScriptPath finds the detection script beside the executable or in the
// working tree, so a deployment that forgot to configure it still works when the
// script is where the repository puts it.
// @returns the first existing candidate path, or an empty string.
func DefaultScriptPath() string {
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "scripts", "shots.py"),
			filepath.Join(dir, "..", "scripts", "shots.py"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "scripts", "shots.py"),
			filepath.Join(wd, "..", "scripts", "shots.py"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

// envInterpreter is the environment variable naming the interpreter that has
// PySceneDetect installed. It names the interpreter rather than a version
// because a deployment may keep this dependency outside the project's own venv.
const envInterpreter = "VIDEO_AGENT_SHOTS_PYTHON"

// envScript is the environment variable naming the detection script.
const envScript = "VIDEO_AGENT_SHOTS_SCRIPT"

// FromEnv builds a detector from the environment, falling back to the script
// location the repository uses.
// @returns the configured detector, and whether it can run.
func FromEnv() (Detector, bool) {
	detector := Detector{
		Interpreter: strings.TrimSpace(os.Getenv(envInterpreter)),
		Script:      strings.TrimSpace(os.Getenv(envScript)),
	}
	if detector.Script == "" {
		detector.Script = DefaultScriptPath()
	}
	return detector, detector.configured()
}
