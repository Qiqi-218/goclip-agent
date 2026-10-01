package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MediaAsset struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	Path          string `json:"path"`
	ContentHash   string `json:"content_hash,omitempty"`
	DurationUS    int64  `json:"duration_us"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	HasAudio      bool   `json:"has_audio"`
	Status        string `json:"status"`
	FPS           string `json:"fps"`
	AudioChannels int    `json:"audio_channels"`
	Rotation      int    `json:"rotation"`
}

type ClipItem struct {
	ID             string   `json:"id"`
	AssetID        string   `json:"asset_id"`
	SourceInUS     int64    `json:"source_in_us"`
	SourceOutUS    int64    `json:"source_out_us"`
	StartFrame     int      `json:"start_frame"`
	DurationFrames int      `json:"duration_frames"`
	Locked         bool     `json:"locked"`
	EvidenceIDs    []string `json:"evidence_ids,omitempty"`
}

type TimelineRevision struct {
	ID             string     `json:"id"`
	ProjectID      string     `json:"project_id"`
	Revision       int        `json:"revision"`
	ParentRevision int        `json:"parent_revision"`
	FPSNum         int        `json:"fps_num"`
	FPSDen         int        `json:"fps_den"`
	Width          int        `json:"width"`
	Height         int        `json:"height"`
	Items          []ClipItem `json:"items"`
}

type OperationKind string

const (
	OpTrimClip    OperationKind = "trim_clip"
	OpReplaceClip OperationKind = "replace_clip"
	OpDeleteClip  OperationKind = "delete_clip"
	OpInsertClip  OperationKind = "insert_clip"
	OpMoveClip    OperationKind = "move_clip"
	OpLockClip    OperationKind = "lock_clip"
	OpUnlockClip  OperationKind = "unlock_clip"
	OpRestore     OperationKind = "restore_revision"
	OpUndo        OperationKind = "undo"
)

type EditOperation struct {
	ID              string        `json:"id"`
	TimelineID      string        `json:"timeline_id"`
	BaseRevision    int           `json:"base_revision"`
	Kind            OperationKind `json:"kind"`
	TargetClipID    string        `json:"target_clip_id,omitempty"`
	NewClipID       string        `json:"new_clip_id,omitempty"`
	AssetID         string        `json:"asset_id,omitempty"`
	SourceInUS      int64         `json:"source_in_us,omitempty"`
	SourceOutUS     int64         `json:"source_out_us,omitempty"`
	DurationFrames  int           `json:"duration_frames,omitempty"`
	Index           int           `json:"index,omitempty"`
	RestoreRevision int           `json:"restore_revision,omitempty"`
}

func (a MediaAsset) Validate() error {
	if a.ID == "" || a.ProjectID == "" || a.Path == "" || a.DurationUS <= 0 || a.DurationUS > 86_400_000_000 || a.Width <= 0 || a.Height <= 0 {
		return errors.New("asset requires id, path, positive duration and dimensions")
	}
	return nil
}

func (t TimelineRevision) Validate(assets map[string]MediaAsset) error {
	if t.ID == "" || t.ProjectID == "" || t.Revision < 1 || t.ParentRevision != t.Revision-1 || t.FPSNum <= 0 || t.FPSNum > 120000 || t.FPSDen <= 0 || t.FPSDen > 10000 || t.FPSNum < t.FPSDen || t.FPSNum > 120*t.FPSDen || t.Width <= 0 || t.Height <= 0 || t.Width > 7680 || t.Height > 7680 || t.Width%2 != 0 || t.Height%2 != 0 || len(t.Items) > 1000 {
		return errors.New("invalid timeline header")
	}
	seen := make(map[string]bool, len(t.Items))
	start := 0
	for _, item := range t.Items {
		if item.ID == "" || seen[item.ID] || item.AssetID == "" || item.StartFrame != start || item.DurationFrames <= 0 {
			return fmt.Errorf("invalid clip %q", item.ID)
		}
		asset, ok := assets[item.AssetID]
		if !ok {
			return fmt.Errorf("clip %q references unknown asset %q", item.ID, item.AssetID)
		}
		if err := asset.Validate(); err != nil {
			return err
		}
		if asset.ProjectID != t.ProjectID {
			return fmt.Errorf("clip %q references another project's asset", item.ID)
		}
		if item.SourceInUS < 0 || item.SourceOutUS <= item.SourceInUS || item.SourceOutUS > asset.DurationUS {
			return fmt.Errorf("clip %q has invalid source range", item.ID)
		}
		if item.DurationFrames != t.Frames(item.SourceOutUS-item.SourceInUS) {
			return fmt.Errorf("clip %q source duration does not match output frames (only 1x playback is supported)", item.ID)
		}
		start += item.DurationFrames
		if t.Microseconds(start) > 86_400_000_000 {
			return errors.New("timeline exceeds 24 hours")
		}
		seen[item.ID] = true
	}
	return nil
}

// Frame quantization is round-to-nearest; source timestamps remain microseconds.
func (t TimelineRevision) Frames(us int64) int {
	return int(math.Round(float64(us) * float64(t.FPSNum) / (1e6 * float64(t.FPSDen))))
}
func (t TimelineRevision) Microseconds(frames int) int64 {
	return int64(math.Round(float64(frames) * 1e6 * float64(t.FPSDen) / float64(t.FPSNum)))
}
func (t *TimelineRevision) Reflow() {
	start := 0
	for i := range t.Items {
		t.Items[i].StartFrame = start
		start += t.Items[i].DurationFrames
	}
}

type RenderJob struct {
	ID         string          `json:"id"`
	TimelineID string          `json:"timeline_id"`
	Revision   int             `json:"revision"`
	Kind       string          `json:"kind"`
	Status     string          `json:"status"`
	Progress   int             `json:"progress"`
	Output     string          `json:"output"`
	Error      string          `json:"error,omitempty"`
	UpdatedAt  time.Time       `json:"updated_at"`
	Validation *Validation     `json:"validation,omitempty"`
	Plan       json.RawMessage `json:"plan"`
}

type Validation struct {
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Frames       int    `json:"frames"`
	DurationUS   int64  `json:"duration_us"`
	SHA256       string `json:"sha256"`
	ProbePassed  bool   `json:"probe_passed"`
	DecodePassed bool   `json:"decode_passed"`
}

func (t TimelineRevision) Clone() TimelineRevision {
	clone := t
	clone.Items = append([]ClipItem(nil), t.Items...)
	for i := range clone.Items {
		clone.Items[i].EvidenceIDs = append([]string(nil), t.Items[i].EvidenceIDs...)
	}
	return clone
}
