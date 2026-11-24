package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

type session struct {
	id, user, csrf string
	expires        int64
}

type handler func(w http.ResponseWriter, r *http.Request, s *session)

// session loads the request's session from the store, sliding its idle expiry.
func (s *Server) session(r *http.Request) *session {
	c, err := r.Cookie(cookieName)
	if err != nil || len(c.Value) < 32 {
		return nil
	}
	st, err := s.store.GetSession(c.Value)
	if err != nil {
		return nil
	}
	now := time.Now()
	s.mu.Lock()
	touch := now.Sub(s.lastTouch[st.ID]) > time.Minute
	if touch {
		s.lastTouch[st.ID] = now
	}
	s.mu.Unlock()
	if touch {
		exp := min(st.Created+int64(sessionAbsolute.Seconds()), now.Add(sessionIdle).Unix())
		_ = s.store.TouchSession(st.ID, now.Unix(), exp)
		st.Expires = exp
	}
	return &session{id: st.ID, user: st.User, csrf: st.CSRF, expires: st.Expires}
}

func (s *Server) authed(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ss := s.session(r)
		if ss == nil {
			apiError(w, 401, "unauthenticated", "your session ended; log in again")
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

// setupOrAdmin allows first-cluster registration with the one-time setup code;
// once a cluster exists it requires a galley admin.
func (s *Server) setupOrAdmin(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		tok := s.setupToken
		s.mu.Unlock()
		if tok != "" {
			cs, err := s.store.Clusters()
			if err == nil && len(cs) == 0 {
				got := r.Header.Get("X-Galley-Setup-Token")
				if got == "" {
					apiError(w, 401, "setup_token_required", "enter the setup code printed by the installer")
					return
				}
				if !s.limiter.allow("setup|"+clientIP(r), time.Now()) {
					apiError(w, 429, "rate_limited", "too many attempts")
					return
				}
				if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(got)), []byte(tok)) != 1 {
					s.limiter.fail("setup|"+clientIP(r), time.Now())
					apiError(w, 403, "setup_token_invalid", "that setup code is not valid")
					return
				}
				h(w, r, nil)
				return
			}
		}
		s.authed(func(w http.ResponseWriter, r *http.Request, ss *session) {
			if !s.galleyAdmin(r.Context(), ss) {
				apiError(w, 403, "forbidden", "adding clusters requires Sys.Modify on / in every registered cluster")
				return
			}
			h(w, r, ss)
		})(w, r)
	}
}

// galleyAdmin: listed in --admin, or holds Sys.Modify on / in every registered cluster.
func (s *Server) galleyAdmin(ctx context.Context, ss *session) bool {
	for _, a := range s.opt.Admins {
		if a == ss.user {
			return true
		}
	}
	cs, err := s.store.Clusters()
	if err != nil || len(cs) == 0 {
		return false
	}
	for _, c := range cs {
		v := s.view(ctx, ss, c.ID)
		if v == nil || !v.sysModify {
			return false
		}
	}
	return true
}

// clusterAdmin: holds Sys.Modify on / of that cluster.
func (s *Server) clusterAdmin(ctx context.Context, ss *session, cid string) bool {
	v := s.view(ctx, ss, cid)
	return v != nil && v.sysModify
}

// ---- per-user cluster credentials ----

var errNoCred = errors.New("not logged in to this cluster")

func (s *Server) cred(ss *session, cid string) (store.Cred, error) {
	cs, err := s.store.Creds(ss.id)
	if err != nil {
		return store.Cred{}, err
	}
	for _, c := range cs {
		if c.ClusterID == cid {
			return c, nil
		}
	}
	return store.Cred{}, errNoCred
}

// userClient returns a client acting as the session's PVE user on cluster cid.
func (s *Server) userClient(ctx context.Context, ss *session, cid string) (*pve.Client, store.Cred, error) {
	base, c, err := s.baseClient(cid)
	if err != nil {
		return nil, store.Cred{}, fmt.Errorf("unknown cluster")
	}
	cr, err := s.cred(ss, cid)
	if err != nil {
		return nil, cr, fmt.Errorf("not logged in to %s", c.Name)
	}
	if time.Until(time.Unix(cr.Expires, 0)) < 30*time.Minute {
		if cr, err = s.renew(ctx, store.HashID(ss.id), cr); err != nil {
			return nil, cr, fmt.Errorf("your login to %s expired; log in again", c.Name)
		}
	}
	return base.WithAuth(&pve.Ticket{User: cr.PVEUser, Ticket: cr.Secret, CSRF: cr.CSRF, Expires: time.Unix(cr.Expires, 0)}), cr, nil
}

