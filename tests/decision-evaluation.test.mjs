import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../src/fs-utils.mjs';
import {
  DECISION_UNKNOWN,
  decisionCaseInputDigest,
  decisionDatasetDigest,
  parseDecisionDataset,
  validateDecisionDataset,
  validateDecisionDatasetEvidence,
  validateDecisionPredictions,
} from '../src/decision-dataset.mjs';
import {
  buildBaselinePredictions,
  evaluateDecisions,
  parseDecisionMetricsConfig,
} from '../src/decision-evaluation.mjs';

const exec = promisify(execFile);
const canonicalTmpdir = await realpath(tmpdir());
const digest = (letter) => letter.repeat(64);

function source(path, sha256Value) {
  return { kind: 'fixture', refs: [{ path, sha256: sha256Value }] };
}

function caseValue({ id, decisionPoint = 'failure-triage', synthetic = false, path, sourceSha256, partition = 'test', groups = id, label = 'fixable-from-log', observation = { checkLog: 'AssertionError: Expected value' } }) {
  return {
    id,
    decisionPoint,
    synthetic,
    source: source(path, sourceSha256),
    observation,
    expected: { label, reviewedBy: 'operator', reviewedAt: '2026-10-04T10:00:00.000Z' },
    split: { partition, sourceGroup: `source-${groups}`, featureGroup: `feature-${groups}`, runLineageGroup: `lineage-${groups}` },
  };
}

async function fixture() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-decision-evaluation-'));
  await mkdir(join(root, 'evidence'), { recursive: true });
  const firstText = 'first evidence\n';
  const secondText = 'second evidence\n';
  await writeFile(join(root, 'evidence', 'first.txt'), firstText);
  await writeFile(join(root, 'evidence', 'second.txt'), secondText);
  const dataset = validateDecisionDataset({
    schemaVersion: 1,
    id: 'offline-fixture',
    version: '1',
    cases: [
      caseValue({ id: 'case-one', path: 'evidence/first.txt', sourceSha256: sha256(firstText), groups: 'one', label: 'fixable-from-log' }),
      caseValue({ id: 'case-two', path: 'evidence/second.txt', sourceSha256: sha256(secondText), groups: 'two', label: 'environment', observation: { checkLog: 'ECONNREFUSED 127.0.0.1' } }),
      caseValue({ id: 'case-three', path: 'evidence/first.txt', sourceSha256: sha256(firstText), groups: 'three', synthetic: true, label: 'fixable-from-log' }),
    ],
  });
  return { root, dataset, firstText, secondText };
}

function metrics() {
  return parseDecisionMetricsConfig(JSON.stringify({
    schemaVersion: 1,
    decisionPoints: {
      'failure-triage': {
        positiveLabels: ['fixable-from-log'],
        acceptLabels: ['fixable-from-log'],
        threshold: 0.8,
        calibrationBins: 4,
      },
    },
  }));
}

