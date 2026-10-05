import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { addTask, approveTask, applyTask, initProject, reviewTask, resolveTaskPacket } from '../src/controller.mjs';
import { beginHarnessCapture, finalizeHarnessCapture } from '../src/harness-adapter.mjs';
import { exportSliceBundle } from '../src/slice-bundle.mjs';
import { validateChange } from '../src/change-format.mjs';
import { sha256 } from '../src/fs-utils.mjs';

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

test('candidate symlinks are retained as symlinks without copying outside bytes', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const outside = join(external, 'outside-marker');
    const source = join(begin.candidatePath, 'outside-link.mjs');
    await writeFile(outside, 'OUTSIDE_SYNTHETIC_MARKER\n');
    await symlink(outside, source);
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true });
    assert.ok(result.scopeViolations.some(({ path }) => path === 'outside-link.mjs'));
    const retained = join(begin.artifactDir, 'workspace-after', 'outside-link.mjs');
    assert.equal((await lstat(retained)).isSymbolicLink(), true);
    assert.equal(await readlink(retained), outside);
    await assert.rejects(applyTask(fixture.root, { id: fixture.plan.id, run: begin.runId, by: 'synthetic-operator' }), { code: 'RUN_SCOPE_VIOLATION' });
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('mutated retained workspace-before is rejected and exact restoration remains usable', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const planned = 'examples/artifact-format/src/s1-errors.mjs';
    const beforePath = join(begin.artifactDir, 'workspace-before', planned);
    const original = await readFile(beforePath);
    await writeFile(beforePath, Buffer.concat([original, Buffer.from('\nMUTATED RETAINED BASELINE\n')]));
    await assert.rejects(
      finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
      { code: 'HARNESS_CAPTURE_STALE' },
    );
    await writeFile(beforePath, original);
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true });
    assert.equal(result.outcome, 'completed');
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('bundle rejects a self-consistent compiled-context replacement and exact restoration remains usable', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const manifestPath = join(bundle.outputDir, 'bundle.json');
    const originalManifest = await readFile(manifestPath);
    const compiledPath = join(bundle.outputDir, 'compiled-context.md');
    const originalCompiled = await readFile(compiledPath);
    const alteredCompiled = Buffer.from('Unapproved substituted compiled context\n');
    const manifest = JSON.parse(originalManifest);
    for (const field of ['files', 'retainedFiles']) {
      const reference = manifest[field].find(({ path }) => path === 'compiled-context.md');
      reference.bytes = alteredCompiled.byteLength;
      reference.sha256 = sha256(alteredCompiled);
    }
    await writeFile(compiledPath, alteredCompiled);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external }),
      { code: 'HARNESS_BUNDLE_INVALID' },
    );
    await writeFile(compiledPath, originalCompiled);
    await writeFile(manifestPath, originalManifest);
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    assert.equal(begin.harness, 'pi');
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('bundle rejects omitted retained files and checkout references, then accepts exact restoration', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const manifestPath = join(bundle.outputDir, 'bundle.json');
    const originalManifest = await readFile(manifestPath);
    const manifest = JSON.parse(originalManifest);
    for (const field of ['files', 'retainedFiles']) manifest[field] = manifest[field].filter(({ path }) => path === 'packet.json');
    manifest.checkoutSnapshot = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external }),
      { code: 'HARNESS_BUNDLE_INVALID' },
    );
    await writeFile(manifestPath, originalManifest);
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    assert.equal(begin.harness, 'pi');
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('bundle rejects hidden context source identities and exact restoration remains usable', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const manifestPath = join(bundle.outputDir, 'bundle.json');
    const originalManifest = await readFile(manifestPath);
    const manifest = JSON.parse(originalManifest);
    manifest.identity.context.sourceDigests = [];
    manifest.checkoutSnapshot = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external }),
      { code: 'HARNESS_BUNDLE_INVALID' },
    );
    await writeFile(manifestPath, originalManifest);
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    assert.equal(begin.harness, 'pi');
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('candidate directory swaps are rejected before outside bytes are retained', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const source = join(begin.candidatePath, 'race-dir');
    const outside = join(external, 'outside-dir');
    await mkdir(source);
    await writeFile(join(source, 'marker'), 'candidate original');
    await mkdir(outside);
    await writeFile(join(outside, 'marker'), 'OUTSIDE_DIRECTORY_SYNTHETIC_MARKER');
    const originalReaddir = fs.readdir;
    let calls = 0;
    let injected = false;
    fs.readdir = async function patchedReaddir(path, ...args) {
      if (String(path) === source && ++calls === 2) {
        injected = true;
        await fs.rename(source, `${source}.prior`);
        await fs.symlink(outside, source);
      }
      return originalReaddir.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
        { code: 'HARNESS_CAPTURE_STALE' },
      );
    } finally {
      fs.readdir = originalReaddir;
      syncBuiltinESMExports();
      await fs.unlink(source);
      await fs.rename(`${source}.prior`, source);
    }
    assert.equal(injected, true);
    const stages = (await originalReaddir.call(fs, begin.artifactDir)).filter((entry) => entry.startsWith('.finalize-'));
    for (const stage of stages) {
      await assert.rejects(readFile(join(begin.artifactDir, stage, 'workspace-after', 'race-dir', 'marker')));
    }
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('finalization marker failure leaves no result and a retry publishes both artifacts', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const originalWriteFile = fs.writeFile;
    let injected = false;
    fs.writeFile = async function patchedWriteFile(path, ...args) {
      if (!injected && String(path) === join(begin.artifactDir, 'finalization.json')) {
        injected = true;
        throw Object.assign(new Error('synthetic injected finalization failure'), { code: 'EIO' });
      }
      return originalWriteFile.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }), { code: 'EIO' });
    } finally {
      fs.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    await assert.rejects(readFile(join(begin.artifactDir, 'result.json')));
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true });
    assert.equal(result.outcome, 'completed');
    assert.equal((await lstat(join(begin.artifactDir, 'finalization.json'))).isFile(), true);
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});

test('result publication failure keeps a stable marker for retry', async () => {
  const fixture = await fixtureProject();
  const external = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-harness-output-'));
  try {
    const bundle = await exportSliceBundle({ projectRoot: fixture.root, changePath: CHANGE_PATH, sliceId: fixture.plan.id, outputDir: join(external, 'bundle') });
    const begin = await beginHarnessCapture({ projectRoot: fixture.root, bundleDir: bundle.outputDir, harness: 'pi', model: 'synthetic/pi', candidateParent: external });
    const originalWriteFile = fs.writeFile;
    let injected = false;
    fs.writeFile = async function patchedWriteFile(path, ...args) {
      if (!injected && String(path) === join(begin.artifactDir, 'result.json')) {
        injected = true;
        throw Object.assign(new Error('synthetic injected result failure'), { code: 'EIO' });
      }
      return originalWriteFile.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true }),
        { code: 'EIO' },
      );
    } finally {
      fs.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    const markerPath = join(begin.artifactDir, 'finalization.json');
    const markerBytes = await readFile(markerPath);
    await assert.rejects(readFile(join(begin.artifactDir, 'result.json')));
    const result = await finalizeHarnessCapture({ projectRoot: fixture.root, runId: begin.runId, completed: true });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(await readFile(markerPath), markerBytes);
  } finally {
    await cleanup(fixture.root);
    await cleanup(external);
  }
});
