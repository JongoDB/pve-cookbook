package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"

	"github.com/JongoDB/pve-cookbook/dashboard/docs"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/assistant"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

// One tool registry serves the in-app assistant and external agents (MCP).
// Every tool runs as the session's user; galley and PVE filter by that user's
// permissions. What a caller may use depends on who it is:
//
//	assistant (browser user): read + docs + draft
//	agent token, scope read:  read + docs
//	agent token, scope draft: read + docs + draft
//	agent token, scope apply: read + docs + draft + apply
var toolTier = map[string]string{
	"list_resources": "read", "get_findings": "read", "list_tasks": "read", "pve_get": "read", "get_metrics": "read",
	"api_schema": "read", "search_docs": "read", "read_doc": "read", "list_changes": "read", "get_change": "read",
	"propose_change": "draft", "propose_host_command": "draft", "propose_action": "draft",
	"apply_change": "apply",
}

func (s *Server) toolsFor(ss *session) []assistant.ToolSpec {
	var out []assistant.ToolSpec
	for _, t := range append(s.assistantTools(), s.extraToolSpecs()...) {
		tier := toolTier[t.Name]
		switch {
		case !ss.agent && tier == "apply":
			continue // the in-app assistant never applies; the user does
		case ss.agent && !scopeAtLeast(ss, tier):
			continue
		}
		out = append(out, t)
	}
	return out
}

func toolAllowed(ss *session, name string) bool {
	tier, ok := toolTier[name]
	if !ok {
		return false
	}
	if !ss.agent {
		return tier != "apply"
	}
	return scopeAtLeast(ss, tier)
}

// draftCtx makes every change built with the returned context an AI draft
// (labelled, typed confirmation) before it becomes visible.
func draftCtx(ctx context.Context, ss *session) context.Context {
	if ss.agent {
		return plan.WithDraft(ctx, "agent:"+ss.agentName, "Agent draft ("+ss.agentName+")")
	}
	return plan.WithDraft(ctx, "assistant", "Assistant draft")
}

// planOwner scopes pending changes to one identity: the same user name on
// clusters with different realms of trust is a different person.
func planOwner(ss *session) string { return ss.home + "|" + ss.user }

var changeIDRe = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

