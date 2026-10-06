import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../src/subset.ts';
import { subset } from '../src/subset.ts';
import { validate, type Options, type ViolationKind } from '../src/validate.ts';

export const root = join(import.meta.dirname, '..');

export function kinds(src: string, options: Partial<Options> = {}): ViolationKind[] {
  return validate(subset, src, { profile: 'strict', widgets: false, ...options }).map((v) => v.kind);
}

export function readText(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8');
}

export function readJson<T>(...parts: string[]): T {
  return JSON.parse(readText(...parts)) as T;
}

export function goodDocuments(): string[] {
  const dir = join(root, 'conformance', 'cases', 'good');
  return readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => readFileSync(join(dir, f), 'utf8'));
}

export const profiles: Profile[] = ['strict', 'compact'];
