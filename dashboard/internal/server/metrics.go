package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
)

// One metric model for every resource. PVE keeps round-robin history per
// node, guest and storage (rrddata); galley normalizes the field names and
// units so a chart can plot any metric of any resource the same way:
//
//	cpu          fraction 0–1 of the resource's CPUs
//	cpus         number of CPUs (for weighting)
//	memUsed, memTotal, swapUsed, swapTotal, rootUsed, rootTotal, diskUsed, diskTotal  bytes
//	netIn, netOut, diskRead, diskWrite                                                bytes/s
//	ioWait       fraction 0–1 (nodes)
//	load         1-min load average (nodes)
//	pressureCpu, pressureIo, pressureMem                                              PSI "some" avg10, %
//
// kind "cluster" sums its nodes (cpu weighted by cpus). Missing samples are null.

// MetricQuery selects one resource's history.
type MetricQuery struct {
	Cluster   string `json:"cluster"`
	Kind      string `json:"kind"` // cluster | node | guest | storage
	ID        string `json:"id"`   // node name, vmid, or storage[@node]
	Timeframe string `json:"timeframe"`
	CF        string `json:"cf,omitempty"` // AVERAGE (default) | MAX
}

// MetricSeries is a normalized history.
type MetricSeries struct {
	Query  MetricQuery           `json:"query"`
	T      []int64               `json:"t"`
	Series map[string][]*float64 `json:"series"`
	Error  string                `json:"error,omitempty"`
}

var timeframes = map[string]time.Duration{"hour": 10 * time.Second, "day": time.Minute, "week": 5 * time.Minute, "month": 15 * time.Minute, "year": time.Hour}

var rrdMap = map[string]string{
	"cpu": "cpu", "maxcpu": "cpus",
	"memused": "memUsed", "memtotal": "memTotal", "mem": "memUsed", "maxmem": "memTotal",
	"swapused": "swapUsed", "swaptotal": "swapTotal", "rootused": "rootUsed", "roottotal": "rootTotal",
	"disk": "diskUsed", "maxdisk": "diskTotal", "used": "diskUsed", "total": "diskTotal",
	"netin": "netIn", "netout": "netOut", "diskread": "diskRead", "diskwrite": "diskWrite",
	"iowait": "ioWait", "loadavg": "load",
	"pressurecpusome": "pressureCpu", "pressureiosome": "pressureIo", "pressurememorysome": "pressureMem",
}

type metricCacheEntry struct {
	at time.Time
	ms MetricSeries
}

type metricCache struct {
	mu sync.Mutex
	m  map[string]metricCacheEntry
}

var mcache = &metricCache{m: map[string]metricCacheEntry{}}

func (c *metricCache) get(k string, ttl time.Duration) (MetricSeries, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Since(e.at) > ttl {
		return MetricSeries{}, false
	}
	return e.ms, true
}

func (c *metricCache) put(k string, ms MetricSeries) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > 5000 { // crude bound
		for kk, e := range c.m {
			if time.Since(e.at) > 5*time.Minute {
				delete(c.m, kk)
			}
		}
	}
	c.m[k] = metricCacheEntry{at: time.Now(), ms: ms}
}

