package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicRequestShapeAndToolLoop(t *testing.T) {
	var reqs []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		reqs = append(reqs, body)
		if !strings.Contains(r.Header.Get("anthropic-beta"), "server-side-fallback-2026-07-01") {
			t.Errorf("fallback beta header missing: %q", r.Header.Get("anthropic-beta"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		ev := func(name string, v any) { b, _ := json.Marshal(v); fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b) }
		ev("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": []any{}, "stop_reason": nil, "usage": map[string]any{"input_tokens": 10, "output_tokens": 0}}})
		if len(reqs) == 1 {
			ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "Looking. "}})
			ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
			ev("content_block_start", map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "tool_use", "id": "toolu_1", "name": "get_findings", "input": map[string]any{}}})
			ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": "{}"}})
			ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 1})
			ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]any{"output_tokens": 5}})
		} else {
			ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "All clear."}})
			ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
			ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"output_tokens": 3}})
		}
		ev("message_stop", map[string]any{"type": "message_stop"})
	}))
	defer srv.Close()
	p, err := New(Config{Enabled: true, Provider: "anthropic", BaseURL: srv.URL, Model: "claude-opus-5-5", APIKey: "sk-ant-test", Effort: "medium", Fallback: true})
	if err != nil {
		t.Fatal(err)
	}
	c := p.NewConversation("sys", []ToolSpec{{Name: "get_findings", Description: "d", Properties: map[string]any{}}})
	c.AddUser("anything wrong?")
	var text strings.Builder
	calls, err := c.Step(context.Background(), func(e Event) { text.WriteString(e.Text) })
	if err != nil || len(calls) != 1 || calls[0].Name != "get_findings" || string(calls[0].Input) != "{}" {
		t.Fatalf("step 1: %v %+v", err, calls)
	}
	c.AddToolResults([]ToolResult{{ID: calls[0].ID, Content: "[]"}})
	calls, err = c.Step(context.Background(), func(e Event) { text.WriteString(e.Text) })
	if err != nil || len(calls) != 0 || text.String() != "Looking. All clear." {
		t.Fatalf("step 2: %v %+v %q", err, calls, text.String())
	}
	r0 := reqs[0]
	if r0["model"] != "claude-opus-5-5" || r0["fallbacks"] != "default" || r0["stream"] != true {
		t.Fatalf("request: model=%v fallbacks=%v stream=%v", r0["model"], r0["fallbacks"], r0["stream"])
	}
	if oc, _ := r0["output_config"].(map[string]any); oc["effort"] != "medium" {
		t.Fatalf("effort: %v", r0["output_config"])
	}
	sys := r0["system"].([]any)[0].(map[string]any)
	if sys["cache_control"] == nil {
		t.Fatal("system prompt not cached")
	}
	tool := r0["tools"].([]any)[0].(map[string]any)
	if tool["eager_input_streaming"] != true {
		t.Fatalf("tool: %v", tool)
	}
	// second request carries the assistant turn and the tool result
	msgs := reqs[1]["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("history: %d", len(msgs))
	}
}
