package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/schema"
)

type schemaEntry struct {
	s   *schema.Schema
	at  time.Time
	err error
}

type schemaCache struct {
	mu      sync.Mutex
	m       map[string]*schemaEntry
	loading map[string]chan struct{}
}

var schemas = &schemaCache{m: map[string]*schemaEntry{}, loading: map[string]chan struct{}{}}

// clusterSchema returns the cluster's own API schema, fetched from
// /pve-docs/api-viewer/apidoc.js and cached for 6 hours (1 minute on error).
func (s *Server) clusterSchema(ctx context.Context, cid string) (*schema.Schema, error) {
	for {
		schemas.mu.Lock()
		e := schemas.m[cid]
		if e != nil && ((e.err == nil && time.Since(e.at) < 6*time.Hour) || (e.err != nil && time.Since(e.at) < time.Minute)) {
			schemas.mu.Unlock()
			return e.s, e.err
		}
		if ch := schemas.loading[cid]; ch != nil {
			schemas.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		schemas.loading[cid] = ch
		schemas.mu.Unlock()

		base, _, err := s.baseClient(cid)
		var sc *schema.Schema
		if err == nil {
			fctx, cancel := context.WithTimeout(s.base, 30*time.Second)
			var b []byte
			b, err = base.GetStatic(fctx, "/pve-docs/api-viewer/apidoc.js", 64<<20)
			cancel()
			if err == nil {
				sc, err = schema.Parse(b)
			}
		}
		schemas.mu.Lock()
		schemas.m[cid] = &schemaEntry{s: sc, at: time.Now(), err: err}
		delete(schemas.loading, cid)
		schemas.mu.Unlock()
		close(ch)
		return sc, err
	}
}

// GET /api/clusters/{id}/schema → every API path with its methods (for search).
// GET /api/clusters/{id}/schema?path=/nodes/pve1/qemu/120/config → that node's
// full description (methods, parameters, permissions) and the path's variables.
func (s *Server) schemaInfo(w http.ResponseWriter, r *http.Request, ss *session) {
	cid := r.PathValue("id")
	if s.view(r.Context(), ss, cid) == nil {
		apiError(w, 409, "cluster_login_required", "log in to this cluster first")
		return
	}
	sc, err := s.clusterSchema(r.Context(), cid)
	if err != nil {
		apiError(w, 502, "schema_unavailable", "could not load this cluster's API schema: "+err.Error())
		return
	}
	if p := r.URL.Query().Get("path"); p != "" {
		n, vars, err := sc.Match(p)
		if err != nil {
			apiError(w, 404, "not_found", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"path": n.Path, "text": n.Text, "info": n.Info, "vars": vars})
		return
	}
	writeJSON(w, 200, sc.Paths())
}
