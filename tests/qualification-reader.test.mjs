import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BENCHMARK_UNKNOWN, buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import { readQualificationEvidence } from '../src/qualification-reader.mjs';
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
  return { root, suitePath: 'bench/suite.json', invocationPath: '.tinysdd/bench/reader-suite/invocation-a' };
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
