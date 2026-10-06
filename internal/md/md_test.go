package md

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownConversion(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"paragraph and inline marks",
			"<p>Use <strong>Go</strong> or <em>Rust</em>, see <code>net/http</code> and <a href=\"https://go.dev\">the docs</a>.</p>",
			"Use **Go** or *Rust*, see `net/http` and [the docs](https://go.dev)."},
		{"space next to an inline tag survives",
			"<p><strong>x</strong> and y</p>", "**x** and y"},
		{"headings",
			"<h2>One</h2>\n<h3>Two</h3>\n<h4>Three</h4>", "## One\n\n### Two\n\n#### Three"},
		{"bullets and numbers",
			"<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<ol>\n<li>x</li>\n<li>y</li>\n</ol>", "- a\n- b\n\n1. x\n2. y"},
		{"nested list",
			"<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>", "- a\n  - b\n- c"},
		{"code fence keeps the language",
			"<pre><code class=\"language-go\">fmt.Println(1)\n</code></pre>", "```go\nfmt.Println(1)\n```"},
		{"table with caption",
			"<table>\n<caption>Speed</caption>\n<thead>\n<tr>\n<th>Lang</th>\n<th>Speed</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Go</td>\n<td>fast</td>\n</tr>\n</tbody>\n</table>",
			"**Speed**\n\n| Lang | Speed |\n| --- | --- |\n| Go | fast |"},
		{"callout",
			"<aside class=\"tip\" role=\"note\"><p>Pick Go.</p></aside>", "> **Tip:** Pick Go."},
		{"suggested replies become a list",
			"<menu><li><button type=\"button\" value=\"a\">One</button></li><li><button type=\"button\" value=\"b\">Two</button></li></menu>", "- One\n- Two"},
		{"blockquote and rule", "<blockquote><p>q</p></blockquote><hr>", "> q\n\n---"},
		{"widgets are dropped", "<p>a</p><template data-widget title=\"x\"><div>hi</div><script>1</script></template><p>b</p>", "a\n\nb"},
		{"pipes in cells are escaped", "<table><tr><td>a|b</td></tr></table>", "| a\\|b |\n| --- |"},
	}
	for _, c := range cases {
		if got := ToMarkdown(c.in); got != c.want {
			t.Errorf("%s:\n got  %q\n want %q", c.name, got, c.want)
		}
	}
}

// Real answers convert without leaving markup behind or going empty.
func TestMarkdownOfGoodSamples(t *testing.T) {
	files, _ := filepath.Glob("../../conformance/cases/good/*.html")
	if len(files) == 0 {
		t.Skip("no samples")
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		md := ToMarkdown(string(b))
		if strings.TrimSpace(md) == "" {
			t.Errorf("%s: empty markdown", f)
		}
		for _, tag := range []string{"<p>", "</p>", "<li>", "<table", "<tr>", "<td>", "<strong>"} {
			if strings.Contains(md, tag) {
				t.Errorf("%s: markdown still contains %s:\n%s", f, tag, md)
			}
		}
	}
}
