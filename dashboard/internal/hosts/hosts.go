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
		HostKeyAlgorithms: []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoRSASHA256},
		Timeout:           10 * time.Second,
	}
	conn, err := dial(ctx, addr)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_, _, _, err = ssh.NewClientConn(conn, addr, cfg)
	if fp != "" {
		return fp, nil
	}
	return "", err
}

var errScanned = errors.New("scanned")

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

type capped struct {
	buf bytes.Buffer
	cut bool
}

func (c *capped) Write(p []byte) (int, error) {
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
		Timeout: 10 * time.Second,
	}
	conn, err := dial(ctx, addr)
	if err != nil {
		return Result{}, err
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return Result{}, err
	}
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
		return Result{Output: out.buf.String(), Exit: -1}, ctx.Err()
	case err := <-done:
		res := Result{Output: out.buf.String()}
		if out.cut {
			res.Output += "\n…(output truncated)"
		}
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
