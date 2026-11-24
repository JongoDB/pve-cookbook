// Package fakepve is an in-memory, TLS-serving imitation of the parts of the
// Proxmox VE API that galley uses. Response shapes follow PVE 9. Used by tests.
package fakepve

import (
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
)

// Call is a recorded mutating request.
type Call struct {
	Method, Path string
	Form         map[string]string
	User         string
	Token        string // user API token id the call was made with ("" = ticket)
}

// UserToken is a user API token created through /access/users/{user}/token.
type UserToken struct {
	ID, User, Secret, Comment string
	Expire                    int64
	Privsep                   bool
}

// termTicket is a termproxy ticket: a node shell, or a container's console
// when guest (the container's hostname) is set.
type termTicket struct{ user, node, guest string }

// Server is a fake cluster API endpoint.
type Server struct {
	*httptest.Server
	mu        sync.Mutex
	Calls     []Call
	TokenID   string
	Secret    string
	Users     map[string]string // user@realm -> password
	TOTPUsers map[string]string // user@realm -> otp
	Admins    map[string]bool   // users with Sys.Modify on /
	tickets   map[string]string // ticket -> user
	Guests    []map[string]any
	BackupJob map[string]any
	NoBackup  []int
	Ring1     bool
	// Restricted users see only these guests and hold no privileges on "/".
	Restricted map[string][]int
	// TokenPerms are the poller token's privileges on "/" (default Sys.Audit).
	TokenPerms map[string]int
	// TaskDuration is how long mutation tasks stay "running".
	TaskDuration time.Duration
	// TaskExit forces a task's exit status, keyed by mutation path.
	TaskExit map[string]string
	tasks    map[string]*fakeTask
	// NodeIP is the "ip" of each node in /cluster/status (host:port allowed in tests).
	NodeIP map[string]string
	Down   bool // respond 595 to everything (simulates pveproxy failure)
	// Fail makes authenticated requests to these API paths (without the
	// /api2/json prefix, e.g. "/cluster/status") answer 500. Mutate it with
	// SetFail while the server is in use.
	Fail map[string]bool
	// Delay holds authenticated requests to these API paths for the given
	// duration (or until the client gives up). Mutate it with SetDelay while
	// the server is in use.
	Delay map[string]time.Duration
	// StorageConfig is served by GET /storage (the cluster storage
	// configuration). Set "disable": 1 on an entry to model disabled storage.
	StorageConfig []map[string]any
	// HAServices are the "service" entries of /cluster/ha/status/current.
	HAServices []map[string]any
	// TokenSelfRevoke lets a user token delete itself (otherwise only the
	// user's ticket can delete it).
	TokenSelfRevoke bool
	// HostRun answers commands run through a node terminal (see TermShell).
	HostRun func(cmd string) (string, int)

	userTokens  map[string]*UserToken // full id -> token
	termTickets map[string]termTicket
	hostCmds    []string
	tokenSeq    int
}

// New starts a fake cluster with three nodes and a few guests.
func New() *Server {
	f := &Server{
		TokenID: "galley@pve!poller", Secret: "11111111-2222-3333-4444-555555555555",
		Users:     map[string]string{"root@pam": "secret", "ops@pve": "opspass"},
		TOTPUsers: map[string]string{"mfa@pve": "123456"},
		Admins:    map[string]bool{"root@pam": true},
		tickets:   map[string]string{},
		Guests: []map[string]any{
			{"vmid": 120, "name": "web01", "type": "qemu", "node": "pve1", "status": "running", "tags": "prod;web"},
			{"vmid": 121, "name": "web02", "type": "qemu", "node": "pve2", "status": "running", "tags": "prod;web"},
			{"vmid": 131, "name": "grafana", "type": "lxc", "node": "pve2", "status": "running", "tags": "monitoring"},
			{"vmid": 300, "name": "llm-vllm", "type": "qemu", "node": "pve1", "status": "stopped", "tags": "gpu"},
			{"vmid": 9000, "name": "debian13-tmpl", "type": "qemu", "node": "pve3", "status": "stopped", "template": 1},
		},
		BackupJob: map[string]any{"id": "nightly-all", "all": 1, "exclude": "131", "enabled": 1, "schedule": "01:30"},
		NoBackup:  []int{131},
		Ring1:     true,
		Fail:      map[string]bool{},
		Delay:     map[string]time.Duration{},
		// nas-backup is enabled but unreachable: /cluster/resources reports it
		// with status "unknown" on every node.
		HAServices: []map[string]any{{"type": "service", "id": "vm:120", "sid": "vm:120", "node": "pve1", "state": "started"}},
		StorageConfig: []map[string]any{
			{"storage": "vm-pool", "type": "rbd", "content": "images,rootdir", "shared": 1},
			{"storage": "local", "type": "dir", "content": "iso,vztmpl,backup", "shared": 0},
			{"storage": "nas-backup", "type": "nfs", "content": "backup", "shared": 1},
		},
	}
	f.TOTPUsers["mfa@pve"] = "123456"
	f.Users["mfa@pve"] = "mfapass"
	f.Users["dev@pve"] = "devpass"
	f.Restricted = map[string][]int{"dev@pve": {121}}
	f.TokenPerms = map[string]int{"Sys.Audit": 1}
	f.TaskExit = map[string]string{}
	f.tasks = map[string]*fakeTask{}
	f.userTokens = map[string]*UserToken{}
	f.termTickets = map[string]termTicket{}
	f.NodeIP = map[string]string{"pve1": "192.0.2.11", "pve2": "192.0.2.12", "pve3": "192.0.2.13"}
	f.Server = httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	f.Server.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	f.StartTLS()
	return f
}

