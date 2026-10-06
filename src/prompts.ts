import { readFileSync } from 'node:fs';
import type { Profile } from './subset.ts';

const read = (name: string): string => readFileSync(new URL(`../spec/${name}`, import.meta.url), 'utf8').trim();

export const systemPrompt: Record<Profile, string> = {
  strict: read('system-prompt-strict.txt'),
  compact: read('system-prompt-compact.txt'),
};
