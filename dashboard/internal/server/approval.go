package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

// What agent tokens with scope apply may apply without a person. A person is a
// browser login; agent tokens can never change this setting.
const (
	approvalHosts  = "hosts"  // host commands and access changes need a person (default)
	approvalAll    = "all"    // every change needs a person
	approvalAlways = "always" // an admin opted out: agents apply everything themselves

	agentPolicyKey = "agents"
)

type agentPolicy struct {
	Approval string `json:"approval"`
}

func validApproval(v string) bool {
	return v == approvalHosts || v == approvalAll || v == approvalAlways
}

// agentPolicy fails closed: anything unreadable is the default, never "always".
func (s *Server) agentPolicy() agentPolicy {
	var p agentPolicy
	if v, err := s.store.GetSetting(agentPolicyKey); err == nil {
		_ = json.Unmarshal([]byte(v), &p)
	}
	if !validApproval(p.Approval) {
		p.Approval = approvalHosts
	}
	return p
}

// GET /api/agent-policy → {"approval"}
func (s *Server) getAgentPolicy(w http.ResponseWriter, _ *http.Request, _ *session) {
	writeJSON(w, 200, s.agentPolicy())
}

// PUT /api/settings/agents {"approval"} (galley admins; never agents)
func (s *Server) putAgentPolicy(w http.ResponseWriter, r *http.Request, ss *session) {
	if ss.agent || !s.galleyAdmin(r.Context(), ss) {
		apiError(w, 403, "forbidden", "agent approval settings require a galley admin")
		return
	}
	var p agentPolicy
	if err := readJSON(r, &p); err != nil || !validApproval(p.Approval) {
		apiError(w, 400, "bad_request", `approval must be "hosts", "all" or "always"`)
		return
	}
	old := s.agentPolicy()
	b, _ := json.Marshal(p)
	if err := s.store.PutSetting(agentPolicyKey, string(b)); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, ss.home, "settings.agents", "Agent approval changed from "+old.Approval+" to "+p.Approval, true,
		map[string]any{"from": old.Approval, "to": p.Approval})
	writeJSON(w, 200, p)
}

// hostAccessRe matches API calls that give the caller another way to run
// commands on a node or to act as somebody else, so that gating host.exec
// alone is not hollow: users, roles, tokens, passwords and realms; node shells
// and the batch endpoint; package sources; cluster membership.
var hostAccessRe = regexp.MustCompile(`^/(access(/|$)|nodes/[^/]+/(execute|termproxy|vncshell|spiceshell|apt)(/|$)|cluster/config(/|$))`)

// hostAccess says why a change counts as a host command or access change ("" = it does not).
func hostAccess(p *plan.Plan) string {
	for _, st := range p.Steps {
		if st.Method == plan.MethodSSH {
			return "it runs a command as root on a node"
		}
		if st.Method == plan.MethodGalley {
			return "it changes galley's own configuration"
		}
		for _, seg := range strings.Split(st.Path, "/") {
			if seg == "." || seg == ".." {
				return "its API path is not canonical"
			}
		}
		if hostAccessRe.MatchString(st.Path) {
			return "it changes who or what can get into the cluster or its nodes (" + st.Path + ")"
		}
	}
	return ""
}

// needsPerson says why ss may not apply p itself ("" = it may).
func (s *Server) needsPerson(ss *session, p *plan.Plan) string {
	if !ss.agent {
		return ""
	}
	switch s.agentPolicy().Approval {
	case approvalAlways:
		return ""
	case approvalAll:
		return "this galley requires a person to apply every agent change"
	}
	return hostAccess(p)
}

const needsPersonHint = ". The draft is waiting in the Changes tab: ask the user to review and apply it there, then look for it with list_changes. Do not work around this"

// draftNote tells an apply-scope agent up front that it cannot apply this draft.
func (s *Server) draftNote(ss *session, p *plan.Plan, m map[string]any) map[string]any {
	if ss.agent {
		if why := s.needsPerson(ss, p); why != "" {
			m["needsPerson"] = true
			m["needsPersonReason"] = why
		}
	}
	return m
}
