package httpapi

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/store"
)

// serveTestServer opens an app over a fresh data directory, records a project so
// assets satisfy their foreign key, and returns the HTTP server plus the store.
// A test can then place files and rows the way the real writers do and ask for
// their bytes over HTTP.
func serveTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	if err := a.Store.CreateProject(domain.Project{ID: "p", Name: "测试项目"}); err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(New(a))
	t.Cleanup(s.Close)
	return s, a.Store
}

// readyAsset is the minimum a stored asset must carry to be accepted.
func readyAsset(id, path, hash string) domain.MediaAsset {
	return domain.MediaAsset{
		ID: id, ProjectID: "p", Path: path, ContentHash: hash, Status: "ready",
		DurationUS: 10_000_000, Width: 1920, Height: 1080, FPS: "25/1",
	}
}

// mediaBytes is a fixed byte pattern: the routes under test must return exactly
// what is on disk, so the assertion compares bytes rather than a length.
var mediaBytes = []byte("FAKE-MP4-PAYLOAD-0123456789")

// TestAssetFileServesSourceBytesWithRange covers the route that made uploaded
// footage reachable at all: before it existed, a browser could only ever fetch a
// completed render, so the video a user had just imported could not be watched,
// and no clip could be scrubbed before committing to a cut.
func TestAssetFileServesSourceBytesWithRange(t *testing.T) {
	s, st := serveTestServer(t)
	assets := filepath.Join(st.Dir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(assets, "abc123.media")
	if err := os.WriteFile(path, mediaBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	const id = "asset-abc123"
	if _, err := st.PutAsset(readyAsset(id, path, "abc123")); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(s.URL + "/v1/assets/" + id + "/file")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %s", resp.Status)
	}
	if string(body) != string(mediaBytes) {
		t.Fatalf("body: %q", body)
	}
	if got := resp.Header.Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges: %q — a player cannot seek without it", got)
	}

	req, _ := http.NewRequest(http.MethodGet, s.URL+"/v1/assets/"+id+"/file", nil)
	req.Header.Set("Range", "bytes=0-3")
	partial, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	chunk, _ := io.ReadAll(partial.Body)
	partial.Body.Close()
	if partial.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status: %s", partial.Status)
	}
	if string(chunk) != "FAKE" {
		t.Fatalf("range body: %q", chunk)
	}
	if got := partial.Header.Get("Content-Range"); got == "" {
		t.Fatal("missing Content-Range on a 206")
	}
}

// TestAssetFileRejectsUnknownAndEscapingPaths proves the two refusals the route
// owes a caller: an id nothing recorded, and a stored path that leaves the
// managed assets directory.
func TestAssetFileRejectsUnknownAndEscapingPaths(t *testing.T) {
	s, st := serveTestServer(t)

	resp, err := http.Get(s.URL + "/v1/assets/asset-nope/file")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown asset status: %s", resp.Status)
	}

	outside := filepath.Join(st.Dir, "video-agent.db")
	if err := os.WriteFile(outside, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	const id = "asset-escape"
	if _, err := st.PutAsset(readyAsset(id, outside, "escape")); err != nil {
		t.Fatal(err)
	}
	resp, err = http.Get(s.URL + "/v1/assets/" + id + "/file")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("escaping path status: %s", resp.Status)
	}
}

// TestProjectAssetUploadStoresAndImports covers the route the workbench panel
// uses. A browser picking a file only ever produces bytes, never a host path, so
// the panel's import has to store and record in one request.
func TestProjectAssetUploadStoresAndImports(t *testing.T) {
	s, st := serveTestServer(t)

	// A body that is not media must be refused before anything is recorded, and
	// the refusal must be the service's own wording rather than a panic.
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("not media")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(s.URL+"/v1/projects/p/assets", writer.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-video upload status: %s", resp.Status)
	}
	assets, err := st.Assets("p")
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 0 {
		t.Fatalf("a refused upload recorded %d asset(s)", len(assets))
	}

	// An unknown project is refused by the import step with a named code, so the
	// model and the panel both learn which referent was wrong.
	var missing bytes.Buffer
	writer = multipart.NewWriter(&missing)
	part, err = writer.CreateFormFile("file", "clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("still not media")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	resp, err = http.Post(s.URL+"/v1/projects/nope/assets", writer.FormDataContentType(), &missing)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("upload into an unknown project answered OK: %s", payload)
	}
	if !bytes.Contains(payload, []byte("code")) {
		t.Fatalf("refusal did not carry a service code: %s", payload)
	}
}

// TestFrameRouteServesOnlySamplerNames pins the pattern check: the frame path
// carries a run directory and a file name taken from the URL, so anything that
// is not exactly what the sampler writes must be refused before it reaches disk.
// Both frame writers are covered, because they key their directories differently.
func TestFrameRouteServesOnlySamplerNames(t *testing.T) {
	s, st := serveTestServer(t)
	assets := filepath.Join(st.Dir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PutAsset(readyAsset("asset-f1", filepath.Join(assets, "f1.media"), "hash1")); err != nil {
		t.Fatal(err)
	}

	const run = "key-1"
	frames := filepath.Join(st.Dir, "analysis", "asset-f1", run, "frames")
	if err := os.MkdirAll(frames, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frames, "frame-0007.jpg"), []byte("JPEGDATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok, err := http.Get(s.URL + "/v1/assets/asset-f1/frames/" + run + "/frame-0007.jpg")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(ok.Body)
	ok.Body.Close()
	if ok.StatusCode != http.StatusOK || string(body) != "JPEGDATA" {
		t.Fatalf("frame fetch: %s %q", ok.Status, body)
	}

	search := filepath.Join(st.Dir, "visionsearch", "asset-f1", "170000000-210000000-16")
	if err := os.MkdirAll(search, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(search, "frame-0003.jpg"), []byte("VSEARCH"), 0o644); err != nil {
		t.Fatal(err)
	}
	vs, err := http.Get(s.URL + "/v1/assets/asset-f1/frames/search/170000000-210000000-16/frame-0003.jpg")
	if err != nil {
		t.Fatal(err)
	}
	vsBody, _ := io.ReadAll(vs.Body)
	vs.Body.Close()
	if vs.StatusCode != http.StatusOK || string(vsBody) != "VSEARCH" {
		t.Fatalf("visual-search frame fetch: %s %q", vs.Status, vsBody)
	}

	for _, bad := range []string{
		"/v1/assets/asset-f1/frames/" + run + "/frame-7.jpg",
		"/v1/assets/asset-f1/frames/" + run + "/../../video-agent.db",
		"/v1/assets/asset-f1/frames/bad.run/frame-0007.jpg",
	} {
		resp, err := http.Get(s.URL + bad)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("%s was served; want a refusal", bad)
		}
	}
}
