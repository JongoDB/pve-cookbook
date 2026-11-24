package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/assistant"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

const assistantSettingKey = "assistant"

// newProvider is swappable in tests.
var newProvider = assistant.New

func (s *Server) assistantConfig() assistant.Config {
	cfg := assistant.DefaultConfig()
	if v, err := s.store.GetSetting(assistantSettingKey); err == nil {
		_ = json.Unmarshal([]byte(v), &cfg)
	}
	return cfg
}

// GET /api/assistant → what any user needs to know (no secrets).
func (s *Server) assistantStatus(w http.ResponseWriter, r *http.Request, ss *session) {
	cfg := s.assistantConfig()
	ready := cfg.Enabled && (cfg.Provider != "anthropic" || cfg.APIKey != "")
	dest := "Anthropic"
	if cfg.Provider == "openai" {
		if u, err := url.Parse(cfg.BaseURL); err == nil {
			dest = u.Host
		}
	}
	writeJSON(w, 200, map[string]any{"enabled": ready, "provider": cfg.Provider, "model": cfg.Model,
		"dataNotice": "Questions and the cluster data the assistant reads to answer them (names, configuration, health, metrics) are sent to " + dest + "."})
}

// GET/PUT /api/settings/assistant (galley admins). The API key is write-only.
func (s *Server) getAssistantSettings(w http.ResponseWriter, r *http.Request, ss *session) {
	if !s.galleyAdmin(r.Context(), ss) {
		apiError(w, 403, "forbidden", "assistant settings require a galley admin")
		return
	}
	cfg := s.assistantConfig()
	hasKey := cfg.APIKey != ""
	cfg.APIKey = ""
	writeJSON(w, 200, map[string]any{"config": cfg, "hasApiKey": hasKey})
}

func (s *Server) putAssistantSettings(w http.ResponseWriter, r *http.Request, ss *session) {
	if !s.galleyAdmin(r.Context(), ss) {
		apiError(w, 403, "forbidden", "assistant settings require a galley admin")
		return
	}
	var req struct {
		assistant.Config
		ClearAPIKey bool `json:"clearApiKey"`
	}
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	cfg := req.Config
	old := s.assistantConfig()
	// Keep the stored key unless replaced or cleared — and never send it to a
	// different destination than the one it was entered for.
	if cfg.APIKey == "" && !req.ClearAPIKey && cfg.Provider == old.Provider && sameHost(cfg.BaseURL, old.BaseURL) {
		cfg.APIKey = old.APIKey
	}
	if err := cfg.Validate(); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	b, _ := json.Marshal(cfg)
	if err := s.store.PutSetting(assistantSettingKey, string(b)); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, ss.home, "settings.assistant", fmt.Sprintf("Assistant: %s %s, enabled=%v", cfg.Provider, cfg.Model, cfg.Enabled), true,
		map[string]any{"provider": cfg.Provider, "model": cfg.Model, "baseUrl": redactURL(cfg.BaseURL), "enabled": cfg.Enabled, "apiKeyChanged": cfg.APIKey != old.APIKey})
	w.WriteHeader(204)
}

// ---- conversations ----

type chat struct {
	mu    sync.Mutex // one answer at a time
	owner string     // session id
	conv  assistant.Conversation
	last  time.Time // guarded by chats
	bytes int       // approximate history size, guarded by mu
}

// maxChatBytes bounds a conversation so it stays within model context limits.
const maxChatBytes = 400_000

func touchChat(c *chat) {
	chats.Lock()
	c.last = time.Now()
	chats.Unlock()
}

var chats = struct {
	sync.Mutex
	m map[string]*chat
}{m: map[string]*chat{}}

func getChat(id, owner string) *chat {
	chats.Lock()
	defer chats.Unlock()
	now := time.Now()
	for k, c := range chats.m {
		if now.Sub(c.last) > 2*time.Hour {
			delete(chats.m, k)
		}
	}
	c := chats.m[id]
	if c == nil || c.owner != owner {
		return nil
	}
	c.last = now
	return c
}

