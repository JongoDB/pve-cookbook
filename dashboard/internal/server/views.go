package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// userView is what one user may see on one cluster, according to PVE itself:
// /cluster/resources is filtered by PVE using the user's own ticket.
type userView struct {
	at        time.Time
	pveUser   string
	guests    map[int]bool
	nodes     map[string]bool
	storage   map[string]bool // "node/storage"
	sysAudit  bool            // Sys.Audit on / (cluster-wide state, all tasks)
	sysModify bool            // Sys.Modify on / (cluster admin)
	privs     map[string]bool // all privileges on /
	err       error
}

func (v *userView) canSeeStorage(id, node string) bool {
	if node != "" {
		return v.storage[node+"/"+id]
	}
	for k := range v.storage {
		if strings.HasSuffix(k, "/"+id) {
			return true
		}
	}
	return false
}

func (s *Server) dropView(sid, cid string) {
	s.mu.Lock()
	delete(s.views, sid+"\x00"+cid)
	s.mu.Unlock()
}

// view returns the cached (≤30 s) visibility of ss on cluster cid, or nil when
// the user has no credential there or PVE could not be asked.
func (s *Server) view(ctx context.Context, ss *session, cid string) *userView {
	key := ss.id + "\x00" + cid
	s.mu.Lock()
	v := s.views[key]
	s.mu.Unlock()
	if v != nil && time.Since(v.at) < viewTTL {
		if v.err != nil {
			return nil
		}
		return v
	}
	cl, cr, err := s.userClient(ctx, ss, cid)
	if err != nil {
		return nil
	}
	nv := &userView{at: time.Now(), pveUser: cr.PVEUser, guests: map[int]bool{}, nodes: map[string]bool{}, storage: map[string]bool{}}
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var res []struct {
		Type    string `json:"type"`
		VMID    int    `json:"vmid"`
		Node    string `json:"node"`
		Storage string `json:"storage"`
	}
	var perms map[string]bool
	var wg sync.WaitGroup
	var rerr, perr error
	wg.Add(2)
	go func() { defer wg.Done(); rerr = cl.Get(vctx, "/cluster/resources", &res) }()
	go func() { defer wg.Done(); perms, perr = cl.Permissions(vctx, "/") }()
	wg.Wait()
	if rerr != nil || perr != nil {
		nv.err = fmt.Errorf("could not check permissions: %v %v", rerr, perr)
		var ae *pve.APIError
		denied := (errors.As(rerr, &ae) || errors.As(perr, &ae)) && (ae.Status == 401 || ae.Status == 403)
		// On a transient error keep the previous good view briefly (and do not
		// cache the failure); never when PVE said the credential is no longer valid.
		if !denied && v != nil && v.err == nil && time.Since(v.at) < 5*viewTTL {
			return v
		}
		if !denied {
			return nil
		}
	} else {
		for _, r := range res {
			switch r.Type {
			case "qemu", "lxc":
				nv.guests[r.VMID] = true
			case "node":
				nv.nodes[r.Node] = true
			case "storage":
				nv.storage[r.Node+"/"+r.Storage] = true
			}
		}
		nv.sysAudit, nv.sysModify, nv.privs = perms["Sys.Audit"], perms["Sys.Modify"], perms
	}
	s.mu.Lock()
	s.views[key] = nv
	s.mu.Unlock()
	if nv.err != nil {
		return nil
	}
	return nv
}

