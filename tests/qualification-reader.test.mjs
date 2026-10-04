import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BENCHMARK_UNKNOWN, benchmarkConfigDigest, buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import { readQualificationEvidence } from '../src/qualification-reader.mjs';
import { readQualificationEvidencePool } from '../src/qualification-reader.mjs';
import { readQualificationEvidenceIndex, registerQualificationInvocation } from '../src/qualification-store.mjs';
import { sha256 } from '../src/fs-utils.mjs';
import { buildQualificationRecord, validateQualificationRecord } from '../src/qualification.mjs';

const digest = (letter) => letter.repeat(64);

async function writeJson(path, value, referencePath = path) {
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text);
  return { path: referencePath, sha256: sha256(text) };
}

function identity(suiteSha256) {
  return buildBenchmarkConfigIdentity({
    model: { provider: 'fake', id: 'fake/model', quantization: 'Q4', server: { id: 'server', version: '1' } },
    worker: { profileDigest: digest('a'), limits: { timeoutMs: 1000, maxToolCalls: 10, firstWriteMs: null }, settings: { sandbox: 'test-runtime' } },
    pi: { version: 'test' },
    tinySdd: { version: '0.1.0', codeRevision: digest('b') },
    suite: { id: 'reader-suite', version: '1', contentSha256: suiteSha256 },
    verifier: { configSha256: digest('c'), checkRunner: { version: 'runCheck-v1', configSha256: digest('d') } },
    runChecks: { declared: true, available: true, budget: 12, unavailableReason: BENCHMARK_UNKNOWN, provenance: { source: 'test', unavailableReason: BENCHMARK_UNKNOWN } },
    environment: { runtime: 'node', runtimeVersion: 'test', platform: 'test', arch: 'test' },
  });
}

function verifier(checkId, definitionSha256) {
  return {
    checkId,
    definitionSha256,
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    output: { ref: `artifacts/${checkId}.txt`, sha256: digest('e'), truncated: false },
    sandbox: { runner: 'test', network: 'none' },
  };
}

