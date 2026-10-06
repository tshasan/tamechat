import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface Backend {
  baseURL: string;
  model: string;
  apiKey: string;
  grammar: string;
  extra: Record<string, unknown>;
}

export function chatModel(b: Backend): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'tamechat',
    baseURL: b.baseURL.replace(/\/+$/, ''),
    apiKey: b.apiKey || undefined,
    includeUsage: true,
    transformRequestBody: (body) => ({ ...b.extra, ...body, ...(b.grammar ? { grammar: b.grammar } : {}) }),
  });
  return provider.chatModel(b.model);
}

export function backendHost(baseURL: string): string {
  try {
    return new URL(baseURL).host || 'backend';
  } catch {
    return 'backend';
  }
}

export function parseExtra(json: string): Record<string, unknown> {
  if (json === '') return {};
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('extra must be a JSON object');
  return value as Record<string, unknown>;
}
