// Package httpapi exposes the same constrained P3 tools over loopback HTTP.
package httpapi

import (
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/zylar06/video-agent/internal/agent"
	"github.com/zylar06/video-agent/internal/analysis"
	"github.com/zylar06/video-agent/internal/analysis/provider"
	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/chat"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/render"
)

//go:embed web/index.html
var webFiles embed.FS

//go:embed web/chat.html
var chatPage []byte

// New builds the local HTTP surface. The tool-calling chat routes are wired here
// so the agent runtime reads the same model configuration as the rest of the
// service.
func New(a *app.App) http.Handler {
	s := agent.NewService(a)
	observer := newActionObserver(512)
	mux := http.NewServeMux()
	agentRoutes(mux, a, s)
	mux.HandleFunc("GET /chat", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(chatPage)
	})
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		data, err := webFiles.ReadFile("web/index.html")
		if err != nil {
			http.Error(w, "web UI unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: map[string]string{"status": "ok"}})
	})
	mux.HandleFunc("GET /v1/tools", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: s.Names()})
	})
	mux.HandleFunc("POST /v1/chat", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var input chat.Request
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input); err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		result, err := (chat.Service{Store: a.Store, Text: provider.OpenAIText{Config: provider.ConfigFromEnvAliases("VIDEO_AGENT_TEXT", "AUTOCLIP_TEXT")}, Analyzer: analysis.New(a.Store, a.Tools)}).Handle(r.Context(), input)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: result})
	})
	// The UI routes are deliberately local implementation details. They provide
	// a safe browser workflow without exposing filesystem paths or tool JSON.
	mux.HandleFunc("POST /v1/ui/projects", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil || strings.TrimSpace(in.Name) == "" {
			write(w, http.StatusBadRequest, invalid(errors.New("请输入项目名称")))
			return
		}
		p := domain.Project{ID: "project-" + app.ID(), Name: strings.TrimSpace(in.Name)}
		if err := a.Store.CreateProject(p); err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: p})
	})
	mux.HandleFunc("GET /v1/ui/projects/{id}/assets", func(w http.ResponseWriter, r *http.Request) {
		assets, err := a.Store.Assets(r.PathValue("id"))
		if err != nil {
			write(w, http.StatusNotFound, invalid(err))
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: assets})
	})
	mux.HandleFunc("POST /v1/ui/projects/{id}/assets", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
		if err := r.ParseMultipartForm(16 << 20); err != nil {
			write(w, http.StatusBadRequest, invalid(errors.New("视频文件超过 2GB 或上传格式不正确")))
			return
		}
		file, header, err := r.FormFile("video")
		if err != nil {
			write(w, http.StatusBadRequest, invalid(errors.New("请选择视频文件")))
			return
		}
		defer file.Close()
		path, err := saveUpload(a.Store.Dir, "uploads", header.Filename, file)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		asset, err := a.Tools.Import(r.Context(), a.Store, r.PathValue("id"), path)
		_ = os.Remove(path)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		result := map[string]any{"asset": asset}
		if subtitle, sh, subtitleErr := r.FormFile("subtitle"); subtitleErr == nil {
			defer subtitle.Close()
			sp, saveErr := saveUpload(a.Store.Dir, "subtitles", sh.Filename, subtitle)
			if saveErr != nil {
				write(w, http.StatusBadRequest, invalid(saveErr))
				return
			}
			result["subtitle_path"] = sp
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: result})
	})
	mux.HandleFunc("POST /v1/ui/analyze", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ProjectID    string `json:"project_id"`
			AssetID      string `json:"asset_id"`
			SubtitlePath string `json:"subtitle_path,omitempty"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		vision := provider.ConfigFromEnvAliases("VIDEO_AGENT_VISION", "AUTOCLIP_VISION")
		visualEnabled := vision.BaseURL != "" && vision.Model != "" && vision.APIKey != ""
		result, err := analysis.New(a.Store, a.Tools).Analyze(r.Context(), analysis.Request{ProjectID: in.ProjectID, AssetID: in.AssetID, SubtitlePath: in.SubtitlePath, Visual: visualEnabled})
		if err != nil {
			write(w, http.StatusBadRequest, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "model_unavailable", Message: "请上传 SRT/VTT 字幕，或在服务端配置 AUTOCLIP_ASR_* 后重试。"}})
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: result})
	})
	mux.HandleFunc("POST /v1/ui/proposals", func(w http.ResponseWriter, r *http.Request) {
		var in chat.Request
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		result, err := (chat.Service{Store: a.Store, Text: provider.OpenAIText{Config: provider.ConfigFromEnvAliases("VIDEO_AGENT_TEXT", "AUTOCLIP_TEXT")}}).Handle(r.Context(), in)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		draft, err := draftTimeline(a, in.ProjectID, in.AssetID, result)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: map[string]any{"reply": result.Reply, "intent": result.Intent, "evidence": result.Evidence, "timeline": draft}})
	})
	mux.HandleFunc("POST /v1/ui/proposals/confirm", func(w http.ResponseWriter, r *http.Request) {
		var timeline domain.TimelineRevision
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&timeline); err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		created, err := a.CreateTimeline(timeline)
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: created})
	})
	mux.HandleFunc("POST /v1/tools/{name}", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			write(w, http.StatusBadRequest, invalid(err))
			return
		}
		done := observer.begin(r.PathValue("name"))
		defer done()
		result := s.Call(r.Context(), r.PathValue("name"), body)
		write(w, status(result), result)
	})
	// Diagnostics for whether callers actually dispatch this service
	// concurrently. Two calls that overlapped here cannot have been serialized
	// by the caller, so an overlap is the evidence that a harness ran its
	// read-only tools in parallel instead of one at a time.
	mux.HandleFunc("GET /v1/diagnostics/concurrency", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: observer.snapshot()})
	})
	mux.HandleFunc("GET /v1/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		j, err := a.Store.Job(r.PathValue("id"))
		if err != nil {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: err.Error()}})
			return
		}
		write(w, http.StatusOK, agent.Envelope{APIVersion: agent.APIVersion, OK: true, Result: j})
	})
	mux.HandleFunc("POST /v1/jobs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		body, _ := json.Marshal(map[string]string{"id": r.PathValue("id")})
		result := s.Call(r.Context(), "jobs_cancel", body)
		write(w, status(result), result)
	})
	mux.HandleFunc("GET /v1/artifacts/{id}", func(w http.ResponseWriter, r *http.Request) {
		j, err := a.Store.Job(r.PathValue("id"))
		if err != nil || j.Status != "completed" {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: "completed artifact not found"}})
			return
		}
		serveManagedFile(w, r, filepath.Join(a.Store.Dir, "exports"), j.Output, "artifact")
	})
	// Source footage by asset id. Without this route the only bytes a browser
	// could reach were completed renders, so the video someone had just uploaded
	// was unreachable and no clip could be scrubbed before committing to a cut.
	mux.HandleFunc("GET /v1/assets/{id}/file", func(w http.ResponseWriter, r *http.Request) {
		asset, err := a.Store.AssetByID(r.PathValue("id"))
		if err != nil {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: err.Error()}})
			return
		}
		serveManagedFile(w, r, filepath.Join(a.Store.Dir, "assets"), asset.Path, "asset")
	})
	// One sampled frame by name, as the sampler wrote it. The frame a vision
	// model judged is the evidence for that judgement, so it has to be
	// inspectable; naming the runs by their own directory keeps the two writers
	// (index-time sampling and ad-hoc visual search) apart without guessing.
	mux.HandleFunc("GET /v1/assets/{id}/frames/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		id, rest := r.PathValue("id"), r.PathValue("rest")
		base, ok := frameBase(a.Store.Dir, id, rest)
		if !ok {
			write(w, http.StatusBadRequest, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "invalid_request", Message: "invalid frame reference"}})
			return
		}
		if _, err := a.Store.AssetByID(id); err != nil {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: err.Error()}})
			return
		}
		serveManagedFile(w, r, base, filepath.Join(base, filepath.Base(rest)), "frame")
	})
	// The credential is applied by path rather than by wrapping the whole mux,
	// because the read-only routes must stay open: a `<video>` or `<img>` cannot
	// send an Authorization header, so gating the bytes would break preview even
	// for an operator who holds the token.
	mux.HandleFunc("GET /v1/artifacts/{id}/poster.jpg", func(w http.ResponseWriter, r *http.Request) {
		job, err := a.Store.Job(r.PathValue("id"))
		if err != nil {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: err.Error()}})
			return
		}
		if len(job.Plan) == 0 {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: "this job recorded no plan, so its opening frame is unknown"}})
			return
		}
		var plan render.Plan
		if err := json.Unmarshal(job.Plan, &plan); err != nil {
			write(w, http.StatusInternalServerError, invalid(err))
			return
		}
		stills, err := render.Stills(r.Context(), a.Tools, plan, 1)
		if err != nil {
			write(w, http.StatusBadGateway, invalid(err))
			return
		}
		if len(stills) == 0 {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: "the cut's opening frame could not be decoded"}})
			return
		}
		writeStill(w, stills[0])
	})
	// An asset's own thumbnail, so its entry in the footage list shows what the
	// file is instead of an empty rectangle. Sampling half a second in skips a
	// slate or a fade at the very start.
	mux.HandleFunc("GET /v1/assets/{id}/thumbnail.jpg", func(w http.ResponseWriter, r *http.Request) {
		asset, err := a.Store.AssetByID(r.PathValue("id"))
		if err != nil {
			write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: err.Error()}})
			return
		}
		still, err := render.Thumbnail(r.Context(), a.Tools, asset.Path, 500_000)
		if err != nil {
			write(w, http.StatusBadGateway, invalid(err))
			return
		}
		writeStill(w, still)
	})
	return securityHeaders(cors(parseAllowedOrigins(os.Getenv(allowedOriginsEnv)),
		actionGuard(mux, os.Getenv(sharedSecretEnv))))
}

// writeStill replies with one decoded JPEG.
//
// A thumbnail is small and stable, so it is cached rather than re-decoded on
// every list render: the workbench asks for one per item each time it loads a
// project. The content type is set explicitly because the bytes come from ffmpeg
// rather than from a file the server could sniff.
//
// @param w - the response to write.
// @param jpeg - the encoded frame.
func writeStill(w http.ResponseWriter, jpeg []byte) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(jpeg)
}

// actionGuard wraps only the routes that change stored state.
//
// The distinction is method as well as path: `GET /v1/tools` is a read that
// lists the actions, while `POST /v1/tools/{name}` is the call that runs one.
// Guarding by path prefix alone would refuse the list, which the workbench panel
// reads to show what the assistant can do.
//
// Everything else passes through: the health probe, asset and frame bytes, and
// the diagnostics snapshot. Those either serve bytes the action routes already
// gated or report on the process, and a browser element cannot attach a header
// to any of them.
//
// @param mux - the full route table.
// @param secret - the configured token, empty to admit every request.
// @returns a handler that guards the mutating routes and passes the rest through.
func actionGuard(mux *http.ServeMux, secret string) http.Handler {
	inner := requireSecret(secret, mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mutating := r.Method != http.MethodGet && r.Method != http.MethodHead &&
			(strings.HasPrefix(r.URL.Path, "/v1/tools") || r.URL.Path == "/v1/chat")
		if !mutating {
			mux.ServeHTTP(w, r)
			return
		}
		inner.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// sharedSecretEnv names the environment variable holding the bearer token that
// callers of the action routes must present.
//
// Those routes change stored state: they create projects, import footage, apply
// edits and start renders. While the service listens on a loopback address that
// is acceptable, because reaching it already requires running code on the
// machine. It stops being acceptable the moment the service is reachable from
// anywhere else, which the competition's public-accessibility requirement
// demands, so the same deployment that widens the listen address can require a
// credential.
//
// Empty or unset means no credential is required, which keeps local development
// unchanged.
const sharedSecretEnv = "VIDEO_AGENT_SHARED_SECRET"

// requireSecret rejects a request that does not carry the configured bearer
// token.
//
// It guards the action routes on every listen address rather than only public
// ones: a check that switched on the bind address would stop protecting the
// service the day the address changed, and the credential is meant to be the
// thing that decides.
//
// The read-only routes are deliberately not wrapped. They serve bytes the action
// routes already gated, and `<video>` and `<img>` cannot send an Authorization
// header, so requiring one there would break preview.
//
// @param secret - the configured token, empty to admit every request.
// @param next - the handler to run when a request is admitted.
// @returns the guarded handler.
func requireSecret(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if secret == "" {
			next.ServeHTTP(w, r)
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if token != secret {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"api_version":"v1","ok":false,"error":{"code":"unauthorized","message":"this deployment requires a bearer token; configure one on the caller"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// frameBase resolves a frame URL's tail to the directory that holds it, or
// reports that the tail is not a shape either frame writer produces. Both
// writers key their tree by asset id; the analyser then names its cache key, and
// the ad-hoc visual search names the sampled window, so the accepted tails are
// `<analysis cache key>/frame-NNNN.jpg` and `search/<window>/frame-NNNN.jpg`.
func frameBase(dataDir, assetID, rest string) (string, bool) {
	parts := strings.Split(rest, "/")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return "", false
		}
	}
	switch {
	case len(parts) == 2 && validFrameName(parts[1]) && validFrameRun(parts[0]):
		return filepath.Join(dataDir, "analysis", assetID, parts[0], "frames"), true
	case len(parts) == 3 && parts[0] == visionSearchRun && validFrameName(parts[2]) && validFrameRun(parts[1]):
		return filepath.Join(dataDir, "visionsearch", assetID, parts[1]), true
	default:
		return "", false
	}
}

// visionSearchRun is the pseudo-run name the ad-hoc visual search uses, because
// its frames live in their own directory tree keyed by the sampled window.
const visionSearchRun = "search"

// validFrameName accepts only the file names the frame sampler writes.
func validFrameName(name string) bool {
	return frameNamePattern.MatchString(name)
}

// validFrameRun accepts an analysis cache key or the visual-search marker.
func validFrameRun(run string) bool {
	return run == visionSearchRun || frameRunPattern.MatchString(run)
}

var (
	frameNamePattern = regexp.MustCompile(`^frame-\d{4}\.jpg$`)
	frameRunPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// serveManagedFile streams one regular file that must live under base, with
// Range support so a browser can seek. Both arguments are server-side values or
// pattern-validated path segments; filepath.Rel is the boundary check that keeps
// a crafted id from escaping the managed directory.
func serveManagedFile(w http.ResponseWriter, r *http.Request, base, path, what string) {
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		write(w, http.StatusForbidden, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "invalid_request", Message: what + " is outside managed storage"}})
		return
	}
	f, err := os.Open(path)
	if err != nil {
		write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: what + " file not found"}})
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		write(w, http.StatusNotFound, agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "not_found", Message: what + " file not found"}})
		return
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

func saveUpload(dataDir, group, name string, source io.Reader) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	switch group {
	case "uploads":
		if ext != ".mp4" && ext != ".mov" && ext != ".m4v" {
			return "", errors.New("仅支持 MP4、MOV 或 M4V 视频")
		}
	case "subtitles":
		if ext != ".srt" && ext != ".vtt" {
			return "", errors.New("字幕仅支持 SRT 或 VTT")
		}
	case "agent-uploads":
		// The chat surfaces accepts both media and subtitles, so it validates
		// against the union rather than one group's format.
		if !isAgentUpload(ext) {
			return "", errors.New("仅支持 MP4、MOV、M4V、SRT 或 VTT")
		}
	}
	dir := filepath.Join(dataDir, group)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "upload-*"+ext)
	if err != nil {
		return "", err
	}
	path := f.Name()
	_, copyErr := io.Copy(f, source)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(path)
		return "", errors.Join(copyErr, closeErr)
	}
	return path, nil
}

// isAgentUpload reports whether an extension may be dropped into the chat
// surface: media to import, or subtitles to analyze against.
func isAgentUpload(ext string) bool {
	switch ext {
	case ".mp4", ".mov", ".m4v", ".srt", ".vtt":
		return true
	}
	return false
}

func draftTimeline(a *app.App, projectID, assetID string, result chat.Result) (domain.TimelineRevision, error) {
	if len(result.Evidence) == 0 {
		return domain.TimelineRevision{}, errors.New("没有找到可确认的素材片段，请换一种说法或补充字幕")
	}
	asset, err := a.Store.Asset(projectID, assetID)
	if err != nil {
		return domain.TimelineRevision{}, err
	}
	parts := strings.Split(asset.FPS, "/")
	fpsNum, fpsDen := 30, 1
	if len(parts) == 2 {
		if n, e := strconv.Atoi(parts[0]); e == nil && n > 0 {
			fpsNum = n
		}
		if d, e := strconv.Atoi(parts[1]); e == nil && d > 0 {
			fpsDen = d
		}
	}
	t := domain.TimelineRevision{ID: "timeline-" + app.ID(), ProjectID: projectID, Revision: 1, FPSNum: fpsNum, FPSDen: fpsDen, Width: asset.Width, Height: asset.Height}
	remaining := result.Intent.DurationUS
	for i, hit := range result.Evidence {
		e := hit.Evidence
		end := e.EndUS
		if remaining > 0 && end-e.StartUS > remaining {
			end = e.StartUS + remaining
		}
		if end <= e.StartUS {
			break
		}
		t.Items = append(t.Items, domain.ClipItem{ID: "clip-" + strconv.Itoa(i+1), AssetID: e.AssetID, SourceInUS: e.StartUS, SourceOutUS: end, DurationFrames: t.Frames(end - e.StartUS), EvidenceIDs: []string{e.ID}})
		if remaining > 0 {
			remaining -= end - e.StartUS
			if remaining <= 0 {
				break
			}
		}
	}
	if len(t.Items) == 0 {
		return domain.TimelineRevision{}, errors.New("候选片段无法生成时间线")
	}
	t.Reflow()
	return t, nil
}

// DefaultUploadTimeout bounds one upload. A video from a phone, a camera card,
// or a remote browser over a home uplink routinely takes minutes, so the default
// is generous; the previous 30s server-wide read timeout aborted such transfers
// mid-body and surfaced to the user as a bare "上传失败".
const DefaultUploadTimeout = 30 * time.Minute

// Server builds the HTTP server. ReadTimeout is off by default because Go applies
// it to the entire request including the body, which would cap every upload at
// that duration regardless of size. Individual handlers that need a deadline set
// their own.
func Server(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       0,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
}

// allowedOriginsEnv names the environment variable that lists the browser
// origins allowed to call this service from a page it did not serve. The
// harness Web client is served by a different process on a different port, so
// its workbench panel cannot read the asset and frame bytes without this.
// Empty or unset means no cross-origin caller is admitted, which keeps the
// default posture closed.
const allowedOriginsEnv = "VIDEO_AGENT_ALLOWED_ORIGINS"

// cors answers the browser's cross-origin checks for the listed origins.
//
// Only listed origins are echoed; an unlisted one gets no header at all, so the
// browser refuses it. The preflight answer is restricted to what a page needs —
// GET, POST, DELETE and a JSON content type — because that is the whole method
// set the routes below use.
func cors(allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// parseAllowedOrigins reads the origin allowlist from one environment value.
// @param raw - comma-separated origins, as read from the environment.
// @returns the set to match against, empty when the value names none.
func parseAllowedOrigins(raw string) map[string]bool {
	allowed := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(part)
		if origin != "" {
			allowed[origin] = true
		}
	}
	return allowed
}
func invalid(err error) agent.Envelope {
	return agent.Envelope{APIVersion: agent.APIVersion, OK: false, Error: &agent.APIError{Code: "invalid_request", Message: err.Error()}}
}
func status(e agent.Envelope) int {
	if e.OK {
		return http.StatusOK
	}
	if e.Error != nil && e.Error.Code == "not_found" {
		return http.StatusNotFound
	}
	if e.Error != nil && e.Error.Code == "revision_conflict" {
		return http.StatusConflict
	}
	return http.StatusBadRequest
}
func write(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