// authorizeMetric checks the user may see the resource and resolves its rrddata path(s).
func (s *Server) metricPaths(ctx context.Context, ss *session, q *MetricQuery) ([]string, error) {
	v := s.view(ctx, ss, q.Cluster)
	if v == nil {
		return nil, fmt.Errorf("not logged in to this cluster")
	}
	tf := "timeframe=" + q.Timeframe + "&cf=" + q.CF
	switch q.Kind {
	case "node":
		if !v.sysAudit && !v.nodes[q.ID] {
			return nil, fmt.Errorf("no such node")
		}
		return []string{"/nodes/" + url.PathEscape(q.ID) + "/rrddata?" + tf}, nil
	case "guest":
		id, err := strconv.Atoi(q.ID)
		if err != nil || !v.guests[id] {
			return nil, fmt.Errorf("no such guest")
		}
		g, ok := s.fleet.Guest(q.Cluster, id)
		if !ok {
			return nil, fmt.Errorf("no such guest")
		}
		return []string{fmt.Sprintf("/nodes/%s/%s/%d/rrddata?%s", url.PathEscape(g.Node), g.Type, id, tf)}, nil
	case "storage":
		st, node, _ := strings.Cut(q.ID, "@")
		if node == "" {
			sum, _, _, _, _ := s.fleet.Snapshot(q.Cluster)
			for _, x := range sum.Storage {
				if x.ID == st && (v.sysAudit || v.canSeeStorage(x.ID, x.Node)) {
					node = x.Node
					break
				}
			}
		}
		if node == "" || !(v.sysAudit || v.canSeeStorage(st, node)) {
			return nil, fmt.Errorf("no such storage")
		}
		return []string{"/nodes/" + url.PathEscape(node) + "/storage/" + url.PathEscape(st) + "/rrddata?" + tf}, nil
	case "cluster":
		if !v.sysAudit {
			return nil, fmt.Errorf("cluster metrics need Sys.Audit on /")
		}
		sum, _, _, _, _ := s.fleet.Snapshot(q.Cluster)
		var ps []string
		for _, n := range sum.Nodes {
			if n.Online {
				ps = append(ps, "/nodes/"+url.PathEscape(n.Name)+"/rrddata?"+tf)
			}
		}
		if len(ps) == 0 {
			return nil, fmt.Errorf("no online nodes")
		}
		return ps, nil
	}
	return nil, fmt.Errorf("kind must be cluster, node, guest or storage")
}

func (s *Server) fetchRRD(ctx context.Context, cl *pve.Client, path string) ([]map[string]any, error) {
	p, rawq, _ := strings.Cut(path, "?")
	vals, _ := url.ParseQuery(rawq)
	var rows []map[string]any
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := cl.Do(ctx, http.MethodGet, p, vals, &rows)
	return rows, err
}

