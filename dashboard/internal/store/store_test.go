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

func testKey(b byte) []byte {
	k := make([]byte, SessionKeySize)
	for i := range k {
		k[i] = b + byte(i)
	}
	return k
}

func TestSessionsCredsAndExpiry(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().Unix()
	k := testKey(1)
	if err := s.PutSession(Session{ID: "sid", User: "u@pam", CSRF: "c", Created: now, LastSeen: now, Expires: now + 60, KeyCheck: s.KeyCheck(k)}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCred("sid", k, Cred{ClusterID: "a", PVEUser: "u@pam", Kind: "ticket", Secret: "tick", CSRF: "x", Expires: now + 10}); err != nil {
		t.Fatal(err)
	}
	cs, _ := s.Creds("sid", k)
	if len(cs) != 1 || cs[0].Secret != "tick" {
		t.Fatalf("creds: %+v", cs)
	}
	due, _ := s.CredsExpiringBefore(now + 20)
	if len(due) != 1 || due[0].SessionHash != HashID("sid") || due[0].PVEUser != "u@pam" {
		t.Fatalf("due: %+v", due)
	}
	ss, _ := s.GetSession("sid")
	if !s.CheckKey(ss, k) || s.CheckKey(ss, testKey(2)) || s.CheckKey(ss, nil) {
		t.Fatal("key check")
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

// The database and the instance key file together must not reveal any user's
// PVE credential: it is sealed under a key derived from the session secret K,
// which only the browser cookie (and galley's memory) holds.
func TestCredsNeedSessionSecret(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	k := testKey(7)
	const ticket = "PVE:root@pam:SECRET-TICKET-VALUE"
	if err := s.PutSession(Session{ID: "sid", User: "root@pam", CSRF: "c", Created: now, LastSeen: now, Expires: now + 3600, KeyCheck: s.KeyCheck(k)}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCred("sid", k, Cred{ClusterID: "a", PVEUser: "root@pam", Kind: "ticket", Secret: ticket, CSRF: "csrf-x", Expires: now + 3600}); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// an attacker with a copy of the data directory (galley.db + secret.key)
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	for _, f := range []string{"galley.db", "galley.db-wal"} {
		if b, err := os.ReadFile(filepath.Join(dir, f)); err == nil && strings.Contains(string(b), "SECRET-TICKET") {
			t.Fatalf("plaintext ticket in %s", f)
		}
	}
	var sec string
	if err := s2.db.QueryRow(`SELECT secret FROM session_creds`).Scan(&sec); err != nil {
		t.Fatal(err)
	}
	if p, err := s2.unseal(sec); err == nil {
		t.Fatalf("instance key alone decrypted the credential: %q", p)
	}
	for _, guess := range [][]byte{nil, testKey(8), make([]byte, SessionKeySize)} {
		if cs, _ := s2.Creds("sid", guess); len(cs) != 0 {
			t.Fatalf("decrypted without K: %+v", cs)
		}
	}
	// a credential moved to another cluster's row does not open
	if _, err := s2.db.Exec(`UPDATE session_creds SET cluster_id='b'`); err != nil {
		t.Fatal(err)
	}
	if cs, _ := s2.Creds("sid", k); len(cs) != 0 {
		t.Fatal("credential opened under another cluster id")
	}
	_, _ = s2.db.Exec(`UPDATE session_creds SET cluster_id='a'`)
	// with K (from the cookie) it works
	cs, err := s2.Creds("sid", k)
	if err != nil || len(cs) != 1 || cs[0].Secret != ticket {
		t.Fatalf("with K: %+v %v", cs, err)
	}
	// the stored verifier is not K and does not decrypt
	var kc string
	_ = s2.db.QueryRow(`SELECT key_check FROM sessions`).Scan(&kc)
	if kc == "" || strings.Contains(kc, string(k)) {
		t.Fatal("key check missing")
	}
}

func TestMigrationDropsOldSessionsAndKeepsSSHClusters(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// rewind to schema 4 with an old-style session and an SSH key for cluster "a"
	for _, q := range []string{
		`DROP TABLE token_revocations`,
		`ALTER TABLE sessions DROP COLUMN key_check`,
		`ALTER TABLE clusters DROP COLUMN credential_mode`,
		`ALTER TABLE clusters DROP COLUMN host_transport`,
		`PRAGMA user_version = 4`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	_, _ = s.db.Exec(`INSERT INTO clusters(id,name,endpoints,token_id,token_secret,share_login,created_at) VALUES('a','a','[]','t','',0,1),('b','b','[]','t','',0,1)`)
	_, _ = s.db.Exec(`INSERT INTO sessions(id_hash,user,csrf,created,last_seen,expires) VALUES('h','u','c',1,1,99999999999)`)
	_, _ = s.db.Exec(`INSERT INTO session_creds(session_hash,cluster_id,pve_user,kind,secret,expires) VALUES('h','a','u','ticket','x',1)`)
	_ = s.PutSetting("hosts.key.a", "pem")
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	_ = s.db.QueryRow(`SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM session_creds)`).Scan(&n)
	if n != 0 {
		t.Fatalf("old sessions survived: %d", n)
	}
	a, _ := s.Cluster("a")
	b, _ := s.Cluster("b")
	if a.HostTransport != "ssh" || b.HostTransport != "pve" || a.CredentialMode != "ticket" {
		t.Fatalf("migrated clusters: %+v %+v", a, b)
	}
}

func TestTokenRevocations(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_ = s.AddTokenRevocation(TokenRevocation{ClusterID: "a", PVEUser: "u@pve", TokenID: "u@pve!galley-1", Reason: "logout"})
	_ = s.AddTokenRevocation(TokenRevocation{ClusterID: "a", PVEUser: "v@pve", TokenID: "v@pve!galley-2", Reason: "expired"})
	if rs, _ := s.TokenRevocations("a", "u@pve"); len(rs) != 1 || rs[0].TokenID != "u@pve!galley-1" {
		t.Fatalf("revocations: %+v", rs)
	}
	if rs, _ := s.TokenRevocations("a", ""); len(rs) != 2 {
		t.Fatalf("all: %+v", rs)
	}
	_ = s.DeleteTokenRevocation("a", "u@pve!galley-1")
	if rs, _ := s.TokenRevocations("a", "u@pve"); len(rs) != 0 {
		t.Fatalf("after delete: %+v", rs)
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
