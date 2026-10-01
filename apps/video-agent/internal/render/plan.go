package render

import (
	"fmt"

	"github.com/zylar06/video-agent/internal/domain"
)

type InputRange struct {
	ClipID         string `json:"clip_id"`
	AssetID        string `json:"asset_id"`
	Path           string `json:"path"`
	SourceInUS     int64  `json:"source_in_us"`
	SourceOutUS    int64  `json:"source_out_us"`
	StartFrame     int    `json:"start_frame"`
	DurationFrames int    `json:"duration_frames"`
	HasAudio       bool   `json:"has_audio"`
	ContentHash    string `json:"content_hash"`
}

type Plan struct {
	TimelineID string       `json:"timeline_id"`
	Revision   int          `json:"revision"`
	Width      int          `json:"width"`
	Height     int          `json:"height"`
	FPSNum     int          `json:"fps_num"`
	FPSDen     int          `json:"fps_den"`
	Inputs     []InputRange `json:"inputs"`
}

func Compile(t domain.TimelineRevision, assets []domain.MediaAsset) (Plan, error) {
	byID := make(map[string]domain.MediaAsset, len(assets))
	for _, asset := range assets {
		if _, ok := byID[asset.ID]; ok {
			return Plan{}, fmt.Errorf("duplicate asset %q", asset.ID)
		}
		byID[asset.ID] = asset
	}
	if err := t.Validate(byID); err != nil {
		return Plan{}, err
	}
	plan := Plan{TimelineID: t.ID, Revision: t.Revision, Width: t.Width, Height: t.Height, FPSNum: t.FPSNum, FPSDen: t.FPSDen}
	for _, item := range t.Items {
		asset := byID[item.AssetID]
		plan.Inputs = append(plan.Inputs, InputRange{ClipID: item.ID, AssetID: item.AssetID, Path: asset.Path, SourceInUS: item.SourceInUS, SourceOutUS: item.SourceOutUS, StartFrame: item.StartFrame, DurationFrames: item.DurationFrames, HasAudio: asset.HasAudio, ContentHash: asset.ContentHash})
	}
	return plan, nil
}

func (p Plan) Validate() error {
	if p.TimelineID == "" || p.Revision < 1 || p.Width <= 0 || p.Height <= 0 || p.Width%2 != 0 || p.Height%2 != 0 || p.Width > 7680 || p.Height > 7680 || p.FPSNum <= 0 || p.FPSNum > 120000 || p.FPSDen <= 0 || p.FPSDen > 10000 || p.FPSNum < p.FPSDen || p.FPSNum > 120*p.FPSDen || len(p.Inputs) == 0 || len(p.Inputs) > 1000 {
		return fmt.Errorf("invalid render plan")
	}
	start := 0
	t := domain.TimelineRevision{FPSNum: p.FPSNum, FPSDen: p.FPSDen}
	for _, input := range p.Inputs {
		if input.AssetID == "" || input.Path == "" || input.SourceInUS < 0 || input.SourceOutUS <= input.SourceInUS || input.SourceOutUS > 86_400_000_000 || input.DurationFrames <= 0 || input.StartFrame != start || input.DurationFrames != t.Frames(input.SourceOutUS-input.SourceInUS) || len(input.ContentHash) != 64 {
			return fmt.Errorf("invalid render input %q", input.AssetID)
		}
		start += input.DurationFrames
		if t.Microseconds(start) > 86_400_000_000 {
			return fmt.Errorf("render plan exceeds 24 hours")
		}
	}
	return nil
}

func (p Plan) Frames() int {
	n := 0
	for _, i := range p.Inputs {
		n += i.DurationFrames
	}
	return n
}
func (p Plan) DurationUS() int64 {
	t := domain.TimelineRevision{FPSNum: p.FPSNum, FPSDen: p.FPSDen}
	return t.Microseconds(p.Frames())
}
