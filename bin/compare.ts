import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import type { Tool } from '../test/compare/harness.ts';

const root = join(import.meta.dirname, '..');
const cases = join(root, 'conformance', 'cases');
const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const jsonOut = arg('--json');
const engineName = arg('--engine') ?? 'chromium';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) throw new Error('--engine must be chromium, firefox or webkit');

function load(dir: string) {
  return readdirSync(join(cases, dir))
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => ({ name: `${dir}/${f.slice(0, -5)}`, html: readFileSync(join(cases, dir, f), 'utf8') }));
}

const attacks = load('attack');
const documents = [...load('good'), ...load('compact')];

const labels: Record<Tool, string> = {
  none: 'no defence (control)',
  escape: 'escape everything',
  purify: 'DOMPurify default',
  native: 'browser setHTML()',
  'native-chat': 'setHTML() + 3 elements',
  tamechat: 'tamechat renderer',
};

const bundle = await build({ entryPoints: [join(root, 'test', 'compare', 'harness.ts')], bundle: true, format: 'esm', target: 'es2022', write: false });
const script = bundle.outputFiles[0]?.text ?? '';
const page = '<!doctype html><meta charset=utf-8><div id=out></div><script type=module src=/h.js></script>';

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': req.url === '/h.js' ? 'text/javascript' : 'text/html' });
  res.end(req.url === '/h.js' ? script : page);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const browser = await engine.launch();
const context = await browser.newContext();
const tab = await context.newPage();
const hits: string[] = [];
await tab.route(/evil\.example/, (r) => {
  hits.push(r.request().url());
  void r.abort();
});
tab.on('dialog', (d) => {
  hits.push(`dialog:${d.message()}`);
  void d.dismiss();
});
tab.on('popup', () => hits.push('popup'));

async function fresh() {
  await tab.goto(url);
  await tab.waitForFunction(() => window.compareReady);
}
await fresh();

const nativeSupported = await tab.evaluate(() => window.nativeSupported);
const tools = (Object.keys(labels) as Tool[]).filter((t) => !t.startsWith('native') || nativeSupported);
const version = browser.version();

type Row = { tool: Tool; held: number; failed: string[]; textKept: number; tagsKept: number };
const rows: Row[] = [];

for (const tool of tools) {
  const failed: string[] = [];
  for (const attack of attacks) {
    hits.length = 0;
    await tab.evaluate(() => {
      (window as unknown as { __pwned: number }).__pwned = 0;
    });
    await tab.evaluate(([h, t]) => window.sanitizeWith(h as string, t as Tool), [attack.html, tool]);
    await tab.waitForTimeout(120);
    const pwned = await tab.evaluate(() => (window as unknown as { __pwned: number }).__pwned);
    const navigated = tab.url() !== url;
    const why = [pwned && 'script ran', hits.length && 'request to evil.example', navigated && 'navigated'].filter(Boolean);
    if (why.length) failed.push(`${attack.name.slice(7)} (${why.join(', ')})`);
    if (navigated) await fresh();
  }

  let textKept = 0;
  let tagsKept = 0;
  for (const doc of documents) {
    const result = await tab.evaluate(
      ([h, t]) => {
        window.sanitizeWith(h as string, t as Tool);
        const el = document.getElementById('out') as HTMLElement;
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        const probe = document.createElement('template');
        probe.innerHTML = h as string;
        const want = norm(probe.content.textContent ?? '');
        const wantTags = window.tagsOf(h as string).join(',');
        const gotTags = window.tagsOf(el.innerHTML).join(',');
        return { text: norm(el.textContent ?? '') === want, tags: gotTags === wantTags };
      },
      [doc.html, tool],
    );
    if (result.text) textKept++;
    if (result.tags) tagsKept++;
  }
  rows.push({ tool, held: attacks.length - failed.length, failed, textKept, tagsKept });
}

await browser.close();
server.close();

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${engineName} ${version}, ${attacks.length} attacks, ${documents.length} valid documents\n`);
console.log(`| ${pad('tool', 22)} | ${pad('attacks contained', 17)} | ${pad('text kept', 9)} | ${pad('structure kept', 14)} |`);
console.log(`|${'-'.repeat(24)}|${'-'.repeat(19)}|${'-'.repeat(11)}|${'-'.repeat(16)}|`);
for (const r of rows) {
  console.log(`| ${pad(labels[r.tool], 22)} | ${pad(`${r.held}/${attacks.length}`, 17)} | ${pad(`${r.textKept}/${documents.length}`, 9)} | ${pad(`${r.tagsKept}/${documents.length}`, 14)} |`);
}
if (!nativeSupported) console.log('\nsetHTML() is not available in this browser, so it was skipped.');
for (const r of rows) {
  if (r.failed.length && r.tool !== 'none') {
    console.log(`\n${labels[r.tool]} let through:`);
    for (const f of r.failed) console.log(`  - ${f}`);
  }
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ engine: engineName, browser: version, attacks: attacks.length, documents: documents.length, rows }, null, 2)}\n`);
