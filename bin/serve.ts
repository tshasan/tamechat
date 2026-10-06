import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { backendFrom, backendOptions } from '../src/backendFlags.ts';
import { backendHost } from '../src/model.ts';
import { createApp } from '../src/server.ts';
import { disabledTelemetry, startTelemetry } from '../src/telemetry.ts';

const { values } = parseArgs({
  options: {
    ...backendOptions,
    addr: { type: 'string', default: '127.0.0.1:8090' },
    profile: { type: 'string', default: 'strict' },
    'trace-file': { type: 'string', default: '' },
  },
});

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (values.profile !== 'strict' && values.profile !== 'compact') die('--profile must be strict or compact');
const { profile } = values;

const separator = values.addr.lastIndexOf(':');
const host = values.addr.slice(0, separator).replace(/^\[|\]$/g, '');
const port = Number(values.addr.slice(separator + 1));
const allInterfaces = host === '0.0.0.0' || host === '::';
if (allInterfaces) console.warn('warning: listening on all interfaces. There is no authentication; anyone who can reach this port can use your backend.');

const backend = (() => {
  try {
    return backendFrom(values);
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
})();

const otlp = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
const telemetry = otlp || values['trace-file'] ? startTelemetry({ file: values['trace-file'], otlp }) : disabledTelemetry;

const app = createApp({
  backend,
  profile,
  hosts: ['localhost', '127.0.0.1', '::1', ...(host && !allInterfaces ? [host] : [])],
  staticDir: join(import.meta.dirname, '..', 'dist'),
  telemetry,
});

app.listen(port, host, () => {
  console.log(`page: http://${values.addr}/  backend: ${backendHost(backend.baseURL)}  model: ${JSON.stringify(backend.model)}  profile: ${profile}  grammar: ${backend.grammar !== ''}  tracing: ${telemetry.enabled}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void telemetry.shutdown().finally(() => process.exit(0)));
}