async function makeEvidenceRoot() {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-qualification-reader-'));
  const suiteRoot = join(root, 'bench');
  await mkdir(join(suiteRoot, 'challenges'), { recursive: true });
  await mkdir(join(suiteRoot, 'fixtures', 'challenge-a'), { recursive: true });
  await mkdir(join(suiteRoot, 'packets', 'challenge-a'), { recursive: true });
  await mkdir(join(suiteRoot, 'verifier'), { recursive: true });
  await writeFile(join(suiteRoot, 'packets', 'challenge-a', 'brief.md'), 'brief\n');
  await writeJson(join(suiteRoot, 'packets', 'challenge-a', 'context.json'), { schemaVersion: 1, facts: [], resources: [] });
  const packetChecks = await writeJson(join(suiteRoot, 'packets', 'challenge-a', 'checks.json'), {
    schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'task', argv: ['node', '-e', '0'], timeoutMs: 1000 }],
  });
  const visible = await writeJson(join(suiteRoot, 'verifier', 'visible.json'), {
    schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'visible', argv: ['node', '-e', '0'], timeoutMs: 1000 }],
  });
  const heldOut = await writeJson(join(suiteRoot, 'verifier', 'held-out.json'), {
    schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'held-out', argv: ['node', '-e', '0'], timeoutMs: 1000 }],
  });
  const challenge = {
    schemaVersion: 1,
    id: 'challenge-a',
    version: '1',
    role: 'write-tests',
    difficultyTags: ['small'],
    fixture: { path: 'fixtures/challenge-a', sha256: digest('f') },
    packet: {
      brief: { path: 'packets/challenge-a/brief.md', sha256: digest('1') },
      context: { path: 'packets/challenge-a/context.json', sha256: digest('2') },
      checks: { path: 'packets/challenge-a/checks.json', sha256: packetChecks.sha256 },
      allowedPaths: [],
      protectedPaths: [],
    },
    verifier: {
      visible: { path: 'verifier/visible.json', sha256: visible.sha256 },
      heldOut: { path: 'verifier/held-out.json', sha256: heldOut.sha256 },
    },
  };
  const challengeRef = await writeJson(join(suiteRoot, 'challenges', 'challenge-a.json'), challenge, 'challenges/challenge-a.json');
  const suite = await writeJson(join(suiteRoot, 'suite.json'), {
    schemaVersion: 1,
    id: 'reader-suite',
    version: '1',
    challenges: [{ path: 'challenges/challenge-a.json', sha256: challengeRef.sha256 }],
    defaults: { repeat: 1 },
  }, 'suite.json');
  const config = identity(suite.sha256);
  const caseResult = {
    schemaVersion: 1,
    suite: { id: 'reader-suite', version: '1', sha256: suite.sha256 },
    challenge: { id: 'challenge-a', version: '1', sha256: challengeRef.sha256 },
    role: 'write-tests',
    difficultyTags: ['small'],
    repetition: 1,
    attemptId: 'challenge-a-repeat-1',
    workerRunId: 'run-1',
    configDigest: config.configDigest,
    configIdentity: config.identity,
    provenance: { type: 'benchmark-invocation', source: 'test', suiteSha256: suite.sha256, packetSha256: digest('3'), profileSha256: digest('a'), workerResultSha256: digest('4') },
    packet: { briefSha256: digest('1'), contextSha256: digest('2'), checksSha256: packetChecks.sha256, profileSha256: digest('a'), fixtureSha256: digest('f') },
    taskShape: { allowedFiles: 0 },
    outcome: 'completed',
    observed: { runChecks: { available: true } },
    limitDetails: { timeoutMs: 1000 },
    changedPaths: [],
    scopeViolations: [],
    artifacts: {},
    verifier: { visible: [verifier('visible', visible.sha256)], heldOut: [verifier('held-out', heldOut.sha256)] },
    hardGates: { outOfScopeEdit: false, protectedFileEdit: false, protectedTestEdit: false, requiredPatchAbsent: false },
    failure: { category: BENCHMARK_UNKNOWN, missing: [] },
  };
  const outputRoot = join(root, '.tinysdd', 'bench', 'reader-suite', 'invocation-a');
  await mkdir(join(outputRoot, 'cases', 'challenge-a-repeat-1'), { recursive: true });
  const caseRef = await writeJson(join(outputRoot, 'cases', 'challenge-a-repeat-1', 'case-result.json'), caseResult, 'cases/challenge-a-repeat-1/case-result.json');
  const summary = {
    schemaVersion: 1,
    suite: { id: 'reader-suite', version: '1', sha256: suite.sha256 },
    configDigest: config.configDigest,
    groups: [{ role: 'write-tests', configDigest: config.configDigest, scheduled: 1, completed: 1, incomplete: 0, failed: 0, unavailable: 0, notRun: 0, caseResults: [{ path: caseRef.path, sha256: caseRef.sha256 }] }],
    artifacts: [],
  };
  const summaryRef = await writeJson(join(outputRoot, 'summary.json'), summary, 'summary.json');
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invocation-a',
    suite: { id: 'reader-suite', version: '1', sha256: suite.sha256 },
    configDigest: config.configDigest,
    configIdentity: config.identity,
    worker: { name: 'fake', profileSha256: digest('a') },
    repeat: 1,
    startedAt: '2026-10-04T00:00:00.000Z',
    completedAt: '2026-10-04T00:00:01.000Z',
    caseResults: [caseRef],
    summary: summaryRef,
  };
  await writeJson(join(outputRoot, 'invocation.json'), invocation);
  return { root, suitePath: 'bench/suite.json', invocationPath: '.tinysdd/bench/reader-suite/invocation-a', configDigest: config.configDigest };
}

