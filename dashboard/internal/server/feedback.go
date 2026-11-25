package server

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/JongoDB/pve-cookbook/dashboard/docs"
)

// What's new and feedback.
//
// Feedback becomes a GitHub issue that the user files from their own GitHub
// account: galley builds a pre-filled "new issue" link and the user reviews
// the text on GitHub before submitting. galley holds no GitHub credential and
// sends nothing anywhere itself.

const feedbackSettingKey = "feedback"

// DefaultFeedbackRepo is where feedback goes unless an admin changes it.
const DefaultFeedbackRepo = "JongoDB/pve-cookbook"

var repoRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`)

type feedbackConfig struct {
	Enabled bool   `json:"enabled"`
	Repo    string `json:"repo"`
}

func (s *Server) feedbackConfig() feedbackConfig {
	c := feedbackConfig{Enabled: true, Repo: DefaultFeedbackRepo}
	if v, err := s.store.GetSetting(feedbackSettingKey); err == nil {
		_ = json.Unmarshal([]byte(v), &c)
	}
	if !repoRe.MatchString(c.Repo) {
		c.Repo = DefaultFeedbackRepo
	}
	return c
}

// GET /api/whats-new → {"version", "releases":[{version,date,markdown}]}
func (s *Server) whatsNew(w http.ResponseWriter, _ *http.Request, _ *session) {
	writeJSON(w, 200, map[string]any{"version": Version, "releases": docs.Releases()})
}

// GET /api/feedback → {"enabled","repo"}
func (s *Server) getFeedback(w http.ResponseWriter, _ *http.Request, _ *session) {
	writeJSON(w, 200, s.feedbackConfig())
}

// PUT /api/settings/feedback {"enabled","repo"} (galley admins)
func (s *Server) putFeedback(w http.ResponseWriter, r *http.Request, ss *session) {
	if !s.galleyAdmin(r.Context(), ss) {
		apiError(w, 403, "forbidden", "feedback settings require a galley admin")
		return
	}
	var c feedbackConfig
	if err := readJSON(r, &c); err != nil || !repoRe.MatchString(c.Repo) {
		apiError(w, 400, "bad_request", "repo must be owner/name on GitHub")
		return
	}
	b, _ := json.Marshal(c)
	if err := s.store.PutSetting(feedbackSettingKey, string(b)); err != nil {
		apiError(w, 500, "store", err.Error())
		return
	}
	s.securityEvent(ss.user, ss.home, "settings.feedback", "Feedback settings changed", true, map[string]any{"enabled": c.Enabled, "repo": c.Repo})
	writeJSON(w, 200, c)
}