test('validates reviewed labels, bounded groups, and keeps synthetic cases out of real counts', async () => {
  const { root, dataset } = await fixture();
  try {
    const verified = await validateDecisionDatasetEvidence(root, dataset);
    assert.equal(verified.verified.length, 3);
    const predictions = buildBaselinePredictions(dataset, { id: 'deterministic-baseline', configSha256: digest('a') });
    const report = evaluateDecisions({ dataset, predictions, metrics: metrics() });
    assert.equal(report.dataset.counts.totalCases, 3);
    assert.equal(report.dataset.counts.realCases, 2);
    assert.equal(report.dataset.counts.syntheticCases, 1);
    assert.equal(report.dataset.counts.realFailureTriageLabels, 2);
    assert.equal(report.dataset.counts.missingRealFailureTriageLabels, 48);
    assert.equal(report.providers[0].decisionPoints['failure-triage'].knownPredictedLabels, 3);
    assert.equal(report.providers[0].decisionPoints['failure-triage'].threshold.falseAcceptRate.rate, DECISION_UNKNOWN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses saved probabilities at the explicit threshold and reports both denominators', async () => {
  const { root, dataset } = await fixture();
  try {
    await validateDecisionDatasetEvidence(root, dataset);
    const provider = { id: 'saved-provider', configSha256: digest('b') };
    const predictions = validateDecisionPredictions({
      schemaVersion: 1,
      datasetSha256: decisionDatasetDigest(dataset),
      predictions: dataset.cases.map((item, index) => ({
        provider,
        caseId: item.id,
        inputSha256: decisionCaseInputDigest(item),
        predictedLabel: index === 1 ? 'fixable-from-log' : 'environment',
        probabilities: { 'fixable-from-log': index === 1 ? 0.8 : 0.1 },
        measurements: {
          latencyMs: index === 2 ? DECISION_UNKNOWN : 12 + index,
          inputTokens: DECISION_UNKNOWN,
          outputTokens: DECISION_UNKNOWN,
          totalTokens: DECISION_UNKNOWN,
          frontierTokensAvoided: DECISION_UNKNOWN,
        },
      })),
    });
    const point = evaluateDecisions({ dataset, predictions, metrics: metrics() }).providers[0].decisionPoints['failure-triage'];
    assert.deepEqual(point.threshold.classes, { accept: 1, negative: 2, abstain: 0 });
    assert.equal(point.threshold.falsePositiveRate.count, 1);
    assert.equal(point.threshold.falsePositiveRate.denominator, 1);
    assert.equal(point.threshold.falsePositiveRate.rate, 1);
    assert.equal(point.threshold.falseDiscoveryRate.denominator, 1);
    assert.equal(point.threshold.falseDiscoveryRate.rate, 1);
    assert.equal(point.calibration.sampleCount, 3);
    assert.equal(point.measurements.latencyMs.count, 2);
    assert.equal(point.measurements.inputTokens, DECISION_UNKNOWN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects split leakage, duplicate predictions, changed input, and unknown cases', async () => {
  const { root, dataset } = await fixture();
  try {
    const leaked = JSON.parse(JSON.stringify(dataset));
    leaked.cases[1].split.featureGroup = leaked.cases[0].split.featureGroup;
    leaked.cases[1].split.partition = 'validation';
    assert.throws(() => validateDecisionDataset(leaked), { code: 'DECISION_DATASET_INVALID' });

    const baseline = buildBaselinePredictions(dataset, { id: 'baseline', configSha256: digest('c') });
    const duplicate = JSON.parse(JSON.stringify(baseline));
    duplicate.predictions.push(duplicate.predictions[0]);
    assert.throws(() => validateDecisionPredictions(duplicate), { code: 'DECISION_PREDICTIONS_INVALID' });

    const changed = JSON.parse(JSON.stringify(baseline));
    changed.predictions[0].inputSha256 = digest('d');
    assert.throws(() => evaluateDecisions({ dataset, predictions: changed }), { code: 'DECISION_EVALUATION_INVALID' });

    const unknown = JSON.parse(JSON.stringify(baseline));
    unknown.predictions[0].caseId = 'missing-case';
    assert.throws(() => evaluateDecisions({ dataset, predictions: unknown }), { code: 'DECISION_EVALUATION_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evidence validation rejects hash changes, symlinks, and invalid benchmark records', async () => {
  const { root, dataset, firstText } = await fixture();
  try {
    const badHash = JSON.parse(JSON.stringify(dataset));
    badHash.cases[0].source.refs[0].sha256 = digest('e');
    await assert.rejects(validateDecisionDatasetEvidence(root, badHash), { code: 'DECISION_EVIDENCE_INVALID' });

    const outside = join(root, 'outside.txt');
    await writeFile(outside, firstText);
    await symlink(outside, join(root, 'evidence', 'link.txt'));
    const symlinked = JSON.parse(JSON.stringify(dataset));
    symlinked.cases[0].source.refs[0] = { path: 'evidence/link.txt', sha256: sha256(firstText) };
    await assert.rejects(validateDecisionDatasetEvidence(root, symlinked), (error) => ['SYMLINK_PATH', 'DECISION_EVIDENCE_INVALID'].includes(error.code));

    const badBenchmark = JSON.parse(JSON.stringify(dataset));
    badBenchmark.cases[0].source.kind = 'benchmark-case-result';
    await assert.rejects(validateDecisionDatasetEvidence(root, badBenchmark), { code: 'DECISION_EVIDENCE_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds paths and observations, validates label metadata, and exposes zero-denominator UNKNOWN', async () => {
  const { root, dataset } = await fixture();
  try {
    const traversal = JSON.parse(JSON.stringify(dataset));
    traversal.cases[0].source.refs[0].path = '../outside.txt';
    assert.throws(() => validateDecisionDataset(traversal), { code: 'DECISION_DATASET_INVALID' });

    const prototype = JSON.parse(JSON.stringify(dataset));
    prototype.cases[0].observation = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.throws(() => validateDecisionDataset(prototype), { code: 'DECISION_DATASET_INVALID' });
    assert.equal({}.polluted, undefined);

    const oversized = JSON.parse(JSON.stringify(dataset));
    oversized.cases[0].observation = { text: 'x'.repeat(128 * 1024 + 1) };
    assert.throws(() => validateDecisionDataset(oversized), { code: 'DECISION_DATASET_INVALID' });

    const missing = JSON.parse(JSON.stringify(dataset));
    missing.cases[0].source.refs[0].path = 'evidence/missing.txt';
    await assert.rejects(validateDecisionDatasetEvidence(root, missing), { code: 'PATH_NOT_FOUND' });

    const duplicateCase = JSON.parse(JSON.stringify(dataset));
    duplicateCase.cases[1].id = duplicateCase.cases[0].id;
    assert.throws(() => validateDecisionDataset(duplicateCase), { code: 'DECISION_DATASET_INVALID' });

    const invalidReview = JSON.parse(JSON.stringify(dataset));
    invalidReview.cases[0].expected.reviewedAt = 'yesterday';
    assert.throws(() => validateDecisionDataset(invalidReview), { code: 'DECISION_DATASET_INVALID' });

    const predictions = buildBaselinePredictions(dataset, { id: 'zero-denominator', configSha256: digest('1') });
    const zeroDenominatorMetrics = parseDecisionMetricsConfig(JSON.stringify({
      schemaVersion: 1,
      decisionPoints: {
        'failure-triage': {
          positiveLabels: ['fixable-from-log', 'environment'],
          acceptLabels: ['fixable-from-log'],
          threshold: 1,
        },
      },
    }));
    const point = evaluateDecisions({ dataset, predictions, metrics: zeroDenominatorMetrics }).providers[0].decisionPoints['failure-triage'];
    assert.equal(point.threshold.falsePositiveRate.rate, DECISION_UNKNOWN);
    assert.equal(point.threshold.falseDiscoveryRate.rate, DECISION_UNKNOWN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline CLI emits one JSON object and writes only an explicitly requested report', async () => {
  const { root, dataset } = await fixture();
  try {
    const datasetText = `${JSON.stringify(dataset, null, 2)}\n`;
    const predictions = buildBaselinePredictions(dataset, { id: 'baseline-cli', configSha256: digest('f') });
    await writeFile(join(root, 'dataset.json'), datasetText);
    await writeFile(join(root, 'predictions.json'), `${JSON.stringify(predictions, null, 2)}\n`);
    const script = fileURLToPath(new URL('../scripts/evaluate-decisions.mjs', import.meta.url));
    const result = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--output', 'report.json', '--json']);
    assert.equal(result.stderr.includes('WARNING:'), true);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.output, 'report.json');
    assert.equal(JSON.parse(await readFile(join(root, 'report.json'), 'utf8')).dataset.counts.syntheticCases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
