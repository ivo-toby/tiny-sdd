import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { addTask, approveTask, configShow, dispatchWorker, initProject } from '../src/controller.mjs';
import { assessQualification, changedIdentityFields, resolveBenchmarkSuite } from '../src/qualification-dispatch.mjs';
import { benchmarkFixtureDigest, inspectBenchmarkIdentity, runBenchmark } from '../src/benchmark-runner.mjs';
import { readQualificationEvidencePool } from '../src/qualification-reader.mjs';
import { accumulateQualificationRecord, persistQualificationRecord } from '../src/qualification-store.mjs';
import { buildQualificationRecord } from '../src/qualification.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-qualification-dispatch-'));
  await mkdir(join(root, '.tinysdd'), { recursive: true });
  return root;
}

async function jsonFile(path, value, relativePath = path) {
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text);
  return { path: relativePath, sha256: sha256(text) };
}

async function dispatchFixture() {
  const root = await project();
  const bench = join(root, 'bench');
  await mkdir(join(bench, 'challenges'), { recursive: true });
  await mkdir(join(bench, 'fixtures', 'one', 'src'), { recursive: true });
  await mkdir(join(bench, 'packets', 'one'), { recursive: true });
  await mkdir(join(bench, 'verifier'), { recursive: true });
  await writeFile(join(bench, 'fixtures', 'one', 'src', 'index.mjs'), 'before\n');
  const brief = await writeFile(join(bench, 'packets', 'one', 'brief.md'), 'Implement one.\n').then(() => ({ path: 'packets/one/brief.md', sha256: sha256('Implement one.\n') }));
  const contextValue = { schemaVersion: 1, facts: [], resources: [] };
  const context = await jsonFile(join(bench, 'packets', 'one', 'context.json'), contextValue, 'packets/one/context.json');
  const packetChecks = await jsonFile(join(bench, 'packets', 'one', 'checks.json'), {
    schemaVersion: 1,
    dependencyMounts: [],
    checks: [{ id: 'task', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 1000 }],
  }, 'packets/one/checks.json');
  const visible = await jsonFile(join(bench, 'verifier', 'visible.json'), {
    schemaVersion: 1,
    dependencyMounts: [],
    checks: [{ id: 'visible', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 1000 }],
  }, 'verifier/visible.json');
  const heldOut = await jsonFile(join(bench, 'verifier', 'held-out.json'), {
    schemaVersion: 1,
    dependencyMounts: [],
    checks: [{ id: 'held-out', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 1000 }],
  }, 'verifier/held-out.json');
  const fixture = await benchmarkFixtureDigest(join(bench, 'fixtures', 'one'));
  const challenge = await jsonFile(join(bench, 'challenges', 'one.json'), {
    schemaVersion: 1,
    id: 'one',
    version: '1',
    role: 'implement-slice',
    difficultyTags: ['small'],
    fixture: { path: 'fixtures/one', sha256: fixture.sha256 },
    packet: {
      brief,
      context,
      checks: packetChecks,
      allowedPaths: ['src/index.mjs'],
      protectedPaths: [],
    },
    verifier: { visible, heldOut },
  }, 'challenges/one.json');
  await jsonFile(join(bench, 'suite.json'), {
    schemaVersion: 1,
    id: 'dispatch-suite',
    version: '1',
    challenges: [challenge],
    defaults: { repeat: 1 },
  });
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await jsonFile(join(agent, 'models.json'), {
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
  await writeFile(pi, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.cwd(), 'src', 'index.mjs'), 'changed\\n');\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }));\n`);
  await chmod(pi, 0o755);
  return {
    root,
    suitePath: 'bench/suite.json',
    worker: { type: 'pi', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } },
    runtime: {
      test: true,
      piExecutable: pi,
      sourceAgentDir: agent,
      sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
      checkRunner: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 1,
        output: { text: '', tail: '', truncated: false },
        sandbox: { runner: 'test-check-runner', network: 'none' },
      }),
    },
  };
}

async function storeBenchmarkEvidence(fixture, result, target = 0.1) {
  const evidence = await readQualificationEvidencePool({
    projectRoot: fixture.root,
    suitePath: fixture.suitePath,
    configDigest: result.config.configDigest,
  });
  const record = buildQualificationRecord({
    observations: evidence.observations,
    source: evidence.source,
    roster: evidence.roster,
    configIdentity: evidence.configIdentity,
    configDigest: evidence.configDigest,
    suite: evidence.suite,
    targets: { 'implement-slice': target },
  });
  return accumulateQualificationRecord(fixture.root, record, {
    workerName: 'worker-a',
    targets: { 'implement-slice': target },
  });
}

test('qualification off does not inspect suite or qualification storage', async () => {
  const root = await project();
  try {
    const decision = await assessQualification({
      projectRoot: root,
      resolved: { config: { qualification: { mode: 'off' } }, workerName: 'w', worker: { type: 'pi' } },
    });
    assert.deepEqual(decision, {
      mode: 'off',
      status: 'skipped',
      reason: 'qualification_disabled',
      recordDigest: null,
      path: null,
      changedFields: [],
      warnings: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('warn and enforce expose a missing current suite without inventing a digest', async () => {
  const root = await project();
  const resolved = {
    config: { qualification: { mode: 'warn' } },
    workerName: 'w',
    worker: { type: 'pi', provider: 'p', model: 'm', limits: { maxCheckRuns: 12 } },
  };
  try {
    const warning = await assessQualification({ projectRoot: root, resolved });
    assert.equal(warning.status, 'unqualified');
    assert.equal(warning.reason, 'current_suite_unavailable');
    assert.equal(warning.recordDigest, null);
    assert.equal(warning.path, null);
    assert.match(warning.warnings[0], /current_suite_unavailable/u);
    await assert.rejects(
      assessQualification({ projectRoot: root, resolved: { ...resolved, config: { qualification: { mode: 'enforce' } } } }),
      (error) => error.code === 'MODEL_NOT_QUALIFIED' && error.details.qualification.recordDigest === null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('current suite resolution accepts a directory and rejects paths outside the project', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'bench'), { recursive: true });
    const suite = await resolveBenchmarkSuite(root, 'bench');
    assert.equal(suite.suitePath, 'bench/suite.json');
    await assert.rejects(resolveBenchmarkSuite(root, '../bench'), { code: 'QUALIFICATION_UNAVAILABLE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('identity changes are reported as stable field names', () => {
  assert.deepEqual(
    changedIdentityFields({ model: { id: 'old' }, runChecks: { declared: true } }, { model: { id: 'new' }, runChecks: { declared: false } }),
    ['model.id', 'runChecks.declared'],
  );
});

test('dispatch qualification refreshes every retained invocation and refuses a later failure', async () => {
  const fixture = await dispatchFixture();
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  const resolved = {
    config: { qualification: { mode: 'enforce', suite: 'bench' } },
    workerName: 'worker-a',
    worker: fixture.worker,
  };
  try {
    const first = await runBenchmark({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: fixture.worker,
      workerName: 'worker-a',
      runtime: fixture.runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed' }),
    });
    await storeBenchmarkEvidence(fixture, first);
    const qualified = await assessQualification({
      projectRoot: fixture.root,
      resolved,
      runtime: fixture.runtime,
      checksDeclared: true,
      verifierMode: 'test-injection',
    });
    assert.equal(qualified.status, 'qualified');
    assert.equal(qualified.refreshed, true);
    const second = await runBenchmark({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: fixture.worker,
      workerName: 'worker-a',
      runtime: fixture.runtime,
      repeat: 1,
      verifier: async () => ({ status: 'failed', exitCode: 1 }),
    });
    assert.equal(second.config.configDigest, first.config.configDigest);
    const qualifiedOffline = await exec(process.execPath, [
      cli,
      '--json',
      '--project', fixture.root,
      'bench',
      'qualify',
      '--results', relative(fixture.root, first.directory),
      '--suite', 'bench',
      '--target', 'implement-slice=0.1',
    ], { env: { ...process.env, TYPESAFE_API_KEY: 'stub' } });
    const offlineData = JSON.parse(qualifiedOffline.stdout);
    assert.equal(offlineData.ok, true);
    assert.equal(offlineData.data.record.roles['implement-slice'].n, 2);
    assert.equal(offlineData.data.record.roles['implement-slice'].passes, 1);
    await assert.rejects(
      assessQualification({
        projectRoot: fixture.root,
        resolved,
        runtime: fixture.runtime,
        checksDeclared: true,
        verifierMode: 'test-injection',
      }),
      (error) => {
        assert.equal(error.code, 'MODEL_NOT_QUALIFIED');
        assert.equal(error.details.qualification.reason, 'insufficient_evidence');
        assert.equal(error.details.qualification.recordDigest, first.config.configDigest);
        return true;
      },
    );
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dispatch rechecks prepared runtime identity before launch', async () => {
  const fixture = await dispatchFixture();
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await initProject(fixture.root);
    await mkdir(join(fixture.root, 'src'), { recursive: true });
    await writeFile(join(fixture.root, 'src', 'index.mjs'), 'before\n');
    await addTask(fixture.root, { id: 'probe', brief: 'bench/packets/one/brief.md', allow: ['src/index.mjs'] });
    await approveTask(fixture.root, { id: 'probe', by: 'reviewer', reason: 'synthetic endpoint race' });
    await writeFile(join(fixture.root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'fake',
      workers: { fake: fixture.worker },
      qualification: { mode: 'enforce', suite: 'bench' },
    }));
    const resolved = await configShow(fixture.root);
    const current = await inspectBenchmarkIdentity({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: resolved.worker,
      profile: resolved.profile,
      runtime: fixture.runtime,
      runChecksDeclared: false,
      maxCheckRuns: resolved.worker.limits.maxCheckRuns,
    });
    const score = {
      n: 20,
      passes: 20,
      target: 0.8,
      perChallenge: [{
        id: 'one',
        version: '1',
        sha256: 'a'.repeat(64),
        n: 20,
        passes: 20,
        results: Array.from({ length: 20 }, (_, index) => ({ attemptId: `attempt-${index}`, repetition: 1, passed: true })),
      }],
    };
    await persistQualificationRecord(fixture.root, buildQualificationRecord({
      configIdentity: current.identity,
      configDigest: current.configDigest,
      suite: current.suite,
      roles: { 'implement-slice': score },
    }), { workerName: 'fake' });

    const modelPath = join(fixture.root, 'agent', 'models.json');
    const changedModels = JSON.parse(await readFile(modelPath, 'utf8'));
    changedModels.providers.fake.baseUrl = 'http://127.0.0.1:10/changed-path';
    let changed = false;
    const raceEnv = { ...fixture.runtime.sourceEnv };
    Object.defineProperty(raceEnv, 'FAKE_BASE', {
      enumerable: true,
      get() {
        if (!changed) {
          changed = true;
          writeFileSync(modelPath, JSON.stringify(changedModels));
        }
        return 'http://127.0.0.1:9/v1';
      },
    });
    await assert.rejects(
      dispatchWorker(fixture.root, { taskId: 'probe', worker: 'fake', runtime: { ...fixture.runtime, sourceEnv: raceEnv } }),
      (error) => {
        assert.equal(error.code, 'MODEL_NOT_QUALIFIED');
        assert.equal(error.details.qualification.reason, 'qualification_invalidated_by_config');
        assert.ok(error.details.qualification.changedFields.includes('worker.settings.endpointFingerprint'));
        return true;
      },
    );
    assert.equal(await readFile(join(fixture.root, 'src', 'index.mjs'), 'utf8'), 'before\n');

    await writeFile(join(fixture.root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'fake',
      workers: { fake: fixture.worker },
      qualification: { mode: 'warn', suite: 'bench' },
    }));
    await writeFile(modelPath, JSON.stringify({
      providers: {
        fake: {
          api: 'openai-completions',
          baseUrl: '$FAKE_BASE',
          apiKey: '$FAKE_TOKEN',
          models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false }],
        },
      },
    }));
    changed = false;
    const warned = await dispatchWorker(fixture.root, { taskId: 'probe', worker: 'fake', runtime: { ...fixture.runtime, sourceEnv: raceEnv } });
    assert.equal(warned.outcome, 'completed');
    assert.equal(warned.qualification.status, 'unqualified');
    assert.equal(warned.qualification.reason, 'qualification_invalidated_by_config');
    assert.ok(warned.qualification.changedFields.includes('worker.settings.endpointFingerprint'));
    assert.match(warned.qualification.warnings[0], /qualification invalidated by config change/u);
    const runtime = JSON.parse(await readFile(warned.artifactPaths.runtime, 'utf8'));
    assert.deepEqual(runtime.qualification, warned.qualification);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dispatch reports an older matching-worker record as invalidated with changed fields', async () => {
  const fixture = await dispatchFixture();
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    const first = await runBenchmark({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: fixture.worker,
      workerName: 'worker-a',
      runtime: fixture.runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed' }),
    });
    await storeBenchmarkEvidence(fixture, first);
    const changedWorker = { ...fixture.worker, model: 'fake/changed-model' };
    await jsonFile(join(fixture.root, 'agent', 'models.json'), {
      providers: {
        fake: {
          api: 'openai-completions',
          baseUrl: '$FAKE_BASE',
          apiKey: '$FAKE_TOKEN',
          models: [
            { id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false },
            { id: 'fake/changed-model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false },
          ],
        },
      },
    });
    const decision = await assessQualification({
      projectRoot: fixture.root,
      resolved: {
        config: { qualification: { mode: 'warn', suite: 'bench' } },
        workerName: 'worker-a',
        worker: changedWorker,
      },
      runtime: fixture.runtime,
      checksDeclared: true,
      verifierMode: 'test-injection',
    });
    assert.equal(decision.status, 'unqualified');
    assert.equal(decision.reason, 'qualification_invalidated_by_config');
    assert.ok(decision.changedFields.includes('model.id'));
    assert.equal(decision.invalidated.length, 1);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dispatch refuses to preserve an old observation when its retained source disappears', async () => {
  const fixture = await dispatchFixture();
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  const resolved = {
    config: { qualification: { mode: 'warn', suite: 'bench' } },
    workerName: 'worker-a',
    worker: fixture.worker,
  };
  try {
    const first = await runBenchmark({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: fixture.worker,
      workerName: 'worker-a',
      runtime: fixture.runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed' }),
    });
    await storeBenchmarkEvidence(fixture, first);
    const indexPath = join(fixture.root, '.tinysdd', 'qualifications', 'evidence.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.entries = index.entries.filter((entry) => entry.invocationId !== first.invocation.invocationId);
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    await rm(first.directory, { recursive: true, force: true });
    await runBenchmark({
      projectRoot: fixture.root,
      suiteRoot: join(fixture.root, 'bench'),
      worker: fixture.worker,
      workerName: 'worker-a',
      runtime: fixture.runtime,
      repeat: 1,
      verifier: async () => ({ status: 'passed' }),
    });
    const decision = await assessQualification({
      projectRoot: fixture.root,
      resolved,
      runtime: fixture.runtime,
      checksDeclared: true,
      verifierMode: 'test-injection',
    });
    assert.equal(decision.status, 'unqualified');
    assert.equal(decision.reason, 'current_evidence_unavailable');
    assert.match(decision.warnings[0], /current qualification evidence unavailable/u);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
