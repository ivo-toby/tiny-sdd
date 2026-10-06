import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSliceTestReviewEvent } from '../src/slice-test-review.mjs';
import { buildSliceTestReviewReport } from '../src/slice-test-review-report.mjs';

const digest = 'a'.repeat(64);

function event(sequence, overrides = {}) {
  return createSliceTestReviewEvent({
    eventType: 'initial-assessment',
    sequence,
    timestamp: '2026-10-06T00:00:00.000Z',
    identity: { featureId: 'feature', taskId: 'task', sliceId: 'slice', runId: `worker-${sequence}`, rootRunId: 'worker-1', lineageId: 'lineage', revision: sequence - 1 },
    inputDigest: digest,
    envelopeDigest: digest,
    assessment: { status: 'observed', verdict: 'positive', observations: [{ criterionId: 'criterion', criterionType: 'slice-test-adequacy', question: 'Does the test cover the requirement?', probability: 0.9, judgment: 'UNKNOWN' }], measurements: { inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 2 } },
    provenance: { source: 'validated-final-run', replayed: false, capture: 'offline-fixture' },
    ...overrides,
  });
}

function review(assessment, sequence, verdict = 'accepted') {
  return event(sequence, {
    eventType: 'strong-review',
    identity: assessment.identity,
    inputDigest: assessment.inputDigest,
    assessment: assessment.assessment,
    review: { reviewer: { id: 'frontier', role: 'reviewer' }, strength: 'strong', attested: true, verdict, inputDigest: assessment.inputDigest, reason: 'Independent reference assessment' },
  });
}

test('review reports count only exact-input reviewed positives and retain denominators', () => {
  const first = event(1);
  const second = event(3);
  const report = buildSliceTestReviewReport([first, review(first, 2, 'rejected'), second]);
  assert.deepEqual(report.positiveReviewCoverage, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(report.positiveReviewDisagreement, { numerator: 1, denominator: 1, value: 1 });
  assert.equal(report.measuredJevUsage.totalTokens.total, 30);
  assert.equal(report.calibrationCases[0].criterionReference, 'UNKNOWN');
  assert.equal(report.populationCalibration, 'UNKNOWN');
  assert.equal(report.directStrongImplementationComparison, 'UNKNOWN');
});

test('unreviewed negatives do not become false-rejection labels', () => {
  const negative = event(1, { assessment: { ...event(1).assessment, verdict: 'negative' } });
  const report = buildSliceTestReviewReport([negative]);
  assert.equal(report.unreviewedNegatives, 1);
  assert.deepEqual(report.negativeReviewDisagreement, { numerator: 0, denominator: 0, value: 'UNKNOWN' });
  assert.deepEqual(report.calibrationCases, []);
});

test('missing usage remains UNKNOWN and review copies do not double-count inference', () => {
  const first = event(1, { assessment: { ...event(1).assessment, measurements: {} } });
  const report = buildSliceTestReviewReport([first, review(first, 2)]);
  assert.deepEqual(report.measuredJevUsage.inputTokens, { measured: 0, measuredCases: 0, missingCases: 1, total: 'UNKNOWN' });
  assert.equal(report.frontierReviewUsage, 'UNKNOWN');
  assert.equal(report.totalFeatureCost, 'UNKNOWN');
});

test('replay and synthetic measurements are excluded from observed live inference totals', () => {
  const replay = event(1, { provenance: { source: 'replay', replayed: true, capture: 'retained-response' } });
  const synthetic = event(2, { provenance: { source: 'synthetic', replayed: false, capture: 'offline-fixture' } });
  const report = buildSliceTestReviewReport([replay, synthetic]);
  assert.equal(report.liveAssessments, 0);
  assert.equal(report.replayAssessments, 1);
  assert.equal(report.syntheticAssessments, 1);
  assert.equal(report.measuredJevUsage.latencyMs.total, 'UNKNOWN');
  assert.equal(report.replayOriginalMeasurements[0].measurements.latencyMs, 2);
});

test('reviews cannot match a different run or lineage and conflicting reviews refuse', () => {
  const first = event(1);
  const wrong = review(first, 2);
  wrong.identity = { ...wrong.identity, lineageId: 'other' };
  delete wrong.eventId;
  delete wrong.eventDigest;
  const report = buildSliceTestReviewReport([first, createSliceTestReviewEvent(wrong)]);
  assert.equal(report.positiveReviewCoverage.numerator, 0);
  assert.throws(() => buildSliceTestReviewReport([first, review(first, 2), review(first, 3, 'rejected')]), { code: 'SLICE_TEST_REVIEW_REPORT_INVALID' });
  assert.throws(() => buildSliceTestReviewReport([first, first]), { code: 'SLICE_TEST_REVIEW_DUPLICATE' });
  const repeated = event(2, { identity: first.identity });
  assert.throws(() => buildSliceTestReviewReport([first, repeated, review(first, 3)]), { code: 'SLICE_TEST_REVIEW_REPORT_INVALID' });
});

test('feature report filtering preserves source identity without importing other feature outcomes', () => {
  const first = event(1);
  const second = event(2, { identity: { ...event(2).identity, featureId: 'other-feature' } });
  const report = buildSliceTestReviewReport([first, second], { feature: 'feature' });
  assert.equal(report.assessments, 1);
  assert.equal(report.feature, 'feature');
  assert.equal(report.calibrationCases.length, 0);
  assert.equal(report.sourceDigest, buildSliceTestReviewReport([first], { feature: 'feature' }).sourceDigest);
  assert.throws(() => buildSliceTestReviewReport([], { feature: '' }), { code: 'SLICE_TEST_REVIEW_REPORT_INVALID' });
});

test('report CLI produces exactly one JSON object and reports absent evidence as UNKNOWN', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-review-report-cli-'));
  const cli = new URL('../bin/tinysdd.mjs', import.meta.url).pathname;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, '--project', root, '--json', 'slice-tests', 'report', '--feature', 'feature']);
    const result = JSON.parse(stdout);
    assert.equal(stderr, '');
    assert.equal(result.ok, true);
    assert.equal(result.data.assessments, 0);
    assert.equal(result.data.positiveReviewDisagreement.value, 'UNKNOWN');
    const human = await promisify(execFile)(process.execPath, [cli, '--project', root, 'slice-tests', 'report']);
    assert.match(human.stdout, /0 assessments/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