// renew exchanges a still-valid ticket for a fresh one (PVE accepts a valid
// ticket as the password), serialised per session and cluster.
func (s *Server) renew(ctx context.Context, hash string, cr store.Cred) (store.Cred, error) {
	key := hash + "\x00" + cr.ClusterID
	s.mu.Lock()
	m := s.renewing[key]
	if m == nil {
		m = &sync.Mutex{}
		s.renewing[key] = m
	}
	s.mu.Unlock()
	m.Lock()
	defer func() {
		m.Unlock()
		s.mu.Lock()
		delete(s.renewing, key)
		s.mu.Unlock()
	}()
	base, _, err := s.baseClient(cr.ClusterID)
	if err != nil {
		return cr, err
	}
	if time.Now().Unix() >= cr.Expires {
		_ = s.store.DeleteCredByHash(hash, cr.ClusterID)
		return cr, errNoCred
	}
	rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	t, err := base.Login(rctx, cr.PVEUser, cr.Secret, "")
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Status == 401 {
			_ = s.store.DeleteCredByHash(hash, cr.ClusterID)
		}
		return cr, err
	}
	cr.Secret, cr.CSRF, cr.Expires = t.Ticket, t.CSRF, t.Expires.Unix()
	return cr, s.store.PutCredByHash(hash, cr)
}

// renewDue renews every live session's tickets that expire within 40 minutes,
// so sessions survive restarts and idle tabs without re-login.
func (s *Server) renewDue() {
	due, err := s.store.CredsExpiringBefore(time.Now().Add(40 * time.Minute).Unix())
	if err != nil {
		s.log.Error("list credentials for renewal", "err", err)
		return
	}
	for _, sc := range due {
		if _, err := s.renew(s.base, sc.SessionHash, sc.Cred); err != nil {
			s.log.Info("ticket renewal failed", "cluster", sc.ClusterID, "user", sc.PVEUser, "err", err)
		}
	}
}

// ---- login ----

type loginReq struct {
	ClusterID string `json:"clusterId,omitempty"`
	Username  string `json:"username"`
	Realm     string `json:"realm"`
	Password  string `json:"password"`
	OTP       string `json:"otp,omitempty"`
}

func (l loginReq) userAtRealm() string {
	u := strings.TrimSpace(l.Username)
	if strings.Contains(u, "@") {
		return u
	}
	realm := l.Realm
	if realm == "" {
		realm = "pam"
	}
	return u + "@" + realm
}

func (s *Server) rateLimited(w http.ResponseWriter, keys ...string) bool {
	now := time.Now()
	for _, k := range keys {
		if !s.limiter.allow(k, now) {
			retry := int(s.limiter.retryAfter(k, now).Seconds()) + 1
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			writeJSON(w, 429, map[string]any{"error": "too many attempts", "code": "rate_limited", "retryAfter": retry})
			return true
		}
	}
	return false
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := readJSON(r, &req); err != nil || req.Username == "" || req.Password == "" || len(req.Password) > 4096 {
		apiError(w, 400, "bad_request", "username and password required")
		return
	}
	user := req.userAtRealm()
	ipKey, userKey := "ip|"+clientIP(r), "user|"+strings.ToLower(user)
	if s.rateLimited(w, ipKey, userKey) {
		return
	}
	base, c, err := s.baseClient(req.ClusterID)
	if err != nil {
		apiError(w, 400, "bad_request", "choose a cluster to log in to")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := base.Login(ctx, user, req.Password, req.OTP)
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Message == "second factor required" {
			apiError(w, 401, "otp_required", "this account requires a second factor")
			return
		}
		now := time.Now()
		s.limiter.fail(ipKey, now)
		s.limiter.fail(userKey, now)
		s.securityEvent(user, c.ID, "auth.login", "Login failed for "+user, false, map[string]string{"ip": clientIP(r)})
		if errors.As(err, &ae) {
			apiError(w, 401, "login_failed", "login failed: check the username, realm and password")
		} else {
			apiError(w, 502, "cluster_unreachable", "could not reach "+c.Name+": "+err.Error())
		}
		return
	}
	s.limiter.reset(userKey)
	ss, err := s.startSession(w, t.User)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	authed := []string{c.ID}
	_ = s.store.PutCred(ss.id, ticketCred(c.ID, t))
	// Opt-in credential sharing: only between clusters an admin marked as sharing a realm.
	if c.ShareLogin {
		if cs, err := s.store.Clusters(); err == nil {
			var wg sync.WaitGroup
			var mu sync.Mutex
			for _, o := range cs {
				if o.ID == c.ID || !o.ShareLogin {
					continue
				}
				wg.Add(1)
				go func(o store.Cluster) {
					defer wg.Done()
					ob, _, err := s.baseClient(o.ID)
					if err != nil {
						return
					}
					if ot, err := ob.Login(ctx, user, req.Password, ""); err == nil {
						_ = s.store.PutCred(ss.id, ticketCred(o.ID, ot))
						mu.Lock()
						authed = append(authed, o.ID)
						mu.Unlock()
					}
				}(o)
			}
			wg.Wait()
		}
	}
	s.securityEvent(t.User, c.ID, "auth.login", "Logged in as "+t.User, true, map[string]any{"ip": clientIP(r), "clusters": authed})
	s.log.Info("login", "user", t.User, "clusters", len(authed), "ip", clientIP(r))
	writeJSON(w, 200, s.meView(r.Context(), ss))
}

