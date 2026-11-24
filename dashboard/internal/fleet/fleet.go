// Package fleet polls every registered cluster with its read-only service token
// and maintains a cached, change-notified view: nodes, guests, storage, Ceph, HA,
// backup coverage, tasks, and health findings.
//
// Each cluster is polled by its own goroutine (see Run), so a slow cluster never
// delays the others. Every PVE call gets its own timeout, and every section of
// the view (status, resources, Ceph, HA, ...) keeps its last good data when a
// call fails; the failure is recorded in ClusterSummary.Errors and surfaced as a
// "<section>-unknown" finding instead of silently looking healthy.
package fleet

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

const (
	// defaultCallTimeout bounds every individual PVE API call.
	defaultCallTimeout = 8 * time.Second
	// defaultSlowEvery is how often slow-changing data (node details, storage
	// configuration) is refreshed after a successful read.
	defaultSlowEvery = 60 * time.Second
	// staleAfter is the number of poll intervals without a successful
	// status+resources read after which a cluster is reported stale.
	staleAfter = 3
	// publishEvery is the minimum spacing of fleet/tasks events.
	publishEvery = time.Second
	// nodeDetailWorkers caps concurrent per-node detail requests per cluster.
	nodeDetailWorkers = 4
	// reservedVMIDs is the start of a VMID range reserved for tests; guests at
	// or above it are ignored for backup coverage.
	reservedVMIDs = 99000
)

// ---- API read models (see docs/api.md) ----

// Node is one cluster member.
type Node struct {
	Name       string  `json:"name"`
	Online     bool    `json:"online"`
	CPU        float64 `json:"cpu"`
	MaxCPU     int     `json:"maxcpu"`
	Mem        int64   `json:"mem"`
	MaxMem     int64   `json:"maxmem"`
	Uptime     int64   `json:"uptime"`
	Guests     int     `json:"guests"`
	Kernel     string  `json:"kernel,omitempty"`
	PVEVersion string  `json:"pveversion,omitempty"`
}

// Ceph summarises the hyper-converged Ceph cluster, if any.
type Ceph struct {
	Health     string `json:"health"`
	OSDsUp     int    `json:"osdsUp"`
	OSDsIn     int    `json:"osdsIn"`
	OSDsTotal  int    `json:"osdsTotal"`
	UsedBytes  int64  `json:"usedBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

// Storage is one storage as seen from one node.
type Storage struct {
	ID     string `json:"id"`
	Node   string `json:"node"`
	Type   string `json:"type"`
	Shared bool   `json:"shared"`
	Used   int64  `json:"used"`
	Total  int64  `json:"total"`
	Active bool   `json:"active"`
	// Status is PVE's raw status ("available", "unknown", ...).
	Status string `json:"status"`
	// Disabled is true when the storage configuration has disable=1. PVE
	// reports disabled storage with status "unknown", like unreachable storage.
	Disabled bool `json:"disabled,omitempty"`
}

// HA summarises the HA manager.
type HA struct {
	Quorum    bool `json:"quorum"`
	Resources int  `json:"resources"`
	Errors    int  `json:"errors"`
}

// Backups summarises backup-job coverage of guests.
type Backups struct {
	// Known is false when the coverage could not be read on the latest poll;
	// Covered is then 0 and Unprotected holds the last known list, if any.
	Known       bool  `json:"known"`
	Covered     int   `json:"covered"`
	Total       int   `json:"total"`
	Unprotected []int `json:"unprotected"`
}

// ClusterSummary is the per-cluster part of the fleet view.
type ClusterSummary struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Quorate bool      `json:"quorate"`
	Nodes   []Node    `json:"nodes"`
	Ceph    *Ceph     `json:"ceph"`
	Storage []Storage `json:"storage"`
	HA      HA        `json:"ha"`
	Backups Backups   `json:"backups"`
	// LastPoll is when the latest poll attempt started (Unix seconds).
	LastPoll int64 `json:"lastPoll"`
	// LastSuccess is when /cluster/status and /cluster/resources were last
	// both read successfully (Unix seconds, 0 = never).
	LastSuccess int64 `json:"lastSuccess"`
	// Stale is true when the latest poll could not read status+resources, or
	// none succeeded within three poll intervals; the data shown is old.
	Stale bool `json:"stale"`
	// Errors maps a section name (see Sections) to the error of its latest
	// read attempt; absent sections are current.
	Errors map[string]string `json:"errors,omitempty"`
}

// Fix is a one-click remediation proposed for a finding.
type Fix struct {
	Action string         `json:"action"`
	Params map[string]any `json:"params"`
	Label  string         `json:"label"`
}

// Resource kinds a finding can be attributed to.
const (
	KindCluster = "cluster"
	KindNode    = "node"
	KindGuest   = "guest"
	KindStorage = "storage"
)

// FindingResource identifies what a finding is about, for per-user filtering.
type FindingResource struct {
	// Kind is one of KindCluster, KindNode, KindGuest, KindStorage.
	Kind string `json:"kind"`
	// ID is the node name, the VMID in decimal, the storage id, or "" for
	// the cluster itself.
	ID string `json:"id"`
	// Node is the node the resource lives on, when meaningful (local
	// storage, a guest's current node, a node finding).
	Node string `json:"node,omitempty"`
}

// Finding is one health observation.
type Finding struct {
	ID        string          `json:"id"`
	Level     string          `json:"level"` // INFO | WARN | CRIT
	Check     string          `json:"check"`
	ClusterID string          `json:"clusterId"`
	Where     string          `json:"where"`
	Message   string          `json:"message"`
	Resource  FindingResource `json:"resource"`
	Fix       *Fix            `json:"fix,omitempty"`
}

// Guest is a VM or container.
type Guest struct {
	ClusterID string   `json:"clusterId"`
	VMID      int      `json:"vmid"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	Node      string   `json:"node"`
	Status    string   `json:"status"`
	CPU       float64  `json:"cpu"`
	MaxCPU    float64  `json:"maxcpu"`
	Mem       int64    `json:"mem"`
	MaxMem    int64    `json:"maxmem"`
	Disk      int64    `json:"disk"`
	MaxDisk   int64    `json:"maxdisk"`
	Uptime    int64    `json:"uptime"`
	Tags      []string `json:"tags"`
	Template  bool     `json:"template"`
	HAState   string   `json:"hastate,omitempty"`
}

