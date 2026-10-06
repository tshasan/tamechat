// Package md converts answers in the HTML subset to Markdown, to estimate what the same
// content would have cost in that format.
//
// ToMarkdown renders an answer in the HTML subset as the Markdown a model would
// most plausibly have written for the same content. It exists to answer one
// question with a number: what does emitting HTML cost in tokens compared with
// Markdown? The result is an estimate (there is no single canonical Markdown for a
// table with a caption or a tip callout), so it is reported as one, but the choices
// below are the common ones: ATX headings, "-" bullets, fenced code, pipe tables,
// blockquote callouts with a bold label.
//
// Widgets (<template data-widget>) are dropped: they have no Markdown equivalent.
package md

import (
	"fmt"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// ToMarkdown converts a document in the subset to Markdown (see the package comment).
func ToMarkdown(src string) string {
	body := &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: "body"}
	nodes, err := html.ParseFragment(strings.NewReader(src), body)
	if err != nil {
		return ""
	}
	return strings.Join(blocks(nodes), "\n\n")
}

func blocks(nodes []*html.Node) []string {
	var out []string
	for _, n := range nodes {
		if s := block(n); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func children(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, c)
	}
	return out
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func block(n *html.Node) string {
	if n.Type == html.TextNode {
		return strings.TrimSpace(collapse(n.Data))
	}
	if n.Type != html.ElementNode {
		return ""
	}
	switch n.Data {
	case "template":
		return "" // a widget
	case "p":
		return strings.TrimSpace(inlineOf(n))
	case "h2", "h3", "h4":
		return strings.Repeat("#", int(n.Data[1]-'0')) + " " + strings.TrimSpace(inlineOf(n))
	case "ul", "ol":
		return list(n, 0)
	case "menu":
		var lines []string
		for _, li := range children(n) {
			if li.Type == html.ElementNode && li.Data == "li" {
				lines = append(lines, "- "+strings.TrimSpace(inlineOf(li)))
			}
		}
		return strings.Join(lines, "\n")
	case "blockquote":
		return quote(strings.Join(blocks(children(n)), "\n\n"))
	case "pre":
		lang := ""
		code := n
		for _, c := range children(n) {
			if c.Type == html.ElementNode && c.Data == "code" {
				code = c
				lang = strings.TrimPrefix(attr(c, "class"), "language-")
			}
		}
		return "```" + lang + "\n" + strings.TrimRight(textOf(code), "\n") + "\n```"
	case "hr":
		return "---"
	case "table":
		return table(n)
	case "details":
		var parts []string
		for _, c := range children(n) {
			if c.Type == html.ElementNode && c.Data == "summary" {
				parts = append([]string{"**" + strings.TrimSpace(inlineOf(c)) + "**"}, parts...)
			} else if s := block(c); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n\n")
	case "dl":
		var lines []string
		for _, c := range children(n) {
			if c.Type != html.ElementNode {
				continue
			}
			if c.Data == "dt" {
				lines = append(lines, "**"+strings.TrimSpace(inlineOf(c))+"**")
			} else if c.Data == "dd" {
				lines = append(lines, ": "+strings.TrimSpace(inlineOf(c)))
			}
		}
		return strings.Join(lines, "\n")
	case "aside":
		label := map[string]string{"note": "Note", "tip": "Tip", "warn": "Warning"}[attr(n, "class")]
		if label == "" {
			label = "Note"
		}
		return quote("**" + label + ":** " + strings.Join(blocks(children(n)), "\n\n"))
	}
	return strings.TrimSpace(inlineOf(n))
}

func list(n *html.Node, depth int) string {
	var lines []string
	i := 0
	for _, li := range children(n) {
		if li.Type != html.ElementNode || li.Data != "li" {
			continue
		}
		i++
		marker := "- "
		if n.Data == "ol" {
			marker = fmt.Sprintf("%d. ", i)
		}
		var text strings.Builder
		var nested []string
		for _, c := range children(li) {
			if c.Type == html.ElementNode && (c.Data == "ul" || c.Data == "ol") {
				nested = append(nested, list(c, depth+1))
			} else {
				text.WriteString(inlineNode(c))
			}
		}
		pad := strings.Repeat("  ", depth)
		lines = append(lines, pad+marker+strings.TrimSpace(text.String()))
		lines = append(lines, nested...)
	}
	return strings.Join(lines, "\n")
}

func table(n *html.Node) string {
	var caption string
	var rows [][]string
	headerRows := 0
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		for _, c := range children(x) {
			if c.Type != html.ElementNode {
				continue
			}
			switch c.Data {
			case "caption":
				caption = strings.TrimSpace(inlineOf(c))
			case "thead", "tbody", "tfoot":
				walk(c)
			case "tr":
				var cells []string
				isHead := false
				for _, cell := range children(c) {
					if cell.Type == html.ElementNode && (cell.Data == "th" || cell.Data == "td") {
						isHead = isHead || cell.Data == "th"
						cells = append(cells, strings.ReplaceAll(strings.TrimSpace(inlineOf(cell)), "|", "\\|"))
					}
				}
				if len(rows) == headerRows && isHead {
					headerRows++
				}
				rows = append(rows, cells)
			}
		}
	}
	walk(n)
	if len(rows) == 0 {
		return caption
	}
	var b strings.Builder
	if caption != "" {
		b.WriteString("**" + caption + "**\n\n")
	}
	line := func(cells []string) string { return "| " + strings.Join(cells, " | ") + " |" }
	b.WriteString(line(rows[0]) + "\n")
	sep := make([]string, len(rows[0]))
	for i := range sep {
		sep[i] = "---"
	}
	b.WriteString(line(sep))
	for _, r := range rows[1:] {
		b.WriteString("\n" + line(r))
	}
	return b.String()
}

func quote(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight("> "+l, " ")
	}
	return strings.Join(lines, "\n")
}

// inlineOf renders an element's children as inline Markdown.
func inlineOf(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(inlineNode(c))
	}
	return b.String()
}

// inlineNode renders one node (and its descendants) as inline Markdown.
func inlineNode(c *html.Node) string {
	switch c.Type {
	case html.TextNode:
		return collapse(c.Data)
	case html.ElementNode:
		inner := inlineOf(c)
		switch c.Data {
		case "strong":
			return "**" + inner + "**"
		case "em":
			return "*" + inner + "*"
		case "code", "kbd":
			return "`" + inner + "`"
		case "del":
			return "~~" + inner + "~~"
		case "a":
			if href := attr(c, "href"); href != "" {
				return "[" + inner + "](" + href + ")"
			}
			return inner
		case "br":
			return "\n"
		}
		return inner // mark, small, abbr, sub, sup, button: just their text
	}
	return ""
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// collapse folds runs of whitespace (HTML ignores them) into single spaces, keeping
// one at either end so words stay apart from a neighbouring <strong> or <code>.
func collapse(s string) string {
	t := strings.Join(strings.Fields(s), " ")
	if t == "" {
		if s != "" {
			return " "
		}
		return ""
	}
	if strings.ContainsRune(" \t\r\n", rune(s[0])) {
		t = " " + t
	}
	if strings.ContainsRune(" \t\r\n", rune(s[len(s)-1])) {
		t += " "
	}
	return t
}