func normalizeRRD(rows []map[string]any) ([]int64, map[string][]*float64) {
	sort.Slice(rows, func(i, j int) bool { return num(rows[i]["time"]) < num(rows[j]["time"]) })
	t := make([]int64, len(rows))
	series := map[string][]*float64{}
	for i, r := range rows {
		t[i] = int64(num(r["time"]))
		for k, v := range r {
			name, ok := rrdMap[k]
			if !ok {
				continue
			}
			if series[name] == nil {
				series[name] = make([]*float64, len(rows))
			}
			f, isNum := v.(float64)
			if isNum && !math.IsNaN(f) && !math.IsInf(f, 0) {
				if name == "ioWait" && f > 1 { // some versions report percent
					f /= 100
				}
				ff := f
				series[name][i] = &ff
			}
		}
	}
	return t, series
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

// sumNodes combines node histories into a cluster history aligned on timestamps.
func sumNodes(parts []MetricSeries) ([]int64, map[string][]*float64) {
	idx := map[int64]int{}
	var ts []int64
	for _, p := range parts {
		for _, t := range p.T {
			if _, ok := idx[t]; !ok {
				idx[t] = 0
				ts = append(ts, t)
			}
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	for i, t := range ts {
		idx[t] = i
	}
	out := map[string][]*float64{}
	cpuW := make([]float64, len(ts))
	cpuSum := make([]float64, len(ts))
	add := func(name string, i int, v float64) {
		if out[name] == nil {
			out[name] = make([]*float64, len(ts))
		}
		if out[name][i] == nil {
			z := 0.0
			out[name][i] = &z
		}
		*out[name][i] += v
	}
	for _, p := range parts {
		for j, t := range p.T {
			i := idx[t]
			cpus := 1.0
			if c := p.Series["cpus"]; c != nil && c[j] != nil {
				cpus = *c[j]
			}
			for name, vals := range p.Series {
				if vals[j] == nil {
					continue
				}
				switch name {
				case "cpu":
					cpuSum[i] += *vals[j] * cpus
					cpuW[i] += cpus
				case "ioWait", "load", "pressureCpu", "pressureIo", "pressureMem":
					// averaged below via sum / node count is misleading; keep the max
					if out[name] == nil {
						out[name] = make([]*float64, len(ts))
					}
					if out[name][i] == nil || *vals[j] > *out[name][i] {
						v := *vals[j]
						out[name][i] = &v
					}
				default:
					add(name, i, *vals[j])
				}
			}
		}
	}
	out["cpu"] = make([]*float64, len(ts))
	for i := range ts {
		if cpuW[i] > 0 {
			v := cpuSum[i] / cpuW[i]
			out["cpu"][i] = &v
		}
	}
	return ts, out
}

var tfRe = regexp.MustCompile(`^(hour|day|week|month|year)$`)

func (s *Server) runMetric(ctx context.Context, ss *session, q MetricQuery) MetricSeries {
	if q.Timeframe == "" {
		q.Timeframe = "day"
	}
	if q.CF == "" {
		q.CF = "AVERAGE"
	}
	res := MetricSeries{Query: q, T: []int64{}, Series: map[string][]*float64{}}
	if !tfRe.MatchString(q.Timeframe) || (q.CF != "AVERAGE" && q.CF != "MAX") {
		res.Error = "timeframe must be hour|day|week|month|year and cf AVERAGE|MAX"
		return res
	}
	paths, err := s.metricPaths(ctx, ss, &q)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	key := q.Cluster + "|" + q.Kind + "|" + q.ID + "|" + q.Timeframe + "|" + q.CF
	if ms, ok := mcache.get(key, timeframes[q.Timeframe]); ok {
		return ms
	}
	cl := s.fleet.ServiceClient(q.Cluster) // authorization was checked against the user's view above
	if cl == nil {
		res.Error = "cluster not polled yet"
		return res
	}
	parts := make([]MetricSeries, len(paths))
	errs := make([]error, len(paths))
	var wg sync.WaitGroup
	for i, p := range paths {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			rows, err := s.fetchRRD(ctx, cl, p)
			if err != nil {
				errs[i] = err
				return
			}
			parts[i].T, parts[i].Series = normalizeRRD(rows)
		}(i, p)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			res.Error = "could not read history: " + e.Error()
			return res
		}
	}
	if q.Kind == "cluster" {
		res.T, res.Series = sumNodes(parts)
	} else {
		res.T, res.Series = parts[0].T, parts[0].Series
	}
	mcache.put(key, res)
	return res
}

// GET /api/metrics?cluster=&kind=&id=&timeframe=&cf=
func (s *Server) metrics(w http.ResponseWriter, r *http.Request, ss *session) {
	q := r.URL.Query()
	ms := s.runMetric(r.Context(), ss, MetricQuery{Cluster: q.Get("cluster"), Kind: q.Get("kind"), ID: q.Get("id"), Timeframe: q.Get("timeframe"), CF: q.Get("cf")})
	code := 200
	if ms.Error != "" {
		code = 400
	}
	writeJSON(w, code, ms)
}

// POST /api/metrics {"queries":[MetricQuery]} → [MetricSeries] in order (max 32).
func (s *Server) metricsBatch(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		Queries []MetricQuery `json:"queries"`
	}
	if err := readJSON(r, &req); err != nil || len(req.Queries) == 0 || len(req.Queries) > 32 {
		apiError(w, 400, "bad_request", "1–32 queries required")
		return
	}
	out := make([]MetricSeries, len(req.Queries))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, q := range req.Queries {
		wg.Add(1)
		go func(i int, q MetricQuery) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = s.runMetric(r.Context(), ss, q)
		}(i, q)
	}
	wg.Wait()
	writeJSON(w, 200, out)
}

// ---- read pass-through ----

var pvePathRe = regexp.MustCompile(`^[A-Za-z0-9_.:@!%+=,\-/]+$`)

// pveGet proxies a GET to the PVE API **as the user**, so PVE's own ACL checks
// apply. Detail pages and the generic resource editor read through it; every
// write still goes through a reviewed plan.
func (s *Server) pveGet(w http.ResponseWriter, r *http.Request, ss *session) {
	p := "/" + r.PathValue("path")
	if !pvePathRe.MatchString(p) || strings.Contains(p, "..") || strings.Contains(p, "//") {
		apiError(w, 400, "bad_request", "invalid API path")
		return
	}
	cl, _, err := s.userClient(r.Context(), ss, r.PathValue("id"))
	if err != nil {
		apiError(w, 409, "cluster_login_required", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var out json.RawMessage
	if err := cl.Do(ctx, http.MethodGet, p, r.URL.Query(), &out); err != nil {
		var ae *pve.APIError
		code := 502
		if errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500 {
			code = ae.Status
		}
		apiError(w, code, "pve_error", err.Error())
		return
	}
	if len(out) == 0 {
		out = json.RawMessage("null")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, `{"data":`)
	_, _ = w.Write(out)
	_, _ = io.WriteString(w, `}`)
}
