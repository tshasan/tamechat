import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sample, type Prompt } from '../src/conform.ts';
import { backendFrom } from '../src/backendFlags.ts';
import {
  callCostUsd,
  inputTokensFor,
  isOpenRouter,
  openRouterPrices,
  plan,
  validateConfig,
  worstCaseUsd,
  type Job,
  type Price,
} from '../src/matrix.ts';

const root = join(import.meta.dirname, '..');
const usage = 'usage: matrix CONFIG.json [--dry-run] [--out runs/] [--only LABEL,...]';

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string', default: join(root, 'runs') },
    only: { type: 'string', default: '' },
  },
});
const configFile = positionals[0] ?? die(usage);
const config = validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
if (values.only) {
  const keep = new Set(values.only.split(','));
  config.runs = config.runs.filter((r) => keep.has(r.label));
  if (config.runs.length === 0) die(`--only matched no run labels`);
}
const promptsFile = config.prompts ? join(root, config.prompts) : join(root, 'corpus', 'prompts.json');
const promptsText = readFileSync(promptsFile, 'utf8');
const prompts = JSON.parse(promptsText) as Prompt[];
const jobs = plan(config, prompts.length);

// Prices: explicit in the config, else OpenRouter's catalogue. A model OpenRouter doesn't list is a typo
// or a retired id, so the dry run says so before anything is spent.
const catalogue = config.runs.some((r) => isOpenRouter(r.backend) && !r.price) ? await openRouterPrices() : new Map<string, Price>();
const priceOf = (job: Job): Price | null => job.spec.price ?? catalogue.get(job.spec.model) ?? (isOpenRouter(job.spec.backend) ? null : { inputPerMTok: 0, outputPerMTok: 0 });

let worst = 0;
const problems: string[] = [];
console.log(`${jobs.length} jobs, ${prompts.length} prompts x ${config.seeds} seeds each, max ${config.maxTokens} tokens per answer\n`);
console.log('| label | model | format | profile | grammar | calls | $/M in | $/M out | worst case $ |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const job of jobs) {
  const price = priceOf(job);
  if (!price) problems.push(`${job.spec.label}: ${job.spec.model} is not in OpenRouter's model list`);
  const cost = price ? worstCaseUsd(job, config, prompts, price) : NaN;
  worst += cost;
  console.log(`| ${job.spec.label} | ${job.spec.model} | ${job.format} | ${job.format === 'markdown' ? '-' : job.profile} | ${job.grammarFile ? 'yes' : 'no'} | ${job.calls} | ${price?.inputPerMTok.toFixed(2) ?? '?'} | ${price?.outputPerMTok.toFixed(2) ?? '?'} | ${cost.toFixed(3)} |`);
}
for (const env of new Set(jobs.map((j) => j.spec.keyEnv).filter((e): e is string => !!e))) {
  if (!process.env[env]) problems.push(`${env} is not set`);
}
console.log(`\nworst case if every answer hits the limit: $${worst.toFixed(2)}; budget $${config.budgetUsd.toFixed(2)}`);
for (const p of problems) console.log(`  problem: ${p}`);
if (values['dry-run']) process.exit(problems.length ? 1 : 0);
if (problems.length) die('\nfix the problems above first');

const git = (args: string[]) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(values.out, stamp);
mkdirSync(runDir, { recursive: true });
writeFileSync(
  join(runDir, 'manifest.json'),
  `${JSON.stringify(
    {
      started: new Date().toISOString(),
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']) !== '',
      promptsFile: promptsFile.replace(`${root}/`, ''),
      promptsSha256: createHash('sha256').update(promptsText).digest('hex'),
      config,
    },
    null,
    2,
  )}\n`,
);

let spent = 0;
let stopped = false;
for (const job of jobs) {
  if (stopped) break;
  const price = priceOf(job) as Price;
  const perCallWorst = callCostUsd(price, Math.max(...prompts.map((p) => inputTokensFor(job.format, job.profile, p))), config.maxTokens);
  // Checked before the first call too: after-the-fact checks alone let one call overshoot.
  if (spent + perCallWorst > config.budgetUsd) {
    console.log(`\nstopping before ${job.spec.label} / ${job.profile}: one call could cost $${perCallWorst.toFixed(4)}, $${(config.budgetUsd - spent).toFixed(4)} left`);
    stopped = true;
    break;
  }
  const dir = join(runDir, job.dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'answers.jsonl');
  writeFileSync(file, '');
  console.log(`\n== ${job.spec.label} / ${job.format === 'markdown' ? 'markdown' : job.profile}${job.grammarFile ? ' / grammar' : ''}  (spent so far $${spent.toFixed(4)})`);
  const extra = { ...(isOpenRouter(job.spec.backend) ? { usage: { include: true } } : {}), ...job.spec.extra };
  const { report } = await sample(
    {
      backend: backendFrom({
        backend: job.spec.backend,
        model: job.spec.model,
        'key-env': job.spec.keyEnv ?? '',
        grammar: job.grammarFile ? join(root, job.grammarFile) : '',
        extra: JSON.stringify(extra),
      }),
      profile: job.profile,
      prompts,
      samples: config.seeds,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      label: job.spec.label,
      verbose: true,
      seed: config.seedBase,
      format: job.format,
    },
    console.log,
    (r) => {
      appendFileSync(file, `${JSON.stringify(r)}\n`);
      spent += r.costUsd ?? callCostUsd(price, r.inputTokens, r.outputTokens);
      if (spent + perCallWorst > config.budgetUsd) {
        console.log(`\nstopping: $${spent.toFixed(4)} spent, the next call could pass the $${config.budgetUsd} budget`);
        stopped = true;
        return false;
      }
      return true;
    },
  );
  writeFileSync(join(dir, 'report.txt'), `${report}\n`);
  console.log(report);
}
writeFileSync(join(runDir, 'spent.json'), `${JSON.stringify({ usd: spent, stopped, finished: new Date().toISOString() }, null, 2)}\n`);
console.log(`\nwrote ${runDir} ($${spent.toFixed(4)} spent${stopped ? ', stopped on budget' : ''})`);
