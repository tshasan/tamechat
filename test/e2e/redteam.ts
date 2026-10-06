import { readdirSync, readFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { Browser } from 'playwright';
import type { Fake } from './fake.ts';

type Mode = 'raw' | 'whole' | 'stream' | 'markdown';

const attackDir = join(import.meta.dirname, '..', '..', 'conformance', 'cases', 'attack');
const attacks = readdirSync(attackDir)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((f) => ({ name: f.slice(0, -5), html: readFileSync(join(attackDir, f), 'utf8') }));

const page = '<!doctype html><meta charset=utf-8><div id=out></div><script type=module src=/rt.js></script>';

async function bundle(): Promise<string> {
  const result = await build({ entryPoints: [join(import.meta.dirname, 'harness.ts')], bundle: true, format: 'esm', target: 'es2022', write: false });
  return result.outputFiles[0]?.text ?? '';
}

function serve(script: string, csp: string | null): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const headers: Record<string, string> = csp ? { 'Content-Security-Policy': csp } : {};
      if (req.url === '/rt.js') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' });
        res.end(script);
      } else {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
        res.end(page);
      }
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function layer(browser: Browser, script: string, title: string, csp: string | null, modes: Mode[]): Promise<number> {
  const server = await serve(script, csp);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rt.html`;
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
  await tab.goto(url);
  await tab.waitForFunction(() => window.ready, null, { timeout: 5000 });
  console.log(`\n${title}`);

  let leaks = 0;
  for (const mode of modes) {
    const bad: string[] = [];
    const inert: string[] = [];
    for (const attack of attacks) {
      hits.length = 0;
      await tab.evaluate(() => {
        (window as unknown as { __pwned: number }).__pwned = 0;
      });
      await tab.evaluate(([html, m]) => window.run(html as string, m as Mode), [attack.html, mode]);
      await tab.waitForTimeout(150);
      const pwned = await tab.evaluate(() => (window as unknown as { __pwned: number }).__pwned);
      const navigated = tab.url() !== url;
      const dom = !navigated && (await tab.evaluate(() => /on\w+\s*=|javascript:/i.test(document.getElementById('out')?.innerHTML ?? '')).catch(() => true));
      const why = [pwned && 'script ran', hits.length && 'request to evil.example', navigated && 'navigated', dom && mode !== 'markdown' && 'handler/javascript: left in DOM'].filter(Boolean);
      if (why.length) bad.push(`${attack.name} (${why.join(', ')})`);
      else if (dom) inert.push(attack.name);
      if (navigated) {
        await tab.goto(url);
        await tab.waitForFunction(() => window.ready);
      }
    }
    console.log(`  ${mode.padEnd(6)} ${bad.length ? `HOLES ${bad.length}` : `all ${attacks.length} contained`}`);
    for (const b of bad) console.log(`         - ${b}`);
    if (inert.length) console.log(`         inert handler text left in the DOM, nothing ran: ${inert.join(', ')}`);
    leaks += bad.length;
  }
  await context.close();
  server.close();
  return leaks;
}

function headerOf(base: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    get(base, (r) => {
      r.resume();
      resolve(r.headers['content-security-policy'] as string | undefined);
    }),
  );
}

async function widgetLayer(browser: Browser, base: string, fake: Fake): Promise<number> {
  console.log('\nLayer 3: hostile widget inside the sandbox');
  let holes = 0;
  const context = await browser.newContext();
  const tab = await context.newPage();
  const hits: string[] = [];
  await tab.route(/evil\.example/, (r) => {
    hits.push(r.request().url());
    void r.abort();
  });
  tab.on('popup', () => hits.push('popup'));
  await tab.goto(base);
  await tab.waitForFunction(() => !/connecting/.test(document.querySelector('#backend')?.textContent ?? ''));
  await tab.fill('#input', 'widgetprobe');
  await tab.click('#send');

  let result: Record<string, unknown> | undefined;
  for (let i = 0; i < 60 && !result; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const messages = fake.seen.map((s) => (s.body.messages as { content: string }[]).at(-1)?.content ?? '');
    const found = messages.find((c) => c.startsWith('PROBE-RESULT '));
    if (found) result = JSON.parse(found.slice('PROBE-RESULT '.length)) as Record<string, unknown>;
  }
  if (!result) {
    console.log('  FAIL: the widget never reported (did it run at all?)');
    holes++;
  } else {
    const contained = new Set(['nested-iframe-script']);
    for (const [k, v] of Object.entries(result)) {
      const bad = typeof v === 'string' && v.startsWith('ALLOWED') && !contained.has(k);
      if (bad) holes++;
      console.log(`  ${bad ? 'HOLE   ' : 'ok     '} ${k.padEnd(22)} ${v}`);
    }
    if (tab.url() !== `${base}/` && tab.url() !== base) {
      holes++;
      console.log(`  HOLE    the widget navigated the top page to ${tab.url()}`);
    }
    if (hits.length) {
      holes++;
      console.log(`  HOLE    requests left the sandbox: ${hits.join(', ')}`);
    }
    console.log('  by design: a widget can call sendPrompt, i.e. speak as the user (capped at 2000 chars, no confirmation).');
  }
  await context.close();
  return holes;
}

export async function redteam(browser: Browser, base: string, fake: Fake): Promise<number> {
  const script = await bundle();

  const control = await layer(browser, script, 'Control: raw innerHTML, no defences (must show holes)', null, ['raw']);
  if (control < 5) {
    console.log(`\nFAIL: control found only ${control} holes; the detector is not working`);
    return 1;
  }

  let holes = await layer(browser, script, 'Layer 1: sanitizer alone, no CSP', null, ['whole', 'stream']);
  holes += await layer(browser, script, 'Baseline: the same attacks through marked + DOMPurify, no CSP', null, ['markdown']);

  const csp = await headerOf(base);
  if (csp) {
    console.log(`\nCSP under test: ${csp}`);
    const through = await layer(browser, script, 'Layer 2: CSP alone, raw innerHTML (informational)', csp, ['raw']);
    console.log(`  (${through} vectors get through CSP alone; the sanitizer is what stops them)`);
  }

  holes += await widgetLayer(browser, base, fake);
  console.log(holes ? `\nFAIL: ${holes} holes` : '\nPASS: every layer held');
  return holes;
}
