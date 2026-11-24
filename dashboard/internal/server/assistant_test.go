package server_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeModel scripts an OpenAI-compatible model: read a config, propose a change, answer.
func fakeModel(t *testing.T) (*httptest.Server, *atomic.Int32) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-test" {
			http.Error(w, "bad request", 400)
			return
		}
		var body struct {
			Messages []map[string]any `json:"messages"`
			Tools    []any            `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.Tools) != 7 {
			t.Errorf("tools offered: %d", len(body.Tools))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(v any) { b, _ := json.Marshal(v); fmt.Fprintf(w, "data: %s\n\n", b) }
		call := func(id, name string, args any) {
			a, _ := json.Marshal(args)
			chunk(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": id, "function": map[string]any{"name": name, "arguments": string(a)}}}}}}})
			chunk(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{}, "finish_reason": "tool_calls"}}})
		}
		switch n.Add(1) {
		case 1:
			chunk(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "Checking 300. "}}}})
			call("c1", "pve_get", map[string]any{"cluster": "pve-lab", "path": "/cluster/resources"})
		case 2:
			last := body.Messages[len(body.Messages)-1]
			if last["role"] != "tool" || !strings.Contains(fmt.Sprint(last["content"]), "llm-vllm") {
				t.Errorf("tool result not fed back: %v", last)
			}
			call("c2", "propose_change", map[string]any{"cluster": "pve-lab", "title": "Attach the second GPU to llm-vllm",
				"calls": []any{map[string]any{"method": "PUT", "path": "/nodes/pve1/qemu/300/config", "body": map[string]string{"hostpci1": "mapping=gpu-a2-1,pcie=1"}}}})
		default:
			chunk(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "Drafted it in Changes."}, "finish_reason": "stop"}}})
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func (c *client) chat(msg string) map[string][]json.RawMessage {
	c.h.t.Helper()
	b, _ := json.Marshal(map[string]any{"message": msg})
	req, _ := http.NewRequest("POST", c.h.ts.URL+"/api/assistant/chat", strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Galley-CSRF", c.csrf)
	resp, err := c.hc.Do(req)
	if err != nil {
		c.h.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		c.h.t.Fatalf("chat: %d", resp.StatusCode)
	}
	events := map[string][]json.RawMessage{}
	sc := bufio.NewScanner(resp.Body)
	name := ""
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "event: ") {
			name = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			events[name] = append(events[name], json.RawMessage(strings.TrimPrefix(line, "data: ")))
		}
	}
	return events
}

func TestAssistantProposesButNeverApplies(t *testing.T) {
	h := newHarness(t)
	h.setup()
	model, calls := fakeModel(t)
	root := h.login("root@pam", "secret")
	dev := h.login("dev@pve", "devpass")
	cfg := map[string]any{"enabled": true, "provider": "openai", "baseUrl": model.URL + "/v1", "model": "local-test", "apiKey": "sk-test"}
	if code := dev.do("PUT", "/api/settings/assistant", cfg, nil); code != 403 {
		t.Fatalf("non-admin changed assistant settings: %d", code)
	}
	if code := root.do("PUT", "/api/settings/assistant", cfg, nil); code != 204 {
		t.Fatalf("settings: %d", code)
	}
	var got struct {
		Config    map[string]any
		HasAPIKey bool
	}
	root.do("GET", "/api/settings/assistant", nil, &got)
	if !got.HasAPIKey || got.Config["apiKey"] != nil && got.Config["apiKey"] != "" {
		t.Fatalf("api key exposed or lost: %+v", got)
	}
	before := len(h.fake.Recorded())
	ev := root.chat("Give llm-vllm the second GPU")
	if len(ev["error"]) > 0 {
		t.Fatalf("assistant error: %s", ev["error"][0])
	}
	if len(ev["change"]) != 1 || len(ev["done"]) != 1 || calls.Load() != 3 {
		t.Fatalf("events: change=%d done=%d model calls=%d", len(ev["change"]), len(ev["done"]), calls.Load())
	}
	var p struct {
		ID    string
		Steps []struct{ CLI string }
	}
	_ = json.Unmarshal(ev["change"][0], &p)
	if p.Steps[0].CLI != "pvesh set /nodes/pve1/qemu/300/config --hostpci1 mapping=gpu-a2-1,pcie=1" {
		t.Fatalf("drafted change: %+v", p)
	}
	if len(h.fake.Recorded()) != before {
		t.Fatal("the assistant changed the cluster")
	}
	// the drafted change is the user's, and applying it is a separate, explicit step
	e := root.runPlanID(p.ID)
	if !e.OK {
		t.Fatalf("apply drafted change: %+v", e)
	}
}