// views returns the user's views for every cluster they are logged in to.
func (s *Server) userViews(ctx context.Context, ss *session) map[string]*userView {
	creds, _ := s.store.Creds(ss.id)
	out := map[string]*userView{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range creds {
		wg.Add(1)
		go func(cid string) {
			defer wg.Done()
			if v := s.view(ctx, ss, cid); v != nil {
				mu.Lock()
				out[cid] = v
				mu.Unlock()
			}
		}(c.ClusterID)
	}
	wg.Wait()
	return out
}

func (s *Server) findingVisible(v *userView, f fleet.Finding) bool {
	switch f.Resource.Kind {
	case "guest":
		id, _ := strconv.Atoi(f.Resource.ID)
		return v.guests[id]
	case "node":
		return v.nodes[f.Resource.ID]
	case "storage":
		if f.Resource.Node == "" && !v.sysAudit { // shared storage: message names nodes
			return false
		}
		return v.canSeeStorage(f.Resource.ID, f.Resource.Node)
	default:
		return v.sysAudit
	}
}

func filterSummary(v *userView, c fleet.ClusterSummary, guests []fleet.Guest) fleet.ClusterSummary {
	if v.sysAudit {
		return c
	}
	nodes := []fleet.Node{}
	for _, n := range c.Nodes {
		if v.nodes[n.Name] {
			nodes = append(nodes, n)
		}
	}
	c.Nodes = nodes
	st := []fleet.Storage{}
	for _, x := range c.Storage {
		if v.canSeeStorage(x.ID, x.Node) {
			st = append(st, x)
		}
	}
	c.Storage = st
	c.Ceph = nil
	c.HA = fleet.HA{Quorum: c.HA.Quorum}
	c.Errors = nil
	unp := []int{}
	for _, id := range c.Backups.Unprotected {
		if v.guests[id] {
			unp = append(unp, id)
		}
	}
	total := 0
	for _, g := range guests {
		if !g.Template && g.VMID < fleet.ReservedVMIDs && v.guests[g.VMID] {
			total++
		}
	}
	c.Backups.Unprotected, c.Backups.Total = unp, total
	if c.Backups.Known {
		c.Backups.Covered = max(total-len(unp), 0)
	}
	return c
}

// userFleet filters the shared fleet cache down to what ss may see.
func (s *Server) userFleet(ctx context.Context, ss *session, f fleet.Fleet) fleet.Fleet {
	vs := s.userViews(ctx, ss)
	out := fleet.Fleet{Clusters: []fleet.ClusterSummary{}, Findings: []fleet.Finding{}}
	first := true
	for _, c := range f.Clusters {
		v := vs[c.ID]
		if v == nil {
			continue
		}
		_, guests, _, _, _ := s.fleet.Snapshot(c.ID)
		fc := filterSummary(v, c, guests)
		out.Clusters = append(out.Clusters, fc)
		if first || c.LastSuccess < out.UpdatedAt {
			out.UpdatedAt, first = c.LastSuccess, false
		}
		out.Totals.Clusters++
		for _, n := range fc.Nodes {
			out.Totals.Nodes++
			if n.Online {
				out.Totals.NodesOnline++
			}
		}
		for _, g := range guests {
			if g.Template || !v.guests[g.VMID] {
				continue
			}
			out.Totals.Guests++
			if g.Status == "running" {
				out.Totals.Running++
			}
		}
	}
	for _, fd := range f.Findings {
		if v := vs[fd.ClusterID]; v != nil && s.findingVisible(v, fd) {
			out.Findings = append(out.Findings, fd)
		}
	}
	return out
}

func (s *Server) taskVisible(v *userView, t fleet.Task) bool {
	if v.sysAudit {
		return true
	}
	// Like PVE: without Sys.Audit you see only your own tasks.
	u, _, _ := strings.Cut(t.User, "!")
	return u == v.pveUser
}

func (s *Server) userTasks(ctx context.Context, ss *session, ts []fleet.Task, limit int) []fleet.Task {
	vs := s.userViews(ctx, ss)
	out := []fleet.Task{}
	for _, t := range ts {
		if v := vs[t.ClusterID]; v != nil && s.taskVisible(v, t) {
			out = append(out, t)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func (s *Server) guests(w http.ResponseWriter, r *http.Request, ss *session) {
	q := r.URL.Query()
	vs := s.userViews(r.Context(), ss)
	out := []fleet.Guest{}
	for _, g := range s.fleet.Guests(q.Get("cluster"), q.Get("q"), q.Get("status"), q.Get("type")) {
		if v := vs[g.ClusterID]; v != nil && v.guests[g.VMID] {
			out = append(out, g)
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) tasks(w http.ResponseWriter, r *http.Request, ss *session) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	writeJSON(w, 200, s.userTasks(r.Context(), ss, s.fleet.Tasks(r.URL.Query().Get("cluster"), 500), limit))
}

func (s *Server) targets(w http.ResponseWriter, r *http.Request, ss *session) {
	out := []string{}
	v := s.view(r.Context(), ss, r.PathValue("cluster"))
	if v == nil {
		writeJSON(w, 200, out)
		return
	}
	for _, n := range s.fleet.OnlineNodes(r.PathValue("cluster")) {
		if n != r.PathValue("node") && (v.sysAudit || v.nodes[n]) {
			out = append(out, n)
		}
	}
	writeJSON(w, 200, out)
}

// ---- health and setup ----

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	if err := s.store.Ping(); err != nil {
		writeJSON(w, 503, map[string]any{"ok": false, "status": "database unavailable"})
		return
	}
	status, stale := "ok", 0
	ids := s.fleet.Clusters()
	for _, id := range ids {
		if sum, _, _, _, ok := s.fleet.Snapshot(id); !ok || sum.Stale {
			stale++
		}
	}
	if stale > 0 {
		status = "degraded"
	}
	writeJSON(w, 200, map[string]any{"ok": true, "status": status, "clusters": len(ids), "staleClusters": stale})
}

func (s *Server) setup(w http.ResponseWriter, _ *http.Request) {
	cs, err := s.store.Clusters()
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	// Names and ids only, so the login page can offer a cluster picker before login.
	list := make([]map[string]string, 0, len(cs))
	for _, c := range cs {
		list = append(list, map[string]string{"id": c.ID, "name": c.Name})
	}
	writeJSON(w, 200, map[string]any{"needsSetup": len(cs) == 0, "clusters": list})
}

// ---- clusters ----

var hostRe = regexp.MustCompile(`^[A-Za-z0-9.\-]+(:[0-9]{1,5})?$|^\[[0-9a-fA-F:]+\](:[0-9]{1,5})?$`)
var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)
var tokenIDRe = regexp.MustCompile(`^[^\s@!]+@[^\s@!]+![A-Za-z0-9][A-Za-z0-9_.-]*$`)

func (s *Server) probe(w http.ResponseWriter, r *http.Request, _ *session) {
	var req struct {
		Endpoints []string `json:"endpoints"`
	}
	if err := readJSON(r, &req); err != nil || len(req.Endpoints) == 0 || len(req.Endpoints) > 16 {
		apiError(w, 400, "bad_request", "1–16 endpoints required")
		return
	}
	out := make([]pve.Probe, len(req.Endpoints))
	var wg sync.WaitGroup
	for i, h := range req.Endpoints {
		h = pve.NormalizeHost(h)
		if !hostRe.MatchString(h) {
			out[i] = pve.Probe{Host: h, Error: "invalid host"}
			continue
		}
		wg.Add(1)
		go func(i int, h string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
			defer cancel()
			out[i] = pve.ProbeEndpoint(ctx, h)
		}(i, h)
	}
	wg.Wait()
	writeJSON(w, 200, map[string]any{"endpoints": out})
}

// privileges a poller token must not hold: galley's poller only reads.
var writePrivs = []string{"Sys.Modify", "Sys.PowerMgmt", "Sys.Console", "VM.Allocate", "VM.PowerMgmt", "VM.Config.Disk",
	"VM.Config.HWType", "VM.Migrate", "Datastore.Allocate", "Datastore.AllocateSpace", "Permissions.Modify", "User.Modify",
	"Realm.Allocate", "SDN.Allocate", "Pool.Allocate"}

func validEndpoints(eps []pve.Endpoint) error {
	if len(eps) == 0 || len(eps) > 16 {
		return fmt.Errorf("1–16 endpoints required")
	}
	for i := range eps {
		eps[i].Host = pve.NormalizeHost(eps[i].Host)
		if !hostRe.MatchString(eps[i].Host) {
			return fmt.Errorf("invalid endpoint host %s", eps[i].Host)
		}
	}
	return nil
}

func (s *Server) addCluster(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		Name        string         `json:"name"`
		Endpoints   []pve.Endpoint `json:"endpoints"`
		TokenID     string         `json:"tokenId"`
		TokenSecret string         `json:"tokenSecret"`
		ShareLogin  bool           `json:"shareLogin"`
	}
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	if !nameRe.MatchString(req.Name) || !tokenIDRe.MatchString(req.TokenID) || req.TokenSecret == "" {
		apiError(w, 400, "bad_request", "name, 1–16 endpoints, tokenId (user@realm!name) and tokenSecret are required")
		return
	}
	if err := validEndpoints(req.Endpoints); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	cl := s.newClient(req.Endpoints, pve.TokenAuth{ID: req.TokenID, Secret: req.TokenSecret})
	defer cl.CloseIdle()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var ver map[string]any
	if err := cl.Get(ctx, "/version", &ver); err != nil {
		apiError(w, 400, "cluster_unreachable", "could not reach the cluster with this token: "+err.Error())
		return
	}
	perms, err := cl.Permissions(ctx, "/")
	if err != nil {
		apiError(w, 400, "token_check_failed", "could not read the token's permissions: "+err.Error())
		return
	}
	var bad []string
	for _, p := range writePrivs {
		if perms[p] {
			bad = append(bad, p)
		}
	}
	if len(bad) > 0 {
		apiError(w, 400, "token_too_powerful", "this token can change the cluster ("+strings.Join(bad, ", ")+"). galley's poller only needs PVEAuditor on / — create a separate read-only token (privilege separation on)")
		return
	}
	if !perms["Sys.Audit"] {
		apiError(w, 400, "token_too_weak", "this token cannot read cluster state: grant it the PVEAuditor role on /")
		return
	}
	c := store.Cluster{ID: strings.ToLower(req.Name), Name: req.Name, Endpoints: req.Endpoints, TokenID: req.TokenID,
		TokenSecret: req.TokenSecret, ShareLogin: req.ShareLogin, CreatedAt: time.Now().Unix()}
	if err := s.store.AddCluster(c); err != nil {
		apiError(w, 409, "conflict", "a cluster with this name exists")
		return
	}
	actor := "(setup)"
	if ss != nil {
		actor = ss.user
	}
	s.securityEvent(actor, c.ID, "cluster.add", "Registered cluster "+c.Name, true, map[string]any{"endpoints": c.Endpoints, "tokenId": c.TokenID})
	s.clearSetupToken()
	s.fleet.Trigger(c.ID)
	writeJSON(w, 201, s.clusterView(c, true))
}

func (s *Server) clusterView(c store.Cluster, detail bool) map[string]any {
	m := map[string]any{"id": c.ID, "name": c.Name}
	if detail {
		m["status"] = s.fleet.Status(c.ID)
		m["endpoints"], m["tokenId"], m["shareLogin"], m["brokenSecret"] = c.Endpoints, c.TokenID, c.ShareLogin, c.BrokenSecret
	}
	return m
}

func (s *Server) listClusters(w http.ResponseWriter, r *http.Request, ss *session) {
	cs, err := s.store.Clusters()
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	vs := s.userViews(r.Context(), ss)
	out := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		v := vs[c.ID]
		m := s.clusterView(c, v != nil && v.sysAudit)
		if v != nil && !v.sysAudit {
			st := s.fleet.Status(c.ID)
			m["status"] = map[string]any{"reachable": st.Reachable, "quorate": st.Quorate, "lastPoll": st.LastPoll}
		}
		m["authed"] = v != nil
		m["admin"] = v != nil && v.sysModify
		out = append(out, m)
	}
	writeJSON(w, 200, out)
}

// updateCluster renames a cluster, replaces its endpoints/pins (e.g. after a
// certificate renewal) or toggles login sharing. Requires Sys.Modify on / there.
func (s *Server) updateCluster(w http.ResponseWriter, r *http.Request, ss *session) {
	id := r.PathValue("id")
	if !s.clusterAdmin(r.Context(), ss, id) {
		apiError(w, 403, "forbidden", "requires Sys.Modify on / in this cluster")
		return
	}
	c, err := s.store.Cluster(id)
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	var req struct {
		Name       *string        `json:"name"`
		Endpoints  []pve.Endpoint `json:"endpoints"`
		ShareLogin *bool          `json:"shareLogin"`
	}
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	if req.Name != nil {
		if !nameRe.MatchString(*req.Name) {
			apiError(w, 400, "bad_request", "invalid name")
			return
		}
		c.Name = *req.Name
	}
	if (req.Endpoints != nil || (req.ShareLogin != nil && *req.ShareLogin)) && !s.galleyAdmin(r.Context(), ss) {
		// Endpoints decide where passwords are sent; sharing decides which clusters
		// receive passwords typed for another. Both affect more than this cluster.
		apiError(w, 403, "forbidden", "changing endpoints or enabling shared login requires a galley admin")
		return
	}
	if req.ShareLogin != nil {
		c.ShareLogin = *req.ShareLogin
	}
	if req.Endpoints != nil {
		if err := validEndpoints(req.Endpoints); err != nil {
			apiError(w, 400, "bad_request", err.Error())
			return
		}
		cl := s.newClient(req.Endpoints, pve.TokenAuth{ID: c.TokenID, Secret: c.TokenSecret})
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		var ver map[string]any
		err := cl.Get(ctx, "/version", &ver)
		cancel()
		cl.CloseIdle()
		if err != nil {
			apiError(w, 400, "cluster_unreachable", "the cluster is not reachable at these endpoints: "+err.Error())
			return
		}
		c.Endpoints = req.Endpoints
	}
	if err := s.store.UpdateCluster(c); err != nil {
		apiError(w, 409, "conflict", err.Error())
		return
	}
	s.securityEvent(ss.user, c.ID, "cluster.update", "Updated cluster "+c.Name, true, map[string]any{"name": c.Name, "endpoints": c.Endpoints, "shareLogin": c.ShareLogin})
	s.dropClient(id)
	s.fleet.Forget(id) // rebuilt with the new endpoints on the next scan
	s.fleet.Trigger(id)
	writeJSON(w, 200, s.clusterView(c, true))
}

func (s *Server) deleteCluster(w http.ResponseWriter, r *http.Request, ss *session) {
	id := r.PathValue("id")
	if !s.clusterAdmin(r.Context(), ss, id) && !s.galleyAdmin(r.Context(), ss) {
		apiError(w, 403, "forbidden", "requires Sys.Modify on / in this cluster")
		return
	}
	c, err := s.store.Cluster(id)
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	if err := s.store.DeleteCluster(id); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, id, "cluster.delete", "Removed cluster "+c.Name, true, nil)
	s.fleet.Forget(id)
	s.dropClient(id)
	w.WriteHeader(204)
}

