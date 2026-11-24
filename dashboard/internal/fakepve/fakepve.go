// Package fakepve is an in-memory, TLS-serving imitation of the parts of the
// Proxmox VE API that galley uses. Response shapes follow PVE 9. Used by tests.
package fakepve

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
}

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
	Down      bool // respond 595 to everything (simulates pveproxy failure)
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
	}
	f.TOTPUsers["mfa@pve"] = "123456"
	f.Users["mfa@pve"] = "mfapass"
	f.Server = httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	f.Server.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	f.StartTLS()
	return f
}

// Endpoint returns this server as a pinned galley endpoint.
func (f *Server) Endpoint() pve.Endpoint {
	return pve.Endpoint{Host: strings.TrimPrefix(f.URL, "https://"), Fingerprint: pve.Fingerprint(f.Certificate())}
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

func (f *Server) who(r *http.Request) string {
	if a := r.Header.Get("Authorization"); a == "PVEAPIToken="+f.TokenID+"="+f.Secret {
		return f.TokenID
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
	if f.Down {
		w.WriteHeader(595)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/api2/json")
	_ = r.ParseForm()
	if p == "/access/ticket" && r.Method == http.MethodPost {
		f.ticket(w, r)
		return
	}
	user := f.who(r)
	if user == "" {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"data":null,"message":"authentication failure"}`))
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
		f.mu.Lock()
		f.Calls = append(f.Calls, Call{Method: r.Method, Path: p, Form: form, User: user})
		f.mu.Unlock()
		if p == "/cluster/backup/nightly-all" && r.Method == http.MethodPut {
			write(w, 200, nil)
			return
		}
		write(w, 200, fmt.Sprintf("UPID:pve1:0000ABCD:00000001:%08X:fake:%s:%s:", time.Now().Unix(), strings.ReplaceAll(p, "/", "_"), user))
		return
	}
	switch {
	case p == "/version":
		write(w, 200, map[string]any{"version": "9.2.32", "release": "9.2"})
	case p == "/cluster/status":
		write(w, 200, []map[string]any{
			{"type": "cluster", "name": "pve-lab", "quorate": 1, "nodes": 3},
			{"type": "node", "name": "pve1", "online": 1}, {"type": "node", "name": "pve2", "online": 1}, {"type": "node", "name": "pve3", "online": 1},
		})
	case p == "/cluster/resources":
		res := []map[string]any{}
		for _, n := range []string{"pve1", "pve2", "pve3"} {
			res = append(res, map[string]any{"type": "node", "node": n, "status": "online", "cpu": 0.12, "maxcpu": 40, "mem": 50 << 30, "maxmem": 503 << 30, "uptime": 3600})
			res = append(res, map[string]any{"type": "storage", "node": n, "storage": "vm-pool", "plugintype": "rbd", "shared": 1, "status": "available", "disk": 1 << 40, "maxdisk": 10 << 40})
			res = append(res, map[string]any{"type": "storage", "node": n, "storage": "local", "plugintype": "dir", "shared": 0, "status": "available", "disk": 85 << 30, "maxdisk": 100 << 30})
		}
		for _, g := range f.Guests {
			x := map[string]any{"maxcpu": 2, "maxmem": 4 << 30, "maxdisk": 32 << 30, "mem": 1 << 30, "cpu": 0.03, "uptime": 1000}
			for k, v := range g {
				x[k] = v
			}
			res = append(res, x)
		}
		write(w, 200, res)
	case p == "/cluster/ceph/status":
		write(w, 200, map[string]any{"health": map[string]any{"status": "HEALTH_OK"}, "osdmap": map[string]any{"num_osds": 9, "num_up_osds": 9, "num_in_osds": 9}, "pgmap": map[string]any{"bytes_used": 3 << 40, "bytes_total": 31 << 40}})
	case p == "/cluster/ha/status/current":
		write(w, 200, []map[string]any{{"type": "quorum", "id": "quorum", "quorate": 1, "status": "OK"}, {"type": "service", "id": "vm:120", "state": "started"}})
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
		if !f.Ring1 {
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
		if f.Admins[user] {
			perms["Sys.Modify"] = 1
		}
		write(w, 200, map[string]any{"/": perms})
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"data":null,"message":"no such path"}`))
	}
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
