// Package assistant runs the in-galley assistant's conversation loop against
// a configurable model provider: the Anthropic API (Claude) or any
// OpenAI-compatible chat-completions endpoint (OpenAI, xAI, OpenRouter, or a
// local vLLM/Ollama server). Tools are supplied by the caller; this package
// only talks to the model.
package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Config selects and configures a provider. Stored (encrypted) by galley.
type Config struct {
	Enabled  bool   `json:"enabled"`
	Provider string `json:"provider"` // "anthropic" | "openai"
	BaseURL  string `json:"baseUrl,omitempty"`
	Model    string `json:"model"`
	APIKey   string `json:"apiKey,omitempty"`
	// Effort for Claude models (low|medium|high|xhigh|max).
	Effort string `json:"effort,omitempty"`
	// Fallback enables Anthropic's server-side refusal fallback.
	Fallback bool `json:"fallback"`
	// MaxTokens per model response.
	MaxTokens int `json:"maxTokens,omitempty"`
}

// DefaultConfig is used until an admin configures the assistant.
func DefaultConfig() Config {
	return Config{Provider: "anthropic", Model: "claude-opus-5-5", Effort: "medium", Fallback: true, MaxTokens: 16000}
}

// Validate checks a configuration before it is saved.
func (c Config) Validate() error {
	switch c.Provider {
	case "anthropic":
		if c.BaseURL != "" && !strings.HasPrefix(c.BaseURL, "https://") &&
			!strings.HasPrefix(c.BaseURL, "http://127.0.0.1") && !strings.HasPrefix(c.BaseURL, "http://localhost") {
			return errors.New("baseUrl for Anthropic must use https://")
		}
	case "openai":
		if c.BaseURL == "" {
			return errors.New("baseUrl is required for OpenAI-compatible providers (e.g. https://api.openai.com/v1 or http://gpu-host:8000/v1)")
		}
		if !strings.HasPrefix(c.BaseURL, "https://") && !strings.HasPrefix(c.BaseURL, "http://") {
			return errors.New("baseUrl must start with https:// or http://")
		}
	default:
		return errors.New(`provider must be "anthropic" or "openai"`)
	}
	if c.Model == "" {
		return errors.New("model is required")
	}
	switch c.Effort {
	case "", "low", "medium", "high", "xhigh", "max":
	default:
		return errors.New("effort must be low, medium, high, xhigh or max")
	}
	if c.MaxTokens < 0 || c.MaxTokens > 128000 {
		return errors.New("maxTokens must be between 0 and 128000")
	}
	return nil
}

// ToolSpec describes a tool to the model. Schema is a JSON-schema object with
// "properties" and optional "required".
type ToolSpec struct {
	Name        string
	Description string
	Properties  map[string]any
	Required    []string
}

// ToolCall is the model asking to run a tool.
type ToolCall struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// ToolResult answers a ToolCall.
type ToolResult struct {
	ID      string
	Content string
	IsError bool
}

// Event is streamed to the user while the model works.
type Event struct {
	Kind string // "text"
	Text string
}

// Conversation is one chat's history in the provider's native format
// (append-only, so Claude's thinking blocks stay valid across turns).
type Conversation interface {
	AddUser(text string)
	// Step asks the model for its next message, streaming text through emit.
	// It returns the tool calls the model wants; none means the turn is done.
	Step(ctx context.Context, emit func(Event)) ([]ToolCall, error)
	AddToolResults(rs []ToolResult)
}

// Provider creates conversations.
type Provider interface {
	NewConversation(system string, tools []ToolSpec) Conversation
}

// New returns a provider for cfg.
func New(cfg Config) (Provider, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.MaxTokens == 0 {
		cfg.MaxTokens = 16000
	}
	switch cfg.Provider {
	case "anthropic":
		if cfg.APIKey == "" {
			return nil, errors.New("an Anthropic API key is required")
		}
		return newAnthropic(cfg), nil
	case "openai":
		return newOpenAI(cfg), nil
	}
	return nil, fmt.Errorf("unknown provider %q", cfg.Provider)
}

// ErrDeclined is returned when the model declines a request.
var ErrDeclined = errors.New("the model declined this request")
