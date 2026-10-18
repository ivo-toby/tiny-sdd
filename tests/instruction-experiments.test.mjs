import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { QUALIFICATION_EVIDENCE_INDEX_PATH } from '../src/qualification-store.mjs';
import { runBenchmark } from '../src/benchmark-runner.mjs';
import { digestJson } from '../src/fs-utils.mjs';
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

async function planned(t) {
  const fixture = await setup(t);
  const request = analysisRequest(fixture.observations, fixture.result.config.configDigest);
  const analysis = await analyzeInstructionEvidence({ projectRoot: fixture.root, request, output: 'analysis.json' });
  const planned = await planInstructionExperiment({ ...fixture, projectRoot: fixture.root, output: 'experiment', request: { id: 'caller-pilot', analysis: analysis.ref, proposalId: 'wire-callers', repetitions: 2, criteria, integrationChecks: { greeting: [{ visibility: 'heldOut', checkId: 'integration' }], checkout: [{ visibility: 'heldOut', checkId: 'integration' }] }, confounds: ['Synthetic worker implements a deterministic response to instruction text.'], preparation: 'UNKNOWN', exposureAttestation: 'Control fixture answers are not inputs to the proposal generator.' } });
  return { ...fixture, analysis, planned };
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
