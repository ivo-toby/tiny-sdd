import test from 'node:test';
import assert from 'node:assert/strict';

import { BENCHMARK_UNKNOWN, buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import {
  parseBenchmarkCaseResult,
  parseBenchmarkInvocation,
  parseBenchmarkSummary,
  validateBenchmarkCaseResult,
} from '../src/benchmark-results.mjs';

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

function caseResult() {
  const identity = config();
  return {
    schemaVersion: 1,
    suite: { id: 'contract-fixture', version: '1', sha256: digest('c') },
    challenge: { id: 'implement-slice', version: '1', sha256: digest('4') },
    role: 'implement-slice',
    difficultyTags: ['brownfield', 'small'],
    repetition: 1,
    attemptId: 'attempt-1',
    workerRunId: 'run-1',
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
    outcome: 'completed',
    observed: { processTermination: { exitCode: 0 } },
    limitDetails: { timeoutMs: 300000, maxToolCalls: 40 },
    changedPaths: [{ path: 'src/index.mjs', change: 'modified' }],
    scopeViolations: [],
    artifacts: { result: { path: 'artifacts/result.json', sha256: digest('a') }, patch: { path: 'artifacts/patch.diff', sha256: digest('b') } },
    verifier: { visible: [verifier('visible')], heldOut: [verifier('held-out')] },
    hardGates: { outOfScopeEdit: false, protectedFileEdit: false, protectedTestEdit: false, requiredPatchAbsent: false },
    failure: { category: BENCHMARK_UNKNOWN, missing: [] },
  };
}

test('validates a case result with worker observations, independent checks, and hard gates', () => {
  const result = validateBenchmarkCaseResult(caseResult());
  assert.equal(result.outcome, 'completed');
  assert.equal(result.verifier.heldOut[0].status, 'passed');
  assert.equal(result.hardGates.requiredPatchAbsent, false);
  assert.equal(result.configIdentity.runChecks.budget, 12);
});

test('retains unavailable and not-run verifier observations without turning them into failures', () => {
  const result = caseResult();
  result.verifier.visible = [verifier('visible', 'unavailable')];
  result.verifier.heldOut = [verifier('held-out', 'not_run')];
  result.outcome = 'unavailable';
  const normalized = validateBenchmarkCaseResult(result);
  assert.equal(normalized.verifier.visible[0].status, 'unavailable');
  assert.equal(normalized.verifier.heldOut[0].status, 'not_run');
  assert.equal(normalized.outcome, 'unavailable');
});

test('requires status-consistent verifier execution evidence', () => {
  for (const mutate of [
    (entry) => { entry.exitCode = 9; },
    (entry) => { entry.timedOut = true; },
    (entry) => { entry.exitCode = BENCHMARK_UNKNOWN; entry.signal = BENCHMARK_UNKNOWN; entry.timedOut = BENCHMARK_UNKNOWN; entry.durationMs = BENCHMARK_UNKNOWN; entry.sandbox = BENCHMARK_UNKNOWN; entry.output.ref = BENCHMARK_UNKNOWN; entry.output.sha256 = BENCHMARK_UNKNOWN; },
  ]) {
    const result = caseResult();
    mutate(result.verifier.visible[0]);
    assert.throws(() => validateBenchmarkCaseResult(result), { code: 'BENCHMARK_RESULTS_INVALID' });
  }

  const failed = caseResult();
  failed.verifier.visible = [verifier('visible', 'failed')];
  assert.doesNotThrow(() => validateBenchmarkCaseResult(failed));

  const unavailableWithGreenEvidence = caseResult();
  unavailableWithGreenEvidence.verifier.visible = [verifier('visible', 'unavailable')];
  Object.assign(unavailableWithGreenEvidence.verifier.visible[0], { exitCode: 0, signal: null, timedOut: false, durationMs: 4, sandbox: { network: 'none' } });
  assert.throws(() => validateBenchmarkCaseResult(unavailableWithGreenEvidence), { code: 'BENCHMARK_RESULTS_INVALID' });
});

test('rejects acceptance claims and duplicate verifier ids', () => {
  const result = caseResult();
  result.accepted = false;
  assert.throws(() => validateBenchmarkCaseResult(result), { code: 'BENCHMARK_RESULTS_INVALID' });

  const duplicate = caseResult();
  duplicate.verifier.heldOut[0].checkId = 'visible';
  assert.throws(() => validateBenchmarkCaseResult(duplicate), { code: 'BENCHMARK_RESULTS_INVALID' });

  const mismatchedConfig = caseResult();
  mismatchedConfig.configIdentity.model.quantization = 'Q8_0';
  assert.throws(() => validateBenchmarkCaseResult(mismatchedConfig), { code: 'BENCHMARK_RESULTS_INVALID' });
});

test('rejects unknown path-change kinds and prototype-polluting observations', () => {
  const badChange = caseResult();
  badChange.changedPaths[0].change = 'renamed';
  assert.throws(() => validateBenchmarkCaseResult(badChange), { code: 'BENCHMARK_RESULTS_INVALID' });

  const polluted = caseResult();
  polluted.observed = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateBenchmarkCaseResult(polluted), { code: 'BENCHMARK_RESULTS_INVALID' });
  const inherited = caseResult();
  inherited.observed = Object.create({ polluted: true });
  assert.throws(() => validateBenchmarkCaseResult(inherited), { code: 'BENCHMARK_RESULTS_INVALID' });
  assert.equal({}.polluted, undefined);
});

