package assistant

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A reasoning model that only thinks must not become a blank answer.
func TestOpenAIEmptyAnswerIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
	}))
	defer srv.Close()
	c := newOpenAI(Config{BaseURL: srv.URL, Model: "m", MaxTokens: 10}).NewConversation("s", nil)
	c.AddUser("hi")
	if _, err := c.Step(context.Background(), func(Event) {}); err == nil || !strings.Contains(err.Error(), "empty answer") {
		t.Fatalf("got %v", err)
	}
}
