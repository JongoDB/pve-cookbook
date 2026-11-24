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
