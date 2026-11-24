// Package plan turns an intended action into an explicit, reviewable list of
// PVE API calls (with the equivalent CLI for each) and executes it as the user.
package plan

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
)

// Step is one API call.
type Step struct {
	Description string            `json:"description"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Body        map[string]string `json:"body"`
	CLI         string            `json:"cli"`
}

// Plan is a reviewable set of steps against one cluster.
type Plan struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	Title       string `json:"title"`
	Summary     string `json:"summary"`
	ClusterID   string `json:"clusterId"`
	Destructive bool   `json:"destructive"`
	ConfirmText string `json:"confirmText,omitempty"`
	Steps       []Step `json:"steps"`
	CreatedAt   int64  `json:"createdAt"`
	ExpiresAt   int64  `json:"expiresAt"`

	owner string
	used  bool
}

// Result of one executed step. Status is "running" while its PVE task runs,
// then "ok" or "error"; OK mirrors Status=="ok" for older clients.
type Result struct {
	Step       int    `json:"step"`
	Status     string `json:"status"`
	OK         bool   `json:"ok"`
	UPID       string `json:"upid,omitempty"`
	ExitStatus string `json:"exitstatus,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Target identifies a guest.
type Target struct {
	VMID int    `json:"vmid"`
	Node string `json:"node"`
	Type string `json:"type"` // qemu | lxc
}

// Request is the body of POST /api/plans.
type Request struct {
	Action    string          `json:"action"`
	ClusterID string          `json:"clusterId"`
	Params    json.RawMessage `json:"params"`
}

// Errors surfaced to the API layer.
var (
	ErrNotFound    = errors.New("plan not found or expired")
	ErrUsed        = errors.New("plan already executed")
	ErrConfirm     = errors.New("confirmation text does not match")
	ErrForbidden   = errors.New("plan belongs to another user")
	ErrBadRequest  = errors.New("invalid plan request")
	ErrTooMany     = errors.New("too many pending plans; run or discard some first")
	snapNameRegexp = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{1,39}$`)
	nodeRegexp     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`)
	jobRegexp      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`)
)

// TTL is how long a plan stays runnable.
const TTL = 10 * time.Minute

// MaxPendingPerUser bounds memory used by unexecuted plans.
const MaxPendingPerUser = 50

// Visible reports whether the requesting user may see guest vmid in cluster.
// A nil Visible allows everything (tests, internal callers).
type Visible func(vmid int) bool

// Manager builds and stores pending plans.
type Manager struct {
	fleet *fleet.Poller
	mu    sync.Mutex
	plans map[string]*Plan
}

// NewManager returns a plan manager.
func NewManager(f *fleet.Poller) *Manager { return &Manager{fleet: f, plans: map[string]*Plan{}} }

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func tool(t string) string {
	if t == "lxc" {
		return "pct"
	}
	return "qm"
}

func (m *Manager) resolve(cluster string, ts []Target, vis Visible) ([]Target, []fleet.Guest, error) {
	if len(ts) == 0 || len(ts) > 100 {
		return nil, nil, fmt.Errorf("%w: 1–100 targets required", ErrBadRequest)
	}
	out := make([]Target, 0, len(ts))
	gs := make([]fleet.Guest, 0, len(ts))
	for _, t := range ts {
		g, ok := m.fleet.Guest(cluster, t.VMID)
		if !ok || (vis != nil && !vis(t.VMID)) {
			return nil, nil, fmt.Errorf("%w: guest %d not found in cluster", ErrBadRequest, t.VMID)
		}
		// Authoritative node/type come from the cache, not the client.
		out = append(out, Target{VMID: g.VMID, Node: g.Node, Type: g.Type})
		gs = append(gs, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].VMID < out[j].VMID })
	return out, gs, nil
}

func vmids(ts []Target) string {
	s := make([]string, len(ts))
	for i, t := range ts {
		s[i] = strconv.Itoa(t.VMID)
	}
	return strings.Join(s, ",")
}

// Build creates a plan for the user. It never calls mutating APIs.
// Build creates a plan for the user. reader is a client acting as that user;
// it is used for any reads the plan needs, so users never learn more than PVE
// lets them read. vis limits targets to guests the user can see.
func (m *Manager) Build(ctx context.Context, user string, req Request, vis Visible, reader *pve.Client) (*Plan, error) {
	p := &Plan{ID: newID(), Action: req.Action, ClusterID: req.ClusterID, CreatedAt: time.Now().Unix(), owner: user}
	p.ExpiresAt = p.CreatedAt + int64(TTL.Seconds())
	if m.fleet.ServiceClient(req.ClusterID) == nil {
		return nil, fmt.Errorf("%w: unknown cluster", ErrBadRequest)
	}
	switch req.Action {
	case "guest.start", "guest.shutdown", "guest.stop", "guest.reboot":
		var prm struct{ Targets []Target }
		if err := json.Unmarshal(req.Params, &prm); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		ts, _, err := m.resolve(req.ClusterID, prm.Targets, vis)
		if err != nil {
			return nil, err
		}
		verb := strings.TrimPrefix(req.Action, "guest.")
		for _, t := range ts {
			p.Steps = append(p.Steps, Step{
				Description: fmt.Sprintf("%s %s %d on %s", strings.ToUpper(verb[:1])+verb[1:], t.Type, t.VMID, t.Node),
				Method:      http.MethodPost, Path: fmt.Sprintf("/nodes/%s/%s/%d/status/%s", t.Node, t.Type, t.VMID, verb),
				Body: map[string]string{}, CLI: fmt.Sprintf("%s %s %d", tool(t.Type), verb, t.VMID),
			})
		}
		p.Title = fmt.Sprintf("%s %s", strings.ToUpper(verb[:1])+verb[1:], vmids(ts))
		p.Summary = fmt.Sprintf("%d guest(s), one task each.", len(ts))
		if verb == "stop" {
			p.Destructive = true
			p.Summary += " Stop is a hard power-off: unsaved guest data may be lost."
		}
	case "guest.migrate":
		var prm struct {
			Targets []Target
			Target  string
			Online  *bool
		}
		if err := json.Unmarshal(req.Params, &prm); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		if !nodeRegexp.MatchString(prm.Target) || !contains(m.fleet.OnlineNodes(req.ClusterID), prm.Target) {
			return nil, fmt.Errorf("%w: target node %q is not an online node of this cluster", ErrBadRequest, prm.Target)
		}
		ts, gs, err := m.resolve(req.ClusterID, prm.Targets, vis)
		if err != nil {
			return nil, err
		}
		online := prm.Online == nil || *prm.Online
		for i, t := range ts {
			if t.Node == prm.Target {
				return nil, fmt.Errorf("%w: guest %d is already on %s", ErrBadRequest, t.VMID, prm.Target)
			}
			body := map[string]string{"target": prm.Target}
			cli := fmt.Sprintf("%s migrate %d %s", tool(t.Type), t.VMID, prm.Target)
			running := gs[i].Status == "running"
			switch {
			case t.Type == "qemu" && running && online:
				body["online"] = "1"
				cli += " --online"
			case t.Type == "qemu" && running:
				return nil, fmt.Errorf("%w: VM %d is running; shut it down first or migrate it online", ErrBadRequest, t.VMID)
			case t.Type == "lxc" && running:
				body["restart"] = "1"
				cli += " --restart"
			}
			p.Steps = append(p.Steps, Step{
				Description: fmt.Sprintf("Migrate %d (%s) %s → %s", t.VMID, gs[i].Name, t.Node, prm.Target),
				Method:      http.MethodPost, Path: fmt.Sprintf("/nodes/%s/%s/%d/migrate", t.Node, t.Type, t.VMID), Body: body, CLI: cli,
			})
		}
		p.Title = fmt.Sprintf("Migrate %s to %s", vmids(ts), prm.Target)
		p.Summary = "Running VMs migrate live; running containers restart on the target."
	case "guest.snapshot":
		var prm struct {
			Targets     []Target
			Name        string
			Description string
		}
		if err := json.Unmarshal(req.Params, &prm); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		if !snapNameRegexp.MatchString(prm.Name) {
			return nil, fmt.Errorf("%w: snapshot name must start with a letter, 2–40 chars of [A-Za-z0-9_-]", ErrBadRequest)
		}
		ts, _, err := m.resolve(req.ClusterID, prm.Targets, vis)
		if err != nil {
			return nil, err
		}
		for _, t := range ts {
			body := map[string]string{"snapname": prm.Name}
			cli := fmt.Sprintf("%s snapshot %d %s", tool(t.Type), t.VMID, prm.Name)
			if prm.Description != "" {
				body["description"] = prm.Description
				cli += " --description " + shellQuote(prm.Description)
			}
			p.Steps = append(p.Steps, Step{Description: fmt.Sprintf("Snapshot %d as %q", t.VMID, prm.Name), Method: http.MethodPost,
				Path: fmt.Sprintf("/nodes/%s/%s/%d/snapshot", t.Node, t.Type, t.VMID), Body: body, CLI: cli})
		}
		p.Title = fmt.Sprintf("Snapshot %s as %s", vmids(ts), prm.Name)
		p.Summary = "Snapshots need snapshot-capable storage (Ceph RBD, ZFS, LVM-thin, qcow2)."
	case "guest.destroy":
		var prm struct{ Targets []Target }
		if err := json.Unmarshal(req.Params, &prm); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		ts, gs, err := m.resolve(req.ClusterID, prm.Targets, vis)
		if err != nil {
			return nil, err
		}
		for i, t := range ts {
			if gs[i].Status == "running" {
				p.Steps = append(p.Steps, Step{Description: fmt.Sprintf("Stop %d (running)", t.VMID), Method: http.MethodPost,
					Path: fmt.Sprintf("/nodes/%s/%s/%d/status/stop", t.Node, t.Type, t.VMID), Body: map[string]string{}, CLI: fmt.Sprintf("%s stop %d", tool(t.Type), t.VMID)})
			}
			p.Steps = append(p.Steps, Step{Description: fmt.Sprintf("Destroy %d (%s) and purge it from jobs and HA", t.VMID, gs[i].Name), Method: http.MethodDelete,
				Path: fmt.Sprintf("/nodes/%s/%s/%d", t.Node, t.Type, t.VMID), Body: map[string]string{"purge": "1", "destroy-unreferenced-disks": "1"},
				CLI: fmt.Sprintf("%s destroy %d --purge 1 --destroy-unreferenced-disks 1", tool(t.Type), t.VMID)})
		}
		p.Destructive = true
		p.ConfirmText = "destroy " + vmids(ts)
		p.Title = "Destroy " + vmids(ts)
		p.Summary = "Permanently deletes the guest(s) and all their disks. Backups are not touched."
	case "backup.protect":
		var prm struct {
			VMIDs []int
			Job   string
		}
		if err := json.Unmarshal(req.Params, &prm); err != nil || len(prm.VMIDs) == 0 || len(prm.VMIDs) > 100 || !jobRegexp.MatchString(prm.Job) {
			return nil, fmt.Errorf("%w: 1–100 vmids and a job are required", ErrBadRequest)
		}
		for _, id := range prm.VMIDs {
			if _, ok := m.fleet.Guest(req.ClusterID, id); !ok || (vis != nil && !vis(id)) {
				return nil, fmt.Errorf("%w: guest %d not found in cluster", ErrBadRequest, id)
			}
		}
		var job struct {
			All     int    `json:"all"`
			VMID    string `json:"vmid"`
			Exclude string `json:"exclude"`
			Pool    string `json:"pool"`
			Node    string `json:"node"`
			Digest  string `json:"digest"`
		}
		if reader == nil {
			reader = m.fleet.ServiceClient(req.ClusterID)
		}
		if err := reader.Get(ctx, "/cluster/backup/"+url.PathEscape(prm.Job), &job); err != nil {
			return nil, fmt.Errorf("%w: cannot read backup job %s with your permissions", ErrBadRequest, prm.Job)
		}
		if job.Pool != "" {
			return nil, fmt.Errorf("%w: job %s selects guests by pool %q; add the guests to that pool instead", ErrBadRequest, prm.Job, job.Pool)
		}
		if job.Node != "" {
			for _, id := range prm.VMIDs {
				if g, _ := m.fleet.Guest(req.ClusterID, id); g.Node != job.Node {
					return nil, fmt.Errorf("%w: job %s only runs on node %s but guest %d is on %s", ErrBadRequest, prm.Job, job.Node, id, g.Node)
				}
			}
		}
		body := map[string]string{}
		var cli string
		if job.All == 1 {
			ex := removeIDs(splitIDs(job.Exclude), prm.VMIDs)
			body["exclude"] = joinIDs(ex)
			if len(ex) == 0 {
				body = map[string]string{"delete": "exclude"}
				cli = fmt.Sprintf("pvesh set /cluster/backup/%s --delete exclude", prm.Job)
			} else {
				cli = fmt.Sprintf("pvesh set /cluster/backup/%s --exclude %s", prm.Job, joinIDs(ex))
			}
		} else {
			ids := addIDs(splitIDs(job.VMID), prm.VMIDs)
			body["vmid"] = joinIDs(ids)
			cli = fmt.Sprintf("pvesh set /cluster/backup/%s --vmid %s", prm.Job, joinIDs(ids))
		}
		if job.Digest != "" { // PVE rejects the update if the job changed since this plan was built
			body["digest"] = job.Digest
		}
		p.Steps = append(p.Steps, Step{Description: fmt.Sprintf("Include %s in backup job %s", joinIDs(prm.VMIDs), prm.Job), Method: http.MethodPut,
			Path: "/cluster/backup/" + url.PathEscape(prm.Job), Body: body, CLI: cli})
		p.Title = fmt.Sprintf("Protect %s with %s", joinIDs(prm.VMIDs), prm.Job)
		p.Summary = "Takes effect from the job's next scheduled run."
	default:
		return nil, fmt.Errorf("%w: unknown action %q", ErrBadRequest, req.Action)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()
	n := 0
	for _, q := range m.plans {
		if q.owner == user && !q.used {
			n++
		}
	}
	if n >= MaxPendingPerUser {
		return nil, ErrTooMany
	}
	m.plans[p.ID] = p
	return p, nil
}

func (m *Manager) gc() {
	now := time.Now().Unix()
	for id, p := range m.plans {
		if now > p.ExpiresAt {
			delete(m.plans, id)
		}
	}
}

// Peek returns a pending plan for its owner without consuming it.
func (m *Manager) Peek(id, user string) (*Plan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.plans[id]
	if p == nil || time.Now().Unix() > p.ExpiresAt {
		return nil, ErrNotFound
	}
	if p.owner != user {
		return nil, ErrNotFound // do not reveal other users' plans
	}
	if p.used {
		return nil, ErrUsed
	}
	return p, nil
}

// Discard drops a pending plan.
func (m *Manager) Discard(id, user string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p := m.plans[id]; p != nil && p.owner == user {
		delete(m.plans, id)
	}
}

// Take claims a plan for execution (single use) after checking owner and confirmation.
func (m *Manager) Take(id, user, confirm string) (*Plan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()
	p := m.plans[id]
	if p == nil || time.Now().Unix() > p.ExpiresAt {
		return nil, ErrNotFound
	}
	if p.owner != user {
		return nil, ErrNotFound
	}
	if p.used {
		return nil, ErrUsed
	}
	if p.ConfirmText != "" && strings.TrimSpace(confirm) != p.ConfirmText {
		return nil, ErrConfirm
	}
	p.used = true
	return p, nil
}

// TaskTimeout bounds how long Execute waits for one PVE task. Migrations and
// backups of large guests can take hours; past this the step is recorded as
// "unknown" (still running in PVE), never as a failure.
var TaskTimeout = 6 * time.Hour

// TaskPoll is how often Execute polls a running task.
var TaskPoll = time.Second

// Execute runs the steps in order with the user's client, waiting for each
// step's PVE task to finish and stopping at the first failure. progress is
// called (if non-nil) whenever a result changes, with a copy of all results.
func Execute(ctx context.Context, cl *pve.Client, p *Plan, progress func([]Result)) ([]Result, bool) {
	res := make([]Result, 0, len(p.Steps))
	emit := func() {
		if progress != nil {
			progress(append([]Result(nil), res...))
		}
	}
	for i, s := range p.Steps {
		form := url.Values{}
		for k, v := range s.Body {
			form.Set(k, v)
		}
		var upid any
		err := cl.Do(ctx, s.Method, s.Path, form, &upid)
		r := Result{Step: i, Status: "ok", OK: true}
		if u, isStr := upid.(string); isStr && strings.HasPrefix(u, "UPID:") {
			r.UPID = u
		}
		if err == nil && r.UPID != "" {
			r.Status, r.OK = "running", false
			res = append(res, r)
			emit()
			tctx, cancel := context.WithTimeout(ctx, TaskTimeout)
			exit, werr := cl.WaitTask(tctx, r.UPID, TaskPoll)
			timedOut := errors.Is(tctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
			cancel()
			r.ExitStatus = exit
			switch {
			case timedOut || (werr != nil && ctx.Err() != nil):
				r.Status, r.OK = "unknown", false
				r.Error = "galley stopped following this task; it may still be running — check the PVE task log"
				res = res[:len(res)-1]
				res = append(res, r)
				emit()
				return res, false
			case werr != nil:
				err = fmt.Errorf("task did not finish: %w", werr)
			case exit != "OK" && !strings.HasPrefix(exit, "WARNINGS"):
				err = fmt.Errorf("task failed: %s", exit)
			}
			res = res[:len(res)-1]
		}
		if err != nil {
			r.Status, r.OK, r.Error = "error", false, err.Error()
			res = append(res, r)
			emit()
			return res, false
		}
		r.Status, r.OK = "ok", true
		res = append(res, r)
		emit()
	}
	return res, true
}

// CLI returns the plan's CLI lines.
func (p *Plan) CLI() []string {
	out := make([]string, len(p.Steps))
	for i, s := range p.Steps {
		out[i] = s.CLI
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func splitIDs(s string) []int {
	var out []int
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		if n, err := strconv.Atoi(f); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func joinIDs(ids []int) string {
	s := make([]string, len(ids))
	for i, n := range ids {
		s[i] = strconv.Itoa(n)
	}
	return strings.Join(s, ",")
}

func addIDs(a, b []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, n := range append(append([]int{}, a...), b...) {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

func removeIDs(a, rm []int) []int {
	drop := map[int]bool{}
	for _, n := range rm {
		drop[n] = true
	}
	var out []int
	for _, n := range a {
		if !drop[n] {
			out = append(out, n)
		}
	}
	return out
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
