package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
)

type drafted struct {
	ChangeID, ConfirmText, NeedsPersonReason string
	NeedsPerson                              bool
}

func (m *mcpClient) draft(tool string, args any) drafted {
	m.h.t.Helper()
	text, isErr := m.tool(tool, args)
	var d drafted
	if isErr || json.Unmarshal([]byte(text), &d) != nil || d.ChangeID == "" {
		m.h.t.Fatalf("%s: %s", tool, text)
	}
	return d
}

func (m *mcpClient) apply(d drafted) (string, bool) {
	m.h.t.Helper()
	return m.tool("apply_change", map[string]any{"changeId": d.ChangeID, "confirm": d.ConfirmText})
}

func TestAgentHostCommandsNeedAPerson(t *testing.T) {
	h := newHarness(t)
	h.setup()
	ran := 0
	h.fake.Update(func(f *fakepve.Server) {
		f.HostRun = func(string) (string, int) { ran++; return "root\n", 0 }
	})
	root := h.login("root@pam", "secret")
	ag := agentToken(t, root, "apply")
	hostCmd := map[string]any{"cluster": "pve-lab", "node": "pve1", "command": "id -un", "reason": "t"}
	var e struct{ Code, Error string }

	// default: refused, the draft stays, every route
	d := ag.draft("propose_host_command", hostCmd)
	if !d.NeedsPerson || d.NeedsPersonReason == "" {
		t.Fatalf("agent not told up front: %+v", d)
	}
	if text, isErr := ag.apply(d); !isErr || !strings.Contains(text, "a person must apply") {
		t.Fatalf("apply_change: %v %s", isErr, text)
	}
	if code := ag.rest("POST", "/api/plans/"+d.ChangeID+"/run", map[string]string{"confirm": d.ConfirmText}, &e); code != 403 || e.Code != "needs_person" {
		t.Fatalf("REST run: %d %+v", code, e)
	}
	d2 := ag.draft("propose_action", map[string]any{"cluster": "pve-lab", "action": "host.exec", "params": map[string]any{"node": "pve1", "command": "id", "reason": "t"}})
	if _, isErr := ag.apply(d2); !isErr {
		t.Fatal("propose_action host.exec applied")
	}
	// a draft the person made themselves is not a way in either
	var mine struct{ ID, ConfirmText string }
	root.do("POST", "/api/plans", map[string]any{"action": "host.exec", "clusterId": "pve-lab", "params": map[string]any{"node": "pve1", "command": "id", "reason": "t"}}, &mine)
	if code := ag.rest("POST", "/api/plans/"+mine.ID+"/run", map[string]string{"confirm": mine.ConfirmText}, &e); code != 403 || e.Code != "needs_person" {
		t.Fatalf("agent ran the person's draft: %d %+v", code, e)
	}
	// access changes: same gate
	for _, c := range []map[string]any{
		{"method": "PUT", "path": "/access/acl", "body": map[string]string{"path": "/", "roles": "Administrator", "users": "dev@pve"}},
		{"method": "POST", "path": "/nodes/pve1/execute", "body": map[string]string{"commands": "[]"}},
	} {
		text, isErr := ag.tool("propose_change", map[string]any{"cluster": "pve-lab", "title": "x", "summary": "x", "calls": []any{c}})
		if isErr {
			continue // not in this schema: cannot be drafted at all
		}
		var a drafted
		_ = json.Unmarshal([]byte(text), &a)
		if _, isErr := ag.apply(a); !isErr {
			t.Fatalf("applied %v", c["path"])
		}
	}
	// everything else still applies without a person
	if s := ag.draft("propose_action", map[string]any{"cluster": "pve-lab", "action": "guest.start", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}}); s.NeedsPerson {
		t.Fatalf("guest.start flagged: %+v", s)
	} else if text, isErr := ag.apply(s); isErr {
		t.Fatalf("guest.start refused: %s", text)
	}
	if ran != 0 {
		t.Fatalf("host commands run: %d", ran)
	}
	status := func() string {
		text, isErr := ag.tool("get_change", map[string]any{"changeId": d.ChangeID})
		var r struct{ Status string }
		if i := strings.Index(text, "{"); isErr || i < 0 || json.NewDecoder(strings.NewReader(text[i:])).Decode(&r) != nil {
			t.Fatalf("get_change: %s", text)
		}
		return r.Status
	}
	if status() != "waiting" {
		t.Fatalf("status %q", status())
	}
	// the person applies the same draft
	if code := root.do("POST", "/api/plans/"+d.ChangeID+"/run", map[string]string{"confirm": d.ConfirmText}, nil); code != 202 {
		t.Fatalf("person could not apply the agent's draft: %d", code)
	}
	for i := 0; status() == "running" && i < 100; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if s := status(); s != "ok" {
		t.Fatalf("agent sees %q after the person applied it", s)
	}
	root.do("DELETE", "/api/plans/"+d2.ChangeID, nil, nil)
	d = d2
	if s := status(); s != "gone" {
		t.Fatalf("discarded draft: %q", s)
	}
	if text, _ := agentToken(t, h.login("dev@pve", "devpass"), "read").tool("get_change", map[string]any{"changeId": mine.ID}); strings.Contains(text, "id -un") {
		t.Fatalf("another user's change is visible: %s", text)
	}
}

