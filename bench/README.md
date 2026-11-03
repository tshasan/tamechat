# Multi-model benchmark: model → renderer → three engines

Two stages. Stage 1 asks models for answers and stores every answer as JSON. Stage 2 renders every stored
answer in Chromium, Firefox and WebKit and checks what each renderer kept. Stage 2 never calls a model, so it
can be re-run for free against old answers whenever the renderer or a browser changes.

## Stage 1: answers

```sh
bun run matrix bench/hosted.json --dry-run     # prices from OpenRouter's catalogue, worst-case cost, missing keys
OPENROUTER_API_KEY=... bun run matrix bench/hosted.json
bun run matrix bench/hosted.json --only claude-haiku-5.5     # one model first, to smoke-test
```

Every model answers in HTML (strict and compact profiles) and, with `"formats": ["html", "markdown"]`, once more in Markdown for the token-cost comparison. Write your predictions in [`PREDICTIONS.md`](../PREDICTIONS.md) and commit them before a paid run.

Each run writes `runs/<timestamp>/`:

| file | what |
|---|---|
| `manifest.json` | git commit, dirty flag, prompts file and its SHA-256, the full config |
| `<label>/<profile>[-grammar]/answers.jsonl` (and `<label>/markdown/`) | one line per answer: prompt, seed, served model, provider, raw text, finish reason, tokens, cost, validator result |
| `<label>/<profile>[-grammar]/report.txt` | the `conform sample` summary for that cell |
| `spent.json` | dollars spent and whether the budget stopped the run |

The seed for prompt *i*, sample *k* is `seedBase + i + 1000k`, the same in every arm, so two arms can be
diffed answer by answer. Not every provider honours `seed`; `servedModel` and `provider` record who
actually answered.

**Budget.** `budgetUsd` is a hard cap. Before each call the runner checks that the worst case (an answer
that hits `maxTokens`) still fits, and stops otherwise. OpenRouter reports the real cost of each call
(`usage.cost`); other backends are priced from `price` in the config. Modal GPU time is not counted; it bills
by the second while the container is up.

### Grammar track (Modal)

Hosted APIs don't accept a GBNF grammar, so the grammar arms run llama-server on Modal:

```sh
uvx modal secret create tamechat-llama LLAMA_API_KEY=$(openssl rand -hex 24)
MODEL=qwen3.6-35b uvx modal run modal/llama_server.py::download   # once; checks the SHA-256 for qwen3.6-35b
MODEL=qwen3.6-35b uvx modal deploy modal/llama_server.py          # prints https://...modal.run
# put that URL (plus /v1) in bench/grammar.json, then:
LLAMA_API_KEY=... bun run matrix bench/grammar.json
uvx modal app stop tamechat-llama-qwen3.6-35b
```

Models available: see `MODELS` in `modal/llama_server.py`. Each runs with and without the grammar, with
thinking off, as in the October runs.

## Stage 2: render

```sh
bun run render runs/<timestamp> --summary runs/<timestamp>/render.md
```

For each answer and engine it records, against the browser's own parse of the raw answer:

- **tamechat text kept / tags kept**: did the renderer keep every word and every element the model wrote
- **streamed = whole**: does rendering in 4-character chunks give the same DOM as rendering the finished answer
- **DOMPurify** and **`setHTML()`** (where the engine has it) on the same answer
- page errors, and whether the parse and each renderer's output are identical across the three engines

Results go to `render.jsonl` next to each `answers.jsonl`.
