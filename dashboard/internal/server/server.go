// Package server exposes galley's HTTP API (docs/api.md), live events, and the SPA.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// Version is set at build time.
var Version = "0.1.0-dev"

const (
	cookieName  = "galley_session"
	sessionIdle = 8 * time.Hour
)

type session struct {
	id, user, csrf string
	tickets        map[string]*pve.Ticket // cluster id -> user ticket
	lastSeen       time.Time
}

// Server wires the API.
type Server struct {
	store  *store.Store
	fleet  *fleet.Poller
	plans  *plan.Manager
	static fs.FS
	log    *slog.Logger
	secure bool // set cookie Secure flag (true unless serving plain HTTP for dev)

	mu       sync.Mutex
	sessions map[string]*session
	// newClient is swappable in tests.
	newClient func(eps []pve.Endpoint, a pve.Auth) *pve.Client
}

// New creates a server.
func New(st *store.Store, f *fleet.Poller, static fs.FS, log *slog.Logger, secureCookies bool) *Server {
	return &Server{store: st, fleet: f, plans: plan.NewManager(f), static: static, log: log, secure: secureCookies,
		sessions: map[string]*session{}, newClient: pve.New}
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/setup", s.setup)
	mux.HandleFunc("POST /api/clusters/probe", s.setupOrAdmin(s.probe))
	mux.HandleFunc("POST /api/clusters", s.setupOrAdmin(s.addCluster))
	mux.HandleFunc("GET /api/clusters", s.authed(s.listClusters))
	mux.HandleFunc("DELETE /api/clusters/{id}", s.admin(s.deleteCluster))
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/clusters/{id}/login", s.authed(s.clusterLogin))
	mux.HandleFunc("POST /api/logout", s.authed(s.logout))
	mux.HandleFunc("GET /api/me", s.authed(s.me))
	mux.HandleFunc("GET /api/fleet", s.authed(func(w http.ResponseWriter, r *http.Request, _ *session) { writeJSON(w, 200, s.fleet.Fleet()) }))
	mux.HandleFunc("GET /api/guests", s.authed(s.guests))
	mux.HandleFunc("GET /api/tasks", s.authed(s.tasks))
	mux.HandleFunc("GET /api/nodes/{cluster}/{node}/targets", s.authed(s.targets))
	mux.HandleFunc("POST /api/plans", s.authed(s.createPlan))
	mux.HandleFunc("POST /api/plans/{id}/run", s.authed(s.runPlan))
	mux.HandleFunc("GET /api/audit", s.authed(s.audit))
	mux.HandleFunc("GET /api/events", s.authed(s.events))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { apiError(w, 404, "not_found", "no such endpoint") })
	mux.Handle("/", s.spa())
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		h.ServeHTTP(w, r)
	})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, map[string]string{"error": msg, "code": kind})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type handler func(w http.ResponseWriter, r *http.Request, s *session)

func (s *Server) session(r *http.Request) *session {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.sessions[c.Value]
	if ss == nil || time.Since(ss.lastSeen) > sessionIdle {
		delete(s.sessions, c.Value)
		return nil
	}
	ss.lastSeen = time.Now()
	return ss
}

func (s *Server) authed(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ss := s.session(r)
		if ss == nil {
			apiError(w, 401, "unauthenticated", "log in first")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Galley-CSRF")), []byte(ss.csrf)) != 1 {
				apiError(w, 403, "csrf", "missing or invalid X-Galley-CSRF header")
				return
			}
		}
		h(w, r, ss)
	}
}

// admin requires a session whose user holds Sys.Modify on "/" in at least one authed cluster.
func (s *Server) admin(h handler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, ss *session) {
		if !s.isAdmin(r.Context(), ss) {
			apiError(w, 403, "forbidden", "requires Sys.Modify on / in a registered cluster")
			return
		}
		h(w, r, ss)
	})
}

// setupOrAdmin allows unauthenticated access only while no cluster is registered.
func (s *Server) setupOrAdmin(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, err := s.store.Clusters()
		if err != nil {
			apiError(w, 500, "store", err.Error())
			return
		}
		if len(cs) == 0 {
			h(w, r, nil)
			return
		}
		s.admin(h)(w, r)
	}
}

