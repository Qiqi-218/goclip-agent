package asr

import (
	"context"
	"os"
	"testing"
)

func TestParseSRTAndVTTTimestamps(t *testing.T) {
	path := t.TempDir() + "/sample.srt"
	data := "1\n00:00:01,250 --> 00:00:02,500\n第一句\n第二行\n\n2\n00:00:03.000 --> 00:00:04.000\n第二句\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	cues, err := ParseFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cues) != 2 || cues[0].StartUS != 1_250_000 || cues[0].EndUS != 2_500_000 || cues[0].Text != "第一句 第二行" {
		t.Fatalf("unexpected cues: %+v", cues)
	}
}

func TestParseRejectsInvalidOrder(t *testing.T) {
	path := t.TempDir() + "/bad.vtt"
	data := "WEBVTT\n\n00:02.000 --> 00:03.000\nlate\n\n00:01.000 --> 00:01.500\nearly\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseFile(context.Background(), path); err == nil {
		t.Fatal("expected ordering error")
	}
}
