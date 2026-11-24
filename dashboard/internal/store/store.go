// Package store persists galley state in SQLite: registered clusters (with the
// service token encrypted at rest) and the audit log.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	CreatedAt   int64          `json:"createdAt"`
}

// AuditEntry records one executed plan.
type AuditEntry struct {
	ID        int64           `json:"id"`
	At        int64           `json:"at"`
	User      string          `json:"user"`
	ClusterID string          `json:"clusterId"`
	Action    string          `json:"action"`
	Title     string          `json:"title"`
	CLI       []string        `json:"cli"`
	OK        bool            `json:"ok"`
	Results   json.RawMessage `json:"results"`
}

// Store wraps the database and the at-rest encryption key.
type Store struct {
	db  *sql.DB
	gcm cipher.AEAD
}

// Open opens (and migrates) the database in dir, creating a 0600 key file on first use.
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
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "galley.db")+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, gcm: gcm}
	return s, s.migrate()
}

func loadKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil && len(b) == 32 {
		return b, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	b = make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, os.WriteFile(path, b, 0o600)
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, endpoints TEXT NOT NULL,
  token_id TEXT NOT NULL, token_secret TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user TEXT NOT NULL,
  cluster_id TEXT NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL,
  cli TEXT NOT NULL, ok INTEGER NOT NULL, results TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);`)
	return err
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) seal(plain string) (string, error) {
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(s.gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (s *Store) open(enc string) (string, error) {
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

// AddCluster inserts a cluster.
func (s *Store) AddCluster(c Cluster) error {
	ep, _ := json.Marshal(c.Endpoints)
	sec, err := s.seal(c.TokenSecret)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO clusters(id,name,endpoints,token_id,token_secret,created_at) VALUES(?,?,?,?,?,?)`,
		c.ID, c.Name, string(ep), c.TokenID, sec, c.CreatedAt)
	return err
}

// DeleteCluster removes a cluster.
func (s *Store) DeleteCluster(id string) error {
	_, err := s.db.Exec(`DELETE FROM clusters WHERE id=?`, id)
	return err
}

// Clusters lists clusters with decrypted service tokens.
func (s *Store) Clusters() ([]Cluster, error) {
	rows, err := s.db.Query(`SELECT id,name,endpoints,token_id,token_secret,created_at FROM clusters ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Cluster
	for rows.Next() {
		var c Cluster
		var ep, sec string
		if err := rows.Scan(&c.ID, &c.Name, &ep, &c.TokenID, &sec, &c.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ep), &c.Endpoints); err != nil {
			return nil, err
		}
		if c.TokenSecret, err = s.open(sec); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// AddAudit appends an entry and returns it with its ID.
func (s *Store) AddAudit(e AuditEntry) (AuditEntry, error) {
	if e.At == 0 {
		e.At = time.Now().Unix()
	}
	cli, _ := json.Marshal(e.CLI)
	if e.Results == nil {
		e.Results = json.RawMessage("[]")
	}
	res, err := s.db.Exec(`INSERT INTO audit(at,user,cluster_id,action,title,cli,ok,results) VALUES(?,?,?,?,?,?,?,?)`,
		e.At, e.User, e.ClusterID, e.Action, e.Title, string(cli), e.OK, string(e.Results))
	if err != nil {
		return e, err
	}
	e.ID, _ = res.LastInsertId()
	return e, nil
}

// Audit returns the newest entries.
func (s *Store) Audit(limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT id,at,user,cluster_id,action,title,cli,ok,results FROM audit ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var cli, res string
		if err := rows.Scan(&e.ID, &e.At, &e.User, &e.ClusterID, &e.Action, &e.Title, &cli, &e.OK, &res); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(cli), &e.CLI)
		e.Results = json.RawMessage(res)
		out = append(out, e)
	}
	return out, rows.Err()
}
