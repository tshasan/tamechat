import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCostUsd, openRouterPrices, plan, slug, validateConfig, worstCaseUsd, type MatrixConfig } from '../src/matrix.ts';

const config: MatrixConfig = {
  seeds: 3,
  seedBase: 1000,
  profiles: ['strict', 'compact'],
  maxTokens: 900,
  temperature: 0.7,
  budgetUsd: 1,
  runs: [
    { label: 'Model A', backend: 'https://openrouter.ai/api/v1', model: 'a/a' },
    { label: 'b+grammar', backend: 'https://x.modal.run/v1', model: 'b', grammar: true },
  ],
};

test('plan: one job per run and profile, with the grammar matching the profile', () => {
  const jobs = plan(config, 12);
  assert.deepEqual(
    jobs.map((j) => [j.dir, j.grammarFile, j.calls]),
    [
      ['model-a/strict', '', 36],
      ['model-a/compact', '', 36],
      ['b-grammar/strict-grammar', 'grammar/strict.gbnf', 36],
      ['b-grammar/compact-grammar', 'grammar/compact.gbnf', 36],
    ],
  );
});

test('plan: a markdown format adds one job per model without a grammar', () => {
  const jobs = plan({ ...config, formats: ['html', 'markdown'] }, 12);
  assert.deepEqual(jobs.filter((j) => j.format === 'markdown').map((j) => j.dir), ['model-a/markdown']);
});

test('slug keeps dots so model versions stay readable', () => {
  assert.equal(slug('Claude Haiku 5.5'), 'claude-haiku-5.5');
});

test('cost: per-million prices, and the worst case assumes every answer hits the limit', () => {
  const price = { inputPerMTok: 1, outputPerMTok: 10 };
  assert.equal(callCostUsd(price, 1_000_000, 0), 1);
  assert.equal(callCostUsd(price, 0, 1000), 0.01);
  const job = plan(config, 1)[0];
  assert.ok(job);
  const worst = worstCaseUsd(job, config, [{ q: 'hi', needs: [] }], price);
  assert.ok(worst > 3 * callCostUsd(price, 0, 900), `${worst}`);
});

test('validateConfig rejects duplicate labels and bad profiles', () => {
  assert.throws(() => validateConfig({ ...config, profiles: ['loose'] }), /profiles/);
  assert.throws(() => validateConfig({ ...config, runs: [config.runs[0], { ...config.runs[0] }] }), /duplicate/);
  assert.equal(validateConfig(config), config);
});

test('openRouterPrices converts per-token strings to per-million numbers', async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ data: [{ id: 'a/a', pricing: { prompt: '0.0000001', completion: '0.0000005' } }, { id: 'free', pricing: {} }] }))) as unknown as typeof fetch;
  const prices = await openRouterPrices(fake);
  const a = prices.get('a/a');
  assert.ok(a);
  assert.ok(Math.abs(a.inputPerMTok - 0.1) < 1e-9 && Math.abs(a.outputPerMTok - 0.5) < 1e-9);
  assert.equal(prices.has('free'), false);
});
