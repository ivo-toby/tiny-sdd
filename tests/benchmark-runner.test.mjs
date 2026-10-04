import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { digestJson, sha256 } from '../src/fs-utils.mjs';
import { benchmarkFixtureDigest, inspectBenchmarkIdentity, RESERVED_VERIFIER_ROOT, runBenchmark } from '../src/benchmark-runner.mjs';
import { parseBenchmarkInvocation } from '../src/benchmark-results.mjs';

const digest = (value) => sha256(value);
const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text);
  return { path, sha256: digest(text) };
}

async function makeRuntime(root) {
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeJson(join(agent, 'models.json'), {
    providers: {
      fake: {
        api: 'openai-completions',
        baseUrl: '$FAKE_BASE',
        apiKey: '$FAKE_TOKEN',
        models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false }],
      },
    },
  });
  const pi = join(root, 'fake-pi.mjs');
  await writeFile(pi, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const challenge = process.env.TINYSDD_TEST_CHALLENGE;
if (process.env.TINYSDD_TEST_SPAWN_MARKER) writeFileSync(process.env.TINYSDD_TEST_SPAWN_MARKER, 'spawned\\n');
if (existsSync(join(process.cwd(), 'verifier', 'held-out.test.mjs'))) {
  writeFileSync(join(process.cwd(), 'src', 'worker-saw-hidden.txt'), 'leak\\n');
}
if (challenge === 'slow-slice' && process.env.TINYSDD_TEST_REPETITION === '2') {
  writeFileSync(join(process.cwd(), 'src', 'index.mjs'), 'slow\\n');
  await new Promise((resolve) => setTimeout(resolve, 2500));
} else {
  writeFileSync(join(process.cwd(), 'src', 'index.mjs'), 'changed\\n');
}
if (process.env.TINYSDD_TEST_MUTATE_VERIFIER && challenge === 'slow-slice' && process.env.TINYSDD_TEST_REPETITION === '1') {
  writeFileSync(process.env.TINYSDD_TEST_MUTATE_VERIFIER, 'mutated by test Pi\\n');
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));
`);
  await chmod(pi, 0o755);
  return {
    test: true,
    piExecutable: pi,
    sourceAgentDir: agent,
    sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
    testEnv: { TINYSDD_TEST_CHALLENGE: 'normal-slice', TINYSDD_TEST_SPAWN_MARKER: join(root, 'pi-spawned') },
    checkRunner: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      output: { text: '', tail: '', truncated: false },
      sandbox: { runner: 'test-check-runner', network: 'none' },
    }),
  };
}

async function makeSuite(root, { heldOutInsideFixture = false, pathFlagVerifier = false } = {}) {
  await mkdir(join(root, 'challenges'), { recursive: true });
  const challengeDefinitions = heldOutInsideFixture
    ? [{ id: 'hidden-slice', fixtureFiles: { 'src/index.mjs': 'before\n', 'tests/contract.test.mjs': 'export {};\n', 'held-out.test.mjs': 'hidden\n' }, heldOutInsideFixture: true }]
    : [
      { id: 'slow-slice', fixtureFiles: { 'src/index.mjs': 'before\n', 'tests/contract.test.mjs': 'export {};\n' } },
      { id: 'collision-slice', fixtureFiles: { 'src/index.mjs': 'before\n', 'tests/contract.test.mjs': 'export {};\n', '__tinysdd_benchmark_verifier/visible/collision-slice-visible.test.mjs': 'candidate collision\n' } },
    ];
  const challengeRefs = [];
  for (const definition of challengeDefinitions) {
    const fixture = join(root, 'fixtures', definition.id);
    await mkdir(fixture, { recursive: true });
    for (const [path, text] of Object.entries(definition.fixtureFiles)) {
      const target = join(fixture, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, text);
    }
    const packetRoot = join(root, 'packets', definition.id);
    await mkdir(packetRoot, { recursive: true });
    await writeFile(join(packetRoot, 'brief.md'), `Implement ${definition.id}.\n`);
    await writeJson(join(packetRoot, 'context.json'), { schemaVersion: 1, facts: [], resources: [] });
    await writeJson(join(packetRoot, 'checks.json'), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'visible', argv: ['node', '--test', 'visible.test.mjs'], timeoutMs: 1000 }],
    });
    const verifierRoot = join(root, 'verifier');
    await mkdir(verifierRoot, { recursive: true });
    await writeFile(join(verifierRoot, `${definition.id}-visible.test.mjs`), 'export {};\n');
    await writeFile(join(verifierRoot, `${definition.id}-held-out.test.mjs`), 'export {};\n');
    if (pathFlagVerifier) await writeFile(join(verifierRoot, `${definition.id}-preload.cjs`), 'module.exports = {};\n');
    const visibleArgv = pathFlagVerifier
      ? pathFlagVerifier === 'inline'
        ? ['node', `--require=verifier/${definition.id}-preload.cjs`, '--test', `verifier/${definition.id}-visible.test.mjs`]
        : ['node', '--require', `verifier/${definition.id}-preload.cjs`, '--test', `verifier/${definition.id}-visible.test.mjs`]
      : ['node', '--test', `verifier/${definition.id}-visible.test.mjs`];
    const visible = await writeJson(join(verifierRoot, `${definition.id}-visible.json`), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'visible', argv: visibleArgv, timeoutMs: 1000 }],
    });
    const heldOut = await writeJson(join(verifierRoot, `${definition.id}-held-out.json`), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'held-out', argv: ['node', '--test', definition.heldOutInsideFixture ? `fixtures/${definition.id}/held-out.test.mjs` : `verifier/${definition.id}-held-out.test.mjs`], timeoutMs: 1000 }],
    });
    challengeRefs.push(await writeJson(join(root, 'challenges', `${definition.id}.json`), {
      schemaVersion: 1,
      id: definition.id,
      version: '1',
      role: 'implement-slice',
      difficultyTags: ['small'],
      fixture: { path: `fixtures/${definition.id}`, sha256: (await benchmarkFixtureDigest(fixture)).sha256 },
      packet: {
        brief: { path: `packets/${definition.id}/brief.md`, sha256: (await writeFile(join(packetRoot, 'brief.md'), `Implement ${definition.id}.\n`).then(() => digest(`Implement ${definition.id}.\n`))) },
        context: { path: `packets/${definition.id}/context.json`, sha256: digest(`${JSON.stringify({ schemaVersion: 1, facts: [], resources: [] })}\n`) },
        checks: { path: `packets/${definition.id}/checks.json`, sha256: digest(`${JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'visible', argv: ['node', '--test', 'visible.test.mjs'], timeoutMs: 1000 }] })}\n`) },
        allowedPaths: ['src/index.mjs'],
        protectedPaths: ['tests/contract.test.mjs'],
      },
      verifier: {
        visible: { path: `verifier/${definition.id}-visible.json`, sha256: visible.sha256 },
        heldOut: { path: `verifier/${definition.id}-held-out.json`, sha256: heldOut.sha256 },
      },
    }));
  }
  const suite = await writeJson(join(root, 'suite.json'), {
    schemaVersion: 1,
    id: 'runner-fixture',
    version: '1',
    challenges: challengeRefs.map(({ path, sha256 }) => ({ path: path.slice(root.length + 1), sha256 })),
    defaults: { repeat: 2 },
  });
  return suite;
}

test('runs fresh repeated fixtures, retains timeout/setup attempts, and defers held-out overlays', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-runner-')));
  const output = join(root, 'results');
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const seen = [];
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: output,
      worker,
      runtime,
      checkRunnerOptions: { limits: { storedOutputBytes: 12345 } },
      verifier: async ({ visibility, candidateDir, checkRunnerOptions }) => {
        seen.push({ visibility, candidateDir, checkRunnerOptions });
        return { status: 'passed', outputText: `${visibility}\n`, sandbox: { runner: 'test-only', network: 'none' } };
      },
    });
    assert.equal(result.invocation.caseResults.length, 4);
    assert.equal(result.summary.groups[0].scheduled, 4);
    assert.equal(result.summary.groups[0].completed, 1);
    assert.equal(result.summary.groups[0].incomplete, 1);
    assert.equal(result.summary.groups[0].failed, 2);
    assert.equal(seen.length, 4);
    const invocation = parseBenchmarkInvocation(await readFile(join(output, 'invocation.json'), 'utf8'));
    assert.equal(invocation.configIdentity.runChecks.available, true);
    assert.equal(invocation.configIdentity.runChecks.budget, 12);
    assert.notEqual(invocation.configIdentity.tinySdd.codeRevision, 'UNKNOWN');
    const cases = await Promise.all(invocation.caseResults.map(async ({ path }) => JSON.parse(await readFile(join(output, path), 'utf8'))));
    assert.ok(cases.every((entry) => entry.observed.runChecks.available === true));
    assert.ok(seen.every(({ candidateDir, checkRunnerOptions }) => candidateDir.includes('tinysdd-benchmark-evaluator-')
      && checkRunnerOptions.limits.storedOutputBytes === 12345));
    assert.equal(cases.filter((entry) => entry.outcome === 'timeout').length, 1);
    assert.equal(cases.filter((entry) => entry.failure.missing.some(({ field }) => field === 'attempt')).length, 2);
    for (const entry of cases) {
      assert.ok(entry.verifier.heldOut.length === 1);
      for (const name of ['prompt', 'workspace-before', 'workspace-after', 'candidate']) {
        const evidence = await readFile(join(output, entry.artifacts[name].path), 'utf8');
        assert.doesNotMatch(evidence, /held-out\.test\.mjs/u);
      }
      const candidateManifestText = await readFile(join(output, entry.artifacts['candidate-files'].path), 'utf8');
      assert.doesNotMatch(candidateManifestText, /held-out\.test\.mjs/u);
      const candidateManifest = JSON.parse(candidateManifestText);
      assert.ok(candidateManifest.tree.entries.some(({ path }) => path === 'src/index.mjs'));
      await access(join(output, candidateManifest.root, 'src', 'index.mjs'));
    }
    assert.equal(await readFile(join(root, 'fixtures', 'slow-slice', 'src', 'index.mjs'), 'utf8'), 'before\n');
    await assert.rejects(
      runBenchmark({ suiteRoot: root, worker, runtime, model: { provider: 'other' } }),
      { code: 'BENCHMARK_RUNNER_INVALID' },
    );
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('binds a missing test check runner as unavailable in worker identity', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-runner-unavailable-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    delete runtime.checkRunner;
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      repeat: 1,
    });
    assert.equal(result.config.identity.runChecks.available, false);
    assert.equal(
      result.config.identity.runChecks.unavailableReason,
      process.platform === 'linux' ? 'test runtime did not provide a check runner' : result.config.identity.runChecks.unavailableReason,
    );
    const caseResult = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(caseResult.observed.runChecks.available, false);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps an undeclared task check context distinct in the benchmark identity', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-runner-check-declaration-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const declared = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'declared'), worker, runtime, repeat: 1, verifier: async () => ({ status: 'passed' }) });
    await assert.rejects(
      runBenchmark({ suiteRoot: root, outputRoot: join(root, 'undeclared'), worker, runtime, repeat: 1, verifier: async () => ({ status: 'passed' }), runChecksDeclared: false }),
      (error) => error.code === 'BENCHMARK_RUNNER_INVALID' && /declared task check context/u.test(error.message),
    );
    await assert.rejects(access(join(root, 'undeclared')), { code: 'ENOENT' });
    const undeclared = await inspectBenchmarkIdentity({
      projectRoot: root,
      suiteRoot: root,
      worker,
      runtime,
      verifierMode: 'test-injection',
      runChecksDeclared: false,
    });
    assert.equal(declared.config.identity.runChecks.declared, true);
    assert.equal(undeclared.identity.runChecks.declared, false);
    assert.notEqual(declared.config.configDigest, undeclared.configDigest);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects held-out resources inside a hashed worker fixture before Pi starts', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-hidden-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root, { heldOutInsideFixture: true });
    const runtime = await makeRuntime(root);
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      verifier: async () => ({ status: 'passed' }),
    });
    const caseResult = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(caseResult.outcome, 'setup_error');
    await assert.rejects(access(join(root, 'pi-spawned')));
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('binds effective model settings and checker limits into the config digest', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-identity-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const verifier = async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } });
    const supplemental = { note: 'operator metadata', sandbox: undefined };
    await assert.rejects(
      runBenchmark({ suiteRoot: root, outputRoot: join(root, 'invalid-settings'), worker, runtime, repeat: 1, workerSettings: false, verifier }),
      { code: 'BENCHMARK_RUNNER_INVALID', message: /workerSettings must be an object/u },
    );
    const first = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'first'), worker, runtime, repeat: 1, checkRunnerOptions: { limits: { storedOutputBytes: 12345 } }, workerSettings: supplemental, verifier });
    assert.equal(first.config.identity.worker.settings.note, 'operator metadata');
    assert.equal(first.config.identity.worker.settings.sandbox, 'test-runtime');
    assert.equal(first.config.identity.worker.settings.endpointFingerprint, 'http://127.0.0.1:9/v1');
    assert.equal(first.config.identity.worker.settings.effectiveMaxTokens, 256);
    const second = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'second'), worker, runtime, repeat: 1, checkRunnerOptions: { limits: { storedOutputBytes: 12346 } }, workerSettings: supplemental, verifier });
    assert.notEqual(first.invocation.configDigest, second.invocation.configDigest);
    await writeJson(join(root, 'agent', 'models.json'), {
      providers: {
        fake: {
          api: 'openai-completions',
          baseUrl: '$FAKE_BASE',
          apiKey: '$FAKE_TOKEN',
          models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 128, input: ['text'], reasoning: false }],
        },
      },
    });
    const third = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'third'), worker, runtime, repeat: 1, checkRunnerOptions: { limits: { storedOutputBytes: 12346 } }, workerSettings: supplemental, verifier });
    assert.notEqual(second.invocation.configDigest, third.invocation.configDigest);
    assert.equal(third.config.identity.worker.settings.effectiveMaxTokens, 128);
    await writeFile(join(root, 'verifier', 'slow-slice-visible.test.mjs'), 'changed verifier bytes\n');
    const fourth = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'fourth'), worker, runtime, repeat: 1, checkRunnerOptions: { limits: { storedOutputBytes: 12346 } }, workerSettings: supplemental, verifier });
    assert.notEqual(third.invocation.configDigest, fourth.invocation.configDigest);
    await writeJson(join(root, 'agent', 'models.json'), {
      providers: {
        fake: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:10/v1',
          apiKey: '$FAKE_TOKEN',
          models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 128, input: ['text'], reasoning: false }],
        },
      },
    });
    const fifth = await runBenchmark({ suiteRoot: root, outputRoot: join(root, 'fifth'), worker, runtime, repeat: 1, checkRunnerOptions: { limits: { storedOutputBytes: 12346 } }, workerSettings: supplemental, verifier });
    assert.equal(fifth.config.identity.worker.settings.endpointFingerprint, 'http://127.0.0.1:10/v1');
    assert.notEqual(fourth.invocation.configDigest, fifth.invocation.configDigest);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a supplied Pi version that conflicts with the installed runtime', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-pi-version-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    await writeJson(join(root, 'package.json'), { name: 'synthetic-pi', version: '0.84.4' });
    await assert.rejects(
      runBenchmark({
        suiteRoot: root,
        outputRoot: join(root, 'results'),
        worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
        runtime,
        repeat: 1,
        piVersion: '0.84.3',
        verifier: async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } }),
      }),
      { code: 'BENCHMARK_RUNNER_INVALID', message: /installed Pi runtime version/u },
    );
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('uses a worker profile object for preflight, identity, and execution', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-profile-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const profile = { schemaVersion: 1, id: 'reasoning-profile', runtime: { reasoning: true } };
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', profile, limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker,
      runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } }),
    });
    assert.equal(result.config.identity.worker.profileDigest, digestJson(profile));
    assert.equal(result.config.identity.worker.settings.effectiveReasoning, true);
    const firstCase = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(firstCase.outcome, 'completed');
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves a worker profile path from the suite and refuses symlinked profiles', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-profile-path-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const profile = { schemaVersion: 1, id: 'path-profile', runtime: { reasoning: true } };
    await writeFile(join(root, 'worker-profile.json'), `${JSON.stringify(profile)}\n`);
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', profile: 'worker-profile.json', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker,
      runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } }),
    });
    assert.equal(result.config.identity.worker.profileDigest, digestJson(profile));
    assert.equal(result.config.identity.worker.settings.effectiveReasoning, true);
    await symlink(join(root, 'worker-profile.json'), join(root, 'linked-profile.json'));
    await assert.rejects(
      runBenchmark({ suiteRoot: root, worker: { ...worker, profile: 'linked-profile.json' }, runtime, verifier: async () => ({ status: 'passed' }) }),
      { code: 'BENCHMARK_RUNNER_INVALID', message: /symlink/u },
    );
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsafe invocation ids before starting workers or writing output', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-invocation-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  const invocationId = `../../../../escaped-${basename(root)}`;
  const escaped = resolve(root, '.tinysdd', 'bench', 'runner-fixture', invocationId);
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    await assert.rejects(
      runBenchmark({
        suiteRoot: root,
        worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
        runtime,
        invocationId,
        verifier: async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } }),
      }),
      { code: 'BENCHMARK_RUNNER_INVALID', message: /invocationId/u },
    );
    await assert.rejects(access(join(root, 'pi-spawned')));
    await assert.rejects(access(escaped));
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
    await rm(escaped, { recursive: true, force: true });
  }
});

test('stages and rewrites verifier path-flag operands before evaluation', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-verifier-flag-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root, { pathFlagVerifier: true });
    const runtime = await makeRuntime(root);
    const checks = [];
    const rewrittenPreloads = [];
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      repeat: 1,
      verifier: async ({ visibility, check, candidateDir }) => {
        checks.push({ visibility, argv: check.argv });
        const requireIndex = check.argv.indexOf('--require');
        const inlineRequire = check.argv.find((argument) => argument.startsWith('--require='));
        if (requireIndex !== -1 || inlineRequire !== undefined) {
          const preload = requireIndex !== -1 ? check.argv[requireIndex + 1] : inlineRequire.slice('--require='.length);
          assert.match(preload, new RegExp(`^\\./${RESERVED_VERIFIER_ROOT}/visible/[a-z-]+-preload\\.cjs$`, 'u'));
          await access(join(candidateDir, preload.slice(2)));
          await execFileAsync(process.execPath, check.argv.slice(1), { cwd: candidateDir });
          rewrittenPreloads.push(preload);
        }
        return { status: 'passed', sandbox: { runner: 'test-only', network: 'none' } };
      },
    });
    assert.ok(checks.length >= 1);
    assert.equal(rewrittenPreloads.length, 1);
    const firstCase = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(firstCase.verifier.visible[0].status, 'passed');
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('executes inline verifier path-flag operands after rewriting', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-verifier-inline-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root, { pathFlagVerifier: 'inline' });
    const runtime = await makeRuntime(root);
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      repeat: 1,
      verifier: async ({ check, candidateDir }) => {
        const inlineRequire = check.argv.find((argument) => argument.startsWith('--require='));
        if (inlineRequire === undefined) return { status: 'passed', sandbox: { runner: 'test-only', network: 'none' } };
        assert.match(inlineRequire, new RegExp(`^--require=\\./${RESERVED_VERIFIER_ROOT}/visible/[a-z-]+-preload\\.cjs$`, 'u'));
        await execFileAsync(process.execPath, check.argv.slice(1), { cwd: candidateDir });
        return { status: 'passed', sandbox: { runner: 'test-only', network: 'none' } };
      },
    });
    const firstCase = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(firstCase.verifier.visible[0].status, 'passed');
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses verifier mutation between visible and held-out evaluation', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-group-mutation-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const heldOutPath = join(root, 'verifier', 'slow-slice-held-out.test.mjs');
    let visibleCalls = 0;
    let heldOutCalls = 0;
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      repeat: 1,
      verifier: async ({ visibility }) => {
        if (visibility === 'visible') {
          visibleCalls += 1;
          await writeFile(heldOutPath, 'mutated after visible evaluation\n');
        } else {
          heldOutCalls += 1;
        }
        return { status: 'passed', sandbox: { runner: 'test-only', network: 'none' } };
      },
    });
    const firstCase = JSON.parse(await readFile(join(root, 'results', result.invocation.caseResults[0].path), 'utf8'));
    assert.equal(firstCase.outcome, 'setup_error');
    assert.equal(visibleCalls, 1);
    assert.equal(heldOutCalls, 0);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('retains setup results when verifier content mutates during an attempt', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-mutation-')));
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    runtime.testEnv.TINYSDD_TEST_MUTATE_VERIFIER = join(root, 'verifier', 'slow-slice-visible.test.mjs');
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: join(root, 'results'),
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
      runtime,
      repeat: 2,
      verifier: async () => ({ status: 'passed', sandbox: { runner: 'test-only', network: 'none' } }),
    });
    const cases = await Promise.all(result.invocation.caseResults.map(async ({ path }) => JSON.parse(await readFile(join(root, 'results', path), 'utf8'))));
    assert.ok(cases.every((entry) => entry.outcome === 'setup_error'));
    assert.ok(cases.every((entry) => entry.verifier.visible.length === 0 && entry.verifier.heldOut.length === 0));
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects verifier injection outside the explicit test runtime', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-injection-')));
  try {
    await makeSuite(root);
    await assert.rejects(
      runBenchmark({ suiteRoot: root, worker: { type: 'pi', provider: 'fake', model: 'fake/model' }, runtime: {}, verifier: () => ({ status: 'passed' }) }),
      { code: 'BENCHMARK_RUNNER_INVALID', message: /test verifier injection/u },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
