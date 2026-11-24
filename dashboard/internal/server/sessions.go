package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// Session secrets (docs/security.md, "Per-session envelope encryption").
//
// The cookie is "<id>.<K>": id (64 hex) names the session, K (32 random bytes,
// base64url) unlocks its stored PVE credentials. The database keeps only
// hash(id) and a verifier of K. galley keeps K in memory while the session is
// in use — for keyIdle after its last request, for as long as one of its live
// event streams is open, and for as long as one of its changes runs — so that
// tickets can be renewed in the background. After that (or after a restart)
// nothing can decrypt the session's credentials until the browser presents K
// again; tickets of abandoned sessions simply expire in PVE.

const (
	keyIdle       = 30 * time.Minute
	maxCachedKeys = 10000
)

type heldKey struct {
	k     []byte
	seen  time.Time
	holds int
}

func newSessionSecret() []byte {
	k := make([]byte, store.SessionKeySize)
	_, _ = rand.Read(k)
	return k
}

func cookieValue(id string, k []byte) string {
	return id + "." + base64.RawURLEncoding.EncodeToString(k)
}

// parseCookie splits a session cookie into id and K.
func parseCookie(v string) (string, []byte, bool) {
	id, enc, ok := strings.Cut(v, ".")
	if !ok || len(id) != 64 {
		return "", nil, false
	}
	k, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || len(k) != store.SessionKeySize {
		return "", nil, false
	}
	return id, k, true
}

// rememberKey records that the session with this hash was just used with K.
func (s *Server) rememberKey(hash string, k []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rememberKeyLocked(hash, k, time.Now())
}

func (s *Server) rememberKeyLocked(hash string, k []byte, now time.Time) *heldKey {
	if h := s.keys[hash]; h != nil {
		h.seen = now
		return h
	}
	if len(s.keys) >= maxCachedKeys {
		s.gcKeysLocked(now)
		if len(s.keys) >= maxCachedKeys { // evict the least recently used idle entry
			var oldest string
			for hs, h := range s.keys {
				if h.holds == 0 && (oldest == "" || h.seen.Before(s.keys[oldest].seen)) {
					oldest = hs
				}
			}
			if oldest != "" {
				clear(s.keys[oldest].k)
				delete(s.keys, oldest)
			}
		}
	}
	h := &heldKey{k: append([]byte(nil), k...), seen: now}
	s.keys[hash] = h
	return h
}

// holdKey keeps K in memory until release is called (a running change, an
// open event stream), however long the user stays idle.
func (s *Server) holdKey(hash string, k []byte) (release func()) {
	s.mu.Lock()
	h := s.rememberKeyLocked(hash, k, time.Now())
	h.holds++
	s.mu.Unlock()
	done := false
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if !done {
			done = true
			h.holds--
			h.seen = time.Now()
		}
	}
}

// cachedKey returns K of a session in use, or nil.
func (s *Server) cachedKey(hash string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.keys[hash]
	if h == nil || (h.holds == 0 && time.Since(h.seen) > keyIdle) {
		return nil
	}
	return append([]byte(nil), h.k...)
}

func (s *Server) forgetKey(hash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.keys[hash]; h != nil {
		if h.holds == 0 {
			clear(h.k)
		}
		delete(s.keys, hash) // holders keep their own copy until they finish
	}
}

func (s *Server) gcKeysLocked(now time.Time) {
	for hs, h := range s.keys {
		if h.holds == 0 && now.Sub(h.seen) > keyIdle {
			clear(h.k)
			delete(s.keys, hs)
		}
	}
}

// ---- storing a fresh login ----

// addLogin stores the credential for cluster c obtained with ticket t, in the
// cluster's credential mode. In "token" mode the ticket is used once to create
// a per-session API token (expiring with the session) and then discarded.
func (s *Server) addLogin(ctx context.Context, ss *session, c *store.Cluster, t *pve.Ticket) error {
	base, _, err := s.baseClient(c.ID)
	if err != nil {
		return err
	}
	tc := base.WithAuth(t)
	s.revokePending(ctx, c.ID, t.User, tc)
	if c.CredentialMode != "token" {
		return s.store.PutCred(ss.id, ss.key, ticketCred(c.ID, t))
	}
	name := "galley-" + randHex(6)
	exp := ss.created + int64(s.opt.SessionMax.Seconds())
	tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	full, secret, err := tc.CreateToken(tctx, t.User, name, exp, "galley session")
	if err != nil {
		return fmt.Errorf("could not create a galley API token for %s on %s: %w", t.User, c.Name, err)
	}
	cr := store.Cred{ClusterID: c.ID, PVEUser: t.User, Kind: "token", TokenID: full, Secret: secret, Expires: exp}
	if err := s.store.PutCred(ss.id, ss.key, cr); err != nil {
		_ = tc.DeleteToken(tctx, t.User, name)
		return err
	}
	return nil
}

