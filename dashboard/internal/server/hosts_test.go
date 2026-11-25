package server_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/hosts"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"golang.org/x/crypto/ssh"
)

// sshd is a minimal SSH server: it accepts one authorized key and answers
// "exec" requests with "ran: <command>" (exit 3 for "false").
type sshd struct {
	addr, fp string
	mu       sync.Mutex
	allowed  ssh.PublicKey
	ran      []string
}

func newSSHD(t *testing.T) *sshd {
	_, hk, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(hk)
	d := &sshd{fp: ssh.FingerprintSHA256(signer.PublicKey())}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.allowed != nil && string(k.Marshal()) == string(d.allowed.Marshal()) {
			return nil, nil
		}
		return nil, ssh.ErrNoAuth
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	d.addr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					ch, creqs, _ := nc.Accept()
					go func() {
						for req := range creqs {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							n := binary.BigEndian.Uint32(req.Payload[:4])
							cmd := string(req.Payload[4 : 4+n])
							d.mu.Lock()
							d.ran = append(d.ran, cmd)
							d.mu.Unlock()
							req.Reply(true, nil)
							ch.Write([]byte("ran: " + cmd + "\n"))
							code := uint32(0)
							if cmd == "false" {
								code = 3
							}
							st := make([]byte, 4)
							binary.BigEndian.PutUint32(st, code)
							ch.SendRequest("exit-status", false, st)
							ch.Close()
						}
					}()
				}
			}()
		}
	}()
	return d
}

func TestHostCommands(t *testing.T) {
	h := newHarness(t)
	d := newSSHD(t)
	h.fake.Update(func(f *fakepve.Server) { f.NodeIP["pve1"] = d.addr })
	h.setup()
	root := h.login("root@pam", "secret")
	dev := h.login("dev@pve", "devpass")
	if code := dev.do("GET", "/api/clusters/pve-lab/hosts", nil, nil); code != 403 {
		t.Fatalf("non-admin sees hosts: %d", code)
	}
	// SSH is opt-in: no key exists until a galley admin switches the transport.
	var hl0 map[string]any
	if code := root.do("GET", "/api/clusters/pve-lab/hosts", nil, &hl0); code != 200 || hl0["transport"] != "pve" || hl0["authorizedKey"] != nil {
		t.Fatalf("default transport: %d %v", code, hl0)
	}
	if _, err := h.st.GetSetting("hosts.key.pve-lab"); err == nil {
		t.Fatal("SSH key created without opting in")
	}
	if code := dev.do("PUT", "/api/clusters/pve-lab", map[string]any{"hostTransport": "ssh"}, nil); code != 403 {
		t.Fatalf("non-admin enabled SSH: %d", code)
	}
	if code := root.do("PUT", "/api/clusters/pve-lab", map[string]any{"hostTransport": "ssh"}, nil); code != 200 {
		t.Fatalf("enable SSH: %d", code)
	}
	var hl struct{ AuthorizedKey, Install string }
	if code := root.do("GET", "/api/clusters/pve-lab/hosts", nil, &hl); code != 200 || !strings.HasPrefix(hl.AuthorizedKey, "restrict ssh-ed25519 ") {
		t.Fatalf("hosts: %d %+v", code, hl)
	}
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimPrefix(hl.AuthorizedKey, "restrict ")))
	if err != nil {
		t.Fatal(err)
	}
	d.mu.Lock()
	d.allowed = pk
	d.mu.Unlock()

	// not pinned yet: drafting works, running refuses
	var sc struct{ Addr, Fingerprint string }
	if code := root.do("POST", "/api/clusters/pve-lab/hosts/pve1/scan", map[string]any{}, &sc); code != 200 || sc.Fingerprint != d.fp {
		t.Fatalf("scan: %d %+v (want %s)", code, sc, d.fp)
	}
	if code := root.do("PUT", "/api/clusters/pve-lab/hosts/pve1", map[string]any{"addr": sc.Addr, "fingerprint": sc.Fingerprint}, nil); code != 204 {
		t.Fatalf("pin: %d", code)
	}
	// dev may not even draft host commands
	if code := dev.do("POST", "/api/plans", map[string]any{"action": "host.exec", "clusterId": "pve-lab", "params": map[string]any{"node": "pve1", "command": "id"}}, nil); code != 403 {
		t.Fatalf("dev drafted host command: %d", code)
	}
	e := root.runAndWait("host.exec", map[string]any{"node": "pve1", "command": "ethtool -A enp1s0 rx on tx on", "reason": "flow control"}, "run on pve1")
	if !e.OK || !strings.Contains(e.Results[0].Output, "ran: ethtool -A enp1s0 rx on tx on") {
		t.Fatalf("exec: %+v", e)
	}
	e = root.runAndWait("host.exec", map[string]any{"node": "pve1", "command": "false"}, "run on pve1")
	if e.OK || e.Results[0].ExitStatus != "exit 3" {
		t.Fatalf("failing command: %+v", e)
	}
	// a pin must match what the node's own address presents, and the address can't be redirected
	if code := root.do("PUT", "/api/clusters/pve-lab/hosts/pve1", map[string]any{"fingerprint": "SHA256:" + strings.Repeat("A", 43)}, nil); code != 409 {
		t.Fatalf("pin with wrong fingerprint: %d", code)
	}
	if code := root.do("PUT", "/api/clusters/pve-lab/hosts/pve1", map[string]any{"addr": "203.0.113.9:22", "fingerprint": sc.Fingerprint}, nil); code != 400 {
		t.Fatalf("pin redirected to another address: %d", code)
	}
	// a node whose key changed after pinning is refused at run time
	d2 := newSSHD(t)
	d2.mu.Lock()
	d2.allowed = pk
	d2.mu.Unlock()
	h.fake.Update(func(f *fakepve.Server) { f.NodeIP["pve2"] = d2.addr })
	var sc2 struct{ Addr, Fingerprint string }
	root.do("POST", "/api/clusters/pve-lab/hosts/pve2/scan", map[string]any{}, &sc2)
	if code := root.do("PUT", "/api/clusters/pve-lab/hosts/pve2", map[string]any{"fingerprint": sc2.Fingerprint}, nil); code != 204 {
		t.Fatalf("pin pve2: %d", code)
	}
	// simulate pve2 being replaced by a machine with a different host key at the pinned address
	pins := map[string]map[string]map[string]any{}
	raw, _ := h.st.GetSetting("hosts.pins")
	_ = json.Unmarshal([]byte(raw), &pins)
	pins["pve-lab"]["pve2"]["addr"] = d.addr
	b, _ := json.Marshal(pins)
	if err := h.st.PutSetting("hosts.pins", string(b)); err != nil {
		t.Fatal(err)
	}
	e = root.runAndWait("host.exec", map[string]any{"node": "pve2", "command": "id"}, "run on pve2")
	if e.OK || !strings.Contains(e.Results[0].Error, "host key changed") {
		t.Fatalf("mismatched host key accepted: %+v", e)
	}
	d.mu.Lock()
	n := len(d.ran)
	d.mu.Unlock()
	if n != 2 {
		t.Fatalf("commands run: %d", n)
	}
	// switching back to the PVE terminal destroys galley's SSH key
	if code := root.do("PUT", "/api/clusters/pve-lab", map[string]any{"hostTransport": "pve"}, nil); code != 200 {
		t.Fatalf("disable SSH: %d", code)
	}
	if _, err := h.st.GetSetting("hosts.key.pve-lab"); err == nil {
		t.Fatal("SSH key kept after switching to the PVE transport")
	}
	if raw, _ := h.st.GetSetting("hosts.pins"); strings.Contains(raw, "pve-lab") {
		t.Fatalf("host key pins kept after switching to the PVE transport: %s", raw)
	}
	_ = plan.MethodSSH
}

