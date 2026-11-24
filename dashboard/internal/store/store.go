// Package store persists galley state in SQLite: registered clusters (service
// token encrypted at rest), user sessions and their per-cluster PVE credentials
// (encrypted), and the audit log. Schema changes are versioned migrations.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
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
	ShareLogin bool  `json:"shareLogin"`
	CreatedAt  int64 `json:"createdAt"`
	// BrokenSecret is set when the stored token cannot be decrypted (key changed).
	BrokenSecret bool `json:"brokenSecret,omitempty"`
}

// AuditEntry records one executed change (or a security event).
type AuditEntry struct {
	ID        int64           `json:"id"`
	At        int64           `json:"at"`
	Updated   int64           `json:"updated"`
	User      string          `json:"user"`      // galley session user
	ActorUser string          `json:"actorUser"` // PVE identity the change ran as
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
	CSRF     string
	Created  int64
	LastSeen int64
	Expires  int64
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
	s := &Store{db: db, gcm: gcm}
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
	_, err = s.db.Exec(`INSERT INTO clusters(id,name,endpoints,token_id,token_secret,share_login,created_at) VALUES(?,?,?,?,?,?,?)`,
		c.ID, c.Name, string(ep), c.TokenID, sec, c.ShareLogin, c.CreatedAt)
	return err
}

