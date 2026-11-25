package server

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	in := `{"data":{"cipassword":"hunter2","name":"web","tokens":[{"tokenid":"x","value":"keep"}],"description":"ticket PVE:root@pam:65A1B2C3::abcdefghijklmnopqrstuvwxyz012345 and PVEAPIToken=root@pam!t=uuid"}}`
	out := redactSecrets(in)
	for _, leak := range []string{"hunter2", "abcdefghijklmnop", "root@pam!t=uuid"} {
		if strings.Contains(out, leak) {
			t.Errorf("leaked %q: %s", leak, out)
		}
	}
	if !strings.Contains(out, `"name":"web"`) || !strings.Contains(out, `"value":"keep"`) {
		t.Errorf("over-redacted: %s", out)
	}
}

func TestAIHostCommandGuard(t *testing.T) {
	for _, c := range []string{"cat /etc/pve/priv/token.cfg", "sqlite3 /var/lib/galley/galley.db .dump", "cat ~/.ssh/id_ed25519", "cat /etc/shadow"} {
		if aiHostCommandProblem(c) == "" {
			t.Errorf("allowed %q", c)
		}
	}
	for _, c := range []string{"ethtool -A enp1s0 rx off tx off", "apt-get update", "zpool status"} {
		if aiHostCommandProblem(c) != "" {
			t.Errorf("refused %q", c)
		}
	}
}