func (s *Server) isAdmin(ctx context.Context, ss *session) bool {
	for cid := range ss.tickets {
		cl, err := s.userClient(ctx, ss, cid)
		if err != nil {
			continue
		}
		var perms map[string]map[string]int
		if cl.Do(ctx, http.MethodGet, "/access/permissions", map[string][]string{"path": {"/"}}, &perms) == nil && perms["/"]["Sys.Modify"] == 1 {
			return true
		}
	}
	return false
}

func (s *Server) cluster(id string) (*store.Cluster, error) {
	cs, err := s.store.Clusters()
	if err != nil {
		return nil, err
	}
	for i := range cs {
		if cs[i].ID == id {
			return &cs[i], nil
		}
	}
	return nil, nil
}

// userClient returns a client acting as the session user, renewing the ticket when old.
func (s *Server) userClient(ctx context.Context, ss *session, cid string) (*pve.Client, error) {
	c, err := s.cluster(cid)
	if err != nil || c == nil {
		return nil, fmt.Errorf("unknown cluster")
	}
	s.mu.Lock()
	t := ss.tickets[cid]
	s.mu.Unlock()
	if t == nil {
		return nil, fmt.Errorf("not logged in to cluster %s", c.Name)
	}
	if time.Until(t.Expires) < 30*time.Minute {
		// PVE renews a valid ticket when it is presented as the password.
		nt, err := s.newClient(c.Endpoints, nil).Login(ctx, t.User, t.Ticket, "")
		if err != nil {
			s.mu.Lock()
			delete(ss.tickets, cid)
			s.mu.Unlock()
			return nil, fmt.Errorf("session for %s expired; log in again", c.Name)
		}
		s.mu.Lock()
		ss.tickets[cid] = nt
		s.mu.Unlock()
		t = nt
	}
	return s.newClient(c.Endpoints, t), nil
}

// ---- handlers ----

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "version": Version})
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

var hostRe = regexp.MustCompile(`^[A-Za-z0-9.\-]+(:[0-9]{1,5})?$|^\[[0-9a-fA-F:]+\](:[0-9]{1,5})?$`)

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
		h = strings.TrimSpace(h)
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

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)
var tokenIDRe = regexp.MustCompile(`^[^\s@!]+@[^\s@!]+![A-Za-z0-9][A-Za-z0-9_.-]*$`)

func (s *Server) addCluster(w http.ResponseWriter, r *http.Request, _ *session) {
	var req struct {
		Name        string         `json:"name"`
		Endpoints   []pve.Endpoint `json:"endpoints"`
		TokenID     string         `json:"tokenId"`
		TokenSecret string         `json:"tokenSecret"`
	}
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	if !nameRe.MatchString(req.Name) || len(req.Endpoints) == 0 || len(req.Endpoints) > 16 || !tokenIDRe.MatchString(req.TokenID) || req.TokenSecret == "" {
		apiError(w, 400, "bad_request", "name, 1–16 endpoints, tokenId (user@realm!name) and tokenSecret are required")
		return
	}
	for _, e := range req.Endpoints {
		if !hostRe.MatchString(e.Host) {
			apiError(w, 400, "bad_request", "invalid endpoint host "+e.Host)
			return
		}
	}
	// Verify the token works and is read-only enough to be a poller.
	cl := s.newClient(req.Endpoints, pve.TokenAuth{ID: req.TokenID, Secret: req.TokenSecret})
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var ver map[string]any
	if err := cl.Get(ctx, "/version", &ver); err != nil {
		apiError(w, 400, "cluster_unreachable", "could not reach the cluster with this token: "+err.Error())
		return
	}
	c := store.Cluster{ID: strings.ToLower(req.Name), Name: req.Name, Endpoints: req.Endpoints, TokenID: req.TokenID, TokenSecret: req.TokenSecret, CreatedAt: time.Now().Unix()}
	if err := s.store.AddCluster(c); err != nil {
		apiError(w, 409, "conflict", "a cluster with this name exists")
		return
	}
	go s.fleet.PollAll(context.WithoutCancel(r.Context()))
	writeJSON(w, 201, s.clusterView(c))
}

func (s *Server) clusterView(c store.Cluster) map[string]any {
	return map[string]any{"id": c.ID, "name": c.Name, "endpoints": c.Endpoints, "tokenId": c.TokenID, "status": s.fleet.Status(c.ID)}
}

func (s *Server) listClusters(w http.ResponseWriter, _ *http.Request, _ *session) {
	cs, err := s.store.Clusters()
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		out = append(out, s.clusterView(c))
	}
	writeJSON(w, 200, out)
}

