package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/zylar06/video-agent/internal/analysis"
	"github.com/zylar06/video-agent/internal/analysis/provider"
	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/catalog"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/edit"
	"github.com/zylar06/video-agent/internal/shots"
	"github.com/zylar06/video-agent/internal/store"
	"github.com/zylar06/video-agent/internal/visionsearch"
)

const APIVersion = "v1"

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Envelope struct {
	APIVersion string    `json:"api_version"`
	OK         bool      `json:"ok"`
	Result     any       `json:"result,omitempty"`
	Error      *APIError `json:"error,omitempty"`
}

// Service is the constrained P3 boundary used by both the JSON CLI and HTTP.
// It deliberately exposes typed actions rather than raw database or filesystem
// access, so an external Code Agent cannot bypass revisions or asset ownership.
type Service struct{ App *app.App }

func NewService(a *app.App) *Service { return &Service{App: a} }

func (s *Service) Names() []string {
	return []string{"analyze", "assets_import", "assets_list", "edit_apply", "evidence_add", "find_in_video", "jobs_cancel", "jobs_get", "jobs_list", "level_curve", "project_create", "project_get", "project_list", "proposal_create", "render_submit", "search", "timeline_create", "timeline_get", "timeline_history", "timeline_list", "shots"}
}

func (s *Service) Call(ctx context.Context, name string, raw json.RawMessage) Envelope {
	result, err := s.call(ctx, name, raw)
	if err != nil {
		return Envelope{APIVersion: APIVersion, OK: false, Error: classify(err)}
	}
	return Envelope{APIVersion: APIVersion, OK: true, Result: result}
}

