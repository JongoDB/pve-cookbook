package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/plan"
)

// galley.* actions change galley's own configuration. They go through
// Changes like PVE changes (reviewable, audited, owner-only), and applying
// one runs the same HTTP handler the UI uses, so permission checks,
// validation and security events are identical.

type galleyAction struct {
	method, path string // handler route, {id}/{node}/{key} filled from params
	describe     func(cid string, body map[string]string) string
	payload      func(body map[string]string) ([]byte, error)
	destructive  bool
}

func boolField(v string) any {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return v
}

var galleyActions = map[string]galleyAction{
	"galley.cluster.update": {
		method: http.MethodPut, path: "/api/clusters/{id}",
		describe: func(cid string, b map[string]string) string {
			var parts []string
			for _, k := range sortedKeys(b) {
				parts = append(parts, k+" = "+b[k])
			}
			return "Update galley's settings for cluster " + cid + ": " + strings.Join(parts, ", ")
		},
		payload: func(b map[string]string) ([]byte, error) {
			m := map[string]any{}
			for k, v := range b {
				switch k {
				case "name", "credentialMode", "hostTransport":
					m[k] = v
				case "shareLogin":
					m[k] = boolField(v)
				default:
					return nil, fmt.Errorf("unknown setting %q (allowed: name, shareLogin, credentialMode, hostTransport)", k)
				}
			}
			return json.Marshal(m)
		},
	},
	"galley.cluster.remove": {
		method: http.MethodDelete, path: "/api/clusters/{id}", destructive: true,
		describe: func(cid string, _ map[string]string) string {
			return "Remove cluster " + cid + " from galley (the cluster itself is not touched)"
		},
		payload: func(b map[string]string) ([]byte, error) { return nil, nil },
	},
	"galley.host.pin": {
		method: http.MethodPut, path: "/api/clusters/{id}/hosts/{node}",
		describe: func(cid string, b map[string]string) string {
			return "Trust the SSH host key " + b["fingerprint"] + " for node " + b["node"]
		},
		payload: func(b map[string]string) ([]byte, error) {
			return json.Marshal(map[string]string{"fingerprint": b["fingerprint"]})
		},
	},
	"galley.host.unpin": {
		method: http.MethodDelete, path: "/api/clusters/{id}/hosts/{node}",
		describe: func(cid string, b map[string]string) string { return "Forget the SSH host key of node " + b["node"] },
		payload:  func(b map[string]string) ([]byte, error) { return nil, nil },
	},
	"galley.prefs.set": {
		method: http.MethodPut, path: "/api/prefs/{key}",
		describe: func(cid string, b map[string]string) string { return "Change your galley preference " + b["key"] },
		payload: func(b map[string]string) ([]byte, error) {
			if !json.Valid([]byte(b["value"])) {
				return nil, fmt.Errorf("value must be JSON")
			}
			return []byte(b["value"]), nil
		},
	},
}

func sortedKeys(m map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// GalleyActionNames lists the galley.* actions (for docs and tools).
func GalleyActionNames() []string {
	out := make([]string, 0, len(galleyActions))
	for k := range galleyActions {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// buildGalleyPlan validates a galley.* request and registers it as a change.
func (s *Server) buildGalleyPlan(ctx context.Context, ss *session, req plan.Request) (*plan.Plan, error) {
	ga, ok := galleyActions[req.Action]
	if !ok {
		return nil, fmt.Errorf("unknown galley action %q", req.Action)
	}
	if _, err := s.store.Cluster(req.ClusterID); err != nil && req.Action != "galley.prefs.set" {
		return nil, fmt.Errorf("unknown cluster")
	}
	body := map[string]string{}
	if len(req.Params) > 0 {
		var raw map[string]any
		if err := json.Unmarshal(req.Params, &raw); err != nil {
			return nil, fmt.Errorf("params must be an object: %v", err)
		}
		for k, v := range raw {
			switch t := v.(type) {
			case string:
				body[k] = t
			default:
				b, _ := json.Marshal(t)
				body[k] = string(b)
			}
		}
	}
	if strings.Contains(ga.path, "{node}") && !hostRe.MatchString(body["node"]) {
		return nil, fmt.Errorf("node required")
	}
	if strings.Contains(ga.path, "{key}") && !prefKeyRe.MatchString(body["key"]) {
		return nil, fmt.Errorf("key required")
	}
	if _, err := ga.payload(withoutRouteKeys(ga, body)); err != nil {
		return nil, err
	}
	desc := ga.describe(req.ClusterID, body)
	p := &plan.Plan{Action: req.Action, ClusterID: req.ClusterID, Title: desc, Destructive: ga.destructive,
		Summary: "Changes galley's own configuration; nothing on the cluster changes.",
		Steps:   []plan.Step{{Description: desc, Method: plan.MethodGalley, Path: req.Action, Body: body, CLI: desc}}}
	if ga.destructive {
		p.ConfirmText = "remove " + req.ClusterID
	}
	if err := s.plans.Register(ss.user, p); err != nil {
		return nil, err
	}
	return p, nil
}

func withoutRouteKeys(ga galleyAction, b map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range b {
		if (k == "node" && strings.Contains(ga.path, "{node}")) || (k == "key" && strings.Contains(ga.path, "{key}")) {
			continue
		}
		out[k] = v
	}
	return out
}

// galleyRunner applies galley.* steps through the regular handlers as ss.
func (s *Server) galleyRunner(ss *session, cid string) plan.GalleyRunner {
	return func(ctx context.Context, action string, body map[string]string) (string, error) {
		ga, ok := galleyActions[action]
		if !ok {
			return "", fmt.Errorf("unknown galley action %q", action)
		}
		payload, err := ga.payload(withoutRouteKeys(ga, body))
		if err != nil {
			return "", err
		}
		path := strings.NewReplacer("{id}", cid, "{node}", body["node"], "{key}", body["key"]).Replace(ga.path)
		r := httptest.NewRequestWithContext(ctx, ga.method, path, bytes.NewReader(payload))
		r.Header.Set("Content-Type", "application/json")
		r.SetPathValue("id", cid)
		r.SetPathValue("node", body["node"])
		r.SetPathValue("key", body["key"])
		w := httptest.NewRecorder()
		h := map[string]handler{
			"galley.cluster.update": s.updateCluster, "galley.cluster.remove": s.deleteCluster,
			"galley.host.pin": s.pinHost, "galley.host.unpin": s.unpinHost, "galley.prefs.set": s.putPref,
		}[action]
		h(w, r, ss)
		if w.Code >= 300 {
			var e struct{ Error string }
			_ = json.Unmarshal(w.Body.Bytes(), &e)
			if e.Error == "" {
				e.Error = http.StatusText(w.Code)
			}
			return "", fmt.Errorf("%s", e.Error)
		}
		return "Done.", nil
	}
}
