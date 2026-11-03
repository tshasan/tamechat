import { generateText } from 'ai';
import { backendHost, chatModel, type Backend } from './model.ts';
import type { Format } from './format.ts';
import { promptFor } from './prompts.ts';
import { subset, type Profile } from './subset.ts';
import { validate, type Violation } from './validate.ts';

export interface Prompt {
  q: string;
  needs: string[];
}

export interface Result {
  violations: Violation[];
  fenced: boolean;
  needs: number;
  got: number;
  tokens: number;
  words: number;
  cutOff: boolean;
}

export interface SampleOptions {
  backend: Backend;
  profile: Profile;
  prompts: Prompt[];
  samples: number;
  maxTokens: number;
  temperature: number;
  label: string;
  verbose: boolean;
  seed?: number;
  format?: Format;
}

// One generated answer, as written to answers.jsonl. Everything needed to
// re-render or re-score it later without calling the model again.
export interface AnswerRecord {
  label: string;
  model: string;
  servedModel: string;
  provider: string;
  host: string;
  format: Format;
  profile: Profile;
  grammar: boolean;
  prompt: number;
  sample: number;
  seed: number | null;
  temperature: number;
  maxTokens: number;
  q: string;
  needs: string[];
  content: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ms: number;
  valid: boolean;
  fenced: boolean;
  violations: string[];
  got: number;
  words: number;
  error: string | null;
}

const fence = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

// The answer with a wrapping code fence removed, which is what a renderer would be handed.
export function bodyOf(content: string): string {
  return fence.exec(content)?.[1] ?? content;
}

// Seed for prompt i, sample k: stable across arms so runs can be diffed pair by pair.
export function seedFor(base: number, i: number, k: number): number {
  return base + i + 1000 * k;
}

const detectors: Record<string, (lower: string) => boolean> = {
  table: (s) => s.includes('<table'),
  code: (s) => s.includes('<pre'),
  callout: (s) => s.includes('<aside'),
  list: (s) => s.includes('<ul') || s.includes('<ol') || s.includes('<dl'),
};

export function evaluate(content: string, profile: Profile, needs: string[]): Result {
  const match = fence.exec(content);
  const body = match?.[1] ?? content;
  const lower = body.toLowerCase();
  return {
    violations: validate(subset, body, { profile, widgets: true }),
    fenced: match !== null,
    needs: needs.length,
    got: needs.filter((n) => detectors[n]?.(lower)).length,
    tokens: 0,
    words: body.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length,
    cutOff: false,
  };
}

const markdownDetectors: Record<string, (s: string) => boolean> = {
  table: (s) => /^\s*\|.*\|\s*$/m.test(s),
  code: (s) => s.includes('```'),
  callout: (s) => /^\s*>/m.test(s),
  list: (s) => /^\s*([-*+]|\d+\.)\s/m.test(s),
};