// levelFromSummary reads a window's measured level back out of the sentence the
// analyzer wrote. The row's own field is prose because the model reads it, so the
// number is parsed back out for consumers that draw it.
// @param summary - the row's acoustic summary.
// @returns the level in dBFS and whether one was found.
func levelFromSummary(summary string) (float64, bool) {
	match := levelPattern.FindStringSubmatch(summary)
	if match == nil {
		return 0, false
	}
	value, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// levelPattern matches the measured level inside an acoustic summary.
var levelPattern = regexp.MustCompile(`本秒\s*(-?\d+(?:\.\d+)?)\s*dBFS`)

// levelEvent names how far above the recording's own floor a window sat, using
// the same labels the analyzer wrote.
// @param summary - the row's acoustic summary.
// @returns "peak", "rise", "steady", or "" when the summary names none.
func levelEvent(summary string) string {
	switch {
	case strings.Contains(summary, "音量峰值"):
		return "peak"
	case strings.Contains(summary, "音量明显升高"):
		return "rise"
	case strings.Contains(summary, "音量平稳"):
		return "steady"
	default:
		return ""
	}
}

func decode(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return fmt.Errorf("invalid input: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("invalid input: expected exactly one JSON object")
	}
	return nil
}

func (s *Service) call(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	switch name {
	case "project_create":
		var in domain.Project
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return in, s.App.Store.CreateProject(in)
	case "project_list":
		var in struct{}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		projects, err := s.App.Store.Projects()
		if err != nil {
			return nil, err
		}
		// Include the asset count so the agent does not have to walk every
		// project with assets_list just to find the one holding footage.
		type projectSummary struct {
			domain.Project
			AssetCount int `json:"asset_count"`
		}
		out := make([]projectSummary, 0, len(projects))
		for _, p := range projects {
			assets, err := s.App.Store.Assets(p.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, projectSummary{Project: p, AssetCount: len(assets)})
		}
		return out, nil
	case "project_get":
		var in struct {
			ID string `json:"id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.Project(in.ID)
	case "assets_import":
		var in struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Tools.Import(ctx, s.App.Store, in.ProjectID, in.Path)
	case "assets_list":
		var in struct {
			ProjectID string `json:"project_id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		if _, err := s.App.Store.Project(in.ProjectID); err != nil {
			return nil, err
		}
		return s.App.Store.Assets(in.ProjectID)
	case "timeline_create":
		var in domain.TimelineRevision
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.CreateTimeline(in)
	case "timeline_list":
		var in struct {
			ProjectID string `json:"project_id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.ProjectTimelines(in.ProjectID)
	case "timeline_get":
		var in struct {
			ID       string `json:"id"`
			Revision int    `json:"revision,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		if in.Revision == 0 {
			return s.App.Store.Current(in.ID)
		}
		return s.App.Store.Revision(in.ID, in.Revision)
	case "timeline_history":
		var in struct {
			ID string `json:"id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.History(in.ID)
	case "evidence_add":
		var in domain.Evidence
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.PutEvidence(in)
	case "analyze":
		var in struct {
			ProjectID       string         `json:"project_id"`
			AssetID         string         `json:"asset_id"`
			SubtitlePath    string         `json:"subtitle_path,omitempty"`
			AnalyzerVersion string         `json:"analyzer_version,omitempty"`
			Provider        string         `json:"provider,omitempty"`
			Parameters      map[string]any `json:"parameters,omitempty"`
			// Frame sampling is on unless the caller turns it off. Understanding a
			// video from subtitles alone misses everything that is shown rather
			// than said (a goal, an expression, an on-screen chart), and a model
			// that has to remember to opt in mostly will not.
			SkipVisual bool `json:"skip_visual,omitempty"`
			// The loudness curve is on for the same reason and costs nothing: it
			// is decoded locally rather than sent to a model, so a caller that
			// never asked for it would only lose the axis a cut is judged on.
			SkipAudio bool `json:"skip_audio,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return analysis.New(s.App.Store, s.App.Tools).Analyze(ctx, analysis.Request{ProjectID: in.ProjectID, AssetID: in.AssetID, SubtitlePath: in.SubtitlePath, AnalyzerVersion: in.AnalyzerVersion, Provider: in.Provider, Parameters: in.Parameters, Visual: !in.SkipVisual, Audio: !in.SkipAudio})
	case "find_in_video":
		var in struct {
			ProjectID string `json:"project_id"`
			AssetID   string `json:"asset_id"`
			Subject   string `json:"subject"`
			StartUS   int64  `json:"start_us,omitempty"`
			EndUS     int64  `json:"end_us,omitempty"`
			Frames    int    `json:"frames,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		vision := provider.ConfigFromEnvAliases("VIDEO_AGENT_VISION", "AUTOCLIP_VISION")
		return visionsearch.Service{
			Store: s.App.Store,
			Tools: s.App.Tools,
			Ask:   provider.OpenAIVision{Config: vision},
		}.Search(ctx, in.ProjectID, in.AssetID, in.Subject, in.StartUS, in.EndUS, in.Frames)
	case "shots":
		var in struct {
			ProjectID string `json:"project_id"`
			AssetID   string `json:"asset_id"`
			// Record writes the shots as evidence. It is on by default because a
			// shot list nobody stored is a computation thrown away.
			SkipRecord bool `json:"skip_record,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		asset, err := s.App.Store.Asset(in.ProjectID, in.AssetID)
		if err != nil {
			return nil, err
		}
		detector, ok := shots.FromEnv()
		if !ok {
			return nil, errors.New("shot detection is not configured: set VIDEO_AGENT_SHOTS_PYTHON to an interpreter with PySceneDetect installed")
		}
		result, err := detector.Detect(ctx, asset.Path)
		if err != nil {
			return nil, err
		}
		recorded := 0
		if !in.SkipRecord {
			for _, e := range shots.Evidence(asset, result) {
				if _, err = s.App.Store.PutEvidence(e); err != nil {
					return nil, err
				}
				recorded++
			}
		}
		return map[string]any{
			"scene_count": result.SceneCount,
			"scenes":      result.Scenes,
			"recorded":    recorded,
			"summary":     shots.Summary(result),
		}, nil
	case "level_curve":
		var in struct {
			ProjectID string `json:"project_id"`
			AssetID   string `json:"asset_id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		rows, err := s.App.Store.Evidence(in.ProjectID, []string{in.AssetID})
		if err != nil {
			return nil, err
		}
		// One measured second per entry, in order, so a caller can draw the curve
		// without paging a keyword search. Retrieval caps a page at 100 rows,
		// which silently truncated the picture of any asset longer than that.
		type second struct {
			StartUS int64   `json:"start_us"`
			EndUS   int64   `json:"end_us"`
			DBFS    float64 `json:"dbfs"`
			Event   string  `json:"event,omitempty"`
			// Label is what this second sounds like, when a labeller named it. It
			// rides beside the event shape rather than replacing it, because the
			// two answer different questions: Event says how loud this second was
			// relative to the recording, Label says what the sound was.
			Label string `json:"label,omitempty"`
		}
		out := make([]second, 0, len(rows))
		for _, e := range rows {
			if e.Provider != "acoustic" || e.AssetID != in.AssetID {
				continue
			}
			db, ok := levelFromSummary(e.AcousticSummary)
			if !ok {
				continue
			}
			out = append(out, second{
				StartUS: e.StartUS,
				EndUS:   e.EndUS,
				DBFS:    db,
				Event:   levelEvent(e.AcousticSummary),
				Label:   e.EventLabel,
			})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].StartUS < out[j].StartUS })
		// The envelope's own `result` is the array, not an object wrapping one.
		// A model that receives `{"seconds":[…],"count":300}` can read the object
		// as "no data" and report an empty curve, which is what happened once:
		// the measurement was complete and the answer was called empty. The array
		// is therefore the whole result, and the count is its length.
		if len(out) == 0 {
			return []second{}, nil
		}
		return out, nil
	case "search":
		var in catalog.SearchRequest
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		result, err := s.App.Store.SearchEvidence(in.ProjectID, in.Query, in.AssetIDs, in.Limit)
		if err != nil {
			return nil, err
		}
		// No hits is a legitimate answer, not a tool failure. Returning an error
		// here read to the model as "the tool is broken" and sent it retrying the
		// same lookup with synonyms, so the absence of a match is reported as a
		// successful empty result the model can act on.
		//
		// The note therefore has to do real work. A model that reads "no results"
		// as "try another word" will spend a whole turn cycling synonyms, and the
		// measurement layer that could have answered the question in one call goes
		// unused. Two things stop that: naming the search's own limits, and naming
		// the tools that answer the questions this one cannot.
		if len(result) == 0 {
			return map[string]any{
				"matches": []any{},
				"count":   0,
				"query":   in.Query,
				"note": "没有证据包含「" + in.Query + "」。这是有效结果，不是故障 —— " +
					"本工具只做**字面**匹配（字幕文本、画面描述、音频事件名），它不理解语义，也不包含任何未说出口的信息。" +
					"**不要换同义词反复重试**：换个词命中率不会提高，只会浪费轮次。" +
					"改走能真正回答问题的工具：" +
					"① 找「精彩/高光/高潮/激动人心」这类没有具体所指的词 —— 永远不要用它来搜，" +
					"应该用 video_level_curve 找响度峰值和音量突起（观众的笑声、掌声、欢呼、音乐的推进都在这里），" +
					"用 video_shots 看镜头切点密度（切得快通常就是节奏紧的地方），" +
					"用 video_find_in_video 看画面里的动作；" +
					"② 找具体的人、物、场景 —— 用 video_find_in_video（它真的抽帧看画面，能找字幕里没有的东西）；" +
					"③ 找一个你确信素材里被说出来的词 —— 再用本工具。" +
					"另外：若还没做过内容理解，先调 video_analyze；没有证据时本工具必然为空。",
			}, nil
		}
		return map[string]any{"matches": result, "count": len(result), "query": in.Query}, nil
	case "proposal_create":
		var in struct {
			TimelineID string `json:"timeline_id"`
			Query      string `json:"query"`
			Limit      int    `json:"limit,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.propose(in.TimelineID, in.Query, in.Limit)
	case "edit_apply":
		var in domain.EditOperation
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return edit.NewEngine(s.App.Store).Apply(ctx, in)
	case "render_submit":
		var in struct {
			TimelineID string `json:"timeline_id"`
			Revision   int    `json:"revision,omitempty"`
			Preview    bool   `json:"preview,omitempty"`
			Filename   string `json:"filename,omitempty"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.SubmitRender(in.TimelineID, in.Revision, in.Preview, in.Filename)
	case "jobs_get":
		var in struct {
			ID string `json:"id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.Job(in.ID)
	case "jobs_list":
		var in struct{}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.Store.Jobs()
	case "jobs_cancel":
		var in struct {
			ID string `json:"id"`
		}
		if err := decode(raw, &in); err != nil {
			return nil, err
		}
		return s.App.CancelJob(in.ID)
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

func (s *Service) propose(timelineID, query string, limit int) (domain.EditProposal, error) {
	if limit == 0 {
		limit = 3
	}
	t, err := s.App.Store.Current(timelineID)
	if err != nil {
		return domain.EditProposal{}, err
	}
	results, err := s.App.Store.SearchEvidence(t.ProjectID, query, nil, limit)
	if err != nil {
		return domain.EditProposal{}, err
	}
	if len(results) == 0 {
		return domain.EditProposal{}, errNoMatch(query)
	}
	p := domain.EditProposal{ID: "proposal-" + app.ID(), TimelineID: t.ID, BaseRevision: t.Revision, Query: query}
	for i, result := range results {
		e := result.Evidence
		p.EvidenceIDs = append(p.EvidenceIDs, e.ID)
		p.Operations = append(p.Operations, domain.EditOperation{ID: fmt.Sprintf("%s-%02d", p.ID, i+1), TimelineID: t.ID, BaseRevision: t.Revision + i, Kind: domain.OpInsertClip, NewClipID: fmt.Sprintf("candidate-%s-%02d", p.ID[len("proposal-"):], i+1), AssetID: e.AssetID, SourceInUS: e.StartUS, SourceOutUS: e.EndUS, Index: len(t.Items) + i})
	}
	return p, nil
}

type noMatchError struct{ query string }

func (e noMatchError) Error() string { return "no source evidence matches query: " + e.query }
func errNoMatch(query string) error  { return noMatchError{query: query} }

func classify(err error) *APIError {
	code := "invalid_request"
	switch {
	case errors.As(err, new(noMatchError)):
		code = "no_match"
	case errors.Is(err, store.ErrNotFound):
		code = "not_found"
	case errors.Is(err, store.ErrConflict):
		code = "revision_conflict"
	case errors.Is(err, context.Canceled):
		code = "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		code = "timeout"
	case strings.Contains(err.Error(), "model"):
		code = "model_unavailable"
	case strings.Contains(err.Error(), "state conflict"):
		code = "revision_conflict"
	}
	return &APIError{Code: code, Message: err.Error()}
}
