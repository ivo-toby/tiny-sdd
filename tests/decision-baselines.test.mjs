import test from 'node:test';
import assert from 'node:assert/strict';

import { triageFailure, triageReview } from '../src/decision-baselines.mjs';

test('triageFailure classifies talon failure logs in rule order', () => {
  const cases = [
    [
      "ReferenceError: Cannot access 'relative' before initialization",
      { decision: 'fixable-from-log', rule: 'tdz' },
    ],
    [
      " 12:3 error Async method 'list' has no 'await' expression require-await",
      { decision: 'fixable-from-log', rule: 'eslint' },
    ],
    [
      'src/x.ts(4,10): error TS2339: Property \'val\' does not exist on type \'Result<...>\'',
      { decision: 'fixable-from-log', rule: 'tsc' },
    ],
    [
      'connect ECONNREFUSED 127.0.0.1:5432',
      { decision: 'environment', rule: 'environment' },
    ],
    [
      "Cannot find module './lease'",
      { decision: 'missing-context', rule: 'missing-context' },
    ],
    [
      'AssertionError: Expected values to be strictly equal\nReceived: 1',
      { decision: 'fixable-from-log', rule: 'assertion' },
    ],
    [
      'the check completed without a diagnostic',
      { decision: 'unknown', rule: null },
    ],
  ];
  for (const [checkLog, expected] of cases) {
    const evidence = expected.decision === 'unknown' ? [] : checkLog.split('\n');
    assert.deepEqual(triageFailure({ checkLog }), { ...expected, evidence });
  }
});

test('triageFailure prefers environment evidence and limits/truncates it', () => {
  const longLine = `prefix ${'x'.repeat(400)} ECONNREFUSED`;
  const result = triageFailure({
    checkLog: [longLine, 'ENOTFOUND host', 'ENOSPC', 'EACCES', "Cannot find module './ignored'"].join('\n'),
  });
  assert.equal(result.decision, 'environment');
  assert.equal(result.rule, 'environment');
  assert.equal(result.evidence.length, 3);
  assert.equal(result.evidence[0].length, 300);
  assert.deepEqual(result.evidence.slice(1), ['ENOTFOUND host', 'ENOSPC']);
});

const cleanResult = { outcome: 'completed', scopeViolations: [] };
const passingChecks = [{ name: 'test', passed: true }];
const cleanPatch = 'diff --git a/src/file.mjs b/src/file.mjs\n+const value = 1;';

test('triageReview does not escalate a completed clean result', () => {
  assert.deepEqual(triageReview({ result: cleanResult, controllerChecks: passingChecks, patch: cleanPatch }), {
    needsFrontierReview: false,
    reasons: [],
  });
});

test('triageReview reports each failed review condition', () => {
  const cases = [
    [{ ...cleanResult, outcome: 'timeout' }, passingChecks, cleanPatch, 'outcome'],
    [{ outcome: 'completed', scopeViolations: [{ path: 'outside.mjs' }] }, passingChecks, cleanPatch, 'scope'],
    [cleanResult, [], cleanPatch, 'checks are missing'],
    [cleanResult, [{ name: 'test', passed: false }], cleanPatch, 'checks did not all pass'],
    [cleanResult, passingChecks, '+export function publicApi() {}', 'public API'],
  ];
  for (const [result, controllerChecks, patch, reason] of cases) {
    const triage = triageReview({ result, controllerChecks, patch });
    assert.equal(triage.needsFrontierReview, true);
    assert.ok(triage.reasons.some((entry) => entry.includes(reason)), `${reason}: ${triage.reasons.join(', ')}`);
  }
});
