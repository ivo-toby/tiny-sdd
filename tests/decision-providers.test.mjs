import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  appendDecisionRecords,
  buildDecisionRecord,
} from '../src/semantic-policy.mjs';
import {
  DECISION_OBSERVATION_ACTION,
  decisionQuestionDigest,
  observeDecision,
  parseDecisionQuestions,
  replaySavedPredictions,
  validateDecisionObservationBatch,
  validateDecisionProviderResponse,
  validateSavedProviderMetadata,
} from '../src/decision-providers.mjs';
import {
  DECISION_UNKNOWN,
  decisionCaseInputDigest,
  decisionDatasetDigest,
  validateDecisionDataset,
  validateDecisionPredictions,
} from '../src/decision-dataset.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const exec = promisify(execFile);
const canonicalTmpdir = await realpath(tmpdir());
const script = fileURLToPath(new URL('../scripts/observe-decisions.mjs', import.meta.url));
const digest = (letter) => letter.repeat(64);

function caseValue({ id, decisionPoint, path, sourceSha256, label, groups }) {
  return {
    id,
    decisionPoint,
    synthetic: true,
    source: { kind: 'fixture', refs: [{ path, sha256: sourceSha256 }] },
    observation: { checkLog: `fixture-${id}` },
    expected: {
      label,
      reviewedBy: 'operator',
      reviewedAt: '2026-10-05T07:00:00.000Z',
    },
    split: {
      partition: 'test',
      sourceGroup: `source-${groups}`,
      featureGroup: `feature-${groups}`,
      runLineageGroup: `lineage-${groups}`,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-provider-'));
  await mkdir(join(root, 'evidence'), { recursive: true });
  const firstText = 'first retained evidence\n';
  const secondText = 'second retained evidence\n';
  await writeFile(join(root, 'evidence', 'first.txt'), firstText);
  await writeFile(join(root, 'evidence', 'second.txt'), secondText);
  const dataset = validateDecisionDataset({
    schemaVersion: 1,
    id: 'provider-fixture',
    version: '1',
    cases: [
      caseValue({ id: 'case-one', decisionPoint: 'failure-triage', path: 'evidence/first.txt', sourceSha256: sha256(firstText), label: 'fixable-from-log', groups: 'one' }),
      caseValue({ id: 'case-two', decisionPoint: 'research-relevance', path: 'evidence/second.txt', sourceSha256: sha256(secondText), label: 'toString', groups: 'two' }),
    ],
  });
  return { root, dataset, firstText, secondText };
}

function prediction(providerId, configLetter, dataset, item, predictedLabel = 'fixable-from-log') {
  return {
    provider: { id: providerId, configSha256: digest(configLetter) },
    caseId: item.id,
    inputSha256: decisionCaseInputDigest(item),
    predictedLabel,
    probabilities: { 'fixable-from-log': 0.75, toString: 0.25 },
    measurements: {
      latencyMs: 12,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      frontierTokensAvoided: 4,
    },
  };
}

function predictionsFor(dataset, includeSecondBeta = true) {
  const entries = [
    ...dataset.cases.map((item) => prediction('provider-a', 'a', dataset, item)),
    prediction('provider-b', 'b', dataset, dataset.cases[0]),
  ];
  if (includeSecondBeta) entries.push(prediction('provider-b', 'b', dataset, dataset.cases[1], 'toString'));
  return validateDecisionPredictions({
    schemaVersion: 1,
    datasetSha256: decisionDatasetDigest(dataset),
    predictions: entries,
  });
}

function providerMetadata({ unavailable = false } = {}) {
  return validateSavedProviderMetadata({
    schemaVersion: 1,
    providers: [
      {
        id: 'provider-a',
        configSha256: digest('a'),
        model: { id: 'saved-model-a', version: 'v1' },
        available: true,
      },
      {
        id: 'provider-b',
        configSha256: digest('b'),
        model: { id: 'saved-model-b', version: 'v2' },
        available: unavailable ? false : true,
        ...(unavailable ? { availabilityReason: 'fixture unavailable' } : {}),
      },
    ],
  });
}

test('shadow provider receives only the label-blind projection and retains exact digests', async () => {
  const { dataset } = await fixture();
  let calls = 0;
  let received;
  const question = { id: 'triage-choice', type: 'choice', choices: ['fixable-from-log', 'environment'] };
  const record = await observeDecision({
    caseValue: dataset.cases[0],
    question,
    provider: {
      id: 'provider-a',
      configSha256: digest('a'),
      modelId: 'model-a',
      modelVersion: 'v1',
      available: true,
      decide: async (value) => {
        calls += 1;
        received = value;
        return { choice: 'fixable-from-log', probabilities: { 'fixable-from-log': 0.9 } };
      },
    },
    timestamp: '2026-10-05T07:01:00.000Z',
  });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(received.state).sort(), ['decisionPoint', 'observation', 'source', 'synthetic']);
  assert.equal(Object.hasOwn(received.state, 'expected'), false);
  assert.equal(JSON.stringify(received.state).includes('reviewedBy'), false);
  assert.equal(Object.isFrozen(received.state), true);
  assert.equal(record.effectiveMode, 'shadow');
  assert.equal(record.action, DECISION_OBSERVATION_ACTION);
  assert.equal(record.band, DECISION_UNKNOWN);
  assert.equal(record.inputSha256, decisionCaseInputDigest(dataset.cases[0]));
  assert.equal(record.questionSha256, decisionQuestionDigest(question));
  assert.equal(record.model.id, 'model-a');
  assert.equal(record.calibration, DECISION_UNKNOWN);
  assert.equal(record.thresholds, DECISION_UNKNOWN);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test('provider callback metadata is detached and frozen before invocation', async () => {
  const { dataset } = await fixture();
  let callbackProvider;
  const record = await observeDecision({
    caseValue: dataset.cases[0],
    question: { id: 'triage-choice', type: 'choice', choices: ['fixable-from-log', 'environment'] },
    provider: {
      id: 'provider-a',
      configSha256: digest('a'),
      model: { id: 'model-a', version: 'v1' },
      availability: { status: 'available', available: true },
      decide: async ({ provider }) => {
        callbackProvider = provider;
        assert.equal(Object.isFrozen(provider), true);
        assert.equal(Object.isFrozen(provider.model), true);
        assert.equal(Object.isFrozen(provider.availability), true);
        try { provider.model.id = 'substituted-model'; } catch {}
        try { provider.availability.reason = 'raw exception payload'; } catch {}
        return { choice: 'fixable-from-log' };
      },
    },
  });
  assert.equal(record.effectiveMode, 'shadow');
  assert.equal(record.model.id, 'model-a');
  assert.equal(record.model.version, 'v1');
  assert.deepEqual(record.availability, { status: 'available', available: true });
  assert.equal(callbackProvider.model.id, 'model-a');
  assert.equal(Object.hasOwn(record.availability, 'reason'), false);
});

test('off never calls a provider and unavailable, missing, invalid and enforce paths are explicit', async () => {
  const { dataset } = await fixture();
  const question = { id: 'triage-choice', type: 'choice', choices: ['fixable-from-log', 'environment'] };
  let calls = 0;
  const common = {
    id: 'provider-a',
    configSha256: digest('a'),
    model: { id: 'model-a', version: 'v1' },
    available: true,
    decide: async () => {
      calls += 1;
      return { choice: 'fixable-from-log' };
    },
  };
  const off = await observeDecision({ caseValue: dataset.cases[0], question, provider: common, mode: 'off' });
  assert.equal(off.effectiveMode, 'off');
  assert.equal(off.reason, 'mode-off');
  assert.equal(calls, 0);

  const unavailable = await observeDecision({ caseValue: dataset.cases[0], question, provider: { ...common, available: false, availabilityReason: 'offline fixture' } });
  assert.equal(unavailable.effectiveMode, 'off');
  assert.equal(unavailable.reason, 'provider-unavailable');
  assert.equal(calls, 0);

  const missing = await observeDecision({ caseValue: dataset.cases[0], question, provider: { ...common, decide: undefined } });
  assert.equal(missing.effectiveMode, 'off');
  assert.equal(missing.reason, 'provider-missing');
  assert.equal(calls, 0);

  const invalidResponse = await observeDecision({
    caseValue: dataset.cases[0],
    question,
    provider: { ...common, decide: async () => { calls += 1; return { choice: 'not-an-option' }; } },
  });
  assert.equal(invalidResponse.effectiveMode, 'off');
  assert.equal(invalidResponse.reason, 'invalid-response');
  assert.equal(calls, 1);

  const contradictoryResponse = await observeDecision({
    caseValue: dataset.cases[0],
    question,
    provider: { ...common, decide: async () => ({ choice: 'fixable-from-log', value: 'environment' }) },
  });
  assert.equal(contradictoryResponse.effectiveMode, 'off');
  assert.equal(contradictoryResponse.reason, 'invalid-response');

  await assert.rejects(observeDecision({ caseValue: dataset.cases[0], question, provider: common, mode: 'enforce' }), { code: 'DECISION_PROVIDER_UNSUPPORTED' });
  assert.equal(calls, 1);
});

test('typed questions and responses enforce bounds and identity', async () => {
  const { dataset } = await fixture();
  const inputSha256 = decisionCaseInputDigest(dataset.cases[0]);
  const question = { id: 'bounded-score', type: 'score', minimum: 0, maximum: 10 };
  const provider = { id: 'provider-a', configSha256: digest('a'), available: true };
  assert.throws(() => validateDecisionProviderResponse({ score: 11 }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ score: 3, probability: 1.1 }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ score: 3, inputSha256: digest('z') }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ score: 3, providerId: 'other' }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  const valid = validateDecisionProviderResponse({ score: 3, probability: 0.8 }, { question, inputSha256, provider });
  assert.equal(valid.value, 3);
  assert.equal(valid.probability, 0.8);
  assert.equal(valid.probabilities.score, 0.8);
  assert.equal(valid.questionSha256, decisionQuestionDigest(question));
  assert.equal(validateDecisionProviderResponse({ score: 3, value: 3, probability: 0.8 }, { question, inputSha256, provider }).value, 3);
  assert.throws(() => validateDecisionProviderResponse({ score: 3, value: 4 }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ score: 3, choice: 'a' }, { question, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });

  const choiceQuestion = { id: 'bounded-choice', type: 'choice', choices: ['a', 'b'] };
  const choice = validateDecisionProviderResponse({ choice: 'a', value: 'a' }, { question: choiceQuestion, inputSha256, provider });
  assert.equal(choice.value, 'a');
  assert.throws(() => validateDecisionProviderResponse({ choice: 'a', value: 'b' }, { question: choiceQuestion, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ choice: 'a', score: 1 }, { question: choiceQuestion, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });

  const noulQuestion = { id: 'bounded-noul', type: 'noul' };
  const noul = validateDecisionProviderResponse({ noul: 0.3, value: 0.3, probability: 0.8 }, { question: noulQuestion, inputSha256, provider });
  assert.equal(noul.value, 0.3);
  assert.throws(() => validateDecisionProviderResponse({ noul: 0.3, value: 0.4 }, { question: noulQuestion, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionProviderResponse({ noul: 0.3, score: 0.4 }, { question: noulQuestion, inputSha256, provider }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => parseDecisionQuestions(JSON.stringify({ schemaVersion: 1, questions: { 'failure-triage': { id: 'q', type: 'choice', choices: ['__proto__', '__proto__'] } } })), { code: 'DECISION_PROVIDER_INVALID' });
});

test('replay validates two saved identities, records missing predictions off, and survives JSON serialization', async () => {
  const { dataset } = await fixture();
  const report = replaySavedPredictions({
    dataset,
    predictions: predictionsFor(dataset, false),
    providerMetadata: providerMetadata(),
    timestamp: '2026-10-05T07:02:00.000Z',
    minimumProviders: 2,
  });
  assert.equal(report.providers.length, 2);
  assert.equal(report.records.length, 4);
  assert.equal(report.records.filter((record) => record.effectiveMode === 'shadow').length, 3);
  const missing = report.records.find((record) => record.provider.id === 'provider-b' && record.inputSha256 === decisionCaseInputDigest(dataset.cases[1]));
  assert.equal(missing.reason, 'missing-saved-prediction');
  assert.equal(missing.caseId, 'case-two');
  assert.equal(missing.decisionPoint, 'research-relevance');
  assert.equal(missing.probabilities, DECISION_UNKNOWN);
  assert.equal(missing.action, DECISION_OBSERVATION_ACTION);
  const saved = report.records.find((record) => record.provider.id === 'provider-a');
  assert.equal(saved.model.id, 'saved-model-a');
  assert.equal(saved.measurements.latencyMs, 12);
  assert.equal(saved.band, DECISION_UNKNOWN);
  assert.equal(saved.replayed, true);
  assert.equal(saved.provider.configSha256, digest('a'));
  assert.equal(saved.datasetSha256, report.dataset.sha256);
  assert.equal(saved.predictionsSha256, report.predictionsSha256);
  assert.equal(saved.questionSha256, DECISION_UNKNOWN);
  assert.equal(saved.replayQuestionSha256, DECISION_UNKNOWN);
  for (const record of report.records) {
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('reviewedBy'), false);
    assert.equal(serialized.includes('checkLog'), false);
    assert.equal(serialized.includes('expected'), false);
    assert.equal(Object.hasOwn(record, 'questionText'), false);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report.records)), report.records);
});

test('replay retains case identity and validates replay-only question mappings', async () => {
  const { dataset } = await fixture();
  const sameInputCases = validateDecisionDataset({
    ...dataset,
    cases: [
      dataset.cases[0],
      {
        ...dataset.cases[0],
        id: 'case-two-same-input',
        expected: { ...dataset.cases[0].expected, label: 'environment' },
        split: { ...dataset.cases[0].split, sourceGroup: 'source-two', featureGroup: 'feature-two', runLineageGroup: 'lineage-two' },
      },
    ],
  });
  assert.equal(decisionCaseInputDigest(sameInputCases.cases[0]), decisionCaseInputDigest(sameInputCases.cases[1]));
  const predictions = validateDecisionPredictions({
    schemaVersion: 1,
    datasetSha256: decisionDatasetDigest(sameInputCases),
    predictions: sameInputCases.cases.map((item) => prediction('provider-a', 'a', sameInputCases, item)),
  });
  const report = replaySavedPredictions({ dataset: sameInputCases, predictions });
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].inputSha256, report.records[1].inputSha256);
  assert.notEqual(report.records[0].caseId, report.records[1].caseId);
  assert.notEqual(JSON.stringify(report.records[0]), JSON.stringify(report.records[1]));
  assert.equal(report.records.every((record) => record.decisionPoint === 'failure-triage'), true);

  const validQuestions = {
    schemaVersion: 1,
    questions: {
      'failure-triage': { id: 'replay-labels', type: 'choice', choices: ['fixable-from-log', 'environment'] },
    },
  };
  const mapped = replaySavedPredictions({ dataset, predictions: predictionsFor(dataset), questions: validQuestions, minimumProviders: 2 });
  assert.equal(mapped.records[0].questionSha256, DECISION_UNKNOWN);
  assert.equal(mapped.records[0].replayQuestionSha256, decisionQuestionDigest(validQuestions.questions['failure-triage']));
  assert.throws(() => replaySavedPredictions({
    dataset,
    predictions: predictionsFor(dataset),
    questions: { schemaVersion: 1, questions: { 'failure-triage': { id: 'wrong', type: 'choice', choices: ['not-the-predicted-label'] } } },
    minimumProviders: 2,
  }), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => replaySavedPredictions({
    dataset,
    predictions: predictionsFor(dataset),
    questions: { schemaVersion: 1, questions: { 'failure-triage': { id: 'wrong-type', type: 'score', minimum: 0, maximum: 1 } } },
    minimumProviders: 2,
  }), { code: 'DECISION_PROVIDER_INVALID' });
});

test('replay keeps missing metadata UNKNOWN and refuses changed dataset/input/provider bindings', async () => {
  const { dataset } = await fixture();
  const predictions = predictionsFor(dataset);
  const report = replaySavedPredictions({ dataset, predictions, minimumProviders: 2 });
  assert.equal(report.providers.every((provider) => provider.model.id === DECISION_UNKNOWN), true);
  assert.equal(report.providers.every((provider) => provider.model.version === DECISION_UNKNOWN), true);
  assert.equal(report.warnings.some((warning) => warning.includes('model metadata is UNKNOWN')), true);

  const changedDataset = JSON.parse(JSON.stringify(dataset));
  changedDataset.cases[0].observation.checkLog = 'changed';
  assert.throws(() => replaySavedPredictions({ dataset: changedDataset, predictions, minimumProviders: 2 }), { code: 'DECISION_EVALUATION_INVALID' });
  const changedInput = JSON.parse(JSON.stringify(predictions));
  changedInput.predictions[0].inputSha256 = digest('d');
  assert.throws(() => replaySavedPredictions({ dataset, predictions: changedInput, minimumProviders: 2 }), { code: 'DECISION_EVALUATION_INVALID' });
  const changedProvider = JSON.parse(JSON.stringify(predictions));
  changedProvider.predictions[0].provider.configSha256 = digest('e');
  assert.throws(() => replaySavedPredictions({ dataset, predictions: changedProvider, minimumProviders: 2 }), { code: 'DECISION_EVALUATION_INVALID' });
});

test('unavailable saved provider carries no probabilities and never maps a band', async () => {
  const { dataset } = await fixture();
  const report = replaySavedPredictions({ dataset, predictions: predictionsFor(dataset), providerMetadata: providerMetadata({ unavailable: true }), minimumProviders: 2 });
  const unavailable = report.records.filter((record) => record.provider.id === 'provider-b');
  assert.equal(unavailable.length, 2);
  assert.equal(unavailable.every((record) => record.effectiveMode === 'off'), true);
  assert.equal(unavailable.every((record) => record.reason === 'provider-unavailable'), true);
  assert.equal(unavailable.every((record) => record.probabilities === DECISION_UNKNOWN), true);
  assert.equal(unavailable.every((record) => record.band === DECISION_UNKNOWN), true);
});

test('CLI validates evidence before output or explicit log append and refuses overwrite/symlink paths', async () => {
  const { root, dataset, firstText } = await fixture();
  try {
    await writeFile(join(root, 'dataset.json'), `${JSON.stringify(dataset)}\n`);
    const predictions = predictionsFor(dataset);
    await writeFile(join(root, 'predictions.json'), `${JSON.stringify(predictions)}\n`);
    await writeFile(join(root, 'providers.json'), `${JSON.stringify(providerMetadata())}\n`);
    const oldRecord = buildDecisionRecord({
      timestamp: '2026-10-05T07:03:00.000Z',
      taskId: 'replay',
      mode: 'shadow',
      model: 'legacy',
      policyAction: 'ignored-shadow',
    });
    await appendDecisionRecords(root, 'replay', [oldRecord]);
    const first = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--providers', 'providers.json', '--output', 'report.json', '--log-task', 'replay', '--json']);
    assert.equal(first.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(first.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.report.records.length, 4);
    assert.equal(parsed.output, 'report.json');
    assert.equal(parsed.loggedRecords, 4);
    const ledgerLines = (await readFile(join(root, '.tinysdd', 'runs', 'decisions', 'replay.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(ledgerLines.length, 5);
    assert.equal(ledgerLines[0].gate, 'evidence-sufficiency');
    assert.equal(ledgerLines[1].recordType, 'decision-provider-observation');
    assert.equal((await readFile(join(root, 'evidence', 'first.txt'), 'utf8')), firstText);

    const existing = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--providers', 'providers.json', '--output', 'report.json', '--json']).catch((error) => error);
    assert.equal(existing.code, 1);
    assert.equal(JSON.parse(existing.stdout).error.code, 'INVALID_ARGUMENT');

    const evidenceOutput = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--providers', 'providers.json', '--output', 'evidence/first.txt', '--log-task', 'blocked', '--json']).catch((error) => error);
    assert.equal(evidenceOutput.code, 1);
    assert.equal(JSON.parse(evidenceOutput.stdout).error.code, 'INVALID_ARGUMENT');
    assert.equal((await readFile(join(root, 'evidence', 'first.txt'), 'utf8')), firstText);
    assert.equal((await readFile(join(root, '.tinysdd', 'runs', 'decisions', 'blocked.jsonl')).catch(() => null)), null);

    await mkdir(join(root, '.tinysdd', 'runs', 'decisions'), { recursive: true });
    const outside = join(root, 'outside-ledger.jsonl');
    await writeFile(outside, 'unchanged\n');
    await symlink(outside, join(root, '.tinysdd', 'runs', 'decisions', 'symlinked.jsonl'));
    const symlinkResult = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--providers', 'providers.json', '--log-task', 'symlinked', '--json']).catch((error) => error);
    assert.equal(symlinkResult.code, 1);
    assert.equal(JSON.parse(symlinkResult.stdout).error.code, 'SYMLINK_PATH');
    assert.equal(await readFile(outside, 'utf8'), 'unchanged\n');

    const changed = JSON.parse(await readFile(join(root, 'predictions.json'), 'utf8'));
    changed.predictions[0].inputSha256 = digest('d');
    await writeFile(join(root, 'predictions.json'), JSON.stringify(changed));
    const bindingResult = await exec(process.execPath, [script, '--project', root, '--dataset', 'dataset.json', '--predictions', 'predictions.json', '--providers', 'providers.json', '--output', 'should-not-exist.json', '--log-task', 'should-not-exist', '--json']).catch((error) => error);
    assert.equal(bindingResult.code, 1);
    assert.equal(JSON.parse(bindingResult.stdout).error.code, 'DECISION_EVALUATION_INVALID');
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'decisions', 'should-not-exist.jsonl')).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observation batch rejects mapped bands and raw state-shaped fields before append', () => {
  const valid = {
    schemaVersion: 1,
    recordType: 'decision-provider-observation',
    replayed: false,
    timestamp: '2026-10-05T07:04:00.000Z',
    inputSha256: digest('a'),
    questionSha256: digest('b'),
    datasetSha256: DECISION_UNKNOWN,
    predictionsSha256: DECISION_UNKNOWN,
    provider: { id: 'provider-a', configSha256: digest('a'), model: { id: DECISION_UNKNOWN, version: DECISION_UNKNOWN }, availability: { status: 'available', available: true } },
    model: { id: DECISION_UNKNOWN, version: DECISION_UNKNOWN },
    requestedMode: 'shadow',
    effectiveMode: 'shadow',
    availability: { status: 'available', available: true },
    value: '__proto__',
    responseType: 'saved-prediction',
    probabilities: { toString: 0.5 },
    calibration: DECISION_UNKNOWN,
    thresholds: DECISION_UNKNOWN,
    band: DECISION_UNKNOWN,
    action: DECISION_OBSERVATION_ACTION,
    measurements: { latencyMs: DECISION_UNKNOWN, inputTokens: DECISION_UNKNOWN, outputTokens: DECISION_UNKNOWN, totalTokens: DECISION_UNKNOWN, frontierTokensAvoided: DECISION_UNKNOWN },
  };
  assert.throws(() => validateDecisionObservationBatch([{ ...valid, band: 'allow' }]), { code: 'DECISION_PROVIDER_INVALID' });
  assert.throws(() => validateDecisionObservationBatch([{ ...valid, expected: 'leak' }]), { code: 'DECISION_PROVIDER_INVALID' });
  assert.deepEqual(validateDecisionObservationBatch([valid])[0].value, '__proto__');
});