// Task is a PVE task log entry.
type Task struct {
	ClusterID string `json:"clusterId"`
	UPID      string `json:"upid"`
	Node      string `json:"node"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	User      string `json:"user"`
	StartTime int64  `json:"starttime"`
	EndTime   int64  `json:"endtime,omitempty"`
	Status    string `json:"status,omitempty"`
}

// Totals are fleet-wide counters.
type Totals struct {
	Clusters    int `json:"clusters"`
	Nodes       int `json:"nodes"`
	NodesOnline int `json:"nodesOnline"`
	Guests      int `json:"guests"`
	Running     int `json:"running"`
}

// Fleet is the /api/fleet payload.
type Fleet struct {
	// UpdatedAt is the oldest LastSuccess across clusters (0 when there are
	// no clusters or any cluster has never been read successfully).
	UpdatedAt int64            `json:"updatedAt"`
	Totals    Totals           `json:"totals"`
	Clusters  []ClusterSummary `json:"clusters"`
	Findings  []Finding        `json:"findings"`
}

// ClusterStatus is the poller's view of connectivity, surfaced on /api/clusters.
type ClusterStatus struct {
	Reachable      bool   `json:"reachable"`
	Quorate        bool   `json:"quorate"`
	Nodes          int    `json:"nodes"`
	NodesOnline    int    `json:"nodesOnline"`
	ActiveEndpoint string `json:"activeEndpoint"`
	LastPoll       int64  `json:"lastPoll"`
	Error          string `json:"error,omitempty"`
}

// Event is published to subscribers when cached state changes.
type Event struct {
	Name string // "fleet" | "tasks"
	Data any
}

// Section names used as keys of ClusterSummary.Errors and, with an
// "-unknown" suffix, as finding checks.
const (
	SecStatus         = "status"
	SecResources      = "resources"
	SecCeph           = "ceph"
	SecHA             = "ha"
	SecBackupJobs     = "backup-jobs"
	SecBackupCoverage = "backup-coverage"
	SecCorosync       = "corosync"
	SecFirewall       = "firewall"
	SecTasks          = "tasks"
	SecStorageConfig  = "storage-config"
	SecNodeDetails    = "node-details"
)

// sectionWhat describes each section for "could not read <what>" messages.
var sectionWhat = map[string]string{
	SecStatus:         "cluster status",
	SecResources:      "cluster resources",
	SecCeph:           "Ceph status",
	SecHA:             "HA status",
	SecBackupJobs:     "backup jobs",
	SecBackupCoverage: "backup coverage",
	SecCorosync:       "corosync configuration",
	SecFirewall:       "datacenter firewall options",
	SecTasks:          "cluster tasks",
	SecStorageConfig:  "storage configuration",
	SecNodeDetails:    "node details",
}

// ---- poller state ----

// snapshot is one cluster's polled state. It is immutable once committed.
type snapshot struct {
	seq         uint64 // per-cluster poll sequence number; never decreases in p.snaps
	summary     ClusterSummary
	guests      []Guest
	tasks       []Task
	findings    []Finding
	status      ClusterStatus
	backupJob   string // first enabled job usable for backup.protect
	lastSuccess time.Time
	latestOK    bool // the poll that produced this read status and resources
}

// section is the last good result of one PVE read.
type section[T any] struct {
	val T
	ok  bool      // val holds data from at least one successful read
	at  time.Time // time of the last successful read
}

func (s *section[T]) set(v T, now time.Time) { s.val, s.ok, s.at = v, true, now }

// fresh reports whether the section was read successfully by the poll at now.
func (s *section[T]) fresh(now time.Time) bool { return s.ok && s.at.Equal(now) }

// nodeDetail holds slow-changing per-node facts.
type nodeDetail struct {
	Kernel, PVEVersion string
	Updates            int
	at                 time.Time // last complete refresh
}

// lastGood is everything a cluster's poller remembers between polls.
type lastGood struct {
	status      section[[]rawStatus]
	resources   section[[]rawResource]
	ceph        section[rawCeph]
	ha          section[[]rawHA]
	jobs        section[[]rawBackupJob]
	notBackedUp section[[]rawNotBackedUp]
	corosync    section[[]rawCorosyncNode]
	firewall    section[rawFirewall]
	tasks       section[[]Task]
	storageCfg  section[[]rawStorageCfg]
	nodes       map[string]nodeDetail
	lastSuccess time.Time
}

// clusterState is the per-cluster poller: configuration, loop control and
// remembered data. Dropping it from Poller.states releases everything.
type clusterState struct {
	id      string
	trigger chan struct{} // capacity 1: coalesces poll requests

	// guarded by Poller.mu
	cfg    store.Cluster
	cfgKey string
	client *pve.Client
	cancel context.CancelFunc // non-nil while a loop goroutine runs

	pollMu sync.Mutex // single-flight: serializes polls; guards seq and last
	seq    uint64
	last   lastGood
}

// Poller owns the cache.
type Poller struct {
	store       *store.Store
	interval    time.Duration
	log         *slog.Logger
	callTimeout time.Duration
	slowEvery   time.Duration

	mu     sync.RWMutex
	states map[string]*clusterState
	snaps  map[string]*snapshot
	subs   map[chan Event]struct{}
	runCtx context.Context // non-nil while Run is active
	loops  sync.WaitGroup
	rescan chan struct{}

	pubMu    sync.Mutex
	pubTimer *time.Timer
	lastPub  time.Time

	flushMu   sync.Mutex
	tasksHash [32]byte
}

// NewPoller creates a poller. Call Run to start it.
func NewPoller(s *store.Store, interval time.Duration, log *slog.Logger) *Poller {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return &Poller{
		store: s, interval: interval, log: log,
		callTimeout: defaultCallTimeout, slowEvery: defaultSlowEvery,
		states: map[string]*clusterState{}, snaps: map[string]*snapshot{},
		subs: map[chan Event]struct{}{}, rescan: make(chan struct{}, 1),
	}
}

// ServiceClient returns the read-only client for a cluster.
func (p *Poller) ServiceClient(id string) *pve.Client {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if st := p.states[id]; st != nil {
		return st.client
	}
	return nil
}

// Subscribe returns a channel of change events; call the cancel func to stop.
func (p *Poller) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 16)
	p.mu.Lock()
	p.subs[ch] = struct{}{}
	p.mu.Unlock()
	return ch, func() {
		p.mu.Lock()
		delete(p.subs, ch)
		p.mu.Unlock()
	}
}

func (p *Poller) publish(e Event) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for ch := range p.subs {
		select {
		case ch <- e:
		default: // slow subscriber: drop; it will get the next full snapshot
		}
	}
}

// schedulePublish arranges for fleet (and, if changed, tasks) events to be
// published, at most once per publishEvery.
func (p *Poller) schedulePublish() {
	p.pubMu.Lock()
	defer p.pubMu.Unlock()
	if p.pubTimer != nil {
		return // a publish is already pending and will see the new state
	}
	wait := max(publishEvery-time.Since(p.lastPub), 0)
	p.pubTimer = time.AfterFunc(wait, p.flush)
}

func (p *Poller) flush() {
	p.flushMu.Lock() // serializes flushes so events are never published out of order
	defer p.flushMu.Unlock()
	p.pubMu.Lock()
	p.pubTimer = nil
	p.lastPub = time.Now()
	p.pubMu.Unlock()

	p.publish(Event{Name: "fleet", Data: p.Fleet()})
	tasks := p.Tasks("", 50)
	b, _ := json.Marshal(tasks)
	if h := sha256.Sum256(b); h != p.tasksHash {
		p.tasksHash = h
		p.publish(Event{Name: "tasks", Data: tasks})
	}
}

// ---- lifecycle ----

// Run polls until ctx is cancelled: one goroutine per registered cluster,
// each polling every interval or when triggered. The store is re-scanned every
// interval (or on Trigger of an unknown cluster / TriggerAll) to start and stop
// cluster goroutines. Run returns after all cluster goroutines have stopped.
func (p *Poller) Run(ctx context.Context) {
	p.mu.Lock()
	if p.runCtx != nil {
		p.mu.Unlock()
		p.log.Error("fleet: Run is already active")
		return
	}
	p.runCtx = ctx
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.runCtx = nil
		for _, st := range p.states {
			if st.cancel != nil {
				st.cancel()
				st.cancel = nil
			}
		}
		p.mu.Unlock()
		p.loops.Wait()
	}()

	_, _ = p.rescanStore()
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.rescan:
		}
		_, _ = p.rescanStore()
	}
}

// PollAll synchronously polls every registered cluster once, concurrently,
// and returns when all polls finished. It is safe to call while Run is active:
// polls of one cluster are serialized and an older result never replaces a
// newer one.
func (p *Poller) PollAll(ctx context.Context) {
	sts, err := p.rescanStore()
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	for _, st := range sts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.pollOnce(ctx, st)
		}()
	}
	wg.Wait()
}

// Trigger requests an immediate poll of one cluster. Requests made while a
// poll is pending or running coalesce into one extra poll. An unknown id makes
// Run re-scan the store (a newly added cluster is polled as soon as its
// goroutine starts). Trigger never blocks; it only has an effect while Run is
// active.
func (p *Poller) Trigger(clusterID string) {
	p.mu.RLock()
	st := p.states[clusterID]
	p.mu.RUnlock()
	if st == nil {
		p.requestRescan()
		return
	}
	select {
	case st.trigger <- struct{}{}:
	default:
	}
}

// TriggerAll re-scans the store and requests an immediate poll of every cluster.
func (p *Poller) TriggerAll() {
	p.requestRescan()
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, st := range p.states {
		select {
		case st.trigger <- struct{}{}:
		default:
		}
	}
}

func (p *Poller) requestRescan() {
	select {
	case p.rescan <- struct{}{}:
	default:
	}
}

// Forget drops all state for a removed cluster and stops its goroutine.
func (p *Poller) Forget(id string) {
	p.mu.Lock()
	p.dropLocked(id)
	p.mu.Unlock()
	p.schedulePublish()
}

// dropLocked removes every trace of a cluster. p.mu must be held.
func (p *Poller) dropLocked(id string) {
	if st := p.states[id]; st != nil && st.cancel != nil {
		st.cancel()
		st.cancel = nil
	}
	delete(p.states, id)
	delete(p.snaps, id)
}

// rescanStore loads the registered clusters and reconciles per-cluster state.
func (p *Poller) rescanStore() ([]*clusterState, error) {
	clusters, err := p.store.Clusters()
	if err != nil {
		p.log.Error("load clusters", "err", err)
		return nil, err
	}
	return p.reconcile(clusters), nil
}

// clusterKey identifies the connection settings of a cluster; a change
// replaces its client.
func clusterKey(c store.Cluster) string {
	var b strings.Builder
	for _, e := range c.Endpoints {
		b.WriteString(e.Host + "|" + e.Fingerprint + "|")
	}
	b.WriteString(c.TokenID + "|" + c.TokenSecret)
	return b.String()
}

// reconcile creates state for new clusters, refreshes changed ones, drops
// vanished ones, and (while Run is active) starts missing loop goroutines.
func (p *Poller) reconcile(clusters []store.Cluster) []*clusterState {
	p.mu.Lock()
	defer p.mu.Unlock()
	live := make(map[string]bool, len(clusters))
	out := make([]*clusterState, 0, len(clusters))
	for _, c := range clusters {
		live[c.ID] = true
		st := p.states[c.ID]
		if st == nil {
			st = &clusterState{id: c.ID, trigger: make(chan struct{}, 1)}
			p.states[c.ID] = st
		}
		if key := clusterKey(c); key != st.cfgKey {
			st.cfgKey = key
			st.client = pve.New(c.Endpoints, pve.TokenAuth{ID: c.TokenID, Secret: c.TokenSecret})
		}
		st.cfg = c
		if p.runCtx != nil && st.cancel == nil {
			ctx, cancel := context.WithCancel(p.runCtx)
			st.cancel = cancel
			p.loops.Add(1)
			go func() {
				defer p.loops.Done()
				p.loop(ctx, st)
			}()
		}
		out = append(out, st)
	}
	for id := range p.states {
		if !live[id] {
			p.dropLocked(id)
		}
	}
	for id := range p.snaps {
		if !live[id] {
			delete(p.snaps, id)
		}
	}
	return out
}

// loop polls one cluster every interval or when triggered, until ctx ends.
func (p *Poller) loop(ctx context.Context, st *clusterState) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		p.pollOnce(ctx, st)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-st.trigger:
		}
	}
}

// pollOnce polls a cluster (single-flight per cluster) and commits the result.
func (p *Poller) pollOnce(ctx context.Context, st *clusterState) {
	st.pollMu.Lock()
	defer st.pollMu.Unlock()
	p.mu.RLock()
	cfg, cl := st.cfg, st.client
	p.mu.RUnlock()
	if cl == nil {
		return
	}
	st.seq++
	snap := p.pollCluster(ctx, cfg, cl, &st.last)
	if ctx.Err() != nil {
		return // shutting down or caller gave up: don't publish cancellation noise
	}
	snap.seq = st.seq
	p.commit(st, snap)
}

// commit installs snap unless the cluster was forgotten meanwhile or a newer
// snapshot is already installed.
func (p *Poller) commit(st *clusterState, snap *snapshot) {
	p.mu.Lock()
	if p.states[st.id] != st {
		p.mu.Unlock()
		return
	}
	if old := p.snaps[st.id]; old != nil && old.seq >= snap.seq {
		p.mu.Unlock()
		return
	}
	p.snaps[st.id] = snap
	p.mu.Unlock()
	p.schedulePublish()
}

// ---- raw PVE shapes ----

type rawStatus struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Online  int    `json:"online"`
	Quorate int    `json:"quorate"`
	Nodes   int    `json:"nodes"`
}

type rawResource struct {
	Type     string  `json:"type"`
	ID       string  `json:"id"`
	Node     string  `json:"node"`
	Status   string  `json:"status"`
	Name     string  `json:"name"`
	VMID     int     `json:"vmid"`
	CPU      float64 `json:"cpu"`
	MaxCPU   float64 `json:"maxcpu"`
	Mem      int64   `json:"mem"`
	MaxMem   int64   `json:"maxmem"`
	Disk     int64   `json:"disk"`
	MaxDisk  int64   `json:"maxdisk"`
	Uptime   int64   `json:"uptime"`
	Tags     string  `json:"tags"`
	Template int     `json:"template"`
	HAState  string  `json:"hastate"`
	Storage  string  `json:"storage"`
	Plugin   string  `json:"plugintype"`
	Shared   int     `json:"shared"`
}

type rawCeph struct {
	Health struct {
		Status string `json:"status"`
	} `json:"health"`
	OSDMap json.RawMessage `json:"osdmap"`
	PGMap  struct {
		BytesUsed  int64 `json:"bytes_used"`
		BytesTotal int64 `json:"bytes_total"`
	} `json:"pgmap"`
}

type osdCounts struct {
	NumOSDs   int `json:"num_osds"`
	NumUpOSDs int `json:"num_up_osds"`
	NumInOSDs int `json:"num_in_osds"`
}

func (r rawCeph) osds() osdCounts {
	var flat osdCounts
	if json.Unmarshal(r.OSDMap, &flat) == nil && flat.NumOSDs > 0 {
		return flat
	}
	var nested struct {
		OSDMap osdCounts `json:"osdmap"`
	}
	_ = json.Unmarshal(r.OSDMap, &nested) // older releases nest osdmap.osdmap
	return nested.OSDMap
}

type rawHA struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	SID     string `json:"sid"`
	Node    string `json:"node"`
	Quorate int    `json:"quorate"`
	State   string `json:"state"`
	Status  string `json:"status"`
}

type rawBackupJob struct {
	ID      string `json:"id"`
	Enabled *int   `json:"enabled"`
	All     int    `json:"all"`
	VMID    string `json:"vmid"`
	Exclude string `json:"exclude"`
}

type rawNotBackedUp struct {
	VMID int    `json:"vmid"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type rawCorosyncNode struct {
	Name  string `json:"name"`
	Ring0 string `json:"ring0_addr"`
	Ring1 string `json:"ring1_addr"`
}

type rawFirewall struct {
	Enable int `json:"enable"`
}

// pveBool decodes PVE booleans, which arrive as 0/1, "0"/"1" or true/false.
type pveBool bool

func (b *pveBool) UnmarshalJSON(d []byte) error {
	s := strings.Trim(string(d), `"`)
	*b = s == "1" || s == "true"
	return nil
}

type rawStorageCfg struct {
	Storage string  `json:"storage"`
	Type    string  `json:"type"`
	Shared  pveBool `json:"shared"`
	Disable pveBool `json:"disable"`
}

type rawNodeStatus struct {
	KVersion   string `json:"kversion"`
	PVEVersion string `json:"pveversion"`
}

// ---- polling ----

// get performs one GET with its own timeout.
func (p *Poller) get(ctx context.Context, cl *pve.Client, path string, out any) error {
	cctx, cancel := context.WithTimeout(ctx, p.callTimeout)
	defer cancel()
	return cl.Get(cctx, path, out)
}

// result is the outcome of an asynchronous read.
type result[T any] struct {
	val T
	err error
}

// fetch starts an asynchronous GET into a fresh value; read it after wg.Wait.
func fetch[T any](ctx context.Context, p *Poller, wg *sync.WaitGroup, cl *pve.Client, path string) *result[T] {
	r := &result[T]{}
	wg.Add(1)
	go func() {
		defer wg.Done()
		r.err = p.get(ctx, cl, path, &r.val)
	}()
	return r
}

// merge stores a successful result as the section's last good data, or
// records the error. A nil result (not attempted) changes nothing.
func merge[T any](errs map[string]error, name string, r *result[T], s *section[T], now time.Time) {
	switch {
	case r == nil:
	case r.err != nil:
		errs[name] = r.err
	default:
		s.set(r.val, now)
	}
}

// isAPIError reports whether err is a definite answer from PVE (as opposed to
// a transport failure or timeout).
func isAPIError(err error) bool {
	var ae *pve.APIError
	return errors.As(err, &ae)
}

// pollCluster reads one cluster, updating last with every successful read,
// and derives a snapshot from the (fresh or last good) data.
func (p *Poller) pollCluster(ctx context.Context, c store.Cluster, cl *pve.Client, last *lastGood) *snapshot {
	now := time.Now()
	errs := map[string]error{}

	// /cluster/status first: if the API is unreachable, everything else would
	// just time out as well.
	var st []rawStatus
	unreachable := false
	if err := p.get(ctx, cl, "/cluster/status", &st); err != nil {
		errs[SecStatus] = err
		unreachable = !isAPIError(err)
	} else {
		last.status.set(st, now)
	}
	if !unreachable {
		p.pollSecondary(ctx, cl, last, errs, now)
	}
	if last.status.fresh(now) && last.resources.fresh(now) {
		last.lastSuccess = now
	}
	snap := derive(c, last, errs, now)
	snap.status.Reachable = !unreachable
	if !unreachable {
		snap.status.ActiveEndpoint = cl.Active()
	}
	if unreachable {
		snap.findings = append(snap.findings, newFinding(c, "CRIT", "reachability", "", "cluster API unreachable with service token: "+errs[SecStatus].Error(), clusterResource(), nil))
	}
	return snap
}

// pollSecondary reads every other section concurrently, each call with its own
// timeout, then merges the results into last.
func (p *Poller) pollSecondary(ctx context.Context, cl *pve.Client, last *lastGood, errs map[string]error, now time.Time) {
	var wg sync.WaitGroup
	res := fetch[[]rawResource](ctx, p, &wg, cl, "/cluster/resources")
	ceph := fetch[rawCeph](ctx, p, &wg, cl, "/cluster/ceph/status")
	ha := fetch[[]rawHA](ctx, p, &wg, cl, "/cluster/ha/status/current")
	jobs := fetch[[]rawBackupJob](ctx, p, &wg, cl, "/cluster/backup")
	nb := fetch[[]rawNotBackedUp](ctx, p, &wg, cl, "/cluster/backup-info/not-backed-up")
	fw := fetch[rawFirewall](ctx, p, &wg, cl, "/cluster/firewall/options")
	tasks := fetch[[]Task](ctx, p, &wg, cl, "/cluster/tasks")

	online, standalone := statusFacts(last)
	var coro *result[[]rawCorosyncNode]
	if last.status.ok && !standalone {
		coro = fetch[[]rawCorosyncNode](ctx, p, &wg, cl, "/cluster/config/nodes")
	}
	var scfg *result[[]rawStorageCfg]
	if !last.storageCfg.ok || now.Sub(last.storageCfg.at) >= p.slowEvery {
		scfg = fetch[[]rawStorageCfg](ctx, p, &wg, cl, "/storage")
	}

	// Slow-changing node details for online nodes not refreshed recently.
	if last.nodes == nil {
		last.nodes = map[string]nodeDetail{}
	}
	type nodeResult struct {
		name          string
		status        rawNodeStatus
		upd           []json.RawMessage
		errSt, errUpd error
	}
	var due []string
	for name, on := range online {
		if on && now.Sub(last.nodes[name].at) >= p.slowEvery {
			due = append(due, name)
		}
	}
	sort.Strings(due)
	nodeRes := make([]nodeResult, len(due))
	sem := make(chan struct{}, nodeDetailWorkers)
	for i, name := range due {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			r := nodeResult{name: name}
			r.errSt = p.get(ctx, cl, "/nodes/"+name+"/status", &r.status)
			r.errUpd = p.get(ctx, cl, "/nodes/"+name+"/apt/update", &r.upd)
			nodeRes[i] = r
		}()
	}
	wg.Wait()

	merge(errs, SecResources, res, &last.resources, now)
	merge(errs, SecHA, ha, &last.ha, now)
	merge(errs, SecBackupJobs, jobs, &last.jobs, now)
	merge(errs, SecBackupCoverage, nb, &last.notBackedUp, now)
	merge(errs, SecFirewall, fw, &last.firewall, now)
	merge(errs, SecCorosync, coro, &last.corosync, now)
	merge(errs, SecStorageConfig, scfg, &last.storageCfg, now)
	merge(errs, SecTasks, tasks, &last.tasks, now)

	// Clusters without Ceph answer /cluster/ceph/status with an API error. Until
	// Ceph has been seen once, such an error means "no Ceph", not "unknown".
	if ceph.err != nil && !last.ceph.ok && isAPIError(ceph.err) {
		ceph = nil
	}
	merge(errs, SecCeph, ceph, &last.ceph, now)

	var nodeErrs []string
	for _, r := range nodeRes {
		d := last.nodes[r.name]
		if r.errSt == nil {
			d.Kernel = r.status.KVersion
			if f := strings.Fields(r.status.KVersion); len(f) > 1 {
				d.Kernel = f[1]
			}
			d.PVEVersion = r.status.PVEVersion
		} else {
			nodeErrs = append(nodeErrs, r.name+": "+r.errSt.Error())
		}
		if r.errUpd == nil {
			d.Updates = len(r.upd)
		} else {
			nodeErrs = append(nodeErrs, r.name+" updates: "+r.errUpd.Error())
		}
		if r.errSt == nil && r.errUpd == nil {
			d.at = now
		}
		last.nodes[r.name] = d
	}
	if len(nodeErrs) > 0 {
		errs[SecNodeDetails] = errors.New(strings.Join(nodeErrs, "; "))
	}
	// Forget details of nodes that left the cluster.
	if last.status.fresh(now) {
		for name := range last.nodes {
			if _, ok := online[name]; !ok {
				delete(last.nodes, name)
			}
		}
	}
}

