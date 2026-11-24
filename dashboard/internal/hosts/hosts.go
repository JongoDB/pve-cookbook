// Package hosts runs commands on PVE nodes over SSH, for the work the PVE API
// cannot do (NIC flow control, kernel parameters, disk wipes, package holds).
// galley uses its own ed25519 key and only connects to hosts whose key an
// admin pinned after comparing fingerprints.
package hosts

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Key is galley's SSH identity.
type Key struct {
	signer ssh.Signer
	pem    []byte
}

// NewKey generates an ed25519 key.
func NewKey() (*Key, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	blk, err := ssh.MarshalPrivateKey(priv, "galley")
	if err != nil {
		return nil, err
	}
	return ParseKey(pem.EncodeToMemory(blk))
}

// ParseKey loads a PEM private key.
func ParseKey(p []byte) (*Key, error) {
	s, err := ssh.ParsePrivateKey(p)
	if err != nil {
		return nil, err
	}
	return &Key{signer: s, pem: p}, nil
}

// PEM returns the private key for storage (encrypt it at rest).
func (k *Key) PEM() []byte { return k.pem }

// AuthorizedKey is the line to add to /root/.ssh/authorized_keys. "restrict"
// disables port/agent/X11 forwarding and PTY allocation; commands still run.
func (k *Key) AuthorizedKey() string {
	return "restrict " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k.signer.PublicKey()))) + " galley"
}

// Scan connects without authenticating and returns the host key fingerprint
// (SHA256:…) for an admin to compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the node.
func Scan(ctx context.Context, addr string) (string, error) {
	var fp string
	cfg := &ssh.ClientConfig{
		User: "root",
		Auth: []ssh.AuthMethod{ssh.Password("")},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			fp = ssh.FingerprintSHA256(key)
			return errScanned
		},
		// Scan and Run must negotiate the same key type, or the pin never matches.
		HostKeyAlgorithms: hostKeyAlgos,
		Timeout:           10 * time.Second,
	}
	conn, err := dial(ctx, addr)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	setDeadline(ctx, conn)
	_, _, _, err = ssh.NewClientConn(conn, addr, cfg)
	if fp != "" {
		return fp, nil
	}
	return "", err
}

var errScanned = errors.New("scanned")

// hostKeyAlgos pins the ed25519 host key, which every current Debian/PVE node has.
var hostKeyAlgos = []string{ssh.KeyAlgoED25519}

// setDeadline bounds the SSH handshake (ClientConfig.Timeout only applies to ssh.Dial).
func setDeadline(ctx context.Context, conn net.Conn) {
	d := time.Now().Add(15 * time.Second)
	if dl, ok := ctx.Deadline(); ok && dl.Before(d) {
		d = dl
	}
	_ = conn.SetDeadline(d)
}

func dial(ctx context.Context, addr string) (net.Conn, error) {
	if _, _, err := net.SplitHostPort(addr); err != nil {
		addr = net.JoinHostPort(addr, "22")
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	return d.DialContext(ctx, "tcp", addr)
}

// Result of a command.
type Result struct {
	Output string `json:"output"`
	Exit   int    `json:"exit"`
}

// MaxOutput bounds captured output (stdout and stderr combined).
const MaxOutput = 256 << 10

// capped is written concurrently by the stdout and stderr copiers.
type capped struct {
	mu  sync.Mutex
	buf bytes.Buffer
	cut bool
}

func (c *capped) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.buf.String()
	if c.cut {
		s += "\n…(output truncated)"
	}
	return s
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := MaxOutput - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.cut = true
		} else {
			c.buf.Write(p)
		}
	} else {
		c.cut = true
	}
	return len(p), nil
}

// Run executes command as root on addr, verifying the pinned host key.
func Run(ctx context.Context, k *Key, addr, pinnedFP, command string) (Result, error) {
	if pinnedFP == "" {
		return Result{}, errors.New("host key not pinned")
	}
	cfg := &ssh.ClientConfig{
		User: "root",
		Auth: []ssh.AuthMethod{ssh.PublicKeys(k.signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if got := ssh.FingerprintSHA256(key); got != pinnedFP {
				return fmt.Errorf("host key changed: pinned %s, got %s — refusing to connect", pinnedFP, got)
			}
			return nil
		},
		HostKeyAlgorithms: hostKeyAlgos,
		Timeout:           10 * time.Second,
	}
	conn, err := dial(ctx, addr)
	if err != nil {
		return Result{}, err
	}
	setDeadline(ctx, conn)
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return Result{}, err
	}
	_ = conn.SetDeadline(time.Time{}) // the command itself is bounded by ctx
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return Result{}, err
	}
	defer sess.Close()
	out := &capped{}
	sess.Stdout, sess.Stderr = out, out
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
	select {
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGTERM)
		client.Close()
		<-done // copiers finish before the buffer is read
		return Result{Output: out.String(), Exit: -1}, ctx.Err()
	case err := <-done:
		res := Result{Output: out.String()}
		var ee *ssh.ExitError
		switch {
		case err == nil:
		case errors.As(err, &ee):
			res.Exit = ee.ExitStatus()
		default:
			return res, err
		}
		return res, nil
	}
}
