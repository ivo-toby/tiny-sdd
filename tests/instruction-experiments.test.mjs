import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { QUALIFICATION_EVIDENCE_INDEX_PATH } from '../src/qualification-store.mjs';
import { runBenchmark } from '../src/benchmark-runner.mjs';
import { digestJson, sha256 } from '../src/fs-utils.mjs';
import { readQualificationEvidence } from '../src/qualification-reader.mjs';
import { buildQualificationRecord } from '../src/qualification.mjs';
import { analyzeInstructionObservations, instructionSchedule, reportInstructionPairs, summarizeInstructionCase, validateInstructionPartitions } from '../src/instruction-experiments.mjs';
import { analyzeInstructionEvidence, createInstructionProfile, planInstructionExperiment, readInstructionReport, runInstructionExperiment } from '../src/instruction-experiment-store.mjs';
import { analysisRequest, criteria, discoveryRun, instructionFixture, jsonFile, partitions } from './helpers/instruction-experiment-fixture.mjs';

const execFileAsync = promisify(execFile);
const rootUrl = new URL('../', import.meta.url);

async function setup(t) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-instructions-')));
  const previous = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  t.after(async () => {
    if (previous === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previous;
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await instructionFixture(root);
  const discovery = await discoveryRun(fixture);
  assert.equal(discovery.observations[0].caseResult.outcome, 'failed', JSON.stringify(discovery.observations[0].caseResult.failure));
  return { ...fixture, ...discovery };
}

async function planned(t, options = {}) {
  const fixture = await setup(t);
  const request = analysisRequest(fixture.observations, fixture.result.config.configDigest);
  const analysis = await analyzeInstructionEvidence({ projectRoot: fixture.root, request, output: 'analysis.json' });
  const planned = await planInstructionExperiment({ ...fixture, ...options, projectRoot: fixture.root, output: 'experiment', request: { id: 'caller-pilot', analysis: analysis.ref, proposalId: 'wire-callers', repetitions: 2, criteria, integrationChecks: { greeting: [{ visibility: 'heldOut', checkId: 'integration' }], checkout: [{ visibility: 'heldOut', checkId: 'integration' }] }, confounds: ['Synthetic worker implements a deterministic response to instruction text.'], preparation: 'UNKNOWN', exposureAttestation: 'Control fixture answers are not inputs to the proposal generator.' } });
  return { ...fixture, analysis, planned };
}

async function replaceRetainedEvidence(root, slotName, text) {
  const experimentRoot = join(root, 'experiment');
  const slotPath = join(experimentRoot, 'run', `${slotName}.json`);
  const slot = JSON.parse(await readFile(slotPath, 'utf8'));
  const invocationPath = join(experimentRoot, slot.invocation.path);
  const invocation = JSON.parse(await readFile(invocationPath, 'utf8'));
  const invocationRoot = join(experimentRoot, 'run', slotName);
  const caseRef = invocation.caseResults[0];
  const casePath = join(invocationRoot, caseRef.path);
  const caseResult = JSON.parse(await readFile(casePath, 'utf8'));
  const artifactPath = join(invocationRoot, caseResult.artifacts.stdout.path);
  const outputPath = join(invocationRoot, caseResult.verifier.heldOut[0].output.ref);
  await writeFile(artifactPath, text);
  await writeFile(outputPath, text);
  caseResult.artifacts.stdout.sha256 = sha256(text);
  caseResult.verifier.heldOut[0].output.sha256 = sha256(text);
  const caseText = `${JSON.stringify(caseResult, null, 2)}\n`;
  await writeFile(casePath, caseText);
  caseRef.sha256 = sha256(caseText);
  const summaryPath = join(invocationRoot, invocation.summary.path);
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const summaryRef = summary.groups.flatMap(({ caseResults }) => caseResults).find(({ path }) => path === caseRef.path);
  assert.ok(summaryRef, `summary must retain ${caseRef.path}`);
  summaryRef.sha256 = caseRef.sha256;
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  await writeFile(summaryPath, summaryText);
  invocation.summary.sha256 = sha256(summaryText);
  const invocationText = `${JSON.stringify(invocation, null, 2)}\n`;
  await writeFile(invocationPath, invocationText);
  slot.invocation.sha256 = sha256(invocationText);
  const slotText = `${JSON.stringify(slot, null, 2)}\n`;
  await writeFile(slotPath, slotText);
  const completePath = join(experimentRoot, 'run', 'complete.json');
  const complete = JSON.parse(await readFile(completePath, 'utf8'));
  const completeRef = complete.slots.find(({ path }) => path === `run/${slotName}.json`);
  assert.ok(completeRef, `completion must retain run/${slotName}.json`);
  completeRef.sha256 = sha256(slotText);
  await writeFile(completePath, `${JSON.stringify(complete, null, 2)}\n`);
  return { artifactPath, outputPath };
}

function reportScore(report) {
  return {
    state: report.state,
    recommendation: report.recommendation,
    partitions: Object.fromEntries(Object.entries(report.partitions).map(([name, value]) => [name, {
      A: value.A, B: value.B, integration: value.integration, completePairs: value.completePairs,
      improved: value.improved, regressed: value.regressed, regressionPairs: value.regressionPairs,
    }])),
  };
}

test('offline A/B retains instructions, executes integration checks, and keeps control/hidden answers out of analysis', async (t) => {
  const fixture = await planned(t);
  assert.equal(fixture.analysis.analysis.proposals[0].status, 'proposed');
  const analysisText = await readFile(join(fixture.root, 'analysis.json'), 'utf8');
  assert.doesNotMatch(analysisText, /HIDDEN_ANSWER_SENTINEL|apply a 10 percent discount|assert.equal\(total/u);
  assert.equal(fixture.analysis.analysis.groups[0].observations.length, 2);
  const plannedOrder = fixture.planned.plan.schedule.map(({ arm }) => arm);
  assert.deepEqual(plannedOrder, ['A', 'B', 'B', 'A']);
  assert.notEqual(fixture.planned.plan.configurations.A.configDigest, fixture.planned.plan.configurations.B.configDigest);
  const proposalReview = await jsonFile(fixture.root, 'proposal-review.json', { note: 'Reviewed as an untested hypothesis only.' });
  const proposed = await createInstructionProfile({ projectRoot: fixture.root, output: 'proposed-profile.json', request: { id: 'proposed-guidance', version: 1, plan: fixture.planned.ref, arm: 'B', review: { by: 'fixture-reviewer', reason: 'Retain untested guidance explicitly.', evidence: proposalReview }, previous: null } });
  assert.equal(proposed.profile.state, 'proposed');
  assert.equal(proposed.profile.provenance.report, 'UNKNOWN');
  const run = await runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(run.stopped, false);
  const { report } = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json', output: 'report.json' });
  assert.equal(report.state, 'tested-improved');
  assert.equal(report.recommendation, 'consider B for the tested configuration');
  for (const value of Object.values(report.partitions)) {
    assert.deepEqual(value.A, { success: 0, failure: 2, unknown: 0, scheduled: 2 });
    assert.deepEqual(value.B, { success: 2, failure: 0, unknown: 0, scheduled: 2 });
    assert.equal(value.meanPairedDifference, 1);
    assert.equal(value.integration.meanPairedDifference, 1);
    assert.equal(value.telemetry.elapsedMs.measuredPairs, 2);
    assert.equal(value.telemetry.repairRounds.meanPairedDifference, 'UNKNOWN');
  }
  assert.ok(report.limitations.some((entry) => entry.includes('SYNTHETIC')));
  await assert.rejects(readFile(join(fixture.root, QUALIFICATION_EVIDENCE_INDEX_PATH)), { code: 'ENOENT' });
  await assert.rejects(runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' }), { code: 'EEXIST' });
  const review = await jsonFile(fixture.root, 'review.json', { reviewer: 'fixture-reviewer', note: 'Synthetic contract review, not a real model recommendation.' });
  const profile = await createInstructionProfile({ projectRoot: fixture.root, output: 'profile-v1.json', request: { id: 'caller-guidance', version: 1, plan: fixture.planned.ref, arm: 'B', review: { by: 'fixture-reviewer', reason: 'Exercise explicit profile publication.', evidence: review }, previous: null } });
  assert.equal(profile.profile.synthetic, true);
  assert.equal(profile.profile.selectedArm, 'B');
  assert.equal(profile.profile.previous, null);
  const rollback = await createInstructionProfile({ projectRoot: fixture.root, output: 'profile-v2.json', request: { id: 'caller-guidance', version: 2, plan: fixture.planned.ref, arm: 'A', review: { by: 'fixture-reviewer', reason: 'Deliberate rollback example.', evidence: review }, previous: profile.ref } });
  assert.equal(rollback.profile.selectedArm, 'A');
  assert.equal(rollback.profile.previous.sha256, profile.ref.sha256);
  await runBenchmark({ ...fixture, projectRoot: fixture.root, outputRoot: join(fixture.root, 'ordinary-benchmark'), repeat: 1, invocationId: 'ordinary-benchmark' });
  const index = JSON.parse(await readFile(join(fixture.root, QUALIFICATION_EVIDENCE_INDEX_PATH), 'utf8'));
  assert.equal(index.entries.length, 1);
  const slotPath = join(fixture.root, 'experiment/run/1-A.json');
  const slotBytes = await readFile(slotPath, 'utf8');
  await writeFile(slotPath, slotBytes.replace('recorded', 'failed'));
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), /digest changed/u);
  await writeFile(slotPath, slotBytes);
  const logPath = join(fixture.root, 'experiment/run/1-B/cases/greeting-repeat-1/verifier-output-held-out-0.txt');
  await writeFile(logPath, 'fabricated green log');
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), /digest changed/u);
});

