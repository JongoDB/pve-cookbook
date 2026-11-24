// Package server exposes galley's HTTP API (docs/api.md), live events, and the SPA.
//
// Security model: galley holds no authority of its own over clusters. Each
// human logs in with their PVE identity; galley keeps that user's PVE ticket
// (encrypted, renewed in the background) and every read shown to the user and
// every change is checked or executed with it. The per-cluster service token
// only feeds the shared cache, which is filtered per user before display.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
	cookieName      = "galley_session"
	sessionIdle     = 8 * time.Hour
	sessionAbsolute = 24 * time.Hour
	viewTTL         = 30 * time.Second
	maxSSEPerSess   = 4
)

// Options configures a Server.
type Options struct {
	// DataDir holds the setup token file while no cluster is registered.
	DataDir string
	// SecureCookies sets the cookie Secure flag (false only for plain-HTTP dev).
	SecureCookies bool
	// Admins ("cluster:user@realm") may add clusters and manage any cluster,
	// when logged in to that cluster as that user.
	Admins []string
	// PublicURL is galley's external base URL (for OpenID redirects). When
	// empty it is derived from the request's Host header.
	PublicURL string
}

// Server wires the API.
type Server struct {
	store  *store.Store
	fleet  *fleet.Poller
	plans  *plan.Manager
	static fs.FS
	log    *slog.Logger
	opt    Options

	// base is cancelled on Shutdown; detached work (plan execution, renewals) derives from it.
	base     context.Context
	cancel   context.CancelFunc
	inflight sync.WaitGroup
	// streams is cancelled as soon as shutdown begins, closing SSE connections
	// so the HTTP server can drain.
	streams     context.Context
	stopStreams context.CancelFunc

	mu         sync.Mutex
	setupMu    sync.Mutex
	setupToken string
	clients    map[string]*pve.Client // cluster id -> unauthenticated base client (shared pool)
	views      map[string]*userView   // session id + "\x00" + cluster id
	renewing   map[string]*sync.Mutex
	sseCount   map[string]int
	lastTouch  map[string]time.Time
	oidc       map[string]oidcPending
	limiter    *limiter
	auditSubs  map[chan store.AuditEntry]*session

	// newClient is swappable in tests.
	newClient func(eps []pve.Endpoint, a pve.Auth) *pve.Client
}

// New creates a server and starts its background maintenance.
func New(st *store.Store, f *fleet.Poller, static fs.FS, log *slog.Logger, opt Options) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{store: st, fleet: f, plans: plan.NewManager(f), static: static, log: log, opt: opt,
		base: ctx, cancel: cancel,
		clients: map[string]*pve.Client{}, views: map[string]*userView{}, renewing: map[string]*sync.Mutex{},
		sseCount: map[string]int{}, lastTouch: map[string]time.Time{}, oidc: map[string]oidcPending{},
		limiter: newLimiter(), auditSubs: map[chan store.AuditEntry]*session{}, newClient: pve.New}
	if n, err := st.InterruptRunning(); err != nil {
		log.Error("could not mark interrupted changes", "err", err)
	} else if n > 0 {
		log.Warn("marked interrupted changes as failed", "count", n)
	}
	s.streams, s.stopStreams = context.WithCancel(ctx)
	s.plans.Schema = s.clusterSchema
	s.initSetupToken()
	go s.maintain()
	return s
}

// StopStreams closes live event streams (register with http.Server.RegisterOnShutdown).
func (s *Server) StopStreams() { s.stopStreams() }

// Shutdown waits for running changes to finish (until ctx ends), then stops
// background work. Changes still running are recorded as interrupted.
func (s *Server) Shutdown(ctx context.Context) {
	done := make(chan struct{})
	go func() { s.inflight.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		s.log.Warn("shutdown: changes still running; marking them interrupted")
	}
	s.cancel()
	// Give cancelled runs a moment to record their outcome before the store closes.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// initSetupToken creates a one-time setup code while no cluster is registered.
func (s *Server) initSetupToken() {
	cs, err := s.store.Clusters()
	if err != nil || len(cs) > 0 {
		s.clearSetupToken()
		return
	}
	path := filepath.Join(s.opt.DataDir, "setup-token")
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		s.setupToken = strings.TrimSpace(string(b))
	} else {
		s.setupToken = randHex(12)
		if s.opt.DataDir != "" {
			_ = os.WriteFile(path, []byte(s.setupToken+"\n"), 0o600)
		}
	}
	s.log.Warn("no cluster registered: the setup code is in the setup-token file", "file", path)
}