type fakeTask struct {
	done   time.Time
	exit   string
	effect func()
	fired  bool
}

// settle applies the effects of finished tasks. Caller holds f.mu.
func (f *Server) settle() {
	now := time.Now()
	for _, t := range f.tasks {
		if !t.fired && !now.Before(t.done) {
			t.fired = true
			if t.effect != nil && t.exit == "OK" {
				t.effect()
			}
		}
	}
}

func (f *Server) guestLocked(vmid string) map[string]any {
	for _, g := range f.Guests {
		if fmt.Sprint(g["vmid"]) == vmid {
			return g
		}
	}
	return nil
}

// Endpoint returns this server as a pinned galley endpoint.
func (f *Server) Endpoint() pve.Endpoint {
	return pve.Endpoint{Host: strings.TrimPrefix(f.URL, "https://"), Fingerprint: pve.Fingerprint(f.Certificate())}
}

// Update runs fn with the server's lock held, so tests can change its
// configuration (Down, Ring1, HAServices, StorageConfig, Fail, Delay, ...)
// while requests are being served. fn must not call other Server methods.
func (f *Server) Update(fn func(s *Server)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// SetFail makes requests to path answer 500 (fail=true) or behave normally.
func (f *Server) SetFail(path string, fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Fail == nil {
		f.Fail = map[string]bool{}
	}
	if fail {
		f.Fail[path] = true
	} else {
		delete(f.Fail, path)
	}
}

// SetDelay delays responses to path by d (0 removes the delay).
func (f *Server) SetDelay(path string, d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Delay == nil {
		f.Delay = map[string]time.Duration{}
	}
	if d > 0 {
		f.Delay[path] = d
	} else {
		delete(f.Delay, path)
	}
}

// Recorded returns a copy of recorded mutations.
func (f *Server) Recorded() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.Calls...)
}

func write(w http.ResponseWriter, code int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}

// UserTokens returns the user API tokens that currently exist.
func (f *Server) UserTokens() []UserToken {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []UserToken{}
	for _, t := range f.userTokens {
		out = append(out, *t)
	}
	return out
}

// tokenOf returns the user token a request authenticates with (nil if none).
func (f *Server) tokenOf(r *http.Request) *UserToken {
	a, ok := strings.CutPrefix(r.Header.Get("Authorization"), "PVEAPIToken=")
	if !ok {
		return nil
	}
	id, sec, _ := strings.Cut(a, "=")
	f.mu.Lock()
	defer f.mu.Unlock()
	t := f.userTokens[id]
	if t == nil || t.Secret != sec || (t.Expire > 0 && time.Now().Unix() >= t.Expire) {
		return nil
	}
	return t
}

func (f *Server) who(r *http.Request) string {
	if a := r.Header.Get("Authorization"); a == "PVEAPIToken="+f.TokenID+"="+f.Secret {
		return f.TokenID
	}
	if t := f.tokenOf(r); t != nil {
		return t.User // privsep=0: the token acts with its user's permissions
	}
	if c, err := r.Cookie("PVEAuthCookie"); err == nil {
		f.mu.Lock()
		defer f.mu.Unlock()
		if u := f.tickets[c.Value]; u != "" && !strings.Contains(c.Value, "!tfa!") {
			return u
		}
	}
	return ""
}

