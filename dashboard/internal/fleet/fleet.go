// Package fleet polls every registered cluster with its read-only service token
// and maintains a cached, change-notified view: nodes, guests, storage, Ceph, HA,
// backup coverage, tasks, and health findings.
package fleet

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// ---- API read models (see docs/api.md) ----

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

type Ceph struct {
	Health     string `json:"health"`
	OSDsUp     int    `json:"osdsUp"`
	OSDsIn     int    `json:"osdsIn"`
	OSDsTotal  int    `json:"osdsTotal"`
	UsedBytes  int64  `json:"usedBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

type Storage struct {
	ID     string `json:"id"`
	Node   string `json:"node"`
	Type   string `json:"type"`
	Shared bool   `json:"shared"`
	Used   int64  `json:"used"`
	Total  int64  `json:"total"`
	Active bool   `json:"active"`
}

type HA struct {
	Quorum    bool `json:"quorum"`
	Resources int  `json:"resources"`
	Errors    int  `json:"errors"`
}

type Backups struct {
	Covered     int   `json:"covered"`
	Total       int   `json:"total"`
	Unprotected []int `json:"unprotected"`
}

type ClusterSummary struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Quorate bool      `json:"quorate"`
	Nodes   []Node    `json:"nodes"`
	Ceph    *Ceph     `json:"ceph"`
	Storage []Storage `json:"storage"`
	HA      HA        `json:"ha"`
	Backups Backups   `json:"backups"`
}

type Fix struct {
	Action string         `json:"action"`
	Params map[string]any `json:"params"`
	Label  string         `json:"label"`
}

type Finding struct {
	ID        string `json:"id"`
	Level     string `json:"level"` // INFO | WARN | CRIT
	Check     string `json:"check"`
	ClusterID string `json:"clusterId"`
	Where     string `json:"where"`
	Message   string `json:"message"`
	Fix       *Fix   `json:"fix,omitempty"`
}

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

type Totals struct {
	Clusters    int `json:"clusters"`
	Nodes       int `json:"nodes"`
	NodesOnline int `json:"nodesOnline"`
	Guests      int `json:"guests"`
	Running     int `json:"running"`
}

type Fleet struct {
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

// snapshot is one cluster's polled state.
type snapshot struct {
	summary   ClusterSummary
	guests    []Guest
	tasks     []Task
	findings  []Finding
	status    ClusterStatus
	backupJob string // first enabled job usable for backup.protect
}

// Event is published to subscribers when cached state changes.
type Event struct {
	Name string // "fleet" | "tasks"
	Data any
}

// Poller owns the cache.
type Poller struct {
	store    *store.Store
	interval time.Duration
	log      *slog.Logger

	mu       sync.RWMutex
	snaps    map[string]*snapshot
	clients  map[string]*pve.Client
	lastHash map[string][32]byte
	subs     map[chan Event]struct{}
	slow     map[string]time.Time // per-cluster time of last slow poll (node details)
	nodeInfo map[string]map[string]nodeExtra
}

// nodeExtra holds slow-changing per-node facts refreshed about once a minute.
type nodeExtra struct {
	Kernel, PVEVersion string
	Updates            int
}

// NewPoller creates a poller. Call Run to start it.
func NewPoller(s *store.Store, interval time.Duration, log *slog.Logger) *Poller {
	return &Poller{
		store: s, interval: interval, log: log,
		snaps: map[string]*snapshot{}, clients: map[string]*pve.Client{},
		lastHash: map[string][32]byte{}, subs: map[chan Event]struct{}{},
		slow: map[string]time.Time{}, nodeInfo: map[string]map[string]nodeExtra{},
	}
}

// ServiceClient returns the read-only client for a cluster.
func (p *Poller) ServiceClient(id string) *pve.Client {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.clients[id]
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

// Run polls until ctx is cancelled.
func (p *Poller) Run(ctx context.Context) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	p.PollAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.PollAll(ctx)
		}
	}
}

// PollAll refreshes every cluster concurrently and publishes changes.
func (p *Poller) PollAll(ctx context.Context) {
	clusters, err := p.store.Clusters()
	if err != nil {
		p.log.Error("load clusters", "err", err)
		return
	}
	live := map[string]bool{}
	var wg sync.WaitGroup
	for _, c := range clusters {
		live[c.ID] = true
		p.mu.Lock()
		if p.clients[c.ID] == nil {
			p.clients[c.ID] = pve.New(c.Endpoints, pve.TokenAuth{ID: c.TokenID, Secret: c.TokenSecret})
		}
		cl := p.clients[c.ID]
		p.mu.Unlock()
		wg.Add(1)
		go func(c store.Cluster, cl *pve.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			snap := p.pollCluster(cctx, c, cl)
			p.mu.Lock()
			p.snaps[c.ID] = snap
			p.mu.Unlock()
		}(c, cl)
	}
	wg.Wait()
	p.mu.Lock()
	for id := range p.snaps {
		if !live[id] {
			delete(p.snaps, id)
			delete(p.clients, id)
		}
	}
	p.mu.Unlock()
	// Fleet is always published so clients see a fresh updatedAt (liveness); it is small.
	p.publish(Event{Name: "fleet", Data: p.Fleet()})
	p.publishIfChanged("tasks", p.Tasks("", 50))
}

// Forget drops cached state for a removed cluster.
func (p *Poller) Forget(id string) {
	p.mu.Lock()
	delete(p.snaps, id)
	delete(p.clients, id)
	p.mu.Unlock()
}

func (p *Poller) publishIfChanged(name string, v any) {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	p.mu.Lock()
	changed := p.lastHash[name] != h
	p.lastHash[name] = h
	p.mu.Unlock()
	if changed {
		p.publish(Event{Name: name, Data: v})
	}
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

func (p *Poller) pollCluster(ctx context.Context, c store.Cluster, cl *pve.Client) *snapshot {
	s := &snapshot{summary: ClusterSummary{ID: c.ID, Name: c.Name, Nodes: []Node{}, Storage: []Storage{}, Backups: Backups{Unprotected: []int{}}}}
	s.status.LastPoll = time.Now().Unix()
	add := func(level, check, where, msg string, fix *Fix) {
		s.findings = append(s.findings, Finding{ID: fmt.Sprintf("%s:%s:%s", c.ID, check, where), Level: level, Check: check, ClusterID: c.ID, Where: c.Name + where, Message: msg, Fix: fix})
	}

	var st []rawStatus
	if err := cl.Get(ctx, "/cluster/status", &st); err != nil {
		s.status.Error = err.Error()
		add("CRIT", "reachability", "", "cluster API unreachable with service token: "+err.Error(), nil)
		return s
	}
	s.status.Reachable = true
	s.status.ActiveEndpoint = cl.Active()
	online := map[string]bool{}
	standalone := true
	for _, x := range st {
		switch x.Type {
		case "cluster":
			standalone = false
			s.summary.Quorate = x.Quorate == 1
			if x.Name != "" && c.Name == "" {
				s.summary.Name = x.Name
			}
		case "node":
			online[x.Name] = x.Online == 1
		}
	}
	if standalone {
		s.summary.Quorate = true
	}
	s.status.Quorate = s.summary.Quorate
	if !s.summary.Quorate {
		add("CRIT", "quorum", "", "cluster is not quorate — /etc/pve is read-only", nil)
	}

	var res []rawResource
	if err := cl.Get(ctx, "/cluster/resources", &res); err != nil {
		s.status.Error = err.Error()
		return s
	}
	guestsPerNode := map[string]int{}
	nodes := map[string]*Node{}
	for _, r := range res {
		switch r.Type {
		case "node":
			nodes[r.Node] = &Node{Name: r.Node, Online: r.Status == "online", CPU: r.CPU, MaxCPU: int(r.MaxCPU), Mem: r.Mem, MaxMem: r.MaxMem, Uptime: r.Uptime}
		case "qemu", "lxc":
			g := Guest{ClusterID: c.ID, VMID: r.VMID, Name: r.Name, Type: r.Type, Node: r.Node, Status: r.Status,
				CPU: r.CPU, MaxCPU: r.MaxCPU, Mem: r.Mem, MaxMem: r.MaxMem, Disk: r.Disk, MaxDisk: r.MaxDisk,
				Uptime: r.Uptime, Tags: splitTags(r.Tags), Template: r.Template == 1, HAState: r.HAState}
			s.guests = append(s.guests, g)
			if !g.Template {
				guestsPerNode[r.Node]++
			}
		case "storage":
			s.summary.Storage = append(s.summary.Storage, Storage{ID: r.Storage, Node: r.Node, Type: r.Plugin, Shared: r.Shared == 1, Used: r.Disk, Total: r.MaxDisk, Active: r.Status == "available"})
		}
	}

	// slow-changing node details every ~60s
	p.mu.Lock()
	needSlow := time.Since(p.slow[c.ID]) > 60*time.Second
	if needSlow {
		p.slow[c.ID] = time.Now()
	}
	info := p.nodeInfo[c.ID]
	if info == nil {
		info = map[string]nodeExtra{}
		p.nodeInfo[c.ID] = info
	}
	p.mu.Unlock()
	for name, n := range nodes {
		n.Guests = guestsPerNode[name]
		if v, ok := online[name]; ok {
			n.Online = n.Online && v
		}
		if needSlow && n.Online {
			var ns struct {
				KVersion   string `json:"kversion"`
				PVEVersion string `json:"pveversion"`
			}
			ex := nodeExtra{}
			if cl.Get(ctx, "/nodes/"+name+"/status", &ns) == nil {
				ex.Kernel = ns.KVersion
				if f := strings.Fields(ns.KVersion); len(f) > 1 {
					ex.Kernel = f[1]
				}
				ex.PVEVersion = ns.PVEVersion
			}
			var upd []json.RawMessage
			if cl.Get(ctx, "/nodes/"+name+"/apt/update", &upd) == nil {
				ex.Updates = len(upd)
			}
			p.mu.Lock()
			info[name] = ex
			p.mu.Unlock()
		}
		p.mu.RLock()
		ex := info[name]
		p.mu.RUnlock()
		n.Kernel, n.PVEVersion = ex.Kernel, ex.PVEVersion
		if ex.Updates > 0 {
			add("INFO", "updates", "/"+name, fmt.Sprintf("%d package updates pending", ex.Updates), nil)
		}
		if !n.Online {
			add("CRIT", "node-offline", "/"+name, "node is offline", nil)
		}
		s.summary.Nodes = append(s.summary.Nodes, *n)
		s.status.Nodes++
		if n.Online {
			s.status.NodesOnline++
		}
	}
	sort.Slice(s.summary.Nodes, func(i, j int) bool { return s.summary.Nodes[i].Name < s.summary.Nodes[j].Name })
	sort.Slice(s.guests, func(i, j int) bool { return s.guests[i].VMID < s.guests[j].VMID })
	sort.Slice(s.summary.Storage, func(i, j int) bool {
		a, b := s.summary.Storage[i], s.summary.Storage[j]
		return a.ID+a.Node < b.ID+b.Node
	})

	// storage fill (shared storage appears once per node: report once)
	seenShared := map[string]bool{}
	for _, st := range s.summary.Storage {
		if st.Shared {
			if seenShared[st.ID] {
				continue
			}
			seenShared[st.ID] = true
		}
		where := "/" + st.ID
		if !st.Shared {
			where = "/" + st.Node + "/" + st.ID
		}
		if !st.Active {
			continue // disabled storages are reported inactive by PVE; not a finding
		}
		if st.Total > 0 {
			pct := float64(st.Used) * 100 / float64(st.Total)
			switch {
			case pct >= 90:
				add("CRIT", "storage", where, fmt.Sprintf("%.0f%% used", pct), nil)
			case pct >= 80:
				add("WARN", "storage", where, fmt.Sprintf("%.0f%% used", pct), nil)
			}
		}
	}

	// Ceph (absent on clusters without it)
	var ceph rawCeph
	if err := cl.Get(ctx, "/cluster/ceph/status", &ceph); err == nil && ceph.Health.Status != "" {
		o := ceph.osds()
		s.summary.Ceph = &Ceph{Health: ceph.Health.Status, OSDsUp: o.NumUpOSDs, OSDsIn: o.NumInOSDs, OSDsTotal: o.NumOSDs, UsedBytes: ceph.PGMap.BytesUsed, TotalBytes: ceph.PGMap.BytesTotal}
		switch ceph.Health.Status {
		case "HEALTH_OK":
		case "HEALTH_WARN":
			add("WARN", "ceph", "", "Ceph reports HEALTH_WARN", nil)
		default:
			add("CRIT", "ceph", "", "Ceph reports "+ceph.Health.Status, nil)
		}
		if o.NumUpOSDs < o.NumOSDs {
			add("CRIT", "ceph-osd", "", fmt.Sprintf("%d of %d OSDs down", o.NumOSDs-o.NumUpOSDs, o.NumOSDs), nil)
		}
	}

	// HA
	var ha []rawHA
	if err := cl.Get(ctx, "/cluster/ha/status/current", &ha); err == nil {
		for _, h := range ha {
			switch h.Type {
			case "quorum":
				s.summary.HA.Quorum = h.Quorate == 1 || strings.Contains(h.Status, "OK")
			case "service":
				s.summary.HA.Resources++
				if h.State == "error" || h.State == "fence" {
					s.summary.HA.Errors++
					add("CRIT", "ha-resource", "/"+h.ID, "HA resource in state "+h.State, nil)
				}
			}
		}
	}

	// backups: jobs + coverage
	var jobs []rawBackupJob
	if err := cl.Get(ctx, "/cluster/backup", &jobs); err == nil {
		for _, j := range jobs {
			if j.Enabled == nil || *j.Enabled == 1 {
				s.backupJob = j.ID
				break
			}
		}
	}
	var nb []rawNotBackedUp
	total := 0
	for _, g := range s.guests {
		if !g.Template && g.VMID < 99000 {
			total++
		}
	}
	s.summary.Backups.Total = total
	if err := cl.Get(ctx, "/cluster/backup-info/not-backed-up", &nb); err == nil {
		for _, g := range nb {
			if g.VMID >= 99000 {
				continue // reserved test range
			}
			s.summary.Backups.Unprotected = append(s.summary.Backups.Unprotected, g.VMID)
			var fix *Fix
			if s.backupJob != "" {
				fix = &Fix{Action: "backup.protect", Params: map[string]any{"vmids": []int{g.VMID}, "job": s.backupJob}, Label: "Add to " + s.backupJob}
			}
			name := g.Name
			if name == "" {
				name = fmt.Sprint(g.VMID)
			}
			add("WARN", "backup-coverage", fmt.Sprintf("/%d", g.VMID), fmt.Sprintf("guest %d (%s) is not in any backup job", g.VMID, name), fix)
		}
	}
	s.summary.Backups.Covered = total - len(s.summary.Backups.Unprotected)
	if len(jobs) == 0 && total > 0 {
		add("WARN", "backup-jobs", "", "no backup jobs configured", nil)
	}

	// corosync redundancy
	var cn []rawCorosyncNode
	if !standalone && cl.Get(ctx, "/cluster/config/nodes", &cn) == nil {
		var single []string
		for _, n := range cn {
			if n.Ring1 == "" {
				single = append(single, n.Name)
			}
		}
		if len(single) > 0 {
			add("WARN", "corosync-links", "", "single corosync link on "+strings.Join(single, ", ")+" — add a redundant link", nil)
		}
	}

	// firewall
	var fw struct {
		Enable int `json:"enable"`
	}
	if cl.Get(ctx, "/cluster/firewall/options", &fw) == nil && fw.Enable != 1 {
		add("WARN", "firewall", "", "datacenter firewall is disabled", nil)
	}

	// tasks
	var tasks []Task
	if cl.Get(ctx, "/cluster/tasks", &tasks) == nil {
		for i := range tasks {
			tasks[i].ClusterID = c.ID
		}
		s.tasks = tasks
	}
	return s
}

func splitTags(s string) []string {
	out := []string{}
	for _, t := range strings.FieldsFunc(s, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }) {
		out = append(out, t)
	}
	return out
}

// ---- queries ----

// Fleet assembles the current fleet view.
func (p *Poller) Fleet() Fleet {
	p.mu.RLock()
	defer p.mu.RUnlock()
	f := Fleet{UpdatedAt: time.Now().Unix(), Clusters: []ClusterSummary{}, Findings: []Finding{}}
	ids := make([]string, 0, len(p.snaps))
	for id := range p.snaps {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return p.snaps[ids[i]].summary.Name < p.snaps[ids[j]].summary.Name })
	for _, id := range ids {
		s := p.snaps[id]
		f.Clusters = append(f.Clusters, s.summary)
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
	rank := map[string]int{"CRIT": 0, "WARN": 1, "INFO": 2}
	sort.SliceStable(f.Findings, func(i, j int) bool { return rank[f.Findings[i].Level] < rank[f.Findings[j].Level] })
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
			if q != "" && !strings.Contains(strings.ToLower(g.Name), q) && !strings.Contains(fmt.Sprint(g.VMID), q) &&
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
	sort.Slice(out, func(i, j int) bool { return out[i].StartTime > out[j].StartTime })
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
