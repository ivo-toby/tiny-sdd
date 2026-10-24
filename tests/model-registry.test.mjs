import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfig, validateProfileDocument } from '../src/config.mjs';
import { profileIdentityDigest, validateBenchmarkCard } from '../src/model-registry.mjs';
import { digestJson } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const PROFILES_DIR = fileURLToPath(new URL('../profiles/', import.meta.url));

function card(overrides = {}) {
  return {
    suite: 'aider-polyglot@7e0611e',
    harness: 'tinysdd bench/polyglot',
    date: '2026-10-22',
    variant: 'baseline',
    split: 'all',
    run: 'main',
    settings: { route: 'titan/llamacpp/gemma', contextWindow: 64000, maxTokens: 16384, thinking: 'medium', timeoutMs: 600000, parallel: 2 },
    exercises: 207,
    validExercises: 207,
    repeats: 1,
    pass1: 0.76,
    pass2: 0.88,
    minutesPerTask: 5.7,
    perLanguage: { rust: { n: 24, pass1: 0.62, pass2: 0.79 } },
    ...overrides,
  };
}

function registryProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'gemma-test-v1',
    status: 'baseline',
    model: { route: 'titan/llamacpp/gemma', family: 'gemma4-26b-a4b', quantization: 'Q4_K_M', server: { id: 'llama.cpp' }, contextWindow: 64000, parallel: 2 },
    runtime: { thinking: 'medium', reasoning: true },
    limits: { timeoutMs: 600000 },
    responseBudget: { maxTokens: 16384 },
    instructions: '',
    benchmarks: [card()],
    ...overrides,
  };
}

test('existing profiles without registry fields validate unchanged', () => {
  const legacy = {
    schemaVersion: 1,
    id: 'legacy',
    runtime: { thinking: 'off', reasoning: true },
    instructions: 'x',
    evidence: ['e'],
    limitations: ['l'],
  };
  assert.deepEqual(validateProfileDocument(structuredClone(legacy), 'legacy.json'), legacy);
});

test('every profile shipped in profiles/ validates', async () => {
  const files = (await readdir(PROFILES_DIR)).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  const ids = new Set();
  for (const name of files) {
    const profile = validateProfileDocument(JSON.parse(await readFile(join(PROFILES_DIR, name), 'utf8')), name);
    assert.equal(ids.has(profile.id), false, `duplicate profile id ${profile.id}`);
    ids.add(profile.id);
  }
});

test('a registry profile resolves through the project config with all fields', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-registry-'));
  try {
    await mkdir(join(root, '.tinysdd'), { recursive: true });
    await writeFile(join(root, 'profile.json'), JSON.stringify(registryProfile()));
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'gemma',
      workers: { gemma: { type: 'pi', provider: 'litellm', model: 'titan/llamacpp/gemma', profile: 'profile.json' } },
    }));
    const resolved = await resolveConfig(root);
    assert.deepEqual(resolved.profile, registryProfile());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registry fields are validated strictly', () => {
  const bad = [
    { status: 'great' },
    { model: { route: 'r', vendor: 'x' } },
    { model: { contextWindow: 0 } },
    { model: { server: { id: 'llama.cpp', build: 1 } } },
    { limits: { timeoutMs: 3_600_001 } },
    { limits: { timeoutMs: 1000, firstWriteMs: 1000 } },
    { limits: { tokens: 1 } },
    { responseBudget: { maxTokens: 1.5 } },
    { responseBudget: { maxTokens: 100, minTokens: 1 } },
    { benchmarks: {} },
    { benchmarks: [card({ pass1: 1.2 })] },
    { benchmarks: [card({ date: '22-10-2026' })] },
    { benchmarks: [card({ split: 'test' })] },
    { benchmarks: [card({ exercises: 300 })] },
    { benchmarks: [card({ settings: { thinking: 'max' } })] },
    { benchmarks: [card({ perLanguage: { rust: { n: 3, pass1: 0.5 } } })] },
    { benchmarks: [card({ decision: { metric: 'pass3', keep: false } })] },
    { benchmarks: [card({ traces: [] })] },
  ];
  for (const overrides of bad) {
    assert.throws(() => validateProfileDocument(registryProfile(overrides), 'p.json'), { code: 'PROFILE_INVALID' }, JSON.stringify(overrides));
  }
  const { pass2, ...missing } = card();
  assert.throws(() => validateBenchmarkCard(missing), { code: 'PROFILE_INVALID' });
});

test('a rejected candidate is recorded as a card with its decision', () => {
  const rejected = card({ variant: 'gemma26-r1-exact-text', split: 'holdout', exercises: 104, decision: { metric: 'pass1', keep: false, n: 104, delta: 0.038, reasons: ['delta_not_above_0.05'] } });
  const profile = validateProfileDocument(registryProfile({ benchmarks: [card(), rejected] }), 'p.json');
  assert.deepEqual(profile.benchmarks[1].decision.reasons, ['delta_not_above_0.05']);
});