func (f *Server) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	down := f.Down
	f.mu.Unlock()
	if down {
		w.WriteHeader(595)
		return
	}
	if r.URL.Path == "/pve-docs/api-viewer/apidoc.js" {
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte(APIDoc))
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/api2/json")
	_ = r.ParseForm()
	if p == "/access/ticket" && r.Method == http.MethodPost {
		f.ticket(w, r)
		return
	}
	switch {
	case p == "/access/domains" && r.Method == http.MethodGet:
		write(w, 200, []map[string]any{{"realm": "pam", "type": "pam", "comment": "Linux PAM"}, {"realm": "pve", "type": "pve", "comment": "Proxmox VE"}, {"realm": "sso", "type": "openid", "comment": "Company SSO"}})
		return
	case p == "/access/openid/auth-url" && r.Method == http.MethodPost:
		if r.Form.Get("realm") != "sso" {
			write(w, 400, nil)
			return
		}
		write(w, 200, "https://idp.invalid/authorize?client_id=pve&state=st-"+fmt.Sprint(time.Now().UnixNano())+"&redirect_uri="+r.Form.Get("redirect-url"))
		return
	case p == "/access/openid/login" && r.Method == http.MethodPost:
		if r.Form.Get("code") != "good" || !strings.HasPrefix(r.Form.Get("state"), "st-") {
			write(w, 401, nil)
			return
		}
		f.mu.Lock()
		t := "PVE:alice@sso:O" + fmt.Sprint(len(f.tickets))
		f.tickets[t] = "alice@sso"
		f.mu.Unlock()
		write(w, 200, map[string]any{"ticket": t, "CSRFPreventionToken": "csrf-alice", "username": "alice@sso"})
		return
	}
	user := f.who(r)
	if user == "" {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"data":null,"message":"authentication failure"}`))
		return
	}
	f.mu.Lock()
	fail, delay := f.Fail[p], f.Delay[p]
	f.mu.Unlock()
	if delay > 0 {
		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-r.Context().Done():
			t.Stop()
			return
		}
	}
	if fail {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"data":null,"message":"injected failure"}`))
		return
	}
	if strings.HasSuffix(p, "/vncwebsocket") && r.Method == http.MethodGet {
		if seg := strings.Split(strings.Trim(p, "/"), "/"); (len(seg) == 3 || len(seg) == 5) && strings.HasPrefix(r.URL.Query().Get("vncticket"), "PVETERM:") {
			f.termSocket(w, r, seg[1], user)
			return
		}
		f.consoleEcho(w, r)
		return
	}
	if r.Method == http.MethodPost && (strings.HasSuffix(p, "/vncproxy") || strings.HasSuffix(p, "/termproxy")) && user != f.TokenID {
		if _, restricted := f.Restricted[user]; restricted {
			write(w, 403, nil)
			return
		}
		seg := strings.Split(strings.Trim(p, "/"), "/")
		if len(seg) == 3 && seg[2] == "termproxy" { // node shell
			if !f.Admins[user] {
				write(w, 403, nil) // Sys.Console on /nodes/{node}
				return
			}
			f.mu.Lock()
			f.tokenSeq++
			t := fmt.Sprintf("PVETERM:%d:%s", f.tokenSeq, user)
			f.termTickets[t] = termTicket{user: user, node: seg[1]}
			f.mu.Unlock()
			write(w, 200, map[string]any{"port": 5900 + f.tokenSeq, "ticket": t, "user": user, "upid": "UPID:" + seg[1] + ":termproxy"})
			return
		}
		if len(seg) == 5 && seg[2] == "lxc" && seg[4] == "termproxy" { // container console
			f.mu.Lock()
			g := f.guestLocked(seg[3])
			if g == nil || g["node"] != seg[1] {
				f.mu.Unlock()
				write(w, 500, nil)
				return
			}
			f.tokenSeq++
			t := fmt.Sprintf("PVETERM:%d:%s", f.tokenSeq, user)
			f.termTickets[t] = termTicket{user: user, node: seg[1], guest: fmt.Sprint(g["name"])}
			port := 5900 + f.tokenSeq
			f.mu.Unlock()
			write(w, 200, map[string]any{"port": port, "ticket": t, "user": user, "upid": "UPID:" + seg[1] + ":vncproxy"})
			return
		}
		write(w, 200, map[string]any{"port": 5900, "ticket": "PVEVNC:fake:" + user, "user": user})
		return
	}
	if strings.HasPrefix(p, "/access/users/") && strings.Contains(p, "/token/") && (r.Method == http.MethodPost || r.Method == http.MethodDelete) {
		f.userToken(w, r, p, user)
		return
	}
	if r.Method != http.MethodGet {
		if user == f.TokenID {
			write(w, 403, nil) // poller token is read-only
			return
		}
		form := map[string]string{}
		for k := range r.Form {
			form[k] = r.Form.Get(k)
		}
		tokID := ""
		if t := f.tokenOf(r); t != nil {
			tokID = t.ID
		}
		f.mu.Lock()
		f.Calls = append(f.Calls, Call{Method: r.Method, Path: p, Form: form, User: user, Token: tokID})
		f.mu.Unlock()
		if p == "/cluster/backup/nightly-all" && r.Method == http.MethodPut {
			write(w, 200, nil)
			return
		}
		parts := strings.Split(strings.Trim(p, "/"), "/") // nodes/N/qemu/ID[/status/verb]
		var effect func()
		if len(parts) >= 4 && parts[0] == "nodes" {
			f.mu.Lock()
			f.settle()
			g := f.guestLocked(parts[3])
			if g != nil && r.Method == http.MethodDelete && g["status"] == "running" {
				f.mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(500)
				_, _ = w.Write([]byte(`{"data":null,"message":"VM ` + parts[3] + ` is running - destroy failed"}`))
				return
			}
			if g != nil && len(parts) == 6 && parts[4] == "status" {
				st := map[string]string{"start": "running", "stop": "stopped", "shutdown": "stopped"}[parts[5]]
				if st != "" {
					effect = func() { g["status"] = st }
				}
			}
			f.mu.Unlock()
		}
		f.mu.Lock()
		upid := fmt.Sprintf("UPID:%s:0000ABCD:%08X:%08X:fake:%s:%s:", nodeOf(p), len(f.Calls), time.Now().Unix(), strings.ReplaceAll(p, "/", "_"), user)
		exit := f.TaskExit[p]
		if exit == "" {
			exit = "OK"
		}
		f.tasks[upid] = &fakeTask{done: time.Now().Add(f.TaskDuration), exit: exit, effect: effect}
		f.mu.Unlock()
		write(w, 200, upid)
		return
	}
	f.mu.Lock()
	f.settle()
	f.mu.Unlock()
	switch {
	case strings.HasPrefix(p, "/nodes/") && strings.Contains(p, "/tasks/") && strings.HasSuffix(p, "/status"):
		upid := strings.TrimSuffix(p[strings.Index(p, "/tasks/")+len("/tasks/"):], "/status")
		f.mu.Lock()
		t := f.tasks[upid]
		f.mu.Unlock()
		switch {
		case t == nil:
			write(w, 404, nil)
		case time.Now().Before(t.done):
			write(w, 200, map[string]any{"status": "running", "upid": upid})
		default:
			write(w, 200, map[string]any{"status": "stopped", "exitstatus": t.exit, "upid": upid})
		}
		return
	case strings.HasPrefix(p, "/nodes/") && strings.HasSuffix(p, "/rrddata"):
		write(w, 200, fakeRRD(p, r.URL.Query().Get("timeframe")))
		return
	case p == "/version":
		write(w, 200, map[string]any{"version": "9.2.32", "release": "9.2"})
	case p == "/cluster/status":
		write(w, 200, []map[string]any{
			{"type": "cluster", "name": "pve-lab", "quorate": 1, "nodes": 3},
			{"type": "node", "name": "pve1", "online": 1, "ip": f.NodeIP["pve1"]}, {"type": "node", "name": "pve2", "online": 1, "ip": f.NodeIP["pve2"]}, {"type": "node", "name": "pve3", "online": 1, "ip": f.NodeIP["pve3"]},
		})
	case p == "/cluster/resources":
		res := []map[string]any{}
		for _, n := range []string{"pve1", "pve2", "pve3"} {
			res = append(res, map[string]any{"type": "node", "node": n, "status": "online", "cpu": 0.12, "maxcpu": 40, "mem": 50 << 30, "maxmem": 503 << 30, "uptime": 3600})
			res = append(res, map[string]any{"type": "storage", "node": n, "storage": "vm-pool", "plugintype": "rbd", "shared": 1, "status": "available", "disk": 1 << 40, "maxdisk": 10 << 40})
			res = append(res, map[string]any{"type": "storage", "node": n, "storage": "local", "plugintype": "dir", "shared": 0, "status": "available", "disk": 85 << 30, "maxdisk": 100 << 30})
			// PVE reports "unknown" for both disabled and unreachable storage.
			res = append(res, map[string]any{"type": "storage", "id": "storage/" + n + "/nas-backup", "node": n, "storage": "nas-backup", "plugintype": "nfs", "shared": 1, "status": "unknown"})
		}
		f.mu.Lock()
		allowed, restricted := f.Restricted[user]
		f.mu.Unlock()
		if restricted {
			res = []map[string]any{}
		}
		for _, g := range f.Guests {
			if restricted && !containsInt(allowed, g["vmid"]) {
				continue
			}
			x := map[string]any{"maxcpu": 2, "maxmem": 4 << 30, "maxdisk": 32 << 30, "mem": 1 << 30, "cpu": 0.03, "uptime": 1000}
			for k, v := range g {
				x[k] = v
			}
			res = append(res, x)
		}
		write(w, 200, res)
	case p == "/storage":
		f.mu.Lock()
		out := make([]map[string]any, 0, len(f.StorageConfig))
		for _, sc := range f.StorageConfig {
			m := map[string]any{}
			for k, v := range sc {
				m[k] = v
			}
			out = append(out, m)
		}
		f.mu.Unlock()
		write(w, 200, out)
	case p == "/cluster/ceph/status":
		write(w, 200, map[string]any{"health": map[string]any{"status": "HEALTH_OK"}, "osdmap": map[string]any{"num_osds": 9, "num_up_osds": 9, "num_in_osds": 9}, "pgmap": map[string]any{"bytes_used": 3 << 40, "bytes_total": 31 << 40}})
	case p == "/cluster/ha/status/current":
		out := []map[string]any{{"type": "quorum", "id": "quorum", "quorate": 1, "status": "OK"}}
		f.mu.Lock()
		out = append(out, f.HAServices...)
		f.mu.Unlock()
		write(w, 200, out)
	case p == "/cluster/nextid":
		write(w, 200, "301")
	case p == "/cluster/mapping/pci":
		write(w, 200, []map[string]any{{"id": "gpu-a2-0", "description": "NVIDIA A2 #0", "map": []string{"node=pve1,path=0000:16:00.0,id=10de:25b6,iommugroup=10"}},
			{"id": "gpu-a2-1", "description": "NVIDIA A2 #1", "map": []string{"node=pve1,path=0000:91:00.0,id=10de:25b6,iommugroup=1"}}})
	case p == "/cluster/sdn/vnets":
		write(w, 200, []map[string]any{{"vnet": "servers", "zone": "evpn1", "tag": 10000}, {"vnet": "lab", "zone": "evpn1", "tag": 10010}})
	case p == "/cluster/backup":
		write(w, 200, []map[string]any{f.BackupJob})
	case p == "/cluster/backup/nightly-all":
		write(w, 200, f.BackupJob)
	case p == "/cluster/backup-info/not-backed-up":
		out := []map[string]any{}
		for _, id := range f.NoBackup {
			out = append(out, map[string]any{"vmid": id, "name": "grafana", "type": "lxc"})
		}
		write(w, 200, out)
	case p == "/cluster/config/nodes":
		r1 := "192.0.2.1x"
		f.mu.Lock()
		ring1 := f.Ring1
		f.mu.Unlock()
		if !ring1 {
			r1 = ""
		}
		out := []map[string]any{}
		for _, n := range []string{"pve1", "pve2", "pve3"} {
			m := map[string]any{"name": n, "ring0_addr": "10.15.15.1x"}
			if r1 != "" {
				m["ring1_addr"] = r1
			}
			out = append(out, m)
		}
		write(w, 200, out)
	case p == "/cluster/firewall/options":
		write(w, 200, map[string]any{"enable": 1, "policy_in": "DROP"})
	case p == "/cluster/tasks":
		write(w, 200, []map[string]any{{"upid": "UPID:pve1:1:2:3:vzdump::root@pam:", "node": "pve1", "type": "vzdump", "id": "120", "user": "root@pam", "starttime": 1700000000, "endtime": 1700000100, "status": "OK"}})
	case strings.HasPrefix(p, "/nodes/") && f.demoGet(w, p, user):
		// handled by demoGet (detail-page reads)
	case strings.HasSuffix(p, "/status") && strings.HasPrefix(p, "/nodes/"):
		write(w, 200, map[string]any{"kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC", "pveversion": "pve-manager/9.2.32"})
	case strings.HasSuffix(p, "/apt/update"):
		if strings.Contains(p, "pve3") {
			write(w, 200, []map[string]any{{"Package": "pve-manager"}, {"Package": "proxmox-kernel"}})
		} else {
			write(w, 200, []map[string]any{})
		}
	case p == "/access/permissions":
		perms := map[string]int{"Sys.Audit": 1}
		f.mu.Lock()
		if user == f.TokenID {
			perms = map[string]int{}
			for k, v := range f.TokenPerms {
				perms[k] = v
			}
		} else if _, restricted := f.Restricted[user]; restricted {
			perms = map[string]int{}
		}
		f.mu.Unlock()
		if f.Admins[user] {
			perms["Sys.Modify"], perms["Sys.Console"], perms["Permissions.Modify"] = 1, 1, 1
		}
		write(w, 200, map[string]any{"/": perms})
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"data":null,"message":"no such path"}`))
	}
}

// userToken creates (POST) or deletes (DELETE) /access/users/{user}/token/{name}.
// A user manages their own tokens with a ticket; tokens cannot create tokens.
func (f *Server) userToken(w http.ResponseWriter, r *http.Request, p, caller string) {
	rest := strings.TrimPrefix(p, "/access/users/")
	user, name, _ := strings.Cut(rest, "/token/")
	tok := f.tokenOf(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	full := user + "!" + name
	f.Calls = append(f.Calls, Call{Method: r.Method, Path: p, User: caller, Token: tok.idOrEmpty()})
	if caller != user {
		write(w, 403, nil)
		return
	}
	switch r.Method {
	case http.MethodPost:
		if tok != nil {
			write(w, 403, nil)
			return
		}
		if _, exists := f.userTokens[full]; exists {
			write(w, 400, nil)
			return
		}
		exp, _ := strconv.ParseInt(r.Form.Get("expire"), 10, 64)
		f.tokenSeq++
		t := &UserToken{ID: full, User: user, Secret: fmt.Sprintf("%08d-0000-4000-8000-%012d", f.tokenSeq, f.tokenSeq), Comment: r.Form.Get("comment"),
			Expire: exp, Privsep: r.Form.Get("privsep") != "0"}
		f.userTokens[full] = t
		write(w, 200, map[string]any{"full-tokenid": full, "value": t.Secret, "info": map[string]any{"expire": exp, "privsep": 0}})
	case http.MethodDelete:
		if tok != nil && !(f.TokenSelfRevoke && tok.ID == full) {
			write(w, 403, nil)
			return
		}
		if _, ok := f.userTokens[full]; !ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"data":null,"message":"no such token '` + name + `' for user '` + user + `'"}`))
			return
		}
		delete(f.userTokens, full)
		write(w, 200, nil)
	}
}

