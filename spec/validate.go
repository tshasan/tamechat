package spec

import (
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// Options selects what counts as valid.
type Options struct {
	Profile Profile // Strict (the default) or Compact
	Widgets bool    // allow <template data-widget> blocks
}

// Violation is one way a document breaks the subset.
type Violation struct {
	Kind   string // element, attribute, value, href, missing, structure, text, end-tag, unbalanced, empty-code, widget, comment
	Detail string
}

func (v Violation) String() string { return v.Kind + ": " + v.Detail }

// htmlVoid are HTML's own void elements, so an unknown <img> or <input> does not stay "open".
var htmlVoid = map[string]bool{"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true,
	"img": true, "input": true, "link": true, "meta": true, "source": true, "track": true, "wbr": true}

var entityRe = regexp.MustCompile(`&(amp|lt|gt|quot|apos|nbsp|#[0-9]{2,6});`)

type frame struct {
	name    string
	unknown bool // not part of the subset: report it once, then stay quiet about what is inside
	text    bool // has seen visible text (for the empty <code> rule)
}

// Validate checks a document against the subset. It reads the raw tag stream, not a parsed
// tree, so it sees what the model wrote: a browser's parser would silently repair or drop
// exactly the things worth reporting.
//
// It checks the element and attribute allowlist (with value patterns), where each element
// may appear (the content model), where text may appear, escaping, empty inline code, and
// end tags: in the strict profile every one must be written; in the compact profile only
// the optional ones (OptionalEnd) may be left out.
func (s *Subset) Validate(src string, o Options) []Violation {
	if o.Profile == "" {
		o.Profile = Strict
	}
	var vs []Violation
	add := func(kind, format string, a ...any) { vs = append(vs, Violation{kind, fmt.Sprintf(format, a...)}) }
	var stack []frame
	top := func() *frame {
		if len(stack) == 0 {
			return nil
		}
		return &stack[len(stack)-1]
	}
	// closeImplied pops an element whose end tag was not written.
	closeImplied := func() {
		f := stack[len(stack)-1]
		// A suggested-reply <li> is fixed markup: its end tag is always written.
		inMenu := f.name == "li" && len(stack) >= 2 && stack[len(stack)-2].name == "menu"
		if !f.unknown && (inMenu || !(o.Profile == Compact && s.optEnd[f.name])) {
			if s.optEnd[f.name] {
				add("end-tag", "</%s> is omitted; the strict profile requires it", f.name)
			} else {
				add("unbalanced", "<%s> is never closed", f.name)
			}
		}
		stack = stack[:len(stack)-1]
	}
	parentKey := func() (string, bool) { // content-model key for the current parent
		t := top()
		if t == nil {
			return "#root", true
		}
		if t.unknown {
			return "", false
		}
		if t.name == "li" && len(stack) >= 2 && stack[len(stack)-2].name == "menu" {
			return "menu>li", true
		}
		return t.name, true
	}

	z := html.NewTokenizer(strings.NewReader(src))
	widget := 0 // inside <template data-widget>: contents are sandboxed, not validated here
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.CommentToken:
			if widget == 0 {
				add("comment", "comments are not allowed")
			}
		case html.DoctypeToken:
			add("element", "a doctype is not part of an answer")
		case html.TextToken:
			if widget > 0 {
				continue
			}
			raw := string(z.Raw())
			bad := "<>&"
			if len(stack) >= 2 && stack[len(stack)-1].name == "code" && stack[len(stack)-2].name == "pre" {
				bad = "<&" // code blocks may contain a raw > (the grammar's pchar)
			}
			if strings.ContainsAny(entityRe.ReplaceAllString(raw, ""), bad) {
				add("text", "unescaped < > or & in text: %q", trim(raw))
			}
			if strings.TrimSpace(raw) == "" {
				continue
			}
			if t := top(); t != nil {
				t.text = true
			}
			if key, ok := parentKey(); ok && !s.allowed[key]["#text"] {
				if key == "#root" {
					add("text", "text must be inside an element: %q", trim(raw))
				} else {
					add("text", "text is not allowed directly inside <%s>: %q", strings.TrimPrefix(key, "menu>"), trim(raw))
				}
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			if widget > 0 {
				continue
			}
			nameB, hasAttr := z.TagName()
			name := string(nameB)
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[string(k)] = string(v)
			}
			if name == "template" {
				if _, ok := attrs["data-widget"]; !ok {
					add("element", "<template> is only allowed with data-widget")
					continue
				}
				if !o.Widgets {
					add("widget", "widgets are not allowed in this profile")
				}
				if key, ok := parentKey(); ok && !s.allowed[key]["template"] {
					add("structure", "a widget is not allowed inside <%s>", strings.TrimPrefix(key, "menu>"))
				}
				checkAttrs(s, "template", attrs, o, add)
				widget = 1
				continue
			}
			if !s.known[name] {
				add("element", "<%s> is not part of the subset", name)
				if tt == html.StartTagToken && !htmlVoid[name] {
					stack = append(stack, frame{name: name, unknown: true})
				}
				continue
			}
			// opening this element implicitly closes some open ones
			for len(stack) > 0 && !top().unknown && s.impliesClose(top().name, name) {
				closeImplied()
			}
			if key, ok := parentKey(); ok && !s.allowed[key][name] {
				add("structure", "<%s> is not allowed inside <%s>", name, strings.TrimPrefix(key, "menu>"))
			}
			checkAttrs(s, name, attrs, o, add)
			if tt == html.StartTagToken && !s.void[name] {
				stack = append(stack, frame{name: name})
			}
		case html.EndTagToken:
			nameB, _ := z.TagName()
			name := string(nameB)
			if widget > 0 {
				if name == "template" {
					widget = 0
				}
				continue
			}
			found := -1
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].name == name {
					found = i
					break
				}
			}
			if found < 0 {
				add("unbalanced", "stray </%s>", name)
				continue
			}
			for len(stack)-1 > found {
				f := stack[len(stack)-1]
				if f.unknown || (!s.optEnd[f.name]) {
					add("unbalanced", "</%s> arrives while <%s> is still open", name, f.name)
					stack = stack[:len(stack)-1]
					continue
				}
				closeImplied()
			}
			f := stack[len(stack)-1]
			if name == "code" && !f.text {
				add("empty-code", "<code> needs visible text")
			}
			stack = stack[:len(stack)-1]
		}
	}
	for len(stack) > 0 {
		closeImplied()
	}
	return vs
}