func (s *Server) deleteCluster(w http.ResponseWriter, r *http.Request, _ *session) {
	id := r.PathValue("id")
	if err := s.store.DeleteCluster(id); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.fleet.Forget(id)
	s.mu.Lock()
	for _, ss := range s.sessions {
		delete(ss.tickets, id)
	}
	s.mu.Unlock()
	w.WriteHeader(204)
}

type loginReq struct {
	ClusterID string `json:"clusterId,omitempty"`
	Username  string `json:"username"`
	Realm     string `json:"realm"`
	Password  string `json:"password"`
	OTP       string `json:"otp,omitempty"`
}

func (l loginReq) userAtRealm() string {
	if strings.Contains(l.Username, "@") {
		return l.Username
	}
	realm := l.Realm
	if realm == "" {
		realm = "pam"
	}
	return l.Username + "@" + realm
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := readJSON(r, &req); err != nil || req.Username == "" || req.Password == "" {
		apiError(w, 400, "bad_request", "username and password required")
		return
	}
	c, err := s.cluster(req.ClusterID)
	if err != nil || c == nil {
		apiError(w, 400, "bad_request", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := s.newClient(c.Endpoints, nil).Login(ctx, req.userAtRealm(), req.Password, req.OTP)
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Message == "second factor required" {
			apiError(w, 401, "otp_required", "this account requires a one-time code")
			return
		}
		s.log.Info("login failed", "user", req.userAtRealm(), "cluster", c.Name)
		time.Sleep(500 * time.Millisecond) // blunt online guessing
		apiError(w, 401, "login_failed", "login failed")
		return
	}
	ss := &session{id: randHex(32), user: t.User, csrf: randHex(24), tickets: map[string]*pve.Ticket{c.ID: t}, lastSeen: time.Now()}
	// Same credentials on the other clusters (common with shared realms). Failures are fine.
	if cs, err := s.store.Clusters(); err == nil {
		var wg sync.WaitGroup
		var mu sync.Mutex
		for _, o := range cs {
			if o.ID == c.ID {
				continue
			}
			wg.Add(1)
			go func(o store.Cluster) {
				defer wg.Done()
				if ot, err := s.newClient(o.Endpoints, nil).Login(ctx, req.userAtRealm(), req.Password, ""); err == nil {
					mu.Lock()
					ss.tickets[o.ID] = ot
					mu.Unlock()
				}
			}(o)
		}
		wg.Wait()
	}
	s.mu.Lock()
	s.sessions[ss.id] = ss
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: ss.id, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: int(sessionIdle.Seconds())})
	s.log.Info("login", "user", ss.user, "clusters", len(ss.tickets))
	writeJSON(w, 200, s.meView(ss))
}

func (s *Server) clusterLogin(w http.ResponseWriter, r *http.Request, ss *session) {
	var req loginReq
	if err := readJSON(r, &req); err != nil || req.Username == "" || req.Password == "" {
		apiError(w, 400, "bad_request", "username and password required")
		return
	}
	c, err := s.cluster(r.PathValue("id"))
	if err != nil || c == nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := s.newClient(c.Endpoints, nil).Login(ctx, req.userAtRealm(), req.Password, req.OTP)
	if err != nil {
		apiError(w, 401, "login_failed", "login failed")
		return
	}
	s.mu.Lock()
	ss.tickets[c.ID] = t
	s.mu.Unlock()
	writeJSON(w, 200, s.meView(ss))
}

func (s *Server) logout(w http.ResponseWriter, _ *http.Request, ss *session) {
	s.mu.Lock()
	delete(s.sessions, ss.id)
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(204)
}

func (s *Server) meView(ss *session) map[string]any {
	cs, _ := s.store.Clusters()
	list := make([]map[string]any, 0, len(cs))
	s.mu.Lock()
	for _, c := range cs {
		list = append(list, map[string]any{"id": c.ID, "name": c.Name, "authed": ss.tickets[c.ID] != nil})
	}
	s.mu.Unlock()
	return map[string]any{"user": ss.user, "csrf": ss.csrf, "clusters": list}
}

func (s *Server) me(w http.ResponseWriter, _ *http.Request, ss *session) {
	writeJSON(w, 200, s.meView(ss))
}