async function cloneInvocation(fixture, id, { invocationId = id, failed = false, suiteVersion, alternateConfig = false } = {}) {
  const source = join(fixture.root, '.tinysdd', 'bench', 'reader-suite', 'invocation-a');
  const target = join(fixture.root, '.tinysdd', 'bench', 'reader-suite', id);
  await cp(source, target, { recursive: true });
  const casePath = join(target, 'cases', 'challenge-a-repeat-1', 'case-result.json');
  const caseValue = JSON.parse(await readFile(casePath, 'utf8'));
  const summaryPath = join(target, 'summary.json');
  const summaryValue = JSON.parse(await readFile(summaryPath, 'utf8'));
  if (failed) {
    caseValue.outcome = 'failed';
    caseValue.failure = { category: 'verifier_failed', missing: [] };
    caseValue.verifier.heldOut[0].status = 'failed';
    caseValue.verifier.heldOut[0].exitCode = 1;
    summaryValue.groups[0].completed = 0;
    summaryValue.groups[0].failed = 1;
  }
  const caseText = `${JSON.stringify(caseValue)}\n`;
  await writeFile(casePath, caseText);
  const caseSha256 = sha256(caseText);
  summaryValue.groups[0].caseResults[0].sha256 = caseSha256;
  const summaryText = `${JSON.stringify(summaryValue)}\n`;
  await writeFile(summaryPath, summaryText);
  const summarySha256 = sha256(summaryText);
  const invocationPath = join(target, 'invocation.json');
  const invocationValue = JSON.parse(await readFile(invocationPath, 'utf8'));
  invocationValue.invocationId = invocationId;
  invocationValue.caseResults[0].sha256 = caseSha256;
  invocationValue.summary.sha256 = summarySha256;
  if (suiteVersion !== undefined) {
    invocationValue.suite.version = suiteVersion;
    invocationValue.configIdentity.suite.version = suiteVersion;
    invocationValue.configDigest = benchmarkConfigDigest(invocationValue.configIdentity);
  }
  if (alternateConfig) {
    invocationValue.configIdentity.model.id = 'other/model';
    invocationValue.configDigest = benchmarkConfigDigest(invocationValue.configIdentity);
  }
  await writeFile(invocationPath, `${JSON.stringify(invocationValue)}\n`);
  return {
    directory: `.tinysdd/bench/reader-suite/${id}`,
    file: `.tinysdd/bench/reader-suite/${id}/invocation.json`,
    invocation: invocationValue,
  };
}

