// Command tokencost measures what the answer format costs in tokens, with the model's own tokenizer.
//
//	go run ./cmd/tokencost -llama http://127.0.0.1:8081 [-model NAME] [-corpus corpus/answers-qwen3.6-35b.json]
//
// It reports the same documents three ways. Strict and compact are MEASURED: the compact form is
// checked, per document, to be valid compact HTML that means the same thing (it converts to the
// same Markdown), so the difference is a saving on identical content. The single-token lines are
// PROJECTIONS: they assume a tokenizer that gives each listed tag one token, which no shipping
// tokenizer does. They show what a tokenizer change could be worth, not what it has delivered.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"tamechat/internal/compact"
	"tamechat/internal/md"
	"tamechat/internal/tokens"
	"tamechat/spec"
)

var tagRe = regexp.MustCompile(`</?[a-zA-Z][a-zA-Z0-9]*[^<>]*>`)

func main() {
	llama := flag.String("llama", "http://127.0.0.1:8081", "llama-server (or router) base URL")
	model := flag.String("model", "", "model id (router mode)")
	corpus := flag.String("corpus", "corpus/answers-qwen3.6-35b.json", "JSON array of answers in the strict profile")
	vocabPath := flag.String("vocab", "spec/token-vocab.txt", "single-token tag forms to project with")
	verbose := flag.Bool("v", false, "one line per answer")
	flag.Parse()

	sub, err := spec.Load()
	check(err)
	raw, err := os.ReadFile(*corpus)
	check(err)
	var answers []string
	check(json.Unmarshal(raw, &answers))
	vocab := readVocab(*vocabPath)
	tk := &tokens.Client{BaseURL: *llama, Model: *model}
	ctx := context.Background()

	var strict, compactT, mdT, projVocab, projAll, used, skipped int
	for i, a := range answers {
		if vs := sub.Validate(a, spec.Options{Profile: spec.Strict}); len(vs) > 0 {
			skipped++
			fmt.Fprintf(os.Stderr, "skipping answer %d: not valid strict HTML (%v)\n", i, vs[0])
			continue
		}
		c := compact.Compact(sub, a)
		if vs := sub.Validate(c, spec.Options{Profile: spec.Compact}); len(vs) > 0 || md.ToMarkdown(a) != md.ToMarkdown(c) {
			skipped++
			fmt.Fprintf(os.Stderr, "skipping answer %d: the compact form is not the same document\n", i)
			continue
		}
		sSpans, err := tk.Tokenize(ctx, a)
		check(err)
		cSpans, err := tk.Tokenize(ctx, c)
		check(err)
		mN, err := tk.Count(ctx, md.ToMarkdown(a))
		check(err)
		pv, pa := project(c, cSpans, vocab), project(c, cSpans, nil)
		strict, compactT, mdT, projVocab, projAll, used = strict+len(sSpans), compactT+len(cSpans), mdT+mN, projVocab+pv, projAll+pa, used+1
		if *verbose {
			fmt.Printf("answer %2d: strict %4d  compact %4d  one-token tags %4d  markdown %4d\n", i, len(sSpans), len(cSpans), pv, mN)
		}
	}
	if used == 0 {
		fmt.Fprintln(os.Stderr, "no answer could be measured")
		os.Exit(1)
	}
	row := func(label, status string, n int) {
		fmt.Printf("  %-46s %-10s %6d tokens  %5.2fx Markdown  %+4.0f%% vs strict\n", label, status, n,
			float64(n)/float64(mdT), 100*float64(n-strict)/float64(strict))
	}
	fmt.Printf("%d answers measured (%d skipped), tokenizer: %s\n\n", used, skipped, *llama)
	fmt.Printf("  %-46s %-10s %6d tokens  %5.2fx Markdown\n", "Markdown (estimate of the same content)", "estimate", mdT, 1.0)
	row("strict HTML, as generated", "measured", strict)
	row("compact HTML (same documents, checked)", "measured", compactT)
	row(fmt.Sprintf("compact + single-token tags (%d listed forms)", len(vocab)), "PROJECTED", projVocab)
	row("compact + every tag a single token (upper bound)", "PROJECTED", projAll)
	fmt.Println("\nMeasured lines use this tokenizer on real text. PROJECTED lines assume a tokenizer that does not exist yet.")
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func readVocab(path string) []string {
	b, err := os.ReadFile(path)
	check(err)
	var v []string
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "#") {
			v = append(v, l)
		}
	}
	sort.Slice(v, func(i, j int) bool { return len(v[i]) > len(v[j]) }) // longest match first
	return v
}

// project counts the tokens a document would cost if each listed tag form were one token.
// vocab == nil means every tag is one token. A token that straddles two tags (the tokenizer merges
// "></" into one) is credited to the first tag only, so nothing is counted twice.
func project(doc string, spans []tokens.Span, vocab []string) int {
	total := len(spans)
	claimed := make([]bool, len(spans))
	for _, loc := range tagRe.FindAllStringIndex(doc, -1) {
		start, end := loc[0], loc[1]
		if vocab != nil {
			tag := doc[start:end]
			end = -1
			for _, e := range vocab {
				if tag == e || (strings.HasSuffix(e, `"`) || strings.HasSuffix(e, "-")) && strings.HasPrefix(tag, e) {
					end = start + len(e)
					break
				}
			}
			if end < 0 {
				continue
			}
		}
		n := 0
		for i, s := range spans {
			if s.End > start && s.Start < end && !claimed[i] {
				claimed[i] = true
				n++
			}
		}
		if n > 1 {
			total -= n - 1
		}
	}
	return total
}
