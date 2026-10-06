import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { Browser } from 'playwright';
import { tally } from './check.ts';
import type { Fake } from './fake.ts';

export async function e2e(browser: Browser, base: string, fake: Fake): Promise<number> {
  const { check, ...t } = tally();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => !/connecting/.test(document.querySelector('#backend')?.textContent ?? ''));
  const label = (await page.textContent('#backend')) ?? '';
  check('the page shows which backend it is using', label.includes(new URL(fake.url).host), label);

  const done = (n: number) =>
    page.waitForFunction(
      (n) =>
        document.querySelectorAll('article').length === n &&
        !(document.querySelector('#send') as HTMLElement).hidden &&
        /characters of HTML|Stopped|Error/.test([...document.querySelectorAll('.meta')].at(-1)?.textContent ?? ''),
      n,
      { timeout: 30000 },
    );
  const ask = async (text: string) => {
    await page.fill('#input', text);
    await page.click('#send');
  };

  await ask('compact please');
  await page.waitForFunction(() => document.querySelector('article .answer p'), null, { timeout: 5000 });
  check('the first block renders while the answer is still streaming', await page.evaluate(() => !(document.querySelector('#stop') as HTMLElement).hidden));
  await done(1);
  const first = page.locator('article').first();
  const shape = await first.locator('.answer').evaluate((el) => ({
    tables: el.querySelectorAll('table').length,
    thead: el.querySelectorAll('thead').length,
    tbody: el.querySelectorAll('tbody').length,
    th: el.querySelectorAll('th').length,
    td: el.querySelectorAll('td').length,
    rows: el.querySelectorAll('tr').length,
    li: el.querySelectorAll('ul li').length,
    paragraphs: el.querySelectorAll(':scope > p').length,
    scopes: [...el.querySelectorAll('th')].map((x) => x.getAttribute('scope')).join(','),
    aside: el.querySelector('aside')?.getAttribute('role'),
    button: el.querySelector('menu button')?.getAttribute('type'),
    caption: el.querySelector('caption')?.textContent,
  }));
  check('omitted end tags are put back: one table, one thead, one tbody, 3 rows', shape.tables === 1 && shape.thead === 1 && shape.tbody === 1 && shape.rows === 3, JSON.stringify(shape));
  check('cells are all there (5 th, 4 td)', shape.th === 5 && shape.td === 4);
  check('a list with omitted </li> has three items', shape.li === 3);
  check('both paragraphs survive', shape.paragraphs === 2, String(shape.paragraphs));
  check('scope is filled in: col in the header row, row for row headers', shape.scopes === 'col,col,col,row,row', shape.scopes);
  check('role and type are filled in on aside and button', shape.aside === 'note' && shape.button === 'button', `${shape.aside}/${shape.button}`);
  check('the table caption is kept', shape.caption === 'Speed');
  check('reasoning from the backend shows in a thinking panel', await first.locator('.thinking').isVisible());

  await page.check('input[value="source"]');
  const source = (await first.locator('.source').textContent()) ?? '';
  check('source view shows the compact HTML exactly as sent', source.startsWith('<p>Here is a comparison.<table><caption>Speed</caption>') && !source.includes('\n') && !source.includes('</td>'), source.slice(0, 70));
  await page.check('input[value="rendered"]');

  await first.locator('menu button').click();
  await done(2);
  const second = (fake.seen.at(-1)?.body.messages ?? []) as { role: string; content: string }[];
  check('a suggested reply sends a follow-up carrying the history', second.length === 4 && second[0]?.role === 'system' && second[2]?.role === 'assistant' && Boolean(second[2]?.content.startsWith('<p>Here is a comparison.')), `${second.length} messages`);
  check('the subset system prompt leads every request', /HTML fragment/.test(second[0]?.content ?? ''));
  check('the server sent the backend its API key', fake.seen.at(-1)?.auth === 'Bearer k', String(fake.seen.at(-1)?.auth));

  await page.evaluate(() => {
    (window as unknown as { __pwned?: number }).__pwned = undefined;
  });
  await ask('evil please');
  await done(3);
  const hostile = await page.locator('article').nth(2).locator('.answer').evaluate((el) => ({
    pwned: (window as unknown as { __pwned?: number }).__pwned,
    tags: [...el.querySelectorAll('*')].map((e) => e.localName),
    handlers: [...el.querySelectorAll('*')].filter((e) => [...e.attributes].some((x) => /^on|^style$/.test(x.name))).length,
    href: el.querySelector('a')?.getAttribute('href') ?? null,
  }));
  check('no script ran', hostile.pwned === undefined, String(hostile.pwned));
  check('script, style, img, iframe and h1 are all gone', !hostile.tags.some((x) => ['script', 'style', 'img', 'iframe', 'h1'].includes(x)), hostile.tags.join(','));
  check('no event handler or style attribute survives', hostile.handlers === 0);
  check('a javascript: link loses its href', hostile.href === null, String(hostile.href));
  const asideClass = await page.locator('article').nth(2).locator('aside').first().getAttribute('class');
  check('an aside with an unknown class loses the class', asideClass === null, String(asideClass));

  await ask('slow please');
  await page.waitForFunction(() => document.querySelectorAll('article').length === 4 && (document.querySelector('article:nth-of-type(4) .answer')?.textContent?.length ?? 0) > 20);
  await page.click('#stop');
  await done(4);
  check('Stop ends the stream and keeps the partial answer', /Stopped/.test((await page.locator('.meta').last().textContent()) ?? '') && ((await page.locator('article').nth(3).locator('.answer').textContent()) ?? '').length > 10);

  check('no console errors', errors.length === 0, errors.join(' | '));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const exported = await readFile(await download.path(), 'utf8');
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const flat = await noScript.newPage();
  await flat.setContent(exported);
  const facts = await flat.evaluate(() => ({
    tables: document.querySelectorAll('table').length,
    tbody: document.querySelectorAll('tbody').length,
    scripts: document.querySelectorAll('script').length,
    handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
    h2: [...document.querySelectorAll('h2')].map((h) => h.textContent ?? ''),
    csp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
  }));
  check('the exported file opens with JavaScript disabled and shows the table', facts.tables === 1 && facts.tbody === 1, JSON.stringify(facts));
  check('the exported file has no script, no handlers, and a CSP', facts.scripts === 0 && facts.handlers === 0 && facts.csp);
  check('the exported file carries the questions', facts.h2.includes('compact please'), facts.h2.join(' | '));
  check('the exported file does not contain the attack payloads', !/evil\.example|__pwned|javascript:/i.test(exported.replace(/Content-Security-Policy[^>]*>/, '')));
  await noScript.close();

  const refused = await page.evaluate(async (b) => (await fetch(`${b}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"messages":[{"role":"user","content":"x"}]}' })).status, base);
  check('a POST without a JSON content type is refused', refused === 403, String(refused));
  const withHost = (host: string) =>
    new Promise<number>((resolve) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: '/api/config', headers: { Host: host } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }).end();
    });
  const rebinding = await withHost('evil.example');
  const normal = await withHost(`127.0.0.1:${new URL(base).port}`);
  check('an unexpected Host header (DNS rebinding) is refused', rebinding === 403, String(rebinding));
  check('the expected Host is served', normal === 200, String(normal));

  await page.close();
  return t.failed;
}