// statusFacts extracts node online flags and whether the node is standalone
// from the last good /cluster/status.
func statusFacts(last *lastGood) (online map[string]bool, standalone bool) {
	online = map[string]bool{}
	if !last.status.ok {
		return online, false
	}
	standalone = true
	for _, x := range last.status.val {
		switch x.Type {
		case "cluster":
			standalone = false
		case "node":
			online[x.Name] = x.Online == 1
		}
	}
	return online, standalone
}

func clusterResource() FindingResource { return FindingResource{Kind: KindCluster} }

func newFinding(c store.Cluster, level, check, where, msg string, r FindingResource, fix *Fix) Finding {
	return Finding{ID: fmt.Sprintf("%s:%s:%s", c.ID, check, where), Level: level, Check: check, ClusterID: c.ID,
		Where: c.Name + where, Message: msg, Resource: r, Fix: fix}
}

// derive builds a snapshot from the last good data of every section. errs
// holds the sections that failed on this poll (at now).
func derive(c store.Cluster, last *lastGood, errs map[string]error, now time.Time) *snapshot {
	s := &snapshot{summary: ClusterSummary{ID: c.ID, Name: c.Name, Nodes: []Node{}, Storage: []Storage{}, Backups: Backups{Unprotected: []int{}}}}
	sum := &s.summary
	sum.LastPoll = now.Unix()
	s.status.LastPoll = sum.LastPoll
	s.lastSuccess = last.lastSuccess
	if !last.lastSuccess.IsZero() {
		sum.LastSuccess = last.lastSuccess.Unix()
	}
	s.latestOK = last.status.fresh(now) && last.resources.fresh(now)
	add := func(level, check, where, msg string, r FindingResource, fix *Fix) {
		s.findings = append(s.findings, newFinding(c, level, check, where, msg, r, fix))
	}

	// status
	online, standalone := statusFacts(last)
	if last.status.ok {
		sum.Quorate = standalone
		for _, x := range last.status.val {
			if x.Type == "cluster" {
				sum.Quorate = x.Quorate == 1
				if x.Name != "" && c.Name == "" {
					sum.Name = x.Name
				}
			}
		}
		if !sum.Quorate {
			add("CRIT", "quorum", "", "cluster is not quorate — /etc/pve is read-only", clusterResource(), nil)
		}
	}
	s.status.Quorate = sum.Quorate

	// resources: nodes, guests, storage
	cfg := map[string]rawStorageCfg{}
	for _, sc := range last.storageCfg.val {
		cfg[sc.Storage] = sc
	}
	guestsPerNode := map[string]int{}
	guestNode := map[int]string{}
	nodes := map[string]*Node{}
	for _, r := range last.resources.val {
		switch r.Type {
		case "node":
			nodes[r.Node] = &Node{Name: r.Node, Online: r.Status == "online", CPU: r.CPU, MaxCPU: int(r.MaxCPU), Mem: r.Mem, MaxMem: r.MaxMem, Uptime: r.Uptime}
		case "qemu", "lxc":
			g := Guest{ClusterID: c.ID, VMID: r.VMID, Name: r.Name, Type: r.Type, Node: r.Node, Status: r.Status,
				CPU: r.CPU, MaxCPU: r.MaxCPU, Mem: r.Mem, MaxMem: r.MaxMem, Disk: r.Disk, MaxDisk: r.MaxDisk,
				Uptime: r.Uptime, Tags: splitTags(r.Tags), Template: r.Template == 1, HAState: r.HAState}
			s.guests = append(s.guests, g)
			guestNode[g.VMID] = g.Node
			if !g.Template {
				guestsPerNode[r.Node]++
			}
		case "storage":
			sum.Storage = append(sum.Storage, Storage{ID: r.Storage, Node: r.Node, Type: r.Plugin, Shared: r.Shared == 1,
				Used: r.Disk, Total: r.MaxDisk, Active: r.Status == "available", Status: r.Status,
				Disabled: bool(cfg[r.Storage].Disable)})
		}
	}
	for name, n := range nodes {
		n.Guests = guestsPerNode[name]
		if v, ok := online[name]; ok {
			n.Online = n.Online && v
		}
		d := last.nodes[name]
		n.Kernel, n.PVEVersion = d.Kernel, d.PVEVersion
		nodeRes := FindingResource{Kind: KindNode, ID: name, Node: name}
		if d.Updates > 0 {
			add("INFO", "updates", "/"+name, fmt.Sprintf("%d package updates pending", d.Updates), nodeRes, nil)
		}
		if !n.Online {
			add("CRIT", "node-offline", "/"+name, "node is offline", nodeRes, nil)
		}
		sum.Nodes = append(sum.Nodes, *n)
		s.status.Nodes++
		if n.Online {
			s.status.NodesOnline++
		}
	}
	sort.Slice(sum.Nodes, func(i, j int) bool { return sum.Nodes[i].Name < sum.Nodes[j].Name })
	sort.Slice(s.guests, func(i, j int) bool { return s.guests[i].VMID < s.guests[j].VMID })
	sort.Slice(sum.Storage, func(i, j int) bool {
		a, b := sum.Storage[i], sum.Storage[j]
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return a.Node < b.Node
	})
	// Findings are sorted by level later; keep node findings in name order.
	sort.SliceStable(s.findings, func(i, j int) bool { return s.findings[i].Where < s.findings[j].Where })

	deriveStorage(c, sum.Storage, cfg, last.storageCfg.ok, add)

	// Ceph (absent on clusters without it)
	if last.ceph.ok && last.ceph.val.Health.Status != "" {
		ceph := last.ceph.val
		o := ceph.osds()
		sum.Ceph = &Ceph{Health: ceph.Health.Status, OSDsUp: o.NumUpOSDs, OSDsIn: o.NumInOSDs, OSDsTotal: o.NumOSDs, UsedBytes: ceph.PGMap.BytesUsed, TotalBytes: ceph.PGMap.BytesTotal}
		switch ceph.Health.Status {
		case "HEALTH_OK":
		case "HEALTH_WARN":
			add("WARN", "ceph", "", "Ceph reports HEALTH_WARN", clusterResource(), nil)
		default:
			add("CRIT", "ceph", "", "Ceph reports "+ceph.Health.Status, clusterResource(), nil)
		}
		if o.NumUpOSDs < o.NumOSDs {
			add("CRIT", "ceph-osd", "", fmt.Sprintf("%d of %d OSDs down", o.NumOSDs-o.NumUpOSDs, o.NumOSDs), clusterResource(), nil)
		}
	}

	// HA
	if last.ha.ok {
		seen := map[string]bool{}
		for _, h := range last.ha.val {
			switch h.Type {
			case "quorum":
				sum.HA.Quorum = h.Quorate == 1 || strings.Contains(h.Status, "OK")
			case "service":
				sid := h.SID
				if sid == "" {
					sid = h.ID
				}
				if sid == "" || seen[sid] {
					continue
				}
				seen[sid] = true
				sum.HA.Resources++
				switch h.State {
				case "error", "fence", "recovery":
					sum.HA.Errors++
					vmid := sid[strings.LastIndexByte(sid, ':')+1:]
					node := h.Node
					if id, err := strconv.Atoi(vmid); err == nil && node == "" {
						node = guestNode[id]
					}
					add("CRIT", "ha-resource", "/"+sid, "HA resource "+sid+" in state "+h.State, FindingResource{Kind: KindGuest, ID: vmid, Node: node}, nil)
				}
			}
		}
		if sum.HA.Resources > 0 && !sum.HA.Quorum && sum.Quorate {
			add("CRIT", "ha-quorum", "", "HA manager reports no quorum — HA resources are not managed", clusterResource(), nil)
		}
	}

	// backups: jobs + coverage
	for _, j := range last.jobs.val {
		if j.Enabled == nil || *j.Enabled == 1 {
			s.backupJob = j.ID
			break
		}
	}
	total := 0
	for _, g := range s.guests {
		if !g.Template && g.VMID < reservedVMIDs {
			total++
		}
	}
	sum.Backups.Total = total
	sum.Backups.Known = last.notBackedUp.fresh(now)
	for _, g := range last.notBackedUp.val {
		if g.VMID >= reservedVMIDs {
			continue // reserved test range
		}
		sum.Backups.Unprotected = append(sum.Backups.Unprotected, g.VMID)
		var fix *Fix
		if s.backupJob != "" {
			fix = &Fix{Action: "backup.protect", Params: map[string]any{"vmids": []int{g.VMID}, "job": s.backupJob}, Label: "Add to " + s.backupJob}
		}
		name := g.Name
		if name == "" {
			name = strconv.Itoa(g.VMID)
		}
		add("WARN", "backup-coverage", fmt.Sprintf("/%d", g.VMID), fmt.Sprintf("guest %d (%s) is not in any backup job", g.VMID, name),
			FindingResource{Kind: KindGuest, ID: strconv.Itoa(g.VMID), Node: guestNode[g.VMID]}, fix)
	}
	if sum.Backups.Known {
		sum.Backups.Covered = max(total-len(sum.Backups.Unprotected), 0)
	}
	if last.jobs.ok && len(last.jobs.val) == 0 && total > 0 {
		add("WARN", "backup-jobs", "", "no backup jobs configured", clusterResource(), nil)
	}

	// corosync redundancy
	if last.status.ok && !standalone && last.corosync.ok {
		var single []string
		for _, n := range last.corosync.val {
			if n.Ring1 == "" {
				single = append(single, n.Name)
			}
		}
		if len(single) > 0 {
			add("WARN", "corosync-links", "", "single corosync link on "+strings.Join(single, ", ")+" — add a redundant link", clusterResource(), nil)
		}
	}

	// firewall
	if last.firewall.ok && last.firewall.val.Enable != 1 {
		add("WARN", "firewall", "", "datacenter firewall is disabled", clusterResource(), nil)
	}

	// tasks
	s.tasks = make([]Task, len(last.tasks.val))
	for i, t := range last.tasks.val {
		t.ClusterID = c.ID
		s.tasks[i] = t
	}

	// sections that could not be read on this poll
	if len(errs) > 0 {
		sum.Errors = make(map[string]string, len(errs))
		names := make([]string, 0, len(errs))
		for name, err := range errs {
			sum.Errors[name] = err.Error()
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			add("WARN", name+"-unknown", "", "could not read "+sectionWhat[name]+": "+sum.Errors[name], clusterResource(), nil)
		}
		if e := sum.Errors[SecStatus]; e != "" {
			s.status.Error = e
		} else {
			s.status.Error = sum.Errors[SecResources]
		}
	}
	return s
}