test('reads roster-bound evidence, preserves provenance, and deduplicates repeated invocation inputs', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    const evidence = await readQualificationEvidence({ projectRoot: fixture.root, suitePath: fixture.suitePath, results: [fixture.invocationPath, `${fixture.invocationPath}/invocation.json`] });
    assert.equal(evidence.observations.length, 1);
    assert.deepEqual(evidence.duplicateInputs, [`${fixture.invocationPath}/invocation.json`]);
    assert.equal(evidence.roster.invocations[0].expected[0].repetitions[0], 1);
    assert.equal(evidence.observations[0].source.path, '.tinysdd/bench/reader-suite/invocation-a/cases/challenge-a-repeat-1/case-result.json');
    const record = buildQualificationRecord({
      observations: evidence.observations,
      source: evidence.source,
      roster: evidence.roster,
      configIdentity: evidence.configIdentity,
      configDigest: evidence.configDigest,
      suite: evidence.suite,
    });
    assert.equal(record.roles['write-tests'].n, 1);
    assert.equal(record.roles['write-tests'].passes, 1);
    assert.equal(record.roles['write-tests'].perChallenge[0].results[0].invocationId, 'invocation-a');
    const tampered = structuredClone(record);
    tampered.roles['write-tests'].perChallenge[0].results = [];
    tampered.roles['write-tests'].perChallenge[0].n = 0;
    tampered.roles['write-tests'].perChallenge[0].passes = 0;
    tampered.roles['write-tests'].n = 0;
    tampered.roles['write-tests'].passes = 0;
    tampered.source.cases = [];
    assert.throws(() => validateQualificationRecord(tampered), { code: 'QUALIFICATION_INVALID' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses a case with missing declared repetition', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    const invocationPath = join(fixture.root, '.tinysdd', 'bench', 'reader-suite', 'invocation-a', 'invocation.json');
    const value = JSON.parse(await readFile(invocationPath, 'utf8'));
    value.repeat = 2;
    await writeFile(invocationPath, `${JSON.stringify(value)}\n`);
    await assert.rejects(
      readQualificationEvidence({ projectRoot: fixture.root, suitePath: fixture.suitePath, results: [fixture.invocationPath] }),
      { code: 'QUALIFICATION_READ_INVALID' },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('discovers every retained invocation for an exact digest and records idempotent registrations', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    const invocationPath = `${fixture.invocationPath}/invocation.json`;
    const invocationText = await readFile(join(fixture.root, invocationPath), 'utf8');
    const invocation = JSON.parse(invocationText);
    const registration = await registerQualificationInvocation(fixture.root, {
      invocationPath,
      invocationSha256: sha256(invocationText),
      invocation,
      suitePath: fixture.suitePath,
      workerName: 'resolved-worker',
    });
    assert.equal(registration.entry.workerName, 'resolved-worker');
    const repeated = await registerQualificationInvocation(fixture.root, {
      invocationPath,
      invocationSha256: sha256(invocationText),
      invocation,
      suitePath: fixture.suitePath,
      workerName: 'resolved-worker',
    });
    assert.equal(repeated.index.entries.length, 1);
    assert.equal((await readQualificationEvidenceIndex(fixture.root)).entries.length, 1);
    await assert.rejects(
      registerQualificationInvocation(fixture.root, {
        invocationPath,
        invocationSha256: sha256(invocationText),
        invocation,
        suitePath: fixture.suitePath,
        workerName: 'different-worker',
      }),
      { code: 'QUALIFICATION_STORE_INVALID' },
    );
    const evidence = await readQualificationEvidencePool({
      projectRoot: fixture.root,
      suitePath: fixture.suitePath,
      configDigest: fixture.configDigest,
    });
    assert.equal(evidence.pool, true);
    assert.deepEqual(evidence.registeredInputs, [invocationPath]);
    assert.equal(evidence.observations.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('pools every retained invocation when explicit results contain only the passing night', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    await cloneInvocation(fixture, 'invocation-b', { failed: true });
    const evidence = await readQualificationEvidencePool({
      projectRoot: fixture.root,
      suitePath: fixture.suitePath,
      configDigest: fixture.configDigest,
      results: [fixture.invocationPath],
    });
    assert.equal(evidence.observations.length, 2);
    assert.equal(evidence.observations.filter(({ caseResult }) => caseResult.verifier.heldOut[0].status === 'passed').length, 1);
    assert.equal(evidence.observations.filter(({ caseResult }) => caseResult.verifier.heldOut[0].status === 'failed').length, 1);
    assert.equal(evidence.source.invocations.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('deduplicates duplicate invocation ids and ignores other config digests and suite versions before loading cases', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    await cloneInvocation(fixture, 'invocation-copy', { invocationId: 'invocation-a' });
    await cloneInvocation(fixture, 'ignored-suite', { suiteVersion: '2' });
    await cloneInvocation(fixture, 'ignored-config', { alternateConfig: true });
    const evidence = await readQualificationEvidencePool({
      projectRoot: fixture.root,
      suitePath: fixture.suitePath,
      configDigest: fixture.configDigest,
      results: [fixture.invocationPath],
    });
    assert.equal(evidence.observations.length, 1);
    assert.deepEqual(evidence.duplicateInputs, ['.tinysdd/bench/reader-suite/invocation-copy/invocation.json']);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses changed and missing registered invocation artifacts', async () => {
  const fixture = await makeEvidenceRoot();
  try {
    const invocationPath = `${fixture.invocationPath}/invocation.json`;
    const original = await readFile(join(fixture.root, invocationPath), 'utf8');
    const invocation = JSON.parse(original);
    await registerQualificationInvocation(fixture.root, {
      invocationPath,
      invocationSha256: sha256(original),
      invocation,
      suitePath: fixture.suitePath,
      workerName: 'resolved-worker',
    });
    invocation.worker.name = 'changed-worker';
    await writeFile(join(fixture.root, invocationPath), `${JSON.stringify(invocation)}\n`);
    await assert.rejects(
      readQualificationEvidencePool({ projectRoot: fixture.root, suitePath: fixture.suitePath, configDigest: fixture.configDigest }),
      { code: 'QUALIFICATION_READ_INVALID' },
    );
    await writeFile(join(fixture.root, invocationPath), original);
    await rm(join(fixture.root, invocationPath));
    await assert.rejects(
      readQualificationEvidencePool({ projectRoot: fixture.root, suitePath: fixture.suitePath, configDigest: fixture.configDigest }),
      { code: 'QUALIFICATION_READ_INVALID' },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