// Markdown has no subset to break, so a Markdown answer is scored only on the asked-for elements and its
// length, for comparing against HTML answers to the same prompts.
export function evaluateMarkdown(content: string, needs: string[]): Result {
  return {
    violations: [],
    fenced: false,
    needs: needs.length,
    got: needs.filter((n) => markdownDetectors[n]?.(content)).length,
    tokens: 0,
    words: content.replace(/[#*_`|>\-]+/g, ' ').split(/\s+/).filter(Boolean).length,
    cutOff: false,
  };
}

const sum = (rs: Result[], f: (r: Result) => number): number => rs.reduce((a, r) => a + f(r), 0);
const percent = (n: number, d: number): string => `${Math.round((100 * n) / d)}%`;

export function report(rs: Result[], o: Pick<SampleOptions, 'label' | 'profile' | 'backend' | 'format'>): string {
  const n = rs.length;
  const grammar = o.backend.grammar !== '';
  const valid = rs.filter((r) => r.violations.length === 0 && !r.fenced).length;
  const fenced = rs.filter((r) => r.fenced).length;
  const cut = rs.filter((r) => r.cutOff).length;
  const needs = sum(rs, (r) => r.needs);
  const got = sum(rs, (r) => r.got);
  const words = sum(rs, (r) => r.words);
  const tokens = sum(rs, (r) => r.tokens);
  const byKind = new Map<string, number>();
  for (const r of rs) for (const kind of new Set(r.violations.map((v) => v.kind))) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  const kinds = [...byKind].map(([k, c]) => `${k} ${c}`).sort().join(', ') || 'none';
  const label = o.label || o.backend.model;
  const host = backendHost(o.backend.baseURL);

  if (o.format === 'markdown') {
    const md = ['', `${n} Markdown answers from ${label} (${host})`, '', `  cut off by the limit    ${cut}/${n}`];
    if (needs > 0) md.push(`  asked-for element present ${got}/${needs}`);
    if (words > 0) md.push(`  completion tokens per word ${(tokens / words).toFixed(2)} (the backend's own count; only comparable within one backend)`);
    return md.join('\n');
  }
  const lines = [
    '',
    `${n} answers from ${label} (${host}), profile ${o.profile}, grammar: ${grammar}`,
    '',
    `  valid as emitted        ${valid}/${n} (${percent(valid, n)})`,
    `  wrapped in a code fence ${fenced}/${n}`,
    `  cut off by the limit    ${cut}/${n}`,
    `  answers with violations by kind: ${kinds}`,
  ];
  if (needs > 0) lines.push(`  asked-for element present ${got}/${needs}`);
  if (words > 0) lines.push(`  completion tokens per word ${(tokens / words).toFixed(2)} (the backend's own count; only comparable within one backend)`);
  lines.push(
    '',
    '| backend | model | profile | grammar | answers | valid as emitted | fenced | cut off |',
    '|---|---|---|---|---|---|---|---|',
    `| ${host} | ${label} | ${o.profile} | ${grammar} | ${n} | ${percent(valid, n)} | ${fenced} | ${cut} |`,
  );
  return lines.join('\n');
}

export function status(r: Result): string {
  if (r.violations.length === 0) return r.fenced ? 'fenced' : 'valid';
  return `${r.violations.length} issues`;
}

function bodyField(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

export interface SampleRun {
  report: string;
  records: AnswerRecord[];
}

// onRecord fires after every answer, so a caller can append to disk and stop on a budget
// without losing what was already paid for. Returning false stops the run.
export async function sample(
  o: SampleOptions,
  log: (line: string) => void = () => {},
  onRecord: (r: AnswerRecord) => boolean | void = () => {},
): Promise<SampleRun> {
  let lastBody: unknown;
  const model = chatModel(o.backend, (body) => {
    lastBody = body;
  });
  const host = backendHost(o.backend.baseURL);
  const format = o.format ?? 'html';
  const results: Result[] = [];
  const records: AnswerRecord[] = [];
  outer: for (const [i, p] of o.prompts.entries()) {
    for (let k = 0; k < o.samples; k++) {
      const seed = o.seed === undefined ? null : seedFor(o.seed, i, k);
      const started = performance.now();
      const base = {
        label: o.label || o.backend.model,
        model: o.backend.model,
        host,
        format,
        profile: o.profile,
        grammar: o.backend.grammar !== '',
        prompt: i,
        sample: k,
        seed,
        temperature: o.temperature,
        maxTokens: o.maxTokens,
        q: p.q,
        needs: p.needs,
      };
      let record: AnswerRecord;
      lastBody = undefined;
      try {
        const out = await generateText({
          model,
          system: promptFor(format, o.profile),
          prompt: p.q,
          maxOutputTokens: o.maxTokens,
          temperature: o.temperature,
          ...(seed === null ? {} : { seed }),
          maxRetries: 2,
          timeout: 180_000,
        });
        const r = format === 'markdown' ? evaluateMarkdown(out.text, p.needs) : evaluate(out.text, o.profile, p.needs);
        r.tokens = out.usage.outputTokens ?? 0;
        r.cutOff = out.finishReason === 'length';
        results.push(r);
        const cost = bodyField(bodyField(lastBody, 'usage'), 'cost');
        record = {
          ...base,
          servedModel: out.response.modelId ?? o.backend.model,
          provider: String(bodyField(lastBody, 'provider') ?? ''),
          content: out.text,
          finishReason: out.finishReason,
          inputTokens: out.usage.inputTokens ?? 0,
          outputTokens: r.tokens,
          costUsd: typeof cost === 'number' ? cost : null,
          ms: Math.round(performance.now() - started),
          valid: format === 'html' && r.violations.length === 0 && !r.fenced,
          fenced: r.fenced,
          violations: r.violations.map((v) => v.kind),
          got: r.got,
          words: r.words,
          error: null,
        };
        if (o.verbose) log(`prompt ${String(i).padStart(2)}.${k}: ${status(r).padEnd(8)} ${String(r.tokens).padStart(4)} tokens  ${p.q}`);
      } catch (e) {
        record = {
          ...base,
          servedModel: '',
          provider: '',
          content: '',
          finishReason: 'error',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          ms: Math.round(performance.now() - started),
          valid: false,
          fenced: false,
          violations: [],
          got: 0,
          words: 0,
          error: e instanceof Error ? e.message : String(e),
        };
        log(`prompt ${String(i).padStart(2)}.${k}: ERROR    ${record.error}`);
      }
      records.push(record);
      if (onRecord(record) === false) break outer;
    }
  }
  const errors = records.filter((r) => r.error !== null).length;
  const summary = results.length ? report(results, o) : '\nno successful answers';
  return { report: errors ? `${summary}\n  errors: ${errors}/${records.length} calls failed` : summary, records };
}
