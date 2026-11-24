package fleet

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

type harness struct {
	t     *testing.T
	st    *store.Store
	fake  *fakepve.Server
	p     *Poller
	ctx   context.Context
	clust string
}

// newHarness registers one fake cluster "lab" and returns an idle poller.
func newHarness(t *testing.T, interval time.Duration) *harness {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := fakepve.New()
	t.Cleanup(f.Close)
	h := &harness{t: t, st: st, fake: f, ctx: context.Background(), clust: "lab"}
	h.addCluster("lab", "pve-lab", f)
	h.p = NewPoller(st, interval, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.p.callTimeout = 2 * time.Second
	return h
}

func (h *harness) addCluster(id, name string, f *fakepve.Server) {
	h.t.Helper()
	if err := h.st.AddCluster(store.Cluster{ID: id, Name: name, Endpoints: []pve.Endpoint{f.Endpoint()}, TokenID: f.TokenID, TokenSecret: f.Secret, CreatedAt: time.Now().Unix()}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) snap() (ClusterSummary, []Guest, []Task, []Finding) {
	h.t.Helper()
	sum, g, ts, fs, ok := h.p.Snapshot(h.clust)
	if !ok {
		h.t.Fatal("no snapshot")
	}
	return sum, g, ts, fs
}

func (h *harness) seq(id string) uint64 {
	h.p.mu.RLock()
	defer h.p.mu.RUnlock()
	if s := h.p.snaps[id]; s != nil {
		return s.seq
	}
	return 0
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func findAll(fs []Finding, check string) []Finding {
	var out []Finding
	for _, f := range fs {
		if f.Check == check {
			out = append(out, f)
		}
	}
	return out
}

func unknownChecks(fs []Finding) []string {
	var out []string
	for _, f := range fs {
		if strings.HasSuffix(f.Check, "-unknown") {
			out = append(out, f.Check)
		}
	}
	return out
}

func TestHappyPath(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.p.PollAll(h.ctx)

	fl := h.p.Fleet()
	want := Totals{Clusters: 1, Nodes: 3, NodesOnline: 3, Guests: 4, Running: 3}
	if fl.Totals != want {
		t.Fatalf("totals = %+v, want %+v", fl.Totals, want)
	}
	sum := fl.Clusters[0]
	if sum.Stale || sum.Errors != nil || sum.LastSuccess == 0 || sum.LastPoll != sum.LastSuccess {
		t.Fatalf("freshness: stale=%v errors=%v lastPoll=%d lastSuccess=%d", sum.Stale, sum.Errors, sum.LastPoll, sum.LastSuccess)
	}
	if fl.UpdatedAt != sum.LastSuccess {
		t.Fatalf("updatedAt = %d, want lastSuccess %d", fl.UpdatedAt, sum.LastSuccess)
	}
	if b := sum.Backups; !b.Known || b.Total != 4 || b.Covered != 3 || len(b.Unprotected) != 1 || b.Unprotected[0] != 131 {
		t.Fatalf("backups = %+v", b)
	}
	if sum.Ceph == nil || sum.Ceph.OSDsUp != 9 || !sum.HA.Quorum || sum.HA.Resources != 1 || sum.HA.Errors != 0 {
		t.Fatalf("ceph/ha = %+v %+v", sum.Ceph, sum.HA)
	}
	if u := unknownChecks(fl.Findings); len(u) != 0 {
		t.Fatalf("unexpected unknown findings %v", u)
	}
	if st := h.p.Status("lab"); !st.Reachable || st.Error != "" || st.Nodes != 3 {
		t.Fatalf("status = %+v", st)
	}
	if ids := h.p.Clusters(); len(ids) != 1 || ids[0] != "lab" {
		t.Fatalf("Clusters() = %v", ids)
	}
	if g, ok := h.p.Guest("lab", 120); !ok || g.Name != "web01" {
		t.Fatalf("Guest(120) = %+v %v", g, ok)
	}
	if n := h.p.OnlineNodes("lab"); len(n) != 3 {
		t.Fatalf("OnlineNodes = %v", n)
	}
	if ts := h.p.Tasks("", 10); len(ts) != 1 || ts[0].ClusterID != "lab" {
		t.Fatalf("tasks = %+v", ts)
	}
	_, _, _, fs := h.snap()
	if len(findAll(fs, "updates")) != 1 || len(findAll(fs, "backup-coverage")) != 1 {
		t.Fatalf("findings = %+v", fs)
	}
}

func TestSnapshotReturnsCopies(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.p.PollAll(h.ctx)
	sum, g, _, fs := h.snap()
	sum.Nodes[0].Name = "mutated"
	sum.Backups.Unprotected[0] = -1
	g[0].Tags[0] = "mutated"
	for i := range fs {
		if fs[i].Fix != nil {
			fs[i].Fix.Params["job"] = "mutated"
		}
	}
	sum2, g2, _, fs2 := h.snap()
	if sum2.Nodes[0].Name == "mutated" || sum2.Backups.Unprotected[0] == -1 || g2[0].Tags[0] == "mutated" {
		t.Fatal("Snapshot shares memory with the cache")
	}
	for _, f := range fs2 {
		if f.Fix != nil && f.Fix.Params["job"] == "mutated" {
			t.Fatal("Snapshot shares finding fixes with the cache")
		}
	}
}

// TestSectionFailures checks that each failing call keeps the last good data,
// records the error, and yields a "<section>-unknown" finding.
func TestSectionFailures(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		warmup bool // poll successfully before injecting the failure
		check  string
		verify func(t *testing.T, sum ClusterSummary, guests []Guest, tasks []Task, fs []Finding, st ClusterStatus)
	}{
		{
			name: "coverage fails on first poll", path: "/cluster/backup-info/not-backed-up", check: "backup-coverage-unknown",
			verify: func(t *testing.T, sum ClusterSummary, _ []Guest, _ []Task, fs []Finding, _ ClusterStatus) {
				b := sum.Backups
				if b.Known || b.Covered == b.Total || b.Covered != 0 || len(b.Unprotected) != 0 {
					t.Fatalf("coverage must be unknown, not all covered: %+v", b)
				}
				if len(findAll(fs, "backup-coverage")) != 0 {
					t.Fatal("no coverage findings expected without data")
				}
				if sum.Stale {
					t.Fatal("status+resources succeeded; must not be stale")
				}
			},
		},
		{
			name: "coverage fails after good poll", path: "/cluster/backup-info/not-backed-up", warmup: true, check: "backup-coverage-unknown",
			verify: func(t *testing.T, sum ClusterSummary, _ []Guest, _ []Task, fs []Finding, _ ClusterStatus) {
				b := sum.Backups
				if b.Known || b.Covered == b.Total || len(b.Unprotected) != 1 || b.Unprotected[0] != 131 {
					t.Fatalf("coverage = %+v", b)
				}
				if len(findAll(fs, "backup-coverage")) != 1 {
					t.Fatal("last known unprotected guest must still be reported")
				}
			},
		},
		{
			name: "ceph fails after good poll", path: "/cluster/ceph/status", warmup: true, check: "ceph-unknown",
			verify: func(t *testing.T, sum ClusterSummary, _ []Guest, _ []Task, _ []Finding, _ ClusterStatus) {
				if sum.Ceph == nil || sum.Ceph.OSDsTotal != 9 {
					t.Fatalf("last good Ceph lost: %+v", sum.Ceph)
				}
			},
		},
		{
			name: "ha fails after good poll", path: "/cluster/ha/status/current", warmup: true, check: "ha-unknown",
			verify: func(t *testing.T, sum ClusterSummary, _ []Guest, _ []Task, _ []Finding, _ ClusterStatus) {
				if !sum.HA.Quorum || sum.HA.Resources != 1 {
					t.Fatalf("last good HA lost: %+v", sum.HA)
				}
			},
		},
		{name: "backup jobs fail", path: "/cluster/backup", check: "backup-jobs-unknown",
			verify: func(t *testing.T, _ ClusterSummary, _ []Guest, _ []Task, fs []Finding, _ ClusterStatus) {
				if len(findAll(fs, "backup-jobs")) != 0 {
					t.Fatal("unknown jobs must not be reported as 'no backup jobs'")
				}
			}},
		{name: "corosync fails", path: "/cluster/config/nodes", check: "corosync-unknown"},
		{name: "firewall fails", path: "/cluster/firewall/options", check: "firewall-unknown"},
		{
			name: "tasks fail after good poll", path: "/cluster/tasks", warmup: true, check: "tasks-unknown",
			verify: func(t *testing.T, _ ClusterSummary, _ []Guest, tasks []Task, _ []Finding, _ ClusterStatus) {
				if len(tasks) != 1 {
					t.Fatalf("last good tasks lost: %+v", tasks)
				}
			},
		},
		{
			name: "storage config fails", path: "/storage", check: "storage-config-unknown",
			verify: func(t *testing.T, _ ClusterSummary, _ []Guest, _ []Task, fs []Finding, _ ClusterStatus) {
				if len(findAll(fs, "storage-offline")) != 0 {
					t.Fatal("cannot tell disabled from offline without the storage config")
				}
			},
		},
		{name: "node details fail", path: "/nodes/pve3/apt/update", check: "node-details-unknown"},
		{
			name: "resources fail after good poll", path: "/cluster/resources", warmup: true, check: "resources-unknown",
			verify: func(t *testing.T, sum ClusterSummary, guests []Guest, _ []Task, _ []Finding, st ClusterStatus) {
				if len(guests) != 4+1 || len(sum.Nodes) != 3 {
					t.Fatalf("last good guests/nodes lost: %d guests %d nodes", len(guests), len(sum.Nodes))
				}
				if !sum.Stale || st.Error == "" {
					t.Fatalf("must be stale with error: stale=%v status=%+v", sum.Stale, st)
				}
			},
		},
		{
			name: "status fails after good poll", path: "/cluster/status", warmup: true, check: "status-unknown",
			verify: func(t *testing.T, sum ClusterSummary, guests []Guest, _ []Task, fs []Finding, st ClusterStatus) {
				if len(guests) != 5 || len(sum.Nodes) != 3 || !sum.Quorate {
					t.Fatalf("last good snapshot lost: %d guests %+v", len(guests), sum)
				}
				if !sum.Stale || sum.LastSuccess == 0 || sum.LastSuccess > sum.LastPoll {
					t.Fatalf("stale=%v lastSuccess=%d lastPoll=%d", sum.Stale, sum.LastSuccess, sum.LastPoll)
				}
				if !st.Reachable || st.Error == "" {
					t.Fatalf("API answered (500): reachable with error expected, got %+v", st)
				}
				if len(findAll(fs, "reachability")) != 0 {
					t.Fatal("API error is not unreachability")
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, time.Hour)
			if tc.warmup {
				h.p.PollAll(h.ctx)
				if u := unknownChecks(h.p.Fleet().Findings); len(u) != 0 {
					t.Fatalf("warmup produced %v", u)
				}
			}
			h.fake.SetFail(tc.path, true)
			h.p.PollAll(h.ctx)
			sum, guests, tasks, fs := h.snap()
			got := unknownChecks(fs)
			if len(got) != 1 || got[0] != tc.check {
				t.Fatalf("unknown findings = %v, want [%s]", got, tc.check)
			}
			f := findAll(fs, tc.check)[0]
			sec := strings.TrimSuffix(tc.check, "-unknown")
			if f.Level != "WARN" || !strings.HasPrefix(f.Message, "could not read ") || !strings.Contains(f.Message, "injected failure") ||
				f.Resource != (FindingResource{Kind: KindCluster}) {
				t.Fatalf("finding = %+v", f)
			}
			if sum.Errors[sec] == "" || len(sum.Errors) != 1 {
				t.Fatalf("errors = %v, want only %q", sum.Errors, sec)
			}
			if tc.verify != nil {
				tc.verify(t, sum, guests, tasks, fs, h.p.Status("lab"))
			}

			// Recovery: the next good poll clears the error.
			h.fake.SetFail(tc.path, false)
			h.p.slowEvery = 0 // refresh slow sections too
			h.p.PollAll(h.ctx)
			sum, _, _, fs = h.snap()
			if u := unknownChecks(fs); len(u) != 0 || sum.Errors != nil || sum.Stale || !sum.Backups.Known {
				t.Fatalf("after recovery: unknown=%v errors=%v stale=%v", u, sum.Errors, sum.Stale)
			}
		})
	}
}

func TestUnreachableKeepsLastGood(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.p.PollAll(h.ctx)
	h.fake.Update(func(s *fakepve.Server) { s.Down = true })
	h.p.PollAll(h.ctx)
	h.fake.Update(func(s *fakepve.Server) { s.Down = false })
	sum, guests, tasks, fs := h.snap()
	if len(guests) != 5 || len(tasks) != 1 || len(sum.Nodes) != 3 || sum.Ceph == nil {
		t.Fatalf("last good data lost: %d guests %d tasks", len(guests), len(tasks))
	}
	if !sum.Stale || sum.Backups.Known {
		t.Fatalf("stale=%v backups=%+v", sum.Stale, sum.Backups)
	}
	if st := h.p.Status("lab"); st.Reachable || st.Error == "" {
		t.Fatalf("status = %+v", st)
	}
	if len(findAll(fs, "reachability")) != 1 || fs[0].Level != "CRIT" {
		t.Fatalf("expected CRIT reachability first, got %+v", fs)
	}
	if u := unknownChecks(fs); len(u) != 1 || u[0] != "status-unknown" {
		t.Fatalf("unknown = %v", u)
	}
}

// TestSlowCallIsIndependent: one slow call times out on its own without
// eating the budget of the others.
func TestSlowCallIsIndependent(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.p.callTimeout = 300 * time.Millisecond
	h.p.PollAll(h.ctx)
	h.fake.SetDelay("/cluster/ceph/status", 2*time.Second)
	h.fake.SetDelay("/cluster/tasks", 200*time.Millisecond)
	start := time.Now()
	h.p.PollAll(h.ctx)
	if d := time.Since(start); d > 1500*time.Millisecond {
		t.Fatalf("poll took %v; calls are not independent", d)
	}
	sum, _, tasks, fs := h.snap()
	if u := unknownChecks(fs); len(u) != 1 || u[0] != "ceph-unknown" {
		t.Fatalf("unknown = %v", u)
	}
	if sum.Stale || !sum.Backups.Known || sum.Ceph == nil || len(tasks) != 1 {
		t.Fatalf("other sections must be fresh: stale=%v backups=%+v", sum.Stale, sum.Backups)
	}
}

func TestStaleAfterThreeIntervals(t *testing.T) {
	h := newHarness(t, 20*time.Millisecond)
	h.p.PollAll(h.ctx)
	if h.p.Fleet().Clusters[0].Stale {
		t.Fatal("fresh poll reported stale")
	}
	time.Sleep(100 * time.Millisecond)
	if !h.p.Fleet().Clusters[0].Stale {
		t.Fatal("no success within 3 intervals must be stale")
	}
}

func TestFleetUpdatedAtIsOldestSuccess(t *testing.T) {
	h := newHarness(t, time.Hour)
	if h.p.Fleet().UpdatedAt != 0 {
		t.Fatal("no clusters: updatedAt must be 0")
	}
	down := fakepve.New()
	t.Cleanup(down.Close)
	down.Update(func(s *fakepve.Server) { s.Down = true })
	h.addCluster("dead", "dead-lab", down)
	h.p.PollAll(h.ctx)
	fl := h.p.Fleet()
	if len(fl.Clusters) != 2 || fl.UpdatedAt != 0 {
		t.Fatalf("one cluster never succeeded: updatedAt = %d", fl.UpdatedAt)
	}
	for _, c := range fl.Clusters {
		if c.ID == "dead" && (!c.Stale || c.LastSuccess != 0 || c.LastPoll == 0) {
			t.Fatalf("dead cluster = %+v", c)
		}
	}
}

func TestStorageHealth(t *testing.T) {
	cases := []struct {
		name        string
		disableNAS  bool
		wantOffline bool
	}{
		{name: "enabled but unreachable", wantOffline: true},
		{name: "disabled", disableNAS: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, time.Hour)
			if tc.disableNAS {
				h.fake.Update(func(s *fakepve.Server) { s.StorageConfig[2]["disable"] = 1 })
			}
			h.p.PollAll(h.ctx)
			sum, _, _, fs := h.snap()
			off := findAll(fs, "storage-offline")
			if !tc.wantOffline {
				if len(off) != 0 {
					t.Fatalf("disabled storage reported: %+v", off)
				}
				for _, s := range sum.Storage {
					if s.ID == "nas-backup" && !s.Disabled {
						t.Fatal("nas-backup must be marked disabled")
					}
				}
			} else {
				if len(off) != 1 {
					t.Fatalf("storage-offline = %+v", off)
				}
				f := off[0]
				if f.Level != "CRIT" || f.Message != "storage nas-backup unreachable on nodes pve1, pve2, pve3" ||
					f.Resource != (FindingResource{Kind: KindStorage, ID: "nas-backup"}) {
					t.Fatalf("finding = %+v", f)
				}
			}
			// Fill-level findings are unchanged: local is 85% full on each node.
			if fill := findAll(fs, "storage"); len(fill) != 3 || fill[0].Level != "WARN" {
				t.Fatalf("fill findings = %+v", fill)
			}
		})
	}
}

