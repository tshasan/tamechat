# tamechat

**One chat page that shows answers from any model, safely, and keeps working with no client code at all.**

The model answers in a small, safe subset of HTML. Because the answer is already a web document, the page is a few hundred lines of JavaScript with no dependencies, the answer can be restyled with any classless stylesheet, and "Download .html" gives you a file that opens in any browser with JavaScript off. Nothing in it is tied to a vendor: any OpenAI-compatible backend works, and a model that does not support constrained decoding is covered by the sanitizer and a Content-Security-Policy instead.

```
any OpenAI-compatible backend  →  cmd/serve (adds the system prompt, streams SSE)  →  the page (renders it, safely)
llama.cpp · Ollama · vLLM · hosted API                                                web/ (about 530 lines of JS, comments included, no dependencies)
```

This is a proof of concept, so read [what was measured and what was not](findings/README.md) before believing any of it. Short version: the format is cheaper than it looks (15% on identical content, with a measured path to near-parity with Markdown that is a projection, not a result), and the safety layers survive a 32-document attack corpus one layer at a time. Whether people prefer it, and whether hosted models follow the subset, is **not shown yet**; the plan below says what would settle each.

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

The page shows each answer rendered, as its HTML source, or restyled by any of five classless stylesheets: the same answer in Simple, Water, Pico, MVP and Sakura, because it is plain semantic HTML. "Download .html" saves the conversation as one static file with the chosen theme and no script.

## What is in here

| | |
|---|---|
| `spec/` | The subset on one page ([SPEC.md](spec/SPEC.md)), as data (`subset.json`), plus a Go validator. Everything else is generated from it or tested against it. |
| `grammar/` | GBNF grammars for llama.cpp, generated: `strict`, and `compact` (which accepts both). |
| `conformance/` | A language-neutral suite: `manifest.json` lists every document, whether it must be accepted or rejected, and in which profile. 58 cases, 32 of them attacks. Another implementation can run the same suite. |
| `cmd/conform` | `check` a file, or `sample` any backend and report how many of its answers conform. |
| `cmd/tokencost` | Measures what a profile costs in tokens, with the model's own tokenizer. |
| `cmd/serve`, `web/` | The demo server and page. |

## Test your model

```sh
go run ./cmd/conform sample -backend http://127.0.0.1:11434/v1 -model llama3.2
```

It works from any directory (the twelve prompts are built in). It sends them with the subset's system prompt and prints how many answers were valid as emitted, which rules the rest broke, and how many were wrapped in a Markdown code fence (a common hosted-model habit that shows up as literal backticks on the page). Paste the table row it prints into an issue.

## What we found

- **Compact HTML is 15% cheaper than strict HTML on identical content** (measured). Matching Markdown's token cost needs a tokenizer that treats about 30 tags as single tokens, which is a projection (0.98×), not a result.
- **A grammar that forbids the token a model wants makes it stop early.** Banning the newline between blocks cut the median answer from 452 to 45 tokens.
- **Each safety layer holds alone against 32 attack documents** (validator, sanitizer, CSP, widget sandbox), and the test found two real bugs on the way.
- **Rendering and sanitizing take 8 KB of code with no dependencies** (3 KB gzipped), against about 69 KB for a Markdown parser plus a sanitizer.

## What would change the plan

Each of these is a result that would change what this project says, decided before looking:

| if | then |
|---|---|
| fewer than 90% of answers are valid as emitted on a hosted model, across three backends | stop claiming it works without a grammar; reposition around local and constrained backends |
| people shown the same answers as Markdown and as themed HTML do not prefer HTML | drop the UX claim; keep the portability and no-client-code claims |
| the red team finds a path to script execution through the sanitizer | fix it and publish the fix before anything else |
| a fine-tune on compact examples does not reduce tokens per word | drop the tokenizer argument; the case then rests on the platform, not on cost |

Open work, in order of how much it would move the argument: run `conform sample` against three hosted backends and publish the table; a small blind preference study; a fine-tune on compact answers.

## Prior work

This is not the first attempt at letting models drive a UI, and it makes different trade-offs. Declarative specs such as [A2UI](https://docs.ag-ui.com/concepts/generative-ui-specs) (Google) and Open-JSON-UI (OpenAI) describe components as JSON, which suits native clients but needs a renderer per platform. MCP-UI embeds HTML in sandboxed iframes, which is the closest relative. The question of HTML against Markdown as a model output format has also been argued in public, with token cost, injection risk and noisy diffs as the objections. This project is a web-only answer to those objections with the costs measured.

Where it loses: native iOS, Android and desktop clients, where JSON component schemas are the better fit; and tokens, where Markdown is cheaper today.

## Develop

```sh
go test ./...                       # validator, grammar and spec drift guards, server, tools
node --test web/scanner.test.js     # the streaming block scanner
python3 grammar/make_grammar.py     # regenerate the grammars (the output is committed)
```

Two browser tests need Playwright, the only thing here that needs npm: `test/e2e/` (a fake streaming backend, a document with omitted end tags, a hostile one, and the exported file opened with JavaScript off) and `test/redteam/` (each defence layer attacked alone; its header says how to run it).

Licence: MIT. Vendored stylesheets are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
