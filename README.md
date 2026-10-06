# tamechat

**Same chat UI, any model, safely. The answer is plain HTML, so it needs no client to read.**

Model vendors are starting to ship their own answer formats: artifacts, JSON component schemas, proprietary widgets. Each needs that vendor's renderer, which is a moat. HTML is what every browser, developer and model already speaks. tamechat restricts it and does not extend it: no custom elements, no invented attributes, so a valid answer is a valid HTML fragment and opens in any browser tab. "Download .html" saves a conversation as one file that works with JavaScript off.

```
any OpenAI-compatible backend → cmd/serve (system prompt, SSE) → web/ (renders safely, ~530 lines of JS, no dependencies)
```

Proof of concept. [Findings](findings/README.md) says what was measured and what was not.

## Run it

Go 1.22+ and an OpenAI-compatible backend:

```sh
# Ollama
go run ./cmd/serve -backend http://127.0.0.1:11434/v1 -model llama3.2

# llama.cpp, grammar-constrained
go run ./cmd/serve -backend http://127.0.0.1:8081/v1 -model <id> -grammar grammar/compact.gbnf -profile compact

# hosted: no grammar, so the sanitizer and CSP carry the safety
OPENAI_API_KEY=... go run ./cmd/serve -backend https://api.openai.com/v1 -model <id> -key-env OPENAI_API_KEY
```

Open http://127.0.0.1:8090/. Switch rendered/source view or one of five classless themes on the same answer. Backend options go in `-extra '{"chat_template_kwargs":{"enable_thinking":false}}'`.

## Test your model

```sh
go run ./cmd/conform sample -backend http://127.0.0.1:11434/v1 -model llama3.2
go run ./cmd/conform check [-profile compact] answer.html
```

`sample` sends 12 built-in prompts and reports how many answers were valid as emitted and which rules the rest broke.

## The standard is the test suite

`conformance/manifest.json` lists 58 documents (32 attacks) with the expected verdict per profile. An implementation in any language can run it. Prose spec: [spec/SPEC.md](spec/SPEC.md), generated from `spec/subset.json`.

## What holds, what does not

| | |
|---|---|
| Safety | Validator, sanitizer, CSP and widget sandbox, each attacked alone in a browser with 32 attack documents. The sanitizer mirrors the grammar, so those two fail together; CSP and sandbox are independent. [Details](findings/README.md). |
| Cost | Markdown is cheaper per word today (HTML about 1.4×). Compact HTML is 15% cheaper than strict on identical content. This project does not claim to be cheaper. |
| Hosted models | Not tested. Only a local model and a fake backend. |
| User preference | Not tested. |

## Falsifiers

| if | then |
|---|---|
| under 90% valid as emitted on hosted models, across three backends | stop claiming it works without a grammar |
| people do not prefer themed HTML to Markdown | drop the UX claim, keep portability |
| red team finds script execution through the sanitizer | fix and publish first |
| a fine-tune on compact answers does not cut tokens per word | drop the tokenizer argument |

## Layout

`spec/` subset and validator · `grammar/` generated GBNF · `conformance/` the suite · `cmd/conform` · `cmd/tokencost` · `cmd/serve` + `web/` demo · `test/e2e`, `test/redteam` (Playwright) · `findings/`

```sh
go test ./...
node --test web/scanner.test.js
python3 grammar/make_grammar.py   # regenerate grammars
```

Related: A2UI and Open-JSON-UI describe UI as JSON and need a renderer per platform; MCP-UI embeds sandboxed HTML and is the closest relative. This loses on native clients and on token cost.

MIT. Vendored stylesheets: [THIRD_PARTY.md](THIRD_PARTY.md).
