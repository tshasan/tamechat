# Grammar shapes: what does the answer format cost, and what does it buy?

> This experiment ran in the prototype this repository was extracted from. The data (`answers.jsonl`, `judge.jsonl`, `summary.json`) is complete. `bench.py` expects that prototype's layout (its bridge, system prompt and grammar variants), so it is kept as a record of the method, not as a tool you can run here.

Qwen3.6-35B-A3B (IQ4_XS), thinking off, temperature 0.7, 12 prompts, one answer per prompt per arm, the same seed for a prompt in every arm. 12 arms, 144 answers. Data is in `results/` (`answers.jsonl`, `judge.jsonl`, `summary.json`, `report.md`). 

**Read the limits first.** Twelve prompts and one sample each is a pilot, not a benchmark. The judge is the same model as the generator, sees plain-text renderings, and is only meant to compare arms with each other. Several differences below are inside the noise; each says so.

## Results

| arm | tokens/answer | tokens per word | vs strict HTML | decode s | asked-for present | judge |
|---|---|---|---|---|---|---|
| **S0** strict HTML (shipped) | 474 | 2.40 | 1.00× | 12.6 | 8/10 | baseline |
| **S1** tight grammar + compact prompt | 142 | 2.20 | 0.92× | 3.8 | 5/10 | 1 win / 18 loss vs S0 (p<0.01) |
| **S2** + end tags optional | 117 | 2.16 | 0.90× | 3.1 | 6/10 | 1 / 22 (p<0.01) |
| **S3** + end tags forbidden | 299 | 4.06 | 1.69× | 8.2 | 7/10 | 1 / 19 (p<0.01) |
| **D1** tight grammar, original prompt | 178 | 2.22 | 0.93× | 4.8 | 4/10 | 1 / 15 (p<0.01) |
| **D2** strict grammar, compact prompt | 286 | 2.75 | 1.15× | 7.7 | 9/10 | 4 / 15 |
| **D5** strict + must end with a menu (control) | 510 | 2.51 | 1.05× | 13.7 | 8/10 | 2 / 2 (20 ties) |
| **D3** tight + must end with a menu | 432 | 2.39 | 1.00× | 11.6 | 10/10 | 5 / 10 vs D5 (p=0.30) |
| **D6** D3 + end tags optional | 432 | 2.39 | 1.00× | 11.9 | 10/10 | identical to D3 |
| **M1** Markdown under a grammar | 210 | 1.55 | 0.65× | 5.5 | 9/10 | 7 / 12 vs S0 (p=0.36) |
| **M2** free Markdown | 309 | 1.73 | 0.72× | 8.2 | 7/10 | 15 / 7 vs S0 (p=0.13) |
| **H** free HTML, prompt only | 469 | 2.30 | 0.96× | 12.4 | 7/10 | 3 / 5 vs S0 (16 ties) |

"Tokens per word" divides tokens by the words of the rendered text, so a longer answer is not mistaken for a more expensive format. "Asked-for present" is whether the table, code block, callout or list the prompt asked for is actually there (10 requests, so one is 10%).

## What this shows

1. **A grammar that forbids the newline between blocks makes the model stop early.** D1 (tight grammar, unchanged prompt) has a median of 45 tokens and 1 block, against 452 and 7.5 for the shipped grammar; 8 of 12 answers are under 60 tokens. Mechanism: the newline is the model's overwhelmingly preferred token after `</p>`; masking it hands its probability to the remaining choices, and end-of-sequence gets a large share. Requiring the answer to end with a `<menu>` removes that exit (D3, D5), and lengths return to normal. This is a general property of constrained decoding, not of HTML.
2. **Telling the model to "write compact HTML" also makes answers shorter** (D2: 452 to 248 tokens at the median) because "compact" leaks into "brief". Any comparison that changes the prompt wording confounds format with content. The first four rows above are confounded this way and should not be read as format savings.
3. **The controlled pair is D5 against D3**: same prompt, same structure, differing only in whitespace and the `scope` attribute. Tokens per word fall 2.51 to 2.39 (-5%), and the judge cannot tell them apart (p=0.30). That agrees with the earlier equivalent-document measurement (`cmd/tokencost` here: dropping newlines and `scope` is worth about 7%).
4. **Forbidding end tags on an untrained model fails** (S3: 4.06 tokens per word, 2 of 12 runaways, `<th>Feature<br>Go<br>Rust…`). Merely allowing it does nothing (D6 is byte-identical to D3): the model never takes the freedom. The remaining ~7% of format savings, and everything beyond, needs a fine-tune.
5. **HTML costs more tokens per word than Markdown today**: 2.4 against 1.55 (constrained) or 1.73 (free), so about 1.4 to 1.5×; tight HTML is about 1.38× free Markdown. This matches the corpus estimate in `cmd/tokencost` (1.48× as generated, 1.27× compact, 0.96× with single-token tags).
6. **No significant quality difference was found between the shipped grammar and the alternatives it should be compared to.** H (same prompt, no grammar) ties S0 in 16 of 24 comparisons; D5 ties in 20 of 24. Free Markdown was preferred over strict HTML 15 to 7 (p=0.13): not significant, but the direction is a reason to check with people before claiming parity.
7. **The grammar's safety value is not demonstrated here.** On 12 ordinary prompts the prompt-only HTML arm (H) produced valid subset HTML every time (0/12 invalid). The grammar guarantees this; this sample cannot show that it is needed. That case needs adversarial prompts and a smaller model.

## What it means for the project

- **Do not ship grammar-only compaction.** It either truncates answers or degenerates. Get compact output by fine-tuning on compact examples, with the grammar relaxed to allow them.
- **If a grammar must forbid a token the model wants, give it no early exit** (end-with-a-closing-block) and test answer length, not just validity.
- **The case for the web platform is not token cost.** Markdown is cheaper per word and, on this sample, not clearly worse. The platform's case is elsewhere: rendering a model's answer takes 4.7 KB with no third-party code (the prototype's `render.js` + `sanitize.js`) against about 69 KB for a typical Markdown parser plus sanitizer (marked 40 KB + DOMPurify 29 KB, minified, measured from npm), and the model can emit `<details>`, callouts, tables with captions and sandboxed widgets that Markdown has no syntax for. DOMPurify is far more battle-tested than the 1.4 KB allowlist here, which is a thin layer over the grammar.

## Method notes and known weaknesses

- Each arm's system prompt describes its own format, including a worked example, so the grammar and the prompt agree. That is what makes the prompt wording a confound (finding 2).
- The "runaway" count (answer hit the 900-token limit) counts the hiking-checklist prompt in several arms; it is probably a long answer, not a loop.
- The judge sees plain-text renderings in both orders to cancel position bias; HTML and Markdown flatten slightly differently, which can favour one.
- Only one model, one temperature, one sample per prompt. Token counts per answer vary by roughly 10% between samples.
- Telemetry: every answer and judge call is an OpenTelemetry trace (`bench.answer`, `bench.judge`) sent through the bridge, so it shows on `/debug.html` and in any OTLP backend. The debug page keeps the newest 100; a collector keeps all. The first 84 answers were backfilled with reconstructed timing (`bench.reconstructed_timing`).
