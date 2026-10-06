import { readFileSync } from 'node:fs';
import type { Format } from './format.ts';
import type { Profile } from './subset.ts';

const read = (name: string): string => readFileSync(new URL(`../spec/${name}`, import.meta.url), 'utf8').trim();

export const systemPrompt: Record<Profile, string> = {
  strict: read('system-prompt-strict.txt'),
  compact: read('system-prompt-compact.txt'),
};

export const markdownPrompt = read('system-prompt-markdown.txt');

export function promptFor(format: Format, profile: Profile): string {
  return format === 'markdown' ? markdownPrompt : systemPrompt[profile];
}
