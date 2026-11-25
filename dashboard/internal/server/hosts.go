package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/hosts"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// Host commands run as root on a node, beyond PVE's permission model, so they
// are limited to administrators: Sys.Modify, Sys.Console and Permissions.Modify on /.
//
// Transports (cluster setting hostTransport):
//   - "pve" (default): PVE's own node terminal (termproxy), opened as the
//     acting user. galley holds no credential for it; PVE authorizes it
//     (Sys.Console) and gives a root shell only to root@pam.
//   - "ssh" (opt-in): galley's per-cluster SSH key, authorized as root on the
//     nodes, to pinned host keys. It works for any galley administrator, but
//     the key is a standing root credential stored by galley.
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

// hostKey is galley's SSH identity for one cluster. Separate keys mean a pin
// on cluster A can never reach nodes that only trust cluster B's key.
func (s *Server) hostKey(cid string) (*hosts.Key, error) {
	hostMu.Lock()
	defer hostMu.Unlock()
	name := hostKeySetting + "." + cid
	if p, err := s.store.GetSetting(name); err == nil {
		return hosts.ParseKey([]byte(p))
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	k, err := hosts.NewKey()
	if err != nil {
		return nil, err
	}
	return k, s.store.PutSetting(name, string(k.PEM()))
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

// dropHostAccess destroys what galley holds for host commands over SSH on a
// cluster: its key and every pinned host key.
func (s *Server) dropHostAccess(cid string) error {
	hostMu.Lock()
	defer hostMu.Unlock()
	err := s.store.DeleteSetting(hostKeySetting + "." + cid)
	pins := s.hostPins()
	if _, ok := pins[cid]; ok {
		delete(pins, cid)
		err = errors.Join(err, s.savePins(pins))
	}
	return err
}

// hostRunner runs host commands of one change; cl is the acting user's client.
func (s *Server) hostRunner(cid string, cl *pve.Client) plan.HostRunner {
	return func(ctx context.Context, node, command string) (string, int, error) {
		c, err := s.store.Cluster(cid)
		if err != nil {
			return "", -1, err
		}
		if defaultTransport(c.HostTransport) != "ssh" {
			return s.termRun(ctx, cl, node, command)
		}
		pin, ok := s.hostPins()[cid][node]
		if !ok {
			return "", -1, errors.New("no confirmed SSH host key for " + node + "; pin it on the Hosts page first")
		}
		k, err := s.hostKey(cid)
		if err != nil {
			return "", -1, err
		}
		cctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		res, err := hosts.Run(cctx, k, pin.Addr, pin.Fingerprint, command)
		return res.Output, res.Exit, err
	}
}

// termRun runs command in a PVE node terminal opened as the user (see hosts.RunTerm).
func (s *Server) termRun(ctx context.Context, cl *pve.Client, node, command string) (string, int, error) {
	if !hostRe.MatchString(node) {
		return "", -1, errors.New("invalid node name")
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	var res struct {
		Port   any    `json:"port"`
		Ticket string `json:"ticket"`
		User   string `json:"user"`
	}
	octx, ocancel := context.WithTimeout(cctx, 20*time.Second)
	err := cl.Do(octx, http.MethodPost, "/nodes/"+node+"/termproxy", url.Values{}, &res)
	ocancel()
	if err != nil {
		return "", -1, fmt.Errorf("PVE refused a terminal on %s (needs Sys.Console): %w", node, err)
	}
	port := fmt.Sprint(res.Port)
	if _, err := strconv.Atoi(port); err != nil || res.Ticket == "" {
		return "", -1, errors.New("PVE returned no terminal port")
	}
	dctx, dcancel := context.WithTimeout(cctx, 20*time.Second)
	ws, err := cl.DialWebsocket(dctx, "/nodes/"+node+"/vncwebsocket", url.Values{"port": {port}, "vncticket": {res.Ticket}})
	dcancel()
	if err != nil {
		return "", -1, fmt.Errorf("could not connect to the terminal of %s: %w", node, err)
	}
	r, err := hosts.RunTerm(cctx, ws, res.User, res.Ticket, command)
	return r.Output, r.Exit, err
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

// GET /api/clusters/{id}/hosts → the host transport, nodes, their pinned SSH
// endpoint and (SSH transport only) galley's public key.
func (s *Server) listHosts(w http.ResponseWriter, r *http.Request, ss *session) {
	cid := r.PathValue("id")
	if !s.requireHostAdmin(w, r, ss, cid) {
		return
	}
	c, err := s.store.Cluster(cid)
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
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
	transport := defaultTransport(c.HostTransport)
	out := map[string]any{"transport": transport, "nodes": nodes}
	if transport != "ssh" {
		// No key exists (or is created) unless an admin opts in to SSH.
		out["note"] = "Host commands run in PVE's node terminal as the acting user; PVE gives a passwordless root shell only to root@pam."
		writeJSON(w, 200, out)
		return
	}
	k, err := s.hostKey(cid)
	if err != nil {
		apiError(w, 500, "hosts", err.Error())
		return
	}
	ak := k.AuthorizedKey()
	out["authorizedKey"] = ak
	// /root/.ssh/authorized_keys on PVE nodes links to the cluster-wide /etc/pve/priv/authorized_keys.
	out["install"] = "echo '" + ak + "' >> /etc/pve/priv/authorized_keys"
	writeJSON(w, 200, out)
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
	if err := readJSON(r, &req); err != nil || !fpRe.MatchString(req.Fingerprint) {
		apiError(w, 400, "bad_request", "the SHA256:… fingerprint you verified on the node is required")
		return
	}
	// The address is the node's own cluster address, never user input, and the
	// fingerprint must be what that address presents now: a pin cannot point a
	// node of this cluster at a machine elsewhere.
	addr, err := s.nodeAddr(r.Context(), cid, node)
	if err != nil {
		apiError(w, 404, "not_found", err.Error())
		return
	}
	if req.Addr != "" && req.Addr != addr {
		apiError(w, 400, "bad_request", "the address must be the node's cluster address "+addr)
		return
	}
	sctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	live, err := hosts.Scan(sctx, addr)
	cancel()
	if err != nil {
		apiError(w, 502, "ssh_unreachable", "could not read the host key of "+node+": "+err.Error())
		return
	}
	if live != req.Fingerprint {
		apiError(w, 409, "fingerprint_mismatch", "the node presents "+live+", not the fingerprint you entered")
		return
	}
	req.Addr = addr
	hostMu.Lock()
	pins := s.hostPins()
	if pins[cid] == nil {
		pins[cid] = map[string]HostPin{}
	}
	pins[cid][node] = HostPin{Addr: req.Addr, Fingerprint: req.Fingerprint, PinnedBy: ss.user, PinnedAt: time.Now().Unix()}
	err = s.savePins(pins)
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
