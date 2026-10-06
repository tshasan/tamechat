// End-to-end test of the demo page against a fake backend. Needs Playwright:
//   npm i playwright && npx playwright install chromium
//   python3 test/e2e/fakebackend.py 8099 &
//   go run ./cmd/serve -addr 127.0.0.1:8090 -backend http://127.0.0.1:8099/v1 -model fake -key-env FAKE_KEY &
//   FAKE_KEY=k node test/e2e/e2e.mjs
import { chromium } from 'playwright';
import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8099';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(BASE);
await page.waitForFunction(() => !/connecting/.test(document.querySelector('#backend').textContent));
const backendLabel = await page.textContent('#backend');
check('page shows which backend it is using', /127\.0\.0\.1:8099/.test(backendLabel), backendLabel);

const done = (n) => page.waitForFunction((n) => document.querySelectorAll('article').length === n && !document.querySelector('#send').hidden && /characters of HTML|Stopped|Error/.test([...document.querySelectorAll('.meta')].at(-1).textContent), n, { timeout: 30000 });
const ask = async (t) => { await page.fill('#input', t); await page.click('#send'); };

// ---- a compact document: omitted end tags, no whitespace, no scope/role/type
await ask('compact please');
await page.waitForFunction(() => document.querySelector('article .answer p'), null, { timeout: 5000 });
const busyWhileFirstBlockShown = await page.evaluate(() => !document.querySelector('#stop').hidden);
check('the first block renders while the answer is still streaming', busyWhileFirstBlockShown);
await done(1);
const a = page.locator('article').first();
const shape = await a.locator('.answer').evaluate((el) => ({
  tables: el.querySelectorAll('table').length, thead: el.querySelectorAll('thead').length, tbody: el.querySelectorAll('tbody').length,
  th: el.querySelectorAll('th').length, td: el.querySelectorAll('td').length, rows: el.querySelectorAll('tr').length,
  li: el.querySelectorAll('ul li').length, ps: el.querySelectorAll(':scope > p').length,
  scopes: [...el.querySelectorAll('th')].map((t) => t.getAttribute('scope')).join(','),
  aside: el.querySelector('aside')?.getAttribute('role'), button: el.querySelector('menu button')?.getAttribute('type'),
  caption: el.querySelector('caption')?.textContent,
}));
check('omitted end tags are put back: one table, 1 thead, 1 tbody, 3 rows', shape.tables === 1 && shape.thead === 1 && shape.tbody === 1 && shape.rows === 3, JSON.stringify(shape));
check('cells are all there (5 th, 4 td)', shape.th === 5 && shape.td === 4);
check('list with omitted </li> has three items', shape.li === 3);
check('both paragraphs survive (one before the table, one after)', shape.ps === 2, String(shape.ps));
check('scope is filled in: col in the header row, row for row headers', shape.scopes === 'col,col,col,row,row', shape.scopes);
check('role and type are filled in on aside and button', shape.aside === 'note' && shape.button === 'button', `${shape.aside}/${shape.button}`);
check('the table caption is kept', shape.caption === 'Speed');
const think = await a.locator('.thinking').isVisible();
check('reasoning from the backend shows in a thinking panel', think);

await page.check('input[value="source"]');
const src = await a.locator('.source').textContent();
check('source view shows the compact HTML exactly as sent', src.startsWith('<p>Here is a comparison.<table><caption>Speed</caption>') && !/\n/.test(src) && !src.includes('</td>'), src.slice(0, 70));
await page.check('input[value="rendered"]');

// ---- themes: the same answer restyled in an isolated, script-free frame
await page.selectOption('#theme', 'pico');
await page.waitForFunction(() => document.querySelector('article iframe.themed')?.contentDocument?.querySelector('link[data-theme]')?.sheet, null, { timeout: 5000 });
const themed = await a.locator('iframe.themed').evaluate((f) => ({
  link: f.contentDocument.querySelector('link[data-theme]').getAttribute('href'), table: f.contentDocument.querySelectorAll('table').length,
  scripts: f.contentDocument.querySelectorAll('script').length, sandbox: f.getAttribute('sandbox'), h: f.getBoundingClientRect().height,
}));
check('a theme restyles the same answer in a frame', themed.link === '/themes/pico.css' && themed.table === 1 && themed.h > 100, JSON.stringify(themed));
check('the themed frame has no scripts and no script permission', themed.scripts === 0 && themed.sandbox === 'allow-same-origin');
await page.selectOption('#theme', 'default');

// ---- a suggested reply sends the next turn, with the earlier answer in the history
await a.locator('menu button').click();
await done(2);
const seen = await (await fetch(FAKE + '/seen')).json();
const second = seen.at(-1).body.messages;
check('a suggested reply sends a follow-up carrying the history', second.length === 4 && second[0].role === 'system' && second[2].role === 'assistant' && second[2].content.startsWith('<p>Here is a comparison.'), `${second.length} messages`);
check('the subset system prompt leads every request', /HTML fragment/.test(second[0].content));
check('the server sent the backend its API key', seen.at(-1).auth === 'Bearer k', String(seen.at(-1).auth));

// ---- hostile output: the sanitizer and the CSP must hold
await page.evaluate(() => { window.__pwned = undefined; });
await ask('evil please');
await done(3);
const hostile = await page.locator('article').nth(2).locator('.answer').evaluate((el) => ({
  html: el.innerHTML, pwned: window.__pwned,
  tags: [...el.querySelectorAll('*')].map((e) => e.localName),
  handlers: [...el.querySelectorAll('*')].filter((e) => [...e.attributes].some((x) => /^on|^style$/.test(x.name))).length,
  href: el.querySelector('a')?.getAttribute('href'),
}));
check('no script ran', hostile.pwned === undefined, String(hostile.pwned));
check('script, style, img, iframe and h1 are all gone', !hostile.tags.some((t) => ['script', 'style', 'img', 'iframe', 'h1'].includes(t)), hostile.tags.join(','));
check('no event handler or style attribute survives', hostile.handlers === 0);
check('a javascript: link loses its href', hostile.href === null, String(hostile.href));
const asideClass = await page.locator('article').nth(2).locator('aside').first().getAttribute('class').catch(() => null);
check('an aside with an unknown class loses the class', asideClass === null, String(asideClass));

// ---- Stop keeps what has arrived
await ask('slow please');
await page.waitForFunction(() => document.querySelectorAll('article').length === 4 && document.querySelector('article:nth-of-type(4) .answer')?.textContent.length > 20);
await page.click('#stop');
await done(4);
check('Stop ends the stream and keeps the partial answer', /Stopped/.test(await page.locator('.meta').last().textContent()) && (await page.locator('article').nth(3).locator('.answer').textContent()).length > 10);

// Console errors are checked before the deliberate refusals below, which the browser logs as errors.
check('no console errors', errors.length === 0, errors.join(' | '));

// ---- the server's guards
const r1 = await page.evaluate(async (b) => (await fetch(b + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"messages":[{"role":"user","content":"x"}]}' })).status, BASE);
check('a POST without a JSON content type is refused', r1 === 403, String(r1));
// fetch() ignores a custom Host header, so use node:http, which sends it as given
const withHost = (host) => new Promise((resolve) => {
  const u = new URL(BASE);
  http.get({ host: u.hostname, port: u.port, path: '/api/config', headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); });
});
const rebinding = await withHost('evil.example');
const normal = await withHost('127.0.0.1:' + new URL(BASE).port);
check('an unexpected Host header (DNS rebinding) is refused', rebinding === 403, String(rebinding));
check('the expected Host is served', normal === 200, String(normal));

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
