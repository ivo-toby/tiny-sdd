#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { attachCard, buildCard, newRegistryProfile } from './lib/card.mjs';
import { buildManifest } from './lib/dataset.mjs';
import { buildImage, oracleCheck } from './lib/docker.mjs';
import { readQueue, readResults, runQueue } from './lib/driver.mjs';
import { exportFailures } from './lib/export.mjs';
import { baselinePlan, confirmPlan, decide, screenPlan, screenSelection } from './lib/plans.mjs';
import { report } from './lib/report.mjs';
import { triage } from './lib/triage.mjs';
import { WORKER_TIMEOUT_MS } from './lib/worker-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage: node bench/polyglot/cli.mjs <command> [options] [--data DIR] [--json]

Setup (once):
  import                         write <data>/manifest.json from the dataset checkout
  image                          build the tinysdd-polyglot:1 Docker image
  oracle [--concurrency N]       check every exercise: stub fails, reference passes

Runs:
  init --run NAME --models K,K|all [--repeats N]   new run with baseline queue
  add-repeat --run NAME --models K,K --repeats N   extend baseline to N repeats
  profile --run NAME --id ID --file PATH [--note TEXT]   add a candidate profile (instructions text file)
  plan-screen --run NAME --model K --candidates ID,ID [--seed N] [--pass-sample N] [--metric pass1|pass2]
  plan-confirm --run NAME --model K --candidate ID [--repeats N]
  run --run NAME [--models K,K | --host titan|randal]   execute the queue (resumable)
  status --run NAME
  report --run NAME              write report.md / report.csv in the run dir
  triage --run NAME --model K [--profile ID]   Jev failure labels (discovery only)
  export --run NAME --model K [--profile ID]   discovery failures for the proposer
  decide --run NAME --model K --candidate ID [--metric pass1|pass2]   pre-registered keep/reject on holdout
  card --run NAME --model K [--profile ID] [--metric pass1|pass2] [--into FILE [--id ID]] [--note TEXT]
                                 registry benchmark card (aggregates only); --into adds it to a
                                 profile file, or creates one with --id
