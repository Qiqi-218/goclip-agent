package analysis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zylar06/video-agent/internal/acoustic"
	"github.com/zylar06/video-agent/internal/analysis/asr"
	"github.com/zylar06/video-agent/internal/analysis/provider"
	"github.com/zylar06/video-agent/internal/analysis/visual"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
	"github.com/zylar06/video-agent/internal/store"
)

type Request struct {
	ProjectID       string         `json:"project_id"`
	AssetID         string         `json:"asset_id"`
	SubtitlePath    string         `json:"subtitle_path,omitempty"`
	AnalyzerVersion string         `json:"analyzer_version"`
	Provider        string         `json:"provider"`
	Parameters      map[string]any `json:"parameters,omitempty"`
	Visual          bool           `json:"visual,omitempty"`
	// Audio measures the loudness curve. It is separate from Visual because the
	// two cost different things: frames call a vision model once each, while the
	// curve is decoded locally and free.
	Audio bool `json:"audio,omitempty"`
}

// labeller returns the provider that names audio events, or nil when no text
// model is configured. Naming is an addition to the measurement, so an absent
// model must leave the curve usable rather than fail the run.
// @returns the labeller, or nil.
func (s *Service) labeller() acoustic.Labeller {
	config := provider.ConfigFromEnvAliases("VIDEO_AGENT_TEXT", "AUTOCLIP_TEXT")
	if config.BaseURL == "" || config.Model == "" || config.APIKey == "" {
		return nil
	}
	text := provider.OpenAIText{Config: config}
	return acoustic.ModelLabeller{Ask: text.CompleteWith}
}

// transcriptIn answers what was said during a range, from evidence already
// gathered in this run. The labeller needs it because a laugh track and a
// speaker's emphasis are the same waveform and only the words separate them.
// @param all - the evidence gathered so far.
// @param startUS - the range's start.
// @param endUS - the range's end.
// @returns the transcript text covering the range, or an empty string.
func transcriptIn(all []domain.Evidence, startUS, endUS int64) string {
	var parts []string
	for _, e := range all {
		if e.Transcript == "" || e.StartUS >= endUS || e.EndUS <= startUS {
			continue
		}
		parts = append(parts, e.Transcript)
	}
	return strings.Join(parts, " ")
}

type Result struct {
	Run      domain.AnalysisRun `json:"run"`
	Evidence []domain.Evidence  `json:"evidence"`
}

type ASRProvider interface {
	Transcribe(context.Context, domain.MediaAsset) ([]asr.Cue, error)
}
type VisionProvider interface {
	Describe(context.Context, []domain.Evidence) (map[string]string, error)
}

type Service struct {
	Store  *store.Store
	Tools  media.Tools
	ASR    ASRProvider
	Vision VisionProvider
}

func New(s *store.Store, tools media.Tools) *Service {
	asrConfig := provider.ConfigFromEnvAliases("VIDEO_AGENT_ASR", "AUTOCLIP_ASR")
	visionConfig := provider.ConfigFromEnvAliases("VIDEO_AGENT_VISION", "AUTOCLIP_VISION")
	var asrProvider ASRProvider
	if asrConfig.BaseURL != "" && asrConfig.Model != "" && asrConfig.APIKey != "" {
		if strings.HasPrefix(asrConfig.Model, "qwen") {
			asrProvider = provider.QwenASR{Config: asrConfig, Tools: tools}
		} else {
			asrProvider = provider.OpenAITranscriber{Config: asrConfig}
		}
	}
	var visionProvider VisionProvider
	if visionConfig.BaseURL != "" && visionConfig.Model != "" && visionConfig.APIKey != "" {
		visionProvider = provider.OpenAIVision{Config: visionConfig}
	}
	return &Service{Store: s, Tools: tools, ASR: asrProvider, Vision: visionProvider}
}

func NewWithProviders(s *store.Store, tools media.Tools, asrProvider ASRProvider, visionProvider VisionProvider) *Service {
	return &Service{Store: s, Tools: tools, ASR: asrProvider, Vision: visionProvider}
}

