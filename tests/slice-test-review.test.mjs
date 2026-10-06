import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  appendSliceTestReviewEvents,
  captureSliceTestReviewEnvelope,
  createSliceTestReviewEnvelope,
  createSliceTestReviewEvent,
  readSliceTestReviewEvents,
  validateSliceTestReviewEnvelope,
  validateSliceTestReviewEvent,
} from '../src/slice-test-review.mjs';
import { sha256 } from '../src/fs-utils.mjs';
import { validateChange } from '../src/change-format.mjs';
import { addTask, approveTask, initProject, resolveTaskPacket, updateTask } from '../src/controller.mjs';
import { runWorker } from '../src/worker.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const digest = (value) => sha256(value);

function criterion() {
  return {
    id: 'criterion-one',
    type: 'slice-test-adequacy',
    question: 'The slice test checks the approved behavior through the declared interface.',
    requirementIds: ['requirement-one'],
    interfaces: ['src/entry.mjs'],
    testPaths: ['tests/slice.test.mjs'],
  };
}

function envelope(overrides = {}) {
  const bytes = Buffer.from('candidate bytes\n');
  const approvalDigest = digest('approval');
  return createSliceTestReviewEnvelope({
    identity: {
      featureId: 'change-one',
      taskId: 'task-one',
      sliceId: 'slice-one',
      runId: 'worker-one',
      rootRunId: 'worker-one',
      lineageId: 'lineage-one',
      revision: 0,
    },
    approval: {
      approvalDigest,
      briefDigest: digest('brief'),
      contextDigest: null,
      checksDigest: null,
      preparationDigest: 'UNKNOWN',
    },
    criteria: [criterion()],
    requirements: [{ id: 'requirement-one', text: 'approved behavior' }],
    interfaces: ['src/feature.mjs'],
    integration: [{ id: 'integration-one', entrypoints: ['src/entry.mjs'], wiringSlice: 'slice-one', testPaths: ['tests/slice.test.mjs'] }],
    artifacts: [{ role: 'candidate', path: 'src/feature.mjs', bytes: bytes.byteLength, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }],
    ...overrides,
  });
}

function event(overrides = {}) {
  const item = envelope();
  return createSliceTestReviewEvent({
    eventType: 'initial-assessment',
    sequence: 1,
    timestamp: '2026-10-06T00:00:00.000Z',
    identity: item.identity,
    inputDigest: item.inputDigest,
    envelopeDigest: item.envelopeDigest,
    assessment: {
      status: 'observed',
      verdict: 'UNKNOWN',
      observations: [{ criterionId: 'criterion-one', criterionType: 'slice-test-adequacy', question: 'wire question', probability: 0.73, judgment: 'UNKNOWN' }],
      provider: {
        id: 'jev-slice',
        configSha256: digest('config'),
        model: { id: 'judge-v1', version: 'UNKNOWN' },
        availability: { status: 'available', available: true },
      },
      request: { sha256: digest('request'), bytes: 123 },
      measurements: { latencyMs: 'UNKNOWN', inputTokens: 'UNKNOWN', outputTokens: 'UNKNOWN', totalTokens: 'UNKNOWN' },
      reason: 'classifier pending operator policy',
    },
    review: 'UNKNOWN',
    route: 'operator-acceptance',
    reason: 'assessment captured',
    provenance: { source: 'validated-final-run', replayed: false, capture: 'test' },
    ...overrides,
  });
}

test('envelopes retain exact bytes and reject digest tampering', () => {
  const item = envelope();
  assert.equal(item.artifacts[0].contentBase64, Buffer.from('candidate bytes\n').toString('base64'));
  assert.equal(validateSliceTestReviewEnvelope(item).envelopeDigest, item.envelopeDigest);
  assert.throws(() => validateSliceTestReviewEnvelope({ ...item, inputDigest: digest('tampered') }), { code: 'SLICE_TEST_REVIEW_INPUT_MISMATCH' });
  assert.throws(() => validateSliceTestReviewEnvelope({ ...item, artifacts: [{ ...item.artifacts[0], contentBase64: Buffer.from('changed\n').toString('base64') }] }), { code: 'JEV_DECISION_INVALID' });
});

