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
	"github.com/JongoDB/pve-cookbook/dashboard/internal/schema"
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
	// Source is "assistant" when the assistant drafted the plan.
	Source    string `json:"source,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`

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
	// Output of a host command (Method "SSH").
	Output string `json:"output,omitempty"`
}

// HostRunner runs a shell command on a cluster node (see package hosts).
type HostRunner func(ctx context.Context, node, command string) (output string, exit int, err error)

// MethodSSH marks a step that runs Body["command"] on node Path over SSH.
const MethodSSH = "SSH"

// MethodGalley marks a step that changes galley's own configuration: Path is
// the action (e.g. "galley.cluster.update") and Body its parameters.
const MethodGalley = "GALLEY"

// GalleyRunner applies a galley-level step with the requesting user's rights.
type GalleyRunner func(ctx context.Context, action string, body map[string]string) (string, error)

type draftKey struct{}

type draftLabel struct{ source, label string }

// WithDraft marks plans built with ctx as drafted by an AI (source, label):
// they are labelled and require typed confirmation from the moment they exist.
func WithDraft(ctx context.Context, source, label string) context.Context {
	return context.WithValue(ctx, draftKey{}, draftLabel{source, label})
}

func applyDraft(ctx context.Context, p *Plan) {
	if d, ok := ctx.Value(draftKey{}).(draftLabel); ok {
		MarkDraft(p, d.source, d.label)
	}
}

