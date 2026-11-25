package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type mcpClient struct {
	h     *harness
	token string
	n     int
}

func (m *mcpClient) call(method string, params any) (map[string]any, map[string]any) {
	m.h.t.Helper()
	m.n++
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.n, "method": method, "params": params})
	req, _ := http.NewRequest("POST", m.h.ts.URL+"/mcp", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+m.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Result map[string]any
		Error  map[string]any
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		m.h.t.Fatalf("mcp %s: %d %s", method, resp.StatusCode, raw)
	}
	return out.Result, out.Error
}

func (m *mcpClient) tool(name string, args any) (string, bool) {
	m.h.t.Helper()
	res, e := m.call("tools/call", map[string]any{"name": name, "arguments": args})
	if e != nil {
		m.h.t.Fatalf("tools/call %s: %v", name, e)
	}
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	return text, res["isError"] == true
}

func (m *mcpClient) toolNames() []string {
	res, _ := m.call("tools/list", map[string]any{})
	var names []string
	for _, t := range res["tools"].([]any) {
		names = append(names, t.(map[string]any)["name"].(string))
	}
	return names
}

func agentToken(t *testing.T, c *client, scope string) *mcpClient {
	t.Helper()
	var tok struct {
		Token    string
		Clusters []string
	}
	if code := c.do("POST", "/api/agent-tokens", map[string]any{"name": "ci-" + scope, "scope": scope, "days": 7}, &tok); code != 201 || !strings.HasPrefix(tok.Token, "glly_") {
		t.Fatalf("create agent token: %d %+v", code, tok)
	}
	return &mcpClient{h: c.h, token: tok.Token}
}

