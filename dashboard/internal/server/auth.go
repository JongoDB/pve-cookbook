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
	id, user, home, csrf string
	created, expires     int64
	// key is the session secret K from the cookie: it unlocks the session's
	// stored credentials (see sessions.go). Never logged or stored.
	key []byte
}

type handler func(w http.ResponseWriter, r *http.Request, s *session)

// session loads the request's session from the store (the cookie must carry
// the session's secret K), sliding its idle expiry and keeping K in memory
// while the session is in use.
func (s *Server) session(r *http.Request) *session {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	id, k, ok := parseCookie(c.Value)
	if !ok {
		return nil
	}
	st, err := s.store.GetSession(id)
	if err != nil || !s.store.CheckKey(st, k) {
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
		exp := min(st.Created+int64(s.opt.SessionMax.Seconds()), now.Add(s.opt.SessionIdle).Unix())
		_ = s.store.TouchSession(st.ID, now.Unix(), exp)
		st.Expires = exp
	}
	return &session{id: st.ID, user: st.User, home: st.Home, csrf: st.CSRF, created: st.Created, expires: st.Expires, key: k}
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
					apiError(w, 403, "setup_token_invalid", "that setup code is not valid")
					return
				}
				s.limiter.succeed("setup|" + clientIP(r))
				s.setupMu.Lock() // one first registration at a time
				defer s.setupMu.Unlock()
				if cs, err := s.store.Clusters(); err != nil || len(cs) > 0 {
					apiError(w, 409, "setup_done", "a cluster was registered meanwhile; log in instead")
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

// galleyAdmin: listed in --admin as cluster:user@realm and logged in to that
// cluster as exactly that user, or holds Sys.Modify on / in every registered
// cluster. Qualifying by cluster means a rogue cluster that mints a ticket
// named "root@pam" cannot claim an admin's identity.
func (s *Server) galleyAdmin(ctx context.Context, ss *session) bool {
	for _, a := range s.opt.Admins {
		cid, user, ok := strings.Cut(a, ":")
		if !ok || user != ss.user {
			continue
		}
		if cr, err := s.cred(ss, cid); err == nil && cr.PVEUser == user {
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
	cs, err := s.store.Creds(ss.id, ss.key)
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
// The client holds a copy of the session secret, so a change that runs for
// hours keeps renewing its ticket even after the user went idle.
func (s *Server) userClient(ctx context.Context, ss *session, cid string) (*pve.Client, store.Cred, error) {
	base, c, err := s.baseClient(cid)
	if err != nil {
		return nil, store.Cred{}, fmt.Errorf("unknown cluster")
	}
	cr, err := s.cred(ss, cid)
	if err != nil {
		return nil, cr, fmt.Errorf("not logged in to %s", c.Name)
	}
	hash := store.HashID(ss.id)
	if cr.Kind == "token" {
		if time.Now().Unix() >= cr.Expires {
			_ = s.store.DeleteCredByHash(hash, cid)
			return nil, cr, fmt.Errorf("your login to %s expired; log in again", c.Name)
		}
		return base.WithAuth(pve.TokenAuth{ID: cr.TokenID, Secret: cr.Secret}), cr, nil
	}
	k := append([]byte(nil), ss.key...)
	if time.Until(time.Unix(cr.Expires, 0)) < 30*time.Minute {
		if cr, err = s.renew(ctx, hash, k, cr); err != nil {
			return nil, cr, fmt.Errorf("your login to %s expired; log in again", c.Name)
		}
	}
	// Each request presents the current ticket (renewed in the background), so
	// long-running changes keep working past the 2-hour ticket lifetime.
	cid2 := cid
	current := cr
	var mu sync.Mutex
	auth := pve.DynamicAuth{Get: func() pve.Auth {
		mu.Lock()
		defer mu.Unlock()
		if time.Until(time.Unix(current.Expires, 0)) < 45*time.Minute {
			if fresh, err := s.store.CredByHash(hash, k, cid2); err == nil {
				current = fresh
			}
			if time.Until(time.Unix(current.Expires, 0)) < 30*time.Minute {
				if r, err := s.renew(s.base, hash, k, current); err == nil {
					current = r
				}
			}
		}
		return &pve.Ticket{User: current.PVEUser, Ticket: current.Secret, CSRF: current.CSRF, Expires: time.Unix(current.Expires, 0)}
	}}
	return base.WithAuth(auth), cr, nil
}

// renew exchanges a still-valid ticket for a fresh one (PVE accepts a valid
// ticket as the password), serialised per session and cluster. It needs the
// session secret k to read and re-seal the credential.
func (s *Server) renew(ctx context.Context, hash string, k []byte, cr store.Cred) (store.Cred, error) {
	key := hash + "\x00" + cr.ClusterID
	s.mu.Lock()
	m := s.renewing[key]
	if m == nil {
		m = &sync.Mutex{}
		s.renewing[key] = m
	}
	s.mu.Unlock()
	m.Lock()
	defer m.Unlock()
	// Another caller may have renewed while we waited: work from the stored copy.
	if fresh, err := s.store.CredByHash(hash, k, cr.ClusterID); err == nil {
		cr = fresh
		if time.Until(time.Unix(cr.Expires, 0)) > 45*time.Minute {
			return cr, nil
		}
	} else {
		return cr, errNoCred
	}
	if cr.Kind != "ticket" {
		return cr, nil
	}
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
	return cr, s.store.PutCredByHash(hash, k, cr)
}

// renewDue renews tickets that expire within 40 minutes — only for sessions
// whose secret is in memory (used in the last keyIdle, or with an open event
// stream or running change). Tickets of other sessions cannot be decrypted
// and lapse in PVE; the user's next request gets 409 cluster_login_required
// for that cluster (the galley session itself stays valid).
func (s *Server) renewDue() {
	due, err := s.store.CredsExpiringBefore(time.Now().Add(40 * time.Minute).Unix())
	if err != nil {
		s.log.Error("list credentials for renewal", "err", err)
		return
	}
	skipped := 0
	for _, m := range due {
		if m.Kind != "ticket" {
			continue
		}
		k := s.cachedKey(m.SessionHash)
		if k == nil {
			skipped++
			continue
		}
		cr, err := s.store.CredByHash(m.SessionHash, k, m.ClusterID)
		if err != nil {
			continue
		}
		if _, err := s.renew(s.base, m.SessionHash, k, cr); err != nil {
			s.log.Info("ticket renewal failed", "cluster", m.ClusterID, "user", m.PVEUser, "err", err)
		}
	}
	if skipped > 0 {
		s.log.Debug("tickets of idle sessions left to lapse", "count", skipped)
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
		s.limiter.succeed(ipKey, userKey)
		apiError(w, 400, "bad_request", "choose a cluster to log in to")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := base.Login(ctx, user, req.Password, req.OTP)
	if err == nil && t.User != user {
		err = &pve.APIError{Status: 401, Message: "cluster answered for a different user"}
		s.log.Warn("login identity mismatch", "requested", user, "returned", t.User, "cluster", c.ID)
	}
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Message == "second factor required" {
			s.limiter.succeed(ipKey, userKey)
			apiError(w, 401, "otp_required", "this account requires a second factor")
			return
		}
		if !errors.As(err, &ae) { // outage: not a guess
			s.limiter.succeed(ipKey, userKey)
			apiError(w, 502, "cluster_unreachable", "could not reach "+c.Name)
			return
		}
		s.securityEvent(user, c.ID, "auth.login", "Login failed for "+user, false, map[string]string{"ip": clientIP(r)})
		apiError(w, 401, "login_failed", "login failed: check the username, realm and password")
		return
	}
	s.limiter.succeed(ipKey, userKey)
	s.limiter.reset(userKey)
	ss, err := s.startSession(w, t.User, c.ID)
	if err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	authed := []string{c.ID}
	if err := s.addLogin(ctx, ss, c, t); err != nil {
		_ = s.store.DeleteSession(ss.id)
		s.forgetKey(store.HashID(ss.id))
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode})
		s.log.Warn("login: storing the credential failed", "user", t.User, "cluster", c.ID, "err", err)
		apiError(w, 502, "credential_failed", err.Error())
		return
	}
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
					if ot, err := ob.Login(ctx, user, req.Password, ""); err == nil && ot.User == user {
						if err := s.addLogin(ctx, ss, &o, ot); err != nil {
							s.log.Warn("shared login: storing the credential failed", "cluster", o.ID, "err", err)
							return
						}
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

// startSession creates a session with a fresh secret K and sets the cookie
// "<id>.<K>". Only hash(id) and a verifier of K are stored.
func (s *Server) startSession(w http.ResponseWriter, user, home string) (*session, error) {
	now := time.Now()
	k := newSessionSecret()
	st := store.Session{ID: randHex(32), User: user, Home: home, CSRF: randHex(24), Created: now.Unix(), LastSeen: now.Unix(),
		Expires: now.Add(s.opt.SessionIdle).Unix(), KeyCheck: s.store.KeyCheck(k)}
	if err := s.store.PutSession(st); err != nil {
		return nil, err
	}
	s.rememberKey(store.HashID(st.ID), k)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: cookieValue(st.ID, k), Path: "/", HttpOnly: true, Secure: s.opt.SecureCookies,
		SameSite: http.SameSiteLaxMode, MaxAge: int(s.opt.SessionMax.Seconds())})
	return &session{id: st.ID, user: user, home: home, csrf: st.CSRF, created: st.Created, expires: st.Expires, key: k}, nil
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
	if user != ss.user {
		apiError(w, 400, "identity_mismatch", "log in to every cluster as "+ss.user+"; to use another identity, log out first")
		return
	}
	userKey := "user|" + strings.ToLower(user)
	if s.rateLimited(w, "ip|"+clientIP(r), userKey) {
		return
	}
	base, c, err := s.baseClient(r.PathValue("id"))
	if err != nil {
		s.limiter.succeed("ip|"+clientIP(r), userKey)
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	t, err := base.Login(ctx, user, req.Password, req.OTP)
	if err == nil && t.User != ss.user {
		err = &pve.APIError{Status: 401, Message: "cluster answered for a different user"}
	}
	if err != nil {
		var ae *pve.APIError
		if errors.As(err, &ae) && ae.Message == "second factor required" {
			s.limiter.succeed("ip|"+clientIP(r), userKey)
			apiError(w, 401, "otp_required", "this account requires a second factor")
			return
		}
		if !errors.As(err, &ae) {
			s.limiter.succeed("ip|"+clientIP(r), userKey)
			apiError(w, 502, "cluster_unreachable", "could not reach "+c.Name)
			return
		}
		s.securityEvent(user, c.ID, "auth.login", "Login failed for "+user, false, map[string]string{"ip": clientIP(r)})
		apiError(w, 401, "login_failed", "login failed")
		return
	}
	s.limiter.succeed("ip|"+clientIP(r), userKey)
	if old, err := s.cred(ss, c.ID); err == nil {
		s.revokeToken(ctx, old, "replaced by a new login")
	}
	if err := s.addLogin(ctx, ss, c, t); err != nil {
		apiError(w, 502, "credential_failed", err.Error())
		return
	}
	s.dropView(ss.id, c.ID)
	writeJSON(w, 200, s.meView(r.Context(), ss))
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, ss *session) {
	if creds, err := s.store.Creds(ss.id, ss.key); err == nil {
		for _, cr := range creds {
			s.revokeToken(r.Context(), cr, "logout")
		}
	}
	_ = s.store.DeleteSession(ss.id)
	s.forgetKey(store.HashID(ss.id))
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
	creds, _ := s.store.Creds(ss.id, ss.key)
	metas, _ := s.store.CredMetas(ss.id)
	now := time.Now().Unix()
	have, stored := map[string]bool{}, map[string]bool{}
	for _, c := range creds {
		have[c.ClusterID] = c.Expires > now
	}
	for _, m := range metas {
		stored[m.ClusterID] = true
	}
	list := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		// loginExpired: this session had a login here that lapsed (e.g. its
		// ticket expired while the session was idle): ask for the password again.
		e := map[string]any{"id": c.ID, "name": c.Name, "authed": have[c.ID], "admin": false,
			"loginExpired": stored[c.ID] && !have[c.ID], "credentialMode": defaultMode(c.CredentialMode)}
		if have[c.ID] {
			if v := s.view(ctx, ss, c.ID); v != nil {
				e["admin"] = v.sysModify
			} else if _, err := s.cred(ss, c.ID); err != nil {
				// PVE refused the login just now (expired, or revoked in PVE)
				e["authed"], e["loginExpired"] = false, true
			}
		}
		list = append(list, e)
	}
	return map[string]any{"user": ss.user, "csrf": ss.csrf, "clusters": list, "version": Version,
		"galleyAdmin": s.galleyAdmin(ctx, ss), "expires": ss.expires, "maxExpires": ss.created + int64(s.opt.SessionMax.Seconds())}
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, ss *session) {
	writeJSON(w, 200, s.meView(r.Context(), ss))
}

// ---- realms and OpenID Connect ----

func (s *Server) realms(w http.ResponseWriter, r *http.Request) {
	ipKey := "realms|" + clientIP(r)
	if s.rateLimited(w, ipKey) {
		return
	}
	s.limiter.succeed(ipKey)
	base, _, err := s.baseClient(r.URL.Query().Get("cluster"))
	if err != nil {
		apiError(w, 404, "not_found", "unknown cluster")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rs, err := base.Realms(ctx)
	if err != nil {
		apiError(w, 502, "cluster_unreachable", "could not reach the cluster")
		return
	}
	writeJSON(w, 200, rs)
}

const oidcCookie = "galley_oidc"

type oidcPending struct {
	cluster, redirect, bind string
	exp                     time.Time
}

func (s *Server) publicBase(r *http.Request) string {
	if s.opt.PublicURL != "" {
		return strings.TrimRight(s.opt.PublicURL, "/")
	}
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
	ipKey := "oidc|" + clientIP(r)
	if s.rateLimited(w, ipKey) {
		return
	}
	s.limiter.succeed(ipKey)
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
		apiError(w, 502, "openid_failed", "the cluster could not start single sign-on for this realm")
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
	// Bind the flow to this browser: the callback must present this cookie,
	// so a callback URL from someone else's login cannot log this browser in.
	bind := randHex(16)
	s.mu.Lock()
	s.oidc[state] = oidcPending{cluster: req.ClusterID, redirect: redirect, bind: store.HashID(bind), exp: time.Now().Add(10 * time.Minute)}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: oidcCookie, Value: bind, Path: "/api/login/openid", HttpOnly: true, Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 600})
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
	bc, cerr := r.Cookie(oidcCookie)
	http.SetCookie(w, &http.Cookie{Name: oidcCookie, Value: "", Path: "/api/login/openid", MaxAge: -1, HttpOnly: true, Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode})
	if !ok || time.Now().After(p.exp) || code == "" || cerr != nil || store.HashID(bc.Value) != p.bind {
		fail("single sign-on expired or was not started in this browser; try again")
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
		fail("single sign-on failed")
		return
	}
	ss, err := s.startSession(w, t.User, c.ID)
	if err != nil {
		fail("could not create a session")
		return
	}
	if err := s.addLogin(ctx, ss, c, t); err != nil {
		_ = s.store.DeleteSession(ss.id)
		s.forgetKey(store.HashID(ss.id))
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.opt.SecureCookies, SameSite: http.SameSiteLaxMode})
		fail("signed in, but galley could not store the login: " + err.Error())
		return
	}
	s.securityEvent(t.User, c.ID, "auth.login", "Logged in as "+t.User+" with single sign-on", true, map[string]string{"ip": clientIP(r)})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// ---- login rate limiting ----