test('events preserve raw probabilities and UNKNOWN measurements with immutable identities', () => {
  const item = event();
  assert.equal(item.assessment.observations[0].probability, 0.73);
  assert.equal(item.assessment.observations[0].judgment, 'UNKNOWN');
  assert.equal(item.assessment.measurements.totalTokens, 'UNKNOWN');
  assert.equal(validateSliceTestReviewEvent(item).eventDigest, item.eventDigest);
  assert.throws(() => validateSliceTestReviewEvent({ ...item, sequence: 2 }), { code: 'SLICE_TEST_REVIEW_INVALID' });
});

test('event ledger is append-only, ordered, and restart-readable', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-slice-review-'));
  try {
    const first = event();
    const second = event({ eventType: 'assessment-uncertain', sequence: 2, timestamp: '2026-10-06T00:00:01.000Z', reason: 'uncertainty retained' });
    await appendSliceTestReviewEvents(root, [first]);
    await appendSliceTestReviewEvents(root, [second]);
    assert.deepEqual((await readSliceTestReviewEvents(root)).map((entry) => entry.sequence), [1, 2]);
    await assert.rejects(appendSliceTestReviewEvents(root, [first]), { code: 'SLICE_TEST_REVIEW_DUPLICATE' });
    const path = join(root, '.tinysdd', 'runs', 'slice-test-review', 'events.jsonl');
    await writeFile(path, `${await readFile(path, 'utf8')}partial`);
    await assert.rejects(readSliceTestReviewEvents(root), { code: 'SLICE_TEST_REVIEW_PARTIAL' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('event append validates the per-record cap before writing and retains maximum questions', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-slice-event-cap-'));
  try {
    const oversized = event({
      assessment: {
        ...event().assessment,
        observations: Array.from({ length: 70 }, (_, index) => ({
          criterionId: `criterion-${index}`,
          criterionType: 'slice-test-adequacy',
          question: 'q'.repeat(4096),
          probability: 0.5,
          judgment: 'UNKNOWN',
        })),
      },
    });
    await assert.rejects(appendSliceTestReviewEvents(root, [oversized]), { code: 'SLICE_TEST_REVIEW_EVENT_TOO_LARGE' });
    assert.deepEqual(await readSliceTestReviewEvents(root), []);

    const maximumQuestion = 'q'.repeat(16 * 1024);
    const retained = event({ assessment: { ...event().assessment, observations: [{ ...event().assessment.observations[0], question: maximumQuestion }] } });
    await appendSliceTestReviewEvents(root, [retained]);
    assert.equal((await readSliceTestReviewEvents(root))[0].assessment.observations[0].question, maximumQuestion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function briefText() {
  return [
    '# Approved slice',
    '',
    '## Slice test review contract',
    '',
    '```json',
    JSON.stringify({ schemaVersion: 1, workflow: 'slice-tests', criteria: [{ id: 'criterion-one', requirementIds: ['requirement-one'], question: criterion().question, interfaces: ['src/entry.mjs'], testPaths: ['tests/slice.test.mjs'] }] }),
    '```',
    '',
    '## Approved slice requirements',
    '',
    '```json',
    JSON.stringify([{ spec: 'specs/feature.md', baseSha256: null, operation: 'add', id: 'requirement-one', text: 'approved behavior' }]),
    '```',
  ].join('\n');
}

async function snapshotDirectory(root, directory) {
  const { readdir, lstat } = await import('node:fs/promises');
  const result = {};
  async function visit(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        result[path] = { kind: 'directory', sha256: null, size: null };
        await visit(absolute, path);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        result[path] = { kind: 'file', sha256: sha256(bytes), size: bytes.byteLength };
      }
    }
  }
  await visit(directory);
  return result;
}

async function runFixture() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-slice-capture-'));
  const sourceFiles = {
    'changes/change/change.json': JSON.stringify({ schemaVersion: 1, id: 'change-one', proposal: 'changes/change/proposal.md', design: 'changes/change/design.md', specDeltas: ['changes/change/deltas/requirement.json'], slices: ['changes/change/slices/slice-one/slice.json'], budget: { maxImplementationFiles: 2, maxSliceTestFiles: 1, maxCompiledContextBytes: 65536 }, featureTests: ['tests/protected.test.mjs'], featureChecks: 'changes/change/feature-checks.json', integration: [{ id: 'integration-one', requirementIds: ['requirement-one'], entrypoints: ['src/entry.mjs'], wiringSlice: 'slice-one', testPaths: ['tests/protected.test.mjs'], checkIds: ['feature-check'] }] }),
    'changes/change/proposal.md': 'approved proposal\n',
    'changes/change/design.md': 'approved design\n',
    'changes/change/feature-checks.json': JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'feature-check', argv: ['node', 'tests/protected.test.mjs'], criteria: ['C1'] }] }),
    'changes/change/deltas/requirement.json': JSON.stringify({ schemaVersion: 1, spec: 'specs/feature.md', baseSha256: null, changes: [{ operation: 'add', id: 'requirement-one', text: 'approved behavior' }] }),
    'changes/change/slices/slice-one/slice.json': JSON.stringify({ schemaVersion: 1, id: 'slice-one', brief: 'changes/change/slices/slice-one/brief.md', context: 'changes/change/slices/slice-one/context.json', checks: 'changes/change/slices/slice-one/checks.json', implementationFiles: ['src/feature.mjs'], sliceTests: ['tests/slice.test.mjs'], protect: [], interfaces: ['src/entry.mjs'], dependsOn: [], budget: { maxImplementationFiles: null, maxSliceTestFiles: null, maxCompiledContextBytes: null }, openDecisions: [], testReview: { schemaVersion: 1, workflow: 'slice-tests', criteria: [{ id: 'criterion-one', requirementIds: ['requirement-one'], question: criterion().question, interfaces: ['src/entry.mjs'], testPaths: ['tests/slice.test.mjs'] }] } }),
    'changes/change/slices/slice-one/brief.md': briefText(),
    'changes/change/slices/slice-one/context.json': JSON.stringify({ schemaVersion: 1, facts: ['use entrypoint'], resources: [{ path: 'src/entry.mjs', startLine: 1, endLine: 1, purpose: 'entrypoint' }] }),
    'changes/change/slices/slice-one/checks.json': JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'slice-check', argv: ['node', 'tests/slice.test.mjs'], criteria: ['C1'] }] }),
    'src/entry.mjs': 'export function entry() { return true; }\n',
    'tests/protected.test.mjs': 'test("integration", () => {});\n',
  };
  for (const [path, content] of Object.entries(sourceFiles)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  const validated = await validateChange({ projectRoot: root, changePath: 'changes/change/change.json', requireReady: true });
  const plan = validated.registrationPlan[0];
  await initProject(root);
  await addTask(root, {
    id: 'slice-one',
    brief: 'changes/change/slices/slice-one/brief.md',
    context: 'changes/change/slices/slice-one/context.json',
    checks: 'changes/change/slices/slice-one/checks.json',
    allow: ['src/feature.mjs', 'tests/slice.test.mjs'],
    protect: ['tests/protected.test.mjs'],
    preparation: plan.preparation,
  });
  await approveTask(root, { id: 'slice-one', by: 'operator', reason: 'approved capture fixture' });
  const packet = await resolveTaskPacket(root, 'slice-one');
  const run = join(root, '.tinysdd', 'runs', 'worker-one');
  await mkdir(join(run, 'workspace-before'), { recursive: true });
  await mkdir(join(run, 'workspace-after'), { recursive: true });
  for (const entry of plan.preparation) {
    if (!entry.exists) continue;
    const source = await readFile(join(root, entry.path));
    for (const workspace of ['workspace-before', 'workspace-after']) {
      const target = join(run, workspace, entry.path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, source);
    }
  }
  for (const workspace of ['workspace-before', 'workspace-after']) {
    const target = join(run, workspace, 'src/entry.mjs');
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, sourceFiles['src/entry.mjs']);
  }
  const featureBytes = Buffer.from('export const feature = true;\n');
  const sliceBytes = Buffer.from('test("feature", () => {});\n');
  for (const [path, bytes] of [['src/feature.mjs', featureBytes], ['tests/slice.test.mjs', sliceBytes]]) {
    const target = join(run, 'workspace-after', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  const before = await snapshotDirectory(root, join(run, 'workspace-before'));
  const after = await snapshotDirectory(root, join(run, 'workspace-after'));
  const changedPaths = Object.keys(after).filter((path) => before[path] === undefined || JSON.stringify(before[path]) !== JSON.stringify(after[path])).map((path) => ({ path, change: before[path] === undefined ? 'created' : 'modified', before: before[path] ?? null, after: after[path] }));
  await writeFile(join(run, 'before-snapshot.json'), JSON.stringify(before));
  await writeFile(join(run, 'after-snapshot.json'), JSON.stringify(after));
  await writeFile(join(run, 'packet.json'), JSON.stringify({
    taskId: packet.taskId,
    briefText: packet.brief.text,
    briefPath: packet.brief.path,
    briefSha256: packet.brief.sha256,
    runtimeScope: packet.runtimeScope,
    allowedPaths: packet.allowedPaths,
    protectedPaths: packet.protectedPaths,
    preparation: packet.preparation,
    dependencies: packet.dependencies,
    approval: packet.approval,
    context: packet.context,
    checks: packet.checks,
  }));
  await writeFile(join(run, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: 'worker-one', taskId: 'slice-one', outcome: 'completed', scopeViolations: [], fileScope: { mode: 'ordinary-create-modify', ordinaryCreateModify: true, deletions: false, actualPaths: changedPaths.map((entry) => entry.path) }, changedPaths }));
  return { root, packet, changePath: 'changes/change/change.json' };
}

