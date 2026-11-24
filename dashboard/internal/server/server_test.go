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
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/server"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

type harness struct {
	t    *testing.T
	fake *fakepve.Server
	ts   *httptest.Server
	hc   *http.Client
	poll *fleet.Poller
	csrf string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := fleet.NewPoller(st, time.Hour, log)
	static := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>galley</title>")}}
	srv := server.New(st, p, static, log, false)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	f := fakepve.New()
	t.Cleanup(f.Close)
	return &harness{t: t, fake: f, ts: ts, hc: &http.Client{Jar: jar}, poll: p}
}

func (h *harness) do(method, path string, body any, out any) int {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.ts.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if h.csrf != "" {
		req.Header.Set("X-Galley-CSRF", h.csrf)
	}
	resp, err := h.hc.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func (h *harness) setupAndLogin(user, pass string) {
	h.t.Helper()
	ep := h.fake.Endpoint()
	var probe struct {
		Endpoints []struct {
			Fingerprint string
			Reachable   bool
		}
	}
	if c := h.do("POST", "/api/clusters/probe", map[string]any{"endpoints": []string{ep.Host}}, &probe); c != 200 || !probe.Endpoints[0].Reachable {
		h.t.Fatalf("probe: %d %+v", c, probe)
	}
	if probe.Endpoints[0].Fingerprint != ep.Fingerprint {
		h.t.Fatal("probe fingerprint mismatch")
	}
	if c := h.do("POST", "/api/clusters", map[string]any{"name": "pve-lab", "endpoints": []any{ep}, "tokenId": h.fake.TokenID, "tokenSecret": h.fake.Secret}, nil); c != 201 {
		h.t.Fatalf("add cluster: %d", c)
	}
	h.poll.PollAll(context.Background())
	var me struct {
		User, CSRF string
		Clusters   []struct {
			ID     string
			Authed bool
		}
	}
	if c := h.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": user, "password": pass}, &me); c != 200 {
		h.t.Fatalf("login: %d", c)
	}
	h.csrf = me.CSRF
	if !me.Clusters[0].Authed {
		h.t.Fatal("cluster not authed after login")
	}
}

func TestSetupLoginFleetPlanAudit(t *testing.T) {
	h := newHarness(t)
	var setup map[string]bool
	h.do("GET", "/api/setup", nil, &setup)
	if !setup["needsSetup"] {
		t.Fatal("fresh install must need setup")
	}
	if c := h.do("GET", "/api/fleet", nil, nil); c != 401 {
		t.Fatalf("fleet without session = %d, want 401", c)
	}
	h.setupAndLogin("root", "secret")

	var fl fleet.Fleet
	h.do("GET", "/api/fleet", nil, &fl)
	if fl.Totals.Nodes != 3 || fl.Totals.Guests != 4 || len(fl.Clusters) != 1 || fl.Clusters[0].Ceph == nil || fl.Clusters[0].Ceph.OSDsUp != 9 {
		t.Fatalf("fleet = %+v", fl.Totals)
	}
	var protect *fleet.Finding
	for i, f := range fl.Findings {
		if f.Check == "backup-coverage" {
			protect = &fl.Findings[i]
		}
	}
	if protect == nil || protect.Fix == nil || protect.Fix.Action != "backup.protect" {
		t.Fatalf("expected backup-coverage finding with fix, got %+v", fl.Findings)
	}
	foundUpdates := false
	for _, f := range fl.Findings {
		if f.Check == "updates" && strings.HasSuffix(f.Where, "/pve3") {
			foundUpdates = true
		}
	}
	if !foundUpdates {
		t.Fatal("expected pending-updates finding on pve3")
	}

	// the finding's fix becomes a plan: all=1 job with exclude=131 -> exclude removed
	var p struct {
		ID    string
		Steps []struct {
			Method, Path, CLI string
			Body              map[string]string
		}
	}
	if c := h.do("POST", "/api/plans", map[string]any{"action": protect.Fix.Action, "clusterId": "pve-lab", "params": protect.Fix.Params}, &p); c != 201 {
		t.Fatalf("plan: %d", c)
	}
	if p.Steps[0].Method != "PUT" || p.Steps[0].Body["delete"] != "exclude" || !strings.Contains(p.Steps[0].CLI, "--delete exclude") {
		t.Fatalf("unexpected protect plan %+v", p.Steps)
	}

	// CSRF is enforced
	saved := h.csrf
	h.csrf = ""
	if c := h.do("POST", "/api/plans/"+p.ID+"/run", nil, nil); c != 403 {
		t.Fatalf("run without CSRF = %d, want 403", c)
	}
	h.csrf = saved

	var run struct {
		AuditID int64
		Results []struct{ OK bool }
	}
	if c := h.do("POST", "/api/plans/"+p.ID+"/run", nil, &run); c != 200 || !run.Results[0].OK {
		t.Fatalf("run: %d %+v", c, run)
	}
	if c := h.do("POST", "/api/plans/"+p.ID+"/run", nil, nil); c != 409 {
		t.Fatalf("second run = %d, want 409 (single use)", c)
	}
	calls := h.fake.Recorded()
	if len(calls) != 1 || calls[0].User != "root@pam" || calls[0].Path != "/cluster/backup/nightly-all" {
		t.Fatalf("mutation must run as the user: %+v", calls)
	}

	var audit []store.AuditEntry
	h.do("GET", "/api/audit", nil, &audit)
	if len(audit) != 1 || audit[0].User != "root@pam" || !audit[0].OK || len(audit[0].CLI) != 1 {
		t.Fatalf("audit = %+v", audit)
	}
}