func ticketCred(cid string, t *pve.Ticket) store.Cred {
	return store.Cred{ClusterID: cid, PVEUser: t.User, Kind: "ticket", Secret: t.Ticket, CSRF: t.CSRF, Expires: t.Expires.Unix()}
}

func (s *Server) startSession(w http.ResponseWriter, user string) (*session, error) {
	now := time.Now()
	st := store.Session{ID: randHex(32), User: user, CSRF: randHex(24), Created: now.Unix(), LastSeen: now.Unix(), Expires: now.Add(sessionIdle).Unix()}
	if err := s.store.PutSession(st); err != nil {
		return nil, err
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: st.ID, Path: "/", HttpOnly: true, Secure: s.opt.SecureCookies,
		SameSite: http.SameSiteLaxMode, MaxAge: int(sessionAbsolute.Seconds())})
	return &session{id: st.ID, user: user, csrf: st.CSRF, expires: st.Expires}, nil
}

// clusterLogin adds a credential for another cluster to the session. The PVE
// user must be the session's user: one galley session is one identity.
func (s *Server) clusterLogin(w http.ResponseWriter, r *http.Request, ss *session) {
	var req loginReq
	if err := readJSON(r, &req); err != nil || req.Password == "" {
		apiError(w, 400, "bad_request", "password required")
		return
	}
	if req.Username == "" {
		req.Username = ss.user
	}
	user := req.userAtRealm()
	if !strings.EqualFold(user, ss.user) {
		apiError(w, 400, "identity_mismatch", "log in to every cluster as "+ss.user+"; to use another identity, log out first")
		return
	}
	userKey := "user|" + strings.ToLower(user)
	if s.rateLimited(w, "ip|"+clientIP(r), userKey) {
		return
	}
	base, c, err := s.baseClient(r.PathValue("id"))
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := base.Login(ctx, user, req.Password, req.OTP)
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Message == "second factor required" {
			apiError(w, 401, "otp_required", "this account requires a second factor")
			return
		}
		s.limiter.fail("ip|"+clientIP(r), time.Now())
		s.limiter.fail(userKey, time.Now())
		s.securityEvent(user, c.ID, "auth.login", "Login failed for "+user, false, map[string]string{"ip": clientIP(r)})
		apiError(w, 401, "login_failed", "login failed")
		return
	}
	_ = s.store.PutCred(ss.id, ticketCred(c.ID, t))
	s.dropView(ss.id, c.ID)
	writeJSON(w, 200, s.meView(r.Context(), ss))
}

func (s *Server) logout(w http.ResponseWriter, _ *http.Request, ss *session) {
	_ = s.store.DeleteSession(ss.id)
	s.mu.Lock()
	for k := range s.views {
		if strings.HasPrefix(k, ss.id+"\x00") {
			delete(s.views, k)
		}
	}
	delete(s.lastTouch, ss.id)
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(204)
}

func (s *Server) meView(ctx context.Context, ss *session) map[string]any {
	cs, _ := s.store.Clusters()
	creds, _ := s.store.Creds(ss.id)
	have := map[string]bool{}
	for _, c := range creds {
		have[c.ClusterID] = true
	}
	list := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		e := map[string]any{"id": c.ID, "name": c.Name, "authed": have[c.ID], "admin": false}
		if have[c.ID] {
			if v := s.view(ctx, ss, c.ID); v != nil {
				e["admin"] = v.sysModify
			}
		}
		list = append(list, e)
	}
	return map[string]any{"user": ss.user, "csrf": ss.csrf, "clusters": list, "version": Version,
		"galleyAdmin": s.galleyAdmin(ctx, ss), "expires": ss.expires}
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, ss *session) {
	writeJSON(w, 200, s.meView(r.Context(), ss))
}

// ---- realms and OpenID Connect ----

func (s *Server) realms(w http.ResponseWriter, r *http.Request) {
	base, _, err := s.baseClient(r.URL.Query().Get("cluster"))
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rs, err := base.Realms(ctx)
	if err != nil {
		apiError(w, 502, "cluster_unreachable", err.Error())
		return
	}
	writeJSON(w, 200, rs)
}

type oidcPending struct {
	cluster, redirect string
	exp               time.Time
}

