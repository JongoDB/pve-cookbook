package server

import "github.com/JongoDB/pve-cookbook/dashboard/internal/store"

// Test hooks for the external server_test package.

// RenewDue runs one background renewal pass.
func (s *Server) RenewDue() { s.renewDue() }

// PurgeExpired runs one session purge pass.
func (s *Server) PurgeExpired() { s.purgeExpired() }

// KeyCached reports whether the secret of the session with this id is in memory.
func (s *Server) KeyCached(sessionID string) bool { return s.cachedKey(store.HashID(sessionID)) != nil }

// ParseCookie splits a session cookie value into id and secret.
func ParseCookie(v string) (string, []byte, bool) { return parseCookie(v) }

// AgeKeys makes every cached session secret look idle for longer than keyIdle
// (as if the users had walked away); held secrets stay usable.
func (s *Server) AgeKeys() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.keys {
		h.seen = h.seen.Add(-2 * keyIdle)
	}
}

// DropViews forgets cached per-user permission views (normally kept 30 s).
func (s *Server) DropViews() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.views)
}
