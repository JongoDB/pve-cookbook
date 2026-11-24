package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestKeyFileIsNeverOverwritten(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "secret.key"), []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("expected refusal, got %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "secret.key"))
	if string(b) != "short" {
		t.Fatal("key file was modified")
	}
}

func TestReopenKeepsDataAndMigrationsAreIdempotent(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddCluster(Cluster{ID: "a", Name: "a", TokenID: "u@pve!t", TokenSecret: "s3cret", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v := s.SchemaVersion(); v != len(migrations) {
		t.Fatalf("schema version %d", v)
	}
	c, err := s.Cluster("a")
	if err != nil || c.TokenSecret != "s3cret" || c.BrokenSecret {
		t.Fatalf("cluster after reopen: %+v %v", c, err)
	}
}

func TestSessionsCredsAndExpiry(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().Unix()
	if err := s.PutSession(Session{ID: "sid", User: "u@pam", CSRF: "c", Created: now, LastSeen: now, Expires: now + 60}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCred("sid", Cred{ClusterID: "a", PVEUser: "u@pam", Kind: "ticket", Secret: "tick", CSRF: "x", Expires: now + 10}); err != nil {
		t.Fatal(err)
	}
	cs, _ := s.Creds("sid")
	if len(cs) != 1 || cs[0].Secret != "tick" {
		t.Fatalf("creds: %+v", cs)
	}
	due, _ := s.CredsExpiringBefore(now + 20)
	if len(due) != 1 || due[0].SessionHash != HashID("sid") {
		t.Fatalf("due: %+v", due)
	}
	// raw ids are never stored
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM sessions WHERE id_hash='sid'`).Scan(&n)
	if n != 0 {
		t.Fatal("raw session id stored")
	}
	if err := s.PutSession(Session{ID: "old", User: "u", CSRF: "c", Created: now, LastSeen: now, Expires: now - 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSession("old"); err != ErrNotFound {
		t.Fatalf("expired session returned: %v", err)
	}
}

func TestInterruptRunning(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, _ := s.AddAudit(AuditEntry{User: "u", ClusterID: "a", Action: "x", Title: "t", Status: "running", Results: json.RawMessage(`[{"step":0,"status":"running"}]`)})
	if n, err := s.InterruptRunning(); err != nil || n != 1 {
		t.Fatalf("interrupt: %d %v", n, err)
	}
	got, _ := s.AuditEntry(e.ID)
	if got.Status != "error" || !strings.Contains(string(got.Results), "galley stopped") && strings.Contains(string(got.Results), `"unknown"`) {
		t.Fatalf("entry: %+v %s", got, got.Results)
	}
}