func putChat(c *chat) string {
	chats.Lock()
	defer chats.Unlock()
	n := 0
	for _, x := range chats.m {
		if x.owner == c.owner {
			n++
		}
	}
	if n >= 20 { // bound memory per session: drop the oldest
		var oldK string
		var oldT time.Time
		for k, x := range chats.m {
			if x.owner == c.owner && (oldK == "" || x.last.Before(oldT)) {
				oldK, oldT = k, x.last
			}
		}
		delete(chats.m, oldK)
	}
	id := randHex(12)
	chats.m[id] = c
	return id
}

const systemPrompt = `You are the assistant inside galley, a cockpit for Proxmox VE (PVE) clusters, working alongside a PVE administrator.

What you can do:
- Read anything the user is allowed to read in PVE, using the tools. Every tool runs with the user's own PVE permissions; if PVE refuses, say what permission is missing.
- Propose changes with propose_change. A proposal appears in the user's "Changes" tab with the exact API calls and pvesh commands. You never apply changes: the user reviews and applies them. Never claim that something was changed, started, created or deleted.

How to work:
- Look before you answer: check real state (resources, configs, tasks, metrics) instead of assuming. Cite concrete names, VMIDs, nodes and numbers.
- Before proposing a change, read the current configuration and, when unsure about parameters, the API schema (api_schema) for the exact path and method. Prefer one proposal containing all calls of a coherent change (for example: attach a GPU, pin the VM with an HA rule, then restart it).
- For GPU passthrough prefer PCI resource mappings (hostpci with mapping=…) over raw PCI ids, and q35 + OVMF machines.
- Keep answers short and practical. Use PVE terms (VMID, node, storage, vnet, ACL). Show pvesh/qm/pct commands when they help the admin learn.
- If something needs the node's shell (outside the PVE API), say so and give the exact command for the admin to run; you cannot run shell commands.`

