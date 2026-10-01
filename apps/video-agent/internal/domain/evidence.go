package domain

import "errors"

// Evidence is a bounded, source-addressable observation about an imported
// asset. P3 accepts evidence produced by an external analyzer (for example an
// SRT importer); P2 owns automatic ASR and visual providers.
type Evidence struct {
	ID               string `json:"id"`
	ProjectID        string `json:"project_id"`
	AssetID          string `json:"asset_id"`
	StartUS          int64  `json:"start_us"`
	EndUS            int64  `json:"end_us"`
	AssetContentHash string `json:"asset_content_hash"`
	Transcript       string `json:"transcript,omitempty"`
	VisualSummary    string `json:"visual_summary,omitempty"`
	// AcousticSummary describes how loud this range is, in the same plain
	// language the other two dimensions use. A measured level is a fact about the
	// range whether or not anything crossed a threshold to be called an event, so
	// it is a field of its own rather than a note squeezed into VisualSummary.
	AcousticSummary string `json:"acoustic_summary,omitempty"`
	// EventLabel names what this range sounds like, from a closed vocabulary
	// (笑声 / 掌声 / 欢呼 / 音乐 / 说话声 / 安静 / 噪声). It is kept apart from
	// AcousticSummary because the two are different kinds of fact: the summary is
	// measured, the label is inferred, and a reader must be able to tell which is
	// which. Empty means nothing named this range.
	EventLabel      string   `json:"event_label,omitempty"`
	FrameRefs       []string `json:"frame_refs,omitempty"`
	AnalyzerVersion string   `json:"analyzer_version,omitempty"`
	Provider        string   `json:"provider,omitempty"`
	CacheKey        string   `json:"cache_key,omitempty"`
}

func (e Evidence) Validate(asset MediaAsset) error {
	if e.ID == "" || e.ProjectID == "" || e.AssetID == "" || e.ProjectID != asset.ProjectID || e.AssetID != asset.ID || e.StartUS < 0 || e.EndUS <= e.StartUS || e.EndUS > asset.DurationUS {
		return errors.New("invalid evidence source range")
	}
	if e.Transcript == "" && e.VisualSummary == "" && e.AcousticSummary == "" && len(e.FrameRefs) == 0 {
		return errors.New("evidence requires transcript, visual_summary, acoustic_summary, or frame_refs")
	}
	if e.AssetContentHash != asset.ContentHash {
		return errors.New("evidence asset_content_hash does not match imported asset")
	}
	return nil
}

type EditProposal struct {
	ID           string          `json:"id"`
	TimelineID   string          `json:"timeline_id"`
	BaseRevision int             `json:"base_revision"`
	Query        string          `json:"query"`
	EvidenceIDs  []string        `json:"evidence_ids"`
	Operations   []EditOperation `json:"operations"`
}
