import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, symlink, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runFixture, makeWorkerRuntime } from './helpers/slice-review-fixture.mjs';
import { sha256, withExclusiveLock } from '../src/fs-utils.mjs';
import {
  activeTestReviewPolicy, assessSliceTests, checkSliceTests, classifySliceTestObservations,
  reviewSliceTests, sliceTestReviewStatus, exportSliceTestReviewDataset, prepareSliceTestOperatorRevision, publishSliceTestOperatorRevision, withSliceTestWorkerGate, SLICE_TEST_REVIEW_TEST_ENV, SLICE_TEST_REVIEW_FAILURE_ENV,
} from '../src/slice-test-review-workflow.mjs';
import { acceptFeature, controllerStatus, applyTask, dispatchWorker, reviewTask } from '../src/controller.mjs';
import { validateTestReviewPolicy } from '../src/phase-gates.mjs';
import { reportSliceTestReviews } from '../src/slice-test-review-report.mjs';
import { readSliceTestReviewEvents } from '../src/slice-test-review.mjs';

process.env[SLICE_TEST_REVIEW_TEST_ENV] = '1';
process.env.TINYSDD_WORKER_TEST = '1';
const policy = { positiveThreshold: 0.8, negativeThreshold: 0.2, revisionLimit: 2, uncertainRoute: 'escalation', unavailableRoute: 'unavailable' };

async function fixture(overrides = {}, options = {}) {
  const result = await runFixture(options);
  const path = join(result.root, '.tinysdd/config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.testReview = { ...policy, ...overrides };
  config.workers.fake = { type: 'pi', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 5000, maxToolCalls: 4 } };
  config.defaultWorker = 'fake';
  await writeFile(path, JSON.stringify(config));
  await mkdir(join(result.root, '.tinysdd/reviews'), { recursive: true });
  await writeFile(join(result.root, '.tinysdd/reviews/strong.md'), 'Reviewed exact candidate requirements, interfaces and tests.\n');
  return result;
}

function provider(probability, extra = {}) {
  return { id: 'jev-fixture', endpoint: 'https://example.invalid/v1', model: 'fixture-judge', configSha256: sha256('offline-config'),
    fetch: async () => new Response(JSON.stringify({ answers: { 'criterion-one': { noul: probability } }, usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } })), ...extra };
}

function assessment(f, probability, overrides = {}) {
  return assessSliceTests(f.root, { id: 'slice-one', run: 'worker-one', change: f.changePath,
    implementer: 'fixture-worker', producer: 'fixture-jev', providerConfig: provider(probability), credential: 'offline-stub', ...overrides });
}

const passingRunner = async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'synthetic check', truncated: false } });