// Register stores a plan built outside Build (galley-level actions) for user.
func (m *Manager) Register(ctx context.Context, user string, p *Plan) error {
	applyDraft(ctx, p)
	p.ID, p.owner = newID(), user
	p.CreatedAt = time.Now().Unix()
	p.ExpiresAt = p.CreatedAt + int64(TTL.Seconds())
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
		return ErrTooMany
	}
	m.plans[p.ID] = p
	return nil
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
	// Schema returns the cluster's API schema (for generic api.call plans).
	Schema func(ctx context.Context, cluster string) (*schema.Schema, error)

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
	case "api.call":
		if err := m.buildAPICall(ctx, p, req); err != nil {
			return nil, err
		}
	case "host.exec":
		var prm struct {
			Node    string `json:"node"`
			Command string `json:"command"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(req.Params, &prm); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		prm.Command = strings.TrimSpace(prm.Command)
		if !nodeRegexp.MatchString(prm.Node) || !contains(m.fleet.OnlineNodes(req.ClusterID), prm.Node) {
			return nil, fmt.Errorf("%w: %q is not an online node of this cluster", ErrBadRequest, prm.Node)
		}
		if prm.Command == "" || len(prm.Command) > 8000 || strings.ContainsRune(prm.Command, 0) {
			return nil, fmt.Errorf("%w: command required (max 8000 characters)", ErrBadRequest)
		}
		first, _, _ := strings.Cut(prm.Command, "\n")
		if len(first) > 60 {
			first = first[:60] + "…"
		}
		p.Steps = []Step{{Description: "Run as root on " + prm.Node, Method: MethodSSH, Path: prm.Node,
			Body: map[string]string{"command": prm.Command}, CLI: "ssh root@" + prm.Node + " " + schema.Quote(prm.Command)}}
		p.Title = "Run on " + prm.Node + ": " + first
		if len(prm.Reason) <= 500 {
			p.Summary = prm.Reason
		}
		p.Summary = strings.TrimSpace(p.Summary + " Runs as root outside the PVE API; PVE permissions do not limit it.")
		p.Destructive = true
		p.ConfirmText = "run on " + prm.Node
	default:
		return nil, fmt.Errorf("%w: unknown action %q", ErrBadRequest, req.Action)
	}
	applyDraft(ctx, p)
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
func Execute(ctx context.Context, cl *pve.Client, p *Plan, progress func([]Result), host HostRunner, galley GalleyRunner) ([]Result, bool) {
	res := make([]Result, 0, len(p.Steps))
	emit := func() {
		if progress != nil {
			progress(append([]Result(nil), res...))
		}
	}
	for i, s := range p.Steps {
		if s.Method == MethodGalley {
			r := Result{Step: i, Status: "ok", OK: true}
			if galley == nil {
				r.Status, r.OK, r.Error = "error", false, "galley actions are not available"
			} else if msg, err := galley(ctx, s.Path, s.Body); err != nil {
				r.Status, r.OK, r.Error = "error", false, err.Error()
			} else {
				r.Output = msg
			}
			res = append(res, r)
			emit()
			if !r.OK {
				return res, false
			}
			continue
		}
		if s.Method == MethodSSH {
			r := Result{Step: i, Status: "running"}
			res = append(res, r)
			emit()
			if host == nil {
				r.Status, r.Error = "error", "host commands are not available"
			} else {
				out, code, err := host(ctx, s.Path, s.Body["command"])
				r.Output, r.ExitStatus = out, fmt.Sprintf("exit %d", code)
				switch {
				case err != nil:
					r.Status, r.Error = "error", err.Error()
				case code != 0:
					r.Status, r.Error = "error", fmt.Sprintf("command exited with status %d", code)
				default:
					r.Status, r.OK, r.ExitStatus = "ok", true, "OK"
				}
			}
			res[len(res)-1] = r
			emit()
			if !r.OK {
				return res, false
			}
			continue
		}
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

// Call is one raw PVE API call in an api.call plan.
type Call struct {
	Method string            `json:"method"`
	Path   string            `json:"path"`
	Body   map[string]string `json:"body"`
}

var (
	// Canonical paths only: no trailing slash, no percent-encoding, no empty segments.
	apiPathRe = regexp.MustCompile(`^(/[A-Za-z0-9_.:@!+=,-]+)+$`)
	// Matched schema templates whose calls disrupt service or destroy data.
	destructiveTemplates = regexp.MustCompile(`/status/(stop|reset|suspend)$|/rollback$|/stopall$|/wipedisk$|/initgpt$|/disks/(lvm|lvmthin|zfs|directory)(/\{name\})?$|/ceph/osd(/\{osdid\})?$|/access/password$|/move_disk$|/move_volume$|/remote_migrate$`)
	destructiveKeys      = map[string]bool{"delete": true, "purge": true, "destroy-unreferenced-disks": true, "force": true, "cleanup-disks": true, "skiplock": true}
)

// isDestructive decides from the matched template, method and body, not the raw path.
func isDestructive(method, template string, body map[string]string) bool {
	if method == http.MethodDelete || destructiveTemplates.MatchString(template) {
		return true
	}
	for k, v := range body {
		if destructiveKeys[k] && v != "" && v != "0" {
			return true
		}
	}
	switch {
	case template == "/nodes/{node}/status" && (body["command"] == "reboot" || body["command"] == "shutdown"):
		return true
	case template == "/access/acl" && body["delete"] != "" && body["delete"] != "0":
		return true
	case strings.HasSuffix(template, "/firewall/options") && body["enable"] != "":
		return true
	case strings.HasPrefix(template, "/cluster/ha/resources") && (body["state"] == "stopped" || body["state"] == "disabled" || body["state"] == "ignored"):
		return true
	}
	return false
}

// buildAPICall turns arbitrary API calls into a reviewable plan. Every call is
// validated against the cluster's own API schema; PVE checks permissions when
// it runs as the user.
func (m *Manager) buildAPICall(ctx context.Context, p *Plan, req Request) error {
	var prm struct {
		Calls   []Call `json:"calls"`
		Title   string `json:"title"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(req.Params, &prm); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if len(prm.Calls) == 0 || len(prm.Calls) > 20 {
		return fmt.Errorf("%w: 1–20 calls required", ErrBadRequest)
	}
	if m.Schema == nil {
		return fmt.Errorf("%w: API schema unavailable", ErrBadRequest)
	}
	sc, err := m.Schema(ctx, req.ClusterID)
	if err != nil {
		return fmt.Errorf("%w: could not load the cluster's API schema: %v", ErrBadRequest, err)
	}
	deletes := 0
	for i, c := range prm.Calls {
		c.Method = strings.ToUpper(c.Method)
		if c.Method != http.MethodPost && c.Method != http.MethodPut && c.Method != http.MethodDelete {
			return fmt.Errorf("%w: call %d: method must be POST, PUT or DELETE (reads need no change)", ErrBadRequest, i+1)
		}
		if !apiPathRe.MatchString(c.Path) || strings.Contains(c.Path, "..") {
			return fmt.Errorf("%w: call %d: invalid path (no trailing slash or percent-encoding)", ErrBadRequest, i+1)
		}
		if c.Body == nil {
			c.Body = map[string]string{}
		}
		meth, err := sc.Validate(c.Method, c.Path, c.Body)
		if err != nil {
			return fmt.Errorf("%w: call %d (%s %s): %v", ErrBadRequest, i+1, c.Method, c.Path, err)
		}
		node, _, _ := sc.Match(c.Path)
		desc, _, _ := strings.Cut(strings.TrimSpace(meth.Description), "\n")
		if desc == "" {
			desc = c.Method + " " + c.Path
		}
		if isDestructive(c.Method, node.Path, c.Body) {
			p.Destructive = true
			deletes++
		}
		p.Steps = append(p.Steps, Step{Description: desc + " (" + c.Path + ")", Method: c.Method, Path: c.Path, Body: c.Body,
			CLI: schema.CLI(c.Method, c.Path, c.Body)})
	}
	p.Title = strings.TrimSpace(prm.Title)
	if p.Title == "" || len(p.Title) > 120 {
		p.Title = p.Steps[0].Description
		if len(p.Steps) > 1 {
			p.Title = fmt.Sprintf("%d API changes", len(p.Steps))
		}
	}
	if len(prm.Summary) <= 500 {
		p.Summary = prm.Summary
	}
	if p.Destructive {
		if len(prm.Calls) == 1 {
			segs := strings.Split(strings.Trim(prm.Calls[0].Path, "/"), "/")
			p.ConfirmText = "delete " + strings.Join(segs[max(0, len(segs)-2):], "/")
			if prm.Calls[0].Method != http.MethodDelete {
				p.ConfirmText = "confirm " + strings.Join(segs[max(0, len(segs)-2):], "/")
			}
		} else {
			p.ConfirmText = fmt.Sprintf("apply %d changes", len(prm.Calls))
		}
	}
	return nil
}

// MarkAssistantDraft labels a plan drafted by the assistant and always
// requires typed confirmation, so data the model read (VM notes, names) can
// never turn into a one-click change.
func MarkAssistantDraft(p *Plan) { MarkDraft(p, "assistant", "Assistant draft") }

// MarkDraft labels a plan drafted by an AI (the assistant, or an external
// agent via MCP) and always requires typed confirmation to apply it.
func MarkDraft(p *Plan, source, label string) {
	p.Source = source
	if !strings.HasPrefix(p.Title, label+": ") {
		p.Title = label + ": " + p.Title
	}
	if p.ConfirmText == "" {
		p.ConfirmText = fmt.Sprintf("apply %d step", len(p.Steps))
		if len(p.Steps) != 1 {
			p.ConfirmText += "s"
		}
	}
}

// List returns user's pending (not yet run, unexpired) plans, newest first.
func (m *Manager) List(user string) []*Plan {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()
	var out []*Plan
	for _, p := range m.plans {
		if p.owner == user && !p.used {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}