func (t *UserToken) idOrEmpty() string {
	if t == nil {
		return ""
	}
	return t.ID
}

func (f *Server) ticket(w http.ResponseWriter, r *http.Request) {
	user, pass := r.Form.Get("username"), r.Form.Get("password")
	f.mu.Lock()
	defer f.mu.Unlock()
	if ch := r.Form.Get("tfa-challenge"); ch != "" {
		if f.tickets[ch] == user && pass == "totp:"+f.TOTPUsers[user] {
			t := "PVE:" + user + ":OK" + fmt.Sprint(len(f.tickets))
			f.tickets[t] = user
			write(w, 200, map[string]any{"ticket": t, "CSRFPreventionToken": "csrf-" + user, "username": user})
			return
		}
		write(w, 401, nil)
		return
	}
	// renewal: a valid ticket presented as the password
	if f.tickets[pass] == user && !strings.Contains(pass, "!tfa!") {
		t := pass + "R"
		f.tickets[t] = user
		write(w, 200, map[string]any{"ticket": t, "CSRFPreventionToken": "csrf-" + user, "username": user})
		return
	}
	if f.Users[user] == "" || f.Users[user] != pass {
		write(w, 401, nil)
		return
	}
	if _, mfa := f.TOTPUsers[user]; mfa {
		t := "PVE:" + user + ":!tfa!challenge"
		f.tickets[t] = user
		write(w, 200, map[string]any{"ticket": t, "username": user, "NeedTFA": 1})
		return
	}
	t := "PVE:" + user + ":T" + fmt.Sprint(len(f.tickets))
	f.tickets[t] = user
	write(w, 200, map[string]any{"ticket": t, "CSRFPreventionToken": "csrf-" + user, "username": user})
}