func (s *Server) clearSetupToken() {
	s.mu.Lock()
	s.setupToken = ""
	s.mu.Unlock()
	if s.opt.DataDir != "" {
		_ = os.Remove(filepath.Join(s.opt.DataDir, "setup-token"))
	}
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/setup", s.setup)
	mux.HandleFunc("GET /api/realms", s.realms)
	mux.HandleFunc("POST /api/clusters/probe", s.setupOrAdmin(s.probe))
	mux.HandleFunc("POST /api/clusters", s.setupOrAdmin(s.addCluster))
	mux.HandleFunc("GET /api/clusters", s.authed(s.listClusters))
	mux.HandleFunc("PUT /api/clusters/{id}", s.authed(s.updateCluster))
	mux.HandleFunc("DELETE /api/clusters/{id}", s.authed(s.deleteCluster))
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/login/openid", s.openidStart)
	mux.HandleFunc("GET /api/login/openid/callback", s.openidCallback)
	mux.HandleFunc("POST /api/clusters/{id}/login", s.authed(s.clusterLogin))
	mux.HandleFunc("POST /api/logout", s.authed(s.logout))
	mux.HandleFunc("GET /api/me", s.authed(s.me))
	mux.HandleFunc("GET /api/fleet", s.authed(func(w http.ResponseWriter, r *http.Request, ss *session) {
		writeJSON(w, 200, s.userFleet(r.Context(), ss, s.fleet.Fleet()))
	}))
	mux.HandleFunc("GET /api/guests", s.authed(s.guests))
	mux.HandleFunc("GET /api/tasks", s.authed(s.tasks))
	mux.HandleFunc("GET /api/nodes/{cluster}/{node}/targets", s.authed(s.targets))
	mux.HandleFunc("POST /api/plans", s.authed(s.createPlan))
	mux.HandleFunc("DELETE /api/plans/{id}", s.authed(s.discardPlan))
	mux.HandleFunc("POST /api/plans/{id}/run", s.authed(s.runPlan))
	mux.HandleFunc("GET /api/audit", s.authed(s.audit))
	mux.HandleFunc("GET /api/metrics", s.authed(s.metrics))
	mux.HandleFunc("POST /api/metrics", s.authed(s.metricsBatch))
	mux.HandleFunc("GET /api/clusters/{id}/pve/{path...}", s.authed(s.pveGet))
	mux.HandleFunc("GET /api/clusters/{id}/schema", s.authed(s.schemaInfo))
	mux.HandleFunc("GET /api/assistant", s.authed(s.assistantStatus))
	mux.HandleFunc("POST /api/assistant/chat", s.authed(s.assistantChat))
	mux.HandleFunc("GET /api/settings/assistant", s.authed(s.getAssistantSettings))
	mux.HandleFunc("PUT /api/settings/assistant", s.authed(s.putAssistantSettings))
	mux.HandleFunc("GET /api/prefs/{key}", s.authed(s.getPref))
	mux.HandleFunc("PUT /api/prefs/{key}", s.authed(s.putPref))
	mux.HandleFunc("GET /api/events", s.authed(s.events))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { apiError(w, 404, "not_found", "no such endpoint") })
	mux.Handle("/", s.spa())
	return securityHeaders(requestGuard(mux))
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		hd.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.ServeHTTP(w, r)
	})
}

// requestGuard rejects cross-site state-changing requests, including on the
// unauthenticated login and setup endpoints that the session CSRF token cannot
// protect: mutations must be JSON and must not come from another origin.
func requestGuard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead {
			if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
				apiError(w, 403, "cross_site", "cross-site request refused")
				return
			}
			if o := r.Header.Get("Origin"); o != "" {
				u, err := url.Parse(o)
				if err != nil || !strings.EqualFold(u.Host, r.Host) {
					apiError(w, 403, "cross_site", "cross-origin request refused")
					return
				}
			}
			if r.Method != http.MethodDelete || r.ContentLength > 0 {
				if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), "application/json") {
					apiError(w, 415, "content_type", "Content-Type must be application/json")
					return
				}
			}
		}
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

// readJSON decodes a JSON body (max 1 MiB). An empty body decodes as {}.
func readJSON(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		b = []byte("{}")
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// clientIP keys rate limits: the remote address (galley does not trust
// X-Forwarded-For), with IPv6 clients grouped by /64.
func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		h = r.RemoteAddr
	}
	if ip := net.ParseIP(h); ip != nil && ip.To4() == nil {
		return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
	}
	return h
}

// baseClient returns the shared, unauthenticated client for a cluster.
func (s *Server) baseClient(cid string) (*pve.Client, *store.Cluster, error) {
	c, err := s.store.Cluster(cid)
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cl := s.clients[cid]
	if cl == nil {
		cl = s.newClient(c.Endpoints, nil)
		s.clients[cid] = cl
	}
	return cl, &c, nil
}

func (s *Server) dropClient(cid string) {
	s.mu.Lock()
	if cl := s.clients[cid]; cl != nil {
		cl.CloseIdle()
	}
	delete(s.clients, cid)
	for k := range s.views {
		if strings.HasSuffix(k, "\x00"+cid) {
			delete(s.views, k)
		}
	}
	s.mu.Unlock()
}

// maintain renews user tickets before they expire and purges dead sessions.
func (s *Server) maintain() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		s.renewDue()
		if creds, err := s.store.PurgeExpiredSessions(time.Now().Unix()); err == nil && len(creds) > 0 {
			s.log.Info("expired sessions purged", "credentials", len(creds))
		}
		s.plansGC()
		select {
		case <-s.base.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) plansGC() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.views {
		if now.Sub(v.at) > 10*viewTTL {
			delete(s.views, k)
		}
	}
	for k, p := range s.oidc {
		if now.After(p.exp) {
			delete(s.oidc, k)
		}
	}
	for k, t := range s.lastTouch {
		if now.Sub(t) > sessionIdle {
			delete(s.lastTouch, k)
		}
	}
	s.limiter.gc(now)
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