func CacheKey(assetHash, version, provider string, parameters map[string]any) (string, error) {
	b, err := json.Marshal(struct {
		Asset, Version, Provider string
		Parameters               map[string]any
	}{assetHash, version, provider, parameters})
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func (s *Service) Analyze(ctx context.Context, req Request) (Result, error) {
	asset, err := s.Store.Asset(req.ProjectID, req.AssetID)
	if err != nil {
		return Result{}, err
	}
	if req.AnalyzerVersion == "" {
		req.AnalyzerVersion = "p2-v1"
	}
	if req.Provider == "" {
		req.Provider = "subtitle"
	}
	parameters := map[string]any{}
	for k, v := range req.Parameters {
		parameters[k] = v
	}
	parameters["_visual"] = req.Visual
	parameters["_audio"] = req.Audio
	if req.SubtitlePath != "" {
		b, hashErr := os.ReadFile(req.SubtitlePath)
		if hashErr != nil {
			return Result{}, hashErr
		}
		h := sha256.Sum256(b)
		parameters["_subtitle_content_hash"] = hex.EncodeToString(h[:])
	}
	key, err := CacheKey(asset.ContentHash, req.AnalyzerVersion, req.Provider, parameters)
	if err != nil {
		return Result{}, err
	}
	if old, err := s.Store.AnalysisRun(req.ProjectID, req.AssetID, key); err == nil && old.Status == "completed" {
		return s.resultFromRun(old)
	}
	run := domain.AnalysisRun{ProjectID: req.ProjectID, AssetID: req.AssetID, AssetContentHash: asset.ContentHash, CacheKey: key, AnalyzerVersion: req.AnalyzerVersion, Provider: req.Provider, Parameters: parameters, Status: "running", Stages: map[string]string{}}
	if _, err = s.Store.PutAnalysisRun(run); err != nil {
		return Result{}, err
	}
	all := []domain.Evidence{}
	// Each dimension is attempted independently and only the dimensions that
	// succeed contribute evidence. A transcript failure used to abort the whole
	// run, which meant an asset whose speech could not be transcribed also lost
	// its frames and its loudness curve — the two readings that would have
	// answered a question about what was shown rather than said.
	//
	// Every failure is recorded twice: the stage's state for a quick read, and its
	// reason for diagnosis. The reason also travels with the run so a caller that
	// never sees an error envelope — because another stage succeeded — can still
	// find out what went wrong with this one.
	stageErr := map[string]error{}
	if run.StageErrors == nil {
		run.StageErrors = map[string]string{}
	}
	failStage := func(stage string, err error) {
		run.Stages[stage] = "failed"
		run.StageErrors[stage] = err.Error()
		stageErr[stage] = err
	}
	if req.SubtitlePath != "" || s.ASR != nil {
		run.Stages["subtitle"] = "running"
		_, _ = s.Store.PutAnalysisRun(run)
		var cues []asr.Cue
		var subtitleErr error
		if req.SubtitlePath != "" {
			cues, subtitleErr = asr.ParseFile(ctx, req.SubtitlePath)
		} else {
			cues, subtitleErr = s.ASR.Transcribe(ctx, asset)
		}
		switch {
		case subtitleErr != nil:
			failStage("subtitle", subtitleErr)
		default:
			for _, e := range asr.ToEvidence(req.ProjectID, asset, cues, req.Provider, req.AnalyzerVersion) {
				e.CacheKey = key
				if _, err = s.Store.PutEvidence(e); err != nil {
					return s.fail(run, "subtitle", err)
				}
				all = append(all, e)
			}
			run.Stages["subtitle"] = "completed"
		}
		_, _ = s.Store.PutAnalysisRun(run)
	} else {
		run.Stages["subtitle"] = "model_unavailable"
	}
	if req.Visual {
		run.Stages["visual"] = "running"
		_, _ = s.Store.PutAnalysisRun(run)
		frameDir := filepath.Join(s.Store.Dir, "analysis", asset.ID, key, "frames")
		frames, sampleErr := (visual.Sampler{}).Sample(ctx, s.Tools, asset, frameDir)
		if sampleErr != nil {
			failStage("visual", sampleErr)
		} else {
			if s.Vision != nil {
				summaries, describeErr := s.Vision.Describe(ctx, frames)
				if describeErr != nil {
					failStage("visual", describeErr)
				} else {
					for i := range frames {
						frames[i].VisualSummary = summaries[frames[i].ID]
					}
				}
			}
			if run.Stages["visual"] != "failed" {
				for _, e := range frames {
					e.CacheKey = key
					if _, err = s.Store.PutEvidence(e); err != nil {
						return s.fail(run, "visual", err)
					}
					all = append(all, e)
				}
				run.Stages["visual"] = "completed"
			}
		}
		_, _ = s.Store.PutAnalysisRun(run)
	}
	if req.Audio {
		run.Stages["audio"] = "running"
		_, _ = s.Store.PutAnalysisRun(run)
		curve, audioErr := (acoustic.Analyzer{}).Analyze(ctx, s.Tools, asset)
		if audioErr != nil {
			failStage("audio", audioErr)
		} else {
			// Naming follows measurement and never replaces it. A labeller that
			// fails or is absent still leaves the curve stored, because the level
			// is a fact this service measured and the name is an inference it
			// merely asked for.
			labeller := s.labeller()
			rows, labelErr := acoustic.LabelStretches(ctx, labeller, curve, acoustic.NameMarginDB,
				func(startUS, endUS int64) string { return transcriptIn(all, startUS, endUS) })
			if labelErr != nil {
				// Naming is an addition to the measurement, so a labeller failure
				// never fails the audio stage; it is recorded and the curve is kept.
				failStage("label", labelErr)
			} else if labeller == nil {
				run.Stages["label"] = "model_unavailable"
			} else {
				run.Stages["label"] = "completed"
			}
			for _, e := range acoustic.Evidence(asset, rows) {
				e.CacheKey = key
				if _, err = s.Store.PutEvidence(e); err != nil {
					return s.fail(run, "audio", err)
				}
				all = append(all, e)
			}
			run.Stages["audio"] = "completed"
		}
		_, _ = s.Store.PutAnalysisRun(run)
	}
	if len(all) == 0 {
		if existing, existingErr := s.Store.Evidence(req.ProjectID, []string{req.AssetID}); existingErr == nil && len(existing) > 0 {
			all = existing
			run.Stages["indexed"] = "completed"
		}
	}
	if len(all) == 0 {
		// Nothing measured anything, so the run reports the first dimension's own
		// failure rather than a generic one: the caller needs to know whether the
		// transcript was empty, the frames unreadable or the audio absent.
		for _, stage := range []string{"subtitle", "visual", "audio"} {
			if failure, ok := stageErr[stage]; ok {
				return s.fail(run, stage, failure)
			}
		}
		return s.fail(run, "analysis", errors.New("model provider unavailable: provide subtitle_path or enable a visual sampler"))
	}
	for _, e := range all {
		run.EvidenceIDs = append(run.EvidenceIDs, e.ID)
	}
	run.Status = "completed"
	if _, err = s.Store.PutAnalysisRun(run); err != nil {
		return Result{}, err
	}
	// Only now is it safe to drop what earlier runs left behind. Their ids
	// collide with the ones just written, and a payload difference would
	// otherwise make the overwrite guard reject this run — but pruning before
	// the new evidence exists would destroy a good reading of the asset if this
	// attempt then failed.
	if produced := s.producedNow(all); produced > 0 {
		if _, err = s.Store.SupersedeEvidence(req.ProjectID, req.AssetID, key); err != nil {
			return Result{}, err
		}
	}
	return Result{Run: run, Evidence: all}, nil
}

// producedNow counts evidence written by this run rather than reused from
// storage, so a run that merely re-indexed existing evidence does not trigger
// pruning of the very rows it returned.
func (s *Service) producedNow(all []domain.Evidence) int {
	n := 0
	for _, e := range all {
		if e.CacheKey != "" {
			n++
		}
	}
	return n
}

func (s *Service) fail(run domain.AnalysisRun, stage string, err error) (Result, error) {
	run.Status = "failed"
	run.Error = err.Error()
	if run.Stages == nil {
		run.Stages = map[string]string{}
	}
	run.Stages[stage] = "failed"
	_, _ = s.Store.PutAnalysisRun(run)
	return Result{Run: run}, err
}

func (s *Service) resultFromRun(run domain.AnalysisRun) (Result, error) {
	items, err := s.Store.Evidence(run.ProjectID, []string{run.AssetID})
	if err != nil {
		return Result{}, err
	}
	allowed := map[string]bool{}
	for _, id := range run.EvidenceIDs {
		allowed[id] = true
	}
	filtered := items[:0]
	for _, e := range items {
		if allowed[e.ID] {
			filtered = append(filtered, e)
		}
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].StartUS < filtered[j].StartUS })
	return Result{Run: run, Evidence: filtered}, nil
}

func SubtitlePath(path string) error {
	if path == "" {
		return errors.New("subtitle_path is required")
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("subtitle path is not a regular file")
	}
	return nil
}
