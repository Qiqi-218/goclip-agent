package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zylar06/video-agent/internal/app"
)

func TestToolsAreLoopbackAPIJSON(t *testing.T) {
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s := httptest.NewServer(New(a))
	defer s.Close()
	resp, err := http.Get(s.URL + "/v1/tools")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("tools response: %s", resp.Status)
	}
	resp.Body.Close()
	resp, err = http.Post(s.URL+"/v1/tools/project_create", "application/json", bytes.NewBufferString(`{"id":"p","name":"P3"}`))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create response: %s", resp.Status)
	}
	resp.Body.Close()
	resp, err = http.Get(s.URL + "/v1/artifacts/../../video-agent.db")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("path traversal status: %s", resp.Status)
	}
	resp.Body.Close()
}

func TestUICreatesAProjectWithoutAnExposedID(t *testing.T) {
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s := httptest.NewServer(New(a))
	defer s.Close()
	resp, err := http.Post(s.URL+"/v1/ui/projects", "application/json", bytes.NewBufferString(`{"name":"我的首支视频"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create response: %s", resp.Status)
	}
}
