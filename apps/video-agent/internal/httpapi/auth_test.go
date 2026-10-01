package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRequireSecretRefusesAMissingOrWrongToken is the credential itself: the
// routes that create projects, import footage and start renders must not answer
// an unauthenticated caller.
//
// A bare token is accepted alongside the `Bearer` form. Rejecting it would add no
// security — the secret is the thing that decides — and it makes the guard
// tolerant of a caller that set the header directly.
func TestRequireSecretRefusesAMissingOrWrongToken(t *testing.T) {
	reached := false
	handler := requireSecret("s3cret", http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) { reached = true; w.WriteHeader(http.StatusOK) },
	))

	cases := []struct {
		header string
		want   int
	}{
		{header: "", want: http.StatusUnauthorized},
		{header: "Bearer ", want: http.StatusUnauthorized},
		{header: "Bearer wrong", want: http.StatusUnauthorized},
		{header: "Bearer s3cret extra", want: http.StatusUnauthorized},
		{header: "Bearer s3cret", want: http.StatusOK},
		{header: "Bearer s3cret ", want: http.StatusOK},
		{header: "s3cret", want: http.StatusOK},
	}
	for _, tc := range cases {
		reached = false
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/tools/project_create", nil)
		if tc.header != "" {
			req.Header.Set("Authorization", tc.header)
		}
		handler.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("Authorization %q: status %d, want %d", tc.header, rec.Code, tc.want)
		}
		if tc.want == http.StatusUnauthorized {
			if reached {
				t.Fatalf("Authorization %q reached the handler", tc.header)
			}
			if !strings.Contains(rec.Body.String(), "unauthorized") {
				t.Fatalf("refusal body did not name its code: %s", rec.Body.String())
			}
		}
	}
}

// TestRequireSecretAdmitsEveryoneWhenUnset keeps local development unchanged: a
// service started without a token is the default and must not lock its own
// operator out.
func TestRequireSecretAdmitsEveryoneWhenUnset(t *testing.T) {
	handler := requireSecret("", http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) },
	))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/tools/project_create", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status %d, want the wrapped handler to run", rec.Code)
	}
}

// TestActionGuardLeavesReadOnlyRoutesOpen is the regression this guard exists
// for. Wrapping the whole route table refused the health probe and the asset
// bytes too, and since a `<video>` or `<img>` cannot send an Authorization
// header, that would break preview even for an operator holding the token.
func TestActionGuardLeavesReadOnlyRoutesOpen(t *testing.T) {
	served := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	mux := http.NewServeMux()
	for _, pattern := range []string{
		"GET /v1/health",
		"GET /v1/tools",
		"GET /v1/assets/{id}/file",
		"GET /v1/assets/{id}/frames/{rest...}",
		"GET /v1/diagnostics/concurrency",
		"POST /v1/tools/{name}",
		"POST /v1/chat",
	} {
		mux.HandleFunc(pattern, served)
	}
	handler := actionGuard(mux, "s3cret")

	cases := []struct {
		method string
		path   string
		want   int
		reason string
	}{
		{http.MethodGet, "/v1/health", http.StatusOK, "a health probe carries no credential"},
		{http.MethodGet, "/v1/tools", http.StatusOK, "the tool list is a read"},
		{http.MethodGet, "/v1/assets/a/file", http.StatusOK, "video bytes cannot carry a header"},
		{http.MethodGet, "/v1/assets/a/frames/k/frame-0001.jpg", http.StatusOK, "frame images cannot carry a header"},
		{http.MethodGet, "/v1/diagnostics/concurrency", http.StatusOK, "diagnostics report on the process"},
		{http.MethodPost, "/v1/tools/project_create", http.StatusUnauthorized, "this route changes stored state"},
		{http.MethodPost, "/v1/chat", http.StatusUnauthorized, "this route drives the model"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != tc.want {
			t.Fatalf("%s %s: status %d, want %d (%s)", tc.method, tc.path, rec.Code, tc.want, tc.reason)
		}
	}

	// The same mutating route with the credential is admitted.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/tools/project_create", nil)
	req.Header.Set("Authorization", "Bearer s3cret")
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("a credentialed call was refused: %d", rec.Code)
	}
}
