package server_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
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
	// a changed host key is refused
	if code := root.do("PUT", "/api/clusters/pve-lab/hosts/pve1", map[string]any{"addr": sc.Addr, "fingerprint": "SHA256:" + strings.Repeat("A", 43)}, nil); code != 204 {
		t.Fatalf("repin: %d", code)
	}
	e = root.runAndWait("host.exec", map[string]any{"node": "pve1", "command": "id"}, "run on pve1")
	if e.OK || !strings.Contains(e.Results[0].Error, "host key changed") {
		t.Fatalf("mismatched host key accepted: %+v", e)
	}
	d.mu.Lock()
	n := len(d.ran)
	d.mu.Unlock()
	if n != 2 {
		t.Fatalf("commands run: %d", n)
	}
	_ = plan.MethodSSH
}
