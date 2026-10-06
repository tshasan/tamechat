# html-answers

A small, safe subset of HTML as the format a language model answers in, so one page can show answers from any model or backend, and the answer is readable in any browser with no client code at all.

```
any OpenAI-compatible backend  →  cmd/serve (adds the system prompt, streams SSE)  →  the page (renders it, safely)
llama.cpp · Ollama · vLLM · hosted API                                                web/ (about 430 lines of JS, no dependencies)
```

This is a proof of concept. [Findings](findings/README.md) says what was measured and, just as important, what was not.

## Try it

You need Go 1.22+ and a backend that speaks the OpenAI chat API.

```sh
# a local llama.cpp server, with a grammar that guarantees the subset
go run ./cmd/serve -backend http://127.0.0.1:8081/v1 -model <id> -grammar grammar/compact.gbnf -profile compact

# Ollama
go run ./cmd/serve -backend http://127.0.0.1:11434/v1 -model llama3.2

# a hosted API: no grammar available, so the page's sanitizer is the safety layer
OPENAI_API_KEY=... go run ./cmd/serve -backend https://api.openai.com/v1 -model <id> -key-env OPENAI_API_KEY
```

Open http://127.0.0.1:8090/. Switching backends is the flags above and nothing else. Backend-specific options (turning thinking off on llama.cpp, say) go in `-extra '{"chat_template_kwargs":{"enable_thinking":false}}'`.

The page shows each answer rendered, as its HTML source, or restyled by any of five classless stylesheets: the same answer in Simple, Water, Pico, MVP and Sakura, because it is plain semantic HTML.

## What is in here

| | |
|---|---|
| `spec/` | The subset on one page ([SPEC.md](spec/SPEC.md)), as data (`subset.json`), plus a Go validator. Everything else is generated from it or tested against it. |
| `grammar/` | GBNF grammars for llama.cpp, generated: `strict`, and `compact` (which accepts both). |
| `conformance/` | Documents that must be accepted, rejected, or are valid only in the compact profile. |
| `cmd/conform` | `check` a file, or `sample` any backend and report how many of its answers conform. |
| `cmd/tokencost` | Measures what a profile costs in tokens, with the model's own tokenizer. |
| `cmd/serve`, `web/` | The demo server and page. |

## Test your model

```sh
go run ./cmd/conform sample -backend http://127.0.0.1:11434/v1 -model llama3.2
```

It sends twelve prompts with the subset's system prompt and prints how many answers were valid as emitted, which rules the rest broke, and how many were wrapped in a Markdown code fence (a common hosted-model habit that shows up as literal backticks on the page). Paste the table row it prints into an issue.

## What we found

- **Compact HTML is 15% cheaper than strict HTML on identical content** (measured). Matching Markdown's token cost needs a tokenizer that treats about 30 tags as single tokens, which is a projection (0.98×), not a result.
- **A grammar that forbids the token a model wants makes it stop early.** Banning the newline between blocks cut the median answer from 452 to 45 tokens.
- **Rendering and sanitizing take 8 KB of code with no dependencies** (3 KB gzipped), against about 69 KB for a Markdown parser plus a sanitizer.

## Prior work

This is not the first attempt at letting models drive a UI, and it makes different trade-offs. Declarative specs such as [A2UI](https://docs.ag-ui.com/concepts/generative-ui-specs) (Google) and Open-JSON-UI (OpenAI) describe components as JSON, which suits native clients but needs a renderer per platform. MCP-UI embeds HTML in sandboxed iframes, which is the closest relative. The question of HTML against Markdown as a model output format has also been argued in public, with token cost, injection risk and noisy diffs as the objections. This project is a web-only answer to those objections with the costs measured.

Where it loses: native iOS, Android and desktop clients, where JSON component schemas are the better fit; and tokens, where Markdown is cheaper today.

## Develop

```sh
go test ./...                       # validator, grammar and spec drift guards, server, tools
node --test web/scanner.test.js     # the streaming block scanner
python3 grammar/make_grammar.py     # regenerate the grammars (the output is committed)
```

An end-to-end browser test (a fake streaming backend, including a document with omitted end tags and a hostile one) lives in `test/e2e/`; its header says how to run it. It needs Playwright, which is the only thing in this repository that needs npm.

Licence: MIT. Vendored stylesheets are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
