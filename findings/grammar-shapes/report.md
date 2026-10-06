| arm | n | tokens/answer | tokens per word | vs strict HTML | vs free Markdown | decode s/answer | runaway | asked-for present | invalid | judge vs S0 (win/tie/loss) |
|---|---|---|---|---|---|---|---|---|---|---|
| **S0** strict HTML (shipped) | 12 | 474 | 2.40 | 1.00× | 1.39× | 12.6 | 1/12 | 8/10 | 0/12 | n/a (baseline) |
| **S1** tight HTML | 12 | 142 | 2.20 | 0.92× | 1.27× | 3.8 | 0/12 | 5/10 | 0/12 | 1/5/18 vs S0 |
| **S2** tight, end tags optional | 12 | 117 | 2.16 | 0.90× | 1.25× | 3.1 | 0/12 | 6/10 | 0/12 | 1/1/22 vs S0 |
| **S3** tight, end tags forbidden | 12 | 299 | 4.06 | 1.69× | 2.35× | 8.2 | 2/12 | 7/10 | 0/12 | 1/4/19 vs S0 |
| **D1** tight grammar, ORIGINAL prompt | 12 | 178 | 2.22 | 0.93× | 1.28× | 4.8 | 1/12 | 4/10 | 0/12 | 1/8/15 vs S0 |
| **D2** strict grammar, COMPACT prompt | 12 | 286 | 2.75 | 1.15× | 1.59× | 7.7 | 0/12 | 9/10 | 0/12 | 4/5/15 vs S0 |
| **D5** strict + menu (control) | 12 | 510 | 2.51 | 1.05× | 1.45× | 13.7 | 1/12 | 8/10 | 0/12 | 2/20/2 vs S0 |
| **D3** tight + menu | 12 | 432 | 2.39 | 1.00× | 1.38× | 11.6 | 1/12 | 10/10 | 0/12 | 5/9/10 vs D5 |
| **D6** tight + menu, end tags optional | 12 | 432 | 2.39 | 1.00× | 1.38× | 11.9 | 1/12 | 10/10 | 0/12 | 5/9/10 vs D5 |
| **M1** Markdown under a grammar | 12 | 210 | 1.55 | 0.65× | 0.90× | 5.5 | 0/12 | 9/10 | 0/12 | 7/5/12 vs S0 |
| **M2** free Markdown (no grammar) | 12 | 309 | 1.73 | 0.72× | 1.00× | 8.2 | 0/12 | 7/10 | 1/12 | 15/2/7 vs S0 |
| **H** free HTML (prompt only) | 12 | 469 | 2.30 | 0.96× | 1.33× | 12.4 | 2/12 | 7/10 | 0/12 | 3/16/5 vs S0 |
