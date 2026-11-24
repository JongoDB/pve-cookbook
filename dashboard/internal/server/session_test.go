package server_test

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/server"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// sessionSecret returns the session id and secret K from a client's cookie.
func (c *client) sessionSecret() (string, []byte) {
	c.h.t.Helper()
	u, _ := url.Parse(c.h.ts.URL)
	for _, ck := range c.hc.Jar.Cookies(u) {
		if ck.Name == "galley_session" {
			id, k, ok := server.ParseCookie(ck.Value)
			if !ok {
				c.h.t.Fatalf("cookie format: %q", ck.Value)
			}
			return id, k
		}
	}
	c.h.t.Fatal("no session cookie")
	return "", nil
}

func (h *harness) restart(cs ...*client) {
	h.t.Helper()
	oldURL := h.ts.URL
	h.ts.Close()
	h.start() // new process, same database
	u1, _ := url.Parse(oldURL)
	u2, _ := url.Parse(h.ts.URL)
	for _, c := range cs {
		c.hc.Jar.SetCookies(u2, c.hc.Jar.Cookies(u1))
	}
	h.refresh()
}

func (h *harness) setCredExpiry(id string, k []byte, exp int64) string {
	h.t.Helper()
	hash := store.HashID(id)
	cr, err := h.st.CredByHash(hash, k, "pve-lab")
	if err != nil {
		h.t.Fatal(err)
	}
	cr.Expires = exp
	if err := h.st.PutCredByHash(hash, k, cr); err != nil {
		h.t.Fatal(err)
	}
	return cr.Secret
}

func (h *harness) credSecret(id string, k []byte) string {
	cr, err := h.st.CredByHash(store.HashID(id), k, "pve-lab")
	if err != nil {
		return ""
	}
	return cr.Secret
}

func TestCookieCarriesSessionSecret(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	id, k := root.sessionSecret()
	if cs, _ := h.st.Creds(id, nil); len(cs) != 0 {
		t.Fatal("credentials readable without the session secret")
	}
	if cs, _ := h.st.Creds(id, k); len(cs) != 1 || !strings.HasPrefix(cs[0].Secret, "PVE:root@pam:") {
		t.Fatalf("credentials with K: %+v", cs)
	}
	// the right id with a wrong secret is not a session
	forged := h.client()
	u, _ := url.Parse(h.ts.URL)
	bad := make([]byte, len(k))
	copy(bad, k)
	bad[0] ^= 1
	forged.hc.Jar.SetCookies(u, []*http.Cookie{{Name: "galley_session", Value: id + "." + strings.TrimRight(encodeB64URL(bad), "=")}})
	if code := forged.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("wrong secret accepted: %d", code)
	}
	// an id alone (the old cookie format) is not a session either
	forged.hc.Jar.SetCookies(u, []*http.Cookie{{Name: "galley_session", Value: id}})
	if code := forged.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("id-only cookie accepted: %d", code)
	}
	var me struct{ Expires, MaxExpires int64 }
	root.do("GET", "/api/me", nil, &me)
	if d := me.MaxExpires - time.Now().Unix(); d < int64((server.DefaultSessionMax-time.Minute).Seconds()) || d > int64(server.DefaultSessionMax.Seconds()) {
		t.Fatalf("maxExpires: %+v", me)
	}
	if d := me.Expires - time.Now().Unix(); d > int64(server.DefaultSessionIdle.Seconds()) {
		t.Fatalf("idle expiry: %+v", me)
	}
}

// After a restart galley cannot decrypt (or renew) anyone's credentials until
// the user's next request brings the session secret back.
func TestRestartCredsNeedTheCookie(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	id, k := root.sessionSecret()
	h.restart(root)
	if h.srv.KeyCached(id) {
		t.Fatal("session secret survived the restart")
	}
	old := h.setCredExpiry(id, k, time.Now().Add(10*time.Minute).Unix())
	h.srv.RenewDue()
	if got := h.credSecret(id, k); got != old {
		t.Fatalf("renewed without the session secret: %q -> %q", old, got)
	}
	// the user comes back: the request carries K, the ticket is renewed and usable
	var gs []map[string]any
	if code := root.do("GET", "/api/guests", nil, &gs); code != 200 || len(gs) == 0 {
		t.Fatalf("guests after restart: %d %d", code, len(gs))
	}
	if !h.srv.KeyCached(id) {
		t.Fatal("secret not kept for an active session")
	}
	cur := h.setCredExpiry(id, k, time.Now().Add(10*time.Minute).Unix())
	h.srv.RenewDue()
	if got := h.credSecret(id, k); got == cur || !strings.HasSuffix(got, "R") {
		t.Fatalf("background renewal skipped an active session: %q -> %q", cur, got)
	}
}

