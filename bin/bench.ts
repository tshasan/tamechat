import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { backendFrom, backendOptions } from '../src/backendFlags.ts';
import { formatReport, runBench } from '../src/bench.ts';
import type { Prompt } from '../src/conform.ts';
import { formats, isFormat, type Format } from '../src/format.ts';
import { createApp } from '../src/server.ts';
import { disabledTelemetry, startTelemetry } from '../src/telemetry.ts';

const root = join(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    ...backendOptions,
    profile: { type: 'string', default: 'strict' },
    prompts: { type: 'string', default: join(root, 'corpus', 'prompts.json') },
    formats: { type: 'string', default: formats.join(',') },
    n: { type: 'string', default: '1' },
    'cpu-slowdown': { type: 'string', default: '1' },
    out: { type: 'string', default: '' },
    'trace-file': { type: 'string', default: '' },
  },
});

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (values.profile !== 'strict' && values.profile !== 'compact') die('--profile must be strict or compact');
const chosen = values.formats.split(',').filter(isFormat) as Format[];
if (chosen.length === 0) die('--formats must list html and/or markdown');

async function minified(source: string): Promise<[number, number]> {
  const out = await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, bundle: true, minify: true, format: 'esm', target: 'es2022', write: false });
  const text = out.outputFiles[0]?.text ?? '';
  return [Buffer.byteLength(text), gzipSync(text).length];
}

async function bundleNotes(): Promise<string[]> {
  const html = await minified("import { subset } from './src/subset.ts'; import { StreamRenderer } from './web/render.ts'; globalThis.x = [subset, StreamRenderer];");
  const markdown = await minified("import { MarkdownRenderer } from './web/markdown.ts'; globalThis.x = MarkdownRenderer;");
  return [
    'client code needed to render and sanitize, minified (gzipped):',
    `  html:     ${html[0]} bytes (${html[1]})`,
    `  markdown: ${markdown[0]} bytes (${markdown[1]}), marked + DOMPurify`,
  ];
}

const telemetry = values['trace-file'] ? startTelemetry({ file: values['trace-file'], otlp: false }) : disabledTelemetry;
const app = createApp({
  backend: backendFrom(values),
  profile: values.profile,
  hosts: ['localhost', '127.0.0.1'],
  staticDir: join(root, 'dist'),
  telemetry,
});
await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

const browser = await chromium.launch();
const results = await runBench({
  browser,
  base,
  prompts: JSON.parse(readFileSync(values.prompts, 'utf8')) as Prompt[],
  formats: chosen,
  repeats: Number(values.n),
  cpuSlowdown: Number(values['cpu-slowdown']),
  log: console.log,
});
await browser.close();
app.close();
await telemetry.shutdown();

if (values.out) writeFileSync(values.out, results.map((m) => JSON.stringify(m)).join('\n') + '\n');
console.log(`\n${formatReport(results, chosen, [...(await bundleNotes()), `cpu slowdown: ${values['cpu-slowdown']}x`])}`);
