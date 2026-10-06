// Package compact rewrites an answer from the strict profile to the compact profile.
//
// The two profiles are the same document: the rewrite removes only what a browser puts back
// (whitespace between block tags, the nine optional end tags) and attributes the page supplies
// (scope, and the role and type the subset fixes). The tests prove it per document by comparing
// what each parses to, so token savings measured with this package are savings on identical content.
package compact

import (
	"regexp"
	"strings"

	"tamechat/spec"
)

var (
	tagRe     = regexp.MustCompile(`</?[a-zA-Z][a-zA-Z0-9]*[^<>]*>`)
	tagNameRe = regexp.MustCompile(`^<(/?)([a-zA-Z][a-zA-Z0-9]*)`)
	// attributes the page can supply, so a compact answer need not spell them
	droppedAttrs = regexp.MustCompile(` (scope="(?:col|row)"|role="note"|type="button")`)
)

type segment struct {
	text string
	name string // element name, "" for text
	end  bool
}

func split(s string) []segment {
	var out []segment
	pos := 0
	for _, l := range tagRe.FindAllStringIndex(s, -1) {
		if l[0] > pos {
			out = append(out, segment{text: s[pos:l[0]]})
		}
		m := tagNameRe.FindStringSubmatch(s[l[0]:l[1]])
		out = append(out, segment{text: s[l[0]:l[1]], name: strings.ToLower(m[2]), end: m[1] == "/"})
		pos = l[1]
	}
	if pos < len(s) {
		out = append(out, segment{text: s[pos:]})
	}
	return out
}

// Compact rewrites a strict-profile document in the compact profile.
func Compact(sub *spec.Subset, src string) string {
	seg := split(src)
	// Whitespace between two block-level tags renders as nothing; between inline tags it is a space.
	blockish := func(g segment) bool { return g.name != "" && !sub.IsPhrasing(g.name) && g.name != "button" }
	var b strings.Builder
	inMenu := false // </li> inside a <menu> is always written
	for i, g := range seg {
		if g.name == "menu" {
			inMenu = !g.end
		}
		switch {
		case g.end && g.name == "li" && inMenu:
			b.WriteString(g.text)
		case g.name == "" && strings.TrimSpace(g.text) == "" && i > 0 && i+1 < len(seg) &&
			blockish(seg[i-1]) && blockish(seg[i+1]):
			continue
		case g.end && sub.IsOptionalEnd(g.name):
			continue
		case g.name != "" && !g.end:
			b.WriteString(droppedAttrs.ReplaceAllString(g.text, ""))
		default:
			b.WriteString(g.text)
		}
	}
	return b.String()
}