func TestHostCommandsThroughPVETerminal(t *testing.T) {
	h := newHarness(t)
	h.setup()
	var mu sync.Mutex
	big := strings.Repeat("x", hosts.MaxOutput+1000)
	h.fake.Update(func(f *fakepve.Server) {
		f.HostRun = func(cmd string) (string, int) {
			mu.Lock()
			defer mu.Unlock()
			switch cmd {
			case "false":
				return "", 3
			case "flood":
				return big, 0
			}
			return "out: " + cmd + "\nline two", 0 // no trailing newline
		}
	})
	root := h.login("root@pam", "secret")
	cmd := "ethtool -A enp1s0 rx on tx on && echo 'quotes \"and\" $vars; ^C \x03'\n" + strings.Repeat(" # long line", 600)
	e := root.runAndWait("host.exec", map[string]any{"node": "pve1", "command": cmd, "reason": "flow control"}, "run on pve1")
	if !e.OK || e.Results[0].Output != "out: "+cmd+"\nline two" {
		t.Fatalf("exec: %+v", e)
	}
	if got := h.fake.HostCommands(); len(got) != 1 || got[0] != "pve1: "+cmd {
		t.Fatalf("node ran %q", got)
	}
	e = root.runAndWait("host.exec", map[string]any{"node": "pve2", "command": "false"}, "run on pve2")
	if e.OK || e.Results[0].ExitStatus != "exit 3" {
		t.Fatalf("failing command: %+v", e)
	}
	e = root.runAndWait("host.exec", map[string]any{"node": "pve1", "command": "flood"}, "run on pve1")
	if !e.OK || len(e.Results[0].Output) > hosts.MaxOutput+100 || !strings.HasSuffix(e.Results[0].Output, "(output truncated)") {
		t.Fatalf("output not capped: ok=%v len=%d", e.OK, len(e.Results[0].Output))
	}
	// no SSH key was ever created
	if _, err := h.st.GetSetting("hosts.key.pve-lab"); err == nil {
		t.Fatal("SSH key created")
	}
	// A host admin who is not root@pam gets PVE's login prompt: refused clearly.
	h.fake.Update(func(f *fakepve.Server) { f.Admins["ops@pve"] = true })
	ops := h.login("ops@pve", "opspass")
	e = ops.runAndWait("host.exec", map[string]any{"node": "pve1", "command": "id"}, "run on pve1")
	if e.OK || !strings.Contains(e.Results[0].Error, "root@pam") {
		t.Fatalf("non-root terminal: %+v", e)
	}
	if got := h.fake.HostCommands(); len(got) != 3 {
		t.Fatalf("commands typed into a login prompt ran: %q", got)
	}
}