// deriveStorage adds fill-level and offline findings. Shared storage appears
// once per node in /cluster/resources and is reported once.
func deriveStorage(c store.Cluster, storage []Storage, cfg map[string]rawStorageCfg, cfgKnown bool, add func(level, check, where, msg string, r FindingResource, fix *Fix)) {
	seenShared := map[string]bool{}
	offShared := map[string][]string{}
	var offOrder []string
	for _, st := range storage {
		res := FindingResource{Kind: KindStorage, ID: st.ID}
		where := "/" + st.ID
		if !st.Shared {
			res.Node = st.Node
			where = "/" + st.Node + "/" + st.ID
		}
		// Offline: enabled in the configuration but not available. Without the
		// configuration, disabled and unreachable storage are indistinguishable.
		if cs, ok := cfg[st.ID]; cfgKnown && ok && !bool(cs.Disable) && st.Status != "available" {
			if st.Shared {
				if len(offShared[st.ID]) == 0 {
					offOrder = append(offOrder, st.ID)
				}
				offShared[st.ID] = append(offShared[st.ID], st.Node)
			} else {
				add("CRIT", "storage-offline", where, fmt.Sprintf("storage %s unreachable on node %s", st.ID, st.Node), res, nil)
			}
		}
		if st.Shared {
			if seenShared[st.ID] {
				continue
			}
			seenShared[st.ID] = true
		}
		if !st.Active || st.Total <= 0 {
			continue
		}
		pct := float64(st.Used) * 100 / float64(st.Total)
		switch {
		case pct >= 90:
			add("CRIT", "storage", where, fmt.Sprintf("%.0f%% used", pct), res, nil)
		case pct >= 80:
			add("WARN", "storage", where, fmt.Sprintf("%.0f%% used", pct), res, nil)
		}
	}
	for _, id := range offOrder {
		nodes := offShared[id]
		word := "node"
		if len(nodes) > 1 {
			word = "nodes"
		}
		add("CRIT", "storage-offline", "/"+id, fmt.Sprintf("storage %s unreachable on %s %s", id, word, strings.Join(nodes, ", ")),
			FindingResource{Kind: KindStorage, ID: id}, nil)
	}
}

