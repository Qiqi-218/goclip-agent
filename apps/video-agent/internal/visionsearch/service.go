// Package visionsearch answers "where in this video does X appear?" by looking at
// the video, not by matching text.
//
// An asset's indexed frame descriptions are a keyword index: they can only
// answer a query whose words happen to appear in a description somebody already
// wrote. A creator asking to cut "the bit with the flying saucer" is describing
// something they saw, and the model that indexed the asset may have recorded it
// as a saucer, a UFO, an alien craft, or not mentioned it at all. This package
// instead samples the requested window and asks the vision model about the
// creator's own words, so the lookup succeeds on meaning rather than vocabulary.
package visionsearch

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/zylar06/video-agent/internal/analysis/visual"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
	"github.com/zylar06/video-agent/internal/store"
)

// DefaultFrames bounds how many frames one question inspects. Every frame is a
// separate vision call, so this is the cost ceiling of a single lookup.
const DefaultFrames = 24

// MaxFrames caps a caller's request: past this the answer stops being
// interactive and a narrower time window is the better move.
const MaxFrames = 60

// SparseIntervalUS is the sampling gap beyond which a miss is not trustworthy:
// a shot shorter than the gap can fall entirely between two frames. Ten seconds
// is roughly the shortest appearance a creator would still describe as a moment
// worth cutting.
const SparseIntervalUS = 10_000_000

// Match is one moment where the subject appears, carrying the model's own reason
// so a finding can be checked rather than trusted.
type Match struct {
	StartUS int64  `json:"start_us"`
	EndUS   int64  `json:"end_us"`
	Frame   string `json:"frame"`
	Reason  string `json:"reason"`
	// ShotIndex and ShotEndUS report the continuous camera run this match landed
	// in, when the asset's shots are known. The frame's own interval is the width
	// of one sample, which says nothing about how long the thing stays on screen;
	// the shot is the run of footage it appeared in, so it is what a cut should
	// be aimed at. Absent when shot detection has not been run.
	ShotIndex int   `json:"shot_index,omitempty"`
	ShotEndUS int64 `json:"shot_end_us,omitempty"`
}

// Result is the outcome of one visual search.
type Result struct {
	Query       string  `json:"query"`
	Scanned     int     `json:"scanned"`
	Matches     []Match `json:"matches"`
	Note        string  `json:"note,omitempty"`
	WindowStart int64   `json:"window_start_us"`
	WindowEnd   int64   `json:"window_end_us"`
	// Sparse marks a miss whose sampling was too coarse to trust.
	Sparse bool `json:"sparse_sampling,omitempty"`
}

// Asker is the vision capability this package needs, kept narrow so it can be
// faked in tests without a live provider.
type Asker interface {
	Ask(ctx context.Context, imagePath, prompt string) (string, error)
}

// Sampler extracts frames from a window. Narrow for the same reason.
type Sampler interface {
	Sample(ctx context.Context, tools media.Tools, asset domain.MediaAsset, dir string) ([]domain.Evidence, error)
}

type Service struct {
	Store *store.Store
	Tools media.Tools
	Ask   Asker
	// NewSampler defaults to the ffmpeg sampler and is overridable in tests.
	NewSampler func(startUS, endUS int64, count int) Sampler
}

func (s Service) sampler(startUS, endUS int64, count int) Sampler {
	if s.NewSampler != nil {
		return s.NewSampler(startUS, endUS, count)
	}
	span := endUS - startUS
	interval := span / int64(count)
	if interval < 1_000_000 {
		interval = 1_000_000
	}
	return visual.Sampler{StartUS: startUS, DurationUS: span, IntervalUS: interval, MaxFrames: count + 1}
}

