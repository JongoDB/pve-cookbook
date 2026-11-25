package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// Agent tokens let AI agents and scripts use galley without the browser UI —
// over MCP (/mcp) or the REST API — as the user who created them.
//
// A token is "glly_<session id>.<K>": an agent session whose secret K travels
// in the token, so the stored credentials are encrypted exactly like browser
// sessions. At creation galley mints a PVE API token per cluster (inheriting
// the user's permissions, expiring with the agent token), so agents work
// without anyone being logged in. The scope limits what galley lets the token
// do: read; draft changes for a human to apply; or apply changes itself.

const agentTokenPrefix = "glly_"

var agentScopes = map[string]int{"read": 1, "draft": 2, "apply": 3}

func scopeAtLeast(ss *session, want string) bool {
	return agentScopes[ss.agentScope] >= agentScopes[want]
}

func (s *Server) agentSession(bearer string) *session {
	v, ok := strings.CutPrefix(bearer, agentTokenPrefix)
	if !ok {
		return nil
	}
	id, k, ok := parseCookie(v)
	if !ok {
		return nil
	}
	st, err := s.store.GetSession(id)
	if err != nil || st.Kind != "agent" || !s.store.CheckKey(st, k) {
		return nil
	}
	s.rememberKey(store.HashID(id), k)
	now := time.Now()
	s.mu.Lock()
	touch := now.Sub(s.lastTouch[st.ID]) > time.Minute
	if touch {
		s.lastTouch[st.ID] = now
	}
	s.mu.Unlock()
	if touch {
		_ = s.store.TouchSession(st.ID, now.Unix(), st.Expires) // agent tokens don't slide
	}
	return &session{id: st.ID, user: st.User, home: st.Home, created: st.Created, expires: st.Expires, key: k,
		agent: true, agentName: st.Name, agentScope: st.Scope}
}

var planRunRe = regexp.MustCompile(`^/api/plans/[0-9a-f]+/run$`)
var planOneRe = regexp.MustCompile(`^/api/plans/[0-9a-f]+$`)

// agentAllowed is the allowlist of what agent tokens may call. Reads are
// allowed (galley and PVE still filter by the user's permissions); writes are
// limited to drafting and (scope apply) applying changes. Galley
// administration — clusters, settings, agent tokens, logins — is never
// available to agent tokens.
func agentAllowed(ss *session, r *http.Request) bool {
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/agent-tokens"), strings.HasPrefix(p, "/api/settings"),
		p == "/api/logout", strings.HasSuffix(p, "/login"), strings.HasPrefix(p, "/api/console"),
		strings.HasSuffix(p, "/console"), p == "/api/assistant/chat":
		return false
	case p == "/mcp":
		return r.Method == http.MethodPost
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		return true
	case r.Method == http.MethodPost && p == "/api/metrics":
		return true
	case r.Method == http.MethodPost && p == "/api/plans", r.Method == http.MethodDelete && planOneRe.MatchString(p):
		return scopeAtLeast(ss, "draft")
	case r.Method == http.MethodPost && planRunRe.MatchString(p):
		return scopeAtLeast(ss, "apply")
	}
	return false
}