func TestDestroyNeedsConfirmText(t *testing.T) {
	h := newHarness(t)
	h.setupAndLogin("root", "secret")
	var p struct {
		ID          string
		Destructive bool
		ConfirmText string
		Steps       []struct{ Description string }
	}
	h.do("POST", "/api/plans", map[string]any{"action": "guest.destroy", "clusterId": "pve-lab", "params": map[string]any{"targets": []any{map[string]any{"vmid": 120}}}}, &p)
	if !p.Destructive || p.ConfirmText != "destroy 120" || len(p.Steps) != 2 {
		t.Fatalf("destroy plan = %+v (running guest needs stop + destroy)", p)
	}
	if c := h.do("POST", "/api/plans/"+p.ID+"/run", map[string]string{"confirm": "destroy 12"}, nil); c != 400 {
		t.Fatalf("wrong confirm = %d, want 400", c)
	}
	if len(h.fake.Recorded()) != 0 {
		t.Fatal("nothing may run before confirmation")
	}
	var run struct{ Results []struct{ OK bool } }
	if c := h.do("POST", "/api/plans/"+p.ID+"/run", map[string]string{"confirm": "destroy 120"}, &run); c != 200 || len(run.Results) != 2 {
		t.Fatalf("confirmed run: %d %+v", c, run)
	}
	calls := h.fake.Recorded()
	if calls[0].Path != "/nodes/pve1/qemu/120/status/stop" || calls[1].Method != "DELETE" || calls[1].Form["purge"] != "1" {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestMigrateValidatesTargetAndUsesCacheNode(t *testing.T) {
	h := newHarness(t)
	h.setupAndLogin("root", "secret")
	if c := h.do("POST", "/api/plans", map[string]any{"action": "guest.migrate", "clusterId": "pve-lab", "params": map[string]any{"targets": []any{map[string]any{"vmid": 120}}, "target": "nope"}}, nil); c != 400 {
		t.Fatalf("bad target = %d", c)
	}
	var p struct {
		Steps []struct {
			Path, CLI string
			Body      map[string]string
		}
	}
	// client claims node pve3, cache says pve1: cache wins
	h.do("POST", "/api/plans", map[string]any{"action": "guest.migrate", "clusterId": "pve-lab", "params": map[string]any{"targets": []any{map[string]any{"vmid": 120, "node": "pve3"}}, "target": "pve2"}}, &p)
	if p.Steps[0].Path != "/nodes/pve1/qemu/120/migrate" || p.Steps[0].Body["online"] != "1" || p.Steps[0].CLI != "qm migrate 120 pve2 --online" {
		t.Fatalf("migrate plan = %+v", p.Steps)
	}
}

func TestNonAdminCannotManageClusters(t *testing.T) {
	h := newHarness(t)
	h.setupAndLogin("ops@pve", "opspass")
	if c := h.do("DELETE", "/api/clusters/pve-lab", nil, nil); c != 403 {
		t.Fatalf("non-admin delete = %d, want 403", c)
	}
	if c := h.do("POST", "/api/clusters/probe", map[string]any{"endpoints": []string{"192.0.2.1"}}, nil); c != 403 {
		t.Fatalf("non-admin probe after setup = %d, want 403", c)
	}
}

func TestOTPRequired(t *testing.T) {
	h := newHarness(t)
	h.setupAndLogin("root", "secret")
	h.hc.Jar, _ = cookiejar.New(nil)
	h.csrf = ""
	var e map[string]string
	if c := h.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": "mfa", "realm": "pve", "password": "mfapass"}, &e); c != 401 || e["code"] != "otp_required" {
		t.Fatalf("mfa without otp: %d %v", c, e)
	}
	if c := h.do("POST", "/api/login", map[string]any{"clusterId": "pve-lab", "username": "mfa", "realm": "pve", "password": "mfapass", "otp": "123456"}, nil); c != 200 {
		t.Fatalf("mfa with otp: %d", c)
	}
}

func TestSPAFallbackAndHeaders(t *testing.T) {
	h := newHarness(t)
	resp, err := h.hc.Get(h.ts.URL + "/guests/some/route")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "<title>galley</title>") || resp.Header.Get("Content-Security-Policy") == "" {
		t.Fatalf("spa fallback/headers wrong: %s %v", b, resp.Header)
	}
}
