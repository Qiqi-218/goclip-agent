package domain

import "time"

type AnalysisRun struct {
	ProjectID        string            `json:"project_id"`
	AssetID          string            `json:"asset_id"`
	AssetContentHash string            `json:"asset_content_hash"`
	CacheKey         string            `json:"cache_key"`
	AnalyzerVersion  string            `json:"analyzer_version"`
	Provider         string            `json:"provider"`
	Parameters       map[string]any    `json:"parameters,omitempty"`
	Status           string            `json:"status"`
	Stages           map[string]string `json:"stages,omitempty"`
	// StageErrors records why each failed stage failed, keyed like Stages. A stage
	// that reports only "failed" cannot be diagnosed: the caller sees that the
	// loudness curve is missing but not whether ffmpeg refused the file, the model
	// was unreachable, or the disk was full — three problems with three different
	// fixes. Added after exactly that happened.
	StageErrors map[string]string `json:"stage_errors,omitempty"`
	EvidenceIDs []string          `json:"evidence_ids,omitempty"`
	Error       string            `json:"error,omitempty"`
	UpdatedAt   time.Time         `json:"updated_at"`
}
