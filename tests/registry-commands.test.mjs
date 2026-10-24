import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const canonicalTmpdir = await realpath(tmpdir());

function profile(id, route, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    status: 'baseline',
    model: { route, contextWindow: 64000, parallel: 2 },
    runtime: { thinking: 'medium', reasoning: true },
    limits: { timeoutMs: 600000 },
    responseBudget: { maxTokens: 16384 },
    instructions: '',
    benchmarks: [
      { suite: 'aider-polyglot@7e0611e', harness: 'tinysdd bench/polyglot', date: '2026-10-20', variant: 'baseline', split: 'all', exercises: 207, repeats: 1, pass1: 0.7, pass2: 0.8 },
      { suite: 'aider-polyglot@7e0611e', harness: 'tinysdd bench/polyglot', date: '2026-10-22', variant: 'baseline', split: 'all', exercises: 207, repeats: 1, pass1: 0.75, pass2: 0.88, minutesPerTask: 5.7 },
      { suite: 'aider-polyglot@7e0611e', harness: 'tinysdd bench/polyglot', date: '2026-10-23', variant: 'candidate-x', split: 'holdout', exercises: 104, repeats: 1, pass1: 0.9, pass2: 0.95 },
    ],
    ...overrides,
  };
}

// A project plus isolated user config and bundled profile directories.
async function sandbox(bundled = []) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-registry-cmd-'));
  const project = join(root, 'project');
  const config = join(root, 'config');
  const bundledDir = join(root, 'bundled');
  await mkdir(project, { recursive: true });
  await mkdir(bundledDir, { recursive: true });
  for (const entry of bundled) await writeFile(join(bundledDir, `${entry.id}.json`), JSON.stringify(entry));
  const env = { ...process.env, TINYSDD_CONFIG_DIR: config, TINYSDD_BUNDLED_PROFILES_DIR: bundledDir };
  async function cli(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [CLI, '--json', '--project', project, ...args], { env });
      return { ...JSON.parse(stdout), stderr };
    } catch (error) {
      if (!error.stdout) throw error;
      return { ...JSON.parse(error.stdout), stderr: error.stderr };
    }
  }
  return { root, project, config, bundledDir, env, cli, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const INIT = ['init', '--worker', 'local', '--provider', 'homelab'];

test('init selects the single profile measured on the model route', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma'), profile('qwen-v1', 'titan/qwen')]);
  try {
    const result = await box.cli(...INIT, '--model', 'titan/gemma');
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.profile, { selectedBy: 'route', id: 'gemma-v1', location: 'bundled', path: join(box.bundledDir, 'gemma-v1.json'), status: 'baseline' });
    const config = JSON.parse(await readFile(join(box.project, '.tinysdd', 'config.json'), 'utf8'));
    assert.equal(config.workers.local.profile, 'gemma-v1');
    const shown = await box.cli('config', 'show');
    assert.equal(shown.ok, true);
    assert.equal(shown.data.provenance.workers.local.profile.id, 'gemma-v1');
  } finally {
    await box.cleanup();
  }
});

test('init refuses to guess between several matching profiles and writes nothing', async () => {
  const box = await sandbox([profile('gemma-a-v1', 'titan/gemma'), profile('gemma-b-v1', 'titan/gemma')]);
  try {
    const result = await box.cli(...INIT, '--model', 'titan/gemma');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PROFILE_MATCH_AMBIGUOUS');
    assert.match(result.error.message, /gemma-a-v1, gemma-b-v1/u);
    await assert.rejects(readFile(join(box.project, '.tinysdd', 'config.json')), { code: 'ENOENT' });

    const picked = await box.cli(...INIT, '--model', 'titan/gemma', '--profile', 'gemma-b-v1');
    assert.equal(picked.ok, true);
    assert.equal(picked.data.profile.selectedBy, 'argument');
    const config = JSON.parse(await readFile(join(box.project, '.tinysdd', 'config.json'), 'utf8'));
    assert.equal(config.workers.local.profile, 'gemma-b-v1');
  } finally {
    await box.cleanup();
  }
});

test('init without a matching profile records the model and says so', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma')]);
  try {
    const result = await box.cli(...INIT, '--model', 'other/model');
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.profile, { selectedBy: 'none' });
    const config = JSON.parse(await readFile(join(box.project, '.tinysdd', 'config.json'), 'utf8'));
    assert.equal(config.workers.local.profile, undefined);
  } finally {
    await box.cleanup();
  }
});