func (s *Server) publicBase(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil && !s.opt.SecureCookies {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

// openidStart asks PVE for the identity provider's login URL. The IdP client
// configured on that PVE realm must allow galley's callback URL as a redirect.
func (s *Server) openidStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClusterID string `json:"clusterId"`
		Realm     string `json:"realm"`
	}
	if err := readJSON(r, &req); err != nil || req.Realm == "" {
		apiError(w, 400, "bad_request", "clusterId and realm required")
		return
	}
	if s.rateLimited(w, "ip|"+clientIP(r)) {
		return
	}
	base, _, err := s.baseClient(req.ClusterID)
	if err != nil {
		apiError(w, 400, "bad_request", "unknown cluster")
		return
	}
	redirect := s.publicBase(r) + "/api/login/openid/callback"
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	authURL, err := base.OpenIDAuthURL(ctx, req.Realm, redirect)
	if err != nil {
		apiError(w, 502, "openid_failed", "the cluster could not start single sign-on: "+err.Error())
		return
	}
	u, err := url.Parse(authURL)
	state := ""
	if err == nil {
		state = u.Query().Get("state")
	}
	if state == "" {
		apiError(w, 502, "openid_failed", "the identity provider URL has no state parameter")
		return
	}
	s.mu.Lock()
	s.oidc[state] = oidcPending{cluster: req.ClusterID, redirect: redirect, exp: time.Now().Add(10 * time.Minute)}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]string{"authUrl": authURL})
}

func (s *Server) openidCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	state, code := q.Get("state"), q.Get("code")
	fail := func(msg string) {
		http.Redirect(w, r, "/?loginError="+url.QueryEscape(msg), http.StatusSeeOther)
	}
	s.mu.Lock()
	p, ok := s.oidc[state]
	delete(s.oidc, state)
	s.mu.Unlock()
	if !ok || time.Now().After(p.exp) || code == "" {
		fail("single sign-on expired or was not started here; try again")
		return
	}
	base, c, err := s.baseClient(p.cluster)
	if err != nil {
		fail("unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := base.OpenIDLogin(ctx, code, state, p.redirect)
	if err != nil {
		s.securityEvent("(openid)", c.ID, "auth.login", "Single sign-on failed", false, map[string]string{"ip": clientIP(r)})
		fail("single sign-on failed: " + err.Error())
		return
	}
	ss, err := s.startSession(w, t.User)
	if err != nil {
		fail("could not create a session")
		return
	}
	_ = s.store.PutCred(ss.id, ticketCred(c.ID, t))
	s.securityEvent(t.User, c.ID, "auth.login", "Logged in as "+t.User+" with single sign-on", true, map[string]string{"ip": clientIP(r)})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// ---- login rate limiting ----

// limiter counts failures per key in a sliding window and also caps total
// attempts per key, so parallel guessing is throttled too.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time // attempts
	errs map[string][]time.Time // failures
}

const (
	limWindow      = 15 * time.Minute
	limFailures    = 8  // failures per key per window
	limAttemptsMin = 30 // attempts per key per minute
)

func newLimiter() *limiter {
	return &limiter{hits: map[string][]time.Time{}, errs: map[string][]time.Time{}}
}

func prune(ts []time.Time, since time.Time) []time.Time {
	i := 0
	for i < len(ts) && ts[i].Before(since) {
		i++
	}
	return ts[i:]
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.errs[key] = prune(l.errs[key], now.Add(-limWindow))
	l.hits[key] = prune(l.hits[key], now.Add(-time.Minute))
	if len(l.errs[key]) >= limFailures || len(l.hits[key]) >= limAttemptsMin {
		return false
	}
	l.hits[key] = append(l.hits[key], now)
	return true
}

func (l *limiter) fail(key string, now time.Time) {
	l.mu.Lock()
	l.errs[key] = append(l.errs[key], now)
	l.mu.Unlock()
}

func (l *limiter) reset(key string) {
	l.mu.Lock()
	delete(l.errs, key)
	l.mu.Unlock()
}

func (l *limiter) retryAfter(key string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	var d time.Duration
	if e := l.errs[key]; len(e) >= limFailures {
		d = e[len(e)-limFailures].Add(limWindow).Sub(now)
	}
	if h := l.hits[key]; len(h) >= limAttemptsMin {
		d = max(d, h[0].Add(time.Minute).Sub(now))
	}
	return max(d, time.Second)
}

func (l *limiter) gc(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, v := range l.errs {
		if len(prune(v, now.Add(-limWindow))) == 0 {
			delete(l.errs, k)
		}
	}
	for k, v := range l.hits {
		if len(prune(v, now.Add(-time.Minute))) == 0 {
			delete(l.hits, k)
		}
	}
}