func TestFindingAttribution(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.fake.Update(func(s *fakepve.Server) {
		s.Ring1 = false
		s.HAServices = []map[string]any{{"type": "service", "sid": "vm:121", "id": "vm:121", "node": "pve2", "state": "error"}}
	})
	h.fake.SetFail("/cluster/tasks", true)
	h.p.PollAll(h.ctx)
	_, _, _, fs := h.snap()
	cases := []struct {
		check, where string
		want         FindingResource
	}{
		{"updates", "pve-lab/pve3", FindingResource{Kind: KindNode, ID: "pve3", Node: "pve3"}},
		{"backup-coverage", "pve-lab/131", FindingResource{Kind: KindGuest, ID: "131", Node: "pve2"}},
		{"ha-resource", "pve-lab/vm:121", FindingResource{Kind: KindGuest, ID: "121", Node: "pve2"}},
		{"corosync-links", "pve-lab", FindingResource{Kind: KindCluster}},
		{"storage", "pve-lab/pve1/local", FindingResource{Kind: KindStorage, ID: "local", Node: "pve1"}},
		{"storage-offline", "pve-lab/nas-backup", FindingResource{Kind: KindStorage, ID: "nas-backup"}},
		{"tasks-unknown", "pve-lab", FindingResource{Kind: KindCluster}},
	}
	for _, tc := range cases {
		t.Run(tc.check, func(t *testing.T) {
			for _, f := range findAll(fs, tc.check) {
				if f.Where == tc.where {
					if f.Resource != tc.want {
						t.Fatalf("resource = %+v, want %+v", f.Resource, tc.want)
					}
					return
				}
			}
			t.Fatalf("no %s finding at %s in %+v", tc.check, tc.where, fs)
		})
	}
	for _, f := range fs {
		if f.Resource.Kind == "" {
			t.Fatalf("unattributed finding %+v", f)
		}
	}
}