test('binds suite, packet, and profile provenance to the config identity', () => {
  for (const mutate of [
    (result) => { result.suite.sha256 = digest('z'); },
    (result) => { result.provenance.suiteSha256 = digest('z'); },
    (result) => { result.packet.packetSha256 = digest('z'); },
    (result) => { result.provenance.profileSha256 = digest('z'); },
    (result) => { result.packet.profileSha256 = digest('z'); },
  ]) {
    const result = caseResult();
    mutate(result);
    assert.throws(() => validateBenchmarkCaseResult(result), { code: 'BENCHMARK_RESULTS_INVALID' });
  }
});

test('parses a summary and invocation manifest with exact category accounting', () => {
  const identity = config();
  const suite = { id: 'contract-fixture', version: '1', sha256: digest('c') };
  const summary = {
    schemaVersion: 1,
    suite,
    configDigest: identity.configDigest,
    groups: [{ role: 'implement-slice', configDigest: identity.configDigest, scheduled: 2, completed: 1, incomplete: 0, failed: 0, unavailable: 1, notRun: 0, caseResults: [{ path: 'artifacts/case-1.json', sha256: digest('a') }, { path: 'artifacts/case-2.json', sha256: digest('b') }] }],
    artifacts: [{ path: 'artifacts/summary.json', sha256: digest('c') }],
  };
  assert.equal(parseBenchmarkSummary(JSON.stringify(summary)).groups[0].unavailable, 1);
  assert.throws(() => parseBenchmarkSummary(JSON.stringify({ ...summary, groups: [{ ...summary.groups[0], scheduled: 3 }] })), { code: 'BENCHMARK_RESULTS_INVALID' });
  assert.throws(() => parseBenchmarkSummary(JSON.stringify({ ...summary, groups: [{ ...summary.groups[0], caseResults: [] }] })), { code: 'BENCHMARK_RESULTS_INVALID' });
  assert.throws(() => parseBenchmarkSummary(JSON.stringify({ ...summary, groups: [{ ...summary.groups[0], caseResults: [summary.groups[0].caseResults[0], summary.groups[0].caseResults[0]] }] })), { code: 'BENCHMARK_RESULTS_INVALID' });

  const invocation = {
    schemaVersion: 1,
    invocationId: 'invocation-1',
    suite,
    configDigest: identity.configDigest,
    configIdentity: identity.identity,
    worker: { name: 'local', profileSha256: digest('a') },
    repeat: 2,
    startedAt: '2026-10-03T10:00:00.000Z',
    completedAt: BENCHMARK_UNKNOWN,
    caseResults: [{ path: 'artifacts/case-1.json', sha256: digest('a') }],
    summary: { path: 'artifacts/summary.json', sha256: digest('c') },
  };
  assert.equal(parseBenchmarkInvocation(JSON.stringify(invocation)).invocationId, 'invocation-1');
  const mismatchedInvocation = { ...invocation, worker: { ...invocation.worker, profileSha256: digest('z') } };
  assert.throws(() => parseBenchmarkInvocation(JSON.stringify(mismatchedInvocation)), { code: 'BENCHMARK_RESULTS_INVALID' });
});
