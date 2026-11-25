package plan

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestAgentDraftsWaitForAPerson(t *testing.T) {
	m := &Manager{plans: map[string]*Plan{}}
	mk := func(ctx context.Context) (*Plan, error) {
		p := &Plan{Title: "t", Steps: []Step{{}}}
		return p, m.Register(ctx, "u", p)
	}
	ctx := context.Background()
	for i := range 6 { // more agents than fit in one user's limit
		a := WithDraft(ctx, fmt.Sprintf("agent:%d", i), "Agent draft")
		for j := range MaxPendingPerAgent {
			p, err := mk(a)
			if i == 5 {
				if !errors.Is(err, ErrTooMany) {
					t.Fatalf("agents over the total limit: %v", err)
				}
				break
			}
			if err != nil || p.ExpiresAt-p.CreatedAt != int64(AgentTTL.Seconds()) {
				t.Fatalf("agent %d draft %d: %v", i, j, err)
			}
		}
		if _, err := mk(a); i < 5 && !errors.Is(err, ErrAgentTooMany) {
			t.Fatalf("agent %d over its limit: %v", i, err)
		}
	}
	for i := range MaxPendingPerUser {
		p, err := mk(ctx)
		if err != nil || p.ExpiresAt-p.CreatedAt != int64(TTL.Seconds()) {
			t.Fatalf("the person is blocked by agents at %d: %v", i, err)
		}
	}
	if _, err := mk(ctx); !errors.Is(err, ErrTooMany) {
		t.Fatalf("person over the limit: %v", err)
	}
}