async function makeWorkerRuntime() {
  const runtimeRoot = await mkdtemp(join(canonicalTmpdir, 'tinysdd-slice-worker-runtime-'));
  const sourceAgentDir = join(runtimeRoot, 'agent');
  await mkdir(sourceAgentDir, { recursive: true });
  await writeFile(join(sourceAgentDir, 'models.json'), JSON.stringify({
    providers: {
      fake: {
        api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false }],
      },
    },
  }));
  const pi = join(runtimeRoot, 'fake-pi.mjs');
  await writeFile(pi, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('src/feature.mjs', 'export const feature = true;\\n');
writeFileSync('tests/slice.test.mjs', 'test("feature", () => {});\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'changed approved files' }] } }));
`);
  await chmod(pi, 0o755);
  return {
    root: runtimeRoot,
    runtime: { test: true, piExecutable: pi, sourceAgentDir, sourceEnv: {} },
  };
}

test('capture uses full retained snapshots, protected tests, and actual extra paths', async () => {
  const { root, packet, changePath } = await runFixture();
  try {
    const item = await captureSliceTestReviewEnvelope({
      projectRoot: root,
      packet,
      runId: 'worker-one',
      changePath,
      featureId: 'change-one',
      sliceId: 'slice-one',
    });
    assert.equal(item.artifacts.some((artifact) => artifact.path === 'src/feature.mjs'), true);
    assert.equal(item.artifacts.some((artifact) => artifact.path === 'tests/slice.test.mjs'), true);
    assert.equal(item.artifacts.some((artifact) => artifact.path === 'changes/change/change.json'), true);
    assert.equal(item.artifacts.some((artifact) => artifact.path === 'changes/change/slices/slice-one/brief.md'), true);
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'src/entry.mjs').role, 'assessed-interface');
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'src/entry.mjs').contentBase64, Buffer.from('export function entry() { return true; }\n').toString('base64'));
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'tests/protected.test.mjs').role, 'protected-feature-test');
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'src/feature.mjs').contentBase64, Buffer.from('export const feature = true;\n').toString('base64'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture refuses changed retained snapshots and approval-bound requirement substitution', async () => {
  const { root, packet, changePath } = await runFixture();
  try {
    await assert.rejects(captureSliceTestReviewEnvelope({ projectRoot: root, packet, runId: 'worker-one', changePath, featureId: 'change-one', sliceId: 'slice-one', requirements: [{ id: 'requirement-one', text: 'substituted' }] }), { code: 'SLICE_TEST_REVIEW_INPUT_MISMATCH' });
    await writeFile(join(root, '.tinysdd', 'runs', 'worker-one', 'after-snapshot.json'), JSON.stringify({}));
    await assert.rejects(captureSliceTestReviewEnvelope({ projectRoot: root, packet, runId: 'worker-one', changePath, featureId: 'change-one', sliceId: 'slice-one' }), { code: 'SLICE_TEST_REVIEW_RUN_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture refuses a packet retained from before controller re-approval', async () => {
  const { root, packet, changePath } = await runFixture();
  try {
    await updateTask(root, {
      id: 'slice-one',
      allow: ['src/feature.mjs', 'tests/slice.test.mjs', 'src/extra.mjs'],
      by: 'operator',
      reason: 'expanded approved output boundary',
    });
    await approveTask(root, { id: 'slice-one', by: 'operator', reason: 're-approved expanded output boundary' });
    await assert.rejects(
      captureSliceTestReviewEnvelope({ projectRoot: root, packet, runId: 'worker-one', changePath, featureId: 'change-one', sliceId: 'slice-one' }),
      { code: 'SLICE_TEST_REVIEW_APPROVAL_STALE' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture accepts an actual fake-worker run with the retained flat packet', async () => {
  const { root, packet, changePath } = await runFixture();
  const runtimeState = await makeWorkerRuntime();
  const previousTestFlag = process.env.TINYSDD_WORKER_TEST;
  const previousTmpdir = process.env.TINYSDD_TMPDIR;
  process.env.TINYSDD_WORKER_TEST = '1';
  process.env.TINYSDD_TMPDIR = canonicalTmpdir;
  try {
    const result = await runWorker({
      projectRoot: root,
      packet,
      worker: { type: 'pi', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 2000, maxToolCalls: 4 } },
      runtime: runtimeState.runtime,
    });
    assert.equal(result.outcome, 'completed');
    const item = await captureSliceTestReviewEnvelope({
      projectRoot: root,
      packet,
      runId: result.runId,
      changePath,
      featureId: 'change-one',
      sliceId: 'slice-one',
    });
    assert.equal(item.provenance.source, 'validated-final-run');
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'src/entry.mjs').role, 'assessed-interface');
    assert.equal(item.artifacts.find((artifact) => artifact.path === 'src/feature.mjs').contentBase64, Buffer.from('export const feature = true;\n').toString('base64'));
  } finally {
    if (previousTestFlag === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousTestFlag;
    if (previousTmpdir === undefined) delete process.env.TINYSDD_TMPDIR;
    else process.env.TINYSDD_TMPDIR = previousTmpdir;
    await rm(runtimeState.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('capture refuses a symlinked retained event ledger', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-slice-ledger-'));
  try {
    await mkdir(join(root, '.tinysdd', 'runs', 'slice-test-review'), { recursive: true });
    await symlink('/dev/null', join(root, '.tinysdd', 'runs', 'slice-test-review', 'events.jsonl'));
    await assert.rejects(readSliceTestReviewEvents(root), { code: 'SYMLINK_PATH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
