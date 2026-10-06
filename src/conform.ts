import { generateText } from 'ai';
import { backendHost, chatModel, type Backend } from './model.ts';
import { systemPrompt } from './prompts.ts';
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
}

const fence = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

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

const sum = (rs: Result[], f: (r: Result) => number): number => rs.reduce((a, r) => a + f(r), 0);
const percent = (n: number, d: number): string => `${Math.round((100 * n) / d)}%`;

export function report(rs: Result[], o: Pick<SampleOptions, 'label' | 'profile' | 'backend'>): string {
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

export async function sample(o: SampleOptions, log: (line: string) => void = () => {}): Promise<string> {
  const model = chatModel(o.backend);
  const results: Result[] = [];
  for (const [i, p] of o.prompts.entries()) {
    for (let k = 0; k < o.samples; k++) {
      const out = await generateText({
        model,
        system: systemPrompt[o.profile],
        prompt: p.q,
        maxOutputTokens: o.maxTokens,
        temperature: o.temperature,
        maxRetries: 0,
        timeout: 180_000,
      });
      const r = evaluate(out.text, o.profile, p.needs);
      r.tokens = out.usage.outputTokens ?? 0;
      r.cutOff = out.finishReason === 'length';
      results.push(r);
      if (o.verbose) log(`prompt ${String(i).padStart(2)}: ${status(r).padEnd(8)} ${String(r.tokens).padStart(4)} tokens  ${p.q}`);
    }
  }
  return report(results, o);
}
