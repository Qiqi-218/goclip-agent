package catalog

import (
	"context"
	"sort"

	"github.com/zylar06/video-agent/internal/domain"
)

type Evidence = domain.Evidence

type SearchRequest struct {
	ProjectID string   `json:"project_id"`
	Query     string   `json:"query"`
	AssetIDs  []string `json:"asset_ids,omitempty"`
	Limit     int      `json:"limit"`
}

type SearchResult struct {
	Evidence Evidence `json:"evidence"`
	Score    float64  `json:"score"`
	Reason   string   `json:"reason"`
}

// AnalysisRequest is intentionally provider-neutral. Parameters must not carry
// credentials; they participate in the persistent cache key after normalization.
type AnalysisRequest struct {
	ProjectID        string         `json:"project_id"`
	AssetID          string         `json:"asset_id"`
	AssetContentHash string         `json:"asset_content_hash"`
	AnalyzerVersion  string         `json:"analyzer_version"`
	Provider         string         `json:"provider"`
	Parameters       map[string]any `json:"parameters,omitempty"`
	CacheKey         string         `json:"cache_key"`
}

type AnalysisResult struct {
	Request  AnalysisRequest `json:"request"`
	Status   string          `json:"status"`
	Evidence []Evidence      `json:"evidence"`
}

// StaticCatalog is an offline mock used to keep the v1 boundary executable.
// Production persistence and providers are introduced by the P2 tasks.
type StaticCatalog struct {
	Analysis map[string]AnalysisResult
	Results  []SearchResult
}

func (s StaticCatalog) Analyze(ctx context.Context, assetID string) ([]Evidence, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return append([]Evidence(nil), s.Analysis[assetID].Evidence...), nil
}

func (s StaticCatalog) Search(ctx context.Context, request SearchRequest) ([]SearchResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := append([]SearchResult(nil), s.Results...)
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Score == result[j].Score {
			return result[i].Evidence.ID < result[j].Evidence.ID
		}
		return result[i].Score > result[j].Score
	})
	if request.Limit > 0 && len(result) > request.Limit {
		result = result[:request.Limit]
	}
	return result, nil
}

type Catalog interface {
	Analyze(context.Context, string) ([]Evidence, error)
	Search(context.Context, SearchRequest) ([]SearchResult, error)
}
