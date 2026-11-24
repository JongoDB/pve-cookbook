package pve_test

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
)

func ctx(t *testing.T) context.Context { t.Helper(); return context.Background() }

func TestPinnedFingerprintAccepted(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	cl := pve.New([]pve.Endpoint{f.Endpoint()}, pve.TokenAuth{ID: f.TokenID, Secret: f.Secret})
	var v map[string]any
	if err := cl.Get(ctx(t), "/version", &v); err != nil {
		t.Fatalf("pinned endpoint rejected: %v", err)
	}
	if v["version"] != "9.2.32" {
		t.Fatalf("unexpected version payload %v", v)
	}
}

func TestWrongFingerprintRejected(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	ep := f.Endpoint()
	ep.Fingerprint = strings.Repeat("00:", 31) + "00"
	err := pve.New([]pve.Endpoint{ep}, pve.TokenAuth{ID: f.TokenID, Secret: f.Secret}).Get(ctx(t), "/version", nil)
	if err == nil || !strings.Contains(err.Error(), "fingerprint mismatch") {
		t.Fatalf("expected fingerprint mismatch, got %v", err)
	}
}

func TestUnpinnedSelfSignedRejected(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	ep := f.Endpoint()
	ep.Fingerprint = ""
	if err := pve.New([]pve.Endpoint{ep}, nil).Get(ctx(t), "/version", nil); err == nil {
		t.Fatal("self-signed endpoint without pin must be rejected")
	}
}

func TestFailoverToNextEndpoint(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	// a closed port first, then a node answering 595, then the healthy node
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := l.Addr().String()
	l.Close()
	down := fakepve.New()
	defer down.Close()
	down.Down = true
	cl := pve.New([]pve.Endpoint{{Host: dead}, down.Endpoint(), f.Endpoint()}, pve.TokenAuth{ID: f.TokenID, Secret: f.Secret})
	if err := cl.Get(ctx(t), "/version", nil); err != nil {
		t.Fatalf("failover failed: %v", err)
	}
	if cl.Active() != f.Endpoint().Host {
		t.Fatalf("active endpoint = %s, want healthy one", cl.Active())
	}
}

func TestAPIErrorNotRetried(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	cl := pve.New([]pve.Endpoint{f.Endpoint()}, pve.TokenAuth{ID: f.TokenID, Secret: "wrong"})
	var ae *pve.APIError
	if err := cl.Get(ctx(t), "/version", nil); !errors.As(err, &ae) || ae.Status != 401 {
		t.Fatalf("expected 401 APIError, got %v", err)
	}
}

func TestLoginAndTOTP(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	cl := pve.New([]pve.Endpoint{f.Endpoint()}, nil)
	tk, err := cl.Login(ctx(t), "root@pam", "secret", "")
	if err != nil || tk.Ticket == "" || tk.CSRF == "" {
		t.Fatalf("login: %v %+v", err, tk)
	}
	if _, err := cl.Login(ctx(t), "root@pam", "nope", ""); err == nil {
		t.Fatal("bad password accepted")
	}
	if _, err := cl.Login(ctx(t), "mfa@pve", "mfapass", ""); err == nil || !strings.Contains(err.Error(), "second factor") {
		t.Fatalf("expected second factor error, got %v", err)
	}
	if tk, err := cl.Login(ctx(t), "mfa@pve", "mfapass", "123456"); err != nil || tk.User != "mfa@pve" {
		t.Fatalf("totp login: %v", err)
	}
	// ticket auth works for reads and sends CSRF on writes
	ucl := cl.WithAuth(tk)
	if err := ucl.Get(ctx(t), "/cluster/status", nil); err != nil {
		t.Fatalf("ticket read: %v", err)
	}
}

func TestProbe(t *testing.T) {
	f := fakepve.New()
	defer f.Close()
	p := pve.ProbeEndpoint(ctx(t), f.Endpoint().Host)
	if !p.Reachable || p.Fingerprint != f.Endpoint().Fingerprint || p.TrustedBySystem {
		t.Fatalf("probe = %+v", p)
	}
}
