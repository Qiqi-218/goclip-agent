package chat

import "testing"

func TestClassifySupportedRequests(t *testing.T) {
	tests := []struct {
		message, goal, query string
		duration             int64
	}{
		{"剪成 1 分钟高能集锦", "highlights", "高能", 60_000_000},
		{"找出所有笑点", "jokes", "笑", 0},
		{"保留进球和庆祝", "sports", "进球 庆祝", 0},
		{"删掉开场和片尾", "trim_ends", "", 0},
		{"生成预览", "preview", "", 0},
		{"保留产品发布的掌声片段，剪成 30 秒", "select", "产品发布的掌声", 30_000_000},
	}
	for _, tt := range tests {
		got := classify(tt.message)
		if got.Goal != tt.goal || got.Query != tt.query || got.DurationUS != tt.duration {
			t.Fatalf("%q: got %+v", tt.message, got)
		}
	}
}