func TestAgentApprovalSetting(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	ag := agentToken(t, root, "apply")
	get := func() string {
		var p struct{ Approval string }
		root.do("GET", "/api/agent-policy", nil, &p)
		return p.Approval
	}
	if get() != "risky" {
		t.Fatalf("default %q", get())
	}
	set := map[string]string{"approval": "always"}
	// nobody but a galley admin in a browser may loosen it
	if code := ag.rest("PUT", "/api/settings/agents", set, nil); code != 403 {
		t.Fatalf("agent changed the setting: %d", code)
	}
	if text, isErr := ag.tool("propose_action", map[string]any{"cluster": "pve-lab", "action": "galley.agents.update", "params": set}); !isErr {
		t.Fatalf("agent drafted the setting: %s", text)
	}
	if code := h.login("dev@pve", "devpass").do("PUT", "/api/settings/agents", set, nil); code != 403 {
		t.Fatalf("non-admin: %d", code)
	}
	for _, bad := range []any{map[string]string{"approval": "never"}, map[string]string{}, map[string]string{"approval": ""}} {
		if code := root.do("PUT", "/api/settings/agents", bad, nil); code != 400 {
			t.Fatalf("%v: %d", bad, code)
		}
	}
	if get() != "risky" {
		t.Fatalf("changed to %q", get())
	}
	// unreadable values fail closed
	for _, raw := range []string{`{"approval":"Always"}`, `{}`, `garbage`, `{"approval":"always"`} {
		if err := h.st.PutSetting("agents", raw); err != nil {
			t.Fatal(err)
		}
		if get() != "risky" {
			t.Fatalf("%s -> %q", raw, get())
		}
	}
	start := map[string]any{"cluster": "pve-lab", "action": "guest.start", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}}
	host := map[string]any{"cluster": "pve-lab", "node": "pve1", "command": "id", "reason": "t"}

	if code := root.do("PUT", "/api/settings/agents", map[string]string{"approval": "all"}, nil); code != 200 {
		t.Fatalf("all: %d", code)
	}
	if text, isErr := ag.apply(ag.draft("propose_action", start)); !isErr {
		t.Fatalf("all: guest.start applied: %s", text)
	}
	destroy := map[string]any{"cluster": "pve-lab", "action": "guest.destroy", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}}
	for level, want := range map[string]bool{"risky": true, "hosts": false} {
		if code := root.do("PUT", "/api/settings/agents", map[string]string{"approval": level}, nil); code != 200 {
			t.Fatalf("%s: %d", level, code)
		}
		if d := ag.draft("propose_action", destroy); d.NeedsPerson != want {
			t.Fatalf("%s: destroy needs a person = %v", level, d.NeedsPerson)
		}
		if d := ag.draft("propose_host_command", host); !d.NeedsPerson {
			t.Fatalf("%s: host command not flagged", level)
		}
		if d := ag.draft("propose_action", start); d.NeedsPerson {
			t.Fatalf("%s: guest.start flagged", level)
		}
	}
	if code := root.do("PUT", "/api/settings/agents", set, nil); code != 200 {
		t.Fatalf("always: %d", code)
	}
	if d := ag.draft("propose_host_command", host); d.NeedsPerson {
		t.Fatalf("always: still flagged: %+v", d)
	} else if text, isErr := ag.apply(d); isErr {
		t.Fatalf("always: refused: %s", text)
	}
	// ...but never galley's own configuration
	var mine struct{ ID, ConfirmText string }
	root.do("POST", "/api/plans", map[string]any{"action": "galley.agents.update", "clusterId": "pve-lab", "params": map[string]string{"approval": "all"}}, &mine)
	if code := ag.rest("POST", "/api/plans/"+mine.ID+"/run", map[string]string{"confirm": mine.ConfirmText}, nil); code != 403 {
		t.Fatalf("agent applied a galley setting: %d", code)
	}
	if en := root.runAndWait("galley.agents.update", map[string]any{"approval": "all"}, mine.ConfirmText); !en.OK || get() != "all" {
		t.Fatalf("person via Changes: %+v %s", en, get())
	}
}

func (m *mcpClient) rest(method, path string, body, out any) int {
	m.h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, m.h.ts.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+m.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.h.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

// The cap holds on every MCP drafting tool, not only over REST.
func TestAgentDraftCapOverMCP(t *testing.T) {
	h := newHarness(t)
	h.setup()
	ag := agentToken(t, h.login("root@pam", "secret"), "draft")
	host := map[string]any{"cluster": "pve-lab", "node": "pve1", "command": "id", "reason": "t"}
	for range 10 {
		ag.draft("propose_host_command", host)
	}
	if text, isErr := ag.tool("propose_host_command", host); !isErr || !strings.Contains(text, "waiting for a person") {
		t.Fatalf("11th draft: %v %s", isErr, text)
	}
}