func splitTags(s string) []string {
	out := []string{}
	for _, t := range strings.FieldsFunc(s, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }) {
		out = append(out, t)
	}
	return out
}

// ---- queries ----

// isStale reports whether s should be shown as stale at now.
func (p *Poller) isStale(s *snapshot, now time.Time) bool {
	return !s.latestOK || s.lastSuccess.IsZero() || now.Sub(s.lastSuccess) > staleAfter*p.interval
}

// view returns the summary with Stale evaluated at now. p.mu must be held.
func (p *Poller) view(s *snapshot, now time.Time) ClusterSummary {
	sum := s.summary
	sum.Stale = p.isStale(s, now)
	return sum
}

// sortedIDsLocked returns cluster ids ordered by name, then id. p.mu must be held.
func (p *Poller) sortedIDsLocked() []string {
	ids := make([]string, 0, len(p.snaps))
	for id := range p.snaps {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := p.snaps[ids[i]].summary.Name, p.snaps[ids[j]].summary.Name
		if a != b {
			return a < b
		}
		return ids[i] < ids[j]
	})
	return ids
}

var levelRank = map[string]int{"CRIT": 0, "WARN": 1, "INFO": 2}

// Fleet assembles the current fleet view.
func (p *Poller) Fleet() Fleet {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	f := Fleet{Clusters: []ClusterSummary{}, Findings: []Finding{}}
	first := true
	for _, id := range p.sortedIDsLocked() {
		s := p.snaps[id]
		if ls := s.summary.LastSuccess; first || ls < f.UpdatedAt {
			f.UpdatedAt = ls
			first = false
		}
		f.Clusters = append(f.Clusters, p.view(s, now))
		f.Findings = append(f.Findings, s.findings...)
		f.Totals.Clusters++
		f.Totals.Nodes += s.status.Nodes
		f.Totals.NodesOnline += s.status.NodesOnline
		for _, g := range s.guests {
			if g.Template {
				continue
			}
			f.Totals.Guests++
			if g.Status == "running" {
				f.Totals.Running++
			}
		}
	}
	sort.SliceStable(f.Findings, func(i, j int) bool { return levelRank[f.Findings[i].Level] < levelRank[f.Findings[j].Level] })
	return f
}

