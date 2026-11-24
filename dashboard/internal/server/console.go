package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type consoleTicket struct {
	session, cluster, node, path string
	query                        url.Values
	exp                          time.Time
}

// POST /api/clusters/{id}/console {"type":"qemu"|"lxc"|"node","node","vmid"?}
// asks PVE (as the user, so VM.Console / Sys.Console apply) for a console
// ticket and returns a one-time galley token for the websocket.
//
// Response: {"token","protocol":"vnc"|"term","password","user","port"}.
// vnc: noVNC with password; term: after connecting send "<user>:<password>\n",
// then PVE termproxy framing ("0:<len>:<data>", resize "1:<cols>:<rows>:").
func (s *Server) openConsole(w http.ResponseWriter, r *http.Request, ss *session) {
	cid := r.PathValue("id")
	var req struct {
		Type string `json:"type"`
		Node string `json:"node"`
		VMID int    `json:"vmid"`
	}
	if err := readJSON(r, &req); err != nil || !hostRe.MatchString(req.Node) {
		apiError(w, 400, "bad_request", "type and node required")
		return
	}
	cl, _, err := s.userClient(r.Context(), ss, cid)
	if err != nil {
		apiError(w, 409, "cluster_login_required", err.Error())
		return
	}
	var base, proxy, protocol string
	form := url.Values{}
	switch req.Type {
	case "qemu":
		base, proxy, protocol = fmt.Sprintf("/nodes/%s/qemu/%d", req.Node, req.VMID), "vncproxy", "vnc"
		form.Set("websocket", "1")
		form.Set("generate-password", "1")
	case "lxc":
		base, proxy, protocol = fmt.Sprintf("/nodes/%s/lxc/%d", req.Node, req.VMID), "termproxy", "term"
	case "node":
		base, proxy, protocol = "/nodes/"+req.Node, "termproxy", "term"
	default:
		apiError(w, 400, "bad_request", "type must be qemu, lxc or node")
		return
	}
	if req.Type != "node" && req.VMID < 100 {
		apiError(w, 400, "bad_request", "vmid required")
		return
	}
	var res struct {
		Port     any    `json:"port"`
		Ticket   string `json:"ticket"`
		User     string `json:"user"`
		Password string `json:"password"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := cl.Do(ctx, http.MethodPost, base+"/"+proxy, form, &res); err != nil {
		apiError(w, 403, "console_denied", "PVE refused the console: "+err.Error())
		return
	}
	port := fmt.Sprint(res.Port)
	if _, err := strconv.Atoi(port); err != nil {
		apiError(w, 502, "console_failed", "PVE returned no console port")
		return
	}
	token := randHex(24)
	s.mu.Lock()
	s.consoles[token] = consoleTicket{session: ss.id, cluster: cid, node: req.Node, path: base + "/vncwebsocket",
		query: url.Values{"port": {port}, "vncticket": {res.Ticket}}, exp: time.Now().Add(time.Minute)}
	s.mu.Unlock()
	password := res.Ticket
	if res.Password != "" {
		password = res.Password
	}
	s.log.Info("console opened", "user", ss.user, "cluster", cid, "target", base)
	writeJSON(w, 200, map[string]any{"token": token, "protocol": protocol, "password": password, "user": res.User, "port": port})
}

// GET /api/console/{token} upgrades to a websocket proxied to PVE.
func (s *Server) consoleSocket(w http.ResponseWriter, r *http.Request, ss *session) {
	// Websocket handshakes carry cookies cross-site: insist on our own origin.
	if o := r.Header.Get("Origin"); o != "" {
		if u, err := url.Parse(o); err != nil || !strings.EqualFold(u.Host, r.Host) {
			apiError(w, 403, "cross_site", "cross-origin console refused")
			return
		}
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		apiError(w, 400, "bad_request", "websocket upgrade required")
		return
	}
	tok := r.PathValue("token")
	s.mu.Lock()
	ct, ok := s.consoles[tok]
	delete(s.consoles, tok) // single use
	s.mu.Unlock()
	if !ok || ct.session != ss.id || time.Now().After(ct.exp) {
		apiError(w, 404, "not_found", "console link expired; open the console again")
		return
	}
	cl, cr, err := s.userClient(r.Context(), ss, ct.cluster)
	if err != nil {
		apiError(w, 409, "cluster_login_required", err.Error())
		return
	}
	cl.WebsocketProxy(ct.path, ct.query, cr.Secret).ServeHTTP(w, r)
}
