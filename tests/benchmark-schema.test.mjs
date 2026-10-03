import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BENCHMARK_ROLES,
  BENCHMARK_UNKNOWN,
  assertRunnableBenchmarkRole,
  buildBenchmarkConfigIdentity,
  parseBenchmarkChallenge,
  parseBenchmarkSuite,
} from '../src/benchmark-schema.mjs';

const digest = (letter) => letter.repeat(64);

const fullConfig = () => ({
  model: {
    provider: 'local-provider',
    id: 'small-model',
    quantization: 'Q4_K_M',
    server: { id: 'server-a', version: '1.2.3' },
  },
  worker: {
    profileDigest: digest('a'),
    limits: { timeoutMs: 300000, maxToolCalls: 40, firstWriteMs: 120000 },
    settings: { sandbox: 'bubblewrap', tools: ['read', 'write', 'edit'] },
  },
  pi: { version: '1.0.0' },
  tinySdd: { version: '0.1.0', codeRevision: digest('b') },
  suite: { id: 'contract-fixture', version: '2026-10-03.1', contentSha256: digest('c') },
  verifier: {
    configSha256: digest('d'),
    checkRunner: { version: 'runner-1', configSha256: digest('e') },
  },
  runChecks: {
    declared: true,
    available: false,
    budget: 12,
    unavailableReason: 'Linux runner unavailable',
    provenance: { source: 'runtime.json', unavailableReason: 'Linux runner unavailable' },
  },
  environment: { runtime: 'node', runtimeVersion: '22.19.0', platform: 'linux', arch: 'x64' },
});

test('parses the frozen suite and challenge fixture schemas', async () => {
  const suite = parseBenchmarkSuite(await readFile(new URL('./fixtures/benchmark-suite/suite.json', import.meta.url), 'utf8'));
  const challenge = parseBenchmarkChallenge(await readFile(new URL('./fixtures/benchmark-suite/challenge.json', import.meta.url), 'utf8'));
  assert.equal(suite.challenges.length, 2);
  assert.equal(suite.defaults.repeat, 2);
  assert.equal(challenge.role, 'implement-slice');
  assert.deepEqual(challenge.packet.allowedPaths, ['src/index.mjs']);
});

test('accepts every declared role in the schema and gates execution separately', () => {
  const base = {
    schemaVersion: 1,
    id: 'slice',
    version: '1',
    difficultyTags: ['small'],
    fixture: { path: 'fixtures/slice', sha256: digest('a') },
    packet: {
      brief: { path: 'packets/slice/brief.md', sha256: digest('a') },
      context: { path: 'packets/slice/context.json', sha256: digest('a') },
      checks: { path: 'packets/slice/checks.json', sha256: digest('a') },
      allowedPaths: ['src/index.mjs'],
      protectedPaths: [],
    },
    verifier: {
      visible: { path: 'verifier/visible.json', sha256: digest('a') },
      heldOut: { path: 'verifier/held-out.json', sha256: digest('a') },
    },
  };
  for (const role of BENCHMARK_ROLES) {
    assert.doesNotThrow(() => parseBenchmarkChallenge(JSON.stringify({ ...base, role })), role);
  }
  assert.doesNotThrow(() => assertRunnableBenchmarkRole('implement-slice'));
  assert.throws(() => assertRunnableBenchmarkRole('research'), { code: 'BENCHMARK_ROLE_UNSUPPORTED' });
});

test('rejects duplicate ids, unsafe roots, hidden fixture paths, and extra keys', () => {
  const suite = {
    schemaVersion: 1,
    id: 'suite',
    version: '1',
    challenges: [{ path: 'challenges/a.json', sha256: digest('a') }, { path: 'challenges/a.json', sha256: digest('b') }],
  };
  assert.throws(() => parseBenchmarkSuite(JSON.stringify(suite)), { code: 'BENCHMARK_SCHEMA_INVALID' });

  const challenge = {
    schemaVersion: 1,
    id: 'slice',
    version: '1',
    role: 'implement-slice',
    difficultyTags: ['small', 'small'],
    fixture: { path: 'fixtures/slice/.hidden', sha256: digest('a') },
    packet: {
      brief: { path: 'packets/slice/brief.md', sha256: digest('a') },
      context: { path: 'packets/slice/context.json', sha256: digest('a') },
      checks: { path: 'packets/slice/checks.json', sha256: digest('a') },
      allowedPaths: ['src/index.mjs'],
      protectedPaths: [],
    },
    verifier: {
      visible: { path: 'verifier/visible.json', sha256: digest('a') },
      heldOut: { path: 'verifier/held-out.json', sha256: digest('a') },
    },
    extra: true,
  };
  assert.throws(() => parseBenchmarkChallenge(JSON.stringify(challenge)), { code: 'BENCHMARK_SCHEMA_INVALID' });
  assert.throws(() => parseBenchmarkChallenge(JSON.stringify({ ...challenge, extra: undefined, difficultyTags: ['small'], fixture: { path: '../fixtures/slice', sha256: digest('a') } })), { code: 'BENCHMARK_SCHEMA_INVALID' });
});

test('config identity is canonical and changes when a benchmark condition changes', () => {
  const base = buildBenchmarkConfigIdentity(fullConfig());
  assert.equal(base.identity.missing.length, 0);
  assert.equal(base.configDigest.length, 64);
  assert.equal(base.configDigest, buildBenchmarkConfigIdentity(fullConfig()).configDigest);

  for (const change of [
    (config) => { config.model.quantization = 'Q8_0'; },
    (config) => { config.worker.profileDigest = digest('f'); },
    (config) => { config.pi.version = '1.0.1'; },
    (config) => { config.tinySdd.codeRevision = digest('f'); },
    (config) => { config.suite.contentSha256 = digest('f'); },
    (config) => { config.verifier.checkRunner.configSha256 = digest('f'); },
    (config) => { config.runChecks.available = true; },
    (config) => { config.runChecks.budget = 13; },
    (config) => { config.worker.limits.timeoutMs = 301000; },
    (config) => { config.worker.limits.maxToolCalls = 41; },
    (config) => { config.worker.limits.firstWriteMs = 121000; },
  ]) {
    const changed = fullConfig();
    change(changed);
    assert.notEqual(buildBenchmarkConfigIdentity(changed).configDigest, base.configDigest);
  }
});

test('missing identity fields are explicit UNKNOWN values with reasons', () => {
  const result = buildBenchmarkConfigIdentity({ model: { provider: 'p', id: 'm' } });
  assert.equal(result.identity.model.quantization, BENCHMARK_UNKNOWN);
  assert.equal(result.identity.runChecks.available, BENCHMARK_UNKNOWN);
  assert.ok(result.identity.missing.some((entry) => entry.field === 'model.quantization'));
  assert.ok(result.identity.missing.some((entry) => entry.field === 'runChecks.available'));
  assert.equal(result.identity.missing.length > 1, true);
});

test('config metadata rejects credential-shaped fields', () => {
  const config = fullConfig();
  config.worker.settings = { apiKey: 'should-never-be-recorded' };
  assert.throws(() => buildBenchmarkConfigIdentity(config), { code: 'BENCHMARK_CONFIG_INVALID' });
});