test('report verification streams large retained artifacts and outputs without changing scores', async (t) => {
  const fixture = await planned(t);
  await runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  const before = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  const largeText = 'x'.repeat(5 * 1024 * 1024);
  await replaceRetainedEvidence(fixture.root, '1-B', largeText);
  const large = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.deepEqual(reportScore(large.report), reportScore(before.report));
});

test('report verification rejects a changed large retained artifact digest', async (t) => {
  const fixture = await planned(t);
  await runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  const largeText = 'x'.repeat(5 * 1024 * 1024);
  const { artifactPath } = await replaceRetainedEvidence(fixture.root, '1-B', largeText);
  await writeFile(artifactPath, 'y'.repeat(largeText.length));
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), /digest changed/u);
});

test('report verification rejects symlinked retained artifacts', async (t) => {
  const fixture = await planned(t);
  await runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  const largeText = 'x'.repeat(5 * 1024 * 1024);
  const { artifactPath } = await replaceRetainedEvidence(fixture.root, '1-B', largeText);
  const symlinkTarget = join(fixture.root, 'large-output-target.txt');
  await writeFile(symlinkTarget, largeText);
  try {
    await unlink(artifactPath);
    await symlink(symlinkTarget, artifactPath);
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), { code: 'SYMLINK_PATH' });
});

