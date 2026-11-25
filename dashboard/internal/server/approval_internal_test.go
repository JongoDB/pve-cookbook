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
