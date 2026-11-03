import type { Prompt } from './conform.ts';
import type { Format } from './format.ts';
import { promptFor } from './prompts.ts';
import type { Profile } from './subset.ts';

// A run matrix: every model in `runs` answers every prompt, `seeds` times, once per profile.
// Prices are USD per million tokens; a run on openrouter.ai without one gets the catalogue price.
export interface MatrixConfig {
  prompts?: string;
  seeds: number;
  seedBase: number;
  profiles: Profile[];
  // "markdown" adds one Markdown job per model without a grammar: the same prompts, for comparison.
  formats?: Format[];
  maxTokens: number;
  temperature: number;
  budgetUsd: number;
  runs: RunSpec[];
}

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface RunSpec {
  label: string;
  backend: string;
  model: string;
  keyEnv?: string;
  grammar?: boolean;
  extra?: Record<string, unknown>;
  price?: Price;
}

export interface Job {
  spec: RunSpec;
  format: Format;
  profile: Profile;
  grammarFile: string;
  dir: string;
  calls: number;
}

export function isOpenRouter(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === 'openrouter.ai';
  } catch {
    return false;
  }
}

export function plan(config: MatrixConfig, promptCount: number): Job[] {
  const jobs: Job[] = [];
  for (const spec of config.runs) {
    for (const profile of config.profiles) {
      const grammarFile = spec.grammar ? `grammar/${profile}.gbnf` : '';
      jobs.push({
        spec,
        format: 'html',
        profile,
        grammarFile,
        dir: `${slug(spec.label)}/${profile}${spec.grammar ? '-grammar' : ''}`,
        calls: promptCount * config.seeds,
      });
    }
    if (config.formats?.includes('markdown') && !spec.grammar) {
      jobs.push({ spec, format: 'markdown', profile: 'strict', grammarFile: '', dir: `${slug(spec.label)}/markdown`, calls: promptCount * config.seeds });
    }
  }
  return jobs;
}

export function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

// Rough input size: system prompt plus question, at about four characters a token.
export function inputTokensFor(format: Format, profile: Profile, p: Prompt): number {
  return Math.ceil((promptFor(format, profile).length + p.q.length) / 4);
}

export function callCostUsd(price: Price, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6;
}

// The most one job can cost: every answer runs to the token limit.
export function worstCaseUsd(job: Job, config: MatrixConfig, prompts: Prompt[], price: Price): number {
  let total = 0;
  for (const p of prompts) total += config.seeds * callCostUsd(price, inputTokensFor(job.format, job.profile, p), config.maxTokens);
  return total;
}

export function validateConfig(value: unknown): MatrixConfig {
  const c = value as MatrixConfig;
  const fail = (m: string): never => {
    throw new Error(`matrix config: ${m}`);
  };
  if (typeof c !== 'object' || c === null) fail('not an object');
  if (!Number.isInteger(c.seeds) || c.seeds < 1) fail('seeds must be a positive integer');
  if (!Number.isInteger(c.seedBase)) fail('seedBase must be an integer');
  if (!Array.isArray(c.profiles) || c.profiles.some((p) => p !== 'strict' && p !== 'compact')) fail('profiles must list strict and/or compact');
  if (c.formats !== undefined && (!Array.isArray(c.formats) || c.formats.some((f) => f !== 'html' && f !== 'markdown'))) fail('formats must list html and/or markdown');
  if (!(c.maxTokens > 0)) fail('maxTokens must be positive');
  if (!(c.budgetUsd >= 0)) fail('budgetUsd must be zero or more');
  if (!Array.isArray(c.runs) || c.runs.length === 0) fail('runs must be a non-empty list');
  const labels = new Set<string>();
  for (const r of c.runs) {
    if (!r.label || !r.backend || !r.model) fail(`every run needs label, backend and model: ${JSON.stringify(r)}`);
    if (labels.has(slug(r.label))) fail(`duplicate label ${r.label}`);
    labels.add(slug(r.label));
  }
  return c;
}

// OpenRouter's public catalogue (no key needed): model id -> price per million tokens.
export async function openRouterPrices(fetcher: typeof fetch = fetch): Promise<Map<string, Price>> {
  const res = await fetcher('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`openrouter models: HTTP ${res.status}`);
  const body = (await res.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  const prices = new Map<string, Price>();
  for (const m of body.data) {
    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    if (Number.isFinite(input) && Number.isFinite(output)) prices.set(m.id, { inputPerMTok: input * 1e6, outputPerMTok: output * 1e6 });
  }
  return prices;
}
