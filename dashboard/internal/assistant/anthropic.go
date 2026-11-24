package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

type anthropicProvider struct {
	client anthropic.Client
	cfg    Config
}

func newAnthropic(cfg Config) *anthropicProvider {
	opts := []option.RequestOption{option.WithAPIKey(cfg.APIKey)}
	if cfg.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	return &anthropicProvider{client: anthropic.NewClient(opts...), cfg: cfg}
}

type anthropicConv struct {
	p       *anthropicProvider
	system  string
	tools   []anthropic.BetaToolUnionParam
	history []anthropic.BetaMessageParam
}

func (p *anthropicProvider) NewConversation(system string, tools []ToolSpec) Conversation {
	ts := make([]anthropic.BetaToolUnionParam, 0, len(tools))
	for _, t := range tools {
		tp := anthropic.BetaToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.BetaToolInputSchemaParam{Properties: t.Properties, Required: t.Required},
			// Streamed requests with client tools: stream inputs as generated;
			// the caller validates every input before running a tool.
			EagerInputStreaming: anthropic.Bool(true),
		}
		ts = append(ts, anthropic.BetaToolUnionParam{OfTool: &tp})
	}
	return &anthropicConv{p: p, system: system, tools: ts}
}

func (c *anthropicConv) AddUser(text string) {
	c.history = append(c.history, anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(text)))
}

func (c *anthropicConv) AddToolResults(rs []ToolResult) {
	blocks := make([]anthropic.BetaContentBlockParamUnion, 0, len(rs))
	for _, r := range rs {
		blocks = append(blocks, anthropic.NewBetaToolResultBlock(r.ID, r.Content, r.IsError))
	}
	// all results of one assistant turn go back in a single user message
	c.history = append(c.history, anthropic.NewBetaUserMessage(blocks...))
}

func (c *anthropicConv) Step(ctx context.Context, emit func(Event)) ([]ToolCall, error) {
	params := anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(c.p.cfg.Model),
		MaxTokens: int64(c.p.cfg.MaxTokens),
		// The system prompt and tools never change within galley, so they are a
		// stable, cacheable prefix.
		System:   []anthropic.BetaTextBlockParam{{Text: c.system, CacheControl: anthropic.NewBetaCacheControlEphemeralParam()}},
		Tools:    c.tools,
		Messages: c.history,
	}
	if c.p.cfg.Effort != "" {
		params.OutputConfig = anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffort(c.p.cfg.Effort)}
	}
	if c.p.cfg.Fallback {
		params.Betas = append(params.Betas, anthropic.AnthropicBetaServerSideFallback2026_07_01)
		params.Fallbacks = anthropic.BetaFallbacksParamOfDefault()
	}
	stream := c.p.client.Beta.Messages.NewStreaming(ctx, params)
	msg := anthropic.BetaMessage{}
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return nil, err
		}
		if d, ok := ev.AsAny().(anthropic.BetaRawContentBlockDeltaEvent); ok {
			if t, ok := d.Delta.AsAny().(anthropic.BetaTextDelta); ok && t.Text != "" {
				emit(Event{Kind: "text", Text: t.Text})
			}
		}
	}
	if err := stream.Err(); err != nil {
		var ae *anthropic.Error
		if errors.As(err, &ae) {
			return nil, fmt.Errorf("model provider error (HTTP %d)", ae.StatusCode)
		}
		return nil, fmt.Errorf("model provider unreachable: %w", err)
	}
	switch msg.StopReason {
	case anthropic.BetaStopReasonRefusal:
		// Not kept: the conversation stays valid for the next question.
		return nil, ErrDeclined
	case anthropic.BetaStopReasonMaxTokens:
		return nil, errors.New("the response hit the token limit before finishing")
	}
	// Keep the response unchanged in history (thinking blocks included).
	c.history = append(c.history, msg.ToParam())
	var calls []ToolCall
	for _, b := range msg.Content {
		if tu, ok := b.AsAny().(anthropic.BetaToolUseBlock); ok {
			raw := json.RawMessage(tu.JSON.Input.Raw())
			if !json.Valid(raw) {
				raw = json.RawMessage(`{"_invalid":true}`)
			}
			calls = append(calls, ToolCall{ID: tu.ID, Name: tu.Name, Input: raw})
		}
	}
	// Every tool_use in history must get a result, so return any calls present.
	return calls, nil
}
