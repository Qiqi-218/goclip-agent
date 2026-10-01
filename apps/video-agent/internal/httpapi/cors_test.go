package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestCORSAdmitsOnlyListedOrigins pins the fence: the harness Web client lives
// on another port, so its page needs this service to answer cross-origin reads
// of asset and frame bytes — but only for origins the operator listed.
func TestCORSAdmitsOnlyListedOrigins(t *testing.T) {
	s, _ := serveTestServer(t)

	// serveTestServer builds the mux without an allowlist, so nothing is admitted.
	req, _ := http.NewRequest(http.MethodGet, s.URL+"/v1/health", nil)
	req.Header.Set("Origin", "http://127.0.0.1:8099")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unlisted origin was echoed as %q; want no header", got)
	}
}

// TestParseAllowedOrigins covers the parsing the allowlist depends on: blank
// values name nobody, surrounding spaces are ignored, and repeats collapse.
func TestParseAllowedOrigins(t *testing.T) {
	cases := []struct {
		raw   string
		want  []string
		empty []string
	}{
		{raw: "", want: nil, empty: []string{"http://127.0.0.1:8099"}},
		{raw: "   ", want: nil, empty: []string{"http://localhost:3080"}},
		{
			raw:   "http://127.0.0.1:8099, http://localhost:3080 ,http://127.0.0.1:8099",
			want:  []string{"http://127.0.0.1:8099", "http://localhost:3080"},
			empty: []string{"http://evil.example"},
		},
	}
	for _, tc := range cases {
		allowed := parseAllowedOrigins(tc.raw)
		for _, origin := range tc.want {
			if !allowed[origin] {
				t.Fatalf("%q: expected %q to be allowed, got %v", tc.raw, origin, allowed)
			}
		}
		for _, origin := range tc.empty {
			if allowed[origin] {
				t.Fatalf("%q: expected %q to be refused, got %v", tc.raw, origin, allowed)
			}
		}
	}
}

// TestCORSPreflightAnswersListedOrigin proves the preflight path the browser
// actually sends before a JSON POST: a listed origin gets the admitted methods
// and no body, so the real request never leaves the browser unexamined.
func TestCORSPreflightAnswersListedOrigin(t *testing.T) {
	handler := cors(parseAllowedOrigins("http://127.0.0.1:8099"), http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) },
	))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/v1/tools/project_list", nil)
	req.Header.Set("Origin", "http://127.0.0.1:8099")
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status: %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:8099" {
		t.Fatalf("allow-origin: %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("preflight did not name the admitted methods")
	}

	// An unlisted origin falls through to the wrapped handler instead.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodOptions, "/v1/tools/project_list", nil)
	req.Header.Set("Origin", "http://evil.example")
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("unlisted preflight should reach the handler, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unlisted origin echoed: %q", got)
	}
}
