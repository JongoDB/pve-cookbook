package schema_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/schema"
)

func load(t *testing.T) *schema.Schema {
	t.Helper()
	s, err := schema.Parse([]byte(fakepve.APIDoc))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestParseAndMatch(t *testing.T) {
	s := load(t)
	if len(s.Paths()) != 5 {
		t.Fatalf("paths: %d", len(s.Paths()))
	}
	n, vars, err := s.Match("/nodes/pve1/qemu/120/config")
	if err != nil || n.Path != "/nodes/{node}/qemu/{vmid}/config" || vars["node"] != "pve1" || vars["vmid"] != "120" {
		t.Fatalf("match: %v %v %v", n, vars, err)
	}
	if _, _, err := s.Match("/nodes/pve1/nope"); err == nil {
		t.Fatal("unknown path matched")
	}
}

func TestValidate(t *testing.T) {
	s := load(t)
	cases := []struct {
		name, method, path string
		body               map[string]string
		wantErr            string
	}{
		{"ok config", "PUT", "/nodes/pve1/qemu/120/config", map[string]string{"cores": "4", "net0": "virtio,bridge=vmbr0", "hostpci1": "mapping=gpu-a2-1,pcie=1", "delete": "balloon"}, ""},
		{"unknown key", "PUT", "/nodes/pve1/qemu/120/config", map[string]string{"bogus": "1"}, "not a parameter"},
		{"range", "PUT", "/nodes/pve1/qemu/120/config", map[string]string{"cores": "0"}, "at least 1"},
		{"type", "PUT", "/nodes/pve1/qemu/120/config", map[string]string{"cores": "four"}, "integer"},
		{"bad path var", "PUT", "/nodes/pve1/qemu/abc/config", map[string]string{}, "vmid: must be an integer"},
		{"no method", "POST", "/nodes/pve1/qemu/120/config", map[string]string{}, "method not allowed"},
		{"required", "POST", "/nodes/pve1/qemu", map[string]string{"name": "x"}, "vmid: required"},
		{"enum", "POST", "/nodes/pve1/qemu", map[string]string{"vmid": "200", "ostype": "dos"}, "one of"},
		{"path var in body", "POST", "/nodes/pve1/qemu", map[string]string{"vmid": "200", "node": "pve2"}, "set in the path"},
		{"create ok", "POST", "/nodes/pve1/qemu", map[string]string{"vmid": "200", "cores": "2", "scsi0": "vm-pool:32", "start": "1"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.Validate(c.method, c.path, c.body)
			if c.wantErr == "" && err != nil {
				t.Fatalf("unexpected: %v", err)
			}
			if c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("want %q, got %v", c.wantErr, err)
			}
			if c.wantErr == "method not allowed" && !errors.Is(err, schema.ErrNoMethod) {
				t.Fatal("want ErrNoMethod")
			}
		})
	}
}

func TestCLI(t *testing.T) {
	got := schema.CLI("PUT", "/nodes/pve1/qemu/120/config", map[string]string{"description": "it's mine", "cores": "4"})
	want := `pvesh set /nodes/pve1/qemu/120/config --cores 4 --description 'it'\''s mine'`
	if got != want {
		t.Fatalf("got %s", got)
	}
}
