import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGrammar, grammarName, variants } from '../src/grammar.ts';

const dir = join(import.meta.dirname, '..', 'grammar');
for (const variant of variants) writeFileSync(join(dir, grammarName(variant)), buildGrammar(variant));
console.log(variants.map(grammarName).join(', '));
