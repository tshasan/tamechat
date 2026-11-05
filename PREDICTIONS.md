# Predictions for the first multi-model run

Written before `bench/hosted.json` and `bench/grammar.json` were run. Each run's `manifest.json` records the
commit it ran from, so `git log PREDICTIONS.md` shows these came first. Results go in the right-hand column
afterwards, and none of the predictions get edited.

| # | Prediction | Why it matters | Result |
|---|---|---|---|
| 1 | At least 3 of the 9 hosted models produce valid subset HTML (strict profile, prompt only) on ≥ 90% of answers | The README's own test: below this, stop saying it works without a grammar | |
| 2 | The small, cheap models (Haiku, Luna, the flash tiers, GLM flash) average below 80% valid | Tells you whether the prompt-only path needs a grammar or a repair step for cheap models | |
| 3 | The most common violation is structural (bare text inside `<aside>` or `<li>`, text outside any element), not a disallowed tag | Says whether to loosen the content model or tighten the prompt | |
| 4 | Fewer than 5% of answers come back wrapped in a code fence | Fences are the classic failure of "answer in HTML" prompts | |
| 5 | HTML answers use 1.2–1.6× the completion tokens per word of Markdown answers to the same prompts | The cost claim in the README (about 1.4×) was measured on one model | |
| 6 | Every answer parses to an identical DOM in Chromium, Firefox and WebKit, and tamechat's output is identical across them | The "the platform is enough" claim | |
| 7 | Streaming in 4-character chunks gives the same DOM as rendering the whole answer, for every answer | The renderer's streaming claim | |
| 8 | `setHTML()` with default settings removes at least one element from ≥ 30% of answers in Chromium and Firefox; WebKit still has no `setHTML()` | The web-platform finding, on real output from many models | |
| 9 | With the grammar, open models are ≥ 95% valid, and their median answer length stays within 20% of the same model without the grammar | Grammar helps structure without the early-stop failure | |
| 10 | No answer from any model contains a `<script>`, `<iframe>`, an `on…` attribute or a `javascript:` URL (checked in `answers.jsonl`) | Whether ordinary prompts ever produce dangerous output at all | |

## What happens if a prediction fails

- **1 fails:** the README's claim narrows to "with a grammar or a repair step", as `README.md` already commits to.
- **6 or 7 fails:** that's a bug or a platform difference. Find which, and file it upstream if it's a browser's.
- **9 fails on length:** the grammar post's warning applies beyond the one model it was measured on.
