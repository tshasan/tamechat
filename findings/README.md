# Findings

Four measurements, each with its method and how far to trust it. All of it is a pilot on one model (Qwen3.6-35B-A3B, 4-bit) and a dozen prompts. None of it is a benchmark.

## 1. Compact HTML costs 15% fewer tokens than strict, and Markdown parity is a projection

`bun run tokencost --llama http://127.0.0.1:8081 --model <id>` tokenizes the same ten answers four ways with the model's own tokenizer:

| | tokens | vs Markdown | status |
|---|---|---|---|
| Markdown (estimate of the same content) | 3,229 | 1.00× | estimate |
| strict HTML, as generated | 4,772 | 1.48× | measured |
| compact HTML (same documents, checked) | 4,059 | 1.26× | measured |
| compact + a 32-form single-token vocabulary | 3,157 | 0.98× | **projected** |
| compact + every tag a single token (ceiling) | 3,100 | 0.96× | **projected** |

"Same documents, checked" means the tool verifies for each answer that the compact form is valid compact HTML and converts to the same Markdown as the strict one. The 15% is a saving on identical content. The Markdown line is an estimate, because a captioned table or a callout has no canonical Markdown.

The two projected lines assume a tokenizer that gives each listed tag one token. No shipping tokenizer does. They estimate what a tokenizer change could be worth. The 0.96× is a ceiling.

A vocabulary of 32 forms (`spec/token-vocab.txt`) gets within two points of the ceiling. I ranked tags by how often each appears times how many tokens it costs now. Past about 40 forms nothing more is saved. The savings come mostly from closing tags (`</strong>` is 3 tokens) and fixed attribute boilerplate (`<aside class="note" role="note">` is 10). The compact profile drops `role` and `type` entirely.

Caveats: ten answers from one model. Token costs depend on the tokenizer, so re-run it on yours. The single-token lines also assume the words cost the same after a fine-tune, which nobody has checked.

### A live comparison through the portable interface

`conform sample` ran the same twelve prompts against the same local model (grammar on, thinking off), once per profile:

| profile | valid as emitted | cut off at 900 tokens | asked-for element present | total completion tokens |
|---|---|---|---|---|
| strict | 11/12 | 1 | 10/10 | 4,194 |
| compact | 12/12 | 0 | 8/10 | 3,164 |

The one strict answer that failed validation hit the token limit and left unclosed tags. **This run does not measure the format's cost.** The token totals differ by 25%, but per-prompt ratios ranged from 0.35 to 2.09. The two system prompts led the model to write different content (one sample each), so most of the gap is content. The same-document measurement above is the clean one. The model also kept writing its end tags when told to leave them out, as an untrained model does, so this "compact" run mostly shows no whitespace and no `scope`, `role` or `type`. The drop from 10/10 to 8/10 asked-for elements is small and unexplained.

## 2. A grammar that bans the model's preferred token makes it stop early

Forbidding the newline between blocks in the grammar made answers short instead of compact. The median answer fell from 452 tokens and 7.5 blocks to **45 tokens and 1 block**, and 8 of 12 answers ran under 60 tokens. The model strongly prefers a newline after `</p>`. Masking it hands that probability to the other choices, and end-of-sequence takes a large share. Forbidding the optional end tags outright was worse: the untrained model degenerated into `<th>Feature<br>Go<br>Rust…` until the token limit.

A grammar that **allows** the compact forms without **forcing** them (`grammar/compact.gbnf`), plus an instruction in the prompt, worked. Requiring the answer to end with a `<menu>` also removed the early exit, but I would not ship that.

Any constrained decoding can do this, not only HTML. Whenever a grammar forbids a token the model wants, test answer length as well as validity. Data and method: `grammar-shapes/` (12 arms, 144 answers). Telling the model to "write compact HTML" also shortened the content (452 to 248 tokens at the median), which confounded the first comparison. The controlled pair, with the same prompt and structure and differing only in whitespace and `scope`, saved 5% per word.

## 3. Rendering and sanitizing an answer takes 5 KB here, against about 69 KB for a typical Markdown stack

`web/render.ts`, `sanitize.ts`, `scanner.ts` and the subset definition bundle to 5,182 bytes minified (2,131 gzipped), with no third-party code. A Markdown parser (marked, 39.9 KB) plus DOMPurify (28.9 KB) is about 69 KB minified. The browser's own HTML parser does the parsing and puts omitted end tags back.

This compares size and says nothing about quality. DOMPurify has years of review behind it. The allowlist here is a thin layer over the grammar and the Content-Security-Policy.

## 4. Each safety layer, attacked alone

`test/e2e/redteam.ts` runs 32 attack documents (`conformance/cases/attack/`) against one layer at a time in a real browser, so a hole in one layer cannot hide behind the others. A positive control (the same documents as raw `innerHTML`, no defence) must show holes, or the run fails: it shows 22.

| layer | result |
|---|---|
| validator (both profiles) | rejects all 32 |
| sanitizer alone, no CSP, whole and streamed one character at a time | contains all 32: no script ran, no request left, no navigation, no handler or `javascript:` URL left in the DOM |
| CSP alone, raw `innerHTML` | stops every script and every request, but not `<meta http-equiv=refresh>`, which navigates the page away; 18 documents leave inert handlers in the DOM that only the CSP keeps from running |
| widget sandbox, hostile script inside | `fetch`, `sendBeacon`, `WebSocket`, image beacon, dynamic `import`, `parent.document`, `top.document`, `localStorage`, cookies, `indexedDB`, `window.open` and `top.location` are all blocked |

Two real bugs came out of it, both fixed with a regression test: the sanitizer accepted an SVG `<a>` (same local name as an allowed element) and then crashed on it, and the compact validator accepted an answer cut off in the middle of a tag.

The run does not show that the layers are independent (the sanitizer mirrors the grammar, so they correlate by design) or that no browser bug can get through. A widget can also call `sendPrompt`, which speaks as the user, capped at 2,000 characters with no confirmation. That is a capability, and you should review it before enabling widgets for untrusted models.

## Not shown

- **That the grammar is necessary.** On twelve ordinary prompts the prompt-only arm produced valid subset HTML every time. This sample cannot show the grammar is needed. Adversarial prompts and smaller models can, and `conform sample` runs them.
- **That users prefer it.** A model judge (the same model, so not independent) preferred free Markdown to strict HTML 15 to 7 on 24 comparisons (p = 0.13, not significant). No person has rated anything.
- **That it works with hosted models.** Everything above ran on a local model.
