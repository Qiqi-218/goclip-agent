// Package app is shared by the local CLI and future API/MCP adapters.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
	"github.com/zylar06/video-agent/internal/render"
	"github.com/zylar06/video-agent/internal/store"
)

type App struct {
	Store *store.Store
	Tools media.Tools
	mu    sync.Mutex
	run   map[string]context.CancelFunc
}

func Open(dir string) (*App, error) {
	s, err := store.Open(dir)
	if err != nil {
		return nil, err
	}
	return &App{Store: s, Tools: media.Default(), run: map[string]context.CancelFunc{}}, nil
}

func (a *App) Close() error {
	a.mu.Lock()
	for _, cancel := range a.run {
		cancel()
	}
	a.mu.Unlock()
	return a.Store.Close()
}
func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (a *App) CreateTimeline(t domain.TimelineRevision) (domain.TimelineRevision, error) {
	if t.Revision == 0 {
		t.Revision = 1
	}
	if t.FPSNum <= 0 || t.FPSDen <= 0 {
		return t, errors.New("positive fps_num and fps_den are required")
	}
	for i := range t.Items {
		if t.Items[i].DurationFrames == 0 {
			t.Items[i].DurationFrames = t.Frames(t.Items[i].SourceOutUS - t.Items[i].SourceInUS)
		}
	}
	t.Reflow()
	return t, a.Store.CreateTimeline(t)
}
func (a *App) Plan(id string, revision int, preview bool) (render.Plan, error) {
	var t domain.TimelineRevision
	var err error
	if revision == 0 {
		t, err = a.Store.Current(id)
	} else {
		t, err = a.Store.Revision(id, revision)
	}
	if err != nil {
		return render.Plan{}, err
	}
	assets, err := a.Store.Assets(t.ProjectID)
	if err != nil {
		return render.Plan{}, err
	}
	list := make([]domain.MediaAsset, 0, len(assets))
	for _, asset := range assets {
		list = append(list, asset)
	}
	p, err := render.Compile(t, list)
	if err != nil {
		return p, err
	}
	if preview && (p.Width > 640 || p.Height > 640) {
		if p.Width >= p.Height {
			p.Height = max(2, (p.Height*640/p.Width)/2*2)
			p.Width = 640
		} else {
			p.Width = max(2, (p.Width*640/p.Height)/2*2)
			p.Height = 640
		}
	}
	return p, p.Validate()
}

// Render is synchronous in P1; status and the exact plan are durable. A killed
// process may leave a running job, but never falsely marks it completed.
func (a *App) Render(ctx context.Context, id string, revision int, preview bool, output string) (domain.RenderJob, error) {
	p, err := a.Plan(id, revision, preview)
	if err != nil {
		return domain.RenderJob{}, err
	}
	job := domain.RenderJob{ID: ID(), TimelineID: p.TimelineID, Revision: p.Revision, Kind: "export", Status: "running", UpdatedAt: time.Now().UTC()}
	if preview {
		job.Kind = "preview"
	}
	if output == "" {
		output = filepath.Join(a.Store.Dir, "exports", job.ID+".mp4")
	}
	job.Output, err = filepath.Abs(output)
	if err != nil {
		return job, err
	}
	job.Plan, _ = json.Marshal(p)
	if err = a.Store.CreateJob(job); err != nil {
		return job, err
	}
	v, renderErr := render.Execute(ctx, a.Tools, p, job.Output)
	if renderErr != nil {
		job.Status = "failed"
		job.Error = renderErr.Error()
		if errors.Is(renderErr, context.Canceled) || errors.Is(renderErr, context.DeadlineExceeded) {
			job.Status = "cancelled"
		}
	} else {
		job.Status = "completed"
		job.Validation = &v
	}
	job.UpdatedAt = time.Now().UTC()
	if err = a.Store.FinishJob(job); err != nil {
		return job, errors.Join(renderErr, err)
	}
	job, err = a.Store.Job(job.ID)
	return job, errors.Join(renderErr, err)
}

// SubmitRender starts a durable local job. The P1 Render method remains
// synchronous for backwards compatibility; P3 callers use this method through
// the tool/API layer and receive a job ID immediately.
func (a *App) SubmitRender(id string, revision int, preview bool, filename string) (domain.RenderJob, error) {
	p, err := a.Plan(id, revision, preview)
	if err != nil {
		return domain.RenderJob{}, err
	}
	if filename == "" {
		filename = ID() + ".mp4"
	}
	if filepath.Base(filename) != filename || !strings.HasSuffix(strings.ToLower(filename), ".mp4") {
		return domain.RenderJob{}, errors.New("filename must be a plain .mp4 filename")
	}
	output := filepath.Join(a.Store.Dir, "exports", filename)
	job := domain.RenderJob{ID: ID(), TimelineID: p.TimelineID, Revision: p.Revision, Kind: "export", Status: "queued", Output: output, UpdatedAt: time.Now().UTC()}
	if preview {
		job.Kind = "preview"
	}
	job.Plan, _ = json.Marshal(p)
	if err = a.Store.CreateJob(job); err != nil {
		return job, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.run[job.ID] = cancel
	a.mu.Unlock()
	go a.runRender(ctx, job)
	return job, nil
}

func (a *App) runRender(ctx context.Context, job domain.RenderJob) {
	defer func() { a.mu.Lock(); delete(a.run, job.ID); a.mu.Unlock() }()
	if _, err := a.Store.StartJob(job.ID); err != nil {
		return
	}
	var p render.Plan
	if err := json.Unmarshal(job.Plan, &p); err != nil {
		job.Status, job.Error = "failed", err.Error()
		job.UpdatedAt = time.Now().UTC()
		_ = a.Store.FinishJob(job)
		return
	}
	v, err := render.Execute(ctx, a.Tools, p, job.Output)
	if err != nil {
		job.Status, job.Error = "failed", err.Error()
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			job.Status = "cancelled"
		}
	} else {
		job.Status, job.Progress, job.Validation = "completed", 100, &v
	}
	job.UpdatedAt = time.Now().UTC()
	_ = a.Store.FinishJob(job)
}

func (a *App) CancelJob(id string) (domain.RenderJob, error) {
	j, err := a.Store.Job(id)
	if err != nil {
		return j, err
	}
	if j.Status == "queued" {
		return a.Store.CancelQueuedJob(id)
	}
	if j.Status != "running" {
		return j, errors.New("only queued or running jobs can be cancelled")
	}
	a.mu.Lock()
	cancel := a.run[id]
	a.mu.Unlock()
	if cancel == nil {
		return j, errors.New("job worker is not available")
	}
	cancel()
	return a.Store.Job(id)
}