// ---- audit ----

// securityEvent records logins and cluster administration in the audit log.
func (s *Server) securityEvent(user, cid, action, title string, ok bool, detail any) {
	status := map[bool]string{true: "ok", false: "error"}[ok]
	raw, _ := json.Marshal([]map[string]any{{"step": 0, "status": status, "ok": ok, "detail": detail}})
	e, err := s.store.AddAudit(store.AuditEntry{User: user, ActorUser: user, ClusterID: cid, Action: action, Title: title, OK: ok, Results: raw})
	if err != nil {
		s.log.Error("audit write failed", "err", err, "action", action)
		return
	}
	s.broadcastAudit(e)
}

// auditVisible: entries are scoped to their cluster. You see an entry if you
// are logged in to that cluster and either hold Sys.Audit on / there or the
// entry is yours there (the same PVE identity on the same cluster).
func (s *Server) auditVisible(ctx context.Context, ss *session, e store.AuditEntry, vs map[string]*userView) bool {
	v := vs[e.ClusterID]
	if v == nil {
		return false
	}
	if e.ActorUser == v.pveUser {
		return true
	}
	// Root command output can reveal anything on the node: administrators only.
	if e.Action == "host.exec" {
		return hostAdmin(v)
	}
	return v.sysAudit
}

func (s *Server) audit(w http.ResponseWriter, r *http.Request, ss *session) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	es, err := s.store.Audit(1000)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	vs := s.userViews(r.Context(), ss)
	out := []store.AuditEntry{}
	for _, e := range es {
		if s.auditVisible(r.Context(), ss, e, vs) {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	writeJSON(w, 200, out)
}

// ---- per-user preferences (dashboard layout etc.) ----

var prefKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

func (s *Server) getPref(w http.ResponseWriter, r *http.Request, ss *session) {
	k := r.PathValue("key")
	if !prefKeyRe.MatchString(k) {
		apiError(w, 400, "bad_request", "invalid key")
		return
	}
	v, err := s.store.GetPref(prefOwner(ss), k)
	if err != nil {
		apiError(w, 404, "not_found", "no such preference")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(v)
}

func (s *Server) putPref(w http.ResponseWriter, r *http.Request, ss *session) {
	k := r.PathValue("key")
	if !prefKeyRe.MatchString(k) {
		apiError(w, 400, "bad_request", "invalid key")
		return
	}
	var v json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&v); err != nil {
		apiError(w, 400, "bad_request", "body must be JSON (max 64 KiB)")
		return
	}
	if err := s.store.PutPref(prefOwner(ss), k, v); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	w.WriteHeader(204)
}

// prefOwner scopes preferences to an identity on its home cluster.
func prefOwner(ss *session) string { return ss.home + ":" + ss.user }
