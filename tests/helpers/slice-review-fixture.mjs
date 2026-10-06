import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../../src/fs-utils.mjs';
import { validateChange } from '../../src/change-format.mjs';
import { addTask, approveTask, initProject, resolveTaskPacket } from '../../src/controller.mjs';
const canonicalTmpdir = await realpath(tmpdir());
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

export async function runFixture({ otherSlice = false, integration = false, dependencies = false } = {}) {
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
  if (dependencies) {
    const checks = JSON.parse(sourceFiles['changes/change/slices/slice-one/checks.json']);
    checks.dependencyMounts = ['vendor'];
    sourceFiles['changes/change/slices/slice-one/checks.json'] = JSON.stringify(checks);
    sourceFiles['vendor/helper.mjs'] = 'export const dependency = true;\n';
  }
  if (integration) sourceFiles['tests/protected.test.mjs'] = "import assert from 'node:assert/strict';\nimport { entry } from '../src/entry.mjs';\nassert.equal(entry(), 'wired');\n";
  if (otherSlice) {
    const change = JSON.parse(sourceFiles['changes/change/change.json']);
    change.slices.push('changes/change/slices/slice-two/slice.json');
    change.integration.push({ id: 'integration-two', requirementIds: ['requirement-one'], entrypoints: ['src/other-entry.mjs'], wiringSlice: 'slice-two', testPaths: ['tests/protected.test.mjs'], checkIds: ['feature-check'] });
    sourceFiles['changes/change/change.json'] = JSON.stringify(change);
    const sliceOne = JSON.parse(sourceFiles['changes/change/slices/slice-one/slice.json']);
    const reviewTwo = { ...sliceOne.testReview, criteria: [{ ...sliceOne.testReview.criteria[0], interfaces: ['src/other-entry.mjs'], testPaths: ['tests/other.test.mjs'] }] };
    sourceFiles['changes/change/slices/slice-two/slice.json'] = JSON.stringify({ ...sliceOne, id: 'slice-two', brief: 'changes/change/slices/slice-two/brief.md', context: 'changes/change/slices/slice-two/context.json', checks: 'changes/change/slices/slice-two/checks.json', implementationFiles: ['src/other.mjs'], sliceTests: ['tests/other.test.mjs'], interfaces: ['src/other-entry.mjs'], testReview: reviewTwo });
    sourceFiles['changes/change/slices/slice-two/brief.md'] = briefText().replace('src/entry.mjs', 'src/other-entry.mjs').replace('tests/slice.test.mjs', 'tests/other.test.mjs');
    sourceFiles['changes/change/slices/slice-two/context.json'] = JSON.stringify({ schemaVersion: 1, facts: ['use entrypoint'], resources: [{ path: 'src/other-entry.mjs', startLine: 1, endLine: 1, purpose: 'entrypoint' }] });
    sourceFiles['changes/change/slices/slice-two/checks.json'] = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'slice-check', argv: ['node', 'tests/other.test.mjs'], criteria: ['C1'] }] });
    sourceFiles['src/other-entry.mjs'] = 'export function otherEntry() { return true; }\n';
  }
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
    feature: 'change-one',
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
  const sliceBytes = Buffer.from("import assert from 'node:assert/strict';\nimport { feature } from '../src/feature.mjs';\nassert.equal(feature, true);\n");
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

export async function makeWorkerRuntime() {
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
writeFileSync('tests/slice.test.mjs', ${JSON.stringify("import assert from 'node:assert/strict';\nimport { feature } from '../src/feature.mjs';\nassert.equal(feature, true);\nassert.equal(typeof feature, 'boolean');\n")});
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'changed approved files' }] } }));
`);
  await chmod(pi, 0o755);
  return {
    root: runtimeRoot,
    runtime: { test: true, piExecutable: pi, sourceAgentDir, sourceEnv: {} },
  };
}
