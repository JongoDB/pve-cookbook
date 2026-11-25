package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/docs"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/assistant"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

// POST /mcp — Model Context Protocol (streamable HTTP transport, stateless,
// JSON responses). Authenticate with an agent token:
//
//	Authorization: Bearer glly_…
//
// Tools are the same registry the in-app assistant uses, filtered by the
// token's scope; the user guide is exposed as resources (galley://docs/<slug>).

const maxBatch = 20

var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErr         `json:"error,omitempty"`
}

const mcpInstructions = `galley is a cockpit for Proxmox VE clusters. Everything you do runs as the user who created your token, with their PVE permissions.
Read state with list_resources, get_findings, list_tasks, get_metrics, pve_get and api_schema. Learn how galley works with search_docs / read_doc.
Changes are never applied implicitly: propose_action / propose_change / propose_host_command draft a change that a human reviews in galley's Changes tab. Only tokens with scope "apply" can apply_change, and must then poll get_change. Unless a galley admin allowed it, a person must apply host commands and changes to who can get in (users, roles, tokens, node shells): a draft with needsPerson stays in Changes for the user, so tell them and stop there.`

func (s *Server) mcp(w http.ResponseWriter, r *http.Request, ss *session) {
	if !ss.agent {
		apiError(w, 403, "agent_token_required", "use an agent token (Authorization: Bearer glly_…); create one in galley under Agents")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	body = []byte(strings.TrimSpace(string(body)))
	batch := len(body) > 0 && body[0] == '['
	var reqs []rpcReq
	if batch {
		err = json.Unmarshal(body, &reqs)
	} else {
		var one rpcReq
		err = json.Unmarshal(body, &one)
		reqs = []rpcReq{one}
	}
	if err != nil {
		writeJSON(w, 200, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcErr{-32700, "parse error"}})
		return
	}
	if batch && (len(reqs) == 0 || len(reqs) > maxBatch) {
		writeJSON(w, 200, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcErr{-32600, "a batch needs 1 to 20 requests"}})
		return
	}
	var out []rpcResp
	for _, q := range reqs {
		if len(q.ID) == 0 { // notification: no response
			continue
		}
		res, e := s.mcpCall(r.Context(), ss, q)
		out = append(out, rpcResp{JSONRPC: "2.0", ID: q.ID, Result: res, Error: e})
	}
	if len(out) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if batch {
		writeJSON(w, 200, out)
		return
	}
	writeJSON(w, 200, out[0])
}

func (s *Server) mcpCall(ctx context.Context, ss *session, q rpcReq) (any, *rpcErr) {
	switch q.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(q.Params, &p)
		ver := mcpVersions[0]
		for _, v := range mcpVersions {
			if v == p.ProtocolVersion {
				ver = v
			}
		}
		return map[string]any{
			"protocolVersion": ver,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}, "resources": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "galley", "version": Version},
			"instructions":    mcpInstructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		var tools []map[string]any
		for _, t := range s.toolsFor(ss) {
			schema := map[string]any{"type": "object", "properties": t.Properties}
			if len(t.Required) > 0 {
				schema["required"] = t.Required
			}
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": schema,
				"annotations": map[string]any{"readOnlyHint": toolTier[t.Name] == "read", "destructiveHint": t.Name == "apply_change"}})
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil || p.Name == "" {
			return nil, &rpcErr{-32602, "params.name required"}
		}
		if len(p.Arguments) == 0 || string(p.Arguments) == "null" {
			p.Arguments = json.RawMessage("{}")
		}
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		text, isErr := s.runTool(cctx, ss, assistant.ToolCall{ID: "mcp", Name: p.Name, Input: p.Arguments}, func(*plan.Plan) {})
		return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}, nil
	case "resources/list":
		var rs []map[string]any
		for _, d := range docs.Index() {
			rs = append(rs, map[string]any{"uri": "galley://docs/" + d.Slug, "name": d.Title, "description": d.Summary, "mimeType": "text/markdown"})
		}
		return map[string]any{"resources": rs}, nil
	case "resources/read":
		var p struct {
			URI string `json:"uri"`
		}
		_ = json.Unmarshal(q.Params, &p)
		d, ok := docs.Get(strings.TrimPrefix(p.URI, "galley://docs/"))
		if !ok {
			return nil, &rpcErr{-32002, "resource not found"}
		}
		return map[string]any{"contents": []map[string]any{{"uri": p.URI, "mimeType": "text/markdown", "text": "# " + d.Title + "\n\n" + d.Markdown}}}, nil
	case "resources/templates/list":
		return map[string]any{"resourceTemplates": []any{}}, nil
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	}
	return nil, &rpcErr{-32601, "method not found: " + q.Method}
}