test('init --profile for another route or an unknown id is an error', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma')]);
  try {
    const mismatch = await box.cli(...INIT, '--model', 'titan/qwen', '--profile', 'gemma-v1');
    assert.equal(mismatch.error.code, 'PROFILE_ROUTE_MISMATCH');
    const unknown = await box.cli(...INIT, '--model', 'titan/qwen', '--profile', 'nope-v1');
    assert.equal(unknown.error.code, 'PROFILE_NOT_FOUND');
    const alone = await box.cli('init', '--profile', 'gemma-v1');
    assert.equal(alone.error.code, 'INVALID_ARGUMENT');
    await assert.rejects(readFile(join(box.project, '.tinysdd', 'config.json')), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('models lists profiles with their newest baseline numbers and flags conflicts', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma'), profile('dup-v1', 'titan/dup')]);
  try {
    await mkdir(join(box.config, 'profiles'), { recursive: true });
    await writeFile(join(box.config, 'profiles', 'dup.json'), JSON.stringify(profile('dup-v1', 'titan/dup', { status: 'proposed' })));
    await writeFile(join(box.config, 'profiles', 'broken.json'), '{');
    const result = await box.cli('models');
    assert.equal(result.ok, true);
    const gemma = result.data.profiles.find((entry) => entry.id === 'gemma-v1');
    assert.deepEqual(gemma.headline, { suite: 'aider-polyglot@7e0611e', date: '2026-10-22', exercises: 207, pass1: 0.75, pass2: 0.88, minutesPerTask: 5.7 });
    assert.equal(gemma.maxTokens, 16384);
    assert.equal(gemma.conflict, false);
    const dups = result.data.profiles.filter((entry) => entry.id === 'dup-v1');
    assert.deepEqual(dups.map((entry) => [entry.location, entry.conflict]), [['user', true], ['bundled', true]]);
    assert.match(result.data.warnings.join('\n'), /broken\.json/u);
    assert.match(result.data.warnings.join('\n'), /no profile registry installed/u);

    const filtered = await box.cli('models', '--route', 'titan/gemma');
    assert.deepEqual(filtered.data.profiles.map((entry) => entry.id), ['gemma-v1']);

    // A conflicting id is never matched by init.
    const init = await box.cli(...INIT, '--model', 'titan/dup');
    assert.deepEqual(init.data.profile, { selectedBy: 'none' });
  } finally {
    await box.cleanup();
  }
});

test('models warns when the installed registry is from another version', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma')]);
  try {
    await mkdir(join(box.config, 'registry'), { recursive: true });
    await writeFile(join(box.config, 'registry', '.registry.json'), JSON.stringify({ schemaVersion: 1, version: '0.0.1' }));
    await writeFile(join(box.config, 'registry', 'gemma-v1.json'), JSON.stringify(profile('gemma-v1', 'titan/gemma', { status: 'tested-inconclusive' })));
    const result = await box.cli('models');
    assert.match(result.data.warnings.join('\n'), /from 0\.0\.1.*profiles update/u);
    const run = await box.cli(...INIT, '--model', 'titan/gemma', '--profile', 'gemma-v1');
    assert.equal(run.error.code, 'PROFILE_AMBIGUOUS');
    assert.match(run.error.message, /tinysdd profiles update/u);
  } finally {
    await box.cleanup();
  }
});

test('profiles new writes a configuration-only local profile', async () => {
  const box = await sandbox([profile('gemma-v1', 'titan/gemma')]);
  try {
    const result = await box.cli('profiles', 'new', '--route', 'titan/new-model', '--context-window', '64000', '--parallel', '2', '--max-tokens', '32768', '--timeout-ms', '900000', '--thinking', 'low', '--quantization', 'Q4_K_M', '--server', 'llama.cpp');
    assert.equal(result.ok, true);
    const path = join(box.config, 'profiles', 'titan-new-model-local-v1.json');
    assert.equal(result.data.path, path);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(written, {
      schemaVersion: 1,
      id: 'titan-new-model-local-v1',
      status: 'proposed',
      model: { route: 'titan/new-model', quantization: 'Q4_K_M', server: { id: 'llama.cpp' }, contextWindow: 64000, parallel: 2 },
      runtime: { thinking: 'low' },
      responseBudget: { maxTokens: 32768 },
      limits: { timeoutMs: 900000 },
      instructions: '',
      evidence: [],
      limitations: ['Created with tinysdd profiles new; not benchmarked.'],
    });

    const init = await box.cli(...INIT, '--model', 'titan/new-model');
    assert.equal(init.data.profile.id, 'titan-new-model-local-v1');
    assert.equal(init.data.profile.location, 'user');

    const again = await box.cli('profiles', 'new', '--route', 'titan/new-model');
    assert.equal(again.error.code, 'PROFILE_EXISTS');
    const taken = await box.cli('profiles', 'new', '--route', 'x/y', '--id', 'gemma-v1');
    assert.equal(taken.error.code, 'PROFILE_EXISTS');
    const noRoute = await box.cli('profiles', 'new');
    assert.equal(noRoute.error.code, 'INVALID_ARGUMENT');
    const badThinking = await box.cli('profiles', 'new', '--route', 'x/y', '--thinking', 'max');
    assert.equal(badThinking.error.code, 'INVALID_ARGUMENT');
    const badNumber = await box.cli('profiles', 'new', '--route', 'x/y', '--max-tokens', '12k');
    assert.equal(badNumber.error.code, 'INVALID_ARGUMENT');
  } finally {
    await box.cleanup();
  }
});

test('update commands are global', async () => {
  const box = await sandbox();
  try {
    for (const args of [['skills', 'update'], ['profiles', 'update']]) {
      const result = await box.cli(...args);
      assert.equal(result.error.code, 'SETUP_PROJECT_UNSUPPORTED');
    }
  } finally {
    await box.cleanup();
  }
});