// Clusters returns the ids of clusters that have a snapshot, ordered by name.
func (p *Poller) Clusters() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sortedIDsLocked()
}

// Snapshot returns deep copies of one cluster's summary, guests, tasks and
// findings (findings ordered by severity). ok is false if there is no snapshot.
func (p *Poller) Snapshot(clusterID string) (sum ClusterSummary, guests []Guest, tasks []Task, findings []Finding, ok bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	s := p.snaps[clusterID]
	if s == nil {
		return ClusterSummary{}, nil, nil, nil, false
	}
	sum = cloneSummary(p.view(s, time.Now()))
	guests = make([]Guest, len(s.guests))
	for i, g := range s.guests {
		g.Tags = append([]string{}, g.Tags...)
		guests[i] = g
	}
	tasks = append([]Task{}, s.tasks...)
	findings = make([]Finding, len(s.findings))
	for i, f := range s.findings {
		findings[i] = cloneFinding(f)
	}
	sort.SliceStable(findings, func(i, j int) bool { return levelRank[findings[i].Level] < levelRank[findings[j].Level] })
	return sum, guests, tasks, findings, true
}

func cloneSummary(s ClusterSummary) ClusterSummary {
	s.Nodes = append([]Node{}, s.Nodes...)
	s.Storage = append([]Storage{}, s.Storage...)
	if s.Ceph != nil {
		c := *s.Ceph
		s.Ceph = &c
	}
	s.Backups.Unprotected = append([]int{}, s.Backups.Unprotected...)
	if s.Errors != nil {
		e := make(map[string]string, len(s.Errors))
		for k, v := range s.Errors {
			e[k] = v
		}
		s.Errors = e
	}
	return s
}