func TestHAResourceStates(t *testing.T) {
	h := newHarness(t, time.Hour)
	h.fake.Update(func(s *fakepve.Server) {
		s.HAServices = []map[string]any{
			{"type": "service", "sid": "vm:120", "id": "vm:120", "state": "recovery"},
			{"type": "service", "sid": "vm:120", "id": "vm:120", "state": "recovery"}, // duplicate entry
			{"type": "service", "sid": "ct:131", "id": "ct:131", "state": "fence"},
			{"type": "service", "sid": "vm:121", "id": "vm:121", "state": "started"},
			{"type": "service", "id": "vm:300", "state": "stopped"}, // no sid: fall back to id
		}
	})
	h.p.PollAll(h.ctx)
	sum, _, _, fs := h.snap()
	if sum.HA.Resources != 4 || sum.HA.Errors != 2 {
		t.Fatalf("ha = %+v", sum.HA)
	}
	ha := findAll(fs, "ha-resource")
	if len(ha) != 2 {
		t.Fatalf("ha findings = %+v", ha)
	}
	for _, f := range ha {
		if f.Level != "CRIT" || f.Resource.Kind != KindGuest || f.Resource.Node == "" {
			t.Fatalf("ha finding = %+v", f)
		}
	}
}

func TestTriggerPollsPromptly(t *testing.T) {
	h := newHarness(t, time.Hour)
	ctx, cancel := context.WithCancel(h.ctx)
	done := make(chan struct{})
	go func() { h.p.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	waitFor(t, 5*time.Second, "initial poll", func() bool { return h.seq("lab") == 1 })
	h.p.Trigger("lab")
	waitFor(t, 2*time.Second, "triggered poll", func() bool { return h.seq("lab") == 2 })
	h.p.TriggerAll()
	waitFor(t, 2*time.Second, "TriggerAll poll", func() bool { return h.seq("lab") == 3 })

	// A cluster added to the store is picked up by Trigger without waiting an interval.
	other := fakepve.New()
	t.Cleanup(other.Close)
	h.addCluster("lab2", "pve-lab2", other)
	h.p.Trigger("lab2")
	waitFor(t, 2*time.Second, "new cluster poll", func() bool { return h.seq("lab2") >= 1 })
}

func TestConcurrentPollsNeverRegress(t *testing.T) {
	h := newHarness(t, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(h.ctx)
	runDone := make(chan struct{})
	go func() { h.p.Run(ctx); close(runDone) }()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				h.p.PollAll(ctx)
				h.p.Trigger("lab")
			}
		}()
	}
	var prev uint64
	deadline := time.Now().Add(700 * time.Millisecond)
	for time.Now().Before(deadline) {
		s := h.seq("lab")
		if s < prev {
			t.Fatalf("sequence regressed %d -> %d", prev, s)
		}
		prev = s
		_ = h.p.Fleet()
		time.Sleep(time.Millisecond)
	}
	close(stop)
	wg.Wait()
	cancel()
	<-runDone
	if prev < 5 {
		t.Fatalf("only %d polls happened", prev)
	}

	// An older result never overwrites a newer one.
	h.p.mu.RLock()
	st, cur := h.p.states["lab"], h.p.snaps["lab"]
	h.p.mu.RUnlock()
	h.p.commit(st, &snapshot{seq: cur.seq - 1})
	if h.seq("lab") != cur.seq {
		t.Fatal("older snapshot replaced newer one")
	}
}