// limiter counts failures per key in a sliding window. allow() records a
// provisional failure *before* the attempt and succeed() withdraws it, so
// parallel guesses cannot outrun the budget. A per-key attempt cap per minute
// also throttles floods.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time // attempts in the last minute
	errs map[string][]time.Time // failures (incl. in-flight) in the window
}

const (
	limWindow      = 15 * time.Minute
	limFailures    = 10 // failures per key per window
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

// allow admits an attempt and provisionally counts it as a failure.
func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.errs[key] = prune(l.errs[key], now.Add(-limWindow))
	l.hits[key] = prune(l.hits[key], now.Add(-time.Minute))
	if len(l.errs[key]) >= limFailures || len(l.hits[key]) >= limAttemptsMin {
		return false
	}
	l.hits[key] = append(l.hits[key], now)
	l.errs[key] = append(l.errs[key], now)
	return true
}

// fail is kept for callers that did not go through allow (setup code).
func (l *limiter) fail(key string, now time.Time) {
	l.mu.Lock()
	l.errs[key] = append(l.errs[key], now)
	l.mu.Unlock()
}

// succeed withdraws the provisional failure of one attempt per key.
func (l *limiter) succeed(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		if e := l.errs[k]; len(e) > 0 {
			l.errs[k] = e[:len(e)-1]
		}
	}
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
