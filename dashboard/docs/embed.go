// Package docs embeds galley's user guide (docs/user/*.md) so the binary can
// serve it on the Help page and give it to the assistant.
package docs

import (
	"embed"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

//go:embed all:user
var files embed.FS

//go:embed changelog.md
var changelog string

// Release is one version's notes from changelog.md.
type Release struct {
	Version  string `json:"version"`
	Date     string `json:"date"`
	Markdown string `json:"markdown"`
}

var releases = parseChangelog(changelog)

// Releases lists release notes, newest first.
func Releases() []Release { return releases }

var releaseHead = regexp.MustCompile(`^## v?([0-9][0-9A-Za-z.+-]*)\s*(?:—|-|–)?\s*(\d{4}-\d{2}-\d{2})?\s*$`)

func parseChangelog(s string) []Release {
	var out []Release
	var cur *Release
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		if m := releaseHead.FindStringSubmatch(line); m != nil {
			out = append(out, Release{Version: m[1], Date: m[2]})
			cur = &out[len(out)-1]
			continue
		}
		if cur != nil {
			cur.Markdown += line + "\n"
		}
	}
	for i := range out {
		out[i].Markdown = strings.TrimSpace(out[i].Markdown)
	}
	return out
}

// Page is one user-guide page.
type Page struct {
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
	Order    int    `json:"order"`
	Route    string `json:"route,omitempty"`
	Markdown string `json:"markdown,omitempty"`
}

var pages = load()

func load() []Page {
	var out []Page
	ents, _ := fs.ReadDir(files, "user")
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".md") || strings.EqualFold(name, "README.md") {
			continue
		}
		b, err := fs.ReadFile(files, "user/"+name)
		if err != nil {
			continue
		}
		p := parse(string(b))
		p.Slug = strings.TrimSuffix(name, ".md")
		if p.Title == "" {
			p.Title = p.Slug
		}
		out = append(out, p)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

func parse(s string) Page {
	var p Page
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if strings.HasPrefix(s, "---\n") {
		if end := strings.Index(s[4:], "\n---"); end >= 0 {
			for _, line := range strings.Split(s[4:4+end], "\n") {
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				v = strings.Trim(strings.TrimSpace(v), `"'`)
				switch strings.TrimSpace(k) {
				case "title":
					p.Title = v
				case "summary":
					p.Summary = v
				case "order":
					p.Order, _ = strconv.Atoi(v)
				case "route":
					p.Route = v
				}
			}
			rest := 4 + end + 4
			if rest > len(s) {
				rest = len(s)
			}
			s = strings.TrimLeft(s[rest:], "\n")
		}
	}
	p.Markdown = s
	return p
}

// Index lists pages without their bodies, in reading order.
func Index() []Page {
	out := make([]Page, len(pages))
	for i, p := range pages {
		p.Markdown = ""
		out[i] = p
	}
	return out
}

// Get returns one page.
func Get(slug string) (Page, bool) {
	for _, p := range pages {
		if p.Slug == slug {
			return p, true
		}
	}
	return Page{}, false
}

// Hit is a search result: the page and its best-matching section.
type Hit struct {
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Section string `json:"section"`
	Excerpt string `json:"excerpt"`
	Score   int    `json:"-"`
}

var word = regexp.MustCompile(`[a-z0-9]+`)

// stopWords carry no meaning for ranking ("how do I create a mapping").
var stopWords = map[string]bool{"a": true, "an": true, "the": true, "to": true, "of": true, "in": true, "on": true,
	"for": true, "and": true, "or": true, "is": true, "it": true, "i": true, "do": true, "how": true, "can": true,
	"my": true, "with": true, "what": true, "where": true, "does": true, "be": true, "this": true, "that": true, "galley": true}

// Search ranks sections by how many query terms they contain (each term
// counts once, capped occurrences), with heading and title matches weighing
// most, so a focused section beats a long page that repeats common words.
func Search(q string, limit int) []Hit {
	var terms []string
	for _, t := range word.FindAllString(strings.ToLower(q), -1) {
		if !stopWords[t] && len(t) > 1 {
			terms = append(terms, t)
		}
	}
	if len(terms) == 0 {
		return nil
	}
	var hits []Hit
	for _, p := range pages {
		title, summary := strings.ToLower(p.Title), strings.ToLower(p.Summary)
		for _, sec := range sections(p.Markdown) {
			body, head := strings.ToLower(sec.body), strings.ToLower(sec.heading)
			score, matched := 0, 0
			for _, t := range terms {
				in := false
				if strings.Contains(head, t) {
					score += 6
					in = true
				}
				if strings.Contains(title, t) {
					score += 4
					in = true
				}
				if strings.Contains(summary, t) {
					score += 2
					in = true
				}
				if n := strings.Count(body, t); n > 0 {
					score += min(n, 3)
					in = true
				}
				if in {
					matched++
				}
			}
			if matched == 0 {
				continue
			}
			score += 10 * matched * matched / len(terms) // reward covering more of the query
			ex := strings.TrimSpace(sec.body)
			if r := []rune(ex); len(r) > 700 {
				ex = string(r[:700]) + "…"
			}
			hits = append(hits, Hit{Slug: p.Slug, Title: p.Title, Section: sec.heading, Excerpt: ex, Score: score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

type section struct{ heading, body string }

func sections(md string) []section {
	var out []section
	cur := section{}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "### ") {
			if strings.TrimSpace(cur.body) != "" || cur.heading != "" {
				out = append(out, cur)
			}
			cur = section{heading: strings.TrimSpace(strings.TrimLeft(line, "# "))}
			continue
		}
		cur.body += line + "\n"
	}
	return append(out, cur)
}
