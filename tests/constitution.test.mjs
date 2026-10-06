import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acceptFeature,
  addTask,
  approveTask,
  controllerStatus,
  initProject,
  reviewTask,
  updateTask,
} from '../src/controller.mjs';
import {
  DEFAULT_CONSTITUTION_APPROVAL_PATH,
  DEFAULT_CONSTITUTION_PATH,
  parseConstitutionApproval,
  parseConstitutionReference,
} from '../src/constitution.mjs';
import { exportSliceBundle } from '../src/slice-bundle.mjs';
import { validateChange } from '../src/change-format.mjs';
import { FEATURE_INTEGRATION_TEST_ENV } from '../src/feature-integration.mjs';
import { LIVING_SPEC_SCHEMA_VERSION, archiveChange, parseArchiveManifest } from '../src/living-spec.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());

const constitutionText = [
  '# Project constitution',
  '',
  '1. Follow approved requirements and surface conflicts for operator review.',
  '2. Treat model output as unverified until the controller observes the check.',
  '3. Amend this document only through explicit operator approval.',
  '',
].join('\n');

function approvalFor(text = constitutionText) {
  return {
    schemaVersion: 1,
    version: '1.0.0',
    ratifiedAt: '2026-10-06T00:00:00.000Z',
    amendedAt: '2026-10-06T00:00:00.000Z',
    approvedAt: '2026-10-06T00:00:00.000Z',
    by: 'operator',
    reason: 'Approved project principles',
    contentSha256: sha256(text),
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function paths(root, relative) {
  return join(root, ...relative.split('/'));
}

async function writeProjectFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = paths(root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
}

function changeDocument({ constitution = true } = {}) {
  return {
    schemaVersion: 1,
    id: 'constitution-change',
    proposal: 'changes/constitution-change/proposal.md',
    design: 'changes/constitution-change/design.md',
    specDeltas: ['changes/constitution-change/deltas/requirements.json'],
    slices: ['changes/constitution-change/slices/one/slice.json'],
    budget: { maxImplementationFiles: 2, maxSliceTestFiles: 1, maxCompiledContextBytes: 65536 },
    featureTests: ['tests/feature.test.mjs'],
    featureChecks: 'changes/constitution-change/feature-checks.json',
    integration: [{
      id: 'entrypoint',
      requirementIds: ['requirement-one'],
      entrypoints: ['src/entry.mjs'],
      wiringSlice: 'one',
      testPaths: ['tests/feature.test.mjs'],
      checkIds: ['feature'],
    }],
    ...(constitution === true ? { constitution: {} } : constitution === false ? {} : { constitution }),
  };
}

function sliceDocument() {
  return {
    schemaVersion: 1,
    id: 'one',
    brief: 'changes/constitution-change/slices/one/brief.md',
    context: 'changes/constitution-change/slices/one/context.json',
    checks: 'changes/constitution-change/slices/one/checks.json',
    implementationFiles: ['src/feature.mjs'],
    sliceTests: ['tests/slice.test.mjs'],
    protect: [],
    interfaces: ['src/entry.mjs'],
    dependsOn: [],
    budget: { maxImplementationFiles: null, maxSliceTestFiles: null, maxCompiledContextBytes: null },
    openDecisions: [],
    testReview: {
      schemaVersion: 1,
      workflow: 'slice-tests',
      criteria: [{
        id: 'criterion-one',
        requirementIds: ['requirement-one'],
        question: 'Does the writable test establish the approved behavior at the entrypoint?',
        interfaces: ['src/entry.mjs'],
        testPaths: ['tests/slice.test.mjs'],
      }],
    },
  };
}

function briefText() {
  return [
    '# Approved slice',
    '',
    '## Slice test review contract',
    '',
    '```json',
    JSON.stringify(sliceDocument().testReview),
    '```',
    '',
    '## Approved slice requirements',
    '',
    '```json',
    JSON.stringify([{ spec: 'specs/feature.md', baseSha256: null, operation: 'add', id: 'requirement-one', text: 'approved behavior' }]),
    '```',
  ].join('\n');
}

async function fixture({ constitution = true, contextRanges = 'full' } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-constitution-'));
  const constitutionPath = constitution && constitution !== true ? constitution.path ?? DEFAULT_CONSTITUTION_PATH : DEFAULT_CONSTITUTION_PATH;
  const approvalPath = constitution && constitution !== true ? constitution.approval ?? DEFAULT_CONSTITUTION_APPROVAL_PATH : DEFAULT_CONSTITUTION_APPROVAL_PATH;
  const constitutionLines = constitutionText.split(/\r?\n/u).length - 1;
  const ranges = contextRanges === 'full' && constitution
    ? [{ path: constitutionPath, startLine: 1, endLine: constitutionLines, purpose: 'Every approved constitution line is required for this slice.' }]
    : contextRanges === 'full' ? [] : contextRanges;
  const change = changeDocument({ constitution });
  const files = {
    'changes/constitution-change/change.json': json(change),
    'changes/constitution-change/proposal.md': '# Proposal\n',
    'changes/constitution-change/design.md': '# Design\n',
    'changes/constitution-change/feature-checks.json': json({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'feature', argv: ['node', 'tests/feature.test.mjs'], criteria: ['C1'] }] }),
    'changes/constitution-change/deltas/requirements.json': json({ schemaVersion: 1, spec: 'specs/feature.md', baseSha256: null, changes: [{ operation: 'add', id: 'requirement-one', text: 'approved behavior' }] }),
    'changes/constitution-change/slices/one/slice.json': json(sliceDocument()),
    'changes/constitution-change/slices/one/brief.md': briefText(),
    'changes/constitution-change/slices/one/context.json': json({ schemaVersion: 1, facts: ['Use the existing entrypoint.'], resources: [{ path: 'src/entry.mjs', startLine: 1, endLine: 1, purpose: 'Existing feature entrypoint.' }, ...ranges] }),
    'changes/constitution-change/slices/one/checks.json': json({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'slice', argv: ['node', 'tests/slice.test.mjs'], criteria: ['C1'] }] }),
    'src/entry.mjs': 'export function entry() { return true; }\n',
    'tests/feature.test.mjs': 'import assert from \'node:assert/strict\';\nassert.equal(true, true);\n',
    'src/feature.mjs': 'export const feature = true;\n',
    'tests/slice.test.mjs': 'import assert from \'node:assert/strict\';\nassert.equal(true, true);\n',
  };
  if (constitution) {
    files[constitutionPath] = constitutionText;
    files[approvalPath] = json(approvalFor());
  }
  await writeProjectFiles(root, files);
  return { root, changePath: 'changes/constitution-change/change.json', constitutionPath, approvalPath };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test('constitution approval records validate exact identity and Markdown bytes', () => {
  const parsed = parseConstitutionApproval(json(approvalFor()));
  assert.deepEqual(parsed, approvalFor());
  assert.throws(() => parseConstitutionApproval(json({ ...approvalFor(), contentSha256: '0'.repeat(64) }).replace(/0{64}/u, 'missing')), { code: 'CONSTITUTION_APPROVAL_INVALID' });
  assert.throws(() => parseConstitutionApproval(json({ ...approvalFor(), contentSha256: undefined })), { code: 'CONSTITUTION_APPROVAL_INVALID' });
  assert.throws(() => parseConstitutionApproval(json({ ...approvalFor(), extra: true })), { code: 'CONSTITUTION_APPROVAL_INVALID' });
  assert.throws(() => parseConstitutionApproval(json({ ...approvalFor(), approvedAt: '2026-02-30T00:00:00Z' })), { code: 'CONSTITUTION_APPROVAL_INVALID' });
  assert.throws(() => parseConstitutionApproval(json({ ...approvalFor(), amendedAt: '2026-10-07T00:00:00.000Z' })), { code: 'CONSTITUTION_APPROVAL_INVALID' });
});