// impliesClose reports whether starting <next> ends an open <open> whose end tag was left out.
func (s *Subset) impliesClose(open, next string) bool {
	switch open {
	case "p":
		// HTML ends a paragraph only for these. Anything else that does not belong inside
		// a <p> (a <button>, say) stays inside it and is reported as misplaced.
		return s.block[next] || next == "li" || next == "dt" || next == "dd" || next == "caption" ||
			next == "thead" || next == "tbody" || next == "tr" || next == "td" || next == "th" || next == "summary"
	case "li":
		return next == "li"
	case "td", "th":
		return next == "td" || next == "th" || next == "tr" || next == "thead" || next == "tbody"
	case "tr":
		return next == "tr" || next == "thead" || next == "tbody"
	case "thead", "tbody":
		return next == "thead" || next == "tbody"
	case "dt", "dd":
		return next == "dt" || next == "dd"
	}
	return false
}

func checkAttrs(s *Subset, name string, attrs map[string]string, o Options, add func(string, string, ...any)) {
	for k, v := range attrs {
		re, ok := s.attrRe[name][k]
		switch {
		case !ok:
			add("attribute", "<%s %s> is not allowed", name, k)
		case !re.MatchString(v):
			kind := "value"
			if name == "a" && k == "href" {
				kind = "href"
			}
			add(kind, "<%s %s=%q> does not match %s", name, k, trim(v), s.Attributes[name][k])
		}
	}
	for _, req := range s.Required[string(o.Profile)][name] {
		if _, ok := attrs[req]; !ok {
			add("missing", "<%s> needs %s", name, req)
		}
	}
}

func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 48 {
		return s[:48] + "…"
	}
	return s
}
