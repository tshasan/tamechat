import { readFileSync } from 'node:fs';
import { parseExtra, type Backend } from './model.ts';

export const backendOptions = {
  backend: { type: 'string', default: 'http://127.0.0.1:8081/v1' },
  model: { type: 'string', default: '' },
  'key-env': { type: 'string', default: '' },
  grammar: { type: 'string', default: '' },
  extra: { type: 'string', default: '' },
} as const;

export interface BackendFlags {
  backend: string;
  model: string;
  'key-env': string;
  grammar: string;
  extra: string;
}

export function backendFrom(values: BackendFlags): Backend {
  const keyEnv = values['key-env'];
  const apiKey = keyEnv ? (process.env[keyEnv] ?? '') : '';
  if (keyEnv && !apiKey) throw new Error(`--key-env ${keyEnv} is empty`);
  let extra: Record<string, unknown>;
  try {
    extra = parseExtra(values.extra);
  } catch (e) {
    throw new Error(`--extra must be a JSON object: ${e instanceof Error ? e.message : e}`);
  }
  return {
    baseURL: values.backend.replace(/\/+$/, ''),
    model: values.model,
    apiKey,
    grammar: values.grammar ? readFileSync(values.grammar, 'utf8') : '',
    extra,
  };
}
