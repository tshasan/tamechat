# tamechat

**Same chat UI, any model, safely. The answer is plain HTML, so it needs no client to read.**

Model vendors are starting to ship their own answer formats: artifacts, JSON component schemas, proprietary widgets. Each needs that vendor's renderer, which is a moat. HTML is what every browser, developer and model already speaks. tamechat restricts it and does not extend it: no custom elements, no invented attributes, so a valid answer is a valid HTML fragment and opens in any browser tab. "Download .html" saves a conversation as one file that works with JavaScript off.

```
any OpenAI-compatible backend → server (Vercel AI SDK, system prompt, SSE) → web/ (renders safely, ~470 lines of TypeScript, no runtime dependencies)
```

Proof of concept. [Findings](findings/README.md) says what was measured and what was not.

## Run it

Bun 1.2+ and an OpenAI-compatible backend:

```sh
bun install

# Ollama
bun start --backend http://127.0.0.1:11434/v1 --model llama3.2

# llama.cpp, grammar-constrained
bun start --backend http://127.0.0.1:8081/v1 --model <id> --grammar grammar/compact.gbnf --profile compact

# hosted: no grammar, so the sanitizer and CSP carry the safety
OPENAI_API_KEY=... bun start --backend https://api.openai.com/v1 --model <id> --key-env OPENAI_API_KEY
```

Open http://127.0.0.1:8090/. Switch between rendered and source view. Backend options go in `--extra '{"chat_template_kwargs":{"enable_thinking":false}}'`.

## Test your model

```sh
bun run conform sample --backend http://127.0.0.1:11434/v1 --model llama3.2
bun run conform check [--profile compact] answer.html
```

`sample` sends 12 built-in prompts and reports how many answers were valid as emitted and which rules the rest broke.

## The standard is the test suite

`conformance/manifest.json` lists 58 documents (32 attacks) with the expected verdict per profile. An implementation in any language can run it. Prose spec: [spec/SPEC.md](spec/SPEC.md), checked against `spec/subset.json` by a test.

## What holds, what does not

| | |
|---|---|
| Safety | Validator, sanitizer, CSP and widget sandbox, each attacked alone in a browser with 32 attack documents. The sanitizer mirrors the grammar, so those two fail together; CSP and sandbox are independent. [Details](findings/README.md). |
| Cost | Markdown is cheaper per word today (HTML about 1.4×). Compact HTML is 15% cheaper than strict on identical content. This project makes no claim to be cheaper. |
| Hosted models | Not tested. Only a local model and a fake backend. |
| User preference | Not tested. |

## Falsifiers

| if | then |
|---|---|
| under 90% valid as emitted on hosted models, across three backends | stop claiming it works without a grammar |
| people do not prefer styled HTML to Markdown | drop the UX claim, keep portability |
| red team finds script execution through the sanitizer | fix and publish first |
| a fine-tune on compact answers does not cut tokens per word | drop the tokenizer argument |

## Layout

`spec/` subset, prompts, prose spec · `src/` validator, grammar, server · `web/` the page · `bin/` conform, tokencost, serve, grammar · `grammar/` generated GBNF · `conformance/` the suite · `test/` · `findings/`

```sh
bun run typecheck
bun test
bun run e2e        # Playwright: the page, then each defence layer attacked alone
bun run grammar    # regenerate grammars
```

Related: A2UI and Open-JSON-UI describe UI as JSON and need a renderer per platform; MCP-UI embeds sandboxed HTML and is the closest relative. This loses on native clients and on token cost.

MIT.