test('constitution reference is optional and defaults only when explicitly adopted', async () => {
  assert.deepEqual(parseConstitutionReference({}), { path: DEFAULT_CONSTITUTION_PATH, approval: DEFAULT_CONSTITUTION_APPROVAL_PATH });
  assert.throws(() => parseConstitutionReference({ path: null }), { code: 'CONSTITUTION_INVALID' });
  assert.throws(() => parseConstitutionReference({ approval: null }), { code: 'CONSTITUTION_INVALID' });
  const adopted = await fixture();
  const unreferenced = await fixture({ constitution: false });
  try {
    await writeProjectFiles(unreferenced.root, {
      [DEFAULT_CONSTITUTION_PATH]: constitutionText,
      [DEFAULT_CONSTITUTION_APPROVAL_PATH]: json(approvalFor()),
    });
    const withConstitution = await validateChange(adopted.root, adopted.changePath, { requireReady: true });
    assert.deepEqual(withConstitution.change.constitution, { path: DEFAULT_CONSTITUTION_PATH, approval: DEFAULT_CONSTITUTION_APPROVAL_PATH });
    const preparation = new Set(withConstitution.preparationPaths);
    assert.equal(preparation.has(DEFAULT_CONSTITUTION_PATH), true);
    assert.equal(preparation.has(DEFAULT_CONSTITUTION_APPROVAL_PATH), true);

    const withoutConstitution = await validateChange(unreferenced.root, unreferenced.changePath, { requireReady: true });
    assert.equal(Object.hasOwn(withoutConstitution.change, 'constitution'), false);
    assert.equal(withoutConstitution.preparationPaths.includes(DEFAULT_CONSTITUTION_PATH), false);
    assert.equal(withoutConstitution.preparationPaths.includes(DEFAULT_CONSTITUTION_APPROVAL_PATH), false);
  } finally {
    await cleanup(adopted.root);
    await cleanup(unreferenced.root);
  }
});

