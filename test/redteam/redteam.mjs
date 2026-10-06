// Red team: each defence layer attacked ALONE with the attack corpus, so a hole in one layer
// is visible instead of hidden behind the others.
//   Layer 1  sanitizer only   (no CSP, real StreamRenderer, whole and 1-char-at-a-time)
//   Layer 2  CSP only         (raw innerHTML under the CSP the server sends; needs BASE)
// Needs Playwright. Run from the repo root:  node test/redteam/redteam.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const attackDir = path.join(root, 'conformance', 'cases', 'attack');
const attacks = fs.readdirSync(attackDir).filter((f) => f.endsWith('.html')).sort()
  .map((f) => ({ name: f.slice(0, -5), html: fs.readFileSync(path.join(attackDir, f), 'utf8') }));

const SCRIPT = `
import { loadSubset } from '/subset.js';
import { StreamRenderer } from '/render.js';
const subset = await loadSubset('/subset.json');
window.run = (html, mode) => {
  const out = document.getElementById('out'); out.replaceChildren();
  if (mode === 'raw') { out.innerHTML = html; return; }
  const r = new StreamRenderer(out, subset, () => {});
  if (mode === 'whole') { r.push(html); r.render(); r.finish(); return; }
  for (const ch of html) { r.push(ch); r.render(); }   // as a slow stream would
  r.finish();
};
window.ready = true;
`;
const PAGE = '<!doctype html><meta charset=utf-8><div id=out></div><script type=module src=/rt.js></script>';

const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
function serve(csp) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const h = { 'Content-Type': 'text/html' };
      if (csp) h['Content-Security-Policy'] = csp;
      if (u === '/rt.html') { res.writeHead(200, h); return res.end(PAGE); }
      if (u === '/rt.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', ...(csp && { 'Content-Security-Policy': csp }) }); return res.end(SCRIPT); }
      const file = u === '/subset.json' ? path.join(root, 'spec', 'subset.json') : path.join(root, 'web', u);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain', ...(csp && { 'Content-Security-Policy': csp }) });
      res.end(fs.readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

const browser = await chromium.launch();
let holes = 0;
async function layer(title, csp, modes) {
  const srv = await serve(csp);
  const url = `http://127.0.0.1:${srv.address().port}/rt.html`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const hits = [];
  await page.route(/evil\.example/, (r) => { hits.push(r.request().url()); r.abort(); });
  page.on('dialog', (d) => { hits.push('dialog:' + d.message()); d.dismiss(); });
  page.on('popup', () => hits.push('popup'));
  page.on('console', () => {});
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 5000 });
  console.log(`\n${title}`);
  let leaks = 0;
  for (const mode of modes) {
    const bad = [];
    for (const a of attacks) {
      hits.length = 0;
      await page.evaluate(() => { window.__pwned = 0; });
      await page.evaluate(([h, m]) => window.run(h, m), [a.html, mode]);
      await page.waitForTimeout(150);
      const pwned = await page.evaluate(() => window.__pwned);
      const nav = page.url() !== url;                      // meta refresh, form/top navigation
      const dom = !nav && await page.evaluate(() => /on\w+\s*=|javascript:/i.test(document.getElementById('out')?.innerHTML ?? '')).catch(() => true);
      const why = [pwned && 'script ran', hits.length && 'request to evil.example', nav && 'navigated', dom && 'handler/javascript: left in DOM'].filter(Boolean);
      if (why.length) bad.push(`${a.name} (${why.join(', ')})`);
      if (nav) await page.goto(url).then(() => page.waitForFunction(() => window.ready));
    }
    console.log(`  ${mode.padEnd(6)} ${bad.length ? 'HOLES ' + bad.length : 'all ' + attacks.length + ' contained'}`);
    bad.forEach((b) => console.log('         -', b));
    leaks += bad.length;
  }
  await ctx.close(); srv.close();
  return leaks;
}

// Positive control: with no defence at all the detector must see holes, or a pass above means nothing.
const control = await layer('Control: raw innerHTML, no defences (must show holes)', null, ['raw']);
if (control < 5) { console.log(`\nFAIL: control found only ${control} holes; the detector is not working`); process.exit(2); }

// Layer 1 must be perfect: it is the only thing standing between a hosted model and the DOM.
holes += await layer('Layer 1: sanitizer alone, no CSP', null, ['whole', 'stream']);

// Layer 2 is reported, not asserted: CSP does not stop everything (e.g. meta refresh), and saying so is the point.
const base = process.env.BASE;
if (base) {
  const csp = await new Promise((res) => http.get(base, (r) => { r.resume(); res(r.headers['content-security-policy']); }));
  if (csp) {
    console.log('\nCSP under test:', csp);
    const l2 = await layer('Layer 2: CSP alone, raw innerHTML (informational)', csp, ['raw']);
    console.log(`  (${l2} vectors get through CSP alone; the sanitizer is what stops them)`);
  } else console.log('\nLayer 2 skipped: server sent no CSP header');
} else console.log('\nLayer 2 skipped: set BASE=http://127.0.0.1:8090 to read the real CSP');

// Layer 3: a widget is model-written JavaScript that DOES run, so attack from inside it.
// Needs the fake backend (test/e2e/fakebackend.py) behind BASE; results come back through the
// one channel a widget has, sendPrompt, and are read from what the backend was sent.
const fake = process.env.FAKE;
if (base && fake) {
  console.log('\nLayer 3: hostile widget inside the sandbox');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const hits = [];
  await page.route(/evil\.example/, (r) => { hits.push(r.request().url()); r.abort(); });
  page.on('popup', () => hits.push('popup'));
  await page.goto(base);
  await page.waitForFunction(() => !/connecting/.test(document.querySelector('#backend').textContent));
  await page.fill('#input', 'widgetprobe');
  await page.click('#send');
  let result;
  for (let i = 0; i < 60 && !result; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const seen = await (await fetch(fake + '/seen')).json();
    const m = seen.map((x) => x.body.messages.at(-1).content).find((c) => c.startsWith('PROBE-RESULT '));
    if (m) result = JSON.parse(m.slice('PROBE-RESULT '.length));
  }
  if (!result) { console.log('  FAIL: the widget never reported (did it run at all?)'); holes++; }
  else {
    const contained = new Set(['nested-iframe-script']);   // a frame inside the sandbox is still the sandbox
    for (const [k, v] of Object.entries(result)) {
      const bad = typeof v === 'string' && v.startsWith('ALLOWED') && !contained.has(k);
      if (bad) holes++;
      console.log(`  ${bad ? 'HOLE   ' : 'ok     '} ${k.padEnd(22)} ${v}`);
    }
    const moved = page.url() !== base + '/' && page.url() !== base;
    if (moved) { holes++; console.log('  HOLE    the widget navigated the top page to', page.url()); }
    if (hits.length) { holes++; console.log('  HOLE    requests left the sandbox:', hits.join(', ')); }
    console.log('  by design: a widget can call sendPrompt, i.e. speak as the user (capped at 2000 chars, no confirmation).');
  }
  await ctx.close();
} else console.log('\nLayer 3 skipped: set BASE and FAKE (fake backend) to run the widget probe');

await browser.close();
console.log(holes ? `\nFAIL: sanitizer let ${holes} through` : '\nPASS: the sanitizer alone contains every attack in the corpus');
process.exit(holes ? 1 : 0);
