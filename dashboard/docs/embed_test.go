package docs

import (
	"regexp"
	"testing"
)

func TestParseFrontMatter(t *testing.T) {
	p := parse("---\ntitle: Changes\nsummary: How changes work.\norder: 3\nroute: /changes\n---\n\n# Changes\n\n## Apply a change\nClick **Apply change**.\n")
	if p.Title != "Changes" || p.Order != 3 || p.Route != "/changes" || p.Summary != "How changes work." || p.Markdown[:9] != "# Changes" {
		t.Fatalf("%+v", p)
	}
	ss := sections(p.Markdown)
	if len(ss) != 2 || ss[1].heading != "Apply a change" {
		t.Fatalf("sections: %+v", ss)
	}
}

// Every shipped help page must have the front matter the Help page and the
// assistant rely on, and links between pages must resolve.
func TestShippedPagesAreWellFormed(t *testing.T) {
	re := regexp.MustCompile(`\]\(([a-z0-9-]+)\.md(#[^)]*)?\)`)
	for _, p := range pages {
		if p.Title == p.Slug || p.Summary == "" || p.Order == 0 {
			t.Errorf("%s.md: front matter needs title, summary and order", p.Slug)
		}
		for _, m := range re.FindAllStringSubmatch(p.Markdown, -1) {
			if _, ok := Get(m[1]); !ok {
				t.Errorf("%s.md links to missing page %s.md", p.Slug, m[1])
			}
		}
	}
}

func TestChangelog(t *testing.T) {
	rs := Releases()
	if len(rs) < 2 || rs[0].Version == "" || rs[0].Date == "" || rs[0].Markdown == "" {
		t.Fatalf("changelog: %+v", rs)
	}
	re := regexp.MustCompile(`\]\(/help/([a-z0-9-]+)\)`)
	for _, r := range rs {
		for _, m := range re.FindAllStringSubmatch(r.Markdown, -1) {
			if _, ok := Get(m[1]); !ok {
				t.Errorf("%s links to missing help page %s", r.Version, m[1])
			}
		}
	}
}

// Real queries must land on the page that answers them.
func TestSearchRanking(t *testing.T) {
	cases := map[string]string{
		"create a PCI mapping":            "hardware-and-gpus",
		"how do I take a snapshot":        "guests",
		"agent token MCP":                 "agents-and-mcp",
		"typed confirmation":              "changes",
		"send feedback":                   "feedback",
		"open a console":                  "consoles",
		"run a command on a node as root": "hosts",
	}
	for q, want := range cases {
		hits := Search(q, 3)
		if len(hits) == 0 || hits[0].Slug != want {
			got := []string{}
			for _, h := range hits {
				got = append(got, h.Slug+"#"+h.Section)
			}
			t.Errorf("%q: want %s first, got %v", q, want, got)
		}
	}
}
