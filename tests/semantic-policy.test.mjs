import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  aggregateGateOutcome,
  appendDecisionRecords,
  buildDecisionRecord,
  computeBand,
  GATE_ID,
} from '../src/semantic-policy.mjs';

const THRESHOLDS = { accept: 0.75, reject: 0.4 };

test('band boundaries: >= accept allow, < reject block, between confirm', () => {
  assert.equal(computeBand(1, THRESHOLDS), 'allow');
  assert.equal(computeBand(0.75, THRESHOLDS), 'allow');
  assert.equal(computeBand(0.749, THRESHOLDS), 'confirm');
  assert.equal(computeBand(0.4, THRESHOLDS), 'confirm');
  assert.equal(computeBand(0.399, THRESHOLDS), 'block');
  assert.equal(computeBand(0, THRESHOLDS), 'block');
  assert.throws(() => computeBand(1.5, THRESHOLDS), { code: 'POLICY_INVALID' });
  assert.throws(() => computeBand(NaN, THRESHOLDS), { code: 'POLICY_INVALID' });
  assert.throws(() => computeBand(0.5, { accept: 0.75 }), { code: 'POLICY_INVALID' });
});

test('aggregation blocks on any blocked band and shadow never enforces', () => {
  const allow = { id: 'C1', band: 'allow' };
  const confirm = { id: 'C2', band: 'confirm' };
  const block = { id: 'C3', band: 'block' };
  assert.deepEqual(aggregateGateOutcome({ evaluated: [allow, allow], mode: 'enforce' }), { action: 'allow', policyAction: 'allow' });
  assert.deepEqual(aggregateGateOutcome({ evaluated: [allow, confirm], mode: 'enforce' }), { action: 'confirm', policyAction: 'confirm' });
  assert.deepEqual(aggregateGateOutcome({ evaluated: [confirm, block], mode: 'enforce' }), { action: 'block', policyAction: 'block' });
  assert.deepEqual(aggregateGateOutcome({ evaluated: [block], mode: 'shadow' }), { action: 'block', policyAction: 'ignored-shadow' });
  assert.throws(() => aggregateGateOutcome({ evaluated: [{ id: 'C1', band: 'maybe' }], mode: 'enforce' }), { code: 'POLICY_INVALID' });
  assert.throws(() => aggregateGateOutcome({ evaluated: [allow], mode: 'sometimes' }), { code: 'POLICY_INVALID' });
});

test('decision records carry the fixed gate field set with digests only', () => {
  const record = buildDecisionRecord({
    timestamp: '2026-09-21T00:00:00.000Z',
    taskId: 'one',
    mode: 'enforce',
    model: 'jev-latest',
    questionId: 'C1',
    criterionDigest: 'a'.repeat(64),
    noul: 0.9,
    band: 'allow',
    policyAction: 'allow',
    artifactDigests: { briefDigest: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64) },
  });
  assert.equal(record.gate, GATE_ID);
  assert.equal(record.gate, 'evidence-sufficiency');
  assert.deepEqual(Object.keys(record).sort(), [
    'artifactDigests', 'band', 'criterionDigest', 'gate', 'mode', 'model',
    'modelVersion', 'noul', 'policyAction', 'questionId', 'taskId', 'timestamp',
  ]);
  assert.equal(record.modelVersion, null);
  assert.throws(() => buildDecisionRecord({ timestamp: 'x', taskId: 'Bad Id', mode: 'off', model: 'm', policyAction: 'allow' }), { code: 'POLICY_INVALID' });
  assert.throws(() => buildDecisionRecord({ timestamp: 'x', taskId: 'one', mode: 'off', model: 'm', policyAction: 'allow', band: 'maybe' }), { code: 'POLICY_INVALID' });
  assert.throws(() => buildDecisionRecord({ taskId: 'one', mode: 'off', model: 'm', policyAction: 'allow' }), { code: 'POLICY_INVALID' });
});

test('decision records append as JSONL under runs/decisions per task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-policy-'));
  try {
    await mkdir(join(root, '.tinysdd'), { recursive: true });
    const record = (noul) => buildDecisionRecord({
      timestamp: new Date().toISOString(),
      taskId: 'one',
      mode: 'shadow',
      model: 'jev-latest',
      questionId: 'C1',
      criterionDigest: 'a'.repeat(64),
      noul,
      band: 'allow',
      policyAction: 'ignored-shadow',
    });
    await appendDecisionRecords(root, 'one', [record(0.9)]);
    await appendDecisionRecords(root, 'one', [record(0.8)]);
    const text = await readFile(join(root, '.tinysdd', 'runs', 'decisions', 'one.jsonl'), 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].noul, 0.9);
    assert.equal(lines[1].noul, 0.8);
    await assert.rejects(appendDecisionRecords(root, 'Bad Id', [record(0.9)]), { code: 'POLICY_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
