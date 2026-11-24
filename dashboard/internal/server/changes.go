package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
)

// maxRun bounds a whole change; each PVE task is also bounded by plan.TaskTimeout.
const maxRun = 4 * time.Hour

func (s *Server) createPlan(w http.ResponseWriter, r *http.Request, ss *session) {
	var req plan.Request
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	v := s.view(r.Context(), ss, req.ClusterID)
	cl, _, cerr := s.userClient(r.Context(), ss, req.ClusterID)
	if v == nil || cerr != nil {
		apiError(w, 409, "cluster_login_required", "log in to this cluster first")
		return
	}
	if req.Action == "host.exec" && !hostAdmin(v) {
		apiError(w, 403, "forbidden", hostAdminMsg)
		return
	}
	p, err := s.plans.Build(r.Context(), ss.user, req, func(id int) bool { return v.guests[id] }, cl)
	switch {
	case errors.Is(err, plan.ErrTooMany):
		apiError(w, 429, "too_many_plans", err.Error())
		return
	case err != nil:
		apiError(w, 400, "bad_plan", err.Error())
		return
	}
	writeJSON(w, 201, p)
}

func (s *Server) discardPlan(w http.ResponseWriter, r *http.Request, ss *session) {
	s.plans.Discard(r.PathValue("id"), ss.user)
	w.WriteHeader(204)
}

// runPlan records the change as running, answers 202, and executes it in the
// background (independent of the browser), waiting for every PVE task to
// finish. Progress and the outcome arrive as SSE "audit" events.
func (s *Server) runPlan(w http.ResponseWriter, r *http.Request, ss *session) {
	var req struct {
		Confirm string `json:"confirm"`
	}
	if err := readJSON(r, &req); err != nil {
		apiError(w, 400, "bad_request", err.Error())
		return
	}
	id := r.PathValue("id")
	p, err := s.plans.Peek(id, ss.user)
	if err != nil {
		apiError(w, 404, "plan_not_found", err.Error())
		return
	}
	// Credential first, so a missing login does not consume the plan.
	cl, cr, err := s.userClient(r.Context(), ss, p.ClusterID)
	if err != nil {
		apiError(w, 409, "cluster_login_required", err.Error())
		return
	}
	if hasHostSteps(p) {
		if v := s.view(r.Context(), ss, p.ClusterID); v == nil || !hostAdmin(v) {
			apiError(w, 403, "forbidden", hostAdminMsg)
			return
		}
	}
	p, err = s.plans.Take(id, ss.user, req.Confirm)
	switch {
	case errors.Is(err, plan.ErrNotFound):
		apiError(w, 404, "plan_not_found", err.Error())
		return
	case errors.Is(err, plan.ErrConfirm):
		apiError(w, 400, "confirm_mismatch", err.Error())
		return
	case err != nil:
		apiError(w, 409, "plan_unavailable", err.Error())
		return
	}
	entry, err := s.store.AddAudit(store.AuditEntry{User: ss.user, ActorUser: cr.PVEUser, ClusterID: p.ClusterID, Action: p.Action,
		Title: p.Title, CLI: p.CLI(), Status: "running", Results: json.RawMessage("[]")})
	if err != nil {
		// Never change a cluster without an audit record.
		apiError(w, 500, "audit_unavailable", "could not record the change, so it was not run: "+err.Error())
		return
	}
	s.broadcastAudit(entry)
	s.log.Info("change started", "audit", entry.ID, "user", ss.user, "as", cr.PVEUser, "action", p.Action, "title", p.Title)

	s.inflight.Add(1)
	go func() {
		defer s.inflight.Done()
		ctx, cancel := context.WithTimeout(s.base, maxRun)
		defer cancel()
		results, ok := plan.Execute(ctx, cl, p, func(rs []plan.Result) {
			raw, _ := json.Marshal(rs)
			if e, err := s.store.UpdateAudit(entry.ID, "running", false, raw); err == nil {
				s.broadcastAudit(e)
			}
		}, s.hostRunner(p.ClusterID))
		if !ok && s.base.Err() != nil && len(results) > 0 {
			results[len(results)-1].Error = "galley stopped while this step was running; check the PVE task log for the outcome"
		}
		raw, _ := json.Marshal(results)
		status := map[bool]string{true: "ok", false: "error"}[ok]
		e, err := s.store.UpdateAudit(entry.ID, status, ok, raw)
		if err != nil {
			s.log.Error("audit update failed", "audit", entry.ID, "err", err)
		} else {
			s.broadcastAudit(e)
		}
		s.log.Info("change finished", "audit", entry.ID, "ok", ok)
		s.fleet.Trigger(p.ClusterID)
	}()
	writeJSON(w, 202, map[string]any{"auditId": entry.ID, "status": "running", "results": []plan.Result{}})
}

// ---- SSE ----

func (s *Server) broadcastAudit(e store.AuditEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.auditSubs {
		select {
		case ch <- e:
		default: // slow client: it will catch up from GET /api/audit
		}
	}
}

func (s *Server) events(w http.ResponseWriter, r *http.Request, ss *session) {
	fl, ok := w.(http.Flusher)
	if !ok {
		apiError(w, 500, "sse", "streaming unsupported")
		return
	}
	s.mu.Lock()
	if s.sseCount[ss.id] >= maxSSEPerSess {
		s.mu.Unlock()
		apiError(w, 429, "too_many_streams", "too many open tabs for this session")
		return
	}
	s.sseCount[ss.id]++
	au := make(chan store.AuditEntry, 16)
	s.auditSubs[au] = ss
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.auditSubs, au)
		if s.sseCount[ss.id]--; s.sseCount[ss.id] <= 0 {
			delete(s.sseCount, ss.id)
		}
		s.mu.Unlock()
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	send := func(name string, v any) bool {
		b, _ := json.Marshal(v)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	ctx := r.Context()
	if !send("fleet", s.userFleet(ctx, ss, s.fleet.Fleet())) || !send("tasks", s.userTasks(ctx, ss, s.fleet.Tasks("", 500), 50)) {
		return
	}
	evs, cancel := s.fleet.Subscribe()
	defer cancel()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	recheck := time.NewTicker(30 * time.Second)
	defer recheck.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.streams.Done():
			return
		case <-recheck.C:
			// End the stream when the session ends (logout, expiry, deletion).
			if _, err := s.store.GetSession(ss.id); err != nil {
				_ = send("session", map[string]string{"state": "ended"})
				return
			}
		case e := <-evs:
			var data any = e.Data
			switch d := e.Data.(type) {
			case fleet.Fleet:
				data = s.userFleet(ctx, ss, d)
			case []fleet.Task:
				_ = d // the event carries only the global top 50; filter from the full list
				data = s.userTasks(ctx, ss, s.fleet.Tasks("", 500), 50)
			default:
				continue // unknown payloads are never forwarded unfiltered
			}
			if !send(e.Name, data) {
				return
			}
		case a := <-au:
			vs := s.userViews(ctx, ss)
			if s.auditVisible(ctx, ss, a, vs) && !send("audit", a) {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}
