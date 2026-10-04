import test from 'node:test';
import assert from 'node:assert/strict';

import { BENCHMARK_UNKNOWN, buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import { validateBenchmarkCaseResult } from '../src/benchmark-results.mjs';
import {
  DEFAULT_QUALIFICATION_TARGET,
  QUALIFICATION_CONFIDENCE,
  QUALIFICATION_Z,
  aggregateBenchmarkCases,
  aggregateBenchmarkObservations,
  buildQualificationRecord,
  isSuccessfulBenchmarkCase,
  mergeQualificationRecords,
  parseQualificationRecord,
  rescoreQualificationRecord,
  scoreRoleCounts,
  validateQualificationRecord,
  wilsonInterval,
} from '../src/qualification.mjs';

const digest = (letter) => letter.repeat(64);

function config() {
  return buildBenchmarkConfigIdentity({
    model: { provider: 'local-provider', id: 'small-model', quantization: 'Q4_K_M', server: { id: 'server-a', version: '1.2.3' } },
    worker: { profileDigest: digest('a'), limits: { timeoutMs: 300000, maxToolCalls: 40, firstWriteMs: 120000 }, settings: { sandbox: 'bubblewrap' } },
    pi: { version: '1.0.0' },
    tinySdd: { version: '0.1.0', codeRevision: digest('b') },
    suite: { id: 'contract-fixture', version: '1', contentSha256: digest('c') },
    verifier: { configSha256: digest('d'), checkRunner: { version: 'runner-1', configSha256: digest('e') } },
    runChecks: { declared: true, available: true, budget: 12, unavailableReason: BENCHMARK_UNKNOWN, provenance: { source: 'runtime.json', unavailableReason: BENCHMARK_UNKNOWN } },
    environment: { runtime: 'node', runtimeVersion: '22.19.0', platform: 'linux', arch: 'x64' },
  });
}

function source() {
  return {
    invocations: [{ path: '.tinysdd/bench/invocation.json', sha256: digest('1') }],
    cases: [{ path: '.tinysdd/bench/cases/attempt-1/case-result.json', sha256: digest('2') }],
  };
}

function roleInput({ n = 10, passes = 9, target = DEFAULT_QUALIFICATION_TARGET } = {}) {
  const results = Array.from({ length: n }, (_, index) => ({
    attemptId: `attempt-${index + 1}`,
    repetition: index + 1,
    passed: index < passes,
  }));
  return {
    n,
    passes,
    target,
    perChallenge: [{ id: 'challenge-a', version: '1', sha256: digest('3'), n, passes, results }],
  };
}

function recordInput(overrides = {}) {
  const identity = config();
  return {
    configIdentity: identity.identity,
    configDigest: identity.configDigest,
    suite: { id: 'contract-fixture', version: '1', sha256: digest('c') },
    source: source(),
    roles: { 'implement-slice': roleInput(), ...overrides },
  };
}

function verifier(checkId, status = 'passed') {
  return {
    checkId,
    definitionSha256: digest(checkId === 'visible' ? '1' : '2'),
    status,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : BENCHMARK_UNKNOWN,
    signal: null,
    timedOut: status === 'passed' || status === 'failed' ? false : BENCHMARK_UNKNOWN,
    durationMs: status === 'unavailable' || status === 'not_run' ? BENCHMARK_UNKNOWN : 4,
    output: { ref: status === 'not_run' ? BENCHMARK_UNKNOWN : `artifacts/${checkId}.txt`, sha256: status === 'not_run' ? BENCHMARK_UNKNOWN : digest('3'), truncated: status === 'not_run' ? BENCHMARK_UNKNOWN : false },
    sandbox: status === 'unavailable' || status === 'not_run' ? BENCHMARK_UNKNOWN : { network: 'none', runner: 'bwrap' },
  };
}

function caseResult({ attemptId = 'attempt-1', repetition = 1, outcome = 'completed', status = 'passed', requiredPatchAbsent = false } = {}) {
  const identity = config();
  return {
    schemaVersion: 1,
    suite: { id: 'contract-fixture', version: '1', sha256: digest('c') },
    challenge: { id: 'challenge-a', version: '1', sha256: digest('4') },
    role: 'implement-slice',
    difficultyTags: ['brownfield'],
    repetition,
    attemptId,
    workerRunId: `run-${attemptId}`,
    configDigest: identity.configDigest,
    configIdentity: identity.identity,
    provenance: {
      type: 'benchmark-invocation',
      source: 'benchmark operator invocation',
      suiteSha256: digest('c'),
      packetSha256: digest('5'),
      profileSha256: digest('a'),
      workerResultSha256: digest('a'),
    },
    packet: {
      briefSha256: digest('6'),
      contextSha256: digest('7'),
      checksSha256: digest('8'),
      profileSha256: digest('a'),
      fixtureSha256: digest('9'),
    },
    taskShape: { allowedFiles: 1 },
    outcome,
    observed: { processTermination: { exitCode: status === 'passed' ? 0 : 1 } },
    limitDetails: { timeoutMs: 300000, maxToolCalls: 40 },
    changedPaths: [{ path: 'src/index.mjs', change: 'modified' }],
    scopeViolations: [],
    artifacts: { result: { path: 'artifacts/result.json', sha256: digest('a') }, packet: { path: 'artifacts/packet.json', sha256: digest('5') }, patch: { path: 'artifacts/patch.diff', sha256: digest('b') } },
    verifier: { visible: [verifier('visible', status)], heldOut: [verifier('held-out', status)] },
    hardGates: { outOfScopeEdit: false, protectedFileEdit: false, protectedTestEdit: false, requiredPatchAbsent },
    failure: { category: BENCHMARK_UNKNOWN, missing: [] },
  };
}

test('uses the approved two-sided 95% Wilson interval', () => {
  const interval = wilsonInterval(10, 9);
  assert.equal(QUALIFICATION_CONFIDENCE, 0.95);
  assert.equal(QUALIFICATION_Z, 1.959963984540054);
  assert.ok(Math.abs(interval.lowerBound - 0.5958499732) < 1e-10);
  assert.ok(Math.abs(interval.upperBound - 0.9821237869) < 1e-10);
});

test('classifies equality at the lower bound as qualified and equality at the upper bound as insufficient', () => {
  const interval = wilsonInterval(10, 9);
  assert.equal(scoreRoleCounts({ n: 10, passes: 9, target: interval.lowerBound }).status, 'qualified');
  assert.equal(scoreRoleCounts({ n: 10, passes: 9, target: interval.upperBound }).status, 'insufficient_evidence');
  assert.equal(scoreRoleCounts({ n: 10, passes: 9, target: interval.upperBound + Number.EPSILON }).status, 'not_qualified');
});

test('records the default target and exact best-case counts for 9/10', () => {
  const score = scoreRoleCounts({ n: 10, passes: 9 });
  assert.equal(score.target, 0.8);
  assert.equal(score.status, 'insufficient_evidence');
  assert.equal(score.passesToQualify, 15);
  assert.equal(score.failuresToRuleOut, 6);
  assert.equal(score.passesToQualifyReason, null);
  assert.equal(score.failuresToRuleOutReason, null);
});

test('handles all-pass, all-fail, no observations, invalid inputs, and large counts', () => {
  assert.equal(scoreRoleCounts({ n: 10, passes: 10 }).status, 'insufficient_evidence');
  assert.equal(scoreRoleCounts({ n: 10, passes: 0 }).status, 'not_qualified');
  assert.equal(wilsonInterval(3, 0).lowerBound, 0);
  assert.equal(wilsonInterval(10, 10).upperBound, 1);
  assert.equal(scoreRoleCounts({ n: 3, passes: 0, target: Number.MIN_VALUE }).status, 'insufficient_evidence');
  assert.equal(scoreRoleCounts({ n: 10, passes: 10, target: 1 }).status, 'insufficient_evidence');
  assert.equal(scoreRoleCounts({ n: 0, passes: 0 }).status, 'insufficient_evidence');
  assert.equal(scoreRoleCounts({ n: 100, passes: 100 }).status, 'qualified');
  assert.throws(() => scoreRoleCounts({ n: 3, passes: 4 }), { code: 'QUALIFICATION_INVALID' });
  assert.throws(() => scoreRoleCounts({ n: 1, passes: 0, target: 1.1 }), { code: 'QUALIFICATION_INVALID' });
  assert.throws(() => scoreRoleCounts({ n: Number.MAX_SAFE_INTEGER + 1, passes: 0 }), { code: 'QUALIFICATION_INVALID' });
  const huge = scoreRoleCounts({ n: Number.MAX_SAFE_INTEGER, passes: Number.MAX_SAFE_INTEGER, target: 1 });
  assert.equal(huge.passesToQualify, null);
  assert.equal(huge.passesToQualifyReason, 'no_finite_solution');
});

test('allows an explicit empty role record when no observations were retained', () => {
  const empty = roleInput({ n: 0, passes: 0 });
  const record = buildQualificationRecord({
    ...recordInput(),
    roles: { 'implement-slice': empty },
  });
  assert.equal(record.roles['implement-slice'].n, 0);
  assert.equal(record.roles['implement-slice'].status, 'insufficient_evidence');
});

test('requires retained per-challenge results to agree with counts', () => {
  const record = buildQualificationRecord(recordInput());
  assert.equal(record.roles['implement-slice'].perChallenge[0].results.length, 10);
  assert.equal(record.roles['implement-slice'].n, 10);
  assert.throws(() => buildQualificationRecord(recordInput({ 'implement-slice': { ...roleInput(), passes: 8 } })), { code: 'QUALIFICATION_INVALID' });
});

test('rescores retained counts with a per-role target without rerunning cases', () => {
  const record = buildQualificationRecord(recordInput());
  const rescored = rescoreQualificationRecord(record, { 'implement-slice': 0.9 });
  assert.equal(rescored.roles['implement-slice'].target, 0.9);
  assert.equal(rescored.roles['implement-slice'].n, record.roles['implement-slice'].n);
  assert.equal(rescored.roles['implement-slice'].passes, record.roles['implement-slice'].passes);
  assert.deepEqual(rescored.roles['implement-slice'].perChallenge, record.roles['implement-slice'].perChallenge);
  assert.equal(rescored.configDigest, record.configDigest);
});

test('validates tamper-resistant status, bounds, counters, identity, and raw-schema separation', () => {
  const record = buildQualificationRecord(recordInput());
  assert.deepEqual(validateQualificationRecord(record), record);
  assert.deepEqual(parseQualificationRecord(`${JSON.stringify(record)}\n`), record);
  for (const mutate of [
    (value) => { value.roles['implement-slice'].status = 'qualified'; },
    (value) => { value.roles['implement-slice'].lowerBound = 0; },
    (value) => { value.roles['implement-slice'].passesToQualify = 1; },
    (value) => { value.roles['implement-slice'].perChallenge[0].results[0].passed = false; },
    (value) => { value.configDigest = digest('f'); },
    (value) => { value.configIdentity.model.id = 'different-model'; },
    (value) => { value.source.cases[0].path = '../escape.json'; },
    (value) => { value.unknown = true; },
  ]) {
    const tampered = structuredClone(record);
    mutate(tampered);
    assert.throws(() => validateQualificationRecord(tampered), { code: 'QUALIFICATION_INVALID' });
  }

  const raw = caseResult();
  assert.equal(isSuccessfulBenchmarkCase(raw), true);
  raw.hardGates.requiredPatchAbsent = BENCHMARK_UNKNOWN;
  assert.equal(isSuccessfulBenchmarkCase(raw), false);
  assert.throws(() => validateBenchmarkCaseResult({ ...raw, qualified: false }), { code: 'BENCHMARK_RESULTS_INVALID' });
});

test('scores a timeout by retained checks and hard gates, independently of raw outcome', () => {
  const timeoutPass = caseResult({ attemptId: 'timeout-pass', outcome: 'timeout' });
  const failedCheck = caseResult({ attemptId: 'timeout-check-fail', outcome: 'timeout', status: 'failed' });
  const gated = caseResult({ attemptId: 'timeout-gate-fail', outcome: 'timeout', requiredPatchAbsent: true });
  assert.equal(isSuccessfulBenchmarkCase(timeoutPass), true);
  assert.equal(isSuccessfulBenchmarkCase(failedCheck), false);
  assert.equal(isSuccessfulBenchmarkCase(gated), false);
  const aggregate = aggregateBenchmarkCases([timeoutPass, failedCheck, gated]);
  assert.equal(aggregate.roles['implement-slice'].passes, 1);
});

test('binds caller-supplied cases to their full identity and suite', () => {
  const original = caseResult();
  const other = buildBenchmarkConfigIdentity({
    model: { provider: 'local-provider', id: 'other-model', quantization: 'Q4_K_M', server: { id: 'server-a', version: '1.2.3' } },
    worker: { profileDigest: digest('a'), limits: { timeoutMs: 300000, maxToolCalls: 40, firstWriteMs: 120000 }, settings: { sandbox: 'bubblewrap' } },
    pi: { version: '1.0.0' },
    tinySdd: { version: '0.1.0', codeRevision: digest('b') },
    suite: { id: 'contract-fixture', version: '1', contentSha256: digest('c') },
    verifier: { configSha256: digest('d'), checkRunner: { version: 'runner-1', configSha256: digest('e') } },
    runChecks: { declared: true, available: true, budget: 12, unavailableReason: BENCHMARK_UNKNOWN, provenance: { source: 'runtime.json', unavailableReason: BENCHMARK_UNKNOWN } },
    environment: { runtime: 'node', runtimeVersion: '22.19.0', platform: 'linux', arch: 'x64' },
  });
  assert.throws(() => buildQualificationRecord({
    cases: [original],
    configIdentity: other.identity,
    configDigest: other.configDigest,
    suite: original.suite,
  }), { code: 'QUALIFICATION_INVALID' });

  const record = buildQualificationRecord(recordInput());
  record.suite.id = 'other-suite';
  assert.throws(() => validateQualificationRecord(record), { code: 'QUALIFICATION_INVALID' });
});

test('rejects nonnumeric persisted bounds, including null and numeric strings', () => {
  const empty = roleInput({ n: 0, passes: 0 });
  const record = buildQualificationRecord({
    ...recordInput(),
    roles: { 'implement-slice': empty },
  });
  for (const value of [null, '0', Number.NaN, Number.POSITIVE_INFINITY]) {
    const tampered = structuredClone(record);
    tampered.roles['implement-slice'].lowerBound = value;
    assert.throws(() => validateQualificationRecord(tampered), { code: 'QUALIFICATION_INVALID' });
  }
});

test('aggregates raw cases without dropping unsuccessful or repeated challenge attempts', () => {
  const cases = [
    caseResult({ attemptId: 'attempt-1', repetition: 1 }),
    caseResult({ attemptId: 'attempt-2', repetition: 2, status: 'failed' }),
    caseResult({ attemptId: 'attempt-3', repetition: 3, outcome: 'timeout' }),
  ];
  const aggregate = aggregateBenchmarkCases(cases, { targets: { 'implement-slice': 0.8 } });
  const role = aggregate.roles['implement-slice'];
  assert.equal(role.n, 3);
  assert.equal(role.passes, 2);
  assert.equal(role.perChallenge[0].results.map((entry) => entry.repetition).join(','), '1,2,3');
  assert.deepEqual(role.perChallenge[0].results.map((entry) => entry.passed), [true, false, true]);
});

test('refuses mixed configuration identities and duplicate attempts', () => {
  const first = caseResult({ attemptId: 'attempt-1' });
  const duplicate = caseResult({ attemptId: 'attempt-1', repetition: 2 });
  assert.throws(() => aggregateBenchmarkCases([first, duplicate]), { code: 'QUALIFICATION_INVALID' });
  const mixed = caseResult({ attemptId: 'attempt-2' });
  mixed.configIdentity.model.id = 'another-model';
  mixed.configDigest = config().configDigest;
  assert.throws(() => aggregateBenchmarkCases([first, mixed]), { code: 'BENCHMARK_RESULTS_INVALID' });
});

test('pools repeated attempt IDs only when invocation provenance is distinct', () => {
  const first = caseResult({ attemptId: 'attempt-1', repetition: 1 });
  const second = caseResult({ attemptId: 'attempt-1', repetition: 1, status: 'failed' });
  const aggregate = aggregateBenchmarkObservations([
    { caseResult: first, invocationId: 'invocation-a', source: { path: '.tinysdd/bench/a/case.json', sha256: digest('1') } },
    { caseResult: second, invocationId: 'invocation-b', source: { path: '.tinysdd/bench/b/case.json', sha256: digest('2') } },
  ]);
  const role = aggregate.roles['implement-slice'];
  assert.equal(role.n, 2);
  assert.equal(role.passes, 1);
  assert.deepEqual(role.perChallenge[0].results.map(({ invocationId, attemptId }) => `${invocationId}/${attemptId}`), ['invocation-a/attempt-1', 'invocation-b/attempt-1']);
  assert.throws(() => aggregateBenchmarkObservations([
    { caseResult: first, invocationId: 'invocation-a', source: { path: '.tinysdd/bench/a/case.json', sha256: digest('1') } },
    { caseResult: second, invocationId: 'invocation-a', source: { path: '.tinysdd/bench/a/case-2.json', sha256: digest('2') } },
  ]), { code: 'QUALIFICATION_INVALID' });
});

test('merges cumulative records by invocation and attempt without dropping failures', () => {
  const first = caseResult({ attemptId: 'attempt-1' });
  const second = caseResult({ attemptId: 'attempt-1', status: 'failed' });
  const identity = config();
  const makeRecord = (value, invocationId, sourcePath, sourceDigest) => buildQualificationRecord({
    observations: [{ caseResult: value, invocationId, source: { path: sourcePath, sha256: sourceDigest } }],
    source: { invocations: [], cases: [{ path: sourcePath, sha256: sourceDigest }] },
    configIdentity: identity.identity,
    configDigest: identity.configDigest,
    suite: value.suite,
  });
  const merged = mergeQualificationRecords(
    makeRecord(first, 'invocation-a', '.tinysdd/bench/a/case.json', digest('1')),
    makeRecord(second, 'invocation-b', '.tinysdd/bench/b/case.json', digest('2')),
  );
  const score = merged.roles['implement-slice'];
  assert.equal(score.n, 2);
  assert.equal(score.passes, 1);
  assert.deepEqual(score.perChallenge[0].results.map(({ invocationId, attemptId }) => `${invocationId}/${attemptId}`), [
    'invocation-a/attempt-1',
    'invocation-b/attempt-1',
  ]);
  assert.throws(() => mergeQualificationRecords(
    merged,
    makeRecord(caseResult({ attemptId: 'attempt-1', status: 'failed' }), 'invocation-a', '.tinysdd/bench/a/other.json', digest('3')),
  ), { code: 'QUALIFICATION_INVALID' });
});