func TestRenewalSkipsIdleSessions(t *testing.T) {
	h := newHarness(t)
	h.setup()
	active := h.login("root@pam", "secret")
	idle := h.login("ops@pve", "opspass")
	aid, ak := active.sessionSecret()
	iid, ik := idle.sessionSecret()
	h.srv.AgeKeys() // both walked away ...
	active.do("GET", "/api/me", nil, nil)
	// ... and only one came back
	a0 := h.setCredExpiry(aid, ak, time.Now().Add(10*time.Minute).Unix())
	i0 := h.setCredExpiry(iid, ik, time.Now().Add(10*time.Minute).Unix())
	h.srv.RenewDue()
	if h.credSecret(aid, ak) == a0 {
		t.Fatal("active session not renewed")
	}
	if h.credSecret(iid, ik) != i0 {
		t.Fatal("idle session renewed")
	}
}

// When an idle session's ticket lapsed, the session stays valid and the
// cluster asks for a login again (409 cluster_login_required).
func TestLapsedClusterLogin(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	id, k := root.sessionSecret()
	h.setCredExpiry(id, k, time.Now().Unix()-1)
	var me struct {
		User     string
		Clusters []struct {
			ID           string
			Authed       bool
			LoginExpired bool
		}
	}
	if code := root.do("GET", "/api/me", nil, &me); code != 200 || me.User != "root@pam" {
		t.Fatalf("session ended with the ticket: %d", code)
	}
	if len(me.Clusters) != 1 || me.Clusters[0].Authed || !me.Clusters[0].LoginExpired {
		t.Fatalf("me: %+v", me)
	}
	var e struct{ Code string }
	if code := root.do("POST", "/api/plans", map[string]any{"action": "guest.start", "clusterId": "pve-lab", "params": map[string]any{"targets": []map[string]any{{"vmid": 300}}}}, &e); code != 409 || e.Code != "cluster_login_required" {
		t.Fatalf("plan with lapsed login: %d %s", code, e.Code)
	}
	if code := root.do("POST", "/api/clusters/pve-lab/login", map[string]any{"password": "secret"}, &me); code != 200 || !me.Clusters[0].Authed || me.Clusters[0].LoginExpired {
		t.Fatalf("re-login: %d %+v", code, me)
	}
}