test('constitution validation rejects wrong or missing approval identity', async () => {
  const wrongDigest = await fixture();
  const missingApproval = await fixture();
  try {
    const approvalPath = paths(wrongDigest.root, wrongDigest.approvalPath);
    await writeFile(approvalPath, json({ ...approvalFor(), contentSha256: '0'.repeat(64) }));
    await assert.rejects(validateChange(wrongDigest.root, wrongDigest.changePath), { code: 'CONSTITUTION_DIGEST_MISMATCH' });

    await writeFile(paths(missingApproval.root, missingApproval.approvalPath), json({ ...approvalFor(), contentSha256: undefined }));
    await assert.rejects(validateChange(missingApproval.root, missingApproval.changePath), { code: 'CONSTITUTION_APPROVAL_INVALID' });
  } finally {
    await cleanup(wrongDigest.root);
    await cleanup(missingApproval.root);
  }
});

test('every slice context must cover the complete approved constitution', async () => {
  const incomplete = await fixture({ contextRanges: [{ path: DEFAULT_CONSTITUTION_PATH, startLine: 1, endLine: 2, purpose: 'Only a partial constitution excerpt.' }] });
  try {
    const result = await validateChange(incomplete.root, incomplete.changePath);
    assert.equal(result.readiness.ready, false);
    assert.deepEqual(result.readiness.issues.find((issue) => issue.code === 'CONSTITUTION_CONTEXT_NOT_CITED')?.details.missingLines, [3, 4, 5]);
    await assert.rejects(validateChange(incomplete.root, incomplete.changePath, { requireReady: true }), { code: 'CHANGE_NOT_READY' });
  } finally {
    await cleanup(incomplete.root);
  }

  const split = await fixture({ contextRanges: [
    { path: DEFAULT_CONSTITUTION_PATH, startLine: 1, endLine: 2, purpose: 'First exact constitution range.' },
    { path: DEFAULT_CONSTITUTION_PATH, startLine: 3, endLine: 5, purpose: 'Second exact constitution range.' },
  ] });
  try {
    const result = await validateChange(split.root, split.changePath, { requireReady: true });
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.sourceSnapshots.find((file) => file.path === DEFAULT_CONSTITUTION_PATH), {
      path: DEFAULT_CONSTITUTION_PATH,
      bytes: Buffer.byteLength(constitutionText),
      sha256: sha256(constitutionText),
    });
  } finally {
    await cleanup(split.root);
  }
});