func TestForgetPrunes(t *testing.T) {
	h := newHarness(t, time.Hour)
	ctx, cancel := context.WithCancel(h.ctx)
	done := make(chan struct{})
	go func() { h.p.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitFor(t, 5*time.Second, "initial poll", func() bool { return h.seq("lab") >= 1 })

	h.p.mu.RLock()
	old := h.p.states["lab"]
	h.p.mu.RUnlock()
	if old.last.nodes == nil || h.p.ServiceClient("lab") == nil {
		t.Fatal("expected per-cluster state before Forget")
	}
	if err := h.st.DeleteCluster("lab"); err != nil {
		t.Fatal(err)
	}
	h.p.Forget("lab")

	h.p.mu.RLock()
	nStates, nSnaps, cancelled := len(h.p.states), len(h.p.snaps), old.cancel == nil
	h.p.mu.RUnlock()
	if nStates != 0 || nSnaps != 0 || !cancelled {
		t.Fatalf("after Forget: %d states, %d snaps, loop cancelled=%v", nStates, nSnaps, cancelled)
	}
	if h.p.ServiceClient("lab") != nil || len(h.p.Clusters()) != 0 || len(h.p.Guests("", "", "", "")) != 0 {
		t.Fatal("Forget left queryable state")
	}
	// An in-flight poll of the forgotten cluster must not resurrect it.
	h.p.pollOnce(h.ctx, old)
	if _, _, _, _, ok := h.p.Snapshot("lab"); ok {
		t.Fatal("forgotten cluster resurrected by a late poll")
	}
}

func TestEventsDebounced(t *testing.T) {
	h := newHarness(t, time.Hour)
	ch, unsub := h.p.Subscribe()
	defer unsub()
	for range 5 {
		h.p.PollAll(h.ctx)
	}
	var fleets, tasks int
	timeout := time.After(1500 * time.Millisecond)
loop:
	for {
		select {
		case e := <-ch:
			switch e.Name {
			case "fleet":
				fleets++
				if fl := e.Data.(Fleet); len(fl.Clusters) != 1 {
					t.Fatalf("fleet event = %+v", fl)
				}
			case "tasks":
				tasks++
			}
		case <-timeout:
			break loop
		}
	}
	// 5 polls within well under a second: one immediate publish plus at most
	// one trailing publish.
	if fleets < 1 || fleets > 2 || tasks != 1 {
		t.Fatalf("got %d fleet and %d tasks events", fleets, tasks)
	}
}
