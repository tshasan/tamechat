import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createApp } from '../../src/server.ts';
import { disabledTelemetry } from '../../src/telemetry.ts';
import { e2e } from './e2e.ts';
import { markdown } from './markdown.ts';
import { startFake } from './fake.ts';
import { redteam } from './redteam.ts';

const fake = await startFake();
const app = createApp({
  backend: { baseURL: `${fake.url}/v1`, model: 'fake', apiKey: 'k', grammar: '', extra: {} },
  profile: 'compact',
  hosts: ['localhost', '127.0.0.1', '::1'],
  staticDir: join(import.meta.dirname, '..', '..', 'dist'),
  telemetry: disabledTelemetry,
});
await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

const browser = await chromium.launch();
const failed = (await e2e(browser, base, fake)) + (await markdown(browser, base)) + (await redteam(browser, base, fake));
await browser.close();
app.close();
await fake.close();

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
