# I ran 32 attacks against four ways to render AI-written HTML

I took 32 known tricks for getting code to run through HTML and fed them to four ways of showing a model's answer in a browser. With no defense, 10 attacks worked. DOMPurify, the browser's built-in `setHTML()` and my own 5 KB renderer stopped all 32. Then I fed each one nine valid documents and checked what came out.

| tool | attacks contained | valid documents kept intact |
|---|---|---|
| no defense | 22 of 32 | 9 of 9 |
| escape everything | 32 of 32 | 0 of 9 |
| DOMPurify default | 32 of 32 | 9 of 9 |
| browser `setHTML()` | 32 of 32 | 7 of 9 |
| my renderer | 32 of 32 | 9 of 9 |

The last column matters because a tool that turns every answer into plain text also contains every attack. `setHTML()` with its default settings drops `<button>` and `<details>`, so suggested replies and collapsible sections disappear. I tested one browser build (Chromium 153), and a custom allowlist would probably fix it.

DOMPurify did as well as my code. If you need a sanitizer today, use it. The rest of this post is about what I think is still missing.

## Nobody can compare these tools

A chat app has to show whatever the model writes. If that is HTML, the model, or anyone who can influence it, can slip code into the page. Every app handles this with its own rules, and I found no shared list of inputs that must pass and inputs that must fail. Security advice says to treat model output as untrusted and sanitize it. It gives you no way to check that your sanitizer did.

So I wrote that list. It has 58 documents, 32 of them attacks, and each one says whether a renderer must accept or reject it. A renderer in any language can run against it. `bun run compare` produces the table above.

## Why this will matter more

Answers are growing from text into software. They now include sortable tables, buttons, diagrams and small tools, and each big vendor delivers them its own way. Claude and ChatGPT show HTML artifacts and canvases. MCP Apps, finalized in January 2026, lets a tool return an interface in a sandboxed frame ([overview](https://composio.dev/content/what-are-mcp-apps)). Google's A2UI describes interfaces as JSON that each app turns into its own widgets ([overview](https://www.analyticsvidhya.com/blog/2025/12/google-a2ui-explained/)). In May 2026 an Anthropic engineer argued that HTML should replace Markdown as the default output, and write-ups say Karpathy agreed ([summary](https://noqta.tn/en/blog/html-vs-markdown-llm-output-karpathy-anthropic-2026)).

When the answer is HTML, every app that shows it has to decide what to trust. Claude artifacts export as HTML files, but outside Claude they can break, because they expect things only Claude's environment provides ([example](https://docs.plannotator.ai/learn/ai-development/claude-artifacts)). A format built together with one app tends to end up that way.

My bet is about timing. Tightly built products win while they are far ahead, and they are far ahead now. Swappable parts win once models become interchangeable and apps want to change them freely. If that happens, the answer format becomes a contested layer and a shared test suite becomes useful. If it doesn't, this project is a safety tool.

## What I built

The allowed list is paragraphs, headings, lists, tables, code, collapsible sections, callouts and a row of suggested replies. It has no invented tags and no invented attributes. It lives in one file, and the checker, the filter and the rules that steer the model all come from that file. The test suite grades any renderer against it. A small chat app works with any OpenAI-compatible model, and "Download .html" saves a chat as one file that opens anywhere with JavaScript off.

My renderer is about 5 KB. Marked plus DOMPurify, the usual Markdown setup, is about 76 KB. Size is the only thing I can claim for it. DOMPurify has years of review that mine doesn't.

The list is plain on purpose. It carries text, structure and a few controls. There is an optional widget feature for small interactive pieces. It is the least safe part, and you should leave it off for models you don't trust.

## How I attacked it

I tested the four defense layers separately, in a real browser. A run with no defense had to show holes, or the test would prove nothing. It showed 22.

- The filter alone contained all 32, even when the page arrived one character at a time.
- The browser's security policy alone stopped every script and every outside request. It did not stop a forced redirect.
- A hostile script inside a widget could not reach the page, its stored data or the network.

Testing found two bugs, both fixed with tests. The filter and the model rules come from the same list, so they can fail together. I want a second reviewer before anyone trusts this with hostile input.

## Banning one token made the model stop

I wanted shorter answers, so I banned the newline between blocks in the grammar. Answers got cut off instead. The median fell from 452 tokens to 45, and 8 of 12 answers ran under 60 tokens.

The model strongly prefers a newline after a paragraph. Remove that option and its probability moves to the other choices, and "end of answer" takes a large share. Banning the optional closing tags was worse: the model repeated junk until it hit the limit. Grammar-Aligned Decoding ([Park et al., 2024](https://arxiv.org/abs/2405.21047)) shows that grammar constraints distort a model's distribution in general; I couldn't find this specific failure, answers ending early, written up.

It applies to any constrained output. If you use grammars or structured output, measure answer length along with validity. My fix was to allow the compact forms and stop forcing them.

## What already exists

- **Markdown plus DOMPurify** is the standard setup. It has no shared test suite for model output.
- **Browser `setHTML()`** shipped in Chrome 146 and Firefox 148, and Safari has not started ([web.dev](https://web.dev/sanitizer)). Production code needs a fallback for now.
- **Email.** Every email app shows its own subset of HTML. No one owns the format, and developers rely on community tables to learn what works where. This is the closest precedent.
- **AMP** was a restricted, validated subset of HTML run by one company. Many people saw it as lock-in. A subset with a checker can become a moat, so this one needs open ownership. It has no governance process yet.
- **MCP Apps and A2UI** handle interactive interfaces, which is a harder problem with a lot of backing. This project covers the static layer under them.

## What it costs

On one local model, with 12 questions and one answer each, HTML used 2.4 tokens per word and Markdown used 1.7. That is about 1.4 times as many. Other write-ups report 2 to 3 times, but they compare whole web pages, and this list has no styling or scripts. Writing tokens is the slow part, so for the same content Markdown is faster. HTML draws faster on the page, 16 ms against 93 ms per thousand characters on one 12-prompt run ([findings/render-timing](../findings/render-timing/run1.txt)), which does not make up for the writing time.

A compact mode drops the closing tags HTML lets you skip. It saves 15% on identical content, and I measured that. If a model gave common tags one token each, the cost would drop to about 0.98 times Markdown. That number is a projection. No shipping model does this, and only people who control a model's weights can try.

## What I haven't shown

- **That people prefer it.** Nobody has rated anything. A model judge, which is not independent, preferred Markdown 15 to 7. One study reports that people "overwhelmingly preferred" its generated interfaces to standard Markdown output ([paper](https://arxiv.org/abs/2604.09577)), but those interfaces did more than this list allows. If real users prefer Markdown, I drop the claim that it looks better and keep the safety suite.
- **That it works on hosted models.** I ran one local model and a fake one. If fewer than 90% of answers follow the rules across three hosted services, I stop saying it works without a steering grammar.
- **That the tokenizer idea works.** If training on compact answers doesn't cut tokens, I drop that argument.
- **That the filter is sound.** If you get a script to run through it, I fix it and publish the fix first.
- **That the comparison is fair.** I wrote the attacks, so the table shows how each tool handles these 32 and nothing more. Send me attacks that break DOMPurify or `setHTML()` and I will add them.

## What would make this a standard

Someone else writes a renderer in any language and it passes the suite. That is the whole test.

## What you can do

The code, the spec and the tests are at [repo link].

- Run `bun run compare` and `bun run conform sample --backend <url> --model <name>`, and post what you get.
- Add an attack that gets through something.
- Write a second renderer and run it against the suite.

If you build a chat app and could use this, tell me what stops you. If it duplicates something that exists, I want to know.
