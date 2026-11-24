package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/hosts"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// Host access is root on the node, beyond PVE's permission model, so it is
// limited to administrators: Sys.Modify, Sys.Console and Permissions.Modify on /.
const hostAdminMsg = "host commands need administrator rights on / (Sys.Modify, Sys.Console and Permissions.Modify)"

func hostAdmin(v *userView) bool {
	return v != nil && v.privs["Sys.Modify"] && v.privs["Sys.Console"] && v.privs["Permissions.Modify"]
}

func hasHostSteps(p *plan.Plan) bool {
	for _, st := range p.Steps {
		if st.Method == plan.MethodSSH {
			return true
		}
	}
	return false
}

const (
	hostKeySetting  = "hosts.key"
	hostPinsSetting = "hosts.pins"
)

// HostPin is an admin-confirmed SSH endpoint of a node.
type HostPin struct {
	Addr        string `json:"addr"`
	Fingerprint string `json:"fingerprint"`
	PinnedBy    string `json:"pinnedBy"`
	PinnedAt    int64  `json:"pinnedAt"`
}

var hostMu sync.Mutex

func (s *Server) hostKey() (*hosts.Key, error) {
	hostMu.Lock()
	defer hostMu.Unlock()
	if p, err := s.store.GetSetting(hostKeySetting); err == nil {
		return hosts.ParseKey([]byte(p))
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	k, err := hosts.NewKey()
	if err != nil {
		return nil, err
	}
	return k, s.store.PutSetting(hostKeySetting, string(k.PEM()))
}

func (s *Server) hostPins() map[string]map[string]HostPin {
	out := map[string]map[string]HostPin{}
	if v, err := s.store.GetSetting(hostPinsSetting); err == nil {
		_ = json.Unmarshal([]byte(v), &out)
	}
	return out
}

func (s *Server) savePins(p map[string]map[string]HostPin) error {
	b, _ := json.Marshal(p)
	return s.store.PutSetting(hostPinsSetting, string(b))
}

func (s *Server) hostRunner(cid string) plan.HostRunner {
	return func(ctx context.Context, node, command string) (string, int, error) {
		pin, ok := s.hostPins()[cid][node]
		if !ok {
			return "", -1, errors.New("no confirmed SSH host key for " + node + "; pin it on the Hosts page first")
		}
		k, err := s.hostKey()
		if err != nil {
			return "", -1, err
		}
		cctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		res, err := hosts.Run(cctx, k, pin.Addr, pin.Fingerprint, command)
		return res.Output, res.Exit, err
	}
}

// nodeAddr finds a node's cluster address from /cluster/status.
func (s *Server) nodeAddr(ctx context.Context, cid, node string) (string, error) {
	cl := s.fleet.ServiceClient(cid)
	if cl == nil {
		return "", errors.New("cluster not polled yet")
	}
	var st []struct {
		Type, Name, IP string
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := cl.Get(cctx, "/cluster/status", &st); err != nil {
		return "", err
	}
	for _, e := range st {
		if e.Type == "node" && e.Name == node && e.IP != "" {
			return e.IP, nil
		}
	}
	return "", errors.New("node has no address in /cluster/status")
}

func (s *Server) requireHostAdmin(w http.ResponseWriter, r *http.Request, ss *session, cid string) bool {
	if !hostAdmin(s.view(r.Context(), ss, cid)) {
		apiError(w, 403, "forbidden", hostAdminMsg)
		return false
	}
	return true
}

// GET /api/clusters/{id}/hosts → nodes, their pinned SSH endpoint, and galley's public key.
func (s *Server) listHosts(w http.ResponseWriter, r *http.Request, ss *session) {
	cid := r.PathValue("id")
	if !s.requireHostAdmin(w, r, ss, cid) {
		return
	}
	k, err := s.hostKey()
	if err != nil {
		apiError(w, 500, "hosts", err.Error())
		return
	}
	pins := s.hostPins()[cid]
	sum, _, _, _, _ := s.fleet.Snapshot(cid)
	nodes := []map[string]any{}
	for _, n := range sum.Nodes {
		e := map[string]any{"node": n.Name, "online": n.Online}
		if p, ok := pins[n.Name]; ok {
			e["pin"] = p
		}
		nodes = append(nodes, e)
	}
	ak := k.AuthorizedKey()
	writeJSON(w, 200, map[string]any{"nodes": nodes, "authorizedKey": ak,
		// /root/.ssh/authorized_keys on PVE nodes links to the cluster-wide /etc/pve/priv/authorized_keys.
		"install": "echo '" + ak + "' >> /etc/pve/priv/authorized_keys"})
}

// POST /api/clusters/{id}/hosts/{node}/scan → {addr, fingerprint} to compare before pinning.
func (s *Server) scanHost(w http.ResponseWriter, r *http.Request, ss *session) {
	cid, node := r.PathValue("id"), r.PathValue("node")
	if !s.requireHostAdmin(w, r, ss, cid) {
		return
	}
	addr, err := s.nodeAddr(r.Context(), cid, node)
	if err != nil {
		apiError(w, 404, "not_found", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	fp, err := hosts.Scan(ctx, addr)
	if err != nil {
		apiError(w, 502, "ssh_unreachable", "could not read the SSH host key of "+node+" at "+addr+": "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"node": node, "addr": addr, "fingerprint": fp,
		"verify": "On " + node + ", run: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"})
}

var fpRe = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)

// PUT /api/clusters/{id}/hosts/{node} {"addr","fingerprint"} pins; DELETE unpins.
func (s *Server) pinHost(w http.ResponseWriter, r *http.Request, ss *session) {
	cid, node := r.PathValue("id"), r.PathValue("node")
	if !s.requireHostAdmin(w, r, ss, cid) {
		return
	}
	var req struct{ Addr, Fingerprint string }
	if err := readJSON(r, &req); err != nil || !fpRe.MatchString(req.Fingerprint) || net.ParseIP(req.Addr) == nil && !hostRe.MatchString(req.Addr) {
		apiError(w, 400, "bad_request", "addr and a SHA256:… fingerprint are required")
		return
	}
	hostMu.Lock()
	pins := s.hostPins()
	if pins[cid] == nil {
		pins[cid] = map[string]HostPin{}
	}
	pins[cid][node] = HostPin{Addr: req.Addr, Fingerprint: req.Fingerprint, PinnedBy: ss.user, PinnedAt: time.Now().Unix()}
	err := s.savePins(pins)
	hostMu.Unlock()
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, cid, "host.pin", "Pinned SSH host key of "+node, true, map[string]string{"addr": req.Addr, "fingerprint": req.Fingerprint})
	w.WriteHeader(204)
}

func (s *Server) unpinHost(w http.ResponseWriter, r *http.Request, ss *session) {
	cid, node := r.PathValue("id"), r.PathValue("node")
	if !s.requireHostAdmin(w, r, ss, cid) {
		return
	}
	hostMu.Lock()
	pins := s.hostPins()
	delete(pins[cid], node)
	err := s.savePins(pins)
	hostMu.Unlock()
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, cid, "host.unpin", "Removed SSH host key pin of "+node, true, nil)
	w.WriteHeader(204)
}