function strongReview(f, event, overrides = {}) {
  return reviewSliceTests(f.root, { id: 'slice-one', eventId: event.eventId, inputDigest: event.inputDigest,
    reviewer: 'fixture-frontier', strength: 'strong', attested: true, verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', ...overrides });
}

test('active policy requires both thresholds and preserves legacy pure policy documents', () => {
  const { negativeThreshold, ...legacy } = policy;
  assert.deepEqual(validateTestReviewPolicy(legacy), legacy);
  assert.throws(() => activeTestReviewPolicy(legacy), { code: 'TEST_REVIEW_POLICY_MISSING' });
  assert.throws(() => activeTestReviewPolicy({ ...policy, uncertainRoute: 'revision' }), { code: 'TEST_REVIEW_POLICY_INVALID' });
  const envelope = { criteria: [{ id: 'a', type: 'slice-test-adequacy' }, { id: 'b', type: 'slice-test-adequacy' }], questions: { a: { instruction: 'A' }, b: { instruction: 'B' } } };
  const observations = (a, b) => [{ criterionId: 'a', criterionType: 'slice-test-adequacy', question: 'A', probability: a }, { criterionId: 'b', criterionType: 'slice-test-adequacy', question: 'B', probability: b }];
  assert.equal(classifySliceTestObservations(envelope, observations(0.8, 1), policy).verdict, 'positive');
  assert.equal(classifySliceTestObservations(envelope, observations(0.9, 0.1), policy).verdict, 'negative');
  assert.equal(classifySliceTestObservations(envelope, observations(0.8, 0.2), policy).verdict, 'uncertain');
  assert.throws(() => classifySliceTestObservations(envelope, observations(0.9, 0.9).slice(1), policy), { code: 'TEST_REVIEW_ASSESSMENT_INVALID' });
});

test('positive waits for exact-byte independent checks and strong review before explicit apply and acceptance', async () => {
  const f = await fixture();
  try {
    await assert.rejects(applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_REQUIRED' });
    const positive = await assessment(f, 0.95);
    assert.equal(positive.route, 'independent-review');
    await assert.rejects(strongReview(f, positive), { code: 'TEST_REVIEW_CHECKS_REQUIRED' });
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await assert.rejects(strongReview(f, checks, { reviewer: 'fixture-worker' }), { code: 'TEST_REVIEW_NOT_INDEPENDENT' });
    await assert.rejects(strongReview(f, checks, { reviewer: 'fixture-jev' }), { code: 'TEST_REVIEW_NOT_INDEPENDENT' });
    await assert.rejects(strongReview(f, checks, { inputDigest: sha256('different') }), { code: 'TEST_REVIEW_INPUT_MISMATCH' });
    const review = await strongReview(f, checks, { reviewUsage: { inputTokens: 100, outputTokens: 20 } });
    const report = await reportSliceTestReviews(f.root);
    assert.equal(report.positiveReviewCoverage.denominator, 1);
    assert.equal(report.frontierReviewUsage[0].measurements.inputTokens, 100);
    assert.equal(report.frontierReviewUsage[0].measurements.totalTokens, 'UNKNOWN');
    assert.equal(report.frontierReviewUsage[0].provenance, 'caller-declared');
    assert.equal(report.liveAssessments, 0);
    assert.equal(review.route, 'operator-acceptance');
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).approved, false);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    const accepted = await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal(accepted.task.status, 'accepted');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('uncertainty escalates to strong review and provider failures never approve', async () => {
  const f = await fixture();
  const unavailable = await fixture();
  try {
    const uncertain = await assessment(f, 0.5);
    assert.equal(uncertain.route, 'escalation');
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: uncertain.eventId, runner: passingRunner });
    assert.equal((await strongReview(f, checks)).route, 'operator-acceptance');
    const failure = await assessment(unavailable, 0.9, { providerConfig: provider(0.9, { fetch: async () => { throw new Error('private provider material'); } }) });
    assert.equal(failure.route, 'unavailable');
    assert.equal(failure.assessment.verdict, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(await readSliceTestReviewEvents(unavailable.root)), /private provider material|offline-stub/);
    await assert.rejects(applyTask(unavailable.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_REQUIRED' });
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(unavailable.root, { recursive: true, force: true }); }
});

test('malformed answers retain failure and policy changes invalidate review use', async () => {
  const malformed = await fixture();
  const f = await fixture();
  try {
    const failure = await assessment(malformed, 0.9, { providerConfig: provider(0.9, { fetch: async () => new Response('{}') }) });
    assert.equal(failure.assessment.status, 'malformed');
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    const configPath = join(f.root, '.tinysdd/config.json');
    const config = JSON.parse(await readFile(configPath));
    config.testReview.positiveThreshold = 0.95;
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_POLICY_STALE' });
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(malformed.root, { recursive: true, force: true }); }
});

test('negative assessment drives a real fake-worker revision, restart preserves the budget, and rejection escalates at the cap', async () => {
  const f = await fixture({ revisionLimit: 1 });
  const runtime = await makeWorkerRuntime();
  try {
    const negative = await assessment(f, 0.1);
    assert.equal(negative.route, 'revision');
    await assert.rejects(dispatchWorker(f.root, { taskId: 'slice-one', runtime: runtime.runtime }), { code: 'TEST_REVIEW_REVISION_LINEAGE' });
    const run = await dispatchWorker(f.root, { taskId: 'slice-one', baseRunId: 'worker-one', runtime: runtime.runtime });
    assert.equal(run.outcome, 'completed');
    const status = await sliceTestReviewStatus(f.root, { id: 'slice-one' });
    assert.equal(status.route, 'assessment-required');
    assert.equal(status.revision, 1);
    const positive = await assessment(f, 0.95, { run: run.runId });
    assert.equal(positive.identity.revision, 1);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    const rejected = await strongReview(f, checks, { verdict: 'rejected' });
    assert.equal(rejected.route, 'escalation');
    await assert.rejects(dispatchWorker(f.root, { taskId: 'slice-one', baseRunId: run.runId, runtime: runtime.runtime }), { code: 'TEST_REVIEW_ROUTE_BLOCKED' });
    await assert.rejects(assessment(f, 0.9, { run: 'worker-unrelated' }), { code: 'TEST_REVIEW_ROUTE_BLOCKED' });
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(runtime.root, { recursive: true, force: true }); }
});

test('worker revision releases the workflow lock while the worker is pending and finalizes once', async () => {
  const f = await fixture();
  try {
    await assessment(f, 0.1);
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const worker = withSliceTestWorkerGate(f.root, { taskId: 'slice-one', baseRunId: 'worker-one' }, async () => {
      entered();
      await pending;
      return { outcome: 'completed', runId: 'worker-two' };
    });
    await enteredPromise;
    let contenderRan = false;
    await withExclusiveLock(join(f.root, '.tinysdd/runs/slice-test-review/workflow.lock'), async () => { contenderRan = true; });
    assert.equal(contenderRan, true);
    release();
    await worker;
    const events = await readSliceTestReviewEvents(f.root);
    assert.equal(events.filter((event) => event.eventType === 'revision-dispatched').length, 1);
    assert.equal(events.filter((event) => event.eventType === 'revision-candidate').length, 1);
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).revision, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('worker gate leaves an initial candidate without a review history unchanged', async () => {
  const f = await fixture();
  try {
    const result = await withSliceTestWorkerGate(f.root, { taskId: 'slice-one', baseRunId: 'worker-one' }, async () => ({ outcome: 'completed', runId: 'worker-one' }));
    assert.deepEqual(result, { outcome: 'completed', runId: 'worker-one' });
    assert.equal((await readSliceTestReviewEvents(f.root)).length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('changed review evidence, candidate bytes and retained-input symlinks are refused', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.95);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await writeFile(join(f.root, '.tinysdd/reviews/strong.md'), 'changed review');
    await assert.rejects(applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_INPUT_STALE' });
    const inputs = join(f.root, '.tinysdd/runs/slice-test-review/inputs');
    const source = join(inputs, `${positive.envelopeDigest}.json`);
    const backup = join(f.root, 'input-copy.json');
    await cp(source, backup);
    await rm(source);
    await symlink(backup, source);
    await assert.rejects(sliceTestReviewStatus(f.root, { id: 'slice-one' }), { code: 'SYMLINK_PATH' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('negative -> worker revision -> positive -> strong review applies only the final reviewed lineage and exports reproducible labels', async () => {
  const f = await fixture();
  const runtime = await makeWorkerRuntime();
  try {
    await assessment(f, 0.1);
    const run = await dispatchWorker(f.root, { taskId: 'slice-one', baseRunId: 'worker-one', runtime: runtime.runtime });
    const positive = await assessment(f, 0.9, { run: run.runId });
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: async ({ candidateDir, check }) => {
      await execFileAsync(process.execPath, check.argv.slice(1), { cwd: candidateDir });
      return passingRunner();
    } });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: run.runId, by: 'operator' });
    assert.equal((await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' })).task.status, 'accepted');
    const dataset = await exportSliceTestReviewDataset(f.root, { partition: 'test' });
    assert.equal(dataset.cases.length, 1);
    assert.equal(dataset.cases[0].synthetic, true);
    assert.equal(dataset.cases[0].expected.label, true);
    assert.deepEqual(await exportSliceTestReviewDataset(f.root, { partition: 'test' }), dataset);
    const { validateDecisionDatasetEvidence } = await import('../src/decision-dataset.mjs');
    await validateDecisionDatasetEvidence(f.root, dataset);
    await writeFile(join(f.root, '.tinysdd/reviews/strong.md'), 'modified independent review');
    assert.equal((await controllerStatus(f.root)).tasks[0].status, 'stale');
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(runtime.root, { recursive: true, force: true }); }
});

test('green slice tests and strong attestation cannot accept disconnected code through the real entrypoint', async () => {
  process.env.TINYSDD_FEATURE_INTEGRATION_TEST = '1';
  const f = await fixture({}, { integration: true });
  try {
    const configPath = join(f.root, '.tinysdd/config.json');
    const config = JSON.parse(await readFile(configPath));
    config.featureIntegration = { argv: ['node', 'tests/protected.test.mjs'], testPaths: ['tests/protected.test.mjs'], entrypoints: ['src/entry.mjs'] };
    await writeFile(configPath, JSON.stringify(config));
    const runner = async ({ candidateDir, check }) => {
      try {
        await execFileAsync(process.execPath, check?.argv.slice(1) ?? ['tests/protected.test.mjs'], { cwd: candidateDir });
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      } catch (error) { return { exitCode: error.code, signal: null, timedOut: false, durationMs: 1 }; }
    };
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner });
    assert.equal(checks.workflow.checkEvidence.passed, true);
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    await assert.rejects(acceptFeature(f.root, { feature: 'change-one', by: 'operator', reason: 'try acceptance', integrationRunner: runner }), { code: 'FEATURE_INTEGRATION_FAILED' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).route, 'revision');
    const runtime = await makeWorkerRuntime();
    try {
      const run = await dispatchWorker(f.root, { taskId: 'slice-one', runtime: runtime.runtime });
      assert.equal(run.outcome, 'completed');
      const next = await assessment(f, 0.9, { run: run.runId });
      assert.equal(next.workflow.revision, 1);
    } finally { await rm(runtime.root, { recursive: true, force: true }); }
  } finally { delete process.env.TINYSDD_FEATURE_INTEGRATION_TEST; await rm(f.root, { recursive: true, force: true }); }
});

test('CLI status and explicit review argument errors print one JSON object', async () => {
  const f = await fixture();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/tinysdd.mjs', '--json', '--project', f.root, 'slice-tests', 'status', '--id', 'slice-one']);
    assert.equal(JSON.parse(stdout).data.route, 'assessment-required');
    assert.equal(stderr, '');
    await assert.rejects(execFileAsync(process.execPath, ['bin/tinysdd.mjs', '--json', '--project', f.root, 'slice-tests', 'review', '--id', 'slice-one']), (error) => {
      const output = JSON.parse(error.stdout);
      return output.ok === false && error.stdout.trim().split('\n').length === 1;
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('independent checks use frozen dependencies and refuse changed dependency evidence before apply', async () => {
  const f = await fixture({}, { dependencies: true });
  try {
    const positive = await assessment(f, 0.9);
    const checked = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: async ({ dependencyMounts }) => {
      assert.equal(dependencyMounts.length, 1);
      assert.notEqual(dependencyMounts[0].source, join(f.root, 'vendor'));
      assert.equal(await readFile(join(dependencyMounts[0].source, 'helper.mjs'), 'utf8'), 'export const dependency = true;\n');
      return passingRunner();
    } });
    assert.equal(checked.workflow.checkEvidence.passed, true);
    await strongReview(f, checked);
    await writeFile(join(f.root, 'vendor/helper.mjs'), 'export const dependency = false;\n');
    await assert.rejects(applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_INPUT_STALE' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy projects without review policy keep their approval contract and synthetic checks cannot verify a real candidate', async () => {
  const legacy = await runFixture();
  const f = await fixture();
  try {
    await mkdir(join(legacy.root, '.tinysdd/reviews'), { recursive: true });
    await writeFile(join(legacy.root, '.tinysdd/reviews/legacy.md'), 'Legacy operator review.');
    await applyTask(legacy.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    assert.equal((await reviewTask(legacy.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/legacy.md', by: 'operator' })).task.status, 'accepted');
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    delete process.env[SLICE_TEST_REVIEW_TEST_ENV];
    await assert.rejects(applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' }), { code: 'TEST_REVIEW_SYNTHETIC' });
  } finally { process.env[SLICE_TEST_REVIEW_TEST_ENV] = '1'; await rm(legacy.root, { recursive: true, force: true }); await rm(f.root, { recursive: true, force: true }); }
});

test('legacy testReview policies retain controller apply, acceptance and operator revision behavior', async () => {
  const f = await runFixture();
  try {
    const configPath = join(f.root, '.tinysdd/config.json');
    const config = JSON.parse(await readFile(configPath));
    config.testReview = { positiveThreshold: 0.8, revisionLimit: 2, uncertainRoute: 'escalation', unavailableRoute: 'unavailable' };
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(join(f.root, '.tinysdd/reviews'), { recursive: true });
    await writeFile(join(f.root, '.tinysdd/reviews/legacy.md'), 'Legacy operator review.\n');
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    assert.equal((await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/legacy.md', by: 'operator' })).task.status, 'accepted');
    await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/legacy.md', by: 'operator' });
    assert.equal((await controllerStatus(f.root)).tasks[0].status, 'ready');
    assert.equal((await readSliceTestReviewEvents(f.root)).length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('accepted slice-test bindings become stale when their applied run evidence is missing', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    const statePath = join(f.root, '.tinysdd/runs/controller.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    delete state.tasks['slice-one'].applied;
    await writeFile(statePath, JSON.stringify(state));
    assert.equal((await controllerStatus(f.root)).tasks[0].status, 'stale');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unexpected freshness configuration errors remain visible to controller status', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    const configPath = join(f.root, '.tinysdd/config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.testReview.revisionLimit = 0;
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(controllerStatus(f.root), { code: 'CONFIG_INVALID' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an uncommitted operator revision intent cannot publish a ledger transition', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    await prepareSliceTestOperatorRevision(f.root, { id: 'slice-one', run: 'worker-one' });
    assert.equal(await publishSliceTestOperatorRevision(f.root, { id: 'slice-one', run: 'worker-one' }), null);
    assert.equal((await readSliceTestReviewEvents(f.root)).filter((event) => event.eventType === 'operator-revision').length, 0);
    await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal((await readSliceTestReviewEvents(f.root)).filter((event) => event.eventType === 'operator-revision').length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('controller-save failure leaves the accepted state and inert intent for a safe retry', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    process.env.TINYSDD_SLICE_TEST_REVIEW_FAIL_CONTROLLER_SAVE = '1';
    await assert.rejects(reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' }), { code: 'WRITE_FAILED' });
    const state = JSON.parse(await readFile(join(f.root, '.tinysdd/runs/controller.json'), 'utf8'));
    assert.equal(state.tasks['slice-one'].review.verdict, 'accepted');
    assert.equal(state.tasks['slice-one'].applied.runId, 'worker-one');
    assert.equal((await readSliceTestReviewEvents(f.root)).filter((event) => event.eventType === 'operator-revision').length, 0);
    const retried = await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal(retried.task.status, 'ready');
    const events = await readSliceTestReviewEvents(f.root);
    assert.equal(events.filter((event) => event.eventType === 'operator-revision').length, 1);
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).route, 'revision');
  } finally { delete process.env.TINYSDD_SLICE_TEST_REVIEW_FAIL_CONTROLLER_SAVE; await rm(f.root, { recursive: true, force: true }); }
});

test('operator revision publication can be retried after the controller state commits', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    process.env[SLICE_TEST_REVIEW_FAILURE_ENV] = 'before-ledger';
    await assert.rejects(reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' }), { code: 'TEST_REVIEW_INJECTED_FAILURE' });
    const state = JSON.parse(await readFile(join(f.root, '.tinysdd/runs/controller.json'), 'utf8'));
    assert.equal(state.tasks['slice-one'].review.verdict, 'revision');
    assert.equal(state.tasks['slice-one'].applied, undefined);
    assert.equal((await readSliceTestReviewEvents(f.root)).filter((event) => event.eventType === 'operator-revision').length, 0);
    const retried = await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal(retried.task.status, 'ready');
    const events = await readSliceTestReviewEvents(f.root);
    assert.equal(events.filter((event) => event.eventType === 'operator-revision').length, 1);
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).route, 'revision');
  } finally { delete process.env[SLICE_TEST_REVIEW_FAILURE_ENV]; await rm(f.root, { recursive: true, force: true }); }
});

test('operator revision repairs an appended ledger event when immutable publication fails', async () => {
  const f = await fixture();
  try {
    const positive = await assessment(f, 0.9);
    const checks = await checkSliceTests(f.root, { id: 'slice-one', eventId: positive.eventId, runner: passingRunner });
    await strongReview(f, checks);
    await applyTask(f.root, { id: 'slice-one', run: 'worker-one', by: 'operator' });
    await reviewTask(f.root, { id: 'slice-one', verdict: 'accepted', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    process.env[SLICE_TEST_REVIEW_FAILURE_ENV] = 'record-before-link';
    await assert.rejects(reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' }), { code: 'TEST_REVIEW_INJECTED_FAILURE' });
    const state = JSON.parse(await readFile(join(f.root, '.tinysdd/runs/controller.json'), 'utf8'));
    assert.equal(state.tasks['slice-one'].review.verdict, 'revision');
    assert.equal(state.tasks['slice-one'].applied, undefined);
    const eventsAfterFailure = await readSliceTestReviewEvents(f.root);
    const operatorEvent = eventsAfterFailure.find((event) => event.eventType === 'operator-revision');
    assert.ok(operatorEvent);
    await assert.rejects(readFile(join(f.root, '.tinysdd/runs/slice-test-review/records', `${operatorEvent.eventId}.json`)));
    assert.equal((await readdir(join(f.root, '.tinysdd/runs/slice-test-review/records'))).some((name) => name.endsWith('.tmp')), false);
    const retried = await reviewTask(f.root, { id: 'slice-one', verdict: 'revision', evidence: '.tinysdd/reviews/strong.md', by: 'operator' });
    assert.equal(retried.task.status, 'ready');
    const events = await readSliceTestReviewEvents(f.root);
    assert.equal(events.filter((event) => event.eventType === 'operator-revision').length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, '.tinysdd/runs/slice-test-review/records', `${operatorEvent.eventId}.json`))), operatorEvent);
    assert.equal((await sliceTestReviewStatus(f.root, { id: 'slice-one' })).route, 'revision');
  } finally { delete process.env[SLICE_TEST_REVIEW_FAILURE_ENV]; await rm(f.root, { recursive: true, force: true }); }
});
