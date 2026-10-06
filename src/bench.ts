import type { Browser } from 'playwright';
import type { Prompt } from './conform.ts';
import type { Format } from './format.ts';
import { median, percentile } from './stats.ts';
import type { TurnMetrics } from '../web/metrics.ts';

export interface BenchOptions {
  browser: Browser;
  base: string;
  prompts: Prompt[];
  formats: Format[];
  repeats: number;
  cpuSlowdown: number;
  log: (line: string) => void;
}

type Measure = (m: TurnMetrics) => number;

const measures: [string, Measure][] = [
  ['first token (ms)', (m) => m.ttftMs],
  ['first content on screen (ms)', (m) => m.firstContentMs],
  ['stream done (ms)', (m) => m.totalMs],
  ['render time, all frames (ms)', (m) => m.renderMs],
  ['worst frame render (ms)', (m) => m.maxRenderMs],
  ['frames rendered', (m) => m.frames],
  ['long tasks', (m) => m.longTasks],
  ['long task time (ms)', (m) => m.longTaskMs],
  ['characters', (m) => m.chars],
  ['words', (m) => m.words],
  ['output tokens', (m) => m.outputTokens],
  ['tokens per word', (m) => (m.words ? m.outputTokens / m.words : 0)],
  ['render ms per 1k characters', (m) => (m.chars ? (m.renderMs / m.chars) * 1000 : 0)],
  ['DOM elements', (m) => m.domNodes],
];

export async function runBench(o: BenchOptions): Promise<TurnMetrics[]> {
  const page = await o.browser.newPage({ viewport: { width: 1000, height: 800 } });
  if (o.cpuSlowdown > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpuSlowdown });
  }
  await page.goto(o.base);
  await page.waitForFunction(() => !/connecting/.test(document.querySelector('#backend')?.textContent ?? ''));

  const results: TurnMetrics[] = [];
  for (let rep = 0; rep < o.repeats; rep++) {
    for (const [i, prompt] of o.prompts.entries()) {
      const order = o.formats.map((_, k) => o.formats[(k + rep + i) % o.formats.length] as Format);
      for (const format of order) {
        const before = results.length;
        await page.selectOption('#format', format);
        await page.fill('#input', prompt.q);
        await page.click('#send');
        await page.waitForFunction((n) => window.tamechat.metrics.length > n, before, { timeout: 300_000 });
        const metrics = await page.evaluate(() => window.tamechat.metrics.at(-1) as TurnMetrics);
        results.push(metrics);
        o.log(`rep ${rep + 1} prompt ${String(i).padStart(2)} ${format.padEnd(8)} first token ${metrics.ttftMs.toFixed(0)} ms, render ${metrics.renderMs.toFixed(0)} ms, ${metrics.outputTokens} tokens`);
      }
    }
  }
  await page.close();
  return results;
}

function cell(values: number[]): string {
  return `${median(values).toFixed(1)} / ${percentile(values, 95).toFixed(1)}`;
}

export function formatReport(results: TurnMetrics[], formats: Format[], notes: string[]): string {
  const groups = formats.map((f) => results.filter((m) => m.format === f && !m.aborted));
  const lines = [
    `${groups.map((g, i) => `${formats[i]}: ${g.length} answers`).join(', ')}`,
    '',
    `| metric (median / p95) | ${formats.join(' | ')} |`,
    `|---|${formats.map(() => '---|').join('')}`,
    ...measures.map(([name, measure]) => `| ${name} | ${groups.map((g) => cell(g.map(measure))).join(' | ')} |`),
    ...(notes.length ? ['', ...notes] : []),
  ];
  return lines.join('\n');
}