// A running change keeps its session secret (and renews its ticket) while the
// user is idle; afterwards the secret is dropped.
func TestRunningChangeHoldsSecret(t *testing.T) {
	h := newHarness(t)
	h.setup()
	h.fake.Update(func(f *fakepve.Server) { f.TaskDuration = 600 * time.Millisecond })
	root := h.login("root@pam", "secret")
	id, _ := root.sessionSecret()
	var p plan.Plan
	root.do("POST", "/api/plans", map[string]any{"action": "guest.start", "clusterId": "pve-lab", "params": map[string]any{"targets": []map[string]any{{"vmid": 300}}}}, &p)
	var run struct{ AuditID int64 }
	if code := root.do("POST", "/api/plans/"+p.ID+"/run", map[string]any{}, &run); code != 202 {
		t.Fatalf("run: %d", code)
	}
	h.srv.AgeKeys()
	if !h.srv.KeyCached(id) {
		t.Fatal("running change lost its session secret")
	}
	// observe completion from the store, without a request that would refresh the key
	deadline := time.Now().Add(10 * time.Second)
	for {
		e, _ := h.st.AuditEntry(run.AuditID)
		if e.Status != "running" {
			if !e.OK {
				t.Fatalf("change failed: %+v", e)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("change did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// the run releases its hold just after recording the outcome
	for released := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		h.srv.AgeKeys()
		if !h.srv.KeyCached(id) {
			break
		}
		if time.Now().After(released) {
			t.Fatal("secret kept after the change finished and the user went idle")
		}
	}
}

func TestTokenCredentialMode(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	dev := h.login("dev@pve", "devpass")
	if code := dev.do("PUT", "/api/clusters/pve-lab", map[string]any{"credentialMode": "token"}, nil); code != 403 {
		t.Fatalf("non-admin changed the credential mode: %d", code)
	}
	var cv map[string]any
	if code := root.do("PUT", "/api/clusters/pve-lab", map[string]any{"credentialMode": "token"}, &cv); code != 200 || cv["credentialMode"] != "token" {
		t.Fatalf("set token mode: %d %v", code, cv)
	}
	if code := root.do("PUT", "/api/clusters/pve-lab", map[string]any{"credentialMode": "magic"}, nil); code != 400 {
		t.Fatalf("bad mode: %d", code)
	}
	if code := root.do("POST", "/api/logout", map[string]any{}, nil); code != 204 {
		t.Fatal("logout")
	}

	// login creates a per-session token; the ticket is not kept
	before := time.Now().Unix()
	dev = h.login("dev@pve", "devpass")
	toks := h.fake.UserTokens()
	if len(toks) != 1 || toks[0].User != "dev@pve" || toks[0].Privsep || toks[0].Comment != "galley session" || !strings.HasPrefix(toks[0].ID, "dev@pve!galley-") {
		t.Fatalf("tokens: %+v", toks)
	}
	if exp := toks[0].Expire - before; exp < int64(server.DefaultSessionMax.Seconds())-5 || exp > int64(server.DefaultSessionMax.Seconds())+5 {
		t.Fatalf("token expiry %d s, want the session maximum", exp)
	}
	id, k := dev.sessionSecret()
	cs, _ := h.st.Creds(id, k)
	if len(cs) != 1 || cs[0].Kind != "token" || cs[0].TokenID != toks[0].ID || cs[0].Secret != toks[0].Secret {
		t.Fatalf("stored credential: %+v", cs)
	}
	// reads and changes use the token
	var gs []map[string]any
	if code := dev.do("GET", "/api/guests", nil, &gs); code != 200 || len(gs) != 1 {
		t.Fatalf("guests: %d %v", code, gs)
	}
	e := dev.runAndWait("guest.start", map[string]any{"targets": []map[string]any{{"vmid": 121}}}, "")
	calls := h.fake.Recorded()
	if last := calls[len(calls)-1]; !e.OK || last.Token != toks[0].ID || last.User != "dev@pve" {
		t.Fatalf("change not made with the token: %+v %+v", e, last)
	}

	// PVE refuses token self-deletion here: logout defers the revocation ...
	if code := dev.do("POST", "/api/logout", map[string]any{}, nil); code != 204 {
		t.Fatal("logout")
	}
	if n := len(h.fake.UserTokens()); n != 1 {
		t.Fatalf("tokens after logout: %d", n)
	}
	if rs, _ := h.st.TokenRevocations("pve-lab", "dev@pve"); len(rs) != 1 || rs[0].TokenID != toks[0].ID {
		t.Fatalf("pending revocations: %+v", rs)
	}
	// ... and the next login's ticket deletes the old token
	dev = h.login("dev@pve", "devpass")
	toks2 := h.fake.UserTokens()
	if len(toks2) != 1 || toks2[0].ID == toks[0].ID {
		t.Fatalf("old token not revoked at next login: %+v", toks2)
	}
	if rs, _ := h.st.TokenRevocations("pve-lab", "dev@pve"); len(rs) != 0 {
		t.Fatalf("pending revocations left: %+v", rs)
	}
	// where PVE lets a token delete itself, logout revokes it at once
	h.fake.Update(func(f *fakepve.Server) { f.TokenSelfRevoke = true })
	if code := dev.do("POST", "/api/logout", map[string]any{}, nil); code != 204 {
		t.Fatal("logout")
	}
	if toks := h.fake.UserTokens(); len(toks) != 0 {
		t.Fatalf("token survived logout: %+v", toks)
	}
	if rs, _ := h.st.TokenRevocations("pve-lab", ""); len(rs) != 0 {
		t.Fatalf("pending revocations: %+v", rs)
	}
	// a token deleted in PVE ends the cluster login (not the session)
	dev = h.login("dev@pve", "devpass")
	h.fake.DeleteUserTokens() // as an administrator could in the PVE GUI
	h.srv.DropViews()         // galley re-checks within 30 s
	var me struct {
		Clusters []struct{ Authed bool }
	}
	if code := dev.do("GET", "/api/me", nil, &me); code != 200 || me.Clusters[0].Authed {
		t.Fatalf("revoked token still counts as logged in: %d %+v", code, me)
	}
}

func encodeB64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