func (s *Server) assistantTools() []assistant.ToolSpec {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return []assistant.ToolSpec{
		{Name: "list_resources", Description: "List clusters, nodes, guests (VMs and containers) and storage the user can see, with live status and usage. Filter by cluster, kind and a text query (name, vmid or tag).",
			Properties: map[string]any{"cluster": str("cluster id (optional)"), "kind": map[string]any{"type": "string", "enum": []string{"all", "clusters", "nodes", "guests", "storage"}}, "query": str("text filter (optional)")}},
		{Name: "get_findings", Description: "Health findings galley detected (quorum, Ceph, storage, HA, backups, updates) that the user can see.", Properties: map[string]any{}},
		{Name: "list_tasks", Description: "Recent PVE tasks visible to the user (newest first).", Properties: map[string]any{"cluster": str("cluster id (optional)"), "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}},
		{Name: "pve_get", Description: "GET any PVE API path as the user, e.g. /nodes/pve1/qemu/120/config, /cluster/ha/status/current, /nodes/pve1/hardware/pci, /cluster/mapping/pci, /cluster/sdn/vnets, /access/acl. Returns JSON (large results are truncated).",
			Properties: map[string]any{"cluster": str("cluster id"), "path": str("API path starting with /"), "params": map[string]any{"type": "object", "description": "query parameters", "additionalProperties": map[string]any{"type": "string"}}}, Required: []string{"cluster", "path"}},
		{Name: "get_metrics", Description: "History of a resource summarized per metric (min, avg, max, last). kind: cluster|node|guest|storage; id: node name, vmid or storage; timeframe: hour|day|week|month|year.",
			Properties: map[string]any{"cluster": str("cluster id"), "kind": map[string]any{"type": "string", "enum": []string{"cluster", "node", "guest", "storage"}}, "id": str("resource id"), "timeframe": map[string]any{"type": "string", "enum": []string{"hour", "day", "week", "month", "year"}}}, Required: []string{"cluster", "kind", "timeframe"}},
		{Name: "api_schema", Description: "The PVE API schema for a concrete path on this cluster's PVE version: methods, parameters (types, formats, defaults), permissions. Use before proposing a change.",
			Properties: map[string]any{"cluster": str("cluster id"), "path": str("concrete API path, e.g. /nodes/pve1/qemu/120/config")}, Required: []string{"cluster", "path"}},
		{Name: "propose_change", Description: "Draft a change for the user to review in the Changes tab. It is NOT applied. Each call is validated against the API schema and shown with its pvesh equivalent; the user applies it with their own permissions.",
			Properties: map[string]any{"cluster": str("cluster id"), "title": str("short imperative title, e.g. 'Attach the second GPU to llm-vllm'"), "summary": str("why, and what the user should know (restarts, downtime)"),
				"calls": map[string]any{"type": "array", "minItems": 1, "maxItems": 20, "items": map[string]any{"type": "object", "required": []string{"method", "path"},
					"properties": map[string]any{"method": map[string]any{"type": "string", "enum": []string{"POST", "PUT", "DELETE"}}, "path": str("API path"), "body": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}}}}},
			Required: []string{"cluster", "title", "calls"}},
		{Name: "propose_host_command", Description: "Draft a shell command to run as root on a node (for what the PVE API cannot do: NIC settings, kernel parameters, packages, disks). Only administrators can apply it; it is NOT run until the user applies it in the Changes tab. Prefer the API (propose_change) whenever it can do the job.",
			Properties: map[string]any{"cluster": str("cluster id"), "node": str("node name"), "command": str("shell command (bash)"), "reason": str("why this is needed, and its effect")},
			Required:   []string{"cluster", "node", "command", "reason"}},
	}
}

func decodeStrict(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid tool input: %v", err)
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + fmt.Sprintf("\n…(truncated, %d of %d bytes shown)", n, len(b))
}

// runTool executes one tool as the user. onChange receives drafted changes.
func (s *Server) runTool(ctx context.Context, ss *session, call assistant.ToolCall, onChange func(*plan.Plan)) (string, bool) {
	fail := func(err error) (string, bool) { return err.Error(), true }
	out := func(v any) (string, bool) {
		b, _ := json.Marshal(v)
		return truncate(b, 60000), false
	}
	switch call.Name {
	case "list_resources":
		var in struct{ Cluster, Kind, Query string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		f := s.userFleet(ctx, ss, s.fleet.Fleet())
		res := map[string]any{}
		q := strings.ToLower(in.Query)
		if in.Kind == "" || in.Kind == "all" || in.Kind == "clusters" {
			cs := []map[string]any{}
			for _, c := range f.Clusters {
				if in.Cluster == "" || c.ID == in.Cluster {
					cs = append(cs, map[string]any{"id": c.ID, "name": c.Name, "quorate": c.Quorate, "stale": c.Stale, "ceph": c.Ceph, "ha": c.HA, "backups": c.Backups, "errors": c.Errors})
				}
			}
			res["clusters"] = cs
		}
		if in.Kind == "" || in.Kind == "all" || in.Kind == "nodes" {
			ns := []any{}
			for _, c := range f.Clusters {
				if in.Cluster == "" || c.ID == in.Cluster {
					for _, n := range c.Nodes {
						ns = append(ns, map[string]any{"cluster": c.ID, "node": n})
					}
				}
			}
			res["nodes"] = ns
		}
		if in.Kind == "" || in.Kind == "all" || in.Kind == "storage" {
			st := []any{}
			for _, c := range f.Clusters {
				if in.Cluster == "" || c.ID == in.Cluster {
					for _, x := range c.Storage {
						st = append(st, map[string]any{"cluster": c.ID, "storage": x})
					}
				}
			}
			res["storage"] = st
		}
		if in.Kind == "" || in.Kind == "all" || in.Kind == "guests" {
			vs := s.userViews(ctx, ss)
			gs := []fleet.Guest{}
			for _, g := range s.fleet.Guests(in.Cluster, "", "", "") {
				v := vs[g.ClusterID]
				if v == nil || !v.guests[g.VMID] {
					continue
				}
				if q != "" && !strings.Contains(strings.ToLower(g.Name), q) && !strings.Contains(fmt.Sprint(g.VMID), q) && !strings.Contains(strings.ToLower(strings.Join(g.Tags, ",")), q) {
					continue
				}
				gs = append(gs, g)
			}
			if len(gs) > 300 {
				res["guestsTruncated"] = len(gs)
				gs = gs[:300]
			}
			res["guests"] = gs
		}
		return out(res)
	case "get_findings":
		return out(s.userFleet(ctx, ss, s.fleet.Fleet()).Findings)
	case "list_tasks":
		var in struct {
			Cluster string
			Limit   int
		}
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if in.Limit <= 0 || in.Limit > 100 {
			in.Limit = 30
		}
		return out(s.userTasks(ctx, ss, s.fleet.Tasks(in.Cluster, 500), in.Limit))
	case "pve_get":
		var in struct {
			Cluster, Path string
			Params        map[string]string
		}
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if !pvePathRe.MatchString(in.Path) || strings.Contains(in.Path, "..") {
			return fail(errors.New("invalid path"))
		}
		cl, _, err := s.userClient(ctx, ss, in.Cluster)
		if err != nil {
			return fail(err)
		}
		vals := url.Values{}
		for k, v := range in.Params {
			vals.Set(k, v)
		}
		var raw json.RawMessage
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := cl.Do(cctx, http.MethodGet, in.Path, vals, &raw); err != nil {
			return fail(err)
		}
		return truncate(raw, 60000), false
	case "get_metrics":
		var in MetricQuery
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		ms := s.runMetric(ctx, ss, in)
		if ms.Error != "" {
			return fail(errors.New(ms.Error))
		}
		sum := map[string]map[string]float64{}
		for name, vals := range ms.Series {
			mn, mx, total, n, last := math.Inf(1), math.Inf(-1), 0.0, 0, math.NaN()
			for _, v := range vals {
				if v == nil {
					continue
				}
				mn, mx, total, n, last = math.Min(mn, *v), math.Max(mx, *v), total+*v, n+1, *v
			}
			if n > 0 {
				sum[name] = map[string]float64{"min": mn, "avg": total / float64(n), "max": mx, "last": last}
			}
		}
		from, to := int64(0), int64(0)
		if len(ms.T) > 0 {
			from, to = ms.T[0], ms.T[len(ms.T)-1]
		}
		return out(map[string]any{"from": from, "to": to, "samples": len(ms.T), "units": "cpu/ioWait fraction 0-1; mem*/disk*/root*/swap* bytes; net*/diskRead/diskWrite bytes per second; pressure* percent", "summary": sum})
	case "api_schema":
		var in struct{ Cluster, Path string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		if s.view(ctx, ss, in.Cluster) == nil {
			return fail(errors.New("not logged in to this cluster"))
		}
		sc, err := s.clusterSchema(ctx, in.Cluster)
		if err != nil {
			return fail(err)
		}
		n, vars, err := sc.Match(in.Path)
		if err != nil {
			return fail(err)
		}
		return out(map[string]any{"path": n.Path, "vars": vars, "methods": n.Info})
	case "propose_change":
		var in struct {
			Cluster, Title, Summary string
			Calls                   []plan.Call
		}
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		v := s.view(ctx, ss, in.Cluster)
		cl, _, err := s.userClient(ctx, ss, in.Cluster)
		if v == nil || err != nil {
			return fail(errors.New("the user is not logged in to this cluster"))
		}
		params, _ := json.Marshal(map[string]any{"title": in.Title, "summary": in.Summary, "calls": in.Calls})
		p, err := s.plans.Build(ctx, ss.user, plan.Request{Action: "api.call", ClusterID: in.Cluster, Params: params}, func(id int) bool { return v.guests[id] }, cl)
		if err != nil {
			return fail(err)
		}
		plan.MarkAssistantDraft(p)
		onChange(p)
		return out(map[string]any{"status": "drafted, waiting for the user to review and apply it in the Changes tab", "changeId": p.ID, "destructive": p.Destructive, "confirmText": p.ConfirmText, "commands": p.CLI()})
	case "propose_host_command":
		var in struct{ Cluster, Node, Command, Reason string }
		if err := decodeStrict(call.Input, &in); err != nil {
			return fail(err)
		}
		v := s.view(ctx, ss, in.Cluster)
		if !hostAdmin(v) {
			return fail(errors.New("the user is not an administrator on this cluster, so host commands are unavailable; give the command for them to pass to an administrator"))
		}
		params, _ := json.Marshal(map[string]string{"node": in.Node, "command": in.Command, "reason": in.Reason})
		p, err := s.plans.Build(ctx, ss.user, plan.Request{Action: "host.exec", ClusterID: in.Cluster, Params: params}, nil, nil)
		if err != nil {
			return fail(err)
		}
		plan.MarkAssistantDraft(p)
		onChange(p)
		return out(map[string]any{"status": "drafted, waiting for the user to review and apply it", "changeId": p.ID, "confirmText": p.ConfirmText})
	}
	return fail(fmt.Errorf("unknown tool %q", call.Name))
}

// POST /api/assistant/chat {"conversationId"?, "message"} → text/event-stream:
// text {delta} · tool {name, status, error?} · change {plan} · done {conversationId} · error {message}
func (s *Server) assistantChat(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		ConversationID string `json:"conversationId"`
		Message        string `json:"message"`
	}
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Message) == "" || len(req.Message) > 20000 {
		apiError(w, 400, "bad_request", "message required (max 20000 characters)")
		return
	}
	cfg := s.assistantConfig()
	if !cfg.Enabled {
		apiError(w, 409, "assistant_disabled", "the assistant is not set up; a galley admin can connect a model provider in Settings")
		return
	}
	if !s.limiter.allow("chat|"+ss.id, time.Now()) {
		apiError(w, 429, "rate_limited", "too many messages; wait a minute")
		return
	}
	s.limiter.succeed("chat|" + ss.id)
	var c *chat
	if req.ConversationID != "" {
		if c = getChat(req.ConversationID, ss.id); c == nil {
			apiError(w, 404, "conversation_not_found", "that conversation has ended; start a new one")
			return
		}
	} else {
		prov, err := newProvider(cfg)
		if err != nil {
			apiError(w, 409, "assistant_misconfigured", err.Error())
			return
		}
		c = &chat{owner: ss.id, conv: prov.NewConversation(systemPrompt+"\n\nThe user is "+ss.user+". Today is "+time.Now().UTC().Format("2006-01-02")+".", s.assistantTools())}
		req.ConversationID = putChat(c)
	}
	if !c.mu.TryLock() {
		apiError(w, 409, "busy", "the assistant is still answering in this conversation")
		return
	}
	defer c.mu.Unlock()
	touchChat(c)
	if c.bytes+len(req.Message) > maxChatBytes {
		apiError(w, 409, "conversation_full", "this conversation is too long; start a new one")
		return
	}

	fl, ok := w.(http.Flusher)
	if !ok {
		apiError(w, 500, "sse", "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	var wmu sync.Mutex
	send := func(name string, v any) {
		wmu.Lock()
		defer wmu.Unlock()
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
		fl.Flush()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	c.conv.AddUser(req.Message)
	c.bytes += len(req.Message)
	for i := 0; i < 16; i++ {
		if c.bytes > maxChatBytes {
			send("error", map[string]string{"message": "this conversation got too long; start a new one"})
			return
		}
		calls, err := c.conv.Step(ctx, func(e assistant.Event) {
			c.bytes += len(e.Text)
			send("text", map[string]string{"delta": e.Text})
		})
		if err != nil {
			s.log.Info("assistant error", "user", ss.user, "err", err)
			send("error", map[string]string{"message": err.Error()})
			return
		}
		if len(calls) == 0 {
			send("done", map[string]string{"conversationId": req.ConversationID})
			return
		}
		results := make([]assistant.ToolResult, len(calls))
		var wg sync.WaitGroup
		for j, call := range calls {
			send("tool", map[string]any{"id": call.ID, "name": call.Name, "status": "running", "input": json.RawMessage(call.Input)})
			wg.Add(1)
			go func(j int, call assistant.ToolCall) {
				defer wg.Done()
				content, isErr := s.runTool(ctx, ss, call, func(p *plan.Plan) { send("change", p) })
				results[j] = assistant.ToolResult{ID: call.ID, Content: content, IsError: isErr}
				ev := map[string]any{"id": call.ID, "name": call.Name, "status": "ok"}
				if isErr {
					ev["status"], ev["error"] = "error", content
				}
				send("tool", ev)
			}(j, call)
		}
		wg.Wait()
		for _, r := range results {
			c.bytes += len(r.Content)
		}
		c.conv.AddToolResults(results)
	}
	send("error", map[string]string{"message": "stopped after 16 tool rounds; ask a narrower question"})
}

func sameHost(a, b string) bool {
	ua, ea := url.Parse(a)
	ub, eb := url.Parse(b)
	return ea == nil && eb == nil && strings.EqualFold(ua.Host, ub.Host) && ua.Scheme == ub.Scheme
}

func redactURL(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	p.User = nil
	return p.String()
}
