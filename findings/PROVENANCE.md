# Provenance

What produced the numbers in [README.md](README.md), so they can be checked or repeated.

| | |
|---|---|
| Model | Qwen3.6-35B-A3B, `Qwen3.6-35B-A3B-UD-IQ4_XS.gguf` (18 GB) |
| Model SHA-256 | `649d7508507b84638732c4f52c24c8b15843c6dca2f3ff793ae07c14a67ebbb3` |
| Server | llama.cpp `llama-server` 0.5.0-dev (build 1), commit `e5983d67043bf989e1d28e037951da559119f479`, Apple Silicon (Metal), 36 GB unified memory |
| Sampling | temperature 0.7; thinking off unless stated; one sample per prompt (the same seed per prompt across arms in `grammar-shapes/`) |
| Prompts | `corpus/prompts.json` (12) |
| Run dates | October 2026 |
| Token counts | the server's own `/tokenize` for that model (`cmd/tokencost`), not an approximation |

Not recorded: the exact sampler seed values, and the order the arms were run in.
