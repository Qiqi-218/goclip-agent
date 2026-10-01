package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseChatResponseReadsToolCalls(t *testing.T) {
	raw := []byte(`{
      "choices":[{"finish_reason":"tool_calls","message":{
        "content":"",
        "tool_calls":[
          {"id":"call_1","type":"function","function":{"name":"search_evidence","arguments":"{\"query\":\"数学\"}"}},
          {"id":"call_2","type":"function","function":{"name":"timeline_get","arguments":"{}"}}
        ]}}],
      "usage":{"total_tokens":42}
    }`)
	got, err := parseChatResponse(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.WantsTools() || len(got.ToolCalls) != 2 {
		t.Fatalf("want 2 tool calls, got %+v", got.ToolCalls)
	}
	if got.ToolCalls[0].Function.Name != "search_evidence" {
		t.Fatalf("wrong tool name: %q", got.ToolCalls[0].Function.Name)
	}
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(got.ToolCalls[0].Function.Arguments), &args); err != nil {
		t.Fatalf("arguments must stay valid raw JSON: %v", err)
	}
	if args.Query != "数学" {
		t.Fatalf("arguments corrupted: %q", args.Query)
	}
	if got.Finish != "tool_calls" {
		t.Fatalf("finish reason lost: %q", got.Finish)
	}
}

func TestParseChatResponseReadsProse(t *testing.T) {
	got, err := parseChatResponse([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"  我已经把方案整理好了  "}}]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.WantsTools() {
		t.Fatal("prose reply must not report tool calls")
	}
	if got.Content != "我已经把方案整理好了" {
		t.Fatalf("content not trimmed: %q", got.Content)
	}
}

func TestParseChatResponseRejectsBadPayloads(t *testing.T) {
	cases := map[string]string{
		"invalid json":     `not json`,
		"no choices":       `{"choices":[]}`,
		"empty everything": `{"choices":[{"message":{"content":""}}]}`,
		"nameless call":    `{"choices":[{"message":{"tool_calls":[{"id":"c","function":{"arguments":"{}"}}]}}]}`,
	}
	for name, payload := range cases {
		if _, err := parseChatResponse([]byte(payload)); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

// The agent loop depends on tool_calls surviving a round trip through Message,
// because the assistant turn is replayed before the tool results.
func TestAssistantMessagePreservesToolCalls(t *testing.T) {
	result := ChatResult{ToolCalls: []ToolCall{{ID: "call_1", Type: "function", Function: ToolCallFunc{Name: "assets_list", Arguments: `{"project_id":"p1"}`}}}}
	encoded, err := json.Marshal(result.AssistantMessage())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"tool_calls"`) || !strings.Contains(string(encoded), `"assets_list"`) {
		t.Fatalf("assistant message dropped tool calls: %s", encoded)
	}
	toolMsg, _ := json.Marshal(ToolMessage("call_1", "assets_list", `{"ok":true}`))
	for _, want := range []string{`"role":"tool"`, `"tool_call_id":"call_1"`, `"name":"assets_list"`} {
		if !strings.Contains(string(toolMsg), want) {
			t.Fatalf("tool message missing %s: %s", want, toolMsg)
		}
	}
}

// Chat must send tools in the wrapped wire format the OpenAI schema requires,
// and must return the parsed tool calls.
func TestChatSendsToolsAndParsesToolCalls(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("missing bearer token, got %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("request body not JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"","tool_calls":[{"id":"c1","function":{"name":"search_evidence","arguments":"{\"query\":\"x\"}"}}]}}]}`))
	}))
	defer server.Close()

	client := OpenAIText{Config: Config{BaseURL: server.URL, Model: "test-model", APIKey: "secret", HTTPClient: server.Client()}}
	result, err := client.Chat(context.Background(),
		[]Message{{Role: "user", Content: "找出讲数学的片段"}},
		[]ToolDefinition{{Name: "search_evidence", Description: "检索", Parameters: map[string]any{"type": "object"}}})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != "search_evidence" {
		t.Fatalf("tool calls not parsed: %+v", result.ToolCalls)
	}

	tools, ok := received["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("tools not sent in wire format: %+v", received["tools"])
	}
	first := tools[0].(map[string]any)
	if first["type"] != "function" {
		t.Fatalf("tool entry must be wrapped with type=function: %+v", first)
	}
	if _, ok := first["function"].(map[string]any); !ok {
		t.Fatalf("tool definition must nest under function: %+v", first)
	}
	if received["tool_choice"] != "auto" {
		t.Fatalf("tool_choice should be auto, got %v", received["tool_choice"])
	}
}

// Without tool definitions the request must stay a plain completion, so existing
// single-shot callers keep working unchanged.
func TestChatOmitsToolsWhenNoneProvided(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &received)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"好的"}}]}`))
	}))
	defer server.Close()

	client := OpenAIText{Config: Config{BaseURL: server.URL, Model: "m", APIKey: "k", HTTPClient: server.Client()}}
	if _, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, present := received["tools"]; present {
		t.Fatalf("tools must be omitted when empty: %+v", received)
	}
}

func TestChatRequiresConfiguration(t *testing.T) {
	client := OpenAIText{}
	if _, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil); err == nil {
		t.Fatal("expected unconfigured provider to fail")
	}
	if _, err := client.Chat(context.Background(), nil, nil); err == nil {
		t.Fatal("expected empty conversation to fail")
	}
}