func tokenName(full string) string {
	_, name, _ := strings.Cut(full, "!")
	return name
}

func tokenGone(err error) bool {
	var ae *pve.APIError
	return errors.As(err, &ae) && (ae.Status == 404 || strings.Contains(ae.Message, "no such token"))
}

// revokeToken deletes a per-session token using the token itself. PVE may not
// let a token delete itself; then (or on any failure) the revocation is
// recorded and done with the user's next login ticket on that cluster. The
// token expires on its own at the end of the session's lifetime regardless.
func (s *Server) revokeToken(ctx context.Context, cr store.Cred, reason string) {
	if cr.Kind != "token" || cr.TokenID == "" {
		return
	}
	var err error
	if cr.Secret != "" {
		if base, _, berr := s.baseClient(cr.ClusterID); berr == nil {
			rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = base.WithAuth(pve.TokenAuth{ID: cr.TokenID, Secret: cr.Secret}).DeleteToken(rctx, cr.PVEUser, tokenName(cr.TokenID))
			cancel()
		} else {
			err = berr
		}
	} else {
		err = errors.New("session secret not available")
	}
	if err == nil || tokenGone(err) {
		s.log.Info("galley token revoked", "cluster", cr.ClusterID, "token", cr.TokenID, "reason", reason)
		return
	}
	s.log.Info("galley token revocation deferred to the user's next login", "cluster", cr.ClusterID, "token", cr.TokenID, "reason", reason, "err", err)
	if aerr := s.store.AddTokenRevocation(store.TokenRevocation{ClusterID: cr.ClusterID, PVEUser: cr.PVEUser, TokenID: cr.TokenID, Reason: reason, Created: s.revocationDate(cr.Expires)}); aerr != nil {
		s.log.Error("record token revocation", "err", aerr)
	}
	s.securityEvent(cr.PVEUser, cr.ClusterID, "auth.token", "galley could not revoke API token "+cr.TokenID+" yet", false,
		map[string]any{"token": cr.TokenID, "reason": reason, "error": err.Error(), "expires": cr.Expires,
			"note": "it is deleted at this user's next login to the cluster and expires on its own"})
}

// revokePending deletes galley tokens of user on cluster cid that could not be
// revoked earlier, using a fresh login ticket (tc).
func (s *Server) revokePending(ctx context.Context, cid, user string, tc *pve.Client) {
	rs, err := s.store.TokenRevocations(cid, user)
	if err != nil || len(rs) == 0 {
		return
	}
	for _, r := range rs {
		rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := tc.DeleteToken(rctx, user, tokenName(r.TokenID))
		cancel()
		if err == nil || tokenGone(err) {
			_ = s.store.DeleteTokenRevocation(cid, r.TokenID)
			s.securityEvent(user, cid, "auth.token", "Revoked earlier galley API token "+r.TokenID, true, map[string]any{"token": r.TokenID, "reason": r.Reason})
			continue
		}
		s.log.Warn("revoking an earlier galley token failed", "cluster", cid, "token", r.TokenID, "err", err)
	}
}

// purgeExpired deletes ended sessions. Their tokens cannot be revoked here
// (the session secret is gone with the session), so they are queued for the
// user's next login; they expire on their own at the latest.
func (s *Server) purgeExpired() {
	metas, err := s.store.PurgeExpiredSessions(time.Now().Unix())
	if err != nil {
		s.log.Error("purge sessions", "err", err)
		return
	}
	for _, m := range metas {
		if m.Kind == "token" && m.Expires > time.Now().Unix() {
			_ = s.store.AddTokenRevocation(store.TokenRevocation{ClusterID: m.ClusterID, PVEUser: m.PVEUser, TokenID: m.TokenID, Reason: "session expired", Created: s.revocationDate(m.Expires)})
		}
		s.forgetKey(m.SessionHash)
	}
	if len(metas) > 0 {
		s.log.Info("expired sessions purged", "credentials", len(metas))
	}
	// Tokens are created to expire with their session: older entries are moot.
	_ = s.store.PruneTokenRevocations(time.Now().Add(-s.opt.SessionMax - time.Hour).Unix())
}

// revocationDate dates a pending revocation so pruning (SessionMax+1h after
// the date) keeps it until the PVE token itself has expired — agent tokens
// live far longer than sessions.
func (s *Server) revocationDate(tokenExpires int64) int64 {
	return max(time.Now().Unix(), tokenExpires-int64(s.opt.SessionMax.Seconds()))
}
