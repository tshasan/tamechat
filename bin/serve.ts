import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { backendHost, parseExtra } from '../src/model.ts';
import { createApp } from '../src/server.ts';
import type { Profile } from '../src/subset.ts';

const { values } = parseArgs({
  options: {
    addr: { type: 'string', default: '127.0.0.1:8090' },
    backend: { type: 'string', default: 'http://127.0.0.1:8081/v1' },
    model: { type: 'string', default: '' },
    'key-env': { type: 'string', default: '' },
    profile: { type: 'string', default: 'strict' },
    grammar: { type: 'string', default: '' },
    extra: { type: 'string', default: '' },
  },
});

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (values.profile !== 'strict' && values.profile !== 'compact') die('--profile must be strict or compact');
const profile: Profile = values.profile;

const apiKey = values['key-env'] ? (process.env[values['key-env']] ?? '') : '';
if (values['key-env'] && !apiKey) die(`--key-env ${values['key-env']} is empty`);

const separator = values.addr.lastIndexOf(':');
const host = values.addr.slice(0, separator).replace(/^\[|\]$/g, '');
const port = Number(values.addr.slice(separator + 1));
const allInterfaces = host === '0.0.0.0' || host === '::';
if (allInterfaces) console.warn('warning: listening on all interfaces. There is no authentication; anyone who can reach this port can use your backend.');

let extra: Record<string, unknown>;
try {
  extra = parseExtra(values.extra);
} catch (e) {
  die(`--extra must be a JSON object: ${e instanceof Error ? e.message : e}`);
}

const baseURL = values.backend.replace(/\/+$/, '');
const grammar = values.grammar ? readFileSync(values.grammar, 'utf8') : '';
const app = createApp({
  backend: { baseURL, model: values.model, apiKey, grammar, extra },
  profile,
  hosts: ['localhost', '127.0.0.1', '::1', ...(host && !allInterfaces ? [host] : [])],
  staticDir: join(import.meta.dirname, '..', 'dist'),
});

app.listen(port, host, () => {
  console.log(`page: http://${values.addr}/  backend: ${backendHost(baseURL)}  model: ${JSON.stringify(values.model)}  profile: ${profile}  grammar: ${grammar !== ''}`);
});