async function registryProject(t, workerOverrides = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-registry-id-'));
  const configDir = join(root, 'home-config');
  const bundled = join(root, 'bundled');
  await mkdir(join(root, '.tinysdd', 'profiles'), { recursive: true });
  await mkdir(join(configDir, 'profiles'), { recursive: true });
  await mkdir(join(configDir, 'registry'), { recursive: true });
  await mkdir(bundled, { recursive: true });
  const previous = { config: process.env.TINYSDD_CONFIG_DIR, bundled: process.env.TINYSDD_BUNDLED_PROFILES_DIR };
  process.env.TINYSDD_CONFIG_DIR = configDir;
  process.env.TINYSDD_BUNDLED_PROFILES_DIR = bundled;
  t.after(async () => {
    for (const [key, value] of [['TINYSDD_CONFIG_DIR', previous.config], ['TINYSDD_BUNDLED_PROFILES_DIR', previous.bundled]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    defaultWorker: 'gemma',
    workers: { gemma: { type: 'pi', provider: 'litellm', model: 'titan/llamacpp/gemma', profile: 'gemma-test-v1', ...workerOverrides } },
  }));
  const put = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value));
  return { root, configDir, bundled, put };
}

test('a profile id resolves from the bundled registry and applies its limits', async (t) => {
  const { root, bundled, put } = await registryProject(t);
  await put(bundled, 'any-file-name.json', registryProfile({ limits: { timeoutMs: 900000 } }));
  const resolved = await resolveConfig(root);
  assert.equal(resolved.profile.id, 'gemma-test-v1');
  assert.equal(resolved.worker.limits.timeoutMs, 900000);
  assert.equal(resolved.worker.limits.maxToolCalls, 100);
  assert.equal(resolved.provenance.workers.gemma.profile.location, 'bundled');
  assert.equal(resolved.provenance.workers.gemma.profile.selectedBy, 'config');
  assert.equal(Object.hasOwn(resolved.worker, 'profileSource'), false);
});

test('the same id with different content in two places is ambiguous; identical copies are fine', async (t) => {
  const { root, configDir, bundled, put } = await registryProject(t);
  await put(bundled, 'gemma-test-v1.json', registryProfile());
  await put(join(configDir, 'registry'), 'gemma-test-v1.json', registryProfile());
  assert.equal((await resolveConfig(root)).provenance.workers.gemma.profile.location, 'registry');
  await put(join(root, '.tinysdd', 'profiles'), 'gemma-test-v1.json', registryProfile({ instructions: 'local edit' }));
  await assert.rejects(resolveConfig(root), { code: 'PROFILE_AMBIGUOUS' });
});

test('an unknown profile id fails without fallback', async (t) => {
  const { root } = await registryProject(t);
  await assert.rejects(resolveConfig(root), { code: 'PROFILE_NOT_FOUND' });
});

test('--profile replaces the selected worker profile and is recorded as the argument', async (t) => {
  const { root, configDir, bundled, put } = await registryProject(t);
  await put(bundled, 'gemma-test-v1.json', registryProfile());
  await put(join(configDir, 'profiles'), 'mine.json', registryProfile({ id: 'gemma-mine-v1', responseBudget: { maxTokens: 32768 } }));
  const resolved = await resolveConfig(root, { profile: 'gemma-mine-v1' });
  assert.equal(resolved.profile.id, 'gemma-mine-v1');
  assert.equal(resolved.worker.profile, 'gemma-mine-v1');
  assert.deepEqual(resolved.provenance.workers.gemma.profile, { id: 'gemma-mine-v1', location: 'user', path: join(configDir, 'profiles', 'mine.json'), selectedBy: 'argument' });
  await assert.rejects(resolveConfig(root, { profile: '../x.txt' }), { code: 'INVALID_PATH' });
});

test('a worker limit that contradicts the profile is a conflict; an equal one is allowed', async (t) => {
  const { root, bundled, put } = await registryProject(t, { limits: { timeoutMs: 300000 } });
  await put(bundled, 'gemma-test-v1.json', registryProfile());
  await assert.rejects(resolveConfig(root), { code: 'PROFILE_LIMIT_CONFLICT' });
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    defaultWorker: 'gemma',
    workers: { gemma: { type: 'pi', provider: 'litellm', model: 'titan/llamacpp/gemma', profile: 'gemma-test-v1', limits: { timeoutMs: 600000, maxToolCalls: 50 } } },
  }));
  const resolved = await resolveConfig(root);
  assert.equal(resolved.worker.limits.timeoutMs, 600000);
  assert.equal(resolved.worker.limits.maxToolCalls, 50);
});

test('the profile identity ignores evidence-only fields', () => {
  const legacy = { schemaVersion: 1, id: 'legacy', runtime: { thinking: 'off' }, evidence: ['e'] };
  assert.equal(profileIdentityDigest(legacy), digestJson(legacy));
  const profile = registryProfile();
  const withMoreEvidence = { ...profile, status: 'tested-inconclusive', benchmarks: [...profile.benchmarks, card({ variant: 'x', split: 'holdout' })] };
  assert.equal(profileIdentityDigest(withMoreEvidence), profileIdentityDigest(profile));
  assert.notEqual(profileIdentityDigest({ ...profile, responseBudget: { maxTokens: 32768 } }), profileIdentityDigest(profile));
});

test('the CLI passes --profile to config show and reports its origin', async (t) => {
  const { root, configDir, bundled, put } = await registryProject(t);
  await put(bundled, 'gemma-test-v1.json', registryProfile());
  await put(join(configDir, 'profiles'), 'mine.json', registryProfile({ id: 'gemma-mine-v1' }));
  const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--json', '--project', root, 'config', 'show', '--profile', 'gemma-mine-v1'], { env: { ...process.env } });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.profile.id, 'gemma-mine-v1');
  assert.equal(result.data.provenance.workers.gemma.profile.selectedBy, 'argument');
});