func nodeOf(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) >= 2 && parts[0] == "nodes" {
		return parts[1]
	}
	return "pve1"
}

func containsInt(xs []int, v any) bool {
	for _, x := range xs {
		if fmt.Sprint(x) == fmt.Sprint(v) {
			return true
		}
	}
	return false
}

// fakeRRD returns 70 deterministic samples shaped like PVE's rrddata.
func fakeRRD(path, timeframe string) []map[string]any {
	step := map[string]int64{"hour": 60, "day": 1200, "week": 8400, "month": 36000, "year": 432000}[timeframe]
	if step == 0 {
		step = 1200
	}
	now := time.Now().Unix() / step * step
	guest := strings.Contains(path, "/qemu/") || strings.Contains(path, "/lxc/")
	storage := strings.Contains(path, "/storage/")
	out := make([]map[string]any, 0, 70)
	for i := 0; i < 70; i++ {
		t := now - int64(69-i)*step
		x := float64(i)
		phase := float64(len(path)%7) + float64(strings.Count(path, "2"))*1.7 + float64(strings.Count(path, "3"))*3.1
		wave := 0.5 + 0.4*math.Sin(x/7+phase)
		m := map[string]any{"time": t}
		switch {
		case storage:
			m["used"], m["total"] = 1e12+x*1e9, 10e12
		case guest:
			m["cpu"], m["maxcpu"] = 0.1*wave, 2.0
			m["mem"], m["maxmem"] = 1e9+2e8*wave, 4e9
			m["netin"], m["netout"] = 2e5*wave, 1e5*wave
			m["diskread"], m["diskwrite"] = 1e6*wave, 5e5*wave
			m["pressurecpusome"] = 0.3 * wave
		default:
			m["cpu"], m["maxcpu"] = 0.2*wave, 40.0
			m["memused"], m["memtotal"] = 5e10+1e10*wave, 5.4e11
			m["netin"], m["netout"] = 3e7*wave, 1e7*wave
			m["iowait"], m["loadavg"] = 0.01*wave, 3*wave
			m["rootused"], m["roottotal"] = 8e9, 1e11
		}
		if i == 69 {
			delete(m, "cpu") // the newest sample is often incomplete
		}
		out = append(out, m)
	}
	return out
}

