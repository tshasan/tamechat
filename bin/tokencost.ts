import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compact } from '../src/compact.ts';
import { Llama, type Span } from '../src/llama.ts';
import { toMarkdown } from '../src/markdown.ts';
import { subset } from '../src/subset.ts';
import { validate } from '../src/validate.ts';

const { values } = parseArgs({
  options: {
    llama: { type: 'string', default: 'http://127.0.0.1:8081' },
    model: { type: 'string', default: '' },
    corpus: { type: 'string', default: 'corpus/answers-qwen3.6-35b.json' },
    vocab: { type: 'string', default: 'spec/token-vocab.txt' },
    v: { type: 'boolean', default: false },
  },
});

const tagPattern = /<\/?[a-zA-Z][a-zA-Z0-9]*[^<>]*>/g;

function readVocab(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .sort((a, b) => b.length - a.length);
}

function project(doc: string, spans: Span[], vocab: string[] | null): number {
  const latin = Buffer.from(doc).toString('latin1');
  const claimed = new Array<boolean>(spans.length).fill(false);
  let total = spans.length;
  for (const m of latin.matchAll(tagPattern)) {
    const start = m.index;
    let end = start + m[0].length;
    if (vocab) {
      const tag = m[0];
      const entry = vocab.find((e) => tag === e || ((e.endsWith('"') || e.endsWith('-')) && tag.startsWith(e)));
      if (entry === undefined) continue;
      end = start + Buffer.byteLength(entry);
    }
    let n = 0;
    spans.forEach((s, i) => {
      if (s.end > start && s.start < end && !claimed[i]) {
        claimed[i] = true;
        n++;
      }
    });
    if (n > 1) total -= n - 1;
  }
  return total;
}

const answers = JSON.parse(readFileSync(values.corpus, 'utf8')) as string[];
const vocab = readVocab(values.vocab);
const llama = new Llama(values.llama, values.model);

let strict = 0;
let compactTokens = 0;
let markdown = 0;
let projectedVocab = 0;
let projectedAll = 0;
let used = 0;
let skipped = 0;

for (const [i, answer] of answers.entries()) {
  const strictViolations = validate(subset, answer, { profile: 'strict', widgets: false });
  if (strictViolations.length > 0) {
    skipped++;
    console.error(`skipping answer ${i}: not valid strict HTML (${strictViolations[0]?.detail})`);
    continue;
  }
  const c = compact(subset, answer);
  if (validate(subset, c, { profile: 'compact', widgets: false }).length > 0 || toMarkdown(answer) !== toMarkdown(c)) {
    skipped++;
    console.error(`skipping answer ${i}: the compact form is not the same document`);
    continue;
  }
  const strictSpans = await llama.tokenize(answer);
  const compactSpans = await llama.tokenize(c);
  const mdCount = await llama.count(toMarkdown(answer));
  const pv = project(c, compactSpans, vocab);
  const pa = project(c, compactSpans, null);
  strict += strictSpans.length;
  compactTokens += compactSpans.length;
  markdown += mdCount;
  projectedVocab += pv;
  projectedAll += pa;
  used++;
  if (values.v) console.log(`answer ${String(i).padStart(2)}: strict ${strictSpans.length}  compact ${compactSpans.length}  one-token tags ${pv}  markdown ${mdCount}`);
}

if (used === 0) {
  console.error('no answer could be measured');
  process.exit(1);
}

const row = (label: string, status: string, n: number) =>
  console.log(`  ${label.padEnd(46)} ${status.padEnd(10)} ${String(n).padStart(6)} tokens  ${(n / markdown).toFixed(2)}x Markdown  ${(100 * (n - strict) / strict).toFixed(0).padStart(4)}% vs strict`);

console.log(`${used} answers measured (${skipped} skipped), tokenizer: ${values.llama}\n`);
console.log(`  ${'Markdown (estimate of the same content)'.padEnd(46)} ${'estimate'.padEnd(10)} ${String(markdown).padStart(6)} tokens  1.00x Markdown`);
row('strict HTML, as generated', 'measured', strict);
row('compact HTML (same documents, checked)', 'measured', compactTokens);
row(`compact + single-token tags (${vocab.length} listed forms)`, 'PROJECTED', projectedVocab);
row('compact + every tag a single token (upper bound)', 'PROJECTED', projectedAll);
console.log('\nMeasured lines use this tokenizer on real text. PROJECTED lines assume a tokenizer that does not exist yet.');
