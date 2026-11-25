// Package store persists galley state in SQLite: registered clusters (service
// token encrypted at rest), user sessions and their per-cluster PVE credentials
// (envelope-encrypted per session, see SessionKey), and the audit log. Schema
// changes are versioned migrations.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	_ "modernc.org/sqlite" // pure-Go driver: static binary, no cgo
)

// Cluster is a registered PVE cluster.
type Cluster struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Endpoints   []pve.Endpoint `json:"endpoints"`
	TokenID     string         `json:"tokenId"`
	TokenSecret string         `json:"-"`
	// ShareLogin: a login on another cluster may reuse the same credentials here
	// (clusters that share a realm, e.g. the same LDAP/AD). Off by default.
	ShareLogin bool `json:"shareLogin"`
	// CredentialMode is how galley holds a user's login to this cluster:
	// "ticket" (default; the user's PVE ticket, renewed while the user is
	// active) or "token" (a short-lived per-session API token created at login).
	CredentialMode string `json:"credentialMode"`
	// HostTransport is how host commands reach nodes: "pve" (default; PVE's
	// node terminal as the user, no galley-held credential) or "ssh" (galley's
	// per-cluster SSH key, opt-in).
	HostTransport string `json:"hostTransport"`
	CreatedAt     int64  `json:"createdAt"`
	// BrokenSecret is set when the stored token cannot be decrypted (key changed).
	BrokenSecret bool `json:"brokenSecret,omitempty"`
}

// AuditEntry records one executed change (or a security event).
type AuditEntry struct {
	ID        int64           `json:"id"`
	At        int64           `json:"at"`
	Updated   int64           `json:"updated"`
	User      string          `json:"user"`          // galley session user
	ActorUser string          `json:"actorUser"`     // PVE identity the change ran as
	Via       string          `json:"via,omitempty"` // "agent:<name>" when an agent token applied it
	ClusterID string          `json:"clusterId"`
	Action    string          `json:"action"`
	Title     string          `json:"title"`
	CLI       []string        `json:"cli"`
	Status    string          `json:"status"` // running | ok | error
	OK        bool            `json:"ok"`
	Results   json.RawMessage `json:"results"`
}

// Session is a logged-in browser session.
type Session struct {
	ID       string // raw id (only held in memory / cookie; DB stores a hash)
	User     string
	Home     string // cluster the identity was established on
	CSRF     string
	Created  int64
	LastSeen int64
	Expires  int64
	// KeyCheck verifies the session secret K presented with the id (see
	// Store.KeyCheck); it reveals nothing about K.
	KeyCheck string
	// Kind is "browser" (cookie) or "agent" (bearer token for MCP/API clients).
	Kind  string
	Name  string // agent token name
	Scope string // agent scope: read | draft | apply
}

// Cred is a session's credential for one cluster.
type Cred struct {
	ClusterID string
	PVEUser   string
	Kind      string // "token" | "ticket"
	TokenID   string // full token id user@realm!name (kind=token)
	Secret    string // token secret or ticket
	CSRF      string // ticket CSRF (kind=ticket)
	Expires   int64
}

// Store wraps the database and the at-rest encryption key.
type Store struct {
	db  *sql.DB
	gcm cipher.AEAD
	key []byte // instance key: input (with a session secret) to per-session keys
}

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("store: not found")

// Open opens (and migrates) the database in dir. The key file is created once
// and never overwritten; a malformed key file is a hard error.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := loadKey(filepath.Join(dir, "secret.key"))
	if err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "galley.db")+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// WAL allows concurrent readers with one writer; serialise writers in the pool.
	db.SetMaxOpenConns(4)
	s := &Store{db: db, gcm: gcm, key: key}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func loadKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	switch {
	case err == nil && len(b) == 32:
		return b, nil
	case err == nil:
		return nil, fmt.Errorf("store: %s is %d bytes, want 32 — refusing to overwrite it (restore it from backup; without it stored secrets cannot be decrypted)", path, len(b))
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	b = make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	// atomic create: temp file, fsync, rename; O_EXCL guards against a concurrent creator.
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	f.Close()
	if err := os.Link(tmp, path); err != nil { // fails if path appeared meanwhile
		os.Remove(tmp)
		return nil, err
	}
	os.Remove(tmp)
	return b, nil
}

