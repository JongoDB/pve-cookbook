package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/server"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

func init() { plan.TaskPoll = 20 * time.Millisecond }

type harness struct {
	t    *testing.T
	dir  string
	st   *store.Store
	fake *fakepve.Server
	srv  *server.Server
	ts   *httptest.Server
	poll *fleet.Poller
}

type client struct {
	h    *harness
	hc   *http.Client
	csrf string
}

var static = fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>galley</title>")}}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := fakepve.New()
	t.Cleanup(f.Close)
	h := &harness{t: t, dir: dir, st: st, fake: f}
	h.start()
	return h
}

func (h *harness) start() {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h.poll = fleet.NewPoller(h.st, time.Hour, log)
	h.srv = server.New(h.st, h.poll, static, log, server.Options{DataDir: h.dir})
	h.ts = httptest.NewServer(h.srv.Handler())
	h.t.Cleanup(h.ts.Close)
	h.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.srv.Shutdown(ctx)
	})
}

func (h *harness) refresh() { h.poll.PollAll(context.Background()) }

func (h *harness) client() *client {
	jar, _ := cookiejar.New(nil)
	return &client{h: h, hc: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *client) req(method, path string, body any, hdr map[string]string, out any) int {
	c.h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.h.ts.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.csrf != "" {
		req.Header.Set("X-Galley-CSRF", c.csrf)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.h.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func (c *client) do(method, path string, body, out any) int {
	return c.req(method, path, body, nil, out)
}

func (h *harness) setupToken() string {
	b, err := os.ReadFile(filepath.Join(h.dir, "setup-token"))
	if err != nil {
		h.t.Fatalf("setup token file: %v", err)
	}
	return strings.TrimSpace(string(b))
}

// setup registers the fake cluster with the setup code.
func (h *harness) setup() {
	h.t.Helper()
	c := h.client()
	ep := h.fake.Endpoint()
	hdr := map[string]string{"X-Galley-Setup-Token": h.setupToken()}
	if code := c.req("POST", "/api/clusters", map[string]any{"name": "pve-lab", "endpoints": []any{ep}, "tokenId": h.fake.TokenID, "tokenSecret": h.fake.Secret}, hdr, nil); code != 201 {
		h.t.Fatalf("add cluster: %d", code)
	}
	h.refresh()
}

func (h *harness) login(user, pass string) *client {
	h.t.Helper()
	c := h.client()
	var me struct{ CSRF, User string }
	if code := c.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": user, "password": pass}, &me); code != 200 {
		h.t.Fatalf("login %s: %d", user, code)
	}
	c.csrf = me.CSRF
	return c
}

type auditEntry struct {
	ID        int64
	User      string
	ActorUser string
	Action    string
	Status    string
	OK        bool
	Results   []plan.Result
}

// runAndWait builds and runs a plan and waits for its audit entry to finish.
func (c *client) runAndWait(action string, params any, confirm string) auditEntry {
	c.h.t.Helper()
	var p plan.Plan
	if code := c.do("POST", "/api/plans", map[string]any{"action": action, "clusterId": "pve-lab", "params": params}, &p); code != 201 {
		c.h.t.Fatalf("plan %s: %d", action, code)
	}
	var run struct {
		AuditID int64
		Status  string
	}
	if code := c.do("POST", "/api/plans/"+p.ID+"/run", map[string]any{"confirm": confirm}, &run); code != 202 || run.Status != "running" {
		c.h.t.Fatalf("run: %d %+v", code, run)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var es []auditEntry
		c.do("GET", "/api/audit?limit=50", nil, &es)
		for _, e := range es {
			if e.ID == run.AuditID && e.Status != "running" {
				return e
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	c.h.t.Fatal("change did not finish")
	return auditEntry{}
}

// ---- tests ----

func TestSetupRequiresCode(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	ep := h.fake.Endpoint()
	body := map[string]any{"name": "pve-lab", "endpoints": []any{ep}, "tokenId": h.fake.TokenID, "tokenSecret": h.fake.Secret}
	var e struct{ Code string }
	if code := c.do("POST", "/api/clusters", body, &e); code != 401 || e.Code != "setup_token_required" {
		t.Fatalf("no code: %d %s", code, e.Code)
	}
	if code := c.req("POST", "/api/clusters", body, map[string]string{"X-Galley-Setup-Token": "nope"}, &e); code != 403 || e.Code != "setup_token_invalid" {
		t.Fatalf("bad code: %d %s", code, e.Code)
	}
	h.setup()
	if _, err := os.Stat(filepath.Join(h.dir, "setup-token")); !os.IsNotExist(err) {
		t.Fatal("setup token file should be removed after setup")
	}
	// setup mode is over: anonymous registration is refused
	if code := c.req("POST", "/api/clusters", body, map[string]string{"X-Galley-Setup-Token": "x"}, nil); code != 401 {
		t.Fatalf("post-setup anonymous add: %d", code)
	}
}

func TestRejectsWriteCapableToken(t *testing.T) {
	h := newHarness(t)
	h.fake.Update(func(f *fakepve.Server) { f.TokenPerms["VM.PowerMgmt"] = 1 })
	var e struct{ Code string }
	ep := h.fake.Endpoint()
	code := h.client().req("POST", "/api/clusters", map[string]any{"name": "pve-lab", "endpoints": []any{ep}, "tokenId": h.fake.TokenID, "tokenSecret": h.fake.Secret},
		map[string]string{"X-Galley-Setup-Token": h.setupToken()}, &e)
	if code != 400 || e.Code != "token_too_powerful" {
		t.Fatalf("got %d %s", code, e.Code)
	}
}

func TestPlanRunsAsyncAndWaitsForTasks(t *testing.T) {
	h := newHarness(t)
	h.setup()
	h.fake.Update(func(f *fakepve.Server) { f.TaskDuration = 150 * time.Millisecond })
	root := h.login("root@pam", "secret")

	// Destroying a running guest: stop must finish before destroy is sent.
	e := root.runAndWait("guest.destroy", map[string]any{"targets": []map[string]any{{"vmid": 120}}}, "destroy 120")
	if !e.OK || e.Status != "ok" || len(e.Results) != 2 {
		t.Fatalf("destroy: %+v", e)
	}
	for _, r := range e.Results {
		if r.Status != "ok" || r.ExitStatus != "OK" || r.UPID == "" {
			t.Fatalf("step not tracked to completion: %+v", r)
		}
	}
	if e.ActorUser != "root@pam" || e.User != "root@pam" {
		t.Fatalf("audit identity: %+v", e)
	}
	calls := h.fake.Recorded()
	if len(calls) != 2 || !strings.HasSuffix(calls[0].Path, "/status/stop") || calls[1].Method != "DELETE" {
		t.Fatalf("calls: %+v", calls)
	}
}

func TestFailedTaskIsReportedAsFailure(t *testing.T) {
	h := newHarness(t)
	h.setup()
	h.fake.Update(func(f *fakepve.Server) {
		f.TaskExit["/nodes/pve1/qemu/300/status/start"] = "start failed: no such storage"
	})
	root := h.login("root@pam", "secret")
	e := root.runAndWait("guest.start", map[string]any{"targets": []map[string]any{{"vmid": 300}}}, "")
	if e.OK || e.Status != "error" || e.Results[0].ExitStatus != "start failed: no such storage" {
		t.Fatalf("expected failure recorded, got %+v", e)
	}
}

func TestReadsAreFilteredByPVEPermissions(t *testing.T) {
	h := newHarness(t)
	h.setup()
	dev := h.login("dev@pve", "devpass") // fake: dev sees only guest 121, no privileges on /
	var gs []fleet.Guest
	dev.do("GET", "/api/guests", nil, &gs)
	if len(gs) != 1 || gs[0].VMID != 121 {
		t.Fatalf("dev guests: %+v", gs)
	}
	var f fleet.Fleet
	dev.do("GET", "/api/fleet", nil, &f)
	if f.Totals.Guests != 1 || len(f.Clusters) != 1 || f.Clusters[0].Ceph != nil || len(f.Clusters[0].Nodes) != 0 {
		t.Fatalf("dev fleet not filtered: totals=%+v ceph=%v nodes=%d", f.Totals, f.Clusters[0].Ceph, len(f.Clusters[0].Nodes))
	}
	for _, fd := range f.Findings {
		if fd.Resource.Kind != "guest" || fd.Resource.ID != "121" {
			t.Fatalf("dev sees finding %+v", fd)
		}
	}
	var ts []fleet.Task
	dev.do("GET", "/api/tasks", nil, &ts)
	if len(ts) != 0 {
		t.Fatalf("dev sees tasks %+v", ts)
	}
	// cannot plan against an invisible guest
	if code := dev.do("POST", "/api/plans", map[string]any{"action": "guest.start", "clusterId": "pve-lab", "params": map[string]any{"targets": []map[string]any{{"vmid": 300}}}}, nil); code != 400 {
		t.Fatalf("plan on invisible guest: %d", code)
	}
	// root's audit entries are not visible to dev
	root := h.login("root@pam", "secret")
	root.runAndWait("guest.start", map[string]any{"targets": []map[string]any{{"vmid": 300}}}, "")
	var es []auditEntry
	dev.do("GET", "/api/audit", nil, &es)
	for _, e := range es {
		if e.User != "dev@pve" {
			t.Fatalf("dev sees audit of %s", e.User)
		}
	}
}

func TestClusterManagementNeedsClusterAdmin(t *testing.T) {
	h := newHarness(t)
	h.setup()
	dev := h.login("dev@pve", "devpass")
	if code := dev.do("DELETE", "/api/clusters/pve-lab", nil, nil); code != 403 {
		t.Fatalf("dev delete: %d", code)
	}
	if code := dev.do("PUT", "/api/clusters/pve-lab", map[string]any{"name": "x"}, nil); code != 403 {
		t.Fatalf("dev update: %d", code)
	}
	root := h.login("root@pam", "secret")
	var v map[string]any
	if code := root.do("PUT", "/api/clusters/pve-lab", map[string]any{"name": "lab-renamed"}, &v); code != 200 || v["name"] != "lab-renamed" {
		t.Fatalf("rename: %d %v", code, v)
	}
	var es []auditEntry
	root.do("GET", "/api/audit", nil, &es)
	found := false
	for _, e := range es {
		found = found || e.Action == "cluster.update"
	}
	if !found {
		t.Fatal("cluster update not audited")
	}
}

func TestLoginRateLimited(t *testing.T) {
	h := newHarness(t)
	h.setup()
	c := h.client()
	var last int
	var e struct {
		Code       string
		RetryAfter int
	}
	for i := 0; i < 10; i++ {
		last = c.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": "root@pam", "password": "wrong"}, &e)
	}
	if last != 429 || e.Code != "rate_limited" || e.RetryAfter <= 0 {
		t.Fatalf("expected 429 with retryAfter, got %d %+v", last, e)
	}
}

func TestCrossSiteAndContentTypeRefused(t *testing.T) {
	h := newHarness(t)
	h.setup()
	c := h.client()
	body := map[string]any{"clusterId": "pve-lab", "username": "root@pam", "password": "secret"}
	if code := c.req("POST", "/api/login", body, map[string]string{"Origin": "https://evil.example"}, nil); code != 403 {
		t.Fatalf("cross-origin login: %d", code)
	}
	if code := c.req("POST", "/api/login", body, map[string]string{"Sec-Fetch-Site": "cross-site"}, nil); code != 403 {
		t.Fatalf("cross-site login: %d", code)
	}
	if code := c.req("POST", "/api/login", body, map[string]string{"Content-Type": "text/plain"}, nil); code != 415 {
		t.Fatalf("text/plain login: %d", code)
	}
}

func TestSessionSurvivesRestartAndLogoutEndsIt(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	oldURL := h.ts.URL
	h.ts.Close()
	h.start() // new process, same database
	// carry the cookie to the new server's URL
	u1, _ := url.Parse(oldURL)
	u2, _ := url.Parse(h.ts.URL)
	root.hc.Jar.SetCookies(u2, root.hc.Jar.Cookies(u1))
	h.refresh()
	var me struct{ User string }
	if code := root.do("GET", "/api/me", nil, &me); code != 200 || me.User != "root@pam" {
		t.Fatalf("after restart: %d %+v", code, me)
	}
	if code := root.do("POST", "/api/logout", map[string]any{}, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	if code := root.do("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("after logout: %d", code)
	}
}

func TestOpenIDLogin(t *testing.T) {
	h := newHarness(t)
	h.setup()
	c := h.client()
	var realms []map[string]any
	if code := c.do("GET", "/api/realms?cluster=pve-lab", nil, &realms); code != 200 || len(realms) != 3 {
		t.Fatalf("realms: %d %v", code, realms)
	}
	var start struct{ AuthURL string }
	if code := c.do("POST", "/api/login/openid", map[string]any{"clusterId": "pve-lab", "realm": "sso"}, &start); code != 200 {
		t.Fatalf("start: %d", code)
	}
	u, _ := url.Parse(start.AuthURL)
	state := u.Query().Get("state")
	if !strings.HasSuffix(u.Query().Get("redirect_uri"), "/api/login/openid/callback") {
		t.Fatalf("redirect: %s", start.AuthURL)
	}
	if code := c.do("GET", "/api/login/openid/callback?code=good&state="+url.QueryEscape(state), nil, nil); code != 303 {
		t.Fatalf("callback: %d", code)
	}
	var me struct{ User string }
	if code := c.do("GET", "/api/me", nil, &me); code != 200 || me.User != "alice@sso" {
		t.Fatalf("me: %d %+v", code, me)
	}
	// a state can be used only once
	if code := c.do("GET", "/api/login/openid/callback?code=good&state="+url.QueryEscape(state), nil, nil); code != 303 {
		t.Fatalf("replay: %d", code)
	}
}

func TestClusterLoginMustBeSameIdentity(t *testing.T) {
	h := newHarness(t)
	h.setup()
	dev := h.login("dev@pve", "devpass")
	var e struct{ Code string }
	if code := dev.do("POST", "/api/clusters/pve-lab/login", map[string]any{"username": "root@pam", "password": "secret"}, &e); code != 400 || e.Code != "identity_mismatch" {
		t.Fatalf("got %d %s", code, e.Code)
	}
}

func TestOTPRequired(t *testing.T) {
	h := newHarness(t)
	h.setup()
	c := h.client()
	var e struct{ Code string }
	if code := c.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": "mfa@pve", "password": "mfapass"}, &e); code != 401 || e.Code != "otp_required" {
		t.Fatalf("got %d %s", code, e.Code)
	}
	if code := c.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": "mfa@pve", "password": "mfapass", "otp": "123456"}, nil); code != 200 {
		t.Fatalf("with otp: %d", code)
	}
}

func TestPrefsRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	layout := map[string]any{"widgets": []string{"quorum", "ceph"}}
	if code := root.do("PUT", "/api/prefs/dashboard", layout, nil); code != 204 {
		t.Fatalf("put: %d", code)
	}
	var got map[string]any
	if code := root.do("GET", "/api/prefs/dashboard", nil, &got); code != 200 || len(got["widgets"].([]any)) != 2 {
		t.Fatalf("get: %d %v", code, got)
	}
	dev := h.login("dev@pve", "devpass")
	if code := dev.do("GET", "/api/prefs/dashboard", nil, nil); code != 404 {
		t.Fatalf("prefs leak across users: %d", code)
	}
}

func TestHealthAndSPA(t *testing.T) {
	h := newHarness(t)
	h.setup()
	c := h.client()
	var hl map[string]any
	if code := c.do("GET", "/api/health", nil, &hl); code != 200 || hl["ok"] != true {
		t.Fatalf("health: %d %v", code, hl)
	}
	if _, has := hl["version"]; has {
		t.Fatal("unauthenticated health must not disclose the version")
	}
	resp, err := http.Get(h.ts.URL + "/guests/some/route")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "<title>galley") || resp.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatalf("spa: %s", b)
	}
}
