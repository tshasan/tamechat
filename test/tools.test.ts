import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sample, type SampleOptions } from '../src/conform.ts';
import { Llama } from '../src/llama.ts';
import { listen, scriptedBackend } from './backend.ts';

function options(url: string, o: Partial<SampleOptions> = {}): SampleOptions {
  return {
    backend: { baseURL: url, model: 'test', apiKey: '', grammar: '', extra: {} },
    profile: 'strict',
    prompts: [{ q: 'one', needs: [] }, { q: 'two', needs: [] }, { q: 'three', needs: [] }, { q: 'four', needs: ['table'] }],
    samples: 1,
    maxTokens: 900,
    temperature: 0.7,
    label: '',
    verbose: false,
    ...o,
  };
}

test('sample: the report counts valid, fenced and rule-breaking answers', async () => {
  const backend = await scriptedBackend([
    '<p>fine</p>',
    '<p>x <img src="https://evil.example/?d=1"></p>',
    '```html\n<p>wrapped</p>\n```',
    '<table><thead><tr><th>a<tbody><tr><td>b</table>',
  ], 'stop');
  try {
    const { report: out } = await sample(options(backend.url));
    for (const want of ['valid as emitted        1/4 (25%)', 'wrapped in a code fence 1/4', 'element 1', 'end-tag 1', 'asked-for element present 1/1', 'completion tokens per word']) {
      assert.ok(out.includes(want), `missing ${want}:\n${out}`);
    }
  } finally {
    await backend.close();
  }
});

test('sample: the compact profile accepts omitted end tags', async () => {
  const backend = await scriptedBackend(['<table><thead><tr><th>a<tbody><tr><td>b</table>'], 'stop');
  try {
    const { report: out } = await sample(options(backend.url, { profile: 'compact', prompts: [{ q: 'one', needs: ['table'] }] }));
    assert.ok(out.includes('valid as emitted        1/1 (100%)'), out);
  } finally {
    await backend.close();
  }
});

test('sample: answers stopped by the length limit are counted', async () => {
  const backend = await scriptedBackend(['<p>half an answ'], 'length');
  try {
    const { report: out } = await sample(options(backend.url, { prompts: [{ q: 'one', needs: [] }] }));
    assert.ok(out.includes('cut off by the limit    1/1'), out);
  } finally {
    await backend.close();
  }
});

test('sample: every answer becomes a record with its seed, model and score', async () => {
  const seen: Record<string, unknown>[] = [];
  const backend = await listen((_req, body, res) => {
    seen.push(JSON.parse(body) as Record<string, unknown>);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'served-m', provider: 'SomeHost',
      choices: [{ index: 0, message: { role: 'assistant', content: '<p>fine</p>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 0.0001 },
    }));
  });
  try {
    const { records } = await sample(options(backend.url, { samples: 2, seed: 1000, prompts: [{ q: 'one', needs: [] }, { q: 'two', needs: [] }] }));
    assert.deepEqual(records.map((r) => r.seed), [1000, 2000, 1001, 2001]);
    assert.deepEqual(seen.map((b) => b.seed), [1000, 2000, 1001, 2001]);
    const r = records[0];
    assert.ok(r);
    assert.equal(r.servedModel, 'served-m');
    assert.equal(r.provider, 'SomeHost');
    assert.equal(r.costUsd, 0.0001);
    assert.equal(r.inputTokens, 7);
    assert.equal(r.valid, true);
    assert.equal(r.content, '<p>fine</p>');
  } finally {
    await backend.close();
  }
});

test('sample: a failed call is recorded and the run continues', async () => {
  let calls = 0;
  const backend = await listen((_req, _body, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '<p>ok</p>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
  });
  try {
    const { records, report } = await sample(options(backend.url, { prompts: [{ q: 'one', needs: [] }, { q: 'two', needs: [] }] }));
    assert.equal(records.length, 2);
    assert.ok(records[0]?.error);
    assert.equal(records[1]?.error, null);
    assert.ok(report.includes('errors: 1/2'), report);
  } finally {
    await backend.close();
  }
});

test('sample: onRecord returning false stops the run', async () => {
  const backend = await scriptedBackend(['<p>fine</p>'], 'stop');
  try {
    const { records } = await sample(options(backend.url), () => {}, () => false);
    assert.equal(records.length, 1);
  } finally {
    await backend.close();
  }
});

function tokenizer(pieces: (string | number[])[]) {
  return listen((_req, body, res) => {
    const request = JSON.parse(body) as { with_pieces: boolean; model: string };
    assert.ok(request.with_pieces);
    assert.equal(request.model, 'm1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tokens: pieces.map((piece) => ({ id: 1, piece })) }));
  });
}

test('tokenize returns byte ranges, including pieces that are raw bytes', async () => {
  const backend = await tokenizer(['<p', '>', [0xc3], [0xa9], '!']);
  try {
    const spans = await new Llama(backend.url, 'm1').tokenize('<p>é!');
    assert.deepEqual(spans, [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }]);
  } finally {
    await backend.close();
  }
});

test('tokenize fails when the pieces do not cover the text', async () => {
  const backend = await tokenizer(['<p', '>']);
  try {
    await assert.rejects(new Llama(backend.url, 'm1').tokenize('<p>longer than the pieces'));
  } finally {
    await backend.close();
  }
});

test('tokenize reports an HTTP error', async () => {
  const backend = await listen((_req, _body, res) => {
    res.writeHead(500);
    res.end('nope');
  });
  try {
    await assert.rejects(new Llama(backend.url, '').count('x'), /500/);
  } finally {
    await backend.close();
  }
});