func (s *Server) extraToolSpecs() []assistant.ToolSpec {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	actions := append([]string{"guest.start", "guest.shutdown", "guest.reboot", "guest.stop", "guest.migrate", "guest.snapshot",
		"guest.destroy", "backup.protect", "host.exec", "api.call"}, GalleyActionNames()...)
	return []assistant.ToolSpec{
		{Name: "search_docs", Description: "Search galley's user guide (how to use and navigate galley: pages, buttons, workflows, permissions, troubleshooting). Use it whenever the user asks how to do something in galley.",
			Properties: map[string]any{"query": str("what to look for")}, Required: []string{"query"}},
		{Name: "read_doc", Description: "Read one page of galley's user guide by slug (see the docs index in your instructions or search_docs results).",
			Properties: map[string]any{"slug": str("page slug, e.g. changes")}, Required: []string{"slug"}},
		{Name: "list_changes", Description: "The user's pending changes (drafted, not yet applied) with their steps and commands.", Properties: map[string]any{}},
		{Name: "get_change", Description: "Status of a change, by auditId (an applied change) or changeId (a draft): waiting, running, ok, error or unknown, per step, with output.",
			Properties: map[string]any{"auditId": map[string]any{"type": "integer"}, "changeId": str("the draft's change id")}},
		{Name: "propose_action", Description: "Draft any action galley offers, for review in Changes. Actions and params:\n" +
			"- guest.start | guest.shutdown | guest.reboot | guest.stop: {\"targets\":[{\"vmid\":120}]}\n" +
			"- guest.migrate: {\"targets\":[{\"vmid\":120}],\"target\":\"pve2\",\"online\":true}\n" +
			"- guest.snapshot: {\"targets\":[{\"vmid\":120}],\"name\":\"pre-upgrade\",\"description\":\"…\"}\n" +
			"- guest.destroy: {\"targets\":[{\"vmid\":120}]}\n" +
			"- backup.protect: {\"vmids\":[131],\"job\":\"nightly-all\"}\n" +
			"- host.exec: {\"node\":\"pve1\",\"command\":\"…\",\"reason\":\"…\"} (administrators)\n" +
			"- api.call: {\"title\":\"…\",\"calls\":[{\"method\":\"PUT\",\"path\":\"/nodes/pve1/qemu/120/config\",\"body\":{\"cores\":\"4\"}}]} (any PVE create/update/delete; check api_schema first)\n" +
			"- galley.cluster.update: {\"name\"?,\"shareLogin\"?,\"credentialMode\"?: ticket|token,\"hostTransport\"?: pve|ssh}\n" +
			"- galley.cluster.remove: {} · galley.host.pin: {\"node\",\"fingerprint\"} · galley.host.unpin: {\"node\"} · galley.prefs.set: {\"key\":\"dashboard\",\"value\":\"<JSON>\"}\n" +
			"- galley.agents.update: {\"approval\": all|risky|hosts|always} (what apply-scope agent tokens need a person for: every change, everything but routine guest work, host commands and access changes, or nothing; galley admins)",
			Properties: map[string]any{"cluster": str("cluster id"), "action": map[string]any{"type": "string", "enum": actions},
				"params": map[string]any{"type": "object", "description": "action parameters (see description)"}},
			Required: []string{"cluster", "action", "params"}},
		{Name: "apply_change", Description: "Apply a pending change (agent tokens with scope apply only). Changes drafted with needsPerson are refused: a person applies them in Changes. Pass confirm = the change's confirmText when it has one. Returns an auditId; poll get_change until it is no longer running.",
			Properties: map[string]any{"changeId": str("change id"), "confirm": str("the change's confirmText, if any")}, Required: []string{"changeId"}},
	}
}

// internal calls a galley API handler as ss, so tools get exactly the checks
// the UI gets.
func (s *Server) internal(ctx context.Context, ss *session, h handler, method, path string, body any, pathVals map[string]string) (int, []byte) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	r := httptest.NewRequestWithContext(ctx, method, path, rd)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range pathVals {
		r.SetPathValue(k, v)
	}
	w := httptest.NewRecorder()
	h(w, r, ss)
	return w.Code, w.Body.Bytes()
}

func errFromBody(code int, b []byte) error {
	var e struct{ Error string }
	_ = json.Unmarshal(b, &e)
	if e.Error == "" {
		e.Error = http.StatusText(code)
	}
	return errors.New(e.Error)
}

