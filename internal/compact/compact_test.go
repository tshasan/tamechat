package compact

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"html-answers/internal/md"
	"html-answers/spec"
)

func TestCompactExamples(t *testing.T) {
	sub, _ := spec.Load()
	cases := []struct{ in, want string }{
		{"<p>a</p>\n\n<p>b</p>", "<p>a<p>b"},
		{"<ul>\n<li>x</li>\n<li>y</li>\n</ul>", "<ul><li>x<li>y</ul>"},
		{"<table>\n<thead>\n<tr>\n<th scope=\"col\">A</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n</tr>\n</tbody>\n</table>",
			"<table><thead><tr><th>A<tbody><tr><td>1</table>"},
		{`<aside class="tip" role="note"><p>x</p></aside>`, `<aside class="tip"><p>x</aside>`},
		{`<menu><li><button type="button" value="v">V</button></li></menu>`, `<menu><li><button value="v">V</button></li></menu>`},
		// whitespace between INLINE tags is a space in the page, so it must stay
		{"<p><strong>a</strong> <em>b</em></p>", "<p><strong>a</strong> <em>b</em>"},
		{"<p>keep <strong>strong</strong> closed</p>", "<p>keep <strong>strong</strong> closed"},
	}
	for _, c := range cases {
		if got := Compact(sub, c.in); got != c.want {
			t.Errorf("\n in   %q\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}

// For every answer in the corpus the compact form must be valid compact-profile HTML and mean
// exactly the same thing: it converts to the same Markdown, so any token saving is a saving on
// identical content.
func TestCompactIsTheSameDocument(t *testing.T) {
	sub, _ := spec.Load()
	var docs []string
	for _, pat := range []string{"../../conformance/cases/good/*.html"} {
		files, _ := filepath.Glob(pat)
		for _, f := range files {
			b, _ := os.ReadFile(f)
			docs = append(docs, string(b))
		}
	}
	b, err := os.ReadFile("../../corpus/answers-qwen3.6-35b.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus []string
	if err := json.Unmarshal(b, &corpus); err != nil {
		t.Fatal(err)
	}
	docs = append(docs, corpus...)
	for i, d := range docs {
		c := Compact(sub, d)
		if vs := sub.Validate(c, spec.Options{Profile: spec.Compact}); len(vs) > 0 {
			t.Errorf("doc %d: compact form is not valid compact HTML: %v\n%.200q", i, vs[:min(3, len(vs))], c)
		}
		if a, b := md.ToMarkdown(d), md.ToMarkdown(c); a != b {
			t.Errorf("doc %d: compact form is a different document\n strict : %.160q\n compact: %.160q", i, a, b)
		}
		if len(c) >= len(d) && len(d) > 60 {
			t.Errorf("doc %d: compact form is not smaller (%d vs %d bytes)", i, len(c), len(d))
		}
	}
	t.Logf("%d documents: compact form valid and equivalent in all", len(docs))
}
