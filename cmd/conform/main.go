// Command conform checks documents, and models, against the subset.
//
//	conform check [-profile strict|compact] [-widgets] FILE...     validate files ("-" reads stdin)
//	conform sample -backend URL -model NAME [flags]                ask a backend, then validate its answers
//
// "sample" is the portability test: it sends the same prompts to any OpenAI-compatible backend
// (llama.cpp, Ollama, vLLM, a hosted API) with the subset's system prompt, and reports how many
// answers are valid as emitted and which rules the rest break. Run it against your model and post
// the table row it prints.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"tamechat/corpus"

	"tamechat/spec"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "check":
		os.Exit(check(os.Args[2:]))
	case "sample":
		os.Exit(sample(os.Args[2:]))
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: conform check [-profile strict|compact] [-widgets] FILE...\n       conform sample -backend URL -model NAME [-profile ...] [-prompts FILE] [-n N] [-grammar FILE] [-key-env VAR] [-extra JSON]")
	os.Exit(2)
}

func mustSubset() *spec.Subset {
	s, err := spec.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return s
}

func check(args []string) int {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	profile := fs.String("profile", "strict", "strict or compact")
	widgets := fs.Bool("widgets", false, "allow <template data-widget> blocks")
	fs.Parse(args)
	if fs.NArg() == 0 {
		usage()
	}
	s := mustSubset()
	bad := 0
	for _, f := range fs.Args() {
		var b []byte
		var err error
		if f == "-" {
			b, err = io.ReadAll(os.Stdin)
		} else {
			b, err = os.ReadFile(f)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		vs := s.Validate(string(b), spec.Options{Profile: spec.Profile(*profile), Widgets: *widgets})
		if len(vs) == 0 {
			fmt.Printf("ok       %s\n", f)
			continue
		}
		bad++
		fmt.Printf("INVALID  %s\n", f)
		for _, v := range vs {
			fmt.Printf("           %s\n", v)
		}
	}
	if bad > 0 {
		return 1
	}
	return 0
}

type prompt struct {
	Q     string   `json:"q"`
	Needs []string `json:"needs"`
}

type result struct {
	violations []spec.Violation
	fenced     bool
	needs, got int
	tokens     int
	words      int
	length     bool // the backend stopped it for length: the answer is cut off
}

func sample(args []string) int {
	fs := flag.NewFlagSet("sample", flag.ExitOnError)
	backend := fs.String("backend", "http://127.0.0.1:8081/v1", "OpenAI-compatible base URL, ending in /v1")
	model := fs.String("model", "", "model id")
	keyEnv := fs.String("key-env", "", "environment variable holding the API key")
	profile := fs.String("profile", "strict", "strict or compact")
	prompts := fs.String("prompts", "", "JSON array of {q, needs} (default: the built-in prompts)")
	n := fs.Int("n", 1, "samples per prompt")
	grammar := fs.String("grammar", "", "GBNF file to send (llama.cpp only)")
	maxTokens := fs.Int("max-tokens", 900, "max_tokens per answer")
	temp := fs.Float64("temp", 0.7, "temperature")
	label := fs.String("label", "", "name for the report row (default: the model)")
	extra := fs.String("extra", "", "JSON object merged into the request body, for backend-specific options")
	verbose := fs.Bool("v", false, "one line per answer")
	fs.Parse(args)

	s := mustSubset()
	raw := corpus.Prompts
	if *prompts != "" {
		var err error
		if raw, err = os.ReadFile(*prompts); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	var ps []prompt
	if err := json.Unmarshal(raw, &ps); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	key := ""
	if *keyEnv != "" {
		if key = os.Getenv(*keyEnv); key == "" {
			fmt.Fprintf(os.Stderr, "%s is empty\n", *keyEnv)
			return 1
		}
	}
	g := ""
	if *grammar != "" {
		b, err := os.ReadFile(*grammar)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		g = string(b)
	}
	var extraBody map[string]any
	if *extra != "" {
		if err := json.Unmarshal([]byte(*extra), &extraBody); err != nil {
			fmt.Fprintln(os.Stderr, "-extra must be a JSON object:", err)
			return 1
		}
	}
	c := &client{extra: extraBody, base: strings.TrimRight(*backend, "/"), model: *model, key: key, max: *maxTokens, temp: *temp, grammar: g,
		http: &http.Client{Timeout: 3 * time.Minute}}
	system := spec.SystemPrompt(spec.Profile(*profile))

	var rs []result
	for i, p := range ps {
		for k := 0; k < *n; k++ {
			content, finish, tokens, err := c.complete(system, p.Q)
			if err != nil {
				fmt.Fprintf(os.Stderr, "prompt %d: %v\n", i, err)
				return 1
			}
			r := evaluate(s, spec.Profile(*profile), content, p.Needs)
			r.tokens, r.length = tokens, finish == "length"
			rs = append(rs, r)
			if *verbose {
				fmt.Printf("prompt %2d: %-8s %4d tokens  %s\n", i, status(r), tokens, p.Q)
			}
		}
	}
	fmt.Println(report(rs, *label, *model, *profile, g != "", *backend))
	return 0
}

func status(r result) string {
	switch {
	case len(r.violations) == 0 && !r.fenced:
		return "valid"
	case r.fenced && len(r.violations) == 0:
		return "fenced"
	}
	return fmt.Sprintf("%d issues", len(r.violations))
}

var (
	fenceRe = regexp.MustCompile("(?s)^\\s*```[a-zA-Z]*\\s*\n(.*?)\n?```\\s*$")
	stripRe = regexp.MustCompile(`<[^>]*>`)
)

// evaluate validates one answer. A hosted model often wraps its HTML in a Markdown code fence,
// which would show up as literal backticks on the page, so that is counted on its own and the
// fence is removed so the rest of the answer is still judged.
func evaluate(s *spec.Subset, p spec.Profile, content string, needs []string) result {
	var r result
	if m := fenceRe.FindStringSubmatch(content); m != nil {
		r.fenced = true
		content = m[1]
	}
	r.violations = s.Validate(content, spec.Options{Profile: p, Widgets: true})
	r.words = len(strings.Fields(stripRe.ReplaceAllString(content, " ")))
	r.needs = len(needs)
	lc := strings.ToLower(content)
	for _, n := range needs {
		ok := false
		switch n {
		case "table":
			ok = strings.Contains(lc, "<table")
		case "code":
			ok = strings.Contains(lc, "<pre")
		case "callout":
			ok = strings.Contains(lc, "<aside")
		case "list":
			ok = strings.Contains(lc, "<ul") || strings.Contains(lc, "<ol") || strings.Contains(lc, "<dl")
		}
		if ok {
			r.got++
		}
	}
	return r
}

func report(rs []result, label, model, profile string, grammar bool, backend string) string {
	if label == "" {
		label = model
	}
	valid, fenced, cut, needs, got, tokens, words := 0, 0, 0, 0, 0, 0, 0
	kinds := map[string]int{}
	for _, r := range rs {
		if len(r.violations) == 0 && !r.fenced {
			valid++
		}
		if r.fenced {
			fenced++
		}
		if r.length {
			cut++
		}
		needs, got, tokens, words = needs+r.needs, got+r.got, tokens+r.tokens, words+r.words
		seen := map[string]bool{}
		for _, v := range r.violations {
			if !seen[v.Kind] {
				kinds[v.Kind]++
				seen[v.Kind] = true
			}
		}
	}
	var ks []string
	for k, n := range kinds {
		ks = append(ks, fmt.Sprintf("%s %d", k, n))
	}
	sort.Strings(ks)
	host := backend
	if u, err := url.Parse(backend); err == nil && u.Host != "" {
		host = u.Host
	}
	n := len(rs)
	var b strings.Builder
	fmt.Fprintf(&b, "\n%d answers from %s (%s), profile %s, grammar: %v\n\n", n, label, host, profile, grammar)
	fmt.Fprintf(&b, "  valid as emitted        %d/%d (%.0f%%)\n", valid, n, 100*float64(valid)/float64(n))
	fmt.Fprintf(&b, "  wrapped in a code fence %d/%d\n", fenced, n)
	fmt.Fprintf(&b, "  cut off by the limit    %d/%d\n", cut, n)
	fmt.Fprintf(&b, "  answers with violations by kind: %s\n", orNone(strings.Join(ks, ", ")))
	if needs > 0 {
		fmt.Fprintf(&b, "  asked-for element present %d/%d\n", got, needs)
	}
	if words > 0 {
		fmt.Fprintf(&b, "  completion tokens per word %.2f (the backend's own count; only comparable within one backend)\n", float64(tokens)/float64(words))
	}
	fmt.Fprintf(&b, "\n| backend | model | profile | grammar | answers | valid as emitted | fenced | cut off |\n|---|---|---|---|---|---|---|---|\n")
	fmt.Fprintf(&b, "| %s | %s | %s | %v | %d | %.0f%% | %d | %d |\n", host, label, profile, grammar, n, 100*float64(valid)/float64(n), fenced, cut)
	return b.String()
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

type client struct {
	base, model, key string
	max              int
	temp             float64
	grammar          string
	extra            map[string]any
	http             *http.Client
}

func (c *client) complete(system, user string) (content, finish string, tokens int, err error) {
	body := map[string]any{
		"model": c.model, "stream": false, "max_tokens": c.max, "temperature": c.temp,
		"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
	}
	if c.grammar != "" {
		body["grammar"] = c.grammar
	}
	for k, v := range c.extra {
		if _, taken := body[k]; !taken { // the options we set ourselves win
			body[k] = v
		}
	}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", c.base+"/chat/completions", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", "", 0, fmt.Errorf("backend answered %d: %.200s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message      struct{ Content string } `json:"message"`
			FinishReason string                   `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			Completion int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return "", "", 0, fmt.Errorf("unreadable response: %.200s", data)
	}
	return out.Choices[0].Message.Content, out.Choices[0].FinishReason, out.Usage.Completion, nil
}
