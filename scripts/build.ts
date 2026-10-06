import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const web = join(root, 'web');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({ entryPoints: [join(web, 'app.ts')], outfile: join(dist, 'app.js'), bundle: true, format: 'esm', target: 'es2022' });

const sandbox = await build({ entryPoints: [join(web, 'sandbox.ts')], bundle: true, format: 'iife', target: 'es2022', write: false });
const script = sandbox.outputFiles[0]?.text ?? '';
if (script.includes('</script')) throw new Error('sandbox script cannot be inlined');
const page = readFileSync(join(web, 'sandbox.html'), 'utf8').replace('<script></script>', () => `<script>\n${script}</script>`);
writeFileSync(join(dist, 'sandbox.html'), page);

for (const file of ['index.html', 'style.css']) copyFileSync(join(web, file), join(dist, file));