// UpdateCluster changes name, endpoints (pins) and share flag.
func (s *Store) UpdateCluster(c Cluster) error {
	ep, _ := json.Marshal(c.Endpoints)
	res, err := s.db.Exec(`UPDATE clusters SET name=?, endpoints=?, share_login=? WHERE id=?`, c.Name, string(ep), c.ShareLogin, c.ID)
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
	if _, err := tx.Exec(`DELETE FROM session_creds WHERE cluster_id=?`, id); err != nil {
		tx.Rollback()
		return err
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
	rows, err := s.db.Query(`SELECT id,name,endpoints,token_id,token_secret,share_login,created_at FROM clusters ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cluster{}
	for rows.Next() {
		var c Cluster
		var ep, sec string
		if err := rows.Scan(&c.ID, &c.Name, &ep, &c.TokenID, &sec, &c.ShareLogin, &c.CreatedAt); err != nil {
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

// HashID hashes a session id for storage/lookup.
func HashID(id string) string {
	h := sha256.Sum256([]byte(id))
	return hex.EncodeToString(h[:])
}

// PutSession creates or replaces a session.
func (s *Store) PutSession(ss Session) error {
	_, err := s.db.Exec(`INSERT INTO sessions(id_hash,user,csrf,created,last_seen,expires) VALUES(?,?,?,?,?,?)
	  ON CONFLICT(id_hash) DO UPDATE SET user=excluded.user, csrf=excluded.csrf, last_seen=excluded.last_seen, expires=excluded.expires`,
		HashID(ss.ID), ss.User, ss.CSRF, ss.Created, ss.LastSeen, ss.Expires)
	return err
}

// GetSession loads a session by raw id; expired sessions are deleted and reported missing.
func (s *Store) GetSession(id string) (Session, error) {
	var ss Session
	err := s.db.QueryRow(`SELECT user,csrf,created,last_seen,expires FROM sessions WHERE id_hash=?`, HashID(id)).
		Scan(&ss.User, &ss.CSRF, &ss.Created, &ss.LastSeen, &ss.Expires)
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

// PurgeExpiredSessions deletes expired sessions and returns their credentials.
func (s *Store) PurgeExpiredSessions(now int64) ([]Cred, error) {
	rows, err := s.db.Query(`SELECT c.cluster_id,c.pve_user,c.kind,c.token_id,c.secret,c.csrf,c.expires
	  FROM session_creds c JOIN sessions s ON s.id_hash=c.session_hash WHERE s.expires < ?`, now)
	if err != nil {
		return nil, err
	}
	creds, err := s.scanCreds(rows)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(`DELETE FROM sessions WHERE expires < ?`, now)
	return creds, err
}

// PutCred stores (encrypted) a session's credential for a cluster.
func (s *Store) PutCred(sessionID string, c Cred) error {
	sec, err := s.seal(c.Secret)
	if err != nil {
		return err
	}
	csrf, err := s.seal(c.CSRF)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO session_creds(session_hash,cluster_id,pve_user,kind,token_id,secret,csrf,expires) VALUES(?,?,?,?,?,?,?,?)
	  ON CONFLICT(session_hash,cluster_id) DO UPDATE SET pve_user=excluded.pve_user, kind=excluded.kind, token_id=excluded.token_id,
	  secret=excluded.secret, csrf=excluded.csrf, expires=excluded.expires`,
		HashID(sessionID), c.ClusterID, c.PVEUser, c.Kind, c.TokenID, sec, csrf, c.Expires)
	return err
}

// DeleteCred removes one credential.
func (s *Store) DeleteCred(sessionID, clusterID string) error {
	_, err := s.db.Exec(`DELETE FROM session_creds WHERE session_hash=? AND cluster_id=?`, HashID(sessionID), clusterID)
	return err
}

// Creds lists a session's credentials.
func (s *Store) Creds(sessionID string) ([]Cred, error) {
	rows, err := s.db.Query(`SELECT cluster_id,pve_user,kind,token_id,secret,csrf,expires FROM session_creds WHERE session_hash=?`, HashID(sessionID))
	if err != nil {
		return nil, err
	}
	return s.scanCreds(rows)
}

func (s *Store) scanCreds(rows *sql.Rows) ([]Cred, error) {
	defer rows.Close()
	out := []Cred{}
	for rows.Next() {
		var c Cred
		var sec, csrf string
		if err := rows.Scan(&c.ClusterID, &c.PVEUser, &c.Kind, &c.TokenID, &sec, &csrf, &c.Expires); err != nil {
			return nil, err
		}
		var err error
		if c.Secret, err = s.unseal(sec); err != nil {
			continue // undecryptable credential: treat as absent
		}
		if c.CSRF, err = s.unseal(csrf); err != nil {
			continue
		}
		out = append(out, c)
	}
	return out, rows.Err()
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
	res, err := s.db.Exec(`INSERT INTO audit(at,updated,user,actor_user,cluster_id,action,title,cli,status,ok,results) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		e.At, e.Updated, e.User, e.ActorUser, e.ClusterID, e.Action, e.Title, string(cli), e.Status, e.OK, string(e.Results))
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
	rows, err := s.db.Query(`SELECT id,at,updated,user,actor_user,cluster_id,action,title,cli,status,ok,results FROM audit `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var cli, res string
		if err := rows.Scan(&e.ID, &e.At, &e.Updated, &e.User, &e.ActorUser, &e.ClusterID, &e.Action, &e.Title, &cli, &e.Status, &e.OK, &res); err != nil {
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

// SessionCred is a credential with its owning session hash (for background renewal).
type SessionCred struct {
	SessionHash string
	Cred
}

// CredsExpiringBefore lists credentials of live sessions that expire before t.
func (s *Store) CredsExpiringBefore(t int64) ([]SessionCred, error) {
	rows, err := s.db.Query(`SELECT c.session_hash,c.cluster_id,c.pve_user,c.kind,c.token_id,c.secret,c.csrf,c.expires
	  FROM session_creds c JOIN sessions s ON s.id_hash=c.session_hash WHERE c.expires < ? AND s.expires > ?`, t, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionCred
	for rows.Next() {
		var sc SessionCred
		var sec, csrf string
		if err := rows.Scan(&sc.SessionHash, &sc.ClusterID, &sc.PVEUser, &sc.Kind, &sc.TokenID, &sec, &csrf, &sc.Expires); err != nil {
			return nil, err
		}
		var e1, e2 error
		sc.Secret, e1 = s.unseal(sec)
		sc.CSRF, e2 = s.unseal(csrf)
		if e1 == nil && e2 == nil {
			out = append(out, sc)
		}
	}
	return out, rows.Err()
}

// PutCredByHash stores a credential for a session identified by its hash.
func (s *Store) PutCredByHash(hash string, c Cred) error {
	sec, err := s.seal(c.Secret)
	if err != nil {
		return err
	}
	csrf, err := s.seal(c.CSRF)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE session_creds SET secret=?, csrf=?, expires=? WHERE session_hash=? AND cluster_id=?`, sec, csrf, c.Expires, hash, c.ClusterID)
	return err
}

// DeleteCredByHash removes a credential by session hash.
func (s *Store) DeleteCredByHash(hash, clusterID string) error {
	_, err := s.db.Exec(`DELETE FROM session_creds WHERE session_hash=? AND cluster_id=?`, hash, clusterID)
	return err
}

// InterruptRunning marks audit entries left "running" by a previous process as failed.
func (s *Store) InterruptRunning() (int64, error) {
	res, err := s.db.Exec(`UPDATE audit SET status='error', ok=0, updated=?,
	  results=json_insert(results,'$[#]',json_object('status','error','error','galley stopped while this change was running; check the PVE task log for the outcome'))
	  WHERE status='running'`, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