// migrations are applied in order; PRAGMA user_version records progress.
var migrations = []string{
	// 1: initial schema (matches MVP)
	`CREATE TABLE IF NOT EXISTS clusters (
	   id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, endpoints TEXT NOT NULL,
	   token_id TEXT NOT NULL, token_secret TEXT NOT NULL, created_at INTEGER NOT NULL);
	 CREATE TABLE IF NOT EXISTS audit (
	   id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user TEXT NOT NULL,
	   cluster_id TEXT NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL,
	   cli TEXT NOT NULL, ok INTEGER NOT NULL, results TEXT NOT NULL);
	 CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);`,
	// 2: sessions, credentials, audit lifecycle, cluster login sharing, user prefs
	`ALTER TABLE clusters ADD COLUMN share_login INTEGER NOT NULL DEFAULT 0;
	 ALTER TABLE audit ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
	 ALTER TABLE audit ADD COLUMN updated INTEGER NOT NULL DEFAULT 0;
	 ALTER TABLE audit ADD COLUMN actor_user TEXT NOT NULL DEFAULT '';
	 CREATE TABLE sessions (
	   id_hash TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL,
	   created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL);
	 CREATE TABLE session_creds (
	   session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
	   cluster_id TEXT NOT NULL, pve_user TEXT NOT NULL, kind TEXT NOT NULL,
	   token_id TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL, csrf TEXT NOT NULL DEFAULT '',
	   expires INTEGER NOT NULL, PRIMARY KEY (session_hash, cluster_id));
	 CREATE TABLE user_prefs (
	   user TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL,
	   PRIMARY KEY (user, key));`,
	// 3: correct statuses of pre-v2 audit rows; sessions remember their home cluster
	`UPDATE audit SET status = CASE WHEN ok THEN 'ok' ELSE 'error' END WHERE updated = 0;
	 ALTER TABLE sessions ADD COLUMN home TEXT NOT NULL DEFAULT '';`,
	// 4: instance settings (assistant provider, host access key); values sealed
	`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);`,
	// 5: per-session envelope encryption of user credentials. Credentials sealed
	// with the instance key alone are dropped (their users log in again).
	// Clusters gain a credential mode and a host-command transport; clusters
	// that already have an SSH key keep using SSH until an admin switches.
	`DELETE FROM session_creds;
	 DELETE FROM sessions;
	 ALTER TABLE sessions ADD COLUMN key_check TEXT NOT NULL DEFAULT '';
	 ALTER TABLE clusters ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'ticket';
	 ALTER TABLE clusters ADD COLUMN host_transport TEXT NOT NULL DEFAULT 'pve';
	 UPDATE clusters SET host_transport = 'ssh' WHERE ('hosts.key.' || id) IN (SELECT key FROM settings);
	 CREATE TABLE token_revocations (
	   cluster_id TEXT NOT NULL, pve_user TEXT NOT NULL, token_id TEXT NOT NULL,
	   reason TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (cluster_id, token_id));`,
	// 6: agent sessions (bearer tokens for MCP/API clients)
	`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser';
	 ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
	 ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT '';`,
	// 7: audit records when an agent token applied a change
	`ALTER TABLE audit ADD COLUMN via TEXT NOT NULL DEFAULT '';`,
}

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i := v; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		for _, stmt := range strings.Split(migrations[i], ";") {
			if strings.TrimSpace(stmt) == "" {
				continue
			}
			if _, err := tx.Exec(stmt); err != nil {
				tx.Rollback()
				return fmt.Errorf("store: migration %d: %w", i+1, err)
			}
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping reports database health.
func (s *Store) Ping() error { return s.db.Ping() }

// SchemaVersion returns the applied migration count.
func (s *Store) SchemaVersion() int {
	var v int
	_ = s.db.QueryRow(`PRAGMA user_version`).Scan(&v)
	return v
}

func (s *Store) seal(plain string) (string, error) {
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(s.gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (s *Store) unseal(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(raw) < s.gcm.NonceSize() {
		return "", fmt.Errorf("store: corrupt secret")
	}
	n := s.gcm.NonceSize()
	p, err := s.gcm.Open(nil, raw[:n], raw[n:], nil)
	if err != nil {
		return "", fmt.Errorf("store: cannot decrypt secret (key changed?)")
	}
	return string(p), nil
}

// ---- clusters ----

// AddCluster inserts a cluster.
func (s *Store) AddCluster(c Cluster) error {
	ep, _ := json.Marshal(c.Endpoints)
	sec, err := s.seal(c.TokenSecret)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO clusters(id,name,endpoints,token_id,token_secret,share_login,credential_mode,host_transport,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		c.ID, c.Name, string(ep), c.TokenID, sec, c.ShareLogin, defaultStr(c.CredentialMode, "ticket"), defaultStr(c.HostTransport, "pve"), c.CreatedAt)
	return err
}

func defaultStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// UpdateCluster changes name, endpoints (pins), share flag, credential mode and host transport.
func (s *Store) UpdateCluster(c Cluster) error {
	ep, _ := json.Marshal(c.Endpoints)
	res, err := s.db.Exec(`UPDATE clusters SET name=?, endpoints=?, share_login=?, credential_mode=?, host_transport=? WHERE id=?`,
		c.Name, string(ep), c.ShareLogin, defaultStr(c.CredentialMode, "ticket"), defaultStr(c.HostTransport, "pve"), c.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteCluster removes a cluster and every session credential for it.
func (s *Store) DeleteCluster(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for _, q := range []string{`DELETE FROM session_creds WHERE cluster_id=?`, `DELETE FROM token_revocations WHERE cluster_id=?`} {
		if _, err := tx.Exec(q, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM clusters WHERE id=?`, id); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Clusters lists clusters. A row whose secret cannot be decrypted is returned
// with BrokenSecret set instead of failing the whole listing.
func (s *Store) Clusters() ([]Cluster, error) {
	rows, err := s.db.Query(`SELECT id,name,endpoints,token_id,token_secret,share_login,credential_mode,host_transport,created_at FROM clusters ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cluster{}
	for rows.Next() {
		var c Cluster
		var ep, sec string
		if err := rows.Scan(&c.ID, &c.Name, &ep, &c.TokenID, &sec, &c.ShareLogin, &c.CredentialMode, &c.HostTransport, &c.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ep), &c.Endpoints); err != nil {
			c.BrokenSecret = true
		}
		if c.TokenSecret, err = s.unseal(sec); err != nil {
			c.BrokenSecret = true
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Cluster returns one cluster.
func (s *Store) Cluster(id string) (Cluster, error) {
	cs, err := s.Clusters()
	if err != nil {
		return Cluster{}, err
	}
	for _, c := range cs {
		if c.ID == id {
			return c, nil
		}
	}
	return Cluster{}, ErrNotFound
}

// ---- sessions ----
//
// Envelope encryption of user credentials. Each session has a random secret K
// (SessionKeySize bytes) that lives only in the browser's session cookie and,
// while the session is in use, in galley's memory. A session's credentials are
// sealed with a key derived from K *and* the instance key: the database plus
// secret.key (a backup, a stolen disk) are not enough to recover any user's PVE
// login. Only a hash of the session id and a verifier of K are stored.

// SessionKeySize is the length of a session secret K.
const SessionKeySize = 32

// ErrNoKey is returned when a session secret is missing or malformed.
var ErrNoKey = errors.New("store: session secret required")

func (s *Store) derive(k []byte, info string) ([]byte, error) {
	if len(k) != SessionKeySize {
		return nil, ErrNoKey
	}
	return hkdf.Key(sha256.New, k, s.key, info, 32)
}

func (s *Store) sessionAEAD(k []byte) (cipher.AEAD, error) {
	dk, err := s.derive(k, "galley session credentials v1")
	if err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(dk)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

// KeyCheck returns a verifier of K for this instance (stored with the session,
// so a request with the right id but a wrong K is refused). It is a one-way
// derivation and does not help decrypt anything.
func (s *Store) KeyCheck(k []byte) string {
	dk, err := s.derive(k, "galley session key check v1")
	if err != nil {
		return ""
	}
	return hex.EncodeToString(dk)
}

// CheckKey reports whether k is the secret of session ss.
func (s *Store) CheckKey(ss Session, k []byte) bool {
	want := s.KeyCheck(k)
	return want != "" && ss.KeyCheck != "" && subtle.ConstantTimeCompare([]byte(want), []byte(ss.KeyCheck)) == 1
}

// credAD binds a sealed value to its row and field, so values cannot be moved
// between clusters or fields of the same session.
func credAD(hash, cid, field string) []byte {
	return []byte(hash + "\x00" + cid + "\x00" + field)
}

func sealWith(a cipher.AEAD, plain string, ad []byte) (string, error) {
	nonce := make([]byte, a.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(a.Seal(nonce, nonce, []byte(plain), ad)), nil
}

func openWith(a cipher.AEAD, enc string, ad []byte) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(raw) < a.NonceSize() {
		return "", fmt.Errorf("store: corrupt secret")
	}
	n := a.NonceSize()
	p, err := a.Open(nil, raw[:n], raw[n:], ad)
	if err != nil {
		return "", fmt.Errorf("store: cannot decrypt credential (wrong session secret)")
	}
	return string(p), nil
}

// HashID hashes a session id for storage/lookup.
func HashID(id string) string {
	h := sha256.Sum256([]byte(id))
	return hex.EncodeToString(h[:])
}

// PutSession creates or replaces a session.
func (s *Store) PutSession(ss Session) error {
	if ss.Kind == "" {
		ss.Kind = "browser"
	}
	_, err := s.db.Exec(`INSERT INTO sessions(id_hash,user,home,csrf,created,last_seen,expires,key_check,kind,name,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)
	  ON CONFLICT(id_hash) DO UPDATE SET user=excluded.user, home=excluded.home, csrf=excluded.csrf, last_seen=excluded.last_seen, expires=excluded.expires, key_check=excluded.key_check`,
		HashID(ss.ID), ss.User, ss.Home, ss.CSRF, ss.Created, ss.LastSeen, ss.Expires, ss.KeyCheck, ss.Kind, ss.Name, ss.Scope)
	return err
}

// GetSession loads a session by raw id; expired sessions are deleted and reported missing.
func (s *Store) GetSession(id string) (Session, error) {
	var ss Session
	err := s.db.QueryRow(`SELECT user,home,csrf,created,last_seen,expires,key_check,kind,name,scope FROM sessions WHERE id_hash=?`, HashID(id)).
		Scan(&ss.User, &ss.Home, &ss.CSRF, &ss.Created, &ss.LastSeen, &ss.Expires, &ss.KeyCheck, &ss.Kind, &ss.Name, &ss.Scope)
	if errors.Is(err, sql.ErrNoRows) {
		return ss, ErrNotFound
	}
	if err != nil {
		return ss, err
	}
	ss.ID = id
	if time.Now().Unix() > ss.Expires {
		_ = s.DeleteSession(id)
		return ss, ErrNotFound
	}
	return ss, nil
}

// SessionLive reports whether the session with this hash exists and has not expired.
func (s *Store) SessionLive(hash string) bool {
	var exp int64
	err := s.db.QueryRow(`SELECT expires FROM sessions WHERE id_hash=?`, hash).Scan(&exp)
	return err == nil && exp >= time.Now().Unix()
}

// TouchSession updates last-seen and slides the expiry.
func (s *Store) TouchSession(id string, lastSeen, expires int64) error {
	_, err := s.db.Exec(`UPDATE sessions SET last_seen=?, expires=? WHERE id_hash=?`, lastSeen, expires, HashID(id))
	return err
}

// DeleteSession removes a session and its credentials.
func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id_hash=?`, HashID(id))
	return err
}

// CredMeta describes a stored credential without its secret (which needs the
// session's K to decrypt).
type CredMeta struct {
	SessionHash string
	ClusterID   string
	PVEUser     string
	Kind        string
	TokenID     string
	Expires     int64
}

const credMetaCols = `c.session_hash,c.cluster_id,c.pve_user,c.kind,c.token_id,c.expires`

func scanMetas(rows *sql.Rows, err error) ([]CredMeta, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CredMeta{}
	for rows.Next() {
		var m CredMeta
		if err := rows.Scan(&m.SessionHash, &m.ClusterID, &m.PVEUser, &m.Kind, &m.TokenID, &m.Expires); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// PurgeExpiredSessions deletes expired sessions and returns their credentials' metadata.
func (s *Store) PurgeExpiredSessions(now int64) ([]CredMeta, error) {
	metas, err := scanMetas(s.db.Query(`SELECT `+credMetaCols+` FROM session_creds c JOIN sessions s ON s.id_hash=c.session_hash WHERE s.expires < ?`, now))
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(`DELETE FROM sessions WHERE expires < ?`, now)
	return metas, err
}

// CredMetas lists a session's credentials without decrypting them.
func (s *Store) CredMetas(sessionID string) ([]CredMeta, error) {
	return scanMetas(s.db.Query(`SELECT `+credMetaCols+` FROM session_creds c WHERE c.session_hash=?`, HashID(sessionID)))
}

// CredsExpiringBefore lists credentials of live sessions that expire before t
// (metadata only: renewal needs the session's K, which only memory holds).
func (s *Store) CredsExpiringBefore(t int64) ([]CredMeta, error) {
	return scanMetas(s.db.Query(`SELECT `+credMetaCols+` FROM session_creds c JOIN sessions s ON s.id_hash=c.session_hash
	  WHERE c.expires < ? AND s.expires > ?`, t, time.Now().Unix()))
}

func (s *Store) sealCred(hash string, k []byte, c Cred) (string, string, error) {
	a, err := s.sessionAEAD(k)
	if err != nil {
		return "", "", err
	}
	sec, err := sealWith(a, c.Secret, credAD(hash, c.ClusterID, "secret"))
	if err != nil {
		return "", "", err
	}
	csrf, err := sealWith(a, c.CSRF, credAD(hash, c.ClusterID, "csrf"))
	return sec, csrf, err
}

// PutCred stores a session's credential for a cluster, sealed under the session secret k.
func (s *Store) PutCred(sessionID string, k []byte, c Cred) error {
	hash := HashID(sessionID)
	sec, csrf, err := s.sealCred(hash, k, c)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO session_creds(session_hash,cluster_id,pve_user,kind,token_id,secret,csrf,expires) VALUES(?,?,?,?,?,?,?,?)
	  ON CONFLICT(session_hash,cluster_id) DO UPDATE SET pve_user=excluded.pve_user, kind=excluded.kind, token_id=excluded.token_id,
	  secret=excluded.secret, csrf=excluded.csrf, expires=excluded.expires`,
		hash, c.ClusterID, c.PVEUser, c.Kind, c.TokenID, sec, csrf, c.Expires)
	return err
}

// PutCredByHash replaces the secret of an existing credential (renewal). It
// never re-creates a credential that was deleted meanwhile (e.g. by logout).
func (s *Store) PutCredByHash(hash string, k []byte, c Cred) error {
	sec, csrf, err := s.sealCred(hash, k, c)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE session_creds SET secret=?, csrf=?, expires=? WHERE session_hash=? AND cluster_id=?`, sec, csrf, c.Expires, hash, c.ClusterID)
	return err
}

// DeleteCred removes one credential.
func (s *Store) DeleteCred(sessionID, clusterID string) error {
	return s.DeleteCredByHash(HashID(sessionID), clusterID)
}

// DeleteCredByHash removes a credential by session hash.
func (s *Store) DeleteCredByHash(hash, clusterID string) error {
	_, err := s.db.Exec(`DELETE FROM session_creds WHERE session_hash=? AND cluster_id=?`, hash, clusterID)
	return err
}

// Creds lists a session's credentials, decrypted with the session secret k.
// Credentials that k does not open are left out.
func (s *Store) Creds(sessionID string, k []byte) ([]Cred, error) {
	hash := HashID(sessionID)
	rows, err := s.db.Query(`SELECT cluster_id,pve_user,kind,token_id,secret,csrf,expires FROM session_creds WHERE session_hash=?`, hash)
	if err != nil {
		return nil, err
	}
	return s.scanCreds(rows, hash, k)
}

// CredByHash returns one credential of a session identified by its hash.
func (s *Store) CredByHash(hash string, k []byte, clusterID string) (Cred, error) {
	rows, err := s.db.Query(`SELECT cluster_id,pve_user,kind,token_id,secret,csrf,expires FROM session_creds WHERE session_hash=? AND cluster_id=?`, hash, clusterID)
	if err != nil {
		return Cred{}, err
	}
	cs, err := s.scanCreds(rows, hash, k)
	if err != nil {
		return Cred{}, err
	}
	if len(cs) == 0 {
		return Cred{}, ErrNotFound
	}
	return cs[0], nil
}

func (s *Store) scanCreds(rows *sql.Rows, hash string, k []byte) ([]Cred, error) {
	defer rows.Close()
	a, aerr := s.sessionAEAD(k)
	out := []Cred{}
	for rows.Next() {
		var c Cred
		var sec, csrf string
		if err := rows.Scan(&c.ClusterID, &c.PVEUser, &c.Kind, &c.TokenID, &sec, &csrf, &c.Expires); err != nil {
			return nil, err
		}
		if aerr != nil {
			continue // no usable session secret: nothing can be decrypted
		}
		var err error
		if c.Secret, err = openWith(a, sec, credAD(hash, c.ClusterID, "secret")); err != nil {
			continue // undecryptable credential: treat as absent
		}
		if c.CSRF, err = openWith(a, csrf, credAD(hash, c.ClusterID, "csrf")); err != nil {
			continue
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ---- per-session API tokens that could not be revoked yet ----

// TokenRevocation is a galley-created PVE API token still to be deleted.
type TokenRevocation struct {
	ClusterID string
	PVEUser   string
	TokenID   string // full id user@realm!name
	Reason    string
	Created   int64
}

// AddTokenRevocation records a token galley could not revoke (it is deleted
// with the user's next login ticket on that cluster, or expires on its own).
func (s *Store) AddTokenRevocation(r TokenRevocation) error {
	if r.Created == 0 {
		r.Created = time.Now().Unix()
	}
	_, err := s.db.Exec(`INSERT INTO token_revocations(cluster_id,pve_user,token_id,reason,created) VALUES(?,?,?,?,?)
	  ON CONFLICT(cluster_id,token_id) DO UPDATE SET reason=excluded.reason`, r.ClusterID, r.PVEUser, r.TokenID, r.Reason, r.Created)
	return err
}

// TokenRevocations lists pending revocations for a user on a cluster ("" = all users).
func (s *Store) TokenRevocations(clusterID, user string) ([]TokenRevocation, error) {
	rows, err := s.db.Query(`SELECT cluster_id,pve_user,token_id,reason,created FROM token_revocations
	  WHERE cluster_id=? AND (?='' OR pve_user=?) ORDER BY created`, clusterID, user, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TokenRevocation{}
	for rows.Next() {
		var r TokenRevocation
		if err := rows.Scan(&r.ClusterID, &r.PVEUser, &r.TokenID, &r.Reason, &r.Created); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PruneTokenRevocations drops entries recorded before t (their tokens have expired).
func (s *Store) PruneTokenRevocations(t int64) error {
	_, err := s.db.Exec(`DELETE FROM token_revocations WHERE created < ?`, t)
	return err
}

// DeleteSetting removes a setting.
func (s *Store) DeleteSetting(key string) error {
	_, err := s.db.Exec(`DELETE FROM settings WHERE key=?`, key)
	return err
}

// DeleteTokenRevocation drops a pending revocation (done, or the token expired).
func (s *Store) DeleteTokenRevocation(clusterID, tokenID string) error {
	_, err := s.db.Exec(`DELETE FROM token_revocations WHERE cluster_id=? AND token_id=?`, clusterID, tokenID)
	return err
}

// ---- audit ----

// AddAudit appends an entry and returns it with its ID.
func (s *Store) AddAudit(e AuditEntry) (AuditEntry, error) {
	now := time.Now().Unix()
	if e.At == 0 {
		e.At = now
	}
	e.Updated = now
	if e.Status == "" {
		e.Status = map[bool]string{true: "ok", false: "error"}[e.OK]
	}
	cli, _ := json.Marshal(e.CLI)
	if e.CLI == nil {
		cli = []byte("[]")
	}
	if e.Results == nil {
		e.Results = json.RawMessage("[]")
	}
	res, err := s.db.Exec(`INSERT INTO audit(at,updated,user,actor_user,via,cluster_id,action,title,cli,status,ok,results) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.At, e.Updated, e.User, e.ActorUser, e.Via, e.ClusterID, e.Action, e.Title, string(cli), e.Status, e.OK, string(e.Results))
	if err != nil {
		return e, err
	}
	e.ID, _ = res.LastInsertId()
	return e, nil
}

// UpdateAudit records the outcome of a running entry.
func (s *Store) UpdateAudit(id int64, status string, ok bool, results json.RawMessage) (AuditEntry, error) {
	if _, err := s.db.Exec(`UPDATE audit SET status=?, ok=?, results=?, updated=? WHERE id=?`, status, ok, string(results), time.Now().Unix(), id); err != nil {
		return AuditEntry{}, err
	}
	return s.AuditEntry(id)
}

// AuditEntry fetches one entry.
func (s *Store) AuditEntry(id int64) (AuditEntry, error) {
	es, err := s.queryAudit(`WHERE id=?`, id)
	if err != nil {
		return AuditEntry{}, err
	}
	if len(es) == 0 {
		return AuditEntry{}, ErrNotFound
	}
	return es[0], nil
}

// Audit returns the newest entries.
func (s *Store) Audit(limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	return s.queryAudit(`ORDER BY id DESC LIMIT ?`, limit)
}

func (s *Store) queryAudit(where string, args ...any) ([]AuditEntry, error) {
	rows, err := s.db.Query(`SELECT id,at,updated,user,actor_user,via,cluster_id,action,title,cli,status,ok,results FROM audit `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var cli, res string
		if err := rows.Scan(&e.ID, &e.At, &e.Updated, &e.User, &e.ActorUser, &e.Via, &e.ClusterID, &e.Action, &e.Title, &cli, &e.Status, &e.OK, &res); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(cli), &e.CLI)
		e.Results = json.RawMessage(res)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ---- user preferences (dashboard layouts etc.) ----

// GetPref returns a stored JSON value.
func (s *Store) GetPref(user, key string) (json.RawMessage, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM user_prefs WHERE user=? AND key=?`, user, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return json.RawMessage(v), err
}

// PutPref stores a JSON value.
func (s *Store) PutPref(user, key string, value json.RawMessage) error {
	_, err := s.db.Exec(`INSERT INTO user_prefs(user,key,value,updated) VALUES(?,?,?,?)
	  ON CONFLICT(user,key) DO UPDATE SET value=excluded.value, updated=excluded.updated`, user, key, string(value), time.Now().Unix())
	return err
}

// InterruptRunning marks audit entries left "running" by a previous process:
// steps still running become "unknown" (the PVE task may have completed) and
// the entry becomes "error".
func (s *Store) InterruptRunning() (int64, error) {
	es, err := s.queryAudit(`WHERE status='running'`)
	if err != nil {
		return 0, err
	}
	const note = "galley stopped while this step was running; check the PVE task log for the outcome"
	var n int64
	for _, e := range es {
		var rs []map[string]any
		if json.Unmarshal(e.Results, &rs) != nil {
			rs = nil
		}
		marked := false
		for _, r := range rs {
			if r["status"] == "running" {
				r["status"], r["ok"], r["error"] = "unknown", false, note
				marked = true
			}
		}
		if !marked {
			rs = append(rs, map[string]any{"step": len(rs), "status": "unknown", "ok": false, "error": note})
		}
		raw, _ := json.Marshal(rs)
		if _, err := s.UpdateAudit(e.ID, "error", false, raw); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// GetSetting returns a decrypted setting.
func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return s.unseal(v)
}

// PutSetting stores a setting encrypted at rest.
func (s *Store) PutSetting(key, value string) error {
	sealed, err := s.seal(value)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated`, key, sealed, time.Now().Unix())
	return err
}

// AgentSession describes an agent token (no secrets).
type AgentSession struct {
	Hash     string `json:"-"`
	ID       string `json:"id"` // short public id (prefix of the hash)
	Name     string `json:"name"`
	Scope    string `json:"scope"`
	Created  int64  `json:"created"`
	LastSeen int64  `json:"lastSeen"`
	Expires  int64  `json:"expires"`
}

// AgentSessions lists user's agent tokens established on home.
func (s *Store) AgentSessions(user, home string) ([]AgentSession, error) {
	rows, err := s.db.Query(`SELECT id_hash,name,scope,created,last_seen,expires FROM sessions WHERE kind='agent' AND user=? AND home=? AND expires>=? ORDER BY created DESC`, user, home, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentSession{}
	for rows.Next() {
		var a AgentSession
		if err := rows.Scan(&a.Hash, &a.Name, &a.Scope, &a.Created, &a.LastSeen, &a.Expires); err != nil {
			return nil, err
		}
		a.ID = a.Hash[:16]
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteSessionByHash removes a session by its hash.
func (s *Store) DeleteSessionByHash(hash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id_hash=?`, hash)
	return err
}

// CredMetasByHash lists a session's credentials (by session hash) without decrypting them.
func (s *Store) CredMetasByHash(hash string) ([]CredMeta, error) {
	return scanMetas(s.db.Query(`SELECT `+credMetaCols+` FROM session_creds c WHERE c.session_hash=?`, hash))
}