test('structural instruction resources remain bounded', async (t) => {
  const fixture = await planned(t);
  await runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  await writeFile(join(fixture.root, 'experiment/run/start.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), /4 MiB/u);
});

test('analysis separates configurations and refuses sparse, contradictory, setup, duplicated and leaked evidence', async (t) => {
  const fixture = await setup(t);
  const request = analysisRequest(fixture.observations, fixture.result.config.configDigest);
  const analyze = (observations, proposals = request.proposals) => analyzeInstructionObservations({ observations, partitions, proposals, preparation: 'UNKNOWN' });
  assert.equal(analyze(fixture.observations).proposals[0].status, 'proposed');
  const sparse = { ...request.proposals[0], evidence: request.proposals[0].evidence.slice(0, 1) };
  assert.equal(analyze(fixture.observations, [sparse]).proposals[0].status, 'inconclusive');
  const unknown = structuredClone(fixture.observations);
  unknown[0].caseResult.outcome = 'setup_error';
  assert.equal(analyze(unknown).proposals[0].status, 'inconclusive');
  assert.throws(() => analyze([...fixture.observations, fixture.observations[0]]), /duplicate observation/u);
  assert.throws(() => analyze(fixture.observations, [{ ...request.proposals[0], evidence: [fixture.observations.find(({ caseResult }) => caseResult.challenge.id === 'checkout').source] }]), /discovery observation/u);
  assert.throws(() => analyze(fixture.observations, [{ ...request.proposals[0], configDigest: 'a'.repeat(64) }]), /mixes configurations/u);
  const alternative = structuredClone(fixture.observations[0]);
  alternative.invocationId = 'other-config';
  alternative.source.path = 'other-config/case.json';
  alternative.caseResult.configIdentity.model.quantization = 'different';
  alternative.caseResult.configDigest = digestJson(alternative.caseResult.configIdentity);
  assert.equal(analyze([...fixture.observations, alternative], []).groups.length, 2);
  const successful = structuredClone(fixture.observations);
  for (const check of [...successful[0].caseResult.verifier.visible, ...successful[0].caseResult.verifier.heldOut]) { check.status = 'passed'; check.exitCode = 0; }
  assert.equal(analyze(successful).proposals[0].status, 'inconclusive');
});

test('partition lineage leakage, duplicate assignments and implicit experiment criteria fail closed', () => {
  assert.throws(() => validateInstructionPartitions([{ ...partitions[0], lineage: 'shared' }, { ...partitions[1], lineage: 'shared' }], ['greeting', 'checkout']), /crosses/u);
  assert.throws(() => validateInstructionPartitions([partitions[0], partitions[0]], ['greeting', 'checkout']), /duplicate/u);
  assert.throws(() => instructionSchedule(1), /integer/u);
  assert.throws(() => reportInstructionPairs({ plan: { criteria: {}, repetitions: 2, partitions, confounds: [] }, outcomes: [] }), /integer/u);
});

test('reports paired regressions, null results, missing pairs and telemetry without counting repetitions as new lineages', async (t) => {
  const fixture = await setup(t);
  const template = summarizeInstructionCase(fixture.observations[0].caseResult);
  const plan = { repetitions: 2, criteria, partitions, confounds: [], synthetic: true };
  const outcomes = partitions.flatMap(({ challengeId }) => instructionSchedule(2).map(({ arm, repetition }) => ({ ...structuredClone(template), challengeId, arm, repetition, quality: arm === 'A' })));
  let report = reportInstructionPairs({ plan, outcomes });
  assert.equal(report.state, 'regressed');
  assert.equal(report.recommendation, 'keep A');
  assert.equal(report.partitions.discovery.regressed, 2);
  assert.equal(report.partitions.discovery.uncertainty.lineages.length, 1);
  report = reportInstructionPairs({ plan, outcomes: outcomes.map((entry) => ({ ...entry, quality: true })) });
  assert.equal(report.state, 'no-improvement');
  report = reportInstructionPairs({ plan, outcomes: outcomes.map((entry) => ({ ...entry, quality: 'UNKNOWN' })) });
  assert.equal(report.state, 'inconclusive');
  assert.equal(report.partitions.control.A.unknown, 2);
  report = reportInstructionPairs({ plan, outcomes: [] });
  assert.equal(report.partitions.control.completePairs, 0);
  assert.equal(report.partitions.control.telemetry.totalTokens.A, 'UNKNOWN');
  const missingUsage = structuredClone(fixture.observations[0].caseResult);
  missingUsage.observed.usage = null;
  missingUsage.observed.cumulativeUsage = { input: 0, output: 0, totalTokens: 0 };
  assert.equal(summarizeInstructionCase(missingUsage).telemetry.totalTokens, 'UNKNOWN');
  missingUsage.observed.usage = { input: 10 };
  assert.equal(summarizeInstructionCase(missingUsage).telemetry.outputTokens, 'UNKNOWN');
  missingUsage.observed.cumulativeUsage.assistantMessages = 2;
  assert.equal(summarizeInstructionCase(missingUsage).telemetry.inputTokens, 'UNKNOWN');
  assert.equal(summarizeInstructionCase(missingUsage).integration, 'UNKNOWN');
  const knownScopeFailure = structuredClone(missingUsage);
  knownScopeFailure.outcome = 'unavailable';
  knownScopeFailure.hardGates.outOfScopeEdit = true;
  assert.equal(summarizeInstructionCase(knownScopeFailure).quality, false);
  assert.throws(() => reportInstructionPairs({ plan, outcomes: [...outcomes, outcomes[0]] }), /duplicate/u);
});

test('frozen suite and runtime drift cannot produce a favorable report', async (t) => {
  const fixture = await planned(t);
  const changedWorker = { ...fixture.worker, limits: { ...fixture.worker.limits, maxToolCalls: 11 } };
  const run = await runInstructionExperiment({ ...fixture, worker: changedWorker, projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(run.stopped, true);
  const { report } = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(report.state, 'inconclusive');
  assert.equal(report.slots[0].status, 'failed');
  assert.equal(report.slots[1].status, 'not_run');
  await writeFile(join(fixture.root, 'experiment/suite/fixtures/greeting/src/index.mjs'), 'changed');
  await assert.rejects(readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' }), /frozen suite bytes changed/u);
});

test('CLI analysis and report keep JSON stdout singular and reject unknown flags', async (t) => {
  const fixture = await setup(t);
  await jsonFile(fixture.root, 'request.json', analysisRequest(fixture.observations, fixture.result.config.configDigest));
  const cli = new URL('bin/tinysdd.mjs', rootUrl).pathname;
  const result = await execFileAsync(process.execPath, [cli, '--json', '--project', fixture.root, 'bench', 'instructions', 'analyze', '--request', 'request.json', '--out', 'analysis.json']);
  assert.equal(JSON.parse(result.stdout).data.analysis.proposals[0].status, 'proposed');
  await assert.rejects(execFileAsync(process.execPath, [cli, '--json', '--project', fixture.root, 'bench', 'instructions', 'analyze', '--network']), (error) => JSON.parse(error.stdout).ok === false);
});

test('an integration regression cannot hide behind an existing correctness failure', () => {
  const plan = { repetitions: 2, criteria: { ...criteria, minQualityGain: 0.1 }, partitions, confounds: [], synthetic: true };
  const telemetry = Object.fromEntries(['elapsedMs', 'repairRounds', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'].map((name) => [name, 'UNKNOWN']));
  const outcomes = partitions.flatMap(({ challengeId }) => instructionSchedule(2).map(({ arm, repetition }) => ({
    challengeId, arm, repetition, telemetry,
    quality: repetition === 2 && arm === 'B',
    integration: repetition === 1 ? arm === 'A' : arm === 'B',
  })));
  const report = reportInstructionPairs({ plan, outcomes });
  assert.equal(report.state, 'regressed');
  assert.equal(report.recommendation, 'keep A');
  for (const value of Object.values(report.partitions)) {
    assert.equal(value.meanPairedDifference, 0.5);
    assert.equal(value.regressed, 0);
    assert.equal(value.integration.regressed, 1);
    assert.equal(value.regressionPairs, 1);
  }
  const overlapping = outcomes.map((entry) => entry.repetition === 1 && entry.arm === 'A' ? { ...entry, quality: true } : entry);
  const countedOnce = reportInstructionPairs({ plan, outcomes: overlapping });
  assert.equal(countedOnce.partitions.discovery.regressed, 1);
  assert.equal(countedOnce.partitions.discovery.integration.regressed, 1);
  assert.equal(countedOnce.partitions.discovery.regressionPairs, 1);
});


test('A/B settings require both frozen confirmations and named acknowledgements before artifacts or inference', async (t) => {
  const fixture = await planned(t, { entryKind: 'synthetic' });
  const snapshots = fixture.planned.plan.effectiveModelSettings;
  assert.ok(snapshots, 'plan must retain both effective-settings reports');
  assert.equal(snapshots.A.settings.entryKind, 'synthetic');
  assert.equal(snapshots.B.settings.maxTokens, 512);
  assert.ok(snapshots.B.findings.some(({ code }) => code === 'THINKING_CONTROL_MISMATCH'));
  const confirmation = Object.fromEntries(['A', 'B'].map((arm) => [arm, {
    entryKind: 'synthetic', settingsDigest: snapshots[arm].settingsDigest,
    acknowledgedFindings: ['THINKING_CONTROL_MISMATCH'],
  }]));
  const run = (value) => runInstructionExperiment({ ...fixture, projectRoot: fixture.root, planPath: 'experiment/plan.json', confirmation: value });
  const absentRun = () => assert.rejects(readFile(join(fixture.root, 'experiment/run/start.json')), { code: 'ENOENT' });
  await assert.rejects(run(), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await absentRun();
  await assert.rejects(run({ A: confirmation.A }), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await absentRun();
  await assert.rejects(run({ ...confirmation, B: { ...confirmation.B, acknowledgedFindings: [] } }), { code: 'MODEL_SETTINGS_FINDING_ACKNOWLEDGEMENT_REQUIRED' });
  await absentRun();
  await assert.rejects(run({ ...confirmation, B: { ...confirmation.B, settingsDigest: 'stale' } }), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await absentRun();
  await assert.rejects(run({ ...confirmation, B: { ...confirmation.B, entryKind: 'real' } }), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await absentRun();
  const modelPath = join(fixture.runtime.sourceAgentDir, 'models.json');
  const originalModels = await readFile(modelPath, 'utf8');
  const changedModels = JSON.parse(originalModels);
  changedModels.providers.fake.models[0].maxTokens = 1024;
  await writeFile(modelPath, JSON.stringify(changedModels));
  await assert.rejects(run(confirmation), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await absentRun();
  await writeFile(modelPath, originalModels);
  assert.equal((await run(confirmation)).stopped, false);
  const start = JSON.parse(await readFile(join(fixture.root, 'experiment/run/start.json'), 'utf8'));
  assert.deepEqual(start.confirmation, confirmation);
  assert.deepEqual(start.effectiveModelSettings, snapshots);
  for (const slot of fixture.planned.plan.schedule) {
    const retained = JSON.parse(await readFile(join(fixture.root, `experiment/run/${slot.repetition}-${slot.arm}/model-settings.json`), 'utf8'));
    assert.equal(retained.settingsDigest, snapshots[slot.arm].settingsDigest);
    assert.deepEqual(retained.acknowledgedFindings, ['THINKING_CONTROL_MISMATCH']);
    assert.equal(retained.settings.entryKind, 'synthetic');
  }
  const { report } = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(report.state, 'tested-improved');
});


test('settings drift after an A invocation stops B and retains the failed and unrun slots', async (t) => {
  const fixture = await planned(t, { entryKind: 'synthetic' });
  const confirmation = Object.fromEntries(['A', 'B'].map((arm) => [arm, {
    entryKind: 'synthetic', settingsDigest: fixture.planned.plan.effectiveModelSettings[arm].settingsDigest,
    acknowledgedFindings: ['THINKING_CONTROL_MISMATCH'],
  }]));
  let checksCompleted = 0;
  const verifier = async (input) => {
    const result = await fixture.verifier(input);
    checksCompleted += 1;
    if (checksCompleted === 4) {
      const path = join(fixture.runtime.sourceAgentDir, 'models.json');
      const models = JSON.parse(await readFile(path, 'utf8'));
      models.providers.fake.models[0].maxTokens = 1024;
      await writeFile(path, JSON.stringify(models));
    }
    return result;
  };
  const run = await runInstructionExperiment({ ...fixture, verifier, projectRoot: fixture.root, planPath: 'experiment/plan.json', confirmation });
  assert.equal(run.stopped, true);
  const { report } = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(report.state, 'inconclusive');
  assert.deepEqual(report.slots.map(({ status }) => status), ['recorded', 'failed', 'not_run', 'not_run']);
  await assert.rejects(readFile(join(fixture.root, 'experiment/run/1-B/invocation.json')), { code: 'ENOENT' });
});

test('mid-invocation settings drift retains readable incomplete evidence and prevents qualification', async (t) => {
  const fixture = await planned(t, { entryKind: 'synthetic' });
  const confirmation = Object.fromEntries(['A', 'B'].map((arm) => [arm, {
    entryKind: 'synthetic', settingsDigest: fixture.planned.plan.effectiveModelSettings[arm].settingsDigest,
    acknowledgedFindings: ['THINKING_CONTROL_MISMATCH'],
  }]));
  const verifierCalls = [];
  const verifier = async (input) => {
    const result = await fixture.verifier(input);
    verifierCalls.push(input.visibility);
    if (verifierCalls.length === 2) {
      const path = join(fixture.runtime.sourceAgentDir, 'models.json');
      const models = JSON.parse(await readFile(path, 'utf8'));
      models.providers.fake.models[0].maxTokens = 1024;
      await writeFile(path, JSON.stringify(models));
    }
    return result;
  };
  const run = await runInstructionExperiment({ ...fixture, verifier, projectRoot: fixture.root, planPath: 'experiment/plan.json', confirmation });
  assert.equal(run.stopped, true);
  assert.deepEqual(verifierCalls, ['visible', 'held-out']);
  const { report } = await readInstructionReport({ projectRoot: fixture.root, planPath: 'experiment/plan.json' });
  assert.equal(report.state, 'inconclusive');
  assert.deepEqual(report.slots.map(({ status }) => status), ['recorded', 'failed', 'not_run', 'not_run']);

  const evidence = await readQualificationEvidence({ projectRoot: join(fixture.root, 'experiment'), suitePath: fixture.planned.plan.suitePath, results: ['run/1-A/invocation.json'] });
  assert.equal(evidence.observations.length, 2);
  const completed = evidence.observations.find(({ caseResult }) => caseResult.challenge.id === 'greeting');
  assert.equal(completed.caseResult.outcome, 'failed');
  for (const [visibility, records] of Object.entries({
    visible: completed.caseResult.verifier.visible,
    heldOut: completed.caseResult.verifier.heldOut,
  })) {
    assert.deepEqual(records.map(({ status }) => status), ['failed']);
    const outputVisibility = visibility === 'heldOut' ? 'held-out' : visibility;
    assert.equal(records[0].output.ref, `cases/greeting-repeat-1/verifier-output-${outputVisibility}-0.txt`);
    assert.match(records[0].output.sha256, /^[0-9a-f]{64}$/u);
  }
  const incomplete = evidence.observations.find(({ caseResult }) => caseResult.challenge.id === 'checkout');
  assert.equal(incomplete.caseResult.outcome, 'setup_error');
  assert.deepEqual(incomplete.caseResult.verifier.visible.map(({ status }) => status), ['not_run']);
  assert.deepEqual(incomplete.caseResult.verifier.heldOut.map(({ status }) => status), ['not_run']);
  const qualification = buildQualificationRecord({
    observations: evidence.observations,
    source: evidence.source,
    roster: evidence.roster,
    configIdentity: evidence.configIdentity,
    configDigest: evidence.configDigest,
    suite: evidence.suite,
  });
  assert.equal(qualification.roles['implement-slice'].passes, 0);
  assert.equal(qualification.roles['implement-slice'].status, 'not_qualified');
});
