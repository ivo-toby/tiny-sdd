import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { addTask, approveTask, applyTask, initProject, reviewTask, resolveTaskPacket } from '../src/controller.mjs';
import { beginHarnessCapture, finalizeHarnessCapture } from '../src/harness-adapter.mjs';
import { exportSliceBundle } from '../src/slice-bundle.mjs';
import { validateChange } from '../src/change-format.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, 'examples', 'artifact-format');
const CANONICAL_TMP = await realpath(tmpdir());
const CHANGE_PATH = 'examples/artifact-format/changes/broker-recut/change.json';

async function fixtureProject() {
  const root = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-project-'));
  await cp(FIXTURE, join(root, 'examples', 'artifact-format'), { recursive: true });
  await initProject(root);
  const validated = await validateChange(root, CHANGE_PATH);
  const plan = validated.registrationPlan[0];
  const slice = validated.slices.find((item) => item.value.id === plan.id);
  const taskDir = join(root, '.tinysdd', 'tasks');
  await mkdir(taskDir, { recursive: true });
  const brief = '.tinysdd/tasks/broker-s1.md';
  const context = '.tinysdd/tasks/broker-s1.context.json';
  const checks = '.tinysdd/tasks/broker-s1.checks.json';
  await writeFile(join(root, brief), slice.brief.text);
  await writeFile(join(root, context), slice.context.text);
  await writeFile(join(root, checks), slice.checks.text);
  await addTask(root, { id: plan.id, feature: plan.feature, brief, context, checks, allow: plan.allow, protect: plan.protect, preparation: plan.preparation, dependsOn: plan.dependsOn });
  await approveTask(root, { id: plan.id, by: 'synthetic-operator', reason: 'adapter fixture approval' });
  return { root, plan, packet: await resolveTaskPacket(root, plan.id) };
}

async function cleanup(path) {
  await rm(path, { recursive: true, force: true });
}

for (const harness of ['claude-code', 'pi']) {
  test(`${harness} capture returns through normal apply and explicit review`, async () => {
    const fixture = await fixtureProject();
    const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
    try {
      await writeFile(join(fixture.root, 'synthetic-review.md'), 'Fixture-only review; no live harness or acceptance evidence.\n');
      const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
      const controllerPath = join(fixture.root, '.tinysdd', 'runs', 'controller.json');
      const controllerBefore = await readFile(controllerPath);
      const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness, model: `synthetic/${harness}`, candidateParent: external });
      assert.deepEqual(JSON.parse(await readFile(begin.packetPath, 'utf8')), fixture.packet);
      assert.deepEqual(await readFile(controllerPath), controllerBefore);

      const planned = 'examples/artifact-format/src/s1-errors.mjs';
      const original = await readFile(join(begin.candidatePath, planned), 'utf8');
      await writeFile(join(begin.candidatePath, planned), `${original}\n// Fixture adapter edit.\n`);
      await writeFile(join(begin.candidatePath, 'ordinary-extra.mjs'), 'export const extra = 31;\n');
      const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true, callerClaims: 'Unverified foreign-harness claim.' });
      assert.equal(result.outcome, 'completed');
      assert.deepEqual(result.scopeViolations, []);
      assert.deepEqual(result.fileScope.actualPaths, ['examples/artifact-format/src/s1-errors.mjs', 'ordinary-extra.mjs']);
      assert.equal(result.model.source, 'caller-declared');
      assert.equal(result.observed.usage, 'UNKNOWN');
      assert.equal(result.observed.checks, 'unrun');
      assert.deepEqual(await readFile(controllerPath), controllerBefore);

      const applied = await applyTask(fixture.root, { id: fixture.plan.id, run: begin.runId, by: 'synthetic-operator' });
      assert.deepEqual(applied.applied.files.map(({ path }) => path).sort(), ['examples/artifact-format/src/s1-errors.mjs', 'ordinary-extra.mjs']);
      assert.equal(await readFile(join(fixture.root, 'ordinary-extra.mjs'), 'utf8'), 'export const extra = 31;\n');
      const reviewed = await reviewTask(fixture.root, { id: fixture.plan.id, verdict: 'accepted', by: 'synthetic-reviewer', evidence: 'synthetic-review.md' });
      assert.equal(reviewed.task.status, 'accepted');
    } finally {
      await cleanup(fixture.root);
      await cleanup(external);
    }
  });
}

test('begin requires an explicit foreign harness and model', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    await assert.rejects(beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'unknown', model: 'synthetic/model', candidateParent: external }), { code: 'HARNESS_REQUIRED' });
    await assert.rejects(beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: '', candidateParent: external }), { code: 'HARNESS_MODEL_REQUIRED' });
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('incomplete foreign sessions retain evidence but cannot apply', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: false });
    assert.equal(result.outcome, 'incomplete');
    await assert.rejects(applyTask(fixture.root, { id: fixture.plan.id, run: begin.runId, by: 'synthetic-operator' }), { code: 'RUN_INCOMPLETE' });
    await assert.rejects(finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }), { code: 'HARNESS_ALREADY_FINALIZED' });
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('begin binding rejects capture metadata substitution and exact restoration remains usable', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const capturePath = join(begin.artifactDir, 'capture.json');
    const originalCapture = await readFile(capturePath);
    const foreign = await mkdtemp(join(external, 'foreign-'));
    await cp(begin.candidatePath, foreign, { recursive: true });
    const foreignIdentity = await lstat(foreign);
    const tampered = JSON.parse(originalCapture);
    tampered.candidate = { path: foreign, realpath: foreign, dev: foreignIdentity.dev, ino: foreignIdentity.ino };
    await writeFile(capturePath, JSON.stringify(tampered));
    await assert.rejects(
      finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
      { code: 'HARNESS_CAPTURE_INVALID' },
    );
    await writeFile(capturePath, originalCapture);
    await writeFile(join(begin.candidatePath, 'ordinary-extra.mjs'), 'export const restored = 31;\n');
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true });
    assert.deepEqual(result.scopeViolations, []);
    assert.deepEqual(result.fileScope.actualPaths, ['ordinary-extra.mjs']);
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('oversized caller claims fail before outputs and a bounded retry finalizes', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    await assert.rejects(
      finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true, callerClaims: 'x'.repeat(128 * 1024 + 1) }),
      { code: 'HARNESS_CLAIM_LIMIT' },
    );
    await assert.rejects(readFile(join(begin.artifactDir, 'source-current')));
    await assert.rejects(readFile(join(begin.artifactDir, 'workspace-after')));
    await assert.rejects(readFile(join(begin.artifactDir, 'after-snapshot.json')));
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true, callerClaims: 'bounded' });
    assert.equal(result.modelClaims.text, 'bounded');
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('concurrent finalization returns a structured state instead of an output collision', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const attempts = await Promise.allSettled([
      finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
      finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
    ]);
    const failures = attempts.filter((attempt) => attempt.status === 'rejected').map((attempt) => attempt.reason.code);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.ok(failures.every((code) => ['HARNESS_FINALIZATION_IN_PROGRESS', 'HARNESS_ALREADY_FINALIZED'].includes(code)));
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});
