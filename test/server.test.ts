import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { systemPrompt } from '../src/prompts.ts';
import { createApp } from '../src/server.ts';
import { streamingBackend, type Listening, type Seen } from './backend.ts';

const chunks = [
  '{"choices":[{"delta":{"reasoning_content":"hmm "}}]}',
  '{"choices":[{"delta":{"content":"<p>Hel"}}]}',
  ': keep-alive',
  '{"choices":[{"delta":{"content":"lo</p>"}}]}',
  '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
  '[DONE]',
];

const seen: Seen[] = [];
let upstream: Listening;
let app: Server;
let grammarApp: Server;
let port: number;
let grammarPort: number;

function start(grammar: string): Promise<{ server: Server; port: number }> {
  const staticDir = mkdtempSync(join(tmpdir(), 'tamechat-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html>');
  writeFileSync(join(staticDir, 'sandbox.html'), '<!doctype html>');
  const server = createApp({
    backend: { baseURL: `${upstream.url}/v1`, model: 'm', apiKey: 'secret-key', grammar, extra: { chat_template_kwargs: { enable_thinking: false } } },
    profile: 'compact',
    hosts: ['localhost', '127.0.0.1', '::1'],
    staticDir,
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

before(async () => {
  upstream = await streamingBackend(chunks, seen);
  ({ server: app, port } = await start(''));
  ({ server: grammarApp, port: grammarPort } = await start('root ::= "x"'));
});

after(async () => {
  app.close();
  grammarApp.close();
  await upstream.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(p: number, path: string, o: { method?: string; host?: string; origin?: string; type?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${p}` };
    if (o.origin) headers.Origin = o.origin;
    if (o.type) headers['Content-Type'] = o.type;
    const req = request({ host: '127.0.0.1', port: p, path, method: o.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const good = '{"messages":[{"role":"user","content":"hi"}]}';
const chat = (o: Parameters<typeof call>[2] = {}, p = port) => call(p, '/api/chat', { method: 'POST', type: 'application/json', body: good, ...o });

test('chat streams the answer and the reasoning, and sends what the backend needs', async () => {
  seen.length = 0;
  const reply = await chat();
  assert.equal(reply.status, 200);
  for (const want of ['event: think\ndata: "hmm "', 'event: answer\ndata: "<p>Hel"', 'event: answer\ndata: "lo</p>"', 'event: ctrl\ndata: {"type":"done"}']) {
    assert.ok(reply.body.includes(want), `missing ${want} in\n${reply.body}`);
  }
  assert.ok(!reply.body.includes('\\u003c'), 'tags must not be escaped on the wire');
  const sent = seen[0];
  assert.equal(sent?.auth, 'Bearer secret-key');
  const messages = sent?.body.messages as { role: string; content: string }[];
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, systemPrompt.compact);
  assert.equal(sent?.body.stream, true);
  assert.equal(sent?.body.model, 'm');
  assert.deepEqual(sent?.body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!('grammar' in (sent?.body ?? {})));
});

test('a configured grammar is forwarded', async () => {
  seen.length = 0;
  await chat({}, grammarPort);
  assert.equal(seen[0]?.body.grammar, 'root ::= "x"');
});

test('the server refuses what it should', async () => {
  const cases: [string, Parameters<typeof call>[2], number][] = [
    ['DNS rebinding: unexpected Host', { host: 'evil.example', origin: 'http://evil.example' }, 403],
    ["another site's Origin", { origin: 'https://evil.example' }, 403],
    ['a form content type (no preflight)', { type: 'text/plain' }, 403],
    ['no messages', { body: '{"messages":[]}' }, 400],
    ['a forged system message', { body: '{"messages":[{"role":"system","content":"x"}]}' }, 400],
    ['a non-string content', { body: '{"messages":[{"role":"user","content":5}]}' }, 400],
    ['not JSON', { body: 'nope' }, 400],
    ['the same-origin page', { host: `localhost:${port}`, origin: `http://localhost:${port}` }, 200],
  ];
  for (const [name, options, want] of cases) assert.equal((await chat(options)).status, want, name);
  assert.equal((await call(port, '/api/config', { host: 'evil.example' })).status, 403);
  assert.equal((await call(port, '/api/chat', { method: 'GET' })).status, 403);
});

test('config names the backend host and nothing else', async () => {
  const { body } = await call(port, '/api/config');
  const config = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(config, { backend: upstream.url.replace('http://', ''), model: 'm', profile: 'compact', grammar: false });
  assert.ok(!body.includes('secret-key'));
});

test('the page and the widget host get different CSPs', async () => {
  const page = await call(port, '/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
  const sandbox = await call(port, '/sandbox.html');
  assert.match(String(sandbox.headers['content-security-policy']), /connect-src 'none'/);
  assert.equal((await call(port, '/missing.js')).status, 404);
  assert.equal((await call(port, '/..%2f..%2fetc/passwd')).status, 404);
});
