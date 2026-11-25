package server

import (
	"testing"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

func TestHostAccess(t *testing.T) {
	for path, want := range map[string]bool{
		"/access/users":                         true,
		"/access/users/a@pve":                   true,
		"/access/users/a@pve/token/x":           true,
		"/access/acl":                           true,
		"/access/password":                      true,
		"/access":                               true,
		"/nodes/pve1/execute":                   true,
		"/nodes/pve1/termproxy":                 true,
		"/nodes/pve1/vncshell":                  true,
		"/nodes/pve1/spiceshell":                true,
		"/nodes/pve1/apt/repositories":          true,
		"/cluster/config/join":                  true,
		"/nodes/pve1/./execute":                 true,
		"/nodes/../access/acl":                  true,
		"/accessories":                          false,
		"/nodes/pve1/qemu/120/status/start":     false,
		"/nodes/pve1/qemu/120/snapshot":         false,
		"/nodes/access/qemu/120/config":         false,
		"/cluster/backup/nightly":               false,
		"/cluster/ha/rules":                     false,
		"/nodes/pve1/lxc/130/status/reboot":     false,
		"/nodes/pve1/qemu/120/agent/ping":       false,
		"/cluster/sdn/vnets/access":             false,
		"/nodes/pve1/storage/local/content/apt": false,
	} {
		p := &plan.Plan{Steps: []plan.Step{{Method: "PUT", Path: "/cluster/options"}, {Method: "POST", Path: path}}}
		if got := hostAccess(p) != ""; got != want {
			t.Errorf("%s: %v, want %v", path, got, want)
		}
	}
	for _, m := range []string{plan.MethodSSH, plan.MethodGalley} {
		if hostAccess(&plan.Plan{Steps: []plan.Step{{Method: m, Path: "pve1"}}}) == "" {
			t.Errorf("%s step not gated", m)
		}
	}
}

func TestRoutine(t *testing.T) {
	const g = "/nodes/pve1/qemu/120"
	for _, c := range []struct {
		method, path string
		body         map[string]string
		ok           bool
	}{
		{"POST", g + "/status/start", nil, true},
		{"POST", "/nodes/pve1/lxc/130/status/reboot", map[string]string{"timeout": "60"}, true},
		{"POST", g + "/snapshot", map[string]string{"snapname": "a"}, true},
		{"POST", g + "/migrate", map[string]string{"target": "pve2", "online": "1"}, true},
		{"PUT", g + "/config", map[string]string{"cores": "4", "memory": "4096"}, true},
		{"POST", "/nodes/pve1/vzdump", map[string]string{"vmid": "120", "remove": "0"}, true},

		{"POST", "/nodes/pve1/vzdump", map[string]string{"vmid": "120"}, false}, // prunes older backups
		{"POST", "/nodes/pve1/vzdump", map[string]string{"vmid": "120", "remove": "0", "mode": "stop"}, false},
		{"POST", "/nodes/pve1/vzdump", map[string]string{"all": "1", "remove": "0"}, false},
		{"POST", g + "/status/shutdown", map[string]string{"forceStop": "1"}, false},
		{"POST", g + "/status/stop", nil, false},
		{"POST", g + "/migrate", map[string]string{"target": "pve2", "force": "1"}, false},
		{"PUT", g + "/config", map[string]string{"cores": "4", "net0": "virtio,bridge=vmbr1"}, false},
		{"PUT", g + "/config", map[string]string{"cipassword": "x"}, false},
		{"PUT", g + "/config", map[string]string{"sshkeys": "x"}, false},
		{"PUT", g + "/config", map[string]string{"protection": "0"}, false},
		{"PUT", g + "/config", map[string]string{"delete": "scsi0"}, false},
		{"PUT", g + "/config", map[string]string{"hookscript": "local:snippets/x"}, false},
		{"POST", g + "/agent/exec", map[string]string{"command": "id"}, false},
		{"POST", g + "/agent", map[string]string{"command": "shutdown"}, false},
		{"POST", g + "/agent/set-user-password", nil, false},
		{"POST", g + "/snapshot/a/rollback", nil, false},
		{"DELETE", g + "/snapshot/a", nil, false},
		{"DELETE", g, nil, false},
		{"POST", "/nodes/pve1/qemu", map[string]string{"vmid": "900"}, false},
		{"POST", "/nodes/pve1/lxc", map[string]string{"vmid": "900"}, false},
		{"PUT", "/cluster/backup/nightly", map[string]string{"enabled": "0"}, false},
		{"PUT", "/nodes/pve1/network", nil, false},
		{"POST", "/nodes/pve1/network", nil, false},
		{"PUT", "/cluster/firewall/options", map[string]string{"policy_in": "ACCEPT"}, false},
		{"POST", g + "/firewall/rules", nil, false},
		{"PUT", "/cluster/options", nil, false},
		{"POST", "/storage", nil, false},
		{"PUT", "/access/acl", nil, false},
		{"POST", "/some/future/endpoint", nil, false},
	} {
		p := &plan.Plan{Action: "api.call", Steps: []plan.Step{{Method: "POST", Path: g + "/status/start"}, {Method: c.method, Path: c.path, Body: c.body}}}
		if got := risky(p) == ""; got != c.ok {
			t.Errorf("%s %s %v: routine = %v, want %v", c.method, c.path, c.body, got, c.ok)
		}
	}
	if risky(&plan.Plan{Destructive: true, Steps: []plan.Step{{Method: "POST", Path: g + "/status/start"}}}) == "" {
		t.Error("a destructive change is never routine")
	}
}
