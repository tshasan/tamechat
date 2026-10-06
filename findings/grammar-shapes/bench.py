#!/usr/bin/env python3
"""Grammar-shape benchmark: what does the shape of the answer format cost, and what does it buy?

Runs the same prompts (same seed per prompt) through several arms against a live
llama-server, then measures tokens, time, runaway rate, whether the answer contains what
was asked for, validity, and a blinded pairwise judge against the shipped grammar.

    python3 bench.py gen      # generate answers (resumable)
    python3 bench.py analyze  # measure + judge + write results/report.md

Needs llama-server in router mode on :8081 with the model loaded (see run.sh). Standard
library only. The model also acts as the judge, so judge numbers are indicative, not
independent: they compare arms against each other, not against ground truth.
"""
import json, re, sys, time, urllib.request, urllib.error
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
OUT = HERE / "results"
LLAMA = "http://127.0.0.1:8081"
MODEL = "Qwen3.6-35B-A3B-UD-IQ4_XS"
N_PREDICT = 900          # an answer that needs more than this counts as a runaway
TEMP = 0.7               # what the bridge uses

HTML_SYS = (ROOT / "bridge/system-prompt.txt").read_text().strip()
G = lambda name: (ROOT / "grammar" / name).read_text()

# --- system prompts: each arm is told the format it will be held to ---------------------
EXAMPLE_SPLIT = "Example answer:\n"
base, example = HTML_SYS.split(EXAMPLE_SPLIT)
EX_TIGHT = ('<p>QUIC is a transport protocol that runs over <abbr title="User Datagram Protocol">UDP</abbr>.</p>'
            '<ul><li><strong>Faster setup:</strong> one round trip, or zero when resuming.</li>'
            '<li><strong>No head-of-line blocking</strong> between streams.</li></ul>'
            '<menu><li><button type="button" value="How does HTTP/3 use QUIC?">HTTP/3 and QUIC</button></li></menu>')
EX_OMIT = ('<p>QUIC is a transport protocol that runs over <abbr title="User Datagram Protocol">UDP</abbr>.'
           '<ul><li><strong>Faster setup:</strong> one round trip, or zero when resuming.'
           '<li><strong>No head-of-line blocking</strong> between streams.</ul>'
           '<menu><li><button type="button" value="How does HTTP/3 use QUIC?">HTTP/3 and QUIC</button></li></menu>')
NOTE_TIGHT = "\n\nWrite compact HTML: no newlines or spaces between tags, and no scope attribute."
NOTE_OPT = (NOTE_TIGHT + " You may leave out the end tags </p>, </li>, </td>, </th>, </tr>, </thead> and </tbody> "
            "(the browser adds them), but keep every other end tag. Inside <menu> keep </li>.")
NOTE_OMIT = (NOTE_TIGHT + " Never write the end tags </p>, </li>, </td>, </th>, </tr>, </thead>, </tbody>, </dt> or </dd>; "
             "start the next element instead (the browser adds them). Keep every other end tag. Inside <menu> keep </li>.")
MD_STRICT_SYS = ("You are a helpful assistant. Write the answer in Markdown using only: ## headings, plain paragraphs "
                 "(one line each), - bullets, 1. numbered lists, > quotes (for a callout write > **Tip:** ...), fenced code "
                 "blocks with a language, pipe tables, **bold**, *italic*, `code` and [text](https://...) links. "
                 "No raw HTML. Keep answers short unless asked for detail.")
MD_FREE_SYS = "You are a helpful assistant. Answer in Markdown. Keep answers short unless asked for detail."
HTML_FREE_SYS = HTML_SYS

ARMS = {
    "S0": dict(label="strict HTML (shipped)", system=HTML_SYS, grammar="answer-strict.gbnf", kind="html"),
    "S1": dict(label="tight HTML", system=base + NOTE_TIGHT + "\n\n" + EXAMPLE_SPLIT + EX_TIGHT, grammar="variants/answer-tight.gbnf", kind="html"),
    "S2": dict(label="tight, end tags optional", system=base + NOTE_OPT + "\n\n" + EXAMPLE_SPLIT + EX_OMIT, grammar="variants/answer-tight-opt.gbnf", kind="html"),
    "S3": dict(label="tight, end tags forbidden", system=base + NOTE_OMIT + "\n\n" + EXAMPLE_SPLIT + EX_OMIT, grammar="variants/answer-tight-omit.gbnf", kind="html"),
    # Diagnostics, added after the first run showed the tight arms stopping early: which of the
    # two changes (the grammar or the prompt wording) is responsible?
    "D1": dict(label="tight grammar, ORIGINAL prompt", system=HTML_SYS, grammar="variants/answer-tight.gbnf", kind="html"),
    "D2": dict(label="strict grammar, COMPACT prompt", system=base + NOTE_TIGHT + "\n\n" + EXAMPLE_SPLIT + EX_TIGHT, grammar="answer-strict.gbnf", kind="html"),
    # Controlled pair (same prompt, same structure, must end with a menu). They differ only in
    # whitespace between tags and the scope attribute, so any difference is the format's.
    "D5": dict(label="strict + menu (control)", system=HTML_SYS, grammar="variants/answer-strict-menu.gbnf", kind="html"),
    "D3": dict(label="tight + menu", system=HTML_SYS, grammar="variants/answer-tight-menu.gbnf", kind="html"),
    "D6": dict(label="tight + menu, end tags optional", system=HTML_SYS, grammar="variants/answer-tight-opt-menu.gbnf", kind="html"),
    "M1": dict(label="Markdown under a grammar", system=MD_STRICT_SYS, grammar="variants/answer-markdown.gbnf", kind="md"),
    "M2": dict(label="free Markdown (no grammar)", system=MD_FREE_SYS, grammar=None, kind="md"),
    "H":  dict(label="free HTML (prompt only)", system=HTML_FREE_SYS, grammar=None, kind="html"),
}

