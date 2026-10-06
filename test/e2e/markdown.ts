import type { Browser } from 'playwright';
import { tally } from './check.ts';
import { formatReport, runBench } from '../../src/bench.ts';

interface Pwned {
  __pwned?: number;
}

export async function markdown(browser: Browser, base: string): Promise<number> {
  const { check, ...t } = tally();
  console.log('\nMarkdown format and metrics');
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => !/connecting/.test(document.querySelector('#backend')?.textContent ?? ''));
  await page.selectOption('#format', 'markdown');

  const done = (n: number) => page.waitForFunction((n) => window.tamechat.metrics.length === n, n, { timeout: 30000 });
  const ask = async (text: string) => {
    await page.fill('#input', text);
    await page.click('#send');
  };

  await ask('compact please');
  await done(1);
  const shape = await page.locator('article .answer').first().evaluate((el) => ({
    tables: el.querySelectorAll('table').length,
    rows: el.querySelectorAll('tr').length,
    li: el.querySelectorAll('li').length,
    quote: el.querySelectorAll('blockquote strong').length,
  }));
  check('markdown renders a table, a list and a callout', shape.tables === 1 && shape.rows === 3 && shape.li === 3 && shape.quote === 1, JSON.stringify(shape));
  const m = await page.evaluate(() => window.tamechat.metrics[0]);
  check('a turn records its metrics', m?.format === 'markdown' && (m?.frames ?? 0) > 1 && (m?.firstContentMs ?? 0) > 0 && (m?.ttftMs ?? 0) > 0 && (m?.renderMs ?? 0) > 0 && (m?.domNodes ?? 0) > 5, JSON.stringify(m));
  check('first content comes after the first token and before the end', (m?.ttftMs ?? 0) <= (m?.firstContentMs ?? 0) && (m?.firstContentMs ?? 0) < (m?.totalMs ?? 0), `${m?.ttftMs} ${m?.firstContentMs} ${m?.totalMs}`);
  const meta = (await page.locator('.meta').first().textContent()) ?? '';
  check('the turn shows its numbers', /markdown · first token .* s · first content .* s · render .* ms over \d+ frames/.test(meta), meta);

  await page.check('input[value="source"]');
  const source = (await page.locator('.source').first().textContent()) ?? '';
  check('source view shows the Markdown as sent', source.startsWith('Here is a comparison.\n\n| Language'), source.slice(0, 40));
  await page.check('input[value="rendered"]');

  await page.evaluate(() => {
    (window as unknown as Pwned).__pwned = undefined;
  });
  await ask('evil please');
  await done(2);
  const hostile = await page.locator('article').nth(1).locator('.answer').evaluate((el) => ({
    pwned: (window as unknown as Pwned).__pwned,
    tags: [...el.querySelectorAll('*')].map((e) => e.localName),
    handlers: [...el.querySelectorAll('*')].filter((e) => [...e.attributes].some((x) => /^on|^style$/.test(x.name))).length,
    href: el.querySelector('a')?.getAttribute('href') ?? null,
  }));
  check('hostile Markdown runs no script', hostile.pwned === undefined, String(hostile.pwned));
  check('script, iframe and handlers are stripped from Markdown output', !hostile.tags.some((x) => ['script', 'iframe'].includes(x)) && hostile.handlers === 0, hostile.tags.join(','));
  check('a javascript: Markdown link loses its href', hostile.href === null, String(hostile.href));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const exported = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  check('a Markdown conversation exports as static HTML', /<table>/.test(exported) && !/<script|onerror|javascript:/i.test(exported));

  await page.selectOption('#format', 'html');
  check('changing the format starts a new chat', (await page.locator('article').count()) === 0);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();

  const results = await runBench({ browser, base, prompts: [{ q: 'compact please', needs: [] }, { q: 'strict please', needs: [] }], formats: ['html', 'markdown'], repeats: 2, cpuSlowdown: 2, log: () => {} });
  check('the benchmark measures both formats', results.length === 8 && results.filter((r) => r.format === 'html').length === 4 && results.every((r) => r.frames > 0 && r.ttftMs > 0), String(results.length));
  const report = formatReport(results, ['html', 'markdown'], []);
  check('the benchmark report has a column per format', /\| metric \(median \/ p95\) \| html \| markdown \|/.test(report) && /first content on screen/.test(report));
  return t.failed;
}