func TestMCPAgentScopes(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")

	reader := agentToken(t, root, "read")
	res, _ := reader.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test"}})
	if res["protocolVersion"] != "2025-06-18" || res["serverInfo"].(map[string]any)["name"] != "galley" {
		t.Fatalf("initialize: %v", res)
	}
	names := strings.Join(reader.toolNames(), ",")
	if !strings.Contains(names, "list_resources") || !strings.Contains(names, "search_docs") || strings.Contains(names, "propose_") || strings.Contains(names, "apply_change") {
		t.Fatalf("read scope tools: %s", names)
	}
	if text, isErr := reader.tool("list_resources", map[string]any{"kind": "guests"}); isErr || !strings.Contains(text, "llm-vllm") {
		t.Fatalf("read tool: %s", text)
	}
	if _, isErr := reader.tool("propose_action", map[string]any{"cluster": "pve-lab", "action": "guest.start", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}}); !isErr {
		t.Fatal("read token drafted a change")
	}
	// agent tokens never reach galley administration
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/settings/assistant", nil)
	req.Header.Set("Authorization", "Bearer "+reader.token)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 403 {
		t.Fatalf("agent reached settings: %d", resp.StatusCode)
	}

	drafter := agentToken(t, root, "draft")
	text, isErr := drafter.tool("propose_action", map[string]any{"cluster": "pve-lab", "action": "guest.start", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}})
	if isErr || !strings.Contains(text, "Agent draft (ci-draft)") {
		t.Fatalf("draft: %s", text)
	}
	var d struct{ ChangeID, ConfirmText string }
	_ = json.Unmarshal([]byte(text), &d)
	if _, isErr := drafter.tool("apply_change", map[string]any{"changeId": d.ChangeID, "confirm": d.ConfirmText}); !isErr {
		t.Fatal("draft token applied a change")
	}
	// the human sees the agent's draft among pending changes
	var pending []struct{ ID, Source string }
	root.do("GET", "/api/plans", nil, &pending)
	if len(pending) == 0 || pending[0].Source != "agent:ci-draft" {
		t.Fatalf("pending: %+v", pending)
	}

	applier := agentToken(t, root, "apply")
	text, _ = applier.tool("propose_action", map[string]any{"cluster": "pve-lab", "action": "guest.start", "params": map[string]any{"targets": []any{map[string]any{"vmid": 300}}}})
	_ = json.Unmarshal([]byte(text), &d)
	if _, isErr := applier.tool("apply_change", map[string]any{"changeId": d.ChangeID}); !isErr {
		t.Fatal("applied without typed confirmation")
	}
	text, isErr = applier.tool("apply_change", map[string]any{"changeId": d.ChangeID, "confirm": d.ConfirmText})
	if isErr || !strings.Contains(text, "auditId") {
		t.Fatalf("apply: %s", text)
	}
	// the change runs asynchronously: wait for the start call
	var started bool
	for i := 0; i < 200 && !started; i++ {
		for _, c := range h.fake.Recorded() {
			if strings.HasSuffix(c.Path, "/qemu/300/status/start") {
				if !strings.Contains(c.Token, "!galley-agent-") {
					t.Fatalf("ran as: %+v", c)
				}
				started = true
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !started {
		t.Fatal("the agent's change never started the guest")
	}

	// docs are resources
	res, _ = applier.call("resources/list", map[string]any{})
	if res["resources"] == nil {
		t.Fatalf("resources: %v", res)
	}
}

func TestAgentTokenRevocation(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	a := agentToken(t, root, "read")
	var list []struct {
		ID, Name string
		LastSeen int64
	}
	root.do("GET", "/api/agent-tokens", nil, &list)
	if len(list) != 1 {
		t.Fatalf("list: %+v", list)
	}
	if list[0].LastSeen != 0 { // the UI says "Never" until an agent uses it
		t.Fatalf("a new token reports a use: %+v", list[0])
	}
	a.call("ping", map[string]any{})
	root.do("GET", "/api/agent-tokens", nil, &list)
	if list[0].LastSeen == 0 {
		t.Fatalf("use not recorded: %+v", list[0])
	}
	if code := root.do("DELETE", "/api/agent-tokens/"+list[0].ID, nil, nil); code != 204 {
		t.Fatalf("revoke: %d", code)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.token)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 401 {
		t.Fatalf("revoked token still works: %d", resp.StatusCode)
	}
}

func TestGalleyActionsGoThroughChanges(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	e := root.runAndWait("galley.cluster.update", map[string]any{"name": "lab-renamed"}, "")
	if !e.OK {
		t.Fatalf("galley action: %+v", e)
	}
	var cs []map[string]any
	root.do("GET", "/api/clusters", nil, &cs)
	if cs[0]["name"] != "lab-renamed" {
		t.Fatalf("rename not applied: %v", cs)
	}
	dev := h.login("dev@pve", "devpass")
	var p struct{ ID string }
	dev.do("POST", "/api/plans", map[string]any{"action": "galley.cluster.update", "clusterId": "pve-lab", "params": map[string]any{"name": "pwned"}}, &p)
	e = dev.runPlanID(p.ID, "")
	if e.OK {
		t.Fatal("non-admin applied a galley setting")
	}
}

// Review H1/M1/M2/M4: agents never reach galley administration through a
// change, REST drafts are labelled, the audit names the agent, bad ids fail.
func TestAgentBoundaries(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	ap := agentToken(t, root, "apply")
	if text, isErr := ap.tool("propose_action", map[string]any{"cluster": "pve-lab", "action": "galley.cluster.update", "params": map[string]any{"name": "agent-was-here"}}); !isErr {
		t.Fatalf("agent drafted a galley setting: %s", text)
	}
	// a human-drafted galley change cannot be applied by an agent either
	var p struct{ ID, ConfirmText string }
	root.do("POST", "/api/plans", map[string]any{"action": "galley.cluster.update", "clusterId": "pve-lab", "params": map[string]any{"name": "x"}}, &p)
	if text, isErr := ap.tool("apply_change", map[string]any{"changeId": p.ID}); !isErr {
		t.Fatalf("agent applied a galley setting: %s", text)
	}
	if _, isErr := ap.tool("apply_change", map[string]any{"changeId": "a b"}); !isErr {
		t.Fatal("malformed id accepted")
	}
	// REST draft by an agent is labelled and needs typed confirmation
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/plans", strings.NewReader(`{"action":"guest.start","clusterId":"pve-lab","params":{"targets":[{"vmid":300}]}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+ap.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var d struct{ ID, Source, ConfirmText string }
	_ = json.NewDecoder(resp.Body).Decode(&d)
	resp.Body.Close()
	if d.Source != "agent:ci-apply" || d.ConfirmText == "" {
		t.Fatalf("REST agent draft not labelled: %+v", d)
	}
	text, isErr := ap.tool("apply_change", map[string]any{"changeId": d.ID, "confirm": d.ConfirmText})
	if isErr {
		t.Fatal(text)
	}
	var res struct{ AuditID int64 }
	_ = json.Unmarshal([]byte(text), &res)
	var entries []struct {
		ID  int64
		Via string
	}
	root.do("GET", "/api/audit", nil, &entries)
	found := false
	for _, e := range entries {
		if e.ID == res.AuditID && e.Via == "agent:ci-apply" {
			found = true
		}
	}
	if !found {
		t.Fatalf("audit does not name the agent: %+v", entries)
	}
}

// Found live: an agent created a VM and immediately drafted its destroy;
// galley's cache had not seen the VM yet ("guest not found"). Guests missing
// from the cache are looked up live, as the user.
func TestActOnGuestBeforeCacheSeesIt(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	root.do("GET", "/api/guests", nil, nil) // warm the cache and the user's view
	h.fake.AddGuest(map[string]any{"vmid": 99020, "name": "just-created", "type": "qemu", "node": "pve1", "status": "stopped"})
	var p struct {
		ID    string
		Title string
		Steps []struct{ Path string }
	}
	code := root.do("POST", "/api/plans", map[string]any{"action": "guest.destroy", "clusterId": "pve-lab", "params": map[string]any{"targets": []any{map[string]any{"vmid": 99020}}}}, &p)
	if code != 201 || len(p.Steps) == 0 || !strings.Contains(p.Steps[len(p.Steps)-1].Path, "/qemu/99020") {
		t.Fatalf("draft for a just-created guest: %d %+v", code, p)
	}
	// still refused for a guest that doesn't exist at all
	if code := root.do("POST", "/api/plans", map[string]any{"action": "guest.start", "clusterId": "pve-lab", "params": map[string]any{"targets": []any{map[string]any{"vmid": 99999}}}}, nil); code != 400 {
		t.Fatalf("unknown guest: %d", code)
	}
}

// Verified on PVE 9.2: in token mode PVE answers 403 when a non-admin's
// personal token creates another token; admins (User.Modify) may.
func TestAgentTokenInTokenMode(t *testing.T) {
	h := newHarness(t)
	h.setup()
	admin := h.login("root@pam", "secret")
	if code := admin.do("PUT", "/api/clusters/pve-lab", map[string]any{"credentialMode": "token"}, nil); code != 200 {
		t.Fatalf("token mode: %d", code)
	}
	agentToken(t, h.login("root@pam", "secret"), "read")
	var e struct{ Code, Error string }
	if code := h.login("dev@pve", "devpass").do("POST", "/api/agent-tokens", map[string]any{"name": "x", "scope": "read", "days": 1}, &e); code != 502 || !strings.Contains(e.Error, "User.Modify") {
		t.Fatalf("non-admin in token mode: %d %+v", code, e)
	}
}