test('constitution files are preparation and protected inputs, and output overlap is refused', async () => {
  const root = await fixture();
  try {
    const result = await validateChange(root.root, root.changePath, { requireReady: true });
    const plan = result.registrationPlan[0];
    assert.ok(plan.preparation.some((entry) => entry.path === root.constitutionPath && entry.exists === true));
    assert.ok(plan.preparation.some((entry) => entry.path === root.approvalPath && entry.exists === true));
    assert.ok(plan.protect.includes(root.constitutionPath));
    assert.ok(plan.protect.includes(root.approvalPath));

    const descriptorPath = paths(root.root, 'changes/constitution-change/slices/one/slice.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    descriptor.implementationFiles = [root.constitutionPath];
    await writeFile(descriptorPath, json(descriptor));
    await assert.rejects(validateChange(root.root, root.changePath), { code: 'OUTPUT_PREPARATION_OVERLAP' });

    const clean = await fixture();
    try {
      const deltaPath = paths(clean.root, 'changes/constitution-change/deltas/requirements.json');
      const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
      delta.spec = clean.constitutionPath;
      delta.baseSha256 = sha256(constitutionText);
      delta.changes[0].operation = 'modify';
      await writeFile(deltaPath, json(delta));
      await assert.rejects(validateChange(clean.root, clean.changePath), { code: 'CONSTITUTION_DELTA_OVERLAP' });
    } finally {
      await cleanup(clean.root);
    }
  } finally {
    await cleanup(root.root);
  }
});

test('editing a referenced constitution stales an existing task approval', async () => {
  const root = await fixture();
  try {
    const result = await validateChange(root.root, root.changePath, { requireReady: true });
    const plan = result.registrationPlan[0];
    await initProject(root.root);
    await mkdir(paths(root.root, '.tinysdd/tasks'), { recursive: true });
    const slice = result.slices[0];
    await writeFile(paths(root.root, '.tinysdd/tasks/one.md'), slice.brief.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.context.json'), slice.context.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.checks.json'), slice.checks.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/legacy.md'), '# Legacy task\n');
    await addTask(root.root, { id: 'one', feature: result.change.id, brief: '.tinysdd/tasks/one.md', context: '.tinysdd/tasks/one.context.json', checks: '.tinysdd/tasks/one.checks.json', allow: plan.allow, protect: plan.protect, preparation: plan.preparation });
    await addTask(root.root, { id: 'legacy', brief: '.tinysdd/tasks/legacy.md', allow: ['src/legacy.mjs'] });
    await approveTask(root.root, { id: 'one', by: 'operator', reason: 'approved constitution-bound packet' });
    await approveTask(root.root, { id: 'legacy', by: 'operator', reason: 'approved unrelated task' });
    assert.equal((await controllerStatus(root.root)).tasks.find((task) => task.id === 'one').status, 'ready');
    assert.equal((await controllerStatus(root.root)).tasks.find((task) => task.id === 'legacy').status, 'ready');
    const approvalPath = paths(root.root, root.approvalPath);
    await writeFile(approvalPath, json({ ...approvalFor(), reason: 'Amendment approved by operator' }));
    assert.equal((await controllerStatus(root.root)).tasks.find((task) => task.id === 'one').status, 'stale_approval');
    assert.equal((await controllerStatus(root.root)).tasks.find((task) => task.id === 'legacy').status, 'ready');
    const refreshed = await validateChange(root.root, root.changePath, { requireReady: true });
    await updateTask(root.root, {
      id: 'one',
      preparation: refreshed.registrationPlan[0].preparation,
      by: 'operator',
      reason: 'refreshed constitution preparation after approval record amendment',
    });
    await approveTask(root.root, { id: 'one', by: 'operator', reason: 're-approved updated constitution record' });
    assert.equal((await controllerStatus(root.root)).tasks.find((task) => task.id === 'one').status, 'ready');
    const markdownPath = paths(root.root, root.constitutionPath);
    const amended = `${constitutionText}4. Keep amendments explicit.\n`;
    await writeFile(markdownPath, amended);
    const afterMarkdownEdit = await controllerStatus(root.root);
    assert.equal(afterMarkdownEdit.tasks.find((task) => task.id === 'one').status, 'stale_approval');
    assert.equal(afterMarkdownEdit.tasks.find((task) => task.id === 'legacy').status, 'ready');
  } finally {
    await cleanup(root.root);
  }
});

test('export retains referenced constitution and approval inputs', async () => {
  const root = await fixture();
  const outputParent = await mkdtemp(join(canonicalTmpdir, 'tinysdd-constitution-bundle-'));
  try {
    const result = await validateChange(root.root, root.changePath, { requireReady: true });
    const plan = result.registrationPlan[0];
    await initProject(root.root);
    await mkdir(paths(root.root, '.tinysdd/tasks'), { recursive: true });
    await writeFile(paths(root.root, '.tinysdd/tasks/one.md'), result.slices[0].brief.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.context.json'), result.slices[0].context.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.checks.json'), result.slices[0].checks.text);
    await addTask(root.root, { id: 'one', feature: result.change.id, brief: '.tinysdd/tasks/one.md', context: '.tinysdd/tasks/one.context.json', checks: '.tinysdd/tasks/one.checks.json', allow: plan.allow, protect: plan.protect, preparation: plan.preparation });
    await approveTask(root.root, { id: 'one', by: 'operator', reason: 'approved export fixture' });
    const bundle = await exportSliceBundle({ projectRoot: root.root, changePath: root.changePath, sliceId: 'one', outputDir: join(outputParent, 'bundle') });
    assert.ok(bundle.files.includes(`preparation/${root.constitutionPath}`));
    assert.ok(bundle.files.includes(`preparation/${root.approvalPath}`));
    assert.equal(JSON.parse(await readFile(join(bundle.outputDir, `preparation/${root.approvalPath}`), 'utf8')).contentSha256, sha256(constitutionText));
    assert.deepEqual(bundle.manifest.identity.context.sourceDigests.find((file) => file.path === root.constitutionPath), {
      path: root.constitutionPath,
      bytes: Buffer.byteLength(constitutionText),
      sha256: sha256(constitutionText),
    });
  } finally {
    await cleanup(root.root);
    await cleanup(outputParent);
  }
});