# --- telemetry -----------------------------------------------------------------------------
# Each answer and each judge call becomes an OpenTelemetry trace, sent to the bridge's
# /api/otel/client endpoint (the same one the chat page reports through). They show up on the
# debug page and are exported to any OTLP backend the bridge is configured for. Telemetry must
# never break the experiment, so every failure here is ignored.
import secrets
BRIDGE = "http://127.0.0.1:8080"

def emit(name, start, end, attrs, children=()):
    """start/end are unix seconds. children: [(name, start, end, attrs)]."""
    try:
        root = secrets.token_hex(8)
        clean = lambda a: {k: (v if isinstance(v, (str, bool)) else float(v)) for k, v in a.items() if v is not None}
        spans = [{"spanId": root, "name": name, "start": start * 1000, "end": end * 1000, "attrs": clean(attrs)}]
        for cname, cs, ce, ca in children:
            spans.append({"spanId": secrets.token_hex(8), "parentId": root, "name": cname,
                          "start": cs * 1000, "end": ce * 1000, "attrs": clean(ca)})
        body = json.dumps({"traceId": secrets.token_hex(16), "spans": spans}).encode()
        urllib.request.urlopen(urllib.request.Request(BRIDGE + "/api/otel/client", body,
                               {"Content-Type": "application/json"}), timeout=3).read()
    except Exception:
        pass

def emit_answer(rec, reconstructed=False):
    a = ARMS[rec["arm"]]
    emit("bench.answer", rec["start"], rec["end"], {
        "bench.arm": rec["arm"], "bench.arm.label": a["label"], "bench.prompt": float(rec["i"]),
        "bench.format": a["kind"], "bench.grammar": a["grammar"] or "none",
        "gen_ai.request.model": MODEL, "gen_ai.usage.output_tokens": float(rec["predicted"]),
        "llama.stop_type": rec["stop"], "llama.predicted_per_second": rec["tps"],
        "bench.runaway": rec["stop"] == "limit", "bench.reconstructed_timing": reconstructed},
        children=[("llama.decode", rec["end"] - rec["predicted_ms"] / 1000, rec["end"],
                   {"llama.predicted_ms": rec["predicted_ms"], "llama.tokens_predicted": float(rec["predicted"])})])

