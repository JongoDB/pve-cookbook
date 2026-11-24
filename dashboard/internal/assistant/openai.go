package assistant

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// openAIProvider speaks the OpenAI chat-completions protocol, which OpenAI,
// xAI, OpenRouter, vLLM, Ollama and many others implement.
type openAIProvider struct {
	cfg  Config
	http *http.Client
}

func newOpenAI(cfg Config) *openAIProvider {
	return &openAIProvider{cfg: cfg, http: &http.Client{Timeout: 10 * time.Minute}}
}

type oaMsg map[string]any

type openAIConv struct {
	p       *openAIProvider
	tools   []map[string]any
	history []oaMsg
}

func (p *openAIProvider) NewConversation(system string, tools []ToolSpec) Conversation {
	ts := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		params := map[string]any{"type": "object", "properties": t.Properties}
		if len(t.Required) > 0 {
			params["required"] = t.Required
		}
		ts = append(ts, map[string]any{"type": "function", "function": map[string]any{
			"name": t.Name, "description": t.Description, "parameters": params}})
	}
	return &openAIConv{p: p, tools: ts, history: []oaMsg{{"role": "system", "content": system}}}
}

func (c *openAIConv) AddUser(text string) {
	c.history = append(c.history, oaMsg{"role": "user", "content": text})
}

func (c *openAIConv) AddToolResults(rs []ToolResult) {
	for _, r := range rs {
		content := r.Content
		if r.IsError {
			content = "ERROR: " + content
		}
		c.history = append(c.history, oaMsg{"role": "tool", "tool_call_id": r.ID, "content": content})
	}
}

type oaToolCallDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func (c *openAIConv) Step(ctx context.Context, emit func(Event)) ([]ToolCall, error) {
	body := map[string]any{"model": c.p.cfg.Model, "messages": c.history, "stream": true, "max_tokens": c.p.cfg.MaxTokens}
	if len(c.tools) > 0 {
		body["tools"] = c.tools
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.p.cfg.BaseURL, "/")+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if c.p.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.p.cfg.APIKey)
	}
	resp, err := c.p.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("model provider unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("model provider error (HTTP %d): %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var text strings.Builder
	calls := map[int]*ToolCall{}
	args := map[int]*strings.Builder{}
	finish := ""
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string            `json:"content"`
					ToolCalls []oaToolCallDelta `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil || len(chunk.Choices) == 0 {
			continue
		}
		ch := chunk.Choices[0]
		if ch.Delta.Content != "" {
			text.WriteString(ch.Delta.Content)
			emit(Event{Kind: "text", Text: ch.Delta.Content})
		}
		for _, tc := range ch.Delta.ToolCalls {
			if calls[tc.Index] == nil {
				calls[tc.Index] = &ToolCall{}
				args[tc.Index] = &strings.Builder{}
			}
			if tc.ID != "" {
				calls[tc.Index].ID = tc.ID
			}
			if tc.Function.Name != "" {
				calls[tc.Index].Name = tc.Function.Name
			}
			args[tc.Index].WriteString(tc.Function.Arguments)
		}
		if ch.FinishReason != nil {
			finish = *ch.FinishReason
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	idx := make([]int, 0, len(calls))
	for i := range calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	out := make([]ToolCall, 0, len(idx))
	tcs := make([]map[string]any, 0, len(idx))
	for _, i := range idx {
		tc := calls[i]
		raw := args[i].String()
		if raw == "" {
			raw = "{}"
		}
		if !json.Valid([]byte(raw)) {
			raw = `{"_invalid":true}`
		}
		if tc.ID == "" {
			tc.ID = fmt.Sprintf("call_%d", i)
		}
		tc.Input = json.RawMessage(raw)
		out = append(out, *tc)
		tcs = append(tcs, map[string]any{"id": tc.ID, "type": "function", "function": map[string]any{"name": tc.Name, "arguments": raw}})
	}
	am := oaMsg{"role": "assistant", "content": text.String()}
	if len(tcs) > 0 {
		am["tool_calls"] = tcs
	}
	c.history = append(c.history, am)
	if finish == "length" {
		return nil, errors.New("the response hit the token limit before finishing")
	}
	if finish == "content_filter" {
		return nil, ErrDeclined
	}
	return out, nil
}