test('archive retains referenced constitution and approval inputs through accepted feature flow', async () => {
  const root = await fixture();
  const previousIntegrationEnv = process.env[FEATURE_INTEGRATION_TEST_ENV];
  process.env[FEATURE_INTEGRATION_TEST_ENV] = '1';
  try {
    const result = await validateChange(root.root, root.changePath, { requireReady: true });
    const plan = result.registrationPlan[0];
    await initProject(root.root);
    await mkdir(paths(root.root, '.tinysdd/tasks'), { recursive: true });
    await mkdir(paths(root.root, '.tinysdd/reviews'), { recursive: true });
    await writeFile(paths(root.root, '.tinysdd/reviews/evidence.md'), 'operator acceptance evidence\n');
    await writeFile(paths(root.root, '.tinysdd/tasks/one.md'), result.slices[0].brief.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.context.json'), result.slices[0].context.text);
    await writeFile(paths(root.root, '.tinysdd/tasks/one.checks.json'), result.slices[0].checks.text);
    await addTask(root.root, {
      id: 'one',
      feature: result.change.id,
      brief: '.tinysdd/tasks/one.md',
      context: '.tinysdd/tasks/one.context.json',
      checks: '.tinysdd/tasks/one.checks.json',
      allow: plan.allow,
      protect: plan.protect,
      preparation: plan.preparation,
    });
    await approveTask(root.root, { id: 'one', by: 'operator', reason: 'approved archive fixture' });
    await reviewTask(root.root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    await writeFile(paths(root.root, '.tinysdd/config.json'), json({
      schemaVersion: 1,
      workers: {},
      featureIntegration: {
        argv: ['node', 'tests/feature.test.mjs'],
        testPaths: ['tests/feature.test.mjs'],
        entrypoints: ['src/entry.mjs'],
      },
    }));
    const output = 'approved behavior';
    await writeFile(paths(root.root, 'changes/constitution-change/merge-draft.json'), json({
      schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
      changeId: result.change.id,
      specs: [{
        spec: 'specs/feature.md',
        baseSha256: null,
        outputSha256: sha256(output),
        changes: [{ id: 'requirement-one', operation: 'add', baseStart: 0, baseEnd: 0, baseText: '', outputText: output }],
      }],
    }));
    await acceptFeature(root.root, {
      feature: result.change.id,
      by: 'operator',
      reason: 'accepted constitution-bound feature',
      integrationRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 }),
    });
    const archived = await archiveChange(root.root, { changePath: root.changePath });
    assert.equal(archived.alreadyArchived, false);
    const archiveDir = paths(root.root, archived.archivePath);
    const manifest = parseArchiveManifest(JSON.parse(await readFile(join(archiveDir, 'manifest.json'), 'utf8')));
    for (const projectPath of [root.constitutionPath, root.approvalPath]) {
      const validationFile = manifest.validation.preparationFiles.find((file) => file.path === projectPath);
      assert.equal(validationFile?.exists, true);
      const retained = manifest.files.find((file) => file.sourcePath === projectPath && file.bytes === validationFile.bytes && file.sha256 === validationFile.sha256);
      assert.ok(retained);
      assert.equal(await readFile(join(archiveDir, retained.archivePath), 'utf8'), await readFile(paths(root.root, projectPath), 'utf8'));
    }
    assert.equal(await readFile(paths(root.root, 'specs/feature.md'), 'utf8'), output);
  } finally {
    if (previousIntegrationEnv === undefined) delete process.env[FEATURE_INTEGRATION_TEST_ENV];
    else process.env[FEATURE_INTEGRATION_TEST_ENV] = previousIntegrationEnv;
    await cleanup(root.root);
  }
});
