// Package spec holds the definition of the HTML subset, and a validator for it.
//
// subset.json is the single source of truth. The validator embeds it, the server serves
// it to the page (which builds its sanitizer from it), and a test checks the generated
// grammar against it, so the three cannot drift apart.
package spec

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed subset.json
var subsetJSON []byte

//go:embed system-prompt-strict.txt
var promptStrict string

//go:embed system-prompt-compact.txt
var promptCompact string

// Profile is how an answer is written. Both profiles mean the same document.
//
//	Strict   every end tag written, as today's grammar produces
//	Compact  the nine optional end tags may be left out, and attributes the page can
//	         supply (role, type) may be left off. Fewer tokens, same document.
type Profile string

const (
	Strict  Profile = "strict"
	Compact Profile = "compact"
)

// Subset is subset.json, parsed and compiled.
type Subset struct {
	Version     string                         `json:"version"`
	Categories  map[string][]string            `json:"categories"`
	Void        []string                       `json:"void"`
	OptionalEnd []string                       `json:"optionalEnd"`
	Content     map[string][]string            `json:"content"`
	Attributes  map[string]map[string]string   `json:"attributes"`
	Required    map[string]map[string][]string `json:"required"`
	Implied     map[string]map[string]string   `json:"implied"`

	attrRe  map[string]map[string]*regexp.Regexp
	void    map[string]bool
	optEnd  map[string]bool
	allowed map[string]map[string]bool // content key -> permitted children, "#text" included
	known   map[string]bool
	phrase  map[string]bool
	block   map[string]bool
}

// Load parses the embedded subset.json.
func Load() (*Subset, error) { return Parse(subsetJSON) }

// Parse compiles a subset definition.
func Parse(data []byte) (*Subset, error) {
	var s Subset
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	set := func(xs []string) map[string]bool {
		m := map[string]bool{}
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	s.void, s.optEnd = set(s.Void), set(s.OptionalEnd)
	s.block, s.phrase = set(s.Categories["block"]), set(s.Categories["phrasing"])
	s.known = map[string]bool{"template": true}
	for k := range s.Content {
		s.known[k[strings.LastIndex(k, ">")+1:]] = true
	}
	for _, xs := range [][]string{s.Void, s.Categories["block"], s.Categories["phrasing"]} {
		for _, x := range xs {
			s.known[x] = true
		}
	}
	delete(s.known, "#root")
	s.allowed = map[string]map[string]bool{}
	for k, kids := range s.Content {
		m := map[string]bool{}
		for _, c := range kids {
			switch c {
			case "@block":
				for b := range s.block {
					m[b] = true
				}
				m["template"] = true // a widget is a block
			case "@phrasing":
				for p := range s.phrase {
					m[p] = true
				}
			default:
				m[c] = true
			}
		}
		s.allowed[k] = m
	}
	s.attrRe = map[string]map[string]*regexp.Regexp{}
	for el, attrs := range s.Attributes {
		s.attrRe[el] = map[string]*regexp.Regexp{}
		for a, pat := range attrs {
			re, err := regexp.Compile(pat)
			if err != nil {
				return nil, fmt.Errorf("attribute %s.%s: %w", el, a, err)
			}
			s.attrRe[el][a] = re
		}
	}
	return &s, nil
}

// JSON returns the definition as embedded, for serving to the page.
func JSON() []byte { return subsetJSON }

// SystemPrompt is the system prompt that teaches a model the profile.
func SystemPrompt(p Profile) string {
	if p == Compact {
		return strings.TrimSpace(promptCompact)
	}
	return strings.TrimSpace(promptStrict)
}

// IsOptionalEnd reports whether an element's end tag may be omitted in the compact profile.
func (s *Subset) IsOptionalEnd(name string) bool { return s.optEnd[name] }

// Elements lists every element the subset allows, widgets aside.
func (s *Subset) Elements() []string {
	var out []string
	for k := range s.known {
		if k != "template" {
			out = append(out, k)
		}
	}
	return out
}

// IsPhrasing reports whether an element is inline (text-level) content.
func (s *Subset) IsPhrasing(name string) bool { return s.phrase[name] }
