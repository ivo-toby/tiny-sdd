import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { addTask, approveTask, initProject } from '../src/controller.mjs';
import { sha256 } from '../src/fs-utils.mjs';
import { exportSliceBundle } from '../src/slice-bundle.mjs';
import { MAX_ARTIFACT_FILE_BYTES, validateChange } from '../src/change-format.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, 'examples', 'artifact-format');
const CANONICAL_TMP = await realpath(tmpdir());
const CHANGE_PATH = 'examples/artifact-format/changes/broker-recut/change.json';

async function project() {
  const root = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-'));
  await cp(FIXTURE, join(root, 'examples', 'artifact-format'), { recursive: true });
  await initProject(root);
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function registerFirstSlice(root, { suffix = '', omitContext = false, omitChecks = false, briefPathOverride } = {}) {
  const validated = await validateChange(root, CHANGE_PATH);
  const plan = validated.registrationPlan[0];
  const tasks = join(root, '.tinysdd', 'tasks');
  await mkdir(tasks, { recursive: true });
  const slice = validated.slices.find((item) => item.value.id === plan.id);
  const briefPath = briefPathOverride ?? '.tinysdd/tasks/' + plan.id + suffix + '.md';
  const contextPath = omitContext ? undefined : '.tinysdd/tasks/' + plan.id + suffix + '.context.json';
  const checksPath = omitChecks ? undefined : '.tinysdd/tasks/' + plan.id + suffix + '.checks.json';
  await writeFile(join(root, briefPath), slice.brief.text);
  if (contextPath) await writeFile(join(root, contextPath), slice.context.text);
  if (checksPath) await writeFile(join(root, checksPath), slice.checks.text);
  await addTask(root, {
    id: plan.id,
    feature: plan.feature,
    brief: briefPath,
    ...(contextPath ? { context: contextPath } : {}),
    ...(checksPath ? { checks: checksPath } : {}),
    allow: plan.allow,
    protect: plan.protect,
    dependsOn: plan.dependsOn,
  });
  await approveTask(root, { id: plan.id, by: 'fixture-operator', reason: 'offline bundle test approval' });
  return { validated, plan, slice };
}

test('bundle export requires a new external directory and retains bounded identities', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  const output = join(outputParent, 'slice');
  try {
    const { validated, plan } = await registerFirstSlice(root);
    const beforeState = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
    const result = await exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: output });
    const manifestText = await readFile(join(output, 'bundle.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(result.manifestPath, join(output, 'bundle.json'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.runtimeScope.mode, 'legacy-allowlist');
    assert.equal(manifest.runtimeScope.extraOrdinaryFiles, false);
    assert.equal(manifest.identity.descriptorSetSha256, validated.preparationIdentity.descriptorSetSha256);
    assert.equal(manifest.identity.approvalContextBinding, undefined);
    assert.equal(manifest.identity.context.approvalContextBinding, 'current');
    assert.equal(manifest.identity.context.compiledSha256.length, 64);
    assert.ok(manifest.citedSourceSnapshots.some((snapshot) => snapshot.path === 'examples/artifact-format/src/entrypoint.mjs'));
    for (const reference of manifest.files) {
      const bytes = await readFile(join(output, reference.path));
      assert.equal(bytes.byteLength, reference.bytes, reference.path);
      assert.equal(sha256(bytes), reference.sha256, reference.path);
    }
    for (const reference of manifest.retainedFiles) {
      const bytes = await readFile(join(output, reference.path));
      assert.equal(bytes.byteLength, reference.bytes, reference.path);
      assert.equal(sha256(bytes), reference.sha256, reference.path);
    }
    const packet = JSON.parse(await readFile(join(output, 'packet.json'), 'utf8'));
    assert.equal(manifest.packet.sha256, sha256(Buffer.from(`${JSON.stringify(packet, null, 2)}\n`)));
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), beforeState);
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: output }), { code: 'BUNDLE_OUTPUT_COLLISION' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export scopes readiness to the selected slice', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    await writeFile(join(root, 'examples/artifact-format/changes/broker-recut/slices/s2/brief.md'), '# draft slice\n');
    await assert.rejects(validateChange({ projectRoot: root, changePath: CHANGE_PATH, requireReady: true }), { code: 'CHANGE_NOT_READY' });
    const { plan } = await registerFirstSlice(root);
    const result = await exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'ready-a') });
    assert.equal(result.manifest.sliceId, 'broker-s1');
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: 'broker-s2', outputDir: join(outputParent, 'draft-b') }), { code: 'CHANGE_NOT_READY' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export rejects an unrelated task and stale approved brief bytes', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const { plan } = await registerFirstSlice(root);
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: 'missing', outputDir: join(outputParent, 'missing') }), { code: 'SLICE_NOT_FOUND' });
    await writeFile(join(root, '.tinysdd', 'tasks', `${plan.id}.md`), '# changed approved brief\n');
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'stale') }), { code: 'TASK_NOT_READY' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export bounds task inputs before controller packet reads', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const { plan } = await registerFirstSlice(root);
    await writeFile(join(root, '.tinysdd', 'tasks', `${plan.id}.md`), Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1, 65));
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'oversized-task-input') }), { code: 'ARTIFACT_READ_LIMIT' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export rejects noncanonical task text before controller decoding', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const { plan } = await registerFirstSlice(root);
    await writeFile(join(root, '.tinysdd', 'tasks', `${plan.id}.md`), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# changed approved brief\n')]));
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'bom-task-input') }), { code: 'ARTIFACT_UTF8_BOM' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export requires exact brief, context and checks paths and presence', async () => {
  const missingRoot = await project();
  const missingOutputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const { plan } = await registerFirstSlice(missingRoot, { omitContext: true, omitChecks: true });
    await assert.rejects(exportSliceBundle({ projectRoot: missingRoot, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(missingOutputParent, 'missing-inputs') }), { code: 'TASK_DESCRIPTOR_MISMATCH' });
  } finally {
    await cleanup(missingRoot);
    await cleanup(missingOutputParent);
  }

  const aliasRoot = await project();
  const aliasOutputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const { plan } = await registerFirstSlice(aliasRoot, { suffix: '-alias' });
    await assert.rejects(exportSliceBundle({ projectRoot: aliasRoot, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(aliasOutputParent, 'alias-inputs') }), { code: 'TASK_DESCRIPTOR_MISMATCH' });
  } finally {
    await cleanup(aliasRoot);
    await cleanup(aliasOutputParent);
  }
});

