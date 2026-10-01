package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
)

func TestOpenAITranscriberAndVision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing auth header")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/audio/transcriptions" {
			_ = json.NewEncoder(w).Encode(map[string]any{"segments": []any{map[string]any{"start": 1.25, "end": 2.5, "text": "关键时刻"}}})
			return
		}
		if r.URL.Path == "/v1/chat/completions" {
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "主持人正在讲话"}}}})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	dir := t.TempDir()
	video := filepath.Join(dir, "video.mp4")
	if err := os.WriteFile(video, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{BaseURL: server.URL, Model: "test", APIKey: "test-key", HTTPClient: server.Client()}
	cues, err := (OpenAITranscriber{Config: cfg}).Transcribe(context.Background(), domain.MediaAsset{Path: video, DurationUS: 5_000_000})
	if err != nil || len(cues) != 1 || cues[0].StartUS != 1_250_000 || cues[0].EndUS != 2_500_000 {
		t.Fatalf("transcription: %+v, %v", cues, err)
	}
	image := filepath.Join(dir, "frame.jpg")
	if err := os.WriteFile(image, []byte("jpeg"), 0600); err != nil {
		t.Fatal(err)
	}
	descriptions, err := (OpenAIVision{Config: cfg}).Describe(context.Background(), []domain.Evidence{{ID: "frame-1", FrameRefs: []string{image}}})
	if err != nil || descriptions["frame-1"] != "主持人正在讲话" {
		t.Fatalf("vision: %+v, %v", descriptions, err)
	}
}