`;

const options = {
  data: { type: 'string' }, run: { type: 'string' }, models: { type: 'string' }, model: { type: 'string' },
  host: { type: 'string' }, repeats: { type: 'string' }, id: { type: 'string' }, file: { type: 'string' },
  note: { type: 'string' }, candidates: { type: 'string' }, candidate: { type: 'string' }, seed: { type: 'string' },
  'pass-sample': { type: 'string' }, profile: { type: 'string' }, concurrency: { type: 'string' },
  metric: { type: 'string' }, into: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
};

function fail(message) {
  const error = new Error(message);
  error.usage = true;
  throw error;
}

function required(values, name) {
  if (!values[name]) fail(`--${name} is required`);
  return values[name];
}

function int(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`--${name} must be a non-negative integer`);
  return parsed;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function paths(values) {
  const data = resolve(values.data ?? process.env.TINYSDD_BENCH_DATA ?? join(homedir(), 'workspace', 'tinysdd-bench-data'));
  const run = values.run ? join(data, 'runs', values.run) : null;
  return { data, checkout: join(data, 'polyglot-benchmark'), manifest: join(data, 'manifest.json'), oracle: join(data, 'oracle-check.json'), run };
}

async function loadModels() {
  return (await readJson(join(HERE, 'models.json'))).models;
}

function selectModels(all, list) {
  if (!list || list === 'all') return all;
  const keys = list.split(',').map((key) => key.trim()).filter(Boolean);
  const unknown = keys.filter((key) => !all.some((model) => model.key === key));
  if (unknown.length) fail(`unknown model(s): ${unknown.join(', ')}`);
  return all.filter((model) => keys.includes(model.key));
}

async function loadManifest(p) {
  if (!existsSync(p.manifest)) fail(`missing ${p.manifest}; run "import" first`);
  return readJson(p.manifest);
}

// Exercises whose own reference solution does not pass (or whose stub passes) say nothing about a model.
async function loadExcluded(p) {
  if (!existsSync(p.oracle)) fail(`missing ${p.oracle}; run "oracle" first`);
  const oracle = await readJson(p.oracle);
  return oracle.results.filter((r) => r.stubPassed !== false || r.referencePassed !== true).map((r) => r.id).sort();
}

async function appendQueue(runDir, entries) {
  const existing = new Set((await readQueue(runDir)).map((entry) => entry.id));
  const fresh = entries.filter((entry) => !existing.has(entry.id));
  if (fresh.length) await appendFile(join(runDir, 'queue.jsonl'), fresh.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  return { added: fresh.length, skippedExisting: entries.length - fresh.length };
}

function profileDoc(id, instructions) {
  return { schemaVersion: 1, id, runtime: { reasoning: true }, instructions };
}

function requireRun(p) {
  if (!p.run || !existsSync(join(p.run, 'run.json'))) fail(`run not found: ${p.run}; use "init" first`);
  return p.run;
}

const commands = {
  async import(values, p) {
    const manifest = await buildManifest({ checkoutDir: p.checkout });
    await writeJson(p.manifest, manifest);
    const bySplit = {};
    for (const exercise of manifest.exercises) bySplit[exercise.split] = (bySplit[exercise.split] ?? 0) + 1;
    return { manifest: p.manifest, commit: manifest.source.commit, exercises: manifest.exercises.length, bySplit };
  },

  async image() {
    await buildImage();
    return { image: 'tinysdd-polyglot:1', built: true };
  },

  async oracle(values, p) {
    const manifest = await loadManifest(p);
    const result = await oracleCheck({
      checkoutDir: p.checkout, manifest, concurrency: int(values.concurrency, 4, 'concurrency'), outFile: p.oracle,
      onProgress: (line) => process.stderr.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`),
    });
    return { oracle: p.oracle, summary: result.summary };
  },

  async init(values, p) {
    const name = required(values, 'run');
    if (existsSync(p.run)) fail(`run already exists: ${p.run}`);
    const models = selectModels(await loadModels(), required(values, 'models'));
    const manifest = await loadManifest(p);
    const excluded = await loadExcluded(p);
    await mkdir(join(p.run, 'profiles'), { recursive: true });
    await writeJson(join(p.run, 'profiles', 'baseline.json'), profileDoc('baseline', ''));
    await writeJson(join(p.run, 'profiles', 'baseline-rerun.json'), profileDoc('baseline-rerun', ''));
    await writeJson(join(p.run, 'run.json'), {
      name, createdAt: new Date().toISOString(), datasetCommit: manifest.source.commit,
      models: models.map((model) => model.key), excluded,
    });
    await writeFile(join(p.run, 'queue.jsonl'), '');
    const queued = await appendQueue(p.run, baselinePlan({ models, manifest, excluded, repeats: int(values.repeats, 1, 'repeats') }));
    return { run: p.run, models: models.map((model) => model.key), excluded, ...queued };
  },

  async 'add-repeat'(values, p) {
    const runDir = requireRun(p);
    const models = selectModels(await loadModels(), required(values, 'models'));
    const manifest = await loadManifest(p);
    const { excluded } = await readJson(join(runDir, 'run.json'));
    return appendQueue(runDir, baselinePlan({ models, manifest, excluded, repeats: int(required(values, 'repeats'), 2, 'repeats') }));
  },

  async profile(values, p) {
    const runDir = requireRun(p);
    const id = required(values, 'id');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.startsWith('baseline')) fail('--id must be lowercase letters, digits and hyphens, and not start with "baseline"');
    const target = join(runDir, 'profiles', `${id}.json`);
    if (existsSync(target)) fail(`profile ${id} already exists; profiles are immutable, pick a new id`);
    const instructions = (await readFile(resolve(required(values, 'file')), 'utf8')).trim();
    if (!instructions) fail('instructions file is empty');
    if (instructions.length > 4000) fail('instructions are longer than 4000 characters; keep candidates short');
    await writeJson(target, profileDoc(id, instructions));
    await writeJson(join(runDir, 'profiles', `${id}.meta.json`), { id, note: values.note ?? null, createdAt: new Date().toISOString(), chars: instructions.length });
    return { profile: target, chars: instructions.length };
  },

  async 'plan-screen'(values, p) {
    const runDir = requireRun(p);
    const model = required(values, 'model');
    const candidates = required(values, 'candidates').split(',').map((id) => id.trim()).filter(Boolean);
    for (const id of candidates) if (!existsSync(join(runDir, 'profiles', `${id}.json`))) fail(`profile ${id} not found; add it with "profile" first`);
    const seed = int(values.seed, 1, 'seed');
    const passSample = int(values['pass-sample'], 20, 'pass-sample');
    const metric = values.metric ?? 'pass2';
    const results = await readResults(runDir);
    const selection = screenSelection({ results, model, passSample, seed, metric });
    if (selection.failed.length === 0) fail(`no discovery baseline results failing ${metric} for ${model}; run the baseline first`);
    await writeJson(join(runDir, 'plans', `screen-${model}-seed${seed}-${candidates.join('+')}.json`), { model, candidates, ...selection });
    const queued = await appendQueue(runDir, screenPlan({ results, model, candidates, passSample, seed, metric }));
    return { model, candidates, seed, metric, failed: selection.failed.length, passSample: selection.passSample.length, ...queued };
  },

  async 'plan-confirm'(values, p) {
    const runDir = requireRun(p);
    const model = required(values, 'model');
    const candidate = required(values, 'candidate');
    if (!existsSync(join(runDir, 'profiles', `${candidate}.json`))) fail(`profile ${candidate} not found`);
    const manifest = await loadManifest(p);
    const { excluded } = await readJson(join(runDir, 'run.json'));
    return { model, candidate, ...(await appendQueue(runDir, confirmPlan({ model, candidate, manifest, excluded, repeats: int(values.repeats, 2, 'repeats') }))) };
  },

  async run(values, p) {
    const runDir = requireRun(p);
    let models = await loadModels();
    if (values.models) models = selectModels(models, values.models);
    if (values.host) models = models.filter((model) => (model.host ?? 'titan') === values.host);
    if (models.length === 0) fail('no models selected');
    const manifest = await loadManifest(p);
    const { excluded } = await readJson(join(runDir, 'run.json'));
    // Only this process's models run, so one process per host can share a run.
    const keys = new Set(models.map((model) => model.key));
    const summary = await runQueue({ runDir, models: await loadModels(), checkoutDir: p.checkout, manifest, excluded, onlyModels: keys });
    return { run: runDir, models: [...keys], summary };
  },

  async status(values, p) {
    const runDir = requireRun(p);
    const queue = await readQueue(runDir);
    const done = new Set((await readResults(runDir)).map((result) => result.id));
    const { excluded } = await readJson(join(runDir, 'run.json'));
    const skip = new Set(excluded);
    const byModel = {};
    for (const entry of queue) {
      if (skip.has(entry.exercise)) continue;
      const row = byModel[`${entry.model} ${entry.profile}`] ??= { queued: 0, done: 0 };
      row.queued += 1;
      if (done.has(entry.id)) row.done += 1;
    }
    let harnessErrors = 0;
    try { harnessErrors = (await readFile(join(runDir, 'harness-errors.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length; } catch {}
    return { run: runDir, byModelProfile: byModel, harnessErrors };
  },

  async report(values, p) {
    const runDir = requireRun(p);
    await report({ runDir });
    return { report: join(runDir, 'report.md'), csv: join(runDir, 'report.csv') };
  },

  async triage(values, p) {
    const runDir = requireRun(p);
    return triage({ runDir, model: required(values, 'model'), profile: values.profile ?? 'baseline', split: 'discovery', metric: values.metric ?? 'pass1', manifest: await loadManifest(p) });
  },

  async export(values, p) {
    const runDir = requireRun(p);
    const model = required(values, 'model');
    const profile = values.profile ?? 'baseline';
    const out = join(runDir, 'export', `${model}-${profile}`);
    await exportFailures({ runDir, model, profile, split: 'discovery', out, manifest: await loadManifest(p), checkoutDir: p.checkout, metric: values.metric ?? 'pass1' });
    return { export: out, files: [join(out, 'failures.md'), join(out, 'failures.json')] };
  },

  async decide(values, p) {
    const runDir = requireRun(p);
    const result = decide({ results: await readResults(runDir), model: required(values, 'model'), candidate: required(values, 'candidate'), metric: values.metric ?? 'pass2' });
    await writeJson(join(runDir, 'decisions', `${values.model}-${values.candidate}-${result.metric}.json`), { ...result, decidedAt: new Date().toISOString() });
    return result;
  },

  async card(values, p) {
    const runDir = requireRun(p);
    const key = required(values, 'model');
    const model = selectModels(await loadModels(), key)[0];
    const profile = values.profile ?? 'baseline';
    const run = await readJson(join(runDir, 'run.json'));
    const manifest = await loadManifest(p);
    let decision = null;
    if (profile !== 'baseline') {
      const file = join(runDir, 'decisions', `${key}-${profile}-${values.metric ?? 'pass1'}.json`);
      if (!existsSync(file)) fail(`no decision for ${profile}; run "decide" first`);
      decision = await readJson(file);
    }
    const card = buildCard({
      results: await readResults(runDir), runName: run.name, datasetCommit: run.datasetCommit,
      validExercises: manifest.exercises.length - run.excluded.length, model, profile,
      timeoutMs: WORKER_TIMEOUT_MS, decision, note: values.note,
    });
    if (!values.into) return card;
    const target = resolve(values.into);
    let doc;
    if (existsSync(target)) {
      doc = attachCard(await readJson(target), card);
    } else {
      const id = required(values, 'id');
      const instructions = (await readJson(join(runDir, 'profiles', `${profile}.json`))).instructions ?? '';
      doc = newRegistryProfile({ id, model, card, instructions });
    }
    await writeJson(target, doc);
    return { profile: target, id: doc.id, benchmarks: doc.benchmarks.length, card };
  },
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options, allowPositionals: false });
  if (!command || values.help || !commands[command]) {
    process.stdout.write(USAGE);
    process.exitCode = command && !values.help ? 2 : 0;
    return;
  }
  const result = await commands[command](values, paths(values));
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  if (error.usage) process.stderr.write(USAGE);
  process.exitCode = 1;
});
