package edit

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/store"
)

func fixture(t *testing.T) (domain.TimelineRevision, *store.Store) {
	t.Helper()
	timeline := domain.TimelineRevision{ID: "tl", ProjectID: "p", Revision: 1, FPSNum: 30, FPSDen: 1, Width: 1920, Height: 1080, Items: []domain.ClipItem{{ID: "c", AssetID: "a", SourceOutUS: 5_000_000, DurationFrames: 150}}}
	s, err := store.Open(filepath.Join(t.TempDir(), "space + 中文"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err = s.CreateProject(domain.Project{ID: "p", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if _, err = s.PutAsset(domain.MediaAsset{ID: id, ProjectID: "p", Path: id + ".mp4", DurationUS: 10_000_000, Width: 320, Height: 180}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.CreateTimeline(timeline); err != nil {
		t.Fatal(err)
	}
	return timeline, s
}

func TestApplyTrimCreatesNewRevisionAndIsIdempotent(t *testing.T) {
	timeline, memory := fixture(t)
	engine := NewEngine(memory)
	op := domain.EditOperation{ID: "op-1", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 90}
	next, err := engine.Apply(context.Background(), op)
	if err != nil || next.Revision != 2 || next.Items[0].DurationFrames != 90 || next.Items[0].SourceOutUS != 3_000_000 {
		t.Fatalf("unexpected first result: %#v, %v", next, err)
	}
	replay, err := engine.Apply(context.Background(), op)
	if err != nil || replay.Revision != 2 {
		t.Fatalf("unexpected replay: %#v, %v", replay, err)
	}
}

func TestApplyRejectsStaleRevisionAndLockedClip(t *testing.T) {
	timeline, memory := fixture(t)
	engine := NewEngine(memory)
	locked, err := engine.Apply(context.Background(), domain.EditOperation{ID: "lock", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpLockClip, TargetClipID: "c"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = engine.Apply(context.Background(), domain.EditOperation{ID: "stale", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 60})
	if err == nil || !strings.Contains(err.Error(), "revision conflict") {
		t.Fatalf("expected revision conflict, got %v", err)
	}
	_, err = engine.Apply(context.Background(), domain.EditOperation{ID: "trim-locked", TimelineID: timeline.ID, BaseRevision: locked.Revision, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 60})
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("expected locked error, got %v", err)
	}
}

func TestApplyInsertAddsClipAtIndex(t *testing.T) {
	timeline, memory := fixture(t)
	engine := NewEngine(memory)
	next, err := engine.Apply(context.Background(), domain.EditOperation{
		ID: "insert", TimelineID: timeline.ID, BaseRevision: 1, Kind: domain.OpInsertClip,
		NewClipID: "inserted", AssetID: "b", SourceInUS: 1_000_000, SourceOutUS: 2_000_000,
		DurationFrames: 30, Index: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Items) != 2 || next.Items[0].ID != "inserted" || next.Items[1].StartFrame != 30 || next.Revision != 2 {
		t.Fatalf("unexpected inserted timeline: %#v", next)
	}
}

func TestEditSequenceHistoryReopenAndRestore(t *testing.T) {
	_, s := fixture(t)
	engine := NewEngine(s)
	ctx := context.Background()
	ops := []domain.EditOperation{
		{Kind: domain.OpInsertClip, NewClipID: "d", AssetID: "b", SourceInUS: 1_000_000, SourceOutUS: 3_000_000, Index: 1},
		{Kind: domain.OpMoveClip, TargetClipID: "d", Index: 0},
		{Kind: domain.OpReplaceClip, TargetClipID: "c", AssetID: "b", SourceInUS: 3_000_000, SourceOutUS: 7_000_000},
		{Kind: domain.OpTrimClip, TargetClipID: "c", SourceInUS: 4_000_000, SourceOutUS: 6_000_000},
		{Kind: domain.OpDeleteClip, TargetClipID: "d"},
	}
	for i, op := range ops {
		op.ID = fmt.Sprint(i)
		op.TimelineID = "tl"
		op.BaseRevision = i + 1
		if _, err := engine.Apply(ctx, op); err != nil {
			t.Fatal(err)
		}
	}
	dir := s.Dir
	s.Close()
	reopened, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	current, err := reopened.Current("tl")
	if err != nil {
		t.Fatal(err)
	}
	if current.Revision != 6 || len(current.Items) != 1 || current.Items[0].SourceInUS != 4_000_000 || current.Items[0].StartFrame != 0 {
		t.Fatalf("lost state: %+v", current)
	}
	history, err := reopened.History("tl")
	if err != nil || len(history) != 6 {
		t.Fatalf("history: %d %v", len(history), err)
	}
	engine = NewEngine(reopened)
	restored, err := engine.Apply(ctx, domain.EditOperation{ID: "restore", TimelineID: "tl", BaseRevision: 6, Kind: domain.OpRestore, RestoreRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Revision != 7 || restored.ParentRevision != 6 || !reflect.DeepEqual(restored.Items, history[0].Items) {
		t.Fatalf("bad restore: %+v", restored)
	}
	undone, err := engine.Apply(ctx, domain.EditOperation{ID: "undo", TimelineID: "tl", BaseRevision: 7, Kind: domain.OpUndo})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(undone.Items, current.Items) {
		t.Fatal("undo did not restore previous contents")
	}
}

func TestLockPreventsDirectAndRippleEdits(t *testing.T) {
	_, s := fixture(t)
	engine := NewEngine(s)
	ctx := context.Background()
	_, err := engine.Apply(ctx, domain.EditOperation{ID: "insert", TimelineID: "tl", BaseRevision: 1, Kind: domain.OpInsertClip, NewClipID: "d", AssetID: "b", SourceOutUS: 2_000_000, Index: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = engine.Apply(ctx, domain.EditOperation{ID: "lock", TimelineID: "tl", BaseRevision: 2, Kind: domain.OpLockClip, TargetClipID: "d"})
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range []domain.EditOperation{
		{Kind: domain.OpMoveClip, TargetClipID: "d", Index: 0},
		{Kind: domain.OpDeleteClip, TargetClipID: "d"},
		{Kind: domain.OpReplaceClip, TargetClipID: "d", AssetID: "a", SourceOutUS: 2_000_000},
		{Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 30},
		{Kind: domain.OpMoveClip, TargetClipID: "c", Index: 1},
	} {
		op.ID = string(op.Kind) + op.TargetClipID
		op.TimelineID = "tl"
		op.BaseRevision = 3
		if _, err = engine.Apply(ctx, op); err == nil || !strings.Contains(err.Error(), "locked") {
			t.Fatalf("expected locked for %+v: %v", op, err)
		}
	}
	_, err = engine.Apply(ctx, domain.EditOperation{ID: "unlock", TimelineID: "tl", BaseRevision: 3, Kind: domain.OpUnlockClip, TargetClipID: "d"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = engine.Apply(ctx, domain.EditOperation{ID: "trim", TimelineID: "tl", BaseRevision: 4, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 30}); err != nil {
		t.Fatal(err)
	}
}

func TestRejectBadAssetRangeAndReusedOperationID(t *testing.T) {
	_, s := fixture(t)
	engine := NewEngine(s)
	ctx := context.Background()
	for _, op := range []domain.EditOperation{
		{Kind: domain.OpReplaceClip, TargetClipID: "c", AssetID: "unknown", SourceOutUS: 2_000_000},
		{Kind: domain.OpReplaceClip, TargetClipID: "c", AssetID: "b", SourceOutUS: 11_000_000},
		{Kind: domain.OpInsertClip, NewClipID: "c", AssetID: "b", SourceOutUS: 2_000_000},
		{Kind: domain.OpInsertClip, NewClipID: "e", AssetID: "b", SourceInUS: -1, SourceOutUS: 2_000_000},
		{Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 151},
	} {
		op.ID = "bad"
		op.TimelineID = "tl"
		op.BaseRevision = 1
		if _, err := engine.Apply(ctx, op); err == nil {
			t.Fatalf("accepted %+v", op)
		}
	}
	op := domain.EditOperation{ID: "trim", TimelineID: "tl", BaseRevision: 1, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 60}
	if _, err := engine.Apply(ctx, op); err != nil {
		t.Fatal(err)
	}
	op.DurationFrames = 30
	if _, err := engine.Apply(ctx, op); !errors.Is(err, store.ErrOperationReuse) {
		t.Fatalf("accepted changed replay: %v", err)
	}
	history, _ := s.History("tl")
	if len(history) != 2 {
		t.Fatalf("invalid operation changed history: %d", len(history))
	}
}

func TestConcurrentStoreConnectionsCompareAndSwap(t *testing.T) {
	_, s := fixture(t)
	second, err := store.Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	start := make(chan struct{})
	for i, db := range []*store.Store{s, second} {
		wg.Add(1)
		go func(i int, db *store.Store) {
			defer wg.Done()
			<-start
			_, err := NewEngine(db).Apply(context.Background(), domain.EditOperation{ID: fmt.Sprint(i), TimelineID: "tl", BaseRevision: 1, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 30 + i})
			results <- err
		}(i, db)
	}
	close(start)
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for err := range results {
		if err == nil {
			ok++
		} else if errors.Is(err, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("lost update: successes=%d conflicts=%d", ok, conflicts)
	}
	history, _ := s.History("tl")
	if len(history) != 2 {
		t.Fatal("unexpected revision count")
	}
}

func TestConcurrentIdenticalRetriesReturnSameRevision(t *testing.T) {
	_, s := fixture(t)
	second, err := store.Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, 12)
	op := domain.EditOperation{ID: "same", TimelineID: "tl", BaseRevision: 1, Kind: domain.OpTrimClip, TargetClipID: "c", DurationFrames: 60}
	for i := 0; i < 12; i++ {
		db := s
		if i%2 == 1 {
			db = second
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, e := NewEngine(db).Apply(context.Background(), op)
			if e == nil && result.Revision != 2 {
				e = fmt.Errorf("unexpected revision %d", result.Revision)
			}
			errs <- e
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	history, _ := s.History("tl")
	if len(history) != 2 {
		t.Fatal("retries created extra revisions")
	}
}
