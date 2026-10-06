import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sample, type Prompt } from '../src/conform.ts';
import { parseExtra } from '../src/model.ts';
import { subset, type Profile } from '../src/subset.ts';
import { describe, validate } from '../src/validate.ts';

const usage = `usage: conform check [--profile strict|compact] [--widgets] FILE...
       conform sample --backend URL --model NAME [--profile ...] [--prompts FILE] [--n N] [--grammar FILE] [--key-env VAR] [--extra JSON]`;

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function profileOf(value: string): Profile {
  if (value !== 'strict' && value !== 'compact') die('--profile must be strict or compact');
  return value;
}

function check(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { profile: { type: 'string', default: 'strict' }, widgets: { type: 'boolean', default: false } },
  });
  if (positionals.length === 0) die(usage);
  const profile = profileOf(values.profile);
  let invalid = 0;
  for (const file of positionals) {
    const src = readFileSync(file === '-' ? 0 : file, 'utf8');
    const violations = validate(subset, src, { profile, widgets: values.widgets });
    if (violations.length === 0) {
      console.log(`ok       ${file}`);
      continue;
    }
    invalid++;
    console.log(`INVALID  ${file}`);
    for (const v of violations) console.log(`           ${describe(v)}`);
  }
  return invalid > 0 ? 1 : 0;
}

async function runSample(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      backend: { type: 'string', default: 'http://127.0.0.1:8081/v1' },
      model: { type: 'string', default: '' },
      'key-env': { type: 'string', default: '' },
      profile: { type: 'string', default: 'strict' },
      prompts: { type: 'string', default: '' },
      n: { type: 'string', default: '1' },
      grammar: { type: 'string', default: '' },
      'max-tokens': { type: 'string', default: '900' },
      temp: { type: 'string', default: '0.7' },
      label: { type: 'string', default: '' },
      extra: { type: 'string', default: '' },
      v: { type: 'boolean', default: false },
    },
  });
  const promptsFile = values.prompts || new URL('../corpus/prompts.json', import.meta.url);
  const prompts = JSON.parse(readFileSync(promptsFile, 'utf8')) as Prompt[];
  const apiKey = values['key-env'] ? (process.env[values['key-env']] ?? '') : '';
  if (values['key-env'] && !apiKey) die(`${values['key-env']} is empty`);
  let extra: Record<string, unknown>;
  try {
    extra = parseExtra(values.extra);
  } catch (e) {
    die(`--extra must be a JSON object: ${e instanceof Error ? e.message : e}`);
  }
  const report = await sample(
    {
      backend: { baseURL: values.backend, model: values.model, apiKey, grammar: values.grammar ? readFileSync(values.grammar, 'utf8') : '', extra },
      profile: profileOf(values.profile),
      prompts,
      samples: Number(values.n),
      maxTokens: Number(values['max-tokens']),
      temperature: Number(values.temp),
      label: values.label,
      verbose: values.v,
    },
    console.log,
  );
  console.log(report);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'check') process.exit(check(rest));
else if (command === 'sample') process.exit(await runSample(rest).catch((e) => die(e instanceof Error ? e.message : String(e))));
else die(usage);
