# tamechat

A test suite for rendering AI-written HTML, and a small chat app that passes it.

## The problem

When an AI model writes an answer, your app has to show it. If the answer is HTML, it can carry code that steals data or sends the page somewhere else. We wrote 32 attacks and ran them against a page with no defense. 10 of them worked: 6 ran a script, 3 sent a request to another site and 1 navigated the page away.

So every chat app needs a rule for what HTML it will accept. Today each app invents its own, and nobody can check it against anyone else's.

## What is here

1. **A list of allowed HTML.** Paragraphs, headings, lists, tables, code, collapsible sections, callouts and suggested replies. Nothing else. The list is one file: [spec/subset.json](spec/subset.json). The written version is [spec/SPEC.md](spec/SPEC.md).
2. **A test suite.** 58 sample documents, 32 of them attacks. Each says whether it must be accepted or rejected. Anyone can build their own checker in any language and run it against this list. See [conformance/manifest.json](conformance/manifest.json).
3. **A small renderer.** About 5 KB of code with no outside dependencies. It shows allowed HTML and throws out the rest. DOMPurify is just as safe on these tests, so the renderer's only advantage is size.
4. **A chat app.** It works with any model that speaks the OpenAI API, and it is the demo for the other three.

## Compare sanitizers

You need [Bun](https://bun.sh) 1.2 or newer.

```sh
bun install
bunx playwright install chromium firefox webkit
bun run compare
```

This runs the 32 attacks and the 9 valid documents through each tool in headless Chromium and prints a table. "Attacks contained" means no script ran, no request left the page and the page did not navigate. "Text kept" and "structure kept" check that a valid document comes out the same, because a tool that deletes everything is safe and useless. `escape everything` is in the table to show that.

Result on Chromium 153 (`bun run compare --engine firefox` or `webkit` for the others):

| tool | attacks contained | text kept | structure kept |
|---|---|---|---|
| no defence | 22/32 | 9/9 | 9/9 |
| escape everything | 32/32 | 0/9 | 0/9 |
| DOMPurify default | 32/32 | 9/9 | 9/9 |
| browser `setHTML()` | 32/32 | 7/9 | 7/9 |
| `setHTML()` allowing `details`, `summary`, `button` | 32/32 | 9/9 | 9/9 |
| tamechat renderer | 32/32 | 9/9 | 9/9 |

Firefox 155 gives the same rows. WebKit 26.6 has no `setHTML()`, and DOMPurify and the tamechat renderer give the same rows there. With no defence, Firefox and WebKit contain 23 of 32; which attacks get through differs by engine, and the harness's short wait may account for some of that, so it isn't reported as a finding yet.

`setHTML()` and DOMPurify are both safe here. `setHTML()` with its default settings removes `<details>`, `<summary>` and `<button>` together with the text inside them, so suggested replies and collapsible sections disappear. It also removes every `class` attribute, which drops code-block languages (`language-go`) and callout styling. Chromium 153 and Firefox 155 behave the same; WebKit 26.6 has no `setHTML()`. DOMPurify keeps all of it. Allowing those three elements in `setHTML()`'s config gives 32/32 and 9/9. The attacks were written against this project, so a pass shows the tool handles these 32 and nothing more.

## What would count as success

Someone else writes their own renderer and it passes the test suite. Until that happens, this is one person's project. After it, it is a standard.

## Benchmark many models in three browsers

`bun run matrix` asks a list of models (hosted ones through OpenRouter, open ones on llama.cpp with the grammar) the same prompts with fixed seeds and stores every answer as JSON. `bun run render` then renders every stored answer in Chromium, Firefox and WebKit and checks what each renderer kept, whether streaming changes the result, and whether the engines agree. See [bench/README.md](bench/README.md).

## Check your own model

You need [Bun](https://bun.sh) 1.2 or newer and a model behind an OpenAI-compatible API (Ollama and llama.cpp both work).

```sh
bun install
bun run conform sample --backend http://127.0.0.1:11434/v1 --model llama3.2
```

This asks 12 test questions and reports how many answers followed the rules, and which rules the rest broke. To check one file:

```sh
bun run conform check answer.html
```

## Try to break it

The attacks are in `conformance/cases/attack/`. If you find one that runs a script through the renderer, open an issue. I will fix it and publish the fix before anything else.

## Run the chat app

```sh
bun start --backend http://127.0.0.1:11434/v1 --model llama3.2
```

Open http://127.0.0.1:8090/. The Format menu switches between HTML and Markdown answers. Changing it starts a new chat. "Download .html" saves a chat as one file that opens with no software and works with JavaScript off.

Other setups:

```sh
bun start --backend http://127.0.0.1:8081/v1 --model <id> --grammar grammar/compact.gbnf --profile compact

OPENAI_API_KEY=... bun start --backend https://api.openai.com/v1 --model <id> --key-env OPENAI_API_KEY
```

The first uses llama.cpp with a grammar, which forces the model to follow the rules. The second is a hosted model with no grammar, so the page's own filters do the protecting.

## A result worth knowing

If a grammar bans a token the model really wants, the model stops early. We banned the newline between blocks, and the median answer fell from 452 tokens to 45. This is true of any constrained output, not only HTML. If you use grammars, test answer length as well as validity. Details in [findings](findings/README.md).

## What we know and what we don't

| | |
|---|---|
| Safety | Four layers of defense, each attacked alone in a real browser. Two layers share a source, so they can fail together. A second reviewer is still needed. |
| Cost | HTML uses about 1.4 times the tokens of Markdown, so it is slower and costs more per word. A compact mode saves 15%. We don't claim HTML is cheaper. |
| Interactive widgets | Optional, and less safe than the rest. Turn them on only for models you trust. |
| Hosted models | Not tested yet. Only one local model so far; `bench/hosted.json` lists nine hosted models to run. |
| Do people like it | Not tested. A model judge preferred Markdown, and it is not an independent judge. |

## What would prove this wrong

| If this happens | We do this |
|---|---|
| Someone gets a script to run through the filter | Fix it first and tell everyone |
| Fewer than 90% of answers follow the rules on three hosted models | Stop saying it works without a grammar. On one local model the prompt alone gave 7 of 12 ([findings](findings/README.md#not-shown)), so this one is open |
| People prefer Markdown to styled HTML | Drop the claim that it looks better. Keep the safety suite. |
| Training a model on compact answers doesn't cut tokens | Drop the tokenizer idea |

## Help wanted

1. Run `bun run conform sample` on your own model, especially a small or hosted one, and share the row it prints.
2. Write a second renderer in another language and run it against the suite.
3. If you build a chat app, tell us what would stop you from using this.

## Related work

- **Markdown plus DOMPurify** is the usual setup. It is well reviewed. It has no shared test suite for model output.
- **Email HTML.** Every email app shows its own subset of HTML. Nobody owns the format and there is no common list of what works.
- **AMP** was a restricted, validated subset of HTML run by one company. Many people saw it as lock-in. A subset with a checker can become a moat, so this one needs open ownership.
- **MCP Apps, MCP-UI, A2UI** put interactive interfaces inside answers. They cover a different, harder problem. This project covers the safe, static part.

## Where things are

| Folder | What is in it |
|---|---|
| `spec/` | The allowed HTML list, the prompts and the written rules |
| `conformance/` | The test documents |
| `src/` | The checker, the grammar, the server |
| `web/` | The chat page and the renderer |
| `bin/` | Command-line tools |
| `grammar/` | Generated grammar files |
| `findings/` | Measurements and how far to trust them |
| `bench/` | Model lists for the multi-model benchmark, and how to run it |
| `modal/` | llama-server on a Modal GPU, for the grammar runs |
| `runs/` | Stored benchmark answers and render results, one folder per run |

```sh
bun run typecheck
bun test
bun run e2e
bun run grammar
```

MIT license.