func (s *Server) guests(w http.ResponseWriter, r *http.Request, _ *session) {
	q := r.URL.Query()
	writeJSON(w, 200, s.fleet.Guests(q.Get("cluster"), q.Get("q"), q.Get("status"), q.Get("type")))
}

func (s *Server) tasks(w http.ResponseWriter, r *http.Request, _ *session) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	writeJSON(w, 200, s.fleet.Tasks(r.URL.Query().Get("cluster"), limit))
}

func (s *Server) targets(w http.ResponseWriter, r *http.Request, _ *session) {
	out := []string{}
	for _, n := range s.fleet.OnlineNodes(r.PathValue("cluster")) {
		if n != r.PathValue("node") {
			out = append(out, n)
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) createPlan(w http.ResponseWriter, r *http.Request, ss *session) {
	var req plan.Request
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	p, err := s.plans.Build(r.Context(), ss.user, req)
	if err != nil {
		apiError(w, 400, "bad_plan", err.Error())
		return
	}
	writeJSON(w, 201, p)
}

func (s *Server) runPlan(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		Confirm string `json:"confirm"`
	}
	if r.ContentLength != 0 {
		if err := readJSON(r, &req); err != nil {
			apiError(w, 400, "bad_request", err.Error())
			return
		}
	}
	p, err := s.plans.Take(r.PathValue("id"), ss.user, req.Confirm)
	switch {
	case errors.Is(err, plan.ErrNotFound):
		apiError(w, 404, "plan_not_found", err.Error())
		return
	case errors.Is(err, plan.ErrConfirm):
		apiError(w, 400, "confirm_mismatch", err.Error())
		return
	case err != nil:
		apiError(w, 409, "plan_unavailable", err.Error())
		return
	}
	cl, err := s.userClient(r.Context(), ss, p.ClusterID)
	if err != nil {
		apiError(w, 401, "cluster_login_required", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	results, ok := plan.Execute(ctx, cl, p)
	raw, _ := json.Marshal(results)
	entry, err := s.store.AddAudit(store.AuditEntry{User: ss.user, ClusterID: p.ClusterID, Action: p.Action, Title: p.Title, CLI: p.CLI(), OK: ok, Results: raw})
	if err != nil {
		s.log.Error("audit write failed", "err", err)
	}
	s.log.Info("plan executed", "user", ss.user, "action", p.Action, "title", p.Title, "ok", ok)
	go s.fleet.PollAll(context.WithoutCancel(r.Context()))
	s.broadcastAudit(entry)
	writeJSON(w, 200, map[string]any{"auditId": entry.ID, "results": results})
}

func (s *Server) audit(w http.ResponseWriter, r *http.Request, _ *session) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	es, err := s.store.Audit(limit)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	writeJSON(w, 200, es)
}

// ---- SSE ----

var auditSubs = struct {
	sync.Mutex
	m map[chan store.AuditEntry]struct{}
}{m: map[chan store.AuditEntry]struct{}{}}

func (s *Server) broadcastAudit(e store.AuditEntry) {
	auditSubs.Lock()
	defer auditSubs.Unlock()
	for ch := range auditSubs.m {
		select {
		case ch <- e:
		default:
		}
	}
}

func (s *Server) events(w http.ResponseWriter, r *http.Request, _ *session) {
	fl, ok := w.(http.Flusher)
	if !ok {
		apiError(w, 500, "sse", "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	send := func(name string, v any) bool {
		b, _ := json.Marshal(v)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	if !send("fleet", s.fleet.Fleet()) || !send("tasks", s.fleet.Tasks("", 50)) {
		return
	}
	evs, cancel := s.fleet.Subscribe()
	defer cancel()
	au := make(chan store.AuditEntry, 4)
	auditSubs.Lock()
	auditSubs.m[au] = struct{}{}
	auditSubs.Unlock()
	defer func() { auditSubs.Lock(); delete(auditSubs.m, au); auditSubs.Unlock() }()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-evs:
			if !send(e.Name, e.Data) {
				return
			}
		case a := <-au:
			if !send("audit", a) {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// ---- SPA ----

func (s *Server) spa() http.Handler {
	files := http.FileServerFS(s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := s.static.Open(p); err == nil {
				_ = f.Close()
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// client-side routes fall back to index.html
		b, err := fs.ReadFile(s.static, "index.html")
		if err != nil {
			http.Error(w, "galley UI not built (run `npm run build` in dashboard/web)", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
}
