import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  MAX_ARTIFACT_FILE_BYTES,
  buildRegistrationPlan,
  parseApprovedBriefSections,
  parseChangeDocument,
  parseDeltaDocument,
  parseSliceDocument,
  validateChange,
} from '../src/change-format.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, 'examples', 'artifact-format');
const CANONICAL_TMP = await realpath(tmpdir());

async function fixtureProject() {
  const root = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-format-'));
  await cp(FIXTURE, join(root, 'examples', 'artifact-format'), { recursive: true });
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

function changeValue(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'change',
    proposal: 'changes/change/proposal.md',
    design: 'changes/change/design.md',
    specDeltas: ['changes/change/deltas/spec.json'],
    slices: ['changes/change/slices/one/slice.json'],
    budget: { maxImplementationFiles: 2, maxSliceTestFiles: 1, maxCompiledContextBytes: 65536 },
    featureTests: ['tests/feature.test.mjs'],
    featureChecks: 'changes/change/feature-checks.json',
    integration: [{ id: 'entrypoint', requirementIds: ['req'], entrypoints: ['src/entry.mjs'], wiringSlice: 'one', testPaths: ['tests/feature.test.mjs'], checkIds: ['feature'] }],
    ...overrides,
  };
}

test('parsers reject unknown keys, unsafe paths, duplicate paths, and malformed deltas', () => {
  const value = changeValue();
  assert.throws(() => parseChangeDocument(JSON.stringify({ ...value, extra: true })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseChangeDocument(JSON.stringify({ ...value, proposal: '../proposal.md' })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseChangeDocument(JSON.stringify({ ...value, slices: [...value.slices, value.slices[0]] })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseDeltaDocument(JSON.stringify({ schemaVersion: 1, spec: 'specs/x.md', baseSha256: null, changes: [{ operation: 'remove', id: 'req', text: null }] })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseSliceDocument(JSON.stringify({ schemaVersion: 1, id: 'one', brief: 'a.md', context: 'a.json', checks: 'a.json', implementationFiles: [], sliceTests: ['a.test.mjs'], protect: [], interfaces: ['a.mjs'], dependsOn: [], budget: { maxImplementationFiles: null, maxSliceTestFiles: null, maxCompiledContextBytes: null }, openDecisions: [], testReview: { schemaVersion: 1, workflow: 'slice-tests', criteria: [] } })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseSliceDocument(JSON.stringify({ schemaVersion: 1, id: 'one', brief: 'a.md', context: 'a.json', checks: 'a.json', implementationFiles: ['src/shared.mjs'], sliceTests: ['src/shared.mjs'], protect: [], interfaces: ['a.mjs'], dependsOn: [], budget: { maxImplementationFiles: null, maxSliceTestFiles: null, maxCompiledContextBytes: null }, openDecisions: [], testReview: { schemaVersion: 1, workflow: 'slice-tests', criteria: [{ id: 'c', requirementIds: ['req'], question: 'Assess.', interfaces: ['a.mjs'], testPaths: ['src/shared.mjs'] }] } })), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseChangeDocument(JSON.stringify({ ...value, proposal: '.env' })), { code: 'ARTIFACT_CREDENTIAL_PATH' });
});

test('approved brief sections parse as strict JSON blocks', () => {
  const text = [
    '# Brief',
    '',
    '## Slice test review contract',
    '',
    '```json',
    '{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"c","requirementIds":["req"],"question":"Assess it.","interfaces":["src/entry.mjs"],"testPaths":["tests/one.test.mjs"]}]}',
    '```',
    '',
    '## Approved slice requirements',
    '',
    '```json',
    '[{"spec":"specs/x.md","baseSha256":null,"operation":"add","id":"req","text":"A rule."}]',
    '```',
  ].join('\n');
  const parsed = parseApprovedBriefSections(text);
  assert.equal(parsed.testReview.criteria[0].id, 'c');
  assert.equal(parsed.requirements[0].id, 'req');
  assert.throws(() => parseApprovedBriefSections(text.replace('```json', '```text')), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseApprovedBriefSections([
    text,
    '## Slice test review contract',
    '',
    '```json',
    '{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"c","requirementIds":["req"],"question":"Assess it.","interfaces":["src/entry.mjs"],"testPaths":["tests/one.test.mjs"]}]}',
    '```',
  ].join('\n')), { code: 'ARTIFACT_FORMAT_INVALID' });
  const fencedHeading = [
    '# Brief',
    '',
    '```text',
    '## Slice test review contract',
    '## Approved slice requirements',
    '```',
    '',
    text.slice(text.indexOf('## Slice test review contract')),
  ].join('\n');
  assert.equal(parseApprovedBriefSections(fencedHeading).requirements[0].id, 'req');
});

test('known credential paths and UTF-8 BOMs are refused before ordinary reads', async () => {
  const root = await fixtureProject();
  try {
    const contextPath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/context.json');
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    context.resources[0].path = 'credentials.json';
    await writeFile(contextPath, JSON.stringify(context));
    await assert.rejects(validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'ARTIFACT_CREDENTIAL_PATH' });
  } finally {
    await cleanup(root);
  }

  const bomRoot = await fixtureProject();
  try {
    const proposal = join(bomRoot, 'examples/artifact-format/changes/broker-recut/proposal.md');
    await writeFile(proposal, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# proposal\n')]));
    await assert.rejects(validateChange(bomRoot, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'ARTIFACT_UTF8_BOM' });
  } finally {
    await cleanup(bomRoot);
  }
});

test('fixture validates with a topological plan and explicit legacy runtime scope', async () => {
  const root = await fixtureProject();
  try {
    const result = await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.deepEqual(result.slicesInOrder.map((slice) => slice.value.id), ['broker-s1', 'broker-s2', 'broker-s3', 'broker-s4', 'broker-s5a', 'broker-s5b']);
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.runtimeScope, { mode: 'legacy-allowlist', extraOrdinaryFiles: false, followUpIssue: 82 });
    assert.deepEqual(result.registrationPlan[0].allow, ['examples/artifact-format/src/s1-errors.mjs', 'examples/artifact-format/tests/s1-errors.test.mjs']);
    assert.equal(result.preparationIdentity.descriptorSetSha256.length, 64);
    await assert.rejects(readFile(join(root, '.tinysdd', 'runs', 'controller.json')), { code: 'ENOENT' });
  } finally {
    await cleanup(root);
  }
});

test('file-count budgets and planned ownership overlaps are warnings', async () => {
  const root = await fixtureProject();
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/slice.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf8'));
    slice.implementationFiles.push('examples/artifact-format/src/s1-extra.mjs');
    await writeFile(join(root, 'examples/artifact-format/src/s1-extra.mjs'), 'export const extra = true;\n');
    await writeFile(slicePath, JSON.stringify(slice));
    const changePath = join(root, 'examples/artifact-format/changes/broker-recut/change.json');
    const change = JSON.parse(await readFile(changePath, 'utf8'));
    change.budget.maxImplementationFiles = 1;
    await writeFile(changePath, JSON.stringify(change));
    const first = await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.ok(first.warnings.some((warning) => warning.code === 'IMPLEMENTATION_SIZING_EXCEEDED'));
    const secondPath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s2/slice.json');
    const second = JSON.parse(await readFile(secondPath, 'utf8'));
    second.implementationFiles = ['examples/artifact-format/src/s1-extra.mjs'];
    await writeFile(secondPath, JSON.stringify(second));
    const result = await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.ok(result.warnings.some((warning) => warning.code === 'EXPECTED_OUTPUT_OWNERSHIP_OVERLAP'));
  } finally {
    await cleanup(root);
  }
});

test('protected preparation overlap and compiled context budget remain hard failures', async () => {
  const root = await fixtureProject();
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/slice.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf8'));
    slice.implementationFiles = ['examples/artifact-format/tests/feature-integration.test.mjs'];
    await writeFile(slicePath, JSON.stringify(slice));
    await assert.rejects(validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'OUTPUT_PREPARATION_OVERLAP' });
    const clean = await fixtureProject();
    try {
      const changePath = join(clean, 'examples/artifact-format/changes/broker-recut/change.json');
      const change = JSON.parse(await readFile(changePath, 'utf8'));
      change.budget.maxCompiledContextBytes = 1;
      await writeFile(changePath, JSON.stringify(change));
      await assert.rejects(validateChange(clean, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'CONTEXT_BUDGET_EXCEEDED' });
    } finally {
      await cleanup(clean);
    }
  } finally {
    await cleanup(root);
  }
});

test('cited caller sources remain writable when they are not protected inputs', async () => {
  const root = await fixtureProject();
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s1/slice.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf8'));
    slice.implementationFiles.push('examples/artifact-format/src/entrypoint.mjs');
    await writeFile(slicePath, JSON.stringify(slice));
    const result = await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.equal(result.readiness.ready, true);
    assert.ok(result.registrationPlan.find((plan) => plan.id === 'broker-s1').allow.includes('examples/artifact-format/src/entrypoint.mjs'));
    assert.equal(result.files.has('examples/artifact-format/src/entrypoint.mjs'), false);
    assert.ok(result.sourceSnapshots.some((snapshot) => snapshot.path === 'examples/artifact-format/src/entrypoint.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('integration tests may be split across referenced checks, but unreferenced coverage is not enough', async () => {
  const root = await fixtureProject();
  try {
    const changePath = join(root, 'examples/artifact-format/changes/broker-recut/change.json');
    const checksPath = join(root, 'examples/artifact-format/changes/broker-recut/feature-checks.json');
    const change = JSON.parse(await readFile(changePath, 'utf8'));
    const checks = JSON.parse(await readFile(checksPath, 'utf8'));
    const first = change.featureTests[0];
    const second = 'examples/artifact-format/tests/feature-wiring.test.mjs';
    change.featureTests = [first, second];
    checks.checks = [
      { id: 'feature-a', argv: ['node', first], timeoutMs: 120000, criteria: ['C1'] },
      { id: 'feature-b', argv: ['node', second], timeoutMs: 120000, criteria: ['C1'] },
    ];
    change.integration[0].testPaths = [first, second];
    change.integration[0].checkIds = ['feature-a', 'feature-b'];
    await writeFile(changePath, JSON.stringify(change));
    await writeFile(checksPath, JSON.stringify(checks));
    assert.equal((await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json')).readiness.ready, true);

    checks.checks.push({ id: 'feature-unused', argv: ['node', second], timeoutMs: 120000, criteria: ['C1'] });
    change.integration[0].checkIds = ['feature-a'];
    await writeFile(changePath, JSON.stringify(change));
    await writeFile(checksPath, JSON.stringify(checks));
    const result = await validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.ok(result.readiness.issues.some((issue) => issue.code === 'INTEGRATION_TEST_NOT_CHECKED' && issue.message.includes(second)));
  } finally {
    await cleanup(root);
  }
});

test('bounded descriptor reads refuse oversized and symlinked inputs before parsing', async () => {
  const root = await fixtureProject();
  try {
    const proposal = join(root, 'examples/artifact-format/changes/broker-recut/proposal.md');
    await writeFile(proposal, Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1, 65));
    await assert.rejects(validateChange(root, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'ARTIFACT_READ_LIMIT' });
    const clean = await fixtureProject();
    try {
      const target = join(clean, 'examples/artifact-format/changes/broker-recut/proposal.md');
      const outside = join(clean, 'outside.md');
      await writeFile(outside, '# outside\n');
      await rm(target);
      await symlink(outside, target);
      await assert.rejects(validateChange(clean, 'examples/artifact-format/changes/broker-recut/change.json'), { code: 'SYMLINK_PATH' });
    } finally {
      await cleanup(clean);
    }
  } finally {
    await cleanup(root);
  }
});

test('buildRegistrationPlan is read-only and reports preparation identity', async () => {
  const root = await fixtureProject();
  try {
    const before = await readFile(join(root, 'examples/artifact-format/changes/broker-recut/change.json'), 'utf8');
    const plan = await buildRegistrationPlan(root, 'examples/artifact-format/changes/broker-recut/change.json');
    assert.equal(plan.registrationPlan.length, 6);
    assert.equal(plan.runtimeScope.extraOrdinaryFiles, false);
    assert.equal(await readFile(join(root, 'examples/artifact-format/changes/broker-recut/change.json'), 'utf8'), before);
    await assert.rejects(readFile(join(root, '.tinysdd', 'runs', 'controller.json')), { code: 'ENOENT' });
  } finally {
    await cleanup(root);
  }
});