def post(path, body, timeout=300):
    req = urllib.request.Request(LLAMA + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def chat_prompt(system, user):
    # think off, exactly as the bridge does it
    return (f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n"
            f"<|im_start|>assistant\n<think>\n\n</think>\n\n")

# --- generation ---------------------------------------------------------------------------
def gen():
    OUT.mkdir(exist_ok=True)
    prompts = json.loads((HERE / "prompts.json").read_text())
    path = OUT / "answers.jsonl"
    done = {(r["arm"], r["i"]) for r in map(json.loads, path.read_text().splitlines())} if path.exists() else set()
    for i, p in enumerate(prompts):
        for name, arm in ARMS.items():
            if (name, i) in done:
                continue
            body = {"model": MODEL, "prompt": chat_prompt(arm["system"], p["q"]), "n_predict": N_PREDICT,
                    "temperature": TEMP, "stream": False, "seed": 1000 + i, "cache_prompt": True}
            if arm["grammar"]:
                body["grammar"] = G(arm["grammar"])
            t = time.time()
            try:
                r = post("/completion", body)
            except urllib.error.HTTPError as e:
                print(f"{name} #{i}: HTTP {e.code} {e.read().decode()[:120]}"); continue
            rec = {"arm": name, "i": i, "q": p["q"], "needs": p["needs"], "content": r["content"],
                   "stop": r["stop_type"], "predicted": r["tokens_predicted"], "wall": time.time() - t,
                   "start": t, "end": time.time(),
                   "predicted_ms": r["timings"]["predicted_ms"], "tps": r["timings"]["predicted_per_second"]}
            emit_answer(rec)
            with path.open("a") as f:
                f.write(json.dumps(rec) + "\n")
            print(f"{name:>3} #{i:<2} {r['tokens_predicted']:>4} tok  {rec['wall']:5.1f}s  stop={r['stop_type']:<5}  {p['q'][:50]}", flush=True)

# --- measurement ------------------------------------------------------------------------------
ALLOWED_TAGS = {"p","h2","h3","h4","ul","ol","li","blockquote","pre","code","hr","table","caption","thead","tbody","tr",
                "th","td","details","summary","dl","dt","dd","aside","menu","button","strong","em","sub","sup","del",
                "kbd","mark","small","br","a","abbr","template"}
ALLOWED_ATTRS = {"a": {"href"}, "abbr": {"title"}, "ol": {"start"}, "code": {"class"}, "th": {"colspan","rowspan","scope"},
                 "td": {"colspan","rowspan"}, "aside": {"class","role"}, "button": {"type","value"},
                 "template": {"data-widget","title"}}
BLOCK = {"p","h2","h3","h4","ul","ol","li","blockquote","pre","hr","table","caption","thead","tbody","tr","details",
         "summary","dl","dt","dd","aside","menu"}

class Checker(HTMLParser):
    def __init__(self):
        super().__init__(); self.violations = []; self.text = []; self.tags = set()
    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        if tag not in ALLOWED_TAGS:
            self.violations.append(f"<{tag}>")
        for k, v in attrs:
            if k not in ALLOWED_ATTRS.get(tag, set()):
                self.violations.append(f"<{tag} {k}>")
            if k == "href" and not re.match(r"(https://|mailto:|#)", v or ""):
                self.violations.append("bad href")
        if tag in BLOCK: self.text.append("\n")
        if tag in ("td", "th"): self.text.append(" | ")
    def handle_endtag(self, tag):
        if tag in BLOCK: self.text.append("\n")
    def handle_data(self, d): self.text.append(d)

def plain(kind, s):
    """A neutral rendering for the judge and for word counts: no markup of either kind."""
    if kind == "html":
        c = Checker(); c.feed(s); t = "".join(c.text)
    else:
        t = re.sub(r"```[a-z0-9+#_-]*\n", "\n", s)
        t = re.sub(r"^\s*#{1,4} ", "", t, flags=re.M)
        t = re.sub(r"^\s*>\s?", "", t, flags=re.M)
        t = re.sub(r"^\s*[-*] ", "", t, flags=re.M)
        t = re.sub(r"\*\*|\*|`", "", t)
        t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
        t = re.sub(r"^\|?\s*-{3}.*$", "", t, flags=re.M)
    return re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t]+", " ", t)).strip()

def has(kind, s, feat):
    if kind == "html":
        c = Checker(); c.feed(s)
        return {"table": "table" in c.tags, "code": "pre" in c.tags, "callout": "aside" in c.tags,
                "list": bool(c.tags & {"ul", "ol", "dl"})}[feat]
    return {"table": bool(re.search(r"^\|.*\|\s*$\n^\|?\s*:?-{3}", s, re.M)), "code": "```" in s,
            "callout": bool(re.search(r"^>\s", s, re.M)), "list": bool(re.search(r"^\s*(-|\d+\.)\s", s, re.M))}[feat]

def runaway(rec):
    if rec["stop"] == "limit":
        return True
    lines = [l.strip() for l in re.split(r"[\n>]", rec["content"]) if len(l.strip()) >= 40]
    return any(lines.count(l) >= 6 for l in set(lines))

def tokens(s):
    return len(post("/tokenize", {"content": s, "add_special": False, "model": MODEL})["tokens"])

def judge(q, a, b):
    prompt = chat_prompt("You are a careful, impartial evaluator.",
        f"Question: {q}\n\nAnswer A:\n{a}\n\nAnswer B:\n{b}\n\n"
        "Which answer is more helpful, accurate and complete for the question? Ignore formatting and length. "
        "Reply with exactly one word: A, B or TIE.")
    r = post("/completion", {"model": MODEL, "prompt": prompt, "n_predict": 4, "temperature": 0, "stream": False, "seed": 1})
    w = r["content"].strip().upper()
    return "A" if w.startswith("A") else "B" if w.startswith("B") else "TIE"

BASELINE = {"D3": "D5", "D6": "D5"}   # controlled comparisons; everything else is judged against S0

