import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { bodyOf, type AnswerRecord } from '../src/conform.ts';
import type { Measured } from '../test/render/harness.ts';

const root = join(import.meta.dirname, '..');
const usage = 'usage: render RUN_DIR|answers.jsonl... [--engines chromium,firefox,webkit] [--chunk 4] [--summary FILE]';
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engines: { type: 'string', default: 'chromium,firefox,webkit' },
    chunk: { type: 'string', default: '4' },
    summary: { type: 'string', default: '' },
  },
});
if (positionals.length === 0) {
  console.error(usage);
  process.exit(1);
}

function answerFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? answerFiles(join(path, d.name)) : d.name === 'answers.jsonl' ? [join(path, d.name)] : [],
  );
}

const files = positionals.flatMap(answerFiles).sort();
const chosen = values.engines.split(',').filter((e) => e in engines);
const chunk = Number(values.chunk);

const bundle = await build({ entryPoints: [join(root, 'test', 'render', 'harness.ts')], bundle: true, format: 'esm', target: 'es2022', write: false });
const script = bundle.outputFiles[0]?.text ?? '';
const page = '<!doctype html><meta charset=utf-8><body></body><script type=module src=/h.js></script>';
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': req.url === '/h.js' ? 'text/javascript' : 'text/html' });
  res.end(req.url === '/h.js' ? script : page);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

interface Row extends Measured {
  label: string;
  profile: string;
  grammar: boolean;
  prompt: number;
  sample: number;
  valid: boolean;
  engine: string;
  engineVersion: string;
  errors: string[];
}

const rowsByFile = new Map<string, Row[]>(files.map((f) => [f, []]));
const versions: Record<string, string> = {};

for (const name of chosen) {
  const browser = await (engines[name] as BrowserType).launch();
  versions[name] = browser.version();
  const tab = await browser.newPage();
  const errors: string[] = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await tab.goto(url);
  await tab.waitForFunction(() => window.renderReady);
  for (const file of files) {
    const answers = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AnswerRecord);
    for (const a of answers) {
      if (a.error !== null || a.format === 'markdown') continue;
      errors.length = 0;
      const m = await tab.evaluate(([h, c]) => window.measure(h as string, c as number), [bodyOf(a.content), chunk] as const);
      rowsByFile.get(file)?.push({
        label: a.label,
        profile: a.profile,
        grammar: a.grammar,
        prompt: a.prompt,
        sample: a.sample,
        valid: a.valid,
        engine: name,
        engineVersion: versions[name] ?? '',
        errors: [...errors],
        ...m,
      });
    }
  }
  await browser.close();
  console.log(`${name} ${versions[name]}: done`);
}
server.close();

for (const [file, rows] of rowsByFile) writeFileSync(join(dirname(file), 'render.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

// One row per (run, engine), plus whether the engines agree on each answer.
const all = [...rowsByFile.values()].flat();
const key = (r: Row) => `${r.label}|${r.profile}|${r.grammar}`;
const groups = new Map<string, Row[]>();
for (const r of all) groups.set(`${key(r)}|${r.engine}`, [...(groups.get(`${key(r)}|${r.engine}`) ?? []), r]);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const lines = [
  `engines: ${chosen.map((e) => `${e} ${versions[e]}`).join(', ')}; streamed in ${chunk}-character chunks`,
  '',
  '| run | profile | grammar | engine | answers | valid subset | tamechat text kept | tamechat tags kept | streamed = whole | DOMPurify tags kept | setHTML tags kept | page errors |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const rows of groups.values()) {
  const r0 = rows[0] as Row;
  const n = rows.length;
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const native = rows.filter((r) => r.native !== null);
  lines.push(
    `| ${r0.label} | ${r0.profile} | ${r0.grammar ? 'yes' : 'no'} | ${r0.engine} | ${n} | ${pct(count((r) => r.valid), n)} | ${pct(count((r) => r.tamechat.textKept), n)} | ${pct(count((r) => r.tamechat.tagsKept), n)} | ${pct(count((r) => r.streamed.equal), n)} | ${pct(count((r) => r.purify.tagsKept), n)} | ${native.length ? pct(native.filter((r) => r.native?.tagsKept).length, native.length) : 'n/a'} | ${count((r) => r.errors.length > 0)} |`,
  );
}

// Cross-engine: the same answer should parse and render to the same DOM everywhere.
const byAnswer = new Map<string, Row[]>();
for (const r of all) {
  const k = `${key(r)}|${r.prompt}|${r.sample}`;
  byAnswer.set(k, [...(byAnswer.get(k) ?? []), r]);
}
const complete = [...byAnswer.values()].filter((rs) => rs.length === chosen.length);
const agree = (f: (r: Row) => string) => complete.filter((rs) => new Set(rs.map(f)).size === 1).length;
lines.push(
  '',
  `answers rendered in all ${chosen.length} engines: ${complete.length}`,
  `  raw parse identical across engines:        ${agree((r) => r.ref.hash)}/${complete.length}`,
  `  tamechat output identical across engines:  ${agree((r) => r.tamechat.hash)}/${complete.length}`,
  `  DOMPurify output identical across engines: ${agree((r) => r.purify.hash)}/${complete.length}`,
);
const droppedByNative = new Map<string, number>();
for (const r of all) for (const t of r.native?.dropped ?? []) droppedByNative.set(`${r.engine}:${t}`, (droppedByNative.get(`${r.engine}:${t}`) ?? 0) + 1);
if (droppedByNative.size) {
  lines.push('', 'tags setHTML() removed from model answers (engine:tag answers):');
  for (const [t, c] of [...droppedByNative].sort((a, b) => b[1] - a[1])) lines.push(`  ${t} ${c}`);
}

const summary = lines.join('\n');
console.log(`\n${summary}`);
if (values.summary) writeFileSync(values.summary, `${summary}\n`);