// POST /api/agent-tokens {"name","scope":"read|draft|apply","days":1-90}
// (browser sessions only) → {"token", ...} — the token is shown once.
func (s *Server) createAgentToken(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
		Days  int    `json:"days"`
	}
	if err := readJSON(r, &req); err != nil || !nameRe.MatchString(req.Name) || agentScopes[req.Scope] == 0 || req.Days < 1 || req.Days > 90 {
		apiError(w, 400, "bad_request", "name (letters, digits, . _ -), scope (read, draft or apply) and days (1–90) are required")
		return
	}
	creds, err := s.store.CredMetas(ss.id)
	if err != nil || len(creds) == 0 {
		apiError(w, 409, "cluster_login_required", "log in to at least one cluster first")
		return
	}
	now := time.Now()
	k := newSessionSecret()
	id := randHex(32)
	exp := now.Add(time.Duration(req.Days) * 24 * time.Hour).Unix()
	// LastSeen stays 0 until an agent uses the token (the Agents page shows "Never").
	st := store.Session{ID: id, User: ss.user, Home: ss.home, CSRF: randHex(24), Created: now.Unix(),
		Expires: exp, Kind: "agent", Name: req.Name, Scope: req.Scope, KeyCheck: s.store.KeyCheck(k)}
	if err := s.store.PutSession(st); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	agent := &session{id: id, user: ss.user, home: ss.home, created: st.Created, expires: exp, key: k, agent: true, agentName: req.Name, agentScope: req.Scope}
	var clusters, warnings []string
	for _, cm := range creds {
		cl, cr, err := s.userClient(r.Context(), ss, cm.ClusterID)
		if err != nil {
			warnings = append(warnings, cm.ClusterID+": "+err.Error())
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		full, secret, err := cl.CreateToken(ctx, cr.PVEUser, "galley-agent-"+randHex(5), exp, "galley agent token: "+req.Name)
		cancel()
		if err != nil {
			msg := "PVE refused to create an API token: " + err.Error()
			var ae *pve.APIError
			if cr.Kind == "token" && errors.As(err, &ae) && ae.Status == http.StatusForbidden {
				// PVE compares the caller with the token's owner, and a token is
				// not its user: only users with User.Modify may do this.
				msg = "this cluster keeps logins as personal API tokens, and PVE lets an API token create another token only for users with User.Modify. Ask an administrator, or use a cluster that keeps PVE login tickets"
			}
			warnings = append(warnings, cm.ClusterID+": "+msg)
			continue
		}
		if err := s.store.PutCred(agent.id, agent.key, store.Cred{ClusterID: cm.ClusterID, PVEUser: cr.PVEUser, Kind: "token", TokenID: full, Secret: secret, Expires: exp}); err != nil {
			warnings = append(warnings, cm.ClusterID+": "+err.Error())
			continue
		}
		clusters = append(clusters, cm.ClusterID)
	}
	if len(clusters) == 0 {
		_ = s.store.DeleteSession(id)
		apiError(w, 502, "credential_failed", "no cluster accepted an API token for this agent: "+strings.Join(warnings, "; "))
		return
	}
	s.securityEvent(ss.user, ss.home, "agent.create", "Created agent token "+req.Name+" ("+req.Scope+")", true,
		map[string]any{"scope": req.Scope, "days": req.Days, "clusters": clusters})
	writeJSON(w, 201, map[string]any{"token": agentTokenPrefix + cookieValue(id, k), "id": store.HashID(id)[:16], "name": req.Name,
		"scope": req.Scope, "expires": exp, "clusters": clusters, "warnings": warnings})
}

// GET /api/agent-tokens → the user's agent tokens (no secrets).
func (s *Server) listAgentTokens(w http.ResponseWriter, r *http.Request, ss *session) {
	as, err := s.store.AgentSessions(ss.user, ss.home)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	writeJSON(w, 200, as)
}

// DELETE /api/agent-tokens/{id} revokes the token and its PVE API tokens.
func (s *Server) deleteAgentToken(w http.ResponseWriter, r *http.Request, ss *session) {
	as, err := s.store.AgentSessions(ss.user, ss.home)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	for _, a := range as {
		if a.ID != r.PathValue("id") {
			continue
		}
		metas, _ := s.store.CredMetasByHash(a.Hash)
		_ = s.store.DeleteSessionByHash(a.Hash)
		s.forgetKey(a.Hash)
		for _, m := range metas {
			// delete the agent's PVE token with the user's own login (users manage their own tokens)
			cl, _, err := s.userClient(r.Context(), ss, m.ClusterID)
			if err == nil && m.TokenID != "" {
				ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
				err = cl.DeleteToken(ctx, m.PVEUser, tokenName(m.TokenID))
				cancel()
			}
			if err != nil && m.TokenID != "" {
				// revocations are pruned SessionMax+1h after Created; date this one
				// so it is kept until the (up to 90-day) PVE token has expired.
				_ = s.store.AddTokenRevocation(store.TokenRevocation{ClusterID: m.ClusterID, PVEUser: m.PVEUser, TokenID: m.TokenID, Reason: "agent token revoked",
					Created: s.revocationDate(m.Expires)})
			}
		}
		s.securityEvent(ss.user, ss.home, "agent.revoke", "Revoked agent token "+a.Name, true, nil)
		w.WriteHeader(204)
		return
	}
	apiError(w, 404, "not_found", "no such agent token")
}
