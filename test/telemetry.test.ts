import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { markdownPrompt, systemPrompt } from '../src/prompts.ts';
import { createApp } from '../src/server.ts';
import { median, percentile } from '../src/stats.ts';
import { JsonlExporter, tracerFor, type SpanRecord } from '../src/telemetry.ts';
import { streamingBackend, type Listening, type Seen } from './backend.ts';

const chunks = [
  '{"choices":[{"delta":{"content":"Hello "}}]}',
  '{"choices":[{"delta":{"content":"**world**"}}]}',
  '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}',
  '[DONE]',
];

const seen: Seen[] = [];
const dir = mkdtempSync(join(tmpdir(), 'tamechat-trace-'));
const traceFile = join(dir, 'spans.jsonl');
let upstream: Listening;
let app: Server;
let port: number;
const telemetry = tracerFor([new SimpleSpanProcessor(new JsonlExporter(traceFile))]);

const spans = (): SpanRecord[] => readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as SpanRecord);

before(async () => {
  upstream = await streamingBackend(chunks, seen);
  const staticDir = mkdtempSync(join(tmpdir(), 'tamechat-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html>');
  app = createApp({
    backend: { baseURL: `${upstream.url}/v1`, model: 'm', apiKey: '', grammar: 'root ::= "x"', extra: {} },
    profile: 'compact',
    hosts: ['127.0.0.1'],
    staticDir,
    telemetry,
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  port = (app.address() as AddressInfo).port;
});

after(async () => {
  app.close();
  await telemetry.shutdown();
  await upstream.close();
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const user = [{ role: 'user', content: 'hi' }];

test('percentiles and median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([10, 20], 50), 15);
  assert.equal(percentile([], 95), 0);
});

test('html chat: html prompt, grammar sent, and a chat span with the numbers that matter', async () => {
  seen.length = 0;
  const text = await (await post('/api/chat', { messages: user, format: 'html' })).text();
  assert.match(text, /event: ctrl\ndata: \{"type":"trace","traceId":"[0-9a-f]{32}"\}/);
  assert.match(text, /"type":"done","outputTokens":7,"finishReason":"stop"/);
  const messages = seen[0]?.body.messages as { content: string }[];
  assert.equal(messages[0]?.content, systemPrompt.compact);
  assert.equal(seen[0]?.body.grammar, 'root ::= "x"');

  const span = spans().find((s) => s.name === 'chat' && s.attributes['tamechat.format'] === 'html');
  assert.ok(span);
  assert.equal(span.attributes['gen_ai.usage.output_tokens'], 7);
  assert.equal(span.attributes['tamechat.answer_chars'], 'Hello **world**'.length);
  assert.equal(span.attributes['tamechat.grammar'], true);
  assert.ok(Number(span.attributes['tamechat.ttft_ms']) > 0);
  assert.ok(!JSON.stringify(span).includes('"hi"'), 'prompt text must not be recorded');
});

test('markdown chat: markdown prompt and no grammar', async () => {
  seen.length = 0;
  await (await post('/api/chat', { messages: user, format: 'markdown' })).text();
  const messages = seen[0]?.body.messages as { content: string }[];
  assert.equal(messages[0]?.content, markdownPrompt);
  assert.ok(!('grammar' in (seen[0]?.body ?? {})));
  const span = spans().findLast((s) => s.name === 'chat');
  assert.equal(span?.attributes['tamechat.format'], 'markdown');
  assert.equal(span?.attributes['tamechat.grammar'], false);
});

test('an unknown format is refused', async () => {
  assert.equal((await post('/api/chat', { messages: user, format: 'rtf' })).status, 400);
});

test('client metrics become a child span of the chat span, once', async () => {
  const text = await (await post('/api/chat', { messages: user, format: 'html' })).text();
  const traceId = /"traceId":"([0-9a-f]{32})"/.exec(text)?.[1] as string;
  const metrics = { totalMs: 250, renderMs: 12.5, frames: 9, format: 'html', nested: { ignored: true } };
  assert.equal((await post('/api/trace', { traceId, metrics })).status, 204);
  assert.equal((await post('/api/trace', { traceId, metrics })).status, 404);
  const mine = spans().filter((s) => s.traceId === traceId);
  const chat = mine.find((s) => s.name === 'chat');
  const render = mine.find((s) => s.name === 'client.render');
  assert.ok(chat && render);
  assert.equal(render.parentSpanId, chat.spanId);
  assert.equal(render.attributes['tamechat.client.renderMs'], 12.5);
  assert.equal(render.attributes['tamechat.client.frames'], 9);
  assert.ok(!('tamechat.client.nested' in render.attributes));
  assert.ok(Math.abs(render.durationMs - 250) < 1);
});

test('trace endpoint refuses unknown ids and foreign callers', async () => {
  assert.equal((await post('/api/trace', { traceId: 'f'.repeat(32), metrics: { totalMs: 1 } })).status, 404);
  const foreign = await fetch(`http://127.0.0.1:${port}/api/trace`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(foreign.status, 403);
});