// consoleEcho accepts a websocket upgrade (handshake only) and echoes raw bytes.
// A client that asks for the "binary" websocket subprotocol (noVNC in a
// browser, like with real PVE) gets a framed websocket and a minimal VNC
// server instead (see vncServer).
func (f *Server) consoleEcho(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("vncticket") == "" || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		write(w, 400, nil)
		return
	}
	if strings.Contains(r.Header.Get("Sec-WebSocket-Protocol"), "binary") {
		f.vncServer(w, r)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		write(w, 500, nil)
		return
	}
	h := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(h[:]))
	_ = rw.Flush()
	buf := make([]byte, 4096)
	for {
		n, err := rw.Read(buf)
		if n > 0 {
			_, _ = conn.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// demoGet answers the per-node reads used by galley's detail pages, so the
// demo mode is complete. It returns false for paths it does not handle.
func (f *Server) demoGet(w http.ResponseWriter, p, user string) bool {
	seg := strings.Split(strings.Trim(p, "/"), "/")
	if len(seg) < 2 {
		return false
	}
	node := seg[1]
	f.mu.Lock()
	allowed, restricted := f.Restricted[user]
	guests := make([]map[string]any, len(f.Guests))
	copy(guests, f.Guests)
	f.mu.Unlock()
	guestOK := func(id string) map[string]any {
		for _, g := range guests {
			if fmt.Sprint(g["vmid"]) == id && g["node"] == node && (!restricted || containsInt(allowed, g["vmid"])) {
				return g
			}
		}
		return nil
	}
	switch {
	case len(seg) == 3 && seg[2] == "status":
		if restricted {
			write(w, 403, nil)
			return true
		}
		write(w, 200, map[string]any{
			"kversion": "Linux 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC", "pveversion": "pve-manager/9.2.32", "uptime": 47000,
			"cpuinfo": map[string]any{"model": "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz", "cpus": 40, "sockets": 1, "cores": 20},
			"loadavg": []string{"1.20", "1.05", "0.98"}, "cpu": 0.12, "wait": 0.002,
			"memory":    map[string]any{"used": 52 << 30, "total": 503 << 30, "free": 451 << 30},
			"swap":      map[string]any{"used": 0, "total": 8 << 30, "free": 8 << 30},
			"rootfs":    map[string]any{"used": 8 << 30, "total": 100 << 30, "avail": 92 << 30},
			"boot-info": map[string]any{"mode": "efi"}, "current-kernel": map[string]any{"release": "7.0.14-30-pve"},
		})
	case len(seg) == 3 && seg[2] == "network":
		write(w, 200, []map[string]any{
			{"iface": "vmbr0", "type": "bridge", "active": 1, "autostart": 1, "cidr": "192.0.2.1" + node[len(node)-1:] + "/24", "gateway": "192.0.2.1", "bridge_ports": "enp1s0f0"},
			{"iface": "enp1s0f0", "type": "eth", "active": 1},
			{"iface": "enp65s0f0", "type": "eth", "active": 1, "cidr": "10.15.15.1" + node[len(node)-1:] + "/24", "comments": "corosync / ceph mesh"},
		})
	case len(seg) == 4 && seg[2] == "disks" && seg[3] == "list":
		write(w, 200, []map[string]any{
			{"devpath": "/dev/nvme0n1", "model": "SAMSUNG MZQL2960HCJR", "size": 960 << 30, "health": "PASSED", "used": "BIOS boot", "type": "nvme", "wearout": 98},
			{"devpath": "/dev/nvme1n1", "model": "SAMSUNG MZQL23T8HCLS", "size": 3840 << 30, "health": "PASSED", "used": "LVM", "type": "nvme", "wearout": 99},
		})
	case len(seg) == 4 && seg[2] == "hardware" && seg[3] == "pci":
		out := []map[string]any{{"id": "0000:00:1f.6", "class": "0x020000", "vendor_name": "Intel Corporation", "device_name": "Ethernet Connection", "iommugroup": 14}}
		if node == "pve1" {
			out = append(out,
				map[string]any{"id": "0000:16:00.0", "class": "0x030200", "vendor": "0x10de", "device": "0x25b6", "vendor_name": "NVIDIA Corporation", "device_name": "GA107GL [A2 / A16]", "iommugroup": 10, "mdev": 0},
				map[string]any{"id": "0000:91:00.0", "class": "0x030200", "vendor": "0x10de", "device": "0x25b6", "vendor_name": "NVIDIA Corporation", "device_name": "GA107GL [A2 / A16]", "iommugroup": 1, "mdev": 0})
		}
		if node == "pve2" { // a GPU without a PCI mapping yet (Hardware offers to create one)
			out = append(out, map[string]any{"id": "0000:41:00.0", "class": "0x030200", "vendor": "0x10de", "device": "0x27b8", "vendor_name": "NVIDIA Corporation", "device_name": "AD104GL [L4]", "iommugroup": 22, "mdev": 0})
		}
		write(w, 200, out)
	case len(seg) == 3 && seg[2] == "storage":
		write(w, 200, []map[string]any{
			{"storage": "vm-pool", "type": "rbd", "content": "images,rootdir", "active": 1, "enabled": 1, "shared": 1, "used": 1 << 40, "total": 10 << 40, "avail": 9 << 40},
			{"storage": "local", "type": "dir", "content": "iso,vztmpl,backup", "active": 1, "enabled": 1, "used": 85 << 30, "total": 100 << 30, "avail": 15 << 30},
		})
	case len(seg) == 5 && seg[2] == "storage" && seg[4] == "content":
		var out []map[string]any
		switch seg[3] {
		case "local":
			out = []map[string]any{
				{"volid": "local:iso/debian-13.1.0-amd64-netinst.iso", "content": "iso", "format": "iso", "size": 754 << 20, "ctime": 1790000000},
				{"volid": "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", "content": "vztmpl", "format": "tzst", "size": 123 << 20, "ctime": 1790000000},
				{"volid": "local:backup/vzdump-qemu-120-2026_11_24-01_30_00.vma.zst", "content": "backup", "format": "vma.zst", "size": 9 << 30, "vmid": 120, "ctime": 1795483800},
			}
		default:
			for _, g := range guests {
				if g["template"] == nil {
					out = append(out, map[string]any{"volid": fmt.Sprintf("%s:vm-%v-disk-0", seg[3], g["vmid"]), "content": "images", "format": "raw", "size": 32 << 30, "vmid": g["vmid"]})
				}
			}
		}
		write(w, 200, out)
	case len(seg) == 3 && seg[2] == "tasks":
		write(w, 200, []map[string]any{{"upid": "UPID:" + node + ":1:2:3:qmstart:120:root@pam:", "node": node, "type": "qmstart", "id": "120", "user": "root@pam", "starttime": 1795480000, "endtime": 1795480004, "status": "OK"}})
	case len(seg) == 5 && (seg[2] == "qemu" || seg[2] == "lxc") && seg[4] == "config":
		g := guestOK(seg[3])
		if g == nil {
			write(w, 403, nil)
			return true
		}
		name := fmt.Sprint(g["name"])
		if seg[2] == "lxc" {
			write(w, 200, map[string]any{"hostname": name, "arch": "amd64", "cores": 2, "memory": 2048, "swap": 512, "ostype": "debian", "unprivileged": 1, "features": "nesting=1",
				"rootfs": "vm-pool:vm-" + seg[3] + "-disk-0,size=8G", "net0": "name=eth0,bridge=servers,ip=dhcp,type=veth", "onboot": 1, "digest": "f00d" + seg[3]})
			return true
		}
		cfg := map[string]any{"name": name, "cores": 4, "sockets": 1, "cpu": "host", "memory": "8192", "balloon": 0, "machine": "q35", "bios": "ovmf", "ostype": "l26",
			"scsihw": "virtio-scsi-single", "scsi0": "vm-pool:vm-" + seg[3] + "-disk-0,iothread=1,discard=on,ssd=1,size=64G", "efidisk0": "vm-pool:vm-" + seg[3] + "-disk-1,efitype=4m,size=528K",
			"net0": "virtio=BC:24:11:00:01:" + fmt.Sprintf("%02X", len(seg[3])) + ",bridge=servers,firewall=1", "boot": "order=scsi0", "agent": "1", "onboot": 1, "digest": "f00d" + seg[3]}
		if seg[3] == "300" {
			cfg["cores"], cfg["memory"] = 16, "65536"
			cfg["hostpci0"] = "mapping=gpu-a2-0,pcie=1"
		}
		write(w, 200, cfg)
	case len(seg) == 5 && (seg[2] == "qemu" || seg[2] == "lxc") && seg[4] == "snapshot":
		if guestOK(seg[3]) == nil {
			write(w, 403, nil)
			return true
		}
		write(w, 200, []map[string]any{
			{"name": "pre-upgrade", "description": "before 9.2", "snaptime": 1795300000},
			{"name": "current", "parent": "pre-upgrade", "description": "You are here!", "running": 1},
		})
	default:
		return false
	}
	return true
}

// DeleteUserTokens removes every user API token (as an administrator could in the GUI).
func (f *Server) DeleteUserTokens() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.userTokens = map[string]*UserToken{}
}
