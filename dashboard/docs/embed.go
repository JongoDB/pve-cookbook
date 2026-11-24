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
			s = strings.TrimLeft(s[4+end+4:], "\n")
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

// Search scores sections by query term matches (title and headings weigh more).
func Search(q string, limit int) []Hit {
	terms := word.FindAllString(strings.ToLower(q), -1)
	if len(terms) == 0 {
		return nil
	}
	var hits []Hit
	for _, p := range pages {
		for _, sec := range sections(p.Markdown) {
			body := strings.ToLower(sec.body)
			head := strings.ToLower(p.Title + " " + sec.heading)
			score := 0
			for _, t := range terms {
				score += 3*strings.Count(head, t) + strings.Count(body, t)
				if strings.Contains(strings.ToLower(p.Summary), t) {
					score++
				}
			}
			if score > 0 {
				ex := strings.TrimSpace(sec.body)
				if len(ex) > 700 {
					ex = ex[:700] + "…"
				}
				hits = append(hits, Hit{Slug: p.Slug, Title: p.Title, Section: sec.heading, Excerpt: ex, Score: score})
			}
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
