package edit

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/store"
)

type Engine struct {
	store *store.Store
}

func NewEngine(s *store.Store) *Engine { return &Engine{store: s} }

func (e *Engine) Apply(ctx context.Context, op domain.EditOperation) (domain.TimelineRevision, error) {
	if err := ctx.Err(); err != nil {
		return domain.TimelineRevision{}, err
	}
	if op.ID == "" || op.TimelineID == "" || op.BaseRevision < 1 {
		return domain.TimelineRevision{}, errors.New("operation requires id, timeline id and base revision")
	}
	if previous, ok, err := e.store.OperationResult(ctx, op); ok || err != nil {
		return previous, err
	}
	current, err := e.store.Current(op.TimelineID)
	if err != nil {
		return domain.TimelineRevision{}, err
	}
	if current.Revision != op.BaseRevision {
		// Another process may have committed this exact request between the two reads.
		if previous, ok, err := e.store.OperationResult(ctx, op); ok || err != nil {
			return previous, err
		}
		return domain.TimelineRevision{}, fmt.Errorf("%w: current=%d base=%d", store.ErrConflict, current.Revision, op.BaseRevision)
	}

	next := current.Clone()
	index := findClip(next.Items, op.TargetClipID)
	if op.Kind == domain.OpRestore || op.Kind == domain.OpUndo {
		revision := op.RestoreRevision
		if op.Kind == domain.OpUndo {
			revision = current.ParentRevision
		}
		if revision < 1 || revision >= current.Revision {
			return next, errors.New("restore requires an earlier revision")
		}
		historical, err := e.store.Revision(current.ID, revision)
		if err != nil {
			return next, err
		}
		next = historical.Clone()
	} else {
		switch op.Kind {
		case domain.OpTrimClip:
			if index < 0 {
				return domain.TimelineRevision{}, errors.New("target clip not found")
			}
			if next.Items[index].Locked {
				return domain.TimelineRevision{}, errors.New("target clip is locked")
			}
			if op.SourceOutUS != 0 {
				item := next.Items[index]
				if op.SourceInUS < item.SourceInUS || op.SourceOutUS > item.SourceOutUS || op.SourceOutUS <= op.SourceInUS {
					return next, errors.New("trim range must be inside current source range")
				}
				next.Items[index].SourceInUS = op.SourceInUS
				next.Items[index].SourceOutUS = op.SourceOutUS
				next.Items[index].DurationFrames = next.Frames(op.SourceOutUS - op.SourceInUS)
				if op.DurationFrames != 0 && op.DurationFrames != next.Items[index].DurationFrames {
					return next, errors.New("trim duration conflicts with source range")
				}
				break
			}
			if op.DurationFrames < 1 || op.DurationFrames > next.Items[index].DurationFrames {
				return domain.TimelineRevision{}, errors.New("trim duration must be positive and no longer than current clip")
			}
			next.Items[index].DurationFrames = op.DurationFrames
			next.Items[index].SourceOutUS = next.Items[index].SourceInUS + next.Microseconds(op.DurationFrames)
			if next.Items[index].SourceOutUS > current.Items[index].SourceOutUS {
				next.Items[index].SourceOutUS = current.Items[index].SourceOutUS
			}
		case domain.OpReplaceClip:
			if index < 0 {
				return domain.TimelineRevision{}, errors.New("target clip not found")
			}
			if next.Items[index].Locked {
				return domain.TimelineRevision{}, errors.New("target clip is locked")
			}
			if op.AssetID == "" || op.SourceInUS < 0 || op.SourceOutUS <= op.SourceInUS {
				return domain.TimelineRevision{}, errors.New("replacement requires asset and source range")
			}
			next.Items[index].AssetID = op.AssetID
			next.Items[index].SourceInUS = op.SourceInUS
			next.Items[index].SourceOutUS = op.SourceOutUS
			next.Items[index].DurationFrames = next.Frames(op.SourceOutUS - op.SourceInUS)
			next.Items[index].EvidenceIDs = nil
			if op.DurationFrames != 0 && op.DurationFrames != next.Items[index].DurationFrames {
				return next, errors.New("replacement duration conflicts with source range")
			}
		case domain.OpInsertClip:
			if op.NewClipID == "" || op.AssetID == "" || op.SourceInUS < 0 || op.SourceOutUS <= op.SourceInUS {
				return domain.TimelineRevision{}, errors.New("insert requires new clip id, asset, source range and duration")
			}
			if op.Index < 0 || op.Index > len(next.Items) {
				return domain.TimelineRevision{}, errors.New("invalid insert index")
			}
			for _, item := range next.Items {
				if item.ID == op.NewClipID {
					return domain.TimelineRevision{}, errors.New("new clip id already exists")
				}
			}
			frames := next.Frames(op.SourceOutUS - op.SourceInUS)
			if op.DurationFrames != 0 && op.DurationFrames != frames {
				return next, errors.New("insert duration conflicts with source range")
			}
			item := domain.ClipItem{ID: op.NewClipID, AssetID: op.AssetID, SourceInUS: op.SourceInUS, SourceOutUS: op.SourceOutUS, DurationFrames: frames}
			next.Items = append(next.Items, domain.ClipItem{})
			copy(next.Items[op.Index+1:], next.Items[op.Index:])
			next.Items[op.Index] = item
		case domain.OpDeleteClip:
			if index < 0 {
				return domain.TimelineRevision{}, errors.New("target clip not found")
			}
			if next.Items[index].Locked {
				return domain.TimelineRevision{}, errors.New("target clip is locked")
			}
			next.Items = append(next.Items[:index], next.Items[index+1:]...)
		case domain.OpMoveClip:
			if index < 0 || op.Index < 0 || op.Index >= len(next.Items) {
				return domain.TimelineRevision{}, errors.New("invalid move target")
			}
			if next.Items[index].Locked {
				return next, errors.New("target clip is locked")
			}
			item := next.Items[index]
			next.Items = append(next.Items[:index], next.Items[index+1:]...)
			next.Items = append(next.Items, domain.ClipItem{})
			copy(next.Items[op.Index+1:], next.Items[op.Index:])
			next.Items[op.Index] = item
		case domain.OpLockClip, domain.OpUnlockClip:
			if index < 0 {
				return domain.TimelineRevision{}, errors.New("target clip not found")
			}
			next.Items[index].Locked = op.Kind == domain.OpLockClip
		default:
			return domain.TimelineRevision{}, fmt.Errorf("unsupported operation %q", op.Kind)
		}
	}
	next.Reflow()
	// Locks also protect output position against ripple edits elsewhere.
	if op.Kind != domain.OpRestore && op.Kind != domain.OpUndo {
		for _, item := range current.Items {
			if !item.Locked || (op.Kind == domain.OpUnlockClip && op.TargetClipID == item.ID) {
				continue
			}
			i := findClip(next.Items, item.ID)
			if i < 0 || !reflect.DeepEqual(item, next.Items[i]) {
				return next, fmt.Errorf("clip %q is locked; edit would change its content or position", item.ID)
			}
		}
	}

	next.ParentRevision = current.Revision
	next.Revision = current.Revision + 1
	return e.store.Save(ctx, next, op)
}

func findClip(items []domain.ClipItem, id string) int {
	for i := range items {
		if items[i].ID == id {
			return i
		}
	}
	return -1
}
