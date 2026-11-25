package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

// What agent tokens with scope apply may apply without a person. A person is a
// browser login; agent tokens can never change this setting.
const (
	approvalAll    = "all"    // every change needs a person
	approvalRisky  = "risky"  // everything but routine guest work needs a person (default)
	approvalHosts  = "hosts"  // host commands and access changes need a person
	approvalAlways = "always" // an admin opted out: agents apply everything themselves

	agentPolicyKey = "agents"
)

type agentPolicy struct {
	Approval string `json:"approval"`
}

func validApproval(v string) bool {
	return v == approvalAll || v == approvalRisky || v == approvalHosts || v == approvalAlways
}

// agentPolicy fails closed: anything unreadable is the default, never "always".
func (s *Server) agentPolicy() agentPolicy {
	var p agentPolicy
	if v, err := s.store.GetSetting(agentPolicyKey); err == nil {
		_ = json.Unmarshal([]byte(v), &p)
	}
	if !validApproval(p.Approval) {
		p.Approval = approvalRisky
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
		apiError(w, 400, "bad_request", `approval must be "all", "risky", "hosts" or "always"`)
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

// routine lists what an agent may apply alone by default: reversible day-to-day
// guest work. It is an allowlist of method, path and parameters, so anything
// new or unforeseen needs a person.
var routine = []struct {
	method string
	path   *regexp.Regexp
	keys   string // space-separated parameters that may be set
}{
	{"POST", regexp.MustCompile(guestPath + `/status/(start|resume)$`), ""},
	{"POST", regexp.MustCompile(guestPath + `/status/(shutdown|reboot)$`), "timeout"},
	{"POST", regexp.MustCompile(guestPath + `/snapshot$`), "snapname description vmstate"},
	{"POST", regexp.MustCompile(guestPath + `/migrate$`), "target online restart with-local-disks"},
	{"PUT", regexp.MustCompile(guestPath + `/config$`), routineConfig},
	{"POST", regexp.MustCompile(`^/nodes/[^/]+/qemu/[0-9]+/config$`), routineConfig},
	{"POST", regexp.MustCompile(`^/nodes/[^/]+/vzdump$`), "vmid storage compress notes-template remove"},
}

const (
	guestPath     = `^/nodes/[^/]+/(qemu|lxc)/[0-9]+`
	routineConfig = "cores sockets vcpus memory balloon swap cpulimit cpuunits name hostname description tags onboot startup digest"
)

func routineStep(st plan.Step) bool {
	for _, r := range routine {
		if st.Method != r.method || !r.path.MatchString(st.Path) {
			continue
		}
		for k := range st.Body {
			if !slices.Contains(strings.Fields(r.keys), k) {
				return false
			}
		}
		// Without remove=0 a backup also prunes older ones.
		return !strings.HasSuffix(st.Path, "/vzdump") || (st.Body["remove"] == "0" && st.Body["vmid"] != "")
	}
	return false
}

// risky says why a change is more than routine guest work ("" = it is routine).
func risky(p *plan.Plan) string {
	if why := hostAccess(p); why != "" {
		return why
	}
	if p.Destructive {
		return "it is destructive: it can lose data or stop guests"
	}
	if p.Action == "backup.protect" {
		return "" // galley builds it: only ever adds guests to a job
	}
	for _, st := range p.Steps {
		if !routineStep(st) {
			return "it is more than routine guest work (" + st.Method + " " + st.Path + ")"
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
	case approvalHosts:
		return hostAccess(p)
	}
	return risky(p)
}

const needsPersonHint = ". The draft is waiting in the Changes tab: ask the user to review and apply it there, then follow it with get_change and its changeId. Do not work around this"

// ranChange remembers which audit entry a change became.
type ranChange struct {
	owner   string
	auditID int64
	at      time.Time
}

func (s *Server) noteRan(changeID, owner string, auditID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.ran {
		if time.Since(v.at) > 2*plan.AgentTTL {
			delete(s.ran, k)
		}
	}
	s.ran[changeID] = ranChange{owner, auditID, time.Now()}
}

// changeAudit returns the audit entry a change of owner became, if it ran.
func (s *Server) changeAudit(changeID, owner string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.ran[changeID]
	return r.auditID, ok && r.owner == owner
}

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