// Search looks for subject inside a window of the asset and returns the frames
// where the vision model reports it present.
func (s Service) Search(ctx context.Context, projectID, assetID, subject string, startUS, endUS int64, frames int) (Result, error) {
	if s.Ask == nil {
		return Result{}, errors.New("model provider unavailable: no vision provider is configured, so frames cannot be examined")
	}
	subject = strings.TrimSpace(subject)
	if subject == "" {
		return Result{}, errors.New("a subject to look for is required")
	}
	if s.Store == nil {
		return Result{}, errors.New("visual search requires a store")
	}
	asset, err := s.Store.Asset(projectID, assetID)
	if err != nil {
		return Result{}, err
	}
	if frames <= 0 {
		frames = DefaultFrames
	}
	if frames > MaxFrames {
		frames = MaxFrames
	}
	// A window narrower than the asset means the caller is narrowing the search;
	// an absent or inverted one means the whole asset.
	if startUS < 0 {
		startUS = 0
	}
	if endUS <= startUS || endUS > asset.DurationUS {
		endUS = asset.DurationUS
	}
	if startUS >= endUS {
		return Result{}, fmt.Errorf("empty time window: %d..%d", startUS, endUS)
	}

	dir := filepath.Join(s.Store.Dir, "visionsearch", asset.ID,
		fmt.Sprintf("%d-%d-%d", startUS, endUS, frames))
	found, err := s.sampler(startUS, endUS, frames).Sample(ctx, s.Tools, asset, dir)
	if err != nil {
		return Result{}, err
	}

	result := Result{Query: subject, WindowStart: startUS, WindowEnd: endUS}
	for _, frame := range found {
		if len(frame.FrameRefs) == 0 {
			continue
		}
		result.Scanned++
		answer, err := s.Ask.Ask(ctx, frame.FrameRefs[0], matchPrompt(subject))
		if err != nil {
			return Result{}, err
		}
		if hit, reason := interpret(answer); hit {
			result.Matches = append(result.Matches, Match{
				StartUS: frame.StartUS, EndUS: frame.EndUS, Frame: frame.FrameRefs[0], Reason: reason,
			})
		}
	}
	if len(result.Matches) == 0 {
		result.Note = "看了 " + strconv.Itoa(result.Scanned) + " 帧，没有出现「" + subject +
			"」。这说明这段范围里确实没有；可以放宽时间范围、增加帧数，或换一种说法再找。"
		// A sparse scan is the most likely reason for a miss on a subject that is
		// really there: with a 25-second gap a ten-second shot falls between two
		// frames and is never looked at. Say so, and say how to fix it, rather
		// than letting the caller conclude the subject is absent.
		if intervalUS := (endUS - startUS) / int64(result.Scanned); intervalUS > SparseIntervalUS {
			result.Note += " 注意：当前间隔约 " + strconv.FormatInt(intervalUS/1_000_000, 10) +
				" 秒一帧，画面里短暂出现的东西可能正好落在两帧之间。若用户确信看到过，请提高 frames 或先用更小的时间范围再找。"
			result.Sparse = true
		}
	}
	// Attach the shot each match landed in, so a caller can cut along a boundary
	// read off the pixels instead of the width of one sample.
	s.attachShots(projectID, assetID, result)
	return result, nil
}

// attachShots records the shot containing each match.
//
// The shot comes from evidence the shot detector already stored rather than from
// a fresh detection pass: detection costs about a third of the video's length, so
// running it again for every question would make asking expensive.
//
// A search with no shots recorded is left as it was. That is the honest outcome
// rather than a fabricated boundary: the caller sees the frame's own interval and
// can ask for detection if a boundary is needed.
//
// @param projectID - the project the asset belongs to.
// @param assetID - the asset that was searched.
// @param result - the result to annotate in place.
func (s Service) attachShots(projectID, assetID string, result Result) {
	if s.Store == nil || len(result.Matches) == 0 {
		return
	}
	rows, err := s.Store.Evidence(projectID, []string{assetID})
	if err != nil {
		return
	}
	type shot struct {
		index int
		start int64
		end   int64
	}
	shotList := []shot{}
	for _, row := range rows {
		if row.Provider != "scenedetect" || row.AssetID != assetID {
			continue
		}
		index, convErr := strconv.Atoi(strings.TrimPrefix(row.ID, row.AssetID+"-shot-"))
		if convErr != nil {
			index = len(shotList) + 1
		}
		shotList = append(shotList, shot{index: index, start: row.StartUS, end: row.EndUS})
	}
	if len(shotList) == 0 {
		return
	}
	sort.Slice(shotList, func(i, j int) bool { return shotList[i].start < shotList[j].start })
	for i := range result.Matches {
		at := result.Matches[i].StartUS
		for _, candidate := range shotList {
			if at >= candidate.start && at < candidate.end {
				result.Matches[i].ShotIndex = candidate.index
				result.Matches[i].ShotEndUS = candidate.end
				break
			}
		}
	}
}

// matchPrompt asks one narrow question per frame. A verdict plus a short reason
// keeps the answer cheap and, more importantly, checkable by the person who
// asked.
func matchPrompt(subject string) string {
	return "只回答这一个问题：这帧画面里是否出现了「" + subject + "」？\n" +
		"如果出现：第一行只写「是」，第二行用不超过 20 字说明你看到的是什么。\n" +
		"如果没有出现：第一行只写「否」，第二行留空。\n" +
		"不要描述画面的其他内容，不要猜测画外信息。"
}

// interpret reads the first line as the verdict. Tolerating both languages and
// stray markdown keeps a chatty model from turning a hit into a miss.
func interpret(answer string) (bool, string) {
	lines := strings.Split(strings.TrimSpace(answer), "\n")
	if len(lines) == 0 {
		return false, ""
	}
	head := strings.ToLower(strings.TrimSpace(lines[0]))
	head = strings.Trim(head, "。.,，:：*# 「」\"'")
	reason := ""
	if len(lines) > 1 {
		reason = strings.Trim(strings.TrimSpace(strings.Join(lines[1:], " ")), "*# ")
	}
	switch {
	case strings.HasPrefix(head, "是"), strings.HasPrefix(head, "yes"), strings.HasPrefix(head, "true"):
		return true, reason
	default:
		return false, ""
	}
}