func (s *Server) runExtraTool(ctx context.Context, ss *session, call assistant.ToolCall, onChange func(*plan.Plan)) (string, bool, bool) {
	fail := func(err error) (string, bool, bool) { return err.Error(), true, true }
	out := func(v any) (string, bool, bool) {
		b, _ := json.Marshal(v)
		return truncate(b, 60000), false, true
	}
	switch call.Name {
	case "search_docs":
		var in struct{ Query string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		hits := docs.Search(in.Query, 6)
		if len(hits) == 0 {
			return out(map[string]any{"hits": []any{}, "note": "nothing found; try other words or read_doc getting-started"})
		}
		return out(map[string]any{"hits": hits})
	case "read_doc":
		var in struct{ Slug string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		p, ok := docs.Get(strings.TrimSuffix(in.Slug, ".md"))
		if !ok {
			return fail(fmt.Errorf("no page %q; use search_docs", in.Slug))
		}
		return out(p)
	case "list_changes":
		return out(s.plans.List(planOwner(ss)))
	case "get_change":
		var in struct {
			AuditID  int64
			ChangeID string
		}
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if in.ChangeID != "" {
			if p, err := s.plans.Peek(in.ChangeID, planOwner(ss)); err == nil {
				return out(map[string]any{"status": "waiting", "changeId": p.ID, "title": p.Title, "expiresAt": p.ExpiresAt,
					"note": "not applied yet; it is in the Changes tab"})
			}
			id, ok := s.changeAudit(in.ChangeID, planOwner(ss))
			if !ok {
				return out(map[string]any{"status": "gone", "changeId": in.ChangeID, "note": "not waiting and not applied: discarded, expired, or galley restarted since. Check the audit log before drafting it again"})
			}
			in.AuditID = id
		}
		e, err := s.store.AuditEntry(in.AuditID)
		if err != nil || !s.auditVisible(ctx, ss, e, s.userViews(ctx, ss)) {
			return fail(errors.New("no such change in your audit log"))
		}
		return out(e)
	case "propose_action":
		var in struct {
			Cluster string
			Action  string
			Params  json.RawMessage
		}
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if len(in.Params) == 0 {
			in.Params = json.RawMessage("{}")
		}
		code, b := s.internal(draftCtx(ctx, ss), ss, s.createPlan, http.MethodPost, "/api/plans",
			map[string]any{"action": in.Action, "clusterId": in.Cluster, "params": in.Params}, nil)
		if code != http.StatusCreated {
			return fail(errFromBody(code, b))
		}
		var created struct{ ID string }
		_ = json.Unmarshal(b, &created)
		p, err := s.plans.Peek(created.ID, planOwner(ss))
		if err != nil {
			return fail(err)
		}
		onChange(p)
		return out(s.draftNote(ss, p, map[string]any{"status": "drafted; the user reviews and applies it in the Changes tab", "changeId": p.ID,
			"title": p.Title, "destructive": p.Destructive, "confirmText": p.ConfirmText, "commands": p.CLI()}))
	case "apply_change":
		if !ss.agent || !scopeAtLeast(ss, "apply") {
			return fail(errors.New("only agent tokens with scope apply can apply changes; the user applies changes in the Changes tab"))
		}
		var in struct{ ChangeID, Confirm string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if !changeIDRe.MatchString(in.ChangeID) {
			return fail(errors.New("unknown change id; use list_changes"))
		}
		code, b := s.internal(ctx, ss, s.runPlan, http.MethodPost, "/api/plans/"+in.ChangeID+"/run",
			map[string]string{"confirm": in.Confirm}, map[string]string{"id": in.ChangeID})
		if code != http.StatusAccepted {
			return fail(errFromBody(code, b))
		}
		var res struct{ AuditID int64 }
		_ = json.Unmarshal(b, &res)
		return out(map[string]any{"status": "running", "auditId": res.AuditID, "next": "poll get_change with this auditId"})
	}
	return "", false, false
}

// ---- REST: docs and pending changes ----

func (s *Server) docsIndex(w http.ResponseWriter, _ *http.Request, _ *session) {
	writeJSON(w, 200, docs.Index())
}

func (s *Server) docsPage(w http.ResponseWriter, r *http.Request, _ *session) {
	p, ok := docs.Get(r.PathValue("slug"))
	if !ok {
		apiError(w, 404, "not_found", "no such help page")
		return
	}
	writeJSON(w, 200, p)
}

// GET /api/plans → the user's pending changes (including drafts by the
// assistant or agents), newest first.
func (s *Server) listPlans(w http.ResponseWriter, _ *http.Request, ss *session) {
	ps := s.plans.List(planOwner(ss))
	if ps == nil {
		ps = []*plan.Plan{}
	}
	writeJSON(w, 200, ps)
}

// docsIndexPrompt is the user-guide index for the system prompt.
func docsIndexPrompt() string {
	var b strings.Builder
	b.WriteString("\n\ngalley user guide (use search_docs / read_doc for details; link pages as /help/<slug>):\n")
	ix := docs.Index()
	sort.SliceStable(ix, func(i, j int) bool { return ix[i].Order < ix[j].Order })
	for _, p := range ix {
		b.WriteString("- " + p.Slug + ": " + p.Title)
		if p.Summary != "" {
			b.WriteString(" — " + p.Summary)
		}
		if p.Route != "" {
			b.WriteString(" (page " + p.Route + ")")
		}
		b.WriteString("\n")
	}
	return b.String()
}