def analyze():
    rows = [json.loads(l) for l in (OUT / "answers.jsonl").read_text().splitlines()]
    by = {}
    for r in rows:
        by.setdefault(r["arm"], {})[r["i"]] = r
    n_prompts = len(json.loads((HERE / "prompts.json").read_text()))

    # judge: every arm against S0, both orders
    jpath = OUT / "judge.jsonl"
    jdone = {(j["arm"], j["i"], j["order"]) for j in map(json.loads, jpath.read_text().splitlines())} if jpath.exists() else set()
    for name in ARMS:
        bname = BASELINE.get(name, "S0")
        if name == bname: continue
        for i in range(n_prompts):
            if i not in by.get(name, {}) or i not in by.get(bname, {}): continue
            x, y = by[name][i], by[bname][i]
            px, py = plain(ARMS[name]["kind"], x["content"]), plain(ARMS[bname]["kind"], y["content"])
            for order in ("x_first", "y_first"):
                if (name, i, order) in jdone: continue
                a, b = (px, py) if order == "x_first" else (py, px)
                jt0 = time.time()
                w = judge(x["q"], a, b)
                won = "arm" if (w == "A") == (order == "x_first") and w != "TIE" else "base" if w != "TIE" else "tie"
                emit("bench.judge", jt0, time.time(), {"bench.arm": name, "bench.prompt": float(i),
                     "bench.order": order, "bench.winner": won, "gen_ai.request.model": MODEL})
                with jpath.open("a") as f:
                    f.write(json.dumps({"arm": name, "i": i, "order": order, "winner": won}) + "\n")
    judged = [json.loads(l) for l in jpath.read_text().splitlines()] if jpath.exists() else []

    summary = {}
    for name, arm in ARMS.items():
        recs = list(by.get(name, {}).values())
        if not recs: continue
        toks = [tokens(r["content"]) for r in recs]
        words = [max(1, len(plain(arm["kind"], r["content"]).split())) for r in recs]
        need = [(r, f) for r in recs for f in r["needs"]]
        viol = 0
        if arm["kind"] == "html":
            for r in recs:
                c = Checker(); c.feed(r["content"]); viol += bool(c.violations)
        else:
            viol = sum(bool(re.search(r"<[a-zA-Z/]|!\[|\]\((?!https://|mailto:|#)", r["content"])) for r in recs)
        js = [j for j in judged if j["arm"] == name]
        summary_base = BASELINE.get(name, "S0")
        summary[name] = {
            "label": arm["label"], "n": len(recs),
            "tokens_mean": sum(toks) / len(toks), "words_mean": sum(words) / len(words),
            "tok_per_word": sum(toks) / sum(words),
            "gen_s_mean": sum(r["predicted_ms"] for r in recs) / len(recs) / 1000,
            "tps": sum(r["tps"] for r in recs) / len(recs),
            "runaway": sum(runaway(r) for r in recs),
            "compliance": (sum(has(arm["kind"], r["content"], f) for r, f in need), len(need)),
            "violations": viol,
            "judge": {k: sum(1 for j in js if j["winner"] == k) for k in ("arm", "tie", "base")},
            "judge_base": summary_base,
        }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(report(summary))

def report(s):
    base = s["S0"]["tok_per_word"]; md = s.get("M2", {}).get("tok_per_word", 1)
    L = ["| arm | n | tokens/answer | tokens per word | vs strict HTML | vs free Markdown | decode s/answer | runaway | asked-for present | invalid | judge vs S0 (win/tie/loss) |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    for k, v in s.items():
        j = v["judge"]; jt = "n/a (baseline)" if k == v["judge_base"] else f"{j['arm']}/{j['tie']}/{j['base']} vs {v['judge_base']}"
        L.append(f"| **{k}** {v['label']} | {v['n']} | {v['tokens_mean']:.0f} | {v['tok_per_word']:.2f} | "
                 f"{v['tok_per_word']/base:.2f}× | {v['tok_per_word']/md:.2f}× | {v['gen_s_mean']:.1f} | {v['runaway']}/{v['n']} | "
                 f"{v['compliance'][0]}/{v['compliance'][1]} | {v['violations']}/{v['n']} | {jt} |")
    return "\n".join(L)

def backfill():
    """Emit traces for answers generated before timing was recorded. Their start times are
    reconstructed by laying the recorded durations end to end from `--start <unix seconds>`;
    each trace says so (bench.reconstructed_timing)."""
    t = float(sys.argv[sys.argv.index("--start") + 1])
    n = 0
    for line in (OUT / "answers.jsonl").read_text().splitlines():
        r = json.loads(line)
        if "start" in r:
            continue
        r["start"], r["end"] = t, t + r["wall"]
        t = r["end"]
        emit_answer(r, reconstructed=True); n += 1
    print("emitted", n, "reconstructed traces")

if __name__ == "__main__":
    {"gen": gen, "analyze": analyze, "backfill": backfill}[sys.argv[1] if len(sys.argv) > 1 else "gen"]()