func cloneFinding(f Finding) Finding {
	if f.Fix != nil {
		fx := *f.Fix
		fx.Params = make(map[string]any, len(f.Fix.Params))
		for k, v := range f.Fix.Params {
			fx.Params[k] = v
		}
		f.Fix = &fx
	}
	return f
}

// Status returns the connectivity status for one cluster.
func (p *Poller) Status(id string) ClusterStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if s := p.snaps[id]; s != nil {
		return s.status
	}
	return ClusterStatus{}
}

// Guests returns guests filtered by cluster, free-text query, status and type.
func (p *Poller) Guests(cluster, q, status, typ string) []Guest {
	p.mu.RLock()
	defer p.mu.RUnlock()
	q = strings.ToLower(strings.TrimSpace(q))
	out := []Guest{}
	for id, s := range p.snaps {
		if cluster != "" && cluster != id {
			continue
		}
		for _, g := range s.guests {
			if status != "" && g.Status != status || typ != "" && g.Type != typ {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(g.Name), q) && !strings.Contains(strconv.Itoa(g.VMID), q) &&
				!strings.Contains(strings.ToLower(strings.Join(g.Tags, " ")), q) && !strings.Contains(g.Node, q) {
				continue
			}
			out = append(out, g)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ClusterID != out[j].ClusterID {
			return out[i].ClusterID < out[j].ClusterID
		}
		return out[i].VMID < out[j].VMID
	})
	return out
}

// Guest finds one guest.
func (p *Poller) Guest(cluster string, vmid int) (Guest, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if s := p.snaps[cluster]; s != nil {
		for _, g := range s.guests {
			if g.VMID == vmid {
				return g, true
			}
		}
	}
	return Guest{}, false
}

// Tasks returns the newest tasks across clusters.
func (p *Poller) Tasks(cluster string, limit int) []Task {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := []Task{}
	for id, s := range p.snaps {
		if cluster != "" && cluster != id {
			continue
		}
		out = append(out, s.tasks...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartTime != out[j].StartTime {
			return out[i].StartTime > out[j].StartTime
		}
		return out[i].UPID < out[j].UPID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// OnlineNodes lists online node names in a cluster.
func (p *Poller) OnlineNodes(cluster string) []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := []string{}
	if s := p.snaps[cluster]; s != nil {
		for _, n := range s.summary.Nodes {
			if n.Online {
				out = append(out, n.Name)
			}
		}
	}
	return out
}
