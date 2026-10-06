package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func load(t *testing.T) *Subset {
	t.Helper()
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func kinds(vs []Violation) string {
	var k []string
	for _, v := range vs {
		k = append(k, v.Kind)
	}
	return strings.Join(k, ",")
}

func kindSet(vs []Violation) []string {
	var k []string
	for _, v := range vs {
		if !slices.Contains(k, v.Kind) {
			k = append(k, v.Kind)
		}
	}
	slices.Sort(k)
	return k
}

func TestValidateSmallCases(t *testing.T) {
	s := load(t)
	cases := []struct {
		name    string
		src     string
		opt     Options
		want    string // violation kinds, in order; "" means valid
		wantAny bool   // just require at least one violation
	}{
		{"paragraph", `<p>Hello.</p>`, Options{}, "", false},
		{"entities", `<p>a &lt; b &amp; c &#36;</p>`, Options{}, "", false},
		{"bare text", `hello`, Options{}, "text", false},
		{"unescaped lt", `<p>a < b</p>`, Options{}, "text", false},
		{"bare ampersand", `<p>fish & chips</p>`, Options{}, "text", false},
		{"unknown element", `<p><img src="x"></p>`, Options{}, "element", false},
		{"script", `<p>x</p><script>alert(1)</script>`, Options{}, "element", true},
		{"event handler", `<p onclick="x()">hi</p>`, Options{}, "attribute", false},
		{"style attribute", `<p style="color:red">x</p>`, Options{}, "attribute", false},
		{"javascript href", `<p><a href="javascript:alert(1)">x</a></p>`, Options{}, "href", false},
		{"http href", `<p><a href="http://x.example">x</a></p>`, Options{}, "href", false},
		{"https href", `<p><a href="https://x.example/a?b=c">x</a></p>`, Options{}, "", false},
		{"anchor href", `<p><a href="#top">x</a></p>`, Options{}, "", false},
		{"aside kind", `<aside class="evil" role="note"><p>x</p></aside>`, Options{}, "value", false},
		{"aside needs role in strict", `<aside class="tip"><p>x</p></aside>`, Options{}, "missing", false},
		{"aside without role in compact", `<aside class="tip"><p>x</p></aside>`, Options{Profile: Compact}, "", false},
		{"h1 not allowed", `<h1>T</h1>`, Options{}, "element", false},
		{"empty code", "<p><code>\n</code></p>", Options{}, "empty-code", false},
		{"code with spaces is fine", `<p>Run <code> ls -la </code> now.</p>`, Options{}, "", false},
		{"inline closed", `<p>hi <strong>x</strong></p>`, Options{}, "", false},
		{"unclosed inline", `<p>hi <strong>x</p>`, Options{}, "unbalanced", false},
		{"unclosed inline in compact", `<p>hi <strong>x</p>`, Options{Profile: Compact}, "unbalanced", false},
		{"stray end tag", `<p>x</p></div>`, Options{}, "unbalanced", false},
		{"li not in a list", `<p>x</p><li>y</li>`, Options{}, "structure", false},
		{"p inside ul", `<ul><p>x</p></ul>`, Options{}, "structure", true},
		{"text directly in ul", `<ul>oops<li>x</li></ul>`, Options{}, "text", false},
		{"widget needs permission", `<template data-widget title="x"><script>1</script></template>`, Options{}, "widget", false},
		{"widget allowed", `<template data-widget title="x"><script>1</script></template>`, Options{Widgets: true}, "", false},
		{"template without data-widget", `<template><p>x</p></template>`, Options{Widgets: true}, "element", true},
		{"comment", `<p>x</p><!-- hi -->`, Options{}, "comment", false},
		// compact profile
		{"omitted </p> in strict", `<p>a<p>b`, Options{}, "end-tag,end-tag", false},
		{"omitted </p> in compact", `<p>a<p>b`, Options{Profile: Compact}, "", false},
		{"omitted list ends", `<ul><li>a<li>b</ul>`, Options{Profile: Compact}, "", false},
		{"omitted list ends rejected in strict", `<ul><li>a<li>b</ul>`, Options{}, "end-tag,end-tag", false},
		{"omitted table ends", `<table><thead><tr><th>A<th>B<tbody><tr><td>1<td>2</table>`, Options{Profile: Compact}, "", false},
		{"nested list", `<ul><li>a<ul><li>b</ul><li>c</ul>`, Options{Profile: Compact}, "", false},
		{"p closed by a block", `<p>a<ul><li>b</ul>`, Options{Profile: Compact}, "", false},
		{"menu keeps </li>", `<menu><li><button value="x">X</button></li></menu>`, Options{Profile: Compact}, "", false},
		{"menu li end tag is always required", `<menu><li><button value="x">X</button></menu>`, Options{Profile: Compact}, "end-tag", false},
		{"menu button needs a value", `<menu><li><button>X</button></li></menu>`, Options{Profile: Compact}, "missing", false},
		{"button outside a menu", `<p><button value="x">X</button></p>`, Options{Profile: Compact}, "structure", false},
	}
	for _, c := range cases {
		got := kinds(s.Validate(c.src, c.opt))
		switch {
		case c.wantAny && got == "":
			t.Errorf("%s: expected a violation, got none", c.name)
		case !c.wantAny && got != c.want:
			t.Errorf("%s:\n  src  %s\n  got  %q\n  want %q\n  %v", c.name, c.src, got, c.want, s.Validate(c.src, c.opt))
		}
	}
}

type manifestCase struct {
	File     string    `json:"file"`
	Expect   string    `json:"expect"`
	Profiles []Profile `json:"profiles"`
	Widgets  bool      `json:"widgets"`
	Kinds    []string  `json:"kinds"`
}

func TestConformanceManifest(t *testing.T) {
	s := load(t)
	root := filepath.Join("..", "conformance")
	raw, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Cases []manifestCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, c := range m.Cases {
		listed[c.File] = true
		b, err := os.ReadFile(filepath.Join(root, "cases", c.File))
		if err != nil {
			t.Errorf("manifest lists %s: %v", c.File, err)
			continue
		}
		src := string(b)
		for _, p := range []Profile{Strict, Compact} {
			vs := s.Validate(src, Options{Profile: p, Widgets: c.Widgets})
			want := c.Expect == "valid" && slices.Contains(c.Profiles, p)
			if want && len(vs) > 0 {
				t.Errorf("%s should be valid in %s: %v", c.File, p, vs)
			}
			if !want && len(vs) == 0 {
				t.Errorf("%s should be invalid in %s", c.File, p)
			}
		}
		if c.Widgets && len(s.Validate(src, Options{})) == 0 {
			t.Errorf("%s should be rejected when widgets are off", c.File)
		}
		if c.Expect == "invalid" {
			got := kindSet(s.Validate(src, Options{Profile: Strict}))
			if !slices.Equal(got, c.Kinds) {
				t.Errorf("%s: kinds %v, manifest says %v", c.File, got, c.Kinds)
			}
		}
	}
	files, _ := filepath.Glob(filepath.Join(root, "cases", "*", "*.html"))
	for _, f := range files {
		rel, _ := filepath.Rel(filepath.Join(root, "cases"), f)
		if !listed[filepath.ToSlash(rel)] {
			t.Errorf("%s exists but is not in the manifest", rel)
		}
	}
	if len(files) != len(m.Cases) {
		t.Errorf("%d case files, %d manifest entries", len(files), len(m.Cases))
	}
}

func TestSubsetDefinitionIsConsistent(t *testing.T) {
	s := load(t)
	for _, el := range s.OptionalEnd {
		if !s.known[el] {
			t.Errorf("optionalEnd names an unknown element %q", el)
		}
	}
	for key, kids := range s.Content {
		for _, k := range kids {
			if strings.HasPrefix(k, "#") || strings.HasPrefix(k, "@") {
				continue
			}
			if !s.known[k] {
				t.Errorf("content[%s] allows unknown element %q", key, k)
			}
		}
	}
	for el := range s.Attributes {
		if !s.known[el] {
			t.Errorf("attributes for unknown element %q", el)
		}
	}
}

// Every answer the grammars produced on the live model must pass the validator. This is the
// check that "valid" means "the grammar accepts it": a failure means either the validator is
// stricter than the grammar, or the grammar is looser than the spec.
func TestValidatorAgreesWithGrammarOutput(t *testing.T) {
	s := load(t)
	f, err := os.Open(filepath.Join("..", "corpus", "grammar-runs.jsonl"))
	if err != nil {
		t.Skip("no corpus")
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	checked, bad := 0, 0
	for dec.More() {
		var r struct {
			Arm, Profile, Stop, HTML string
			Prompt                   int
		}
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		if r.Stop == "limit" {
			continue // cut off mid-answer, so it cannot be complete
		}
		checked++
		if vs := s.Validate(r.HTML, Options{Profile: Profile(r.Profile)}); len(vs) > 0 {
			bad++
			if bad <= 5 {
				t.Errorf("arm %s prompt %d (%s profile) rejected: %v\n  %.160q", r.Arm, r.Prompt, r.Profile, vs[:min(3, len(vs))], r.HTML)
			}
		}
	}
	t.Logf("%d grammar-produced answers checked, %d rejected", checked, bad)
	if checked < 50 {
		t.Errorf("only %d answers checked", checked)
	}
}

// The prose spec must name every element, so it cannot quietly fall behind subset.json.
func TestSpecTextMentionsEveryElement(t *testing.T) {
	s := load(t)
	b, err := os.ReadFile("SPEC.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b)
	for _, el := range s.Elements() {
		if !strings.Contains(doc, "`<"+el+">`") && !strings.Contains(doc, "<"+el+" ") && !strings.Contains(doc, "<"+el+">") {
			t.Errorf("SPEC.md never mentions <%s>", el)
		}
	}
}

// The generated grammars must use exactly the elements and attributes the subset defines.
func TestGrammarMatchesSubset(t *testing.T) {
	s := load(t)
	elRe := regexp.MustCompile(`</?([a-z][a-z0-9]*)`)
	attrRe := regexp.MustCompile(`\s([a-z-]+)=\\"`)
	for _, name := range []string{"strict.gbnf", "compact.gbnf"} {
		b, err := os.ReadFile(filepath.Join("..", "grammar", name))
		if err != nil {
			t.Fatal(err)
		}
		els, attrs := map[string]bool{}, map[string]bool{}
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				continue
			}
			for _, m := range elRe.FindAllStringSubmatch(line, -1) {
				els[m[1]] = true
			}
			for _, m := range attrRe.FindAllStringSubmatch(line, -1) {
				attrs[m[1]] = true
			}
		}
		want := map[string]bool{}
		for _, e := range s.Elements() {
			want[e] = true
		}
		for e := range els {
			if !want[e] {
				t.Errorf("%s uses <%s>, which the subset does not define", name, e)
			}
		}
		for e := range want {
			if !els[e] {
				t.Errorf("%s never produces <%s>, which the subset defines", name, e)
			}
		}
		defined := map[string]bool{}
		for el, as := range s.Attributes {
			if el == "template" {
				continue // widgets have their own grammar section
			}
			for a := range as {
				defined[a] = true
			}
		}
		for a := range attrs {
			if !defined[a] {
				t.Errorf("%s uses attribute %q, which the subset does not define", name, a)
			}
		}
		for a := range defined {
			if !attrs[a] {
				t.Errorf("%s never produces attribute %q, which the subset defines", name, a)
			}
		}
	}
}

func TestInputEndingMidTagIsInvalid(t *testing.T) {
	sub := load(t)
	for _, src := range []string{"<p>text <img src='https://evil.example/?d=", "<p>ok</p><a href=\"https://x", "<p>ok</p><"} {
		for _, prof := range []Profile{Strict, Compact} {
			if vs := sub.Validate(src, Options{Profile: prof}); len(vs) == 0 {
				t.Errorf("%s accepted %q", prof, src)
			}
		}
	}
}