test('bundle export refuses an output parent reached through a symlink alias', async () => {
  const root = await project();
  const canonicalParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  const aliasParent = join(canonicalParent, 'alias');
  const outputParent = join(canonicalParent, 'real');
  try {
    await mkdir(outputParent);
    await symlink(outputParent, aliasParent, 'dir');
    const { plan } = await registerFirstSlice(root);
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(aliasParent, 'slice') }), { code: 'SYMLINK_PATH' });
  } finally {
    await cleanup(root);
    await cleanup(canonicalParent);
  }
});

test('bundle export enforces the retained-byte cap while reading baselines', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/slice.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf8'));
    slice.implementationFiles = Array.from({ length: 65 }, (_, index) => `examples/artifact-format/src/s1-large-${index}.mjs`);
    for (const output of slice.implementationFiles) {
      await writeFile(join(root, output), Buffer.alloc(MAX_ARTIFACT_FILE_BYTES, 65));
    }
    await writeFile(slicePath, JSON.stringify(slice));
    const { plan } = await registerFirstSlice(root);
    await assert.rejects(exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'too-large') }), { code: 'BUNDLE_SIZE_LIMIT' });
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export enforces the resolved budget on the registered compiled context', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/slice.json');
    const descriptor = JSON.parse(await readFile(slicePath, 'utf8'));
    const original = await validateChange(root, CHANGE_PATH);
    await writeFile(join(root, 'c.json'), original.slices[0].context.text);
    descriptor.context = 'c.json';
    await writeFile(slicePath, JSON.stringify(descriptor));
    const shortDescriptor = await validateChange(root, CHANGE_PATH);
    descriptor.budget.maxCompiledContextBytes = shortDescriptor.slices[0].compiled.bytes;
    await writeFile(slicePath, JSON.stringify(descriptor));
    const { plan } = await registerFirstSlice(root);
    await assert.rejects(
      exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'over-budget') }),
      { code: 'CONTEXT_BUDGET_EXCEEDED' },
    );
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('bundle export refuses a registered credential path before controller reads it', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-bundle-output-'));
  try {
    const validated = await validateChange(root, CHANGE_PATH);
    await writeFile(join(root, '.env.md'), validated.slices[0].brief.text);
    const { plan } = await registerFirstSlice(root, { briefPathOverride: '.env.md' });
    const previousReadFile = fsPromises.readFile;
    let credentialReads = 0;
    fsPromises.readFile = async function hookedReadFile(path, ...args) {
      if (String(path).endsWith('/.env.md')) credentialReads += 1;
      return previousReadFile.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        exportSliceBundle({ projectRoot: root, changePath: CHANGE_PATH, sliceId: plan.id, outputDir: join(outputParent, 'credential-input') }),
        { code: 'ARTIFACT_CREDENTIAL_PATH' },
      );
    } finally {
      fsPromises.readFile = previousReadFile;
      syncBuiltinESMExports();
    }
    assert.equal(credentialReads, 0);
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});
