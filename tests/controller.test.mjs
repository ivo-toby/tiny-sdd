import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import {
  addTask,
  applyTask,
  approveTask,
  BEHAVIOR_SPLIT_THRESHOLDS,
  closeTask,
  controllerNext,
  controllerStatus,
  initProject,
  resolveBenchmarkPacket,
  resolveTaskPacket,
  reviewTask,
  supersedeTask,
} from '../src/controller.mjs';
import * as controller from '../src/controller.mjs';
import { compileContext } from '../src/context-compiler.mjs';
import { digestJson, sha256 } from '../src/fs-utils.mjs';
import { detectFilesystemAliases } from '../src/file-scope.mjs';

const { updateTask, createController } = controller;
const exec = promisify(execFile);
// Project roots may not resolve through a symlink, and tmpdir() does on macOS
// (/var -> /private/var), so temp dirs are built from the real path.
const canonicalTmpdir = await realpath(tmpdir());

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-controller-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
  await initProject(root);
  await mkdir(join(root, '.tinysdd', 'reviews'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), 'observed evidence\n');
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test('task approval, packet resolution, review, and acceptance are explicit', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/new-file.ts'] });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'pending_approval');
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.brief.text, '# Brief\n');
    assert.deepEqual(packet.runtimeScope, { mode: 'ordinary-create-modify', ordinaryCreateModify: true, deletions: false });
    assert.deepEqual(packet.allowedPaths, ['src/new-file.ts']);
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_ALREADY_ACCEPTED' });
  } finally {
    await cleanup(root);
  }
});

test('CLI review retains explicitly supplied candidate paths', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/planned.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'manual-extra.ts'), 'export const version = 1;\n');
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    await exec(process.execPath, [bin, '--project', root, 'task', 'review', '--id', 'one', '--verdict', 'accepted', '--evidence', '.tinysdd/reviews/evidence.md', '--by', 'reviewer', '--candidate-paths', 'src/manual-extra.ts']);
    assert.deepEqual((await rawState(root)).tasks.one.review.candidatePaths, ['src/manual-extra.ts', 'src/planned.ts']);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await writeFile(join(root, 'src', 'manual-extra.ts'), 'export const version = 2;\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale');
  } finally {
    await cleanup(root);
  }
});

test('preparation identity preserves an absent spec through approval and explicit reapproval', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'specs'), { recursive: true });
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/new-file.ts'], preparation: [{ path: 'specs/future.md', exists: false }] });
    assert.deepEqual((await rawState(root)).tasks.one.preparation, [{ path: 'specs/future.md', exists: false }]);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked absent future spec' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.deepEqual(packet.preparation, [{ path: 'specs/future.md', exists: false }]);
    assert.equal((await rawState(root)).tasks.one.protect, undefined);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');

    await writeFile(join(root, 'specs', 'future.md'), '# Future\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
    await approveTask(root, { id: 'one', by: 'operator', reason: 'recaptured current future spec' });
    const refreshed = await resolveTaskPacket(root, 'one');
    assert.equal(refreshed.preparation[0].exists, true);
    assert.equal(refreshed.preparation[0].sha256, sha256('# Future\n'));
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
  } finally {
    await cleanup(root);
  }
});

test('apply refuses task input aliases before writing on aliasing filesystems', async () => {
  const root = await project();
  const nfc = 'docs/caf\u00e9.md';
  const nfd = nfc.normalize('NFD');
  try {
    const aliases = await detectFilesystemAliases(root);
    await writeFile(join(root, ...nfc.split('/')), '# Brief\n');
    if (!aliases.unicodeInsensitive) await writeFile(join(root, ...nfd.split('/')), '# Brief\n');
    const observedAliases = await detectFilesystemAliases(root);
    await addTask(root, { id: 'one', brief: nfc, allow: ['src/a.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked input identity' });
    await fakeRun(root, RUN_ONE, { before: { [nfd]: '# Brief\n' }, after: { [nfd]: '# Rewritten\n' } });
    if (observedAliases.unicodeInsensitive === true) {
      await assert.rejects(apply(root), { code: 'APPLY_CHANGES_TASK_INPUT' });
      assert.equal(await readProject(root, nfc), '# Brief\n');
    } else if (observedAliases.unicodeInsensitive === false) {
      await apply(root);
      assert.equal(await readProject(root, nfd), '# Rewritten\n');
      assert.equal(await readProject(root, nfc), '# Brief\n');
    } else {
      await assert.rejects(apply(root), { code: 'APPLY_CHANGES_TASK_INPUT' });
      assert.equal(await readProject(root, nfc), '# Brief\n');
    }
  } finally {
    await cleanup(root);
  }
});

test('revision feedback is carried in the next packet without replacing the brief', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/new-file.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    await reviewTask(root, { id: 'one', verdict: 'revision', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.brief.text, '# Brief\n');
    assert.equal(packet.review.verdict, 'revision');
    assert.equal(packet.review.by, 'reviewer');
    assert.equal(packet.review.evidence.path, '.tinysdd/reviews/evidence.md');
    assert.equal(packet.review.evidence.text, 'observed evidence\n');
    assert.equal(packet.review.evidence.sha256.length, 64);
  } finally {
    await cleanup(root);
  }
});

test('allows task packets and review evidence only in dedicated controller artifact directories', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    await mkdir(join(root, '.tinysdd', 'reviews'), { recursive: true });
    await writeFile(join(root, '.tinysdd', 'tasks', 'one.md'), '# Controller task\n');
    await writeFile(join(root, '.tinysdd', 'reviews', 'one.md'), 'verified\n');
    await addTask(root, { id: 'one', brief: '.tinysdd/tasks/one.md', allow: ['src/new-file.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.brief.path, '.tinysdd/tasks/one.md');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/one.md', by: 'reviewer' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await assert.rejects(addTask(root, { id: 'bad', brief: '.tinysdd/config.json', allow: ['src/other.ts'] }), { code: 'INVALID_PATH' });
  } finally {
    await cleanup(root);
  }
});

test('context manifests are carried in packets and make approval stale when changed', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    const contextPath = join(root, '.tinysdd', 'tasks', 'one.context.json');
    await writeFile(contextPath, JSON.stringify({ schemaVersion: 1, facts: ['Keep the boundary.'], resources: [] }));
    await addTask(root, { id: 'one', brief: 'docs/brief.md', context: '.tinysdd/tasks/one.context.json', allow: ['src/new-file.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope and context' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.context.path, '.tinysdd/tasks/one.context.json');
    assert.match(packet.context.text, /Keep the boundary/u);
    await writeFile(contextPath, JSON.stringify({ schemaVersion: 1, facts: ['Changed boundary.'], resources: [] }));
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_NOT_READY' });
  } finally {
    await cleanup(root);
  }
});

test('selected context source changes also make approval stale', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'contract.ts'), 'export const boundary = 1;\n');
    await writeFile(join(root, '.tinysdd', 'tasks', 'one.context.json'), JSON.stringify({
      schemaVersion: 1,
      facts: [],
      resources: [{ path: 'src/contract.ts', startLine: 1, endLine: 1, purpose: 'Compatibility contract.' }],
    }));
    await addTask(root, { id: 'one', brief: 'docs/brief.md', context: '.tinysdd/tasks/one.context.json', allow: ['src/new-file.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked source context' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.context.compiledSha256.length, 64);
    await writeFile(join(root, 'src', 'contract.ts'), 'export const boundary = 2;\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
  } finally {
    await cleanup(root);
  }
});

const SHARED_SPEC = ['# Shared feature spec', 'A1 first rule', 'A2 second rule', 'A3 third rule', 'separator', 'B1 first rule', 'B2 second rule', 'B3 third rule', 'closing note'];

async function writeSharedSpec(root, lines = SHARED_SPEC) {
  await writeFile(join(root, 'docs', 'spec.md'), `${lines.join('\n')}\n`);
}

// One brief per slice; the shared spec is cited through the slice's manifest.
async function addSliceCitingSpec(root, id, startLine, endLine) {
  await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
  await writeFile(join(root, 'docs', `${id}.md`), `# Slice ${id}\n`);
  await writeFile(join(root, '.tinysdd', 'tasks', `${id}.context.json`), JSON.stringify({
    schemaVersion: 1,
    facts: [],
    resources: [{ path: 'docs/spec.md', startLine, endLine, purpose: `Rules for ${id}.` }],
  }));
  await addTask(root, { id, brief: `docs/${id}.md`, context: `.tinysdd/tasks/${id}.context.json`, allow: [`src/${id}.ts`] });
  await approveTask(root, { id, by: 'operator', reason: 'checked the brief and the cited spec lines' });
}

async function statusById(root) {
  return Object.fromEntries((await controllerStatus(root)).tasks.map((task) => [task.id, task.status]));
}

// Rewrites an approval the way a controller recorded it while the compiled
// text still carried a whole-file source digest per cited file.
async function makeApprovalLegacy(root, id) {
  const state = await rawState(root);
  const task = state.tasks[id];
  const text = await readFile(join(root, task.context), 'utf8');
  const compiled = await compileContext(root, { path: task.context, text, sha256: sha256(text) });
  const { approvalDigest, ...approvalBase } = task.approval;
  assert.equal(approvalBase.contextDigest, compiled.sha256);
  approvalBase.contextDigest = compiled.legacySha256;
  task.approval = { ...approvalBase, approvalDigest: digestJson(approvalBase) };
  await writeState(root, state);
  return { legacy: compiled.legacySha256, current: compiled.sha256 };
}

test('slices citing one shared spec go stale only when their own cited lines move or change', async () => {
  const root = await project();
  try {
    await writeSharedSpec(root);
    await addSliceCitingSpec(root, 'one', 2, 4);
    await addSliceCitingSpec(root, 'two', 6, 8);
    assert.deepEqual(await statusById(root), { one: 'ready', two: 'ready' });

    await writeSharedSpec(root, [...SHARED_SPEC, '', 'Addendum: a paragraph appended at the end.']);
    assert.deepEqual(await statusById(root), { one: 'ready', two: 'ready' });

    await writeSharedSpec(root, SHARED_SPEC.map((line) => (line === 'closing note' ? 'closing note, reworded' : line)));
    assert.deepEqual(await statusById(root), { one: 'ready', two: 'ready' });

    await writeSharedSpec(root, SHARED_SPEC.map((line) => (line === 'A2 second rule' ? 'A2 changed rule' : line)));
    assert.deepEqual(await statusById(root), { one: 'stale_approval', two: 'ready' });
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_NOT_READY' });
    assert.equal((await resolveTaskPacket(root, 'two')).taskId, 'two');

    // Citations are positional: a line inserted above both ranges shifts them.
    await writeSharedSpec(root, [SHARED_SPEC[0], 'inserted above both ranges', ...SHARED_SPEC.slice(1)]);
    assert.deepEqual(await statusById(root), { one: 'stale_approval', two: 'stale_approval' });
  } finally {
    await cleanup(root);
  }
});

test('an approval holding the legacy context digest stays fresh, still binds the whole file, and is replaced on re-approval', async () => {
  const root = await project();
  try {
    await writeSharedSpec(root);
    await addSliceCitingSpec(root, 'one', 2, 4);
    const { legacy, current } = await makeApprovalLegacy(root, 'one');
    assert.notEqual(legacy, current);
    assert.equal((await rawState(root)).tasks.one.approval.contextDigest, legacy);
    assert.deepEqual(await statusById(root), { one: 'ready' });

    // The packet and a benchmark replay each carry a digest the worker accepts.
    assert.equal((await resolveTaskPacket(root, 'one')).context.compiledSha256, current);
    assert.equal((await resolveBenchmarkPacket(root, 'one')).context.compiledSha256, legacy);

    // Legacy digests bound the whole file, so an uncited edit still stales them.
    await writeSharedSpec(root, SHARED_SPEC.map((line) => (line === 'B2 second rule' ? 'B2 changed rule' : line)));
    assert.deepEqual(await statusById(root), { one: 'stale_approval' });

    await approveTask(root, { id: 'one', by: 'operator', reason: 're-approved after the spec edit' });
    const approval = (await rawState(root)).tasks.one.approval;
    assert.equal(approval.contextDigest.length, 64);
    assert.notEqual(approval.contextDigest, legacy);
    assert.deepEqual(await statusById(root), { one: 'ready' });

    await writeSharedSpec(root, [...SHARED_SPEC, 'appended after re-approval']);
    assert.deepEqual(await statusById(root), { one: 'ready' });
  } finally {
    await cleanup(root);
  }
});

test('an accepted slice with a legacy context digest stays accepted, and a current one survives appending to its spec', async () => {
  const root = await project();
  try {
    await writeSharedSpec(root);
    await addSliceCitingSpec(root, 'legacy', 2, 4);
    await addSliceCitingSpec(root, 'current', 6, 8);
    await makeApprovalLegacy(root, 'legacy');
    for (const id of ['legacy', 'current']) {
      await reviewTask(root, { id, verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    }
    assert.deepEqual(await statusById(root), { legacy: 'accepted', current: 'accepted' });

    const appended = [...SHARED_SPEC, '', 'Addendum: a paragraph appended at the end.'];
    await writeSharedSpec(root, appended);
    // The legacy digest still binds the whole file, so only the current approval is unaffected.
    assert.deepEqual(await statusById(root), { legacy: 'stale', current: 'accepted' });

    await writeSharedSpec(root, appended.map((line) => (line === 'B1 first rule' ? 'B1 changed rule' : line)));
    assert.equal((await statusById(root)).current, 'stale');
  } finally {
    await cleanup(root);
  }
});

test('task add validates the context manifest before registering the task', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'contract.ts'), 'export const boundary = 1;\n');
    const manifest = join(root, '.tinysdd', 'tasks', 'one.context.json');
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, task: 'one', facts: [], resources: [] }));
    await assert.rejects(
      addTask(root, { id: 'one', brief: 'docs/brief.md', context: '.tinysdd/tasks/one.context.json', allow: ['src/new-file.ts'] }),
      { code: 'CONTEXT_MANIFEST_INVALID', message: /unknown key: task/u },
    );
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, facts: [], resources: [{ path: 'src/contract.ts', startLine: 1, endLine: 9, purpose: 'Out of range.' }] }));
    await assert.rejects(
      addTask(root, { id: 'one', brief: 'docs/brief.md', context: '.tinysdd/tasks/one.context.json', allow: ['src/new-file.ts'] }),
      { code: 'CONTEXT_MANIFEST_INVALID', message: /exceeds source/u },
    );
    assert.deepEqual((await controllerStatus(root)).tasks, []);
  } finally {
    await cleanup(root);
  }
});

test('task checks manifests are validated, approved, and carried in packets', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    const checksPath = '.tinysdd/tasks/one.checks.json';
    const checksText = JSON.stringify({
      schemaVersion: 1,
      dependencyMounts: ['node_modules'],
      checks: [{ id: 'unit', argv: ['node_modules/.bin/vitest', 'run'], timeoutMs: 5000, criteria: ['C1'] }],
    });
    await writeFile(join(root, ...checksPath.split('/')), checksText);
    const added = await addTask(root, { id: 'one', brief: 'docs/brief.md', checks: checksPath, allow: ['src/new-file.ts'] });
    assert.equal(added.task.checks, checksPath);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked declared checks' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.deepEqual(packet.runtimeScope, { mode: 'ordinary-create-modify', ordinaryCreateModify: true, deletions: false });
    assert.equal(packet.checks.path, checksPath);
    assert.equal(packet.checks.text, checksText);
    assert.equal(packet.checks.sha256, sha256(checksText));
    const benchmark = await resolveBenchmarkPacket(root, 'one');
    assert.deepEqual(benchmark.runtimeScope, { mode: 'ordinary-create-modify', ordinaryCreateModify: true, deletions: false });
    assert.equal(benchmark.checks.sha256, sha256(checksText));
    assert.equal((await controllerStatus(root)).tasks[0].checks, checksPath);
    await writeFile(join(root, ...checksPath.split('/')), `${checksText}\n`);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
    await assert.rejects(resolveBenchmarkPacket(root, 'one'), { code: 'STALE_BENCHMARK_CHECKS' });
  } finally {
    await cleanup(root);
  }
});

test('benchmark replay refuses every task shape change after approval', async () => {
  const cases = [
    ['allow', { allow: ['src/expanded.ts'] }],
    ['protect', { protect: [] }],
    ['context', { context: '' }],
    ['checks', { checks: '' }],
    ['depends-on', { dependsOn: ['dependency'] }],
  ];
  for (const [label, update] of cases) {
    const root = await project();
    try {
      await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'contract.ts'), 'export const boundary = 1;\n');
      await writeFile(join(root, '.tinysdd', 'tasks', 'one.context.json'), JSON.stringify({ schemaVersion: 1, facts: ['approved context'], resources: [] }));
      await writeFile(join(root, '.tinysdd', 'tasks', 'one.checks.json'), JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node', '--test'] }] }));
      await addTask(root, { id: 'dependency', brief: 'docs/brief.md', allow: ['src/dependency.ts'] });
      await addTask(root, {
        id: 'one',
        brief: 'docs/brief.md',
        context: '.tinysdd/tasks/one.context.json',
        checks: '.tinysdd/tasks/one.checks.json',
        allow: ['src/allowed.ts'],
        protect: ['src/contract.ts'],
      });
      await approveTask(root, { id: 'one', by: 'operator', reason: 'approved benchmark shape' });
      const approved = await resolveBenchmarkPacket(root, 'one');
      assert.deepEqual(approved.allowedPaths, ['src/allowed.ts'], label);
      assert.deepEqual(approved.protectedPaths, ['src/contract.ts'], label);
      assert.equal(approved.context.path, '.tinysdd/tasks/one.context.json', label);
      assert.equal(approved.checks.path, '.tinysdd/tasks/one.checks.json', label);

      await updateTask(root, { id: 'one', by: 'operator', reason: `change ${label}`, ...update });
      await assert.rejects(resolveBenchmarkPacket(root, 'one'), { code: 'STALE_BENCHMARK_SHAPE' }, label);
    } finally {
      await cleanup(root);
    }
  }
});

test('task add rejects invalid checks manifests without changing state', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    const valid = { schemaVersion: 1, dependencyMounts: ['node_modules'], checks: [{ id: 'unit', argv: ['node_modules/.bin/vitest'] }] };
    const invalidCases = [
      { name: 'unknown top-level key', value: { ...valid, extra: true }, message: /unknown key: extra/u },
      { name: 'unknown check key', value: { ...valid, checks: [{ ...valid.checks[0], extra: true }] }, message: /unknown key: extra/u },
      { name: 'string argv', value: { ...valid, checks: [{ id: 'unit', argv: 'node_modules/.bin/vitest' }] }, message: /argv must be an array, not a shell string/u },
      { name: 'argv outside mounts', value: { ...valid, checks: [{ id: 'unit', argv: ['scripts/test'] }] }, message: /inside a declared dependency mount/u },
      { name: 'argv traversal', value: { ...valid, checks: [{ id: 'unit', argv: ['node_modules/../bin/test'] }] }, message: /must not traverse/u },
      { name: 'duplicate id', value: { ...valid, checks: [{ id: 'unit', argv: ['node'] }, { id: 'unit', argv: ['node'] }] }, message: /duplicate id: unit/u },
      { name: 'bad criteria', value: { ...valid, checks: [{ id: 'unit', argv: ['node'], criteria: ['criterion'] }] }, message: /criteria must contain unique C<n> ids/u },
      { name: 'timeout out of range', value: { ...valid, checks: [{ id: 'unit', argv: ['node'], timeoutMs: 999 }] }, message: /timeoutMs must be an integer from 1000 to 600000/u },
      { name: 'empty checks', value: { ...valid, checks: [] }, message: /checks must contain between 1 and 16 items/u },
    ];
    for (const [index, invalidCase] of invalidCases.entries()) {
      const path = `.tinysdd/tasks/invalid-${index}.json`;
      await writeFile(join(root, ...path.split('/')), JSON.stringify(invalidCase.value));
      await assert.rejects(
        addTask(root, { id: `bad-${index}`, brief: 'docs/brief.md', checks: path, allow: ['src/new-file.ts'] }),
        (error) => {
          assert.equal(error.code, 'CHECKS_MANIFEST_INVALID', invalidCase.name);
          assert.match(error.message, invalidCase.message, invalidCase.name);
          return true;
        },
      );
      assert.deepEqual((await controllerStatus(root)).tasks, [], invalidCase.name);
    }
  } finally {
    await cleanup(root);
  }
});

test('old approvals without checks fields remain fresh for tasks without checks', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/new-file.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    const state = await rawState(root);
    delete state.tasks.one.approval.checks;
    delete state.tasks.one.approval.checksDigest;
    await writeState(root, state);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
  } finally {
    await cleanup(root);
  }
});

test('task add and approve report advisory sizing without blocking', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'tests', 'contract.test.ts'), `${Array.from({ length: 320 }, (_, index) => `// assertion ${index}`).join('\n')}\n`);
    await writeFile(join(root, '.tinysdd', 'tasks', 'big.context.json'), JSON.stringify({
      schemaVersion: 1,
      facts: [],
      resources: [{ path: 'tests/contract.test.ts', startLine: 1, endLine: 320, purpose: 'Fixed acceptance tests.' }],
    }));
    const allow = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const added = await addTask(root, { id: 'big', brief: 'docs/brief.md', context: '.tinysdd/tasks/big.context.json', allow });
    assert.equal(added.sizing.allowedFiles, 4);
    assert.equal(added.sizing.citedTestLines, 320);
    assert.equal(added.sizing.contextFacts, 0);
    assert.equal(added.sizing.citedResources, 1);
    assert.ok(added.sizing.compiledContextBytes > 0);
    assert.deepEqual(added.sizing.warnings.map((warning) => warning.split(' ')[0]), ['allowedFiles', 'citedTestLines']);
    const approved = await approveTask(root, { id: 'big', by: 'operator', reason: 'accepted the size risk' });
    assert.equal(approved.task.status, 'ready');
    assert.equal(approved.sizing.warnings.length, 2);
    const small = await addTask(root, { id: 'small', brief: 'docs/brief.md', allow: ['src/small.ts'] });
    assert.deepEqual(small.sizing.warnings, []);
  } finally {
    await cleanup(root);
  }
});

for (const [name, source, counts, reasonCount] of [
  ['fake timers with deferred promises', 'vi.useFakeTimers();\nPromise.withResolvers();', [1, 1, 0, 0], 1],
  ['fake timers with races', 't.mock.timers.enable({ apis: ["setTimeout"] });\nPromise.race([]);', [1, 0, 1, 0], 1],
  ['fake timers alone', 'vi.useFakeTimers();', [1, 0, 0, 0], 0],
  ['deferred promises and races without fake timers', 'deferred();\nPromise.race([]);', [0, 1, 1, 0], 0],
  ['eight ordering assertions', Array(8).fill('assert.deepEqual(events, []);').join('\n'), [0, 0, 0, 8], 1],
  ['seven ordering assertions', Array(7).fill('expect(callOrder).toEqual([]);').join('\n'), [0, 0, 0, 7], 0],
  ['both behavior split conditions', ['vi.useFakeTimers();', 'deferred();', ...Array(8).fill('assert.deepEqual(events, []);')].join('\n'), [1, 1, 0, 8], 2],
  ['plain synchronous tests', 'assert.equal(sum(1, 2), 3);', [0, 0, 0, 0], 0],
]) {
  test(`task sizing for ${name} remains advisory on add and approve`, async () => {
    const root = await project();
    try {
      await mkdir(join(root, 'tests'));
      await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
      await writeFile(join(root, 'tests', 'timers.test.ts'), `${source}\n`);
      const context = '.tinysdd/tasks/one.context.json';
      await writeFile(join(root, context), JSON.stringify({
        schemaVersion: 1, facts: [],
        resources: [{ path: 'tests/timers.test.ts', startLine: 1, endLine: source.split('\n').length, purpose: 'Acceptance tests.' }],
      }));
      const added = await addTask(root, { id: 'one', brief: 'docs/brief.md', context, allow: ['src/one.ts'] });
      assert.equal((await controllerStatus(root)).tasks[0].status, 'pending_approval');
      const approved = await approveTask(root, { id: 'one', by: 'operator', reason: 'reviewed the behavior split advice' });
      assert.equal(approved.task.status, 'ready');
      assert.deepEqual(added.sizing, approved.sizing);
      const sizing = approved.sizing;
      assert.deepEqual([sizing.citedFakeTimers, sizing.citedDeferredPromises, sizing.citedConcurrencyMarkers, sizing.citedOrderingAssertions], counts);
      assert.equal(sizing.behaviorSplit.recommended, reasonCount > 0);
      assert.equal(sizing.behaviorSplit.reasons.length, reasonCount);
      assert.equal(sizing.thresholds.citedOrderingAssertions, BEHAVIOR_SPLIT_THRESHOLDS.citedOrderingAssertions);
      assert.equal(sizing.warnings.length, reasonCount > 0 ? 1 : 0);
      if (reasonCount > 0) {
        assert.match(sizing.warnings[0], /behavior split recommended/u);
        assert.match(sizing.warnings[0], /separate the sequential core from the async edge, each with its own test file; fewer files alone will not help/u);
      } else {
        assert.deepEqual(sizing.warnings, []);
      }
    } finally {
      await cleanup(root);
    }
  });
}

test('allows an approved path below parent directories that do not exist yet', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'nested', brief: 'docs/brief.md', allow: ['src/new-module/file.mjs'] });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'pending_approval');
  } finally {
    await cleanup(root);
  }
});

test('rejects an existing directory as an allowed file path', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await assert.rejects(addTask(root, { id: 'directory', brief: 'docs/brief.md', allow: ['src'] }), { code: 'INVALID_FILE' });
  } finally {
    await cleanup(root);
  }
});

test('does not resolve an absent constructor-named task through Object.prototype', async () => {
  const root = await project();
  try {
    await assert.rejects(resolveTaskPacket(root, 'constructor'), { code: 'TASK_NOT_FOUND' });
  } finally {
    await cleanup(root);
  }
});

test('dependency acceptance becomes stale when evidence changes', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'first', brief: 'docs/brief.md', allow: ['src/first.ts'] });
    await approveTask(root, { id: 'first', by: 'operator', reason: 'scope' });
    await reviewTask(root, { id: 'first', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    await addTask(root, { id: 'second', brief: 'docs/brief.md', dependsOn: ['first'], allow: ['src/second.ts'] });
    await approveTask(root, { id: 'second', by: 'operator', reason: 'dependency accepted' });
    await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), 'changed evidence\n');
    const status = await controllerStatus(root);
    assert.equal(status.tasks.find((task) => task.id === 'first').status, 'stale');
    assert.equal(status.tasks.find((task) => task.id === 'second').status, 'blocked');
    await assert.rejects(resolveTaskPacket(root, 'second'), { code: 'TASK_NOT_READY' });
  } finally {
    await cleanup(root);
  }
});

test('approval becomes stale when the exact allowed-file list changes', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/first.ts'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'scope' });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.tasks.one.allow = ['src/changed.ts'];
    await writeFile(statePath, `${JSON.stringify(state)}\n`);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
  } finally {
    await cleanup(root);
  }
});

test('task paths reject traversal, wildcard, internal, and symlink escape', async (t) => {
  const root = await project();
  try {
    await assert.rejects(addTask(root, { id: 'bad', brief: '../brief.md', allow: ['src/a'] }), { code: 'INVALID_PATH' });
    await assert.rejects(addTask(root, { id: 'bad', brief: 'docs/brief.md', allow: ['src/*.ts'] }), { code: 'INVALID_PATH' });
    await assert.rejects(addTask(root, { id: 'bad', brief: 'docs/brief.md', allow: ['.tinysdd/state'] }), { code: 'INVALID_PATH' });
    try {
      await symlink('docs', join(root, 'link'));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(addTask(root, { id: 'bad', brief: 'docs/brief.md', allow: ['link/new.ts'] }), { code: 'SYMLINK_PATH' });
  } finally {
    await cleanup(root);
  }
});

test('malformed state is preserved and active mutation lock is rejected', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.tinysdd', 'runs'), { recursive: true });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    await writeFile(statePath, '{not-json');
    await assert.rejects(addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.ts'] }), { code: 'STATE_MALFORMED' });
    assert.equal(await readFile(statePath, 'utf8'), '{not-json');
    await rm(statePath);
    const lock = join(root, '.tinysdd', 'runs', 'controller.lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname() }));
    await assert.rejects(addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.ts'] }), { code: 'LOCKED' });
  } finally {
    await cleanup(root);
  }
});

test('stale lock metadata is reported without reclaiming the lock', async () => {
  const root = await project();
  try {
    const lock = join(root, '.tinysdd', 'runs', 'controller.lock');
    await mkdir(lock);
    const owner = { pid: 2147483647, hostname: hostname(), acquiredAt: new Date().toISOString() };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
    await assert.rejects(addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.ts'] }), { code: 'LOCK_STALE' });
    assert.deepEqual(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')), owner);
  } finally {
    await cleanup(root);
  }
});

test('malformed structured state is rejected without replacement', async () => {
  const root = await project();
  try {
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const malformed = JSON.stringify({ schemaVersion: 1, tasks: { bad: { id: 'bad', brief: '../bad.md', dependsOn: [], allow: [] } } });
    await writeFile(statePath, malformed);
    await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' });
    assert.equal(await readFile(statePath, 'utf8'), malformed);
  } finally {
    await cleanup(root);
  }
});

test('read operations reject a symlinked runs directory', async (t) => {
  const root = await project();
  try {
    const runs = join(root, '.tinysdd', 'runs');
    await rm(runs, { recursive: true, force: true });
    try {
      await symlink(root, runs, 'dir');
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(controllerStatus(root), { code: 'SYMLINK_PATH' });
  } finally {
    await cleanup(root);
  }
});

test('CLI emits one clean JSON result and never accepts automatically', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-cli-'));
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const result = await exec(process.execPath, [bin, 'init', '--project', root, '--json']);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ok, true);
    const status = await exec(process.execPath, [bin, '--json', '--project', root, 'status']);
    assert.equal(JSON.parse(status.stdout).data.tasks.length, 0);
  } finally {
    await cleanup(root);
  }
});

test('CLI exposes help and version without touching project state', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-cli-help-'));
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const help = await exec(process.execPath, [bin, '--help', '--json', '--project', root]);
    const helpResult = JSON.parse(help.stdout);
    assert.equal(helpResult.ok, true);
    assert.match(helpResult.data.help, /Usage:/u);
    const version = await exec(process.execPath, [bin, '--version']);
    assert.match(version.stdout, /^0\.1\.0\n$/u);
  } finally {
    await cleanup(root);
  }
});

test('next exposes a pending approval without advancing state', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.ts'] });
    const next = await controllerNext(root);
    assert.deepEqual(next.next, { action: 'pending_approval', taskId: 'one' });
  } finally {
    await cleanup(root);
  }
});

async function rawState(root) {
  return JSON.parse(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'));
}

async function writeState(root, state) {
  await writeFile(join(root, '.tinysdd', 'runs', 'controller.json'), `${JSON.stringify(state)}\n`);
}

const EVIDENCE = '.tinysdd/reviews/evidence.md';
const taskStatus = async (root, id) => (await controllerStatus(root)).tasks.find((task) => task.id === id).status;

async function addOpenTask(root, id, options = {}) {
  await addTask(root, { id, brief: 'docs/brief.md', allow: [`src/${id}.ts`], ...options });
}

async function addApprovedTask(root, id, options = {}) {
  await addOpenTask(root, id, options);
  await approveTask(root, { id, by: 'operator', reason: 'scope' });
}

test('close retires stale_approval, ready and pending_approval tasks and next skips them', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'docs', 'old.md'), '# Old\n');
    await addApprovedTask(root, 'stale', { brief: 'docs/old.md' });
    await writeFile(join(root, 'docs', 'old.md'), '# Old, re-cut\n');
    await addApprovedTask(root, 'ready');
    await addOpenTask(root, 'pending');
    await addOpenTask(root, 'open');
    assert.equal(await taskStatus(root, 'stale'), 'stale_approval');
    assert.equal(await taskStatus(root, 'ready'), 'ready');
    assert.equal(await taskStatus(root, 'pending'), 'pending_approval');
    assert.deepEqual((await controllerNext(root)).next, { action: 'stale_approval', taskId: 'stale' });
    const closed = await closeTask(root, { id: 'stale', by: 'operator', reason: 'abandoned' });
    assert.equal(closed.task.status, 'closed');
    assert.deepEqual(Object.keys(closed.task.closure).sort(), ['by', 'closedAt', 'kind', 'reason']);
    assert.equal(closed.task.closure.kind, 'closed');
    assert.equal(closed.task.closure.by, 'operator');
    assert.equal(closed.task.closure.reason, 'abandoned');
    assert.match(closed.task.closure.closedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.deepEqual((await controllerNext(root)).next, { action: 'ready', taskId: 'ready' });
    assert.equal((await closeTask(root, { id: 'ready', by: 'operator', reason: 'abandoned' })).task.status, 'closed');
    assert.deepEqual((await controllerNext(root)).next, { action: 'pending_approval', taskId: 'pending' });
    assert.equal((await closeTask(root, { id: 'pending', by: 'operator', reason: 'abandoned' })).task.status, 'closed');
    assert.deepEqual((await controllerNext(root)).next, { action: 'pending_approval', taskId: 'open' });
    assert.equal(await taskStatus(root, 'open'), 'pending_approval');
    await closeTask(root, { id: 'open', by: 'operator', reason: 'abandoned' });
    assert.equal((await controllerNext(root)).next, null);
    const state = await rawState(root);
    assert.equal(state.tasks.stale.closure.kind, 'closed');
    assert.equal(state.tasks.stale.closure.supersededBy, undefined);
  } finally {
    await cleanup(root);
  }
});

test('close is refused while open tasks depend on it and lists them', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'base');
    await addOpenTask(root, 'zeta', { dependsOn: ['base'] });
    await addOpenTask(root, 'alpha', { dependsOn: ['base'] });
    await assert.rejects(
      closeTask(root, { id: 'base', by: 'operator', reason: 'abandoned' }),
      (error) => {
        assert.equal(error.code, 'TASK_HAS_DEPENDENTS');
        assert.match(error.message, /alpha, zeta/u);
        assert.deepEqual(error.details.dependents, ['alpha', 'zeta']);
        return true;
      },
    );
    assert.equal(await taskStatus(root, 'base'), 'pending_approval');
    await closeTask(root, { id: 'zeta', by: 'operator', reason: 'abandoned' });
    await assert.rejects(closeTask(root, { id: 'base', by: 'operator', reason: 'abandoned' }), (error) => {
      assert.equal(error.code, 'TASK_HAS_DEPENDENTS');
      assert.deepEqual(error.details.dependents, ['alpha']);
      return true;
    });
    await assert.rejects(supersedeTask(root, { id: 'alpha', with: 'zeta', by: 'operator', reason: 're-cut' }), { code: 'TASK_CLOSED' });
    await closeTask(root, { id: 'alpha', by: 'operator', reason: 'abandoned' });
    assert.equal((await closeTask(root, { id: 'base', by: 'operator', reason: 'abandoned' })).task.status, 'closed');
  } finally {
    await cleanup(root);
  }
});

test('close refuses an accepted task but retires a stale one', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'one');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    await assert.rejects(closeTask(root, { id: 'one', by: 'operator', reason: 'abandoned' }), { code: 'TASK_ACCEPTED' });
    await assert.rejects(supersedeTask(root, { id: 'one', with: 'two', by: 'operator', reason: 're-cut' }), { code: 'TASK_NOT_FOUND' });
    await addOpenTask(root, 'two');
    await assert.rejects(supersedeTask(root, { id: 'one', with: 'two', by: 'operator', reason: 're-cut' }), { code: 'TASK_ACCEPTED' });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
    await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), 'changed evidence\n');
    assert.equal(await taskStatus(root, 'one'), 'stale');
    assert.equal((await closeTask(root, { id: 'one', by: 'operator', reason: 'abandoned' })).task.status, 'closed');
  } finally {
    await cleanup(root);
  }
});

test('close validates its arguments and refuses a task that is already retired', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'one');
    await assert.rejects(closeTask(root, { id: 'one', reason: 'abandoned' }), { code: 'INVALID_ARGUMENT', message: /by/u });
    await assert.rejects(closeTask(root, { id: 'one', by: 'operator' }), { code: 'INVALID_ARGUMENT', message: /reason/u });
    await assert.rejects(closeTask(root, { id: 'one', by: ' ', reason: 'abandoned' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(closeTask(root, { id: 'missing', by: 'operator', reason: 'abandoned' }), { code: 'TASK_NOT_FOUND' });
    await assert.rejects(closeTask(root, { id: 'constructor', by: 'operator', reason: 'abandoned' }), { code: 'TASK_NOT_FOUND' });
    assert.equal(await taskStatus(root, 'one'), 'pending_approval');
    await closeTask(root, { id: 'one', by: 'operator', reason: 'abandoned' });
    await assert.rejects(closeTask(root, { id: 'one', by: 'operator', reason: 'again' }), { code: 'TASK_CLOSED', message: 'task one is closed' });
    await assert.rejects(supersedeTask(root, { id: 'one', with: 'one', by: 'operator', reason: 'again' }), { code: 'TASK_CLOSED' });
    assert.equal((await rawState(root)).tasks.one.closure.reason, 'abandoned');
  } finally {
    await cleanup(root);
  }
});

test('supersede records deduplicated successors that status exposes under closure', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'broker');
    await addOpenTask(root, 's1');
    await addOpenTask(root, 's2');
    const result = await supersedeTask(root, { id: 'broker', with: 's1,s2, s1', by: 'operator', reason: 're-cut into slices' });
    assert.equal(result.task.status, 'superseded');
    assert.equal(result.task.closure.kind, 'superseded');
    assert.deepEqual(result.task.closure.supersededBy, ['s1', 's2']);
    const listed = (await controllerStatus(root)).tasks.find((task) => task.id === 'broker');
    assert.equal(listed.status, 'superseded');
    assert.equal(listed.closure.by, 'operator');
    assert.equal(listed.closure.reason, 're-cut into slices');
    assert.deepEqual(listed.closure.supersededBy, ['s1', 's2']);
    assert.deepEqual((await controllerNext(root)).next, { action: 'pending_approval', taskId: 's1' });
    assert.deepEqual((await rawState(root)).tasks.broker.closure.supersededBy, ['s1', 's2']);
    await addOpenTask(root, 'array-form');
    const viaArray = await supersedeTask(root, { id: 'array-form', with: ['s2', 's1'], by: 'operator', reason: 're-cut' });
    assert.deepEqual(viaArray.task.closure.supersededBy, ['s2', 's1']);
  } finally {
    await cleanup(root);
  }
});

test('supersede refuses unknown, self and retired successors and an empty list', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'old');
    await addOpenTask(root, 'gone');
    await closeTask(root, { id: 'gone', by: 'operator', reason: 'abandoned' });
    await addOpenTask(root, 'fresh');
    const args = { id: 'old', by: 'operator', reason: 're-cut' };
    await assert.rejects(supersedeTask(root, { ...args, with: 'fresh,nowhere' }), { code: 'TASK_NOT_FOUND', message: /nowhere/u });
    await assert.rejects(supersedeTask(root, { ...args, with: 'fresh,old' }), { code: 'INVALID_ARGUMENT', message: /itself/u });
    await assert.rejects(supersedeTask(root, { ...args, with: 'fresh,gone' }), { code: 'TASK_CLOSED', message: 'task gone is closed' });
    await assert.rejects(supersedeTask(root, { ...args, with: [] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(supersedeTask(root, { ...args, with: '' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(supersedeTask(root, { ...args }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(supersedeTask(root, { ...args, with: 'Not An Id' }), { code: 'INVALID_TASK_ID' });
    await assert.rejects(supersedeTask(root, { ...args, with: 'fresh', by: undefined }), { code: 'INVALID_ARGUMENT' });
    assert.equal(await taskStatus(root, 'old'), 'pending_approval');
    assert.equal((await supersedeTask(root, { ...args, with: 'fresh' })).task.status, 'superseded');
    await assert.rejects(supersedeTask(root, { id: 'fresh', with: 'old', by: 'operator', reason: 'loop' }), { code: 'TASK_CLOSED', message: 'task old is superseded by fresh' });
  } finally {
    await cleanup(root);
  }
});

test('a retired task cannot be approved, reviewed or dispatched, or become a new dependency', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'old');
    await addOpenTask(root, 'slice');
    await supersedeTask(root, { id: 'old', with: 'slice', by: 'operator', reason: 're-cut' });
    const refused = { code: 'TASK_CLOSED', message: 'task old is superseded by slice' };
    await assert.rejects(approveTask(root, { id: 'old', by: 'operator', reason: 'again' }), refused);
    await assert.rejects(reviewTask(root, { id: 'old', verdict: 'blocked', evidence: EVIDENCE, by: 'reviewer' }), refused);
    await assert.rejects(reviewTask(root, { id: 'old', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' }), refused);
    await assert.rejects(resolveTaskPacket(root, 'old'), refused);
    await assert.rejects(addTask(root, { id: 'late', brief: 'docs/brief.md', allow: ['src/late.ts'], dependsOn: ['old'] }), { code: 'DEPENDENCY_CLOSED', message: /superseded by slice/u });
    await assert.rejects(addTask(root, { id: 'late', brief: 'docs/brief.md', allow: ['src/late.ts'], dependsOn: ['slice', 'old'] }), { code: 'DEPENDENCY_CLOSED' });
    assert.equal(Object.hasOwn((await rawState(root)).tasks, 'late'), false);
    // Historical replays keep working: the original approval is the benchmark packet.
    assert.equal((await resolveBenchmarkPacket(root, 'old')).taskId, 'old');
    await addOpenTask(root, 'plain');
    await closeTask(root, { id: 'plain', by: 'operator', reason: 'abandoned' });
    await assert.rejects(approveTask(root, { id: 'plain', by: 'operator', reason: 'again' }), { code: 'TASK_CLOSED', message: 'task plain is closed' });
    assert.equal((await rawState(root)).tasks.old.review, undefined);
  } finally {
    await cleanup(root);
  }
});

test('a retired task never satisfies a dependency, even with a current acceptance', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'first');
    await reviewTask(root, { id: 'first', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    await addApprovedTask(root, 'second', { dependsOn: ['first'] });
    assert.equal(await taskStatus(root, 'second'), 'ready');
    // The commands refuse this; only a hand-edited state reaches it.
    const state = await rawState(root);
    state.tasks.first.closure = { kind: 'closed', by: 'operator', reason: 'edited', closedAt: '2026-01-01T00:00:00.000Z' };
    await writeState(root, state);
    const status = await controllerStatus(root);
    assert.equal(status.tasks.find((task) => task.id === 'first').status, 'closed');
    const second = status.tasks.find((task) => task.id === 'second');
    assert.equal(second.status, 'blocked');
    assert.deepEqual(second.blockedBy, ['first']);
    await assert.rejects(resolveTaskPacket(root, 'second'), { code: 'TASK_NOT_READY' });
  } finally {
    await cleanup(root);
  }
});

test('controller state validates the closure shape and still accepts tasks without one', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'one');
    const valid = { kind: 'closed', by: 'operator', reason: 'abandoned', closedAt: '2026-01-01T00:00:00.000Z' };
    const superseded = { ...valid, kind: 'superseded', supersededBy: ['two'] };
    const cases = [
      { kind: 'gone' },
      { ...valid, kind: 'gone' },
      { ...valid, kind: undefined },
      { ...valid, by: '' },
      { ...valid, by: undefined },
      { ...valid, reason: ' ' },
      { ...valid, reason: 7 },
      { ...valid, closedAt: undefined },
      { ...valid, supersededBy: ['two'] },
      { ...valid, supersededBy: null },
      { ...superseded, supersededBy: undefined },
      { ...superseded, supersededBy: [] },
      { ...superseded, supersededBy: 'two' },
      { ...superseded, supersededBy: ['Bad Id'] },
      { ...superseded, supersededBy: [3] },
      null,
      'closed',
      ['closed'],
    ];
    for (const closure of cases) {
      const state = await rawState(root);
      state.tasks.one.closure = closure;
      await writeState(root, state);
      await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' }, JSON.stringify(closure));
    }
    // A malformed closure is never replaced by a later mutation.
    await assert.rejects(addTask(root, { id: 'other', brief: 'docs/brief.md', allow: ['src/other.ts'] }), { code: 'STATE_MALFORMED' });
    for (const closure of [valid, superseded]) {
      const state = await rawState(root);
      state.tasks.one.closure = closure;
      await writeState(root, state);
      assert.equal((await controllerStatus(root)).tasks[0].status, closure.kind);
    }
    const state = await rawState(root);
    delete state.tasks.one.closure;
    await writeState(root, state);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'pending_approval');
    assert.equal((await controllerStatus(root)).tasks[0].closure, undefined);
  } finally {
    await cleanup(root);
  }
});

test('status exposes a stable global slice DAG and renders applied runs', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'broker-s1', { feature: 'broker' });
    await approveTask(root, { id: 'broker-s1', by: 'operator', reason: 'scope' });
    await reviewTask(root, { id: 'broker-s1', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    await addApprovedTask(root, 'broker-s2', { feature: 'broker', dependsOn: ['broker-s1'] });
    await addOpenTask(root, 'broker-s3', { feature: 'broker', dependsOn: ['broker-s1'] });
    await addOpenTask(root, 'broker-s4', { feature: 'broker', dependsOn: ['broker-s2'] });
    await addOpenTask(root, 'broker-s5', { feature: 'broker', dependsOn: ['broker-s2', 'broker-s3', 'broker-s4'] });
    const state = await rawState(root);
    state.tasks['broker-s1'].applied = {
      runId: 'worker-2026-09-01T10-00-00-000Z-11111111',
      rootRunId: 'worker-2026-09-01T10-00-00-000Z-11111111',
      by: 'operator',
      appliedAt: '2026-09-01T10:00:00.000Z',
      files: [{ path: 'src/broker-s1.ts', change: 'created', status: 'written', sha256: '0'.repeat(64) }],
    };
    await writeState(root, state);
    const status = await controllerStatus(root);
    assert.deepEqual(Object.fromEntries(status.tasks.map((task) => [task.id, task.order])), {
      'broker-s1': 1,
      'broker-s2': 2,
      'broker-s3': 3,
      'broker-s4': 4,
      'broker-s5': 5,
    });
    assert.deepEqual(Object.fromEntries(status.tasks.map((task) => [task.id, task.dependents])), {
      'broker-s1': ['broker-s2', 'broker-s3'],
      'broker-s2': ['broker-s4', 'broker-s5'],
      'broker-s3': ['broker-s5'],
      'broker-s4': ['broker-s5'],
      'broker-s5': [],
    });
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    const human = await cli('status');
    assert.equal(human.stdout, [
      'broker-s1  accepted (applied from worker-2026-09-01T10-00-00-000Z-11111111)',
      '├─ broker-s2  ready',
      '│  ├─ broker-s4  blocked (requires broker-s2)',
      '│  └─ broker-s5  blocked (requires broker-s2, broker-s3, broker-s4)',
      '└─ broker-s3  pending_approval',
      '',
    ].join('\n'));
    const json = JSON.parse((await cli('--json', 'status')).stdout);
    assert.equal(json.data.tasks.find((task) => task.id === 'broker-s1').applied.runId, 'worker-2026-09-01T10-00-00-000Z-11111111');
  } finally {
    await cleanup(root);
  }
});

test('status uses lexical tie-breaks and feature filters preserve global order', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'b-root', { feature: 'other' });
    await addOpenTask(root, 'a-root', { feature: 'broker' });
    const status = await controllerStatus(root, { feature: 'broker' });
    assert.equal(status.feature, 'broker');
    assert.deepEqual(status.tasks.map((task) => ({ id: task.id, order: task.order })), [{ id: 'a-root', order: 1 }]);
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    assert.equal((await cli('status', '--feature', 'broker')).stdout, 'a-root  pending_approval\n');
    const json = JSON.parse((await cli('--json', 'status', '--feature', 'broker')).stdout);
    assert.equal(json.data.feature, 'broker');
    assert.deepEqual(json.data.tasks.map((task) => task.id), ['a-root']);
    assert.equal((await cli('status', '--feature', 'missing')).stdout, 'No tasks in feature missing.\n');
    const invalid = await cli('status', '--feature', 'Bad Name').catch((error) => error);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /^ERROR \[INVALID_FEATURE\]/u);
    const missing = await cli('status', '--feature').catch((error) => error);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^ERROR \[INVALID_ARGUMENT\] --feature requires a value$/mu);
    const next = await cli('next', '--feature', 'broker').catch((error) => error);
    assert.equal(next.code, 1);
    assert.match(next.stderr, /^ERROR \[INVALID_ARGUMENT\] unexpected argument: --feature$/mu);
  } finally {
    await cleanup(root);
  }
});

test('feature labels are optional, validate state, and do not stale approval', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'one');
    await approveTask(root, { id: 'one', by: 'operator', reason: 'scope' });
    const before = await controllerStatus(root);
    assert.equal(Object.hasOwn(before.tasks[0], 'feature'), false);
    assert.equal(before.tasks[0].order, 1);
    assert.deepEqual(before.tasks[0].dependents, []);
    const state = await rawState(root);
    state.tasks.one.feature = 'broker';
    await writeState(root, state);
    const relabeled = await controllerStatus(root);
    assert.equal(relabeled.tasks[0].feature, 'broker');
    assert.equal(relabeled.tasks[0].status, 'ready');
    state.tasks.one.feature = 'Bad Name';
    await writeState(root, state);
    await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' });
    await assert.rejects(addTask(root, { id: 'bad-feature', brief: 'docs/brief.md', allow: ['src/bad.ts'], feature: 'Bad Name' }), { code: 'INVALID_FEATURE' });
  } finally {
    await cleanup(root);
  }
});

test('CLI supersede returns the closure as JSON and status prints how the task ended', async () => {
  const root = await project();
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    await cli('task', 'add', '--id', 'broker-contract', '--brief', 'docs/brief.md', '--allow', 'src/broker.ts');
    await cli('task', 'add', '--id', 'broker-s1', '--brief', 'docs/brief.md', '--allow', 'src/s1.ts');
    await cli('task', 'add', '--id', 'broker-s2', '--brief', 'docs/brief.md', '--allow', 'src/s2.ts');
    const superseded = await cli('--json', 'task', 'supersede', '--id', 'broker-contract', '--with', 'broker-s1,broker-s2', '--with', 'broker-s1', '--by', 'operator', '--reason', 're-cut into slices');
    assert.equal(superseded.stderr, '');
    const lines = superseded.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.task.status, 'superseded');
    const { closedAt, ...closure } = parsed.data.task.closure;
    assert.match(closedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(closure, { kind: 'superseded', by: 'operator', reason: 're-cut into slices', supersededBy: ['broker-s1', 'broker-s2'] });
    const status = await cli('status');
    assert.match(status.stdout, /^broker-contract: superseded by broker-s1, broker-s2$/mu);
    assert.match(status.stdout, /^broker-s1  pending_approval$/mu);
    assert.match(status.stdout, /^Closed or superseded:$/mu);
    assert.match(status.stdout, /^broker-contract: superseded by broker-s1, broker-s2$/mu);
    const next = await cli('next');
    assert.match(next.stdout, /^broker-contract: superseded by broker-s1, broker-s2$/mu);
    assert.match(next.stdout, /^Next: broker-s1 — pending_approval$/mu);
    const statusJson = JSON.parse((await cli('--json', 'status')).stdout);
    assert.equal(statusJson.data.tasks[0].closure.kind, 'superseded');
    const closed = await cli('task', 'close', '--id', 'broker-s2', '--by', 'operator', '--reason', 'dropped');
    assert.equal(closed.stdout, 'broker-s2: closed\n');
    const supersededHuman = await cli('task', 'supersede', '--id', 'broker-s1', '--with', 'broker-s2', '--by', 'operator', '--reason', 'x').catch((error) => error);
    assert.equal(supersededHuman.code, 1);
    assert.match(supersededHuman.stderr, /^ERROR \[TASK_CLOSED\] task broker-s2 is closed\n$/u);
    assert.match((await cli('--help')).stdout, /task supersede --id ID --with ID\[,ID\] --by LABEL --reason TEXT/u);
  } finally {
    await cleanup(root);
  }
});

test('CLI close fails cleanly without a reason and refuses a task that others depend on', async () => {
  const root = await project();
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    await cli('task', 'add', '--id', 'one', '--brief', 'docs/brief.md', '--allow', 'src/one.ts');
    await cli('task', 'add', '--id', 'two', '--brief', 'docs/brief.md', '--allow', 'src/two.ts', '--depends-on', 'one');
    const missing = await cli('task', 'close', '--id', 'one', '--by', 'operator').catch((error) => error);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /^ERROR \[INVALID_ARGUMENT\] closure reason must be nonempty\n$/u);
    const missingJson = await cli('--json', 'task', 'close', '--id', 'one', '--by', 'operator').catch((error) => error);
    assert.equal(missingJson.code, 1);
    assert.equal(missingJson.stderr, '');
    assert.deepEqual(JSON.parse(missingJson.stdout), { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'closure reason must be nonempty' } });
    const noWith = await cli('--json', 'task', 'supersede', '--id', 'one', '--by', 'operator', '--reason', 'x').catch((error) => error);
    assert.equal(JSON.parse(noWith.stdout).error.code, 'INVALID_ARGUMENT');
    const blocked = await cli('--json', 'task', 'close', '--id', 'one', '--by', 'operator', '--reason', 'x').catch((error) => error);
    assert.equal(blocked.code, 1);
    const error = JSON.parse(blocked.stdout).error;
    assert.equal(error.code, 'TASK_HAS_DEPENDENTS');
    assert.deepEqual(error.details.dependents, ['two']);
    const unknown = await cli('task', 'close', '--id', 'one', '--by', 'operator', '--reason', 'x', '--with', 'two').catch((e) => e);
    assert.match(unknown.stderr, /unknown option: --with/u);
    assert.equal((await rawState(root)).tasks.one.closure, undefined);
  } finally {
    await cleanup(root);
  }
});

const GATE_BRIEF = [
  '# Brief',
  '',
  '## Acceptance and checks',
  '',
  '| Situation | Expected result and preserved state | Source | Exact check |',
  '| --- | --- | --- | --- |',
  '| C1 | behavior one is demonstrated | brief | run tests |',
  '| C2 | behavior two is demonstrated | brief | inspect output |',
  '',
].join('\n');

const GATE_EVIDENCE = [
  '# Evidence',
  '',
  '## Checks',
  '',
  '- run tests: pass',
  '- inspect output: pass',
  '',
].join('\n');

async function gateProject(mode, { brief = GATE_BRIEF, evidence = GATE_EVIDENCE, thresholds } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-gate-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), brief);
  await initProject(root);
  const gate = { mode };
  if (thresholds !== undefined) gate.thresholds = thresholds;
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({ schemaVersion: 1, workers: {}, semanticGate: gate }));
  await mkdir(join(root, '.tinysdd', 'reviews'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), evidence);
  await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/new-file.ts'] });
  await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
  return root;
}

function judgeStub(answers, { fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) throw new Error('judge down');
    return { status: 200, json: async () => ({ answers }) };
  };
  return { calls, fetchImpl };
}

async function decisionLines(root) {
  const text = await readFile(join(root, '.tinysdd', 'runs', 'decisions', 'one.jsonl'), 'utf8');
  return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

async function controllerState(root) {
  return JSON.parse(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'));
}

test('shadow gate never blocks and logs ignored-shadow decisions', async () => {
  const root = await gateProject('shadow');
  try {
    const judge = judgeStub({ C1: { noul: 0.1 }, C2: { noul: 0.2 } });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const lines = await decisionLines(root);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.policyAction, 'ignored-shadow');
      assert.equal(line.gate, 'evidence-sufficiency');
      assert.equal(line.mode, 'shadow');
    }
    assert.equal(lines[0].questionId, 'C1');
    assert.equal(lines[0].band, 'block');
    assert.equal(lines[0].noul, 0.1);
    assert.equal(lines[1].questionId, 'C2');
    assert.equal(lines[1].noul, 0.2);
    const state = await controllerState(root);
    assert.equal(state.tasks.one.review.semanticGate, undefined);
  } finally {
    await cleanup(root);
  }
});

test('enforce gate blocks acceptance below the reject threshold without state change', async () => {
  const root = await gateProject('enforce');
  const stateBefore = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
  try {
    const judge = judgeStub({ C1: { noul: 0.3 }, C2: { noul: 0.9 } });
    await assert.rejects(
      reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } }),
      (error) => {
        assert.equal(error.code, 'SEMANTIC_GATE_REJECTED');
        assert.match(error.message, /C1/u);
        assert.deepEqual(error.details.criteria, [{ id: 'C1', noul: 0.3, band: 'block' }]);
        assert.deepEqual(error.details.thresholds, { accept: 0.75, reject: 0.4 });
        return true;
      },
    );
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), stateBefore);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    const lines = await decisionLines(root);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].policyAction, 'block');
    assert.equal(lines[1].policyAction, 'allow');
  } finally {
    await cleanup(root);
  }
});

test('enforce gate allows acceptance above the accept threshold and logs allow', async () => {
  const root = await gateProject('enforce');
  try {
    const judge = judgeStub({ C1: { noul: 0.9 }, C2: { noul: 0.8 } });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const state = await controllerState(root);
    assert.equal(state.tasks.one.review.semanticGate, undefined);
    assert.equal(typeof state.tasks.one.review.acceptanceDigest, 'string');
    const lines = await decisionLines(root);
    assert.deepEqual(lines.map((line) => line.policyAction), ['allow', 'allow']);
    assert.equal(lines[0].model, 'jev-latest');
    assert.match(lines[0].criterionDigest, /^[a-f0-9]{64}$/u);
  } finally {
    await cleanup(root);
  }
});

test('enforce gate records a confirm warning in the review between thresholds', async () => {
  const root = await gateProject('enforce');
  try {
    const judge = judgeStub({ C1: { noul: 0.55 }, C2: { noul: 0.9 } });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const state = await controllerState(root);
    assert.equal(state.tasks.one.review.semanticGate.mode, 'enforce');
    assert.equal(state.tasks.one.review.semanticGate.action, 'confirm');
    assert.equal(state.tasks.one.review.semanticGate.warnings.length, 1);
    assert.match(state.tasks.one.review.semanticGate.warnings[0], /C1 noul 0\.55/u);
    const lines = await decisionLines(root);
    assert.deepEqual(lines.map((line) => line.band), ['confirm', 'allow']);
    assert.deepEqual(lines.map((line) => line.policyAction), ['confirm', 'allow']);
  } finally {
    await cleanup(root);
  }
});

test('enforce gate does not call the judge or log decisions for a retired task', async () => {
  const root = await gateProject('enforce');
  try {
    await closeTask(root, { id: 'one', by: 'operator', reason: 're-cut' });
    const judge = judgeStub({ C1: { noul: 0.9 }, C2: { noul: 0.9 } });
    await assert.rejects(
      reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } }),
      { code: 'TASK_CLOSED' },
    );
    assert.equal(judge.calls.length, 0);
    await assert.rejects(readFile(join(root, '.tinysdd', 'runs', 'decisions', 'one.jsonl'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanup(root);
  }
});

test('an unavailable judge behaves exactly like off and logs semantic-judge-unavailable', async () => {
  const root = await gateProject('enforce');
  const originalKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const judge = judgeStub({}, { fail: true });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal(judge.calls.length, 2);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const state = await controllerState(root);
    assert.equal(state.tasks.one.review.semanticGate, undefined);
    const lines = await decisionLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].policyAction, 'semantic-judge-unavailable');
    assert.equal(lines[0].questionId, null);
    assert.equal(lines[0].criterionDigest, null);
    assert.equal(lines[0].noul, null);
    assert.equal(lines[0].band, null);
    assert.equal(lines[0].reason, 'JEV_NETWORK');
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    await cleanup(root);
  }
});

test('decision log records carry the fixed field set with digests only', async () => {
  const root = await gateProject('enforce');
  try {
    const judge = judgeStub({ C1: { noul: 0.9 }, C2: { noul: 0.8 } });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    const lines = await decisionLines(root);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).sort(), [
        'artifactDigests', 'band', 'criterionDigest', 'gate', 'mode', 'model',
        'modelVersion', 'noul', 'policyAction', 'questionId', 'taskId', 'timestamp',
      ]);
      assert.match(line.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      assert.equal(line.taskId, 'one');
      assert.equal(line.gate, 'evidence-sufficiency');
      assert.equal(line.model, 'jev-latest');
      assert.match(line.criterionDigest, /^[a-f0-9]{64}$/u);
      const rendered = JSON.stringify(line);
      assert.ok(!rendered.includes('behavior one'));
      assert.ok(!rendered.includes('run tests'));
    }
    assert.equal(lines[0].questionId, 'C1');
    assert.equal(lines[0].criterionDigest, sha256('behavior one is demonstrated | brief | run tests'));
    assert.deepEqual(lines[0].artifactDigests, { briefDigest: sha256(GATE_BRIEF), evidenceDigest: sha256(GATE_EVIDENCE) });
  } finally {
    await cleanup(root);
  }
});

test('evidence without a Checks section confirms without calling the judge', async () => {
  const root = await gateProject('enforce', { evidence: 'observed evidence\n' });
  try {
    const judge = judgeStub({});
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal(judge.calls.length, 0);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const state = await controllerState(root);
    assert.equal(state.tasks.one.review.semanticGate.action, 'confirm');
    assert.match(state.tasks.one.review.semanticGate.warnings[0], /## Checks section/u);
    const lines = await decisionLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].policyAction, 'confirm');
    assert.equal(lines[0].band, 'confirm');
    assert.equal(lines[0].noul, null);
    assert.equal(lines[0].questionId, null);
  } finally {
    await cleanup(root);
  }
});

test('a brief without C-prefixed rows confirms without calling the judge', async () => {
  const root = await gateProject('enforce', {
    brief: '# Brief\n\n## Acceptance and checks\n\n| Situation | Expected result |\n| --- | --- |\n| unnumbered | something observed |\n',
  });
  try {
    const judge = judgeStub({});
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal(judge.calls.length, 0);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    const lines = await decisionLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].policyAction, 'confirm');
    assert.equal(lines[0].band, 'confirm');
    assert.match(lines[0].reason, /C-prefixed/u);
  } finally {
    await cleanup(root);
  }
});

test('gate stays inactive for non-accepted verdicts and off mode', async () => {
  const root = await gateProject('enforce');
  try {
    const judge = judgeStub({});
    await reviewTask(root, { id: 'one', verdict: 'revision', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal(judge.calls.length, 0);
    assert.equal((await controllerStatus(root)).tasks[0].review.verdict, 'revision');
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({ schemaVersion: 1, workers: {} }));
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer', judge: { fetch: judge.fetchImpl, retryDelayMs: 0 } });
    assert.equal(judge.calls.length, 0);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await assert.rejects(readFile(join(root, '.tinysdd', 'runs', 'decisions', 'one.jsonl'), 'utf8'));
  } finally {
    await cleanup(root);
  }
});

// task apply: runs are faked on disk (result.json plus the two workspaces); no worker runs.
const RUN_ONE = 'worker-2026-09-01T10-00-00-000Z-11111111';
const RUN_TWO = 'worker-2026-09-01T11-00-00-000Z-22222222';
const RUN_OTHER = 'worker-2026-09-01T12-00-00-000Z-33333333';

async function writeTree(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

function changesBetween(before, after) {
  const fileIdentity = (value) => {
    if (value === undefined || value === null) return null;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { kind: 'file', sha256: sha256(bytes), size: bytes.byteLength };
  };
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((path) => {
    const was = before[path] ?? null;
    const now = after[path] ?? null;
    if (Buffer.isBuffer(was) && Buffer.isBuffer(now) ? was.equals(now) : was === now) return [];
    return [{ path, change: now === null ? 'deleted' : was === null ? 'created' : 'modified', before: fileIdentity(was), after: fileIdentity(now) }];
  });
}

// before/after map a project path to its content, or null for an absent file.
async function fakeRun(root, runId, { taskId = 'one', before = {}, after = {}, outcome = 'completed', scopeViolations = [], changedPaths, packet = 'capture', ...extra } = {}) {
  const directory = join(root, '.tinysdd', 'runs', runId);
  await writeTree(join(directory, 'workspace-before'), before);
  await writeTree(join(directory, 'workspace-after'), after);
  const retainedChanges = changesBetween(before, after);
  const claimedChanges = changedPaths === undefined
    ? retainedChanges
    : changedPaths.map((change) => ({
      ...change,
      ...(retainedChanges.find((entry) => entry.path === change.path) ?? {}),
      ...change,
    }));
  const snapshot = (files) => {
    const result = Object.create(null);
    for (const [path, value] of Object.entries(files)) {
      if (value === null) continue;
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join('/');
        result[directoryPath] ??= { kind: 'directory', sha256: null, size: null };
      }
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      result[path] = { kind: 'file', sha256: sha256(bytes), size: bytes.byteLength };
    }
    return result;
  };
  await writeFile(join(directory, 'before-snapshot.json'), JSON.stringify(snapshot(before)));
  await writeFile(join(directory, 'after-snapshot.json'), JSON.stringify(snapshot(after)));
  if (packet === 'capture') {
    await writeFile(join(directory, 'packet.json'), JSON.stringify(await resolveTaskPacket(root, taskId)));
  } else if (packet !== false) {
    await writeFile(join(directory, 'packet.json'), JSON.stringify(packet));
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({
    schemaVersion: 1, runId, taskId, outcome, changedPaths: claimedChanges, scopeViolations,
    fileScope: { mode: 'ordinary-create-modify', actualPaths: retainedChanges.map(({ path }) => path).sort(), ordinaryCreateModify: true, deletions: false },
    ...extra,
  }));
  return directory;
}

async function applyProject(files, allow = ['src/a.ts', 'src/b.ts']) {
  const root = await project();
  await writeTree(root, files);
  await addApprovedTask(root, 'one', { allow });
  return root;
}

const apply = (root, run = RUN_ONE, options = {}) => applyTask(root, { id: 'one', run, by: 'operator', ...options });
const readProject = (root, path) => readFile(join(root, ...path.split('/')), 'utf8');

async function assertNothingApplied(root, files) {
  assert.equal((await rawState(root)).tasks.one.applied, undefined);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await assert.rejects(readProject(root, path), { code: 'ENOENT' }, path);
    else assert.equal(await readProject(root, path), content, path);
  }
}

test('apply writes created and modified files, records the run and leaves the task ready', async () => {
  const root = await applyProject({ 'src/b.ts': 'old b\n' });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/b.ts': 'old b\n' }, after: { 'src/a.ts': 'new a\n', 'src/b.ts': 'new b\n' } });
    const result = await apply(root);
    assert.equal(await readProject(root, 'src/a.ts'), 'new a\n');
    assert.equal(await readProject(root, 'src/b.ts'), 'new b\n');
    assert.equal(result.task.status, 'ready');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    const { appliedAt, allowedDigest, ...record } = (await rawState(root)).tasks.one.applied;
    assert.match(allowedDigest, /^[0-9a-f]{64}$/u);
    assert.match(record.actualDigest, /^[0-9a-f]{64}$/u);
    assert.match(appliedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(record, {
      runId: RUN_ONE,
      rootRunId: RUN_ONE,
      by: 'operator',
      actualPaths: ['src/a.ts', 'src/b.ts'],
      actualDigest: record.actualDigest,
      files: [
        { path: 'src/a.ts', change: 'created', sha256: sha256('new a\n'), status: 'written' },
        { path: 'src/b.ts', change: 'modified', sha256: sha256('new b\n'), status: 'written' },
      ],
    });
    assert.deepEqual(result.applied, { ...record, appliedAt, allowedDigest });
    const publicApplied = (await controllerStatus(root)).tasks[0].applied;
    assert.deepEqual(publicApplied, { runId: RUN_ONE, appliedAt, files: 2 });

    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.deepEqual((await rawState(root)).tasks.one.review.appliedFromRun, { runId: RUN_ONE, identical: true });
    // Review binds exactly the digest apply recorded.
    assert.equal((await rawState(root)).tasks.one.review.allowedDigest, allowedDigest);
    assert.equal(await taskStatus(root, 'one'), 'accepted');
    assert.deepEqual((await controllerStatus(root)).tasks[0].review.appliedFromRun, { runId: RUN_ONE, identical: true });
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a run retained from before brief re-approval', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'old candidate\n' } });
    const runApprovalDigest = (await rawState(root)).tasks.one.approval.approvalDigest;
    await writeFile(join(root, 'docs', 'brief.md'), '# Brief, revised\n');
    await approveTask(root, { id: 'one', by: 'operator', reason: 're-approved revised brief' });
    const currentApprovalDigest = (await rawState(root)).tasks.one.approval.approvalDigest;
    assert.notEqual(runApprovalDigest, currentApprovalDigest);
    const stateBefore = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
    await assert.rejects(apply(root), (error) => {
      assert.equal(error.code, 'RUN_APPROVAL_MISMATCH');
      assert.deepEqual(error.details, { runId: RUN_ONE, runApprovalDigest, currentApprovalDigest });
      assert.match(error.message, new RegExp(runApprovalDigest, 'u'));
      assert.match(error.message, new RegExp(currentApprovalDigest, 'u'));
      assert.match(error.message, /dispatch a fresh run/u);
      return true;
    });
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), stateBefore);
    assert.equal(await readFile(join(root, 'docs', 'brief.md'), 'utf8'), '# Brief, revised\n');
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a run retained from before task update and re-approval', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'old candidate\n' } });
    const runApprovalDigest = (await rawState(root)).tasks.one.approval.approvalDigest;
    await updateTask(root, {
      id: 'one',
      by: 'operator',
      reason: 'expanded scope',
      allow: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    await approveTask(root, { id: 'one', by: 'operator', reason: 're-approved expanded scope' });
    const currentApprovalDigest = (await rawState(root)).tasks.one.approval.approvalDigest;
    assert.notEqual(runApprovalDigest, currentApprovalDigest);
    const stateBefore = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
    await assert.rejects(apply(root), (error) => {
      assert.equal(error.code, 'RUN_APPROVAL_MISMATCH');
      assert.deepEqual(error.details, { runId: RUN_ONE, runApprovalDigest, currentApprovalDigest });
      assert.match(error.message, /dispatch a fresh run/u);
      return true;
    });
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), stateBefore);
    await assertNothingApplied(root, { 'src/a.ts': null, 'src/b.ts': null, 'src/c.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a final packet with missing or mismatched approval digests', async () => {
  const cases = [
    {
      label: 'missing approval',
      edit(packet) {
        delete packet.approval;
      },
      runApprovalDigest: null,
    },
    {
      label: 'missing approval digest',
      edit(packet) {
        packet.approval = {};
      },
      runApprovalDigest: null,
    },
    {
      label: 'mismatched approval digest',
      edit(packet) {
        packet.approval.approvalDigest = 'f'.repeat(64);
      },
      runApprovalDigest: 'f'.repeat(64),
    },
    {
      label: 'missing current approval digest',
      editState(state) {
        delete state.tasks.one.approval.approvalDigest;
      },
      runApprovalDigest: 'current',
      currentApprovalDigest: null,
    },
  ];
  for (const currentCase of cases) {
    const root = await applyProject({});
    try {
      const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'candidate\n' } });
      const packetPath = join(directory, 'packet.json');
      const packet = JSON.parse(await readFile(packetPath, 'utf8'));
      const originalCurrentDigest = (await rawState(root)).tasks.one.approval.approvalDigest;
      if (currentCase.edit) {
        currentCase.edit(packet);
        await writeFile(packetPath, JSON.stringify(packet));
      } else {
        const state = await rawState(root);
        currentCase.editState(state);
        await writeState(root, state);
      }
      const stateBefore = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
      const expectedRunDigest = currentCase.runApprovalDigest === 'current' ? originalCurrentDigest : currentCase.runApprovalDigest;
      const expectedCurrentDigest = Object.hasOwn(currentCase, 'currentApprovalDigest')
        ? currentCase.currentApprovalDigest
        : originalCurrentDigest;
      await assert.rejects(apply(root), (error) => {
        assert.equal(error.code, 'RUN_APPROVAL_MISMATCH', currentCase.label);
        assert.deepEqual(error.details, {
          runId: RUN_ONE,
          runApprovalDigest: expectedRunDigest,
          currentApprovalDigest: expectedCurrentDigest,
        }, currentCase.label);
        assert.match(error.message, /run .* approval digest/u, currentCase.label);
        assert.match(error.message, /current task one approval digest/u, currentCase.label);
        assert.match(error.message, /dispatch a fresh run/u, currentCase.label);
        return true;
      }, currentCase.label);
      assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), stateBefore, currentCase.label);
      await assertNothingApplied(root, { 'src/a.ts': null });
    } finally {
      await cleanup(root);
    }
  }
});

test('apply refuses malformed or unsafe final packets before writing', async (t) => {
  const root = await applyProject({});
  try {
    const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'candidate\n' } });
    const stateBefore = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
    await writeFile(join(directory, 'packet.json'), '{not json');
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), stateBefore);
    await assertNothingApplied(root, { 'src/a.ts': null });

    await writeFile(join(directory, 'packet.json'), JSON.stringify([]));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    await assertNothingApplied(root, { 'src/a.ts': null });

    await rm(join(directory, 'packet.json'));
    try {
      await symlink(join(directory, 'result.json'), join(directory, 'packet.json'));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('an edit between apply and review is allowed and recorded as not identical', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'new a\n', 'src/b.ts': 'new b\n' } });
    await apply(root);
    await writeFile(join(root, 'src', 'b.ts'), 'edited during review\n');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.deepEqual((await rawState(root)).tasks.one.review.appliedFromRun, { runId: RUN_ONE, identical: false });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('identical covers every allowed file, including ones the run did not change', async () => {
  const files = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' };
  const run = { before: files, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b0\n' } };
  const identicalAfter = async (edit) => {
    const root = await applyProject(files);
    try {
      await fakeRun(root, RUN_ONE, run);
      await apply(root);
      await edit(root);
      await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
      assert.equal(await taskStatus(root, 'one'), 'accepted');
      return (await rawState(root)).tasks.one.review.appliedFromRun.identical;
    } finally {
      await cleanup(root);
    }
  };
  assert.equal(await identicalAfter(async () => {}), true);
  assert.equal(await identicalAfter((root) => writeFile(join(root, 'src', 'b.ts'), 'b edited\n')), false);
  assert.equal(await identicalAfter((root) => writeFile(join(root, 'src', 'a.ts'), 'a edited\n')), false);
  assert.equal(await identicalAfter((root) => rm(join(root, 'src', 'b.ts'))), false);
});

test('identical is not fooled by a run that changed nothing', async () => {
  const files = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' };
  for (const [edited, expected] of [[false, true], [true, false]]) {
    const root = await applyProject(files);
    try {
      await fakeRun(root, RUN_ONE, { before: files, after: files });
      const { applied } = await apply(root);
      assert.deepEqual(applied.files, []);
      if (edited) await writeFile(join(root, 'src', 'a.ts'), 'a edited\n');
      await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
      assert.equal((await rawState(root)).tasks.one.review.appliedFromRun.identical, expected);
    } finally {
      await cleanup(root);
    }
  }
});

test('a record without allowedDigest falls back to comparing the files it wrote', async () => {
  const files = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' };
  for (const [edited, expected] of [[false, true], [true, false]]) {
    const root = await applyProject(files);
    try {
      await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b0\n' } });
      await apply(root);
      const state = await rawState(root);
      delete state.tasks.one.applied.allowedDigest;
      await writeState(root, state);
      if (edited) await writeFile(join(root, 'src', 'a.ts'), 'a edited\n');
      await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
      assert.equal((await rawState(root)).tasks.one.review.appliedFromRun.identical, expected);
    } finally {
      await cleanup(root);
    }
  }
});

test('a revision review records appliedFromRun and spends the applied record; blocked leaves it', async () => {
  const revised = await applyProject({});
  try {
    await fakeRun(revised, RUN_ONE, { after: { 'src/a.ts': 'new a\n' } });
    await apply(revised);
    await writeFile(join(revised, 'src', 'a.ts'), 'edited before the verdict\n');
    await reviewTask(revised, { id: 'one', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' });
    const task = (await rawState(revised)).tasks.one;
    assert.deepEqual(task.review.appliedFromRun, { runId: RUN_ONE, identical: false });
    assert.equal(task.review.acceptanceDigest, undefined);
    assert.equal(task.applied, undefined);
    assert.equal((await controllerStatus(revised)).tasks[0].applied, undefined);
    assert.deepEqual((await controllerStatus(revised)).tasks[0].review.appliedFromRun, { runId: RUN_ONE, identical: false });
    assert.equal(await taskStatus(revised, 'one'), 'ready');
  } finally {
    await cleanup(revised);
  }
  const blocked = await applyProject({});
  try {
    await fakeRun(blocked, RUN_ONE, { after: { 'src/a.ts': 'new a\n' } });
    await apply(blocked);
    await reviewTask(blocked, { id: 'one', verdict: 'blocked', evidence: EVIDENCE, by: 'reviewer' });
    const task = (await rawState(blocked)).tasks.one;
    assert.equal(task.applied.runId, RUN_ONE);
    assert.equal(task.review.appliedFromRun, undefined);
  } finally {
    await cleanup(blocked);
  }
});

// Task `one` allows src/a.ts only. Its context cites line 1 of src/a.ts (allowed)
// and, when asked, of src/other.ts (not allowed). The fake run rewrites src/a.ts.
async function contextApplyProject({ citeAllowed = true, citeOther = false, start = 'one\n', candidate = 'two\n' } = {}) {
  const root = await project();
  await writeTree(root, { 'src/a.ts': start, 'src/other.ts': 'ctx\n' });
  await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
  const cited = [...(citeAllowed ? ['src/a.ts'] : []), ...(citeOther ? ['src/other.ts'] : [])];
  await writeFile(join(root, '.tinysdd', 'tasks', 'one.context.json'), JSON.stringify({
    schemaVersion: 1,
    facts: [],
    resources: cited.map((path) => ({ path, startLine: 1, endLine: 1, purpose: `Rules in ${path}.` })),
  }));
  await addApprovedTask(root, 'one', { allow: ['src/a.ts'], context: '.tinysdd/tasks/one.context.json' });
  await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': start }, after: { 'src/a.ts': candidate } });
  return root;
}

test('applying a run that rewrites a cited allowed file keeps the approval current, and review accepts', async () => {
  const root = await contextApplyProject();
  try {
    const approved = (await rawState(root)).tasks.one.approval.contextDigest;
    await apply(root);
    assert.equal(await readProject(root, 'src/a.ts'), 'two\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    assert.equal((await controllerStatus(root)).tasks[0].approval.current, true);
    assert.equal((await rawState(root)).tasks.one.approval.contextDigest, approved);
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    const task = (await rawState(root)).tasks.one;
    assert.deepEqual(task.review.appliedFromRun, { runId: RUN_ONE, identical: true });
    assert.equal(task.applied.runId, RUN_ONE);
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('after apply the approval still binds the starting context: outside edits stale it, allowed-file edits do not', async () => {
  const root = await contextApplyProject({ citeOther: true });
  try {
    await apply(root);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    // The allowed file is the candidate now; editing it by hand is review's business, not the approval's.
    await writeFile(join(root, 'src', 'a.ts'), 'edited by hand\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await writeFile(join(root, 'src', 'other.ts'), 'ctx, changed\n');
    assert.equal(await taskStatus(root, 'one'), 'stale_approval');
    await assert.rejects(reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' }), { code: 'APPROVAL_STALE' });
  } finally {
    await cleanup(root);
  }
});

test('a missing or unsafe root run makes an applied approval stale instead of trusting the project', async (t) => {
  // The cited line 1 is not what the run changed, so the project alone would still match the approval:
  // the approval goes stale because the starting source can no longer be shown, not because the text moved.
  const missing = await contextApplyProject({ start: 'one\nlater\n', candidate: 'one\nrewritten\n' });
  try {
    await apply(missing);
    assert.equal(await taskStatus(missing, 'one'), 'ready');
    await rm(join(missing, '.tinysdd', 'runs', RUN_ONE), { recursive: true });
    assert.equal(await taskStatus(missing, 'one'), 'stale_approval');
    await assert.rejects(reviewTask(missing, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' }), { code: 'APPROVAL_STALE' });
  } finally {
    await cleanup(missing);
  }
  const unsafe = await contextApplyProject({ start: 'one\nlater\n', candidate: 'one\nrewritten\n' });
  try {
    await apply(unsafe);
    const cited = join(unsafe, '.tinysdd', 'runs', RUN_ONE, 'workspace-before', 'src', 'a.ts');
    await rm(cited);
    try {
      await symlink(join(unsafe, 'src', 'a.ts'), cited);
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    assert.equal(await taskStatus(unsafe, 'one'), 'stale_approval');
  } finally {
    await cleanup(unsafe);
  }
});

test('approving again after apply records the same context digest and stays ready', async () => {
  const root = await contextApplyProject();
  try {
    const first = (await rawState(root)).tasks.one.approval;
    await apply(root);
    await approveTask(root, { id: 'one', by: 'second-operator', reason: 'looked again' });
    const task = (await rawState(root)).tasks.one;
    assert.equal(task.approval.contextDigest, first.contextDigest);
    assert.equal(task.approval.by, 'second-operator');
    assert.equal(task.applied.runId, RUN_ONE);
    assert.equal(await taskStatus(root, 'one'), 'ready');
  } finally {
    await cleanup(root);
  }
});

test('an approval holding the legacy context digest stays ready through apply', async () => {
  const root = await contextApplyProject();
  try {
    const { legacy, current } = await makeApprovalLegacy(root, 'one');
    assert.notEqual(legacy, current);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await writeFile(join(root, '.tinysdd', 'runs', RUN_ONE, 'packet.json'), JSON.stringify(await resolveTaskPacket(root, 'one')));
    await apply(root);
    assert.equal((await rawState(root)).tasks.one.approval.contextDigest, legacy);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('dispatch is refused while an applied run is recorded', async () => {
  const root = await contextApplyProject();
  try {
    assert.equal((await resolveTaskPacket(root, 'one')).taskId, 'one');
    await apply(root);
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_APPLIED', details: { runId: RUN_ONE }, message: /review it/u });
  } finally {
    await cleanup(root);
  }
});

test('a revision review after apply reopens dispatch, after re-approval when the cited allowed file changed', async () => {
  const stale = await contextApplyProject();
  try {
    await apply(stale);
    await reviewTask(stale, { id: 'one', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' });
    assert.equal((await rawState(stale)).tasks.one.applied, undefined);
    assert.deepEqual((await rawState(stale)).tasks.one.review.appliedFromRun, { runId: RUN_ONE, identical: true });
    // The cited line of an allowed file changed with the apply, so the operator re-approves it explicitly.
    assert.equal(await taskStatus(stale, 'one'), 'stale_approval');
    await assert.rejects(resolveTaskPacket(stale, 'one'), { code: 'TASK_NOT_READY', details: { status: 'stale_approval', blockedBy: [] } });
    await approveTask(stale, { id: 'one', by: 'operator', reason: 'reviewed the applied source' });
    const packet = await resolveTaskPacket(stale, 'one');
    assert.equal(packet.review.verdict, 'revision');
    assert.match(packet.context.text, /src\/a\.ts/u);
  } finally {
    await cleanup(stale);
  }
  const ready = await contextApplyProject({ citeAllowed: false, citeOther: true });
  try {
    await apply(ready);
    await reviewTask(ready, { id: 'one', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' });
    assert.equal(await taskStatus(ready, 'one'), 'ready');
    assert.equal((await resolveTaskPacket(ready, 'one')).review.verdict, 'revision');
  } finally {
    await cleanup(ready);
  }
});

// Task `one` is approved with a context that cites line 1 of each path in `cite`.
async function citedProject({ files, allow, cite }) {
  const root = await project();
  await writeTree(root, files);
  await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'tasks', 'one.context.json'), JSON.stringify({
    schemaVersion: 1,
    facts: [],
    resources: cite.map((path) => ({ path, startLine: 1, endLine: 1, purpose: `Rules in ${path}.` })),
  }));
  await addApprovedTask(root, 'one', { allow, context: '.tinysdd/tasks/one.context.json' });
  return root;
}

test('apply keeps the approved current text of a cited allowed file the lineage never changed', async () => {
  const root = await citedProject({ files: { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' }, allow: ['src/a.ts', 'src/b.ts'], cite: ['src/b.ts'] });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' }, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b0\n' } });
    // B changes after the run and the operator approves the task as it now reads.
    await writeFile(join(root, 'src', 'b.ts'), 'b1\n');
    await approveTask(root, { id: 'one', by: 'operator', reason: 're-approved after editing b' });
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await writeFile(join(root, '.tinysdd', 'runs', RUN_ONE, 'packet.json'), JSON.stringify(await resolveTaskPacket(root, 'one')));
    const { applied } = await apply(root);
    assert.deepEqual(applied.files.map(({ path, status }) => [path, status]), [['src/a.ts', 'written']]);
    assert.equal(await readProject(root, 'src/b.ts'), 'b1\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.deepEqual((await rawState(root)).tasks.one.review.appliedFromRun, { runId: RUN_ONE, identical: true });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('an already-applied cited path is not displaced by apply, so the approval keeps its current text', async () => {
  const root = await citedProject({ files: { 'src/a.ts': 'a1\n' }, allow: ['src/a.ts'], cite: ['src/a.ts'] });
  try {
    // The project already holds the candidate (applied by hand) and the task was approved in that state.
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'a0\n' }, after: { 'src/a.ts': 'a1\n' } });
    assert.equal(await taskStatus(root, 'one'), 'ready');
    const { applied } = await apply(root);
    assert.deepEqual(applied.files.map(({ path, status }) => [path, status]), [['src/a.ts', 'already-applied']]);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.deepEqual((await rawState(root)).tasks.one.review.appliedFromRun, { runId: RUN_ONE, identical: true });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('after apply only the paths apply wrote are pinned: editing another cited allowed file stales the approval', async () => {
  const files = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' };
  const root = await citedProject({ files, allow: ['src/a.ts', 'src/b.ts'], cite: ['src/a.ts', 'src/b.ts'] });
  try {
    await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b0\n' } });
    await apply(root);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    // A was written by apply: it is pinned to the run's starting copy, so editing it is review's business.
    await writeFile(join(root, 'src', 'a.ts'), 'a edited by hand\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    // B was not written: the approval binds its current text.
    await writeFile(join(root, 'src', 'b.ts'), 'b edited\n');
    assert.equal(await taskStatus(root, 'one'), 'stale_approval');
    await assert.rejects(reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' }), { code: 'APPROVAL_STALE' });
    await writeFile(join(root, 'src', 'b.ts'), 'b0\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
  } finally {
    await cleanup(root);
  }
});

test('apply refuses before writing when the recorded pins would leave the approval stale', async () => {
  // Reachable with real inputs: the first apply pinned A. A second run from the same start is then
  // hand-applied, so A is already-applied and unpinned and the project text no longer matches the approval.
  const root = await citedProject({ files: { 'src/a.ts': 'one\n' }, allow: ['src/a.ts'], cite: ['src/a.ts'] });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'one\n' }, after: { 'src/a.ts': 'two\n' } });
    await fakeRun(root, RUN_TWO, { before: { 'src/a.ts': 'one\n' }, after: { 'src/a.ts': 'three\n' } });
    await apply(root);
    await writeFile(join(root, 'src', 'a.ts'), 'three\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await assert.rejects(apply(root, RUN_TWO), { code: 'APPLY_WOULD_STALE', details: { runId: RUN_TWO, rootRunId: RUN_TWO }, message: /task one/u });
    const task = (await rawState(root)).tasks.one;
    assert.equal(task.applied.runId, RUN_ONE);
    assert.equal(await readProject(root, 'src/a.ts'), 'three\n');
    assert.equal(await taskStatus(root, 'one'), 'ready');
  } finally {
    await cleanup(root);
  }
});

// Task `one` allows its own brief, context manifest and checks manifest (all project-local) plus src/a.ts.
const TASK_INPUTS = { brief: 'docs/brief.md', context: 'docs/context.json', checks: 'docs/checks.json' };
const contextManifest = (fact) => JSON.stringify({ schemaVersion: 1, facts: [fact], resources: [] });
const checksManifest = (timeoutMs) => JSON.stringify({ schemaVersion: 1, dependencyMounts: ['node_modules'], checks: [{ id: 'unit', argv: ['node_modules/.bin/vitest'], timeoutMs }] });

async function inputsProject(files = {}) {
  const start = { 'docs/brief.md': '# Brief\n', 'docs/context.json': contextManifest('fact one'), 'docs/checks.json': checksManifest(5000), 'src/a.ts': 'a0\n', ...files };
  const root = await project();
  await writeTree(root, start);
  await addApprovedTask(root, 'one', { allow: Object.keys(start).sort(), context: TASK_INPUTS.context, checks: TASK_INPUTS.checks });
  return { root, start };
}

test('apply refuses a run that rewrites its own brief, context manifest or checks, and writes nothing', async () => {
  const rewrites = {
    'docs/brief.md': '# Brief, rewritten by the run\n',
    'docs/context.json': contextManifest('a different fact'),
    'docs/checks.json': checksManifest(9000),
  };
  for (const [path, rewritten] of Object.entries(rewrites)) {
    const { root, start } = await inputsProject();
    try {
      await fakeRun(root, RUN_ONE, { before: start, after: { ...start, [path]: rewritten, 'src/a.ts': 'a1\n' } });
      await assert.rejects(apply(root), { code: 'APPLY_CHANGES_TASK_INPUT', details: { paths: [path], runId: RUN_ONE }, message: /docs\//u }, path);
      await assertNothingApplied(root, start);
      assert.equal(await taskStatus(root, 'one'), 'ready', path);
    } finally {
      await cleanup(root);
    }
  }
});

test('apply names every task input the run rewrites', async () => {
  const { root, start } = await inputsProject();
  try {
    await fakeRun(root, RUN_ONE, { before: start, after: { ...start, 'docs/brief.md': '# New brief\n', 'docs/checks.json': checksManifest(7000), 'src/a.ts': 'a1\n' } });
    await assert.rejects(apply(root), { code: 'APPLY_CHANGES_TASK_INPUT', details: { paths: ['docs/brief.md', 'docs/checks.json'], runId: RUN_ONE } });
    await assertNothingApplied(root, start);
  } finally {
    await cleanup(root);
  }
});

test('task inputs that are allowed but left unchanged by the run do not stop apply', async () => {
  const { root, start } = await inputsProject();
  try {
    await fakeRun(root, RUN_ONE, { before: start, after: { ...start, 'src/a.ts': 'a1\n' } });
    const { applied } = await apply(root);
    assert.deepEqual(applied.files.map(({ path, status }) => [path, status]), [['src/a.ts', 'written']]);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('a task input the project already holds in its candidate form is already-applied, not refused', async () => {
  // The task was approved with the rewritten manifest already in the project, so nothing is written for it.
  const rewritten = contextManifest('a different fact');
  const { root, start } = await inputsProject({ 'docs/context.json': rewritten });
  try {
    await fakeRun(root, RUN_ONE, { before: { ...start, 'docs/context.json': contextManifest('fact one') }, after: { ...start, 'docs/context.json': rewritten, 'src/a.ts': 'a1\n' } });
    const { applied } = await apply(root);
    assert.deepEqual(applied.files.map(({ path, status }) => [path, status]), [['docs/context.json', 'already-applied'], ['src/a.ts', 'written']]);
    assert.equal(await taskStatus(root, 'one'), 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    assert.equal(await taskStatus(root, 'one'), 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a deleted file before writing anything', async () => {
  const files = { 'src/a.ts': 'keep\n', 'src/b.ts': 'remove\n' };
  const root = await applyProject(files);
  try {
    await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'keep\n' } });
    await assert.rejects(apply(root), { code: 'RUN_SCOPE_VIOLATION', details: { runId: RUN_ONE, paths: ['src/b.ts'], violations: [{ path: 'src/b.ts', change: 'deleted', reason: 'file deletion is not authorized' }] } });
    assert.equal(await readProject(root, 'src/b.ts'), 'remove\n');
    assert.equal(await readProject(root, 'src/a.ts'), 'keep\n');
  } finally {
    await cleanup(root);
  }
});

test('apply includes ordinary extra files and preserves unchanged paths', async () => {
  const files = { 'src/a.ts': 'one\n', 'src/other.ts': 'not allowed\n', 'solo/b.ts': 'solo\n' };
  const root = await applyProject(files, ['solo/b.ts', 'src/a.ts']);
  try {
    await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'two\n', 'src/other.ts': 'ordinary extra\n', 'solo/b.ts': 'solo\n' } });
    const { applied } = await apply(root);
    assert.equal(await readProject(root, 'src/a.ts'), 'two\n');
    assert.equal(await readProject(root, 'src/other.ts'), 'ordinary extra\n');
    assert.equal(await readProject(root, 'solo/b.ts'), 'solo\n');
    assert.deepEqual(applied.files.map(({ path, change, status }) => [path, change, status]), [
      ['src/a.ts', 'modified', 'written'],
      ['src/other.ts', 'modified', 'written'],
    ]);
    assert.ok((await stat(join(root, 'solo'))).isDirectory());
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer', candidatePaths: ['src/a.ts'] });
    const review = (await rawState(root)).tasks.one.review;
    assert.deepEqual(review.candidatePaths, ['solo/b.ts', 'src/a.ts', 'src/other.ts']);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
  } finally {
    await cleanup(root);
  }
});

test('apply preserves the file mode of the candidate', async () => {
  const root = await applyProject({});
  try {
    const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': '#!/bin/sh\n' } });
    await chmod(join(directory, 'workspace-after', 'src', 'a.ts'), 0o755);
    await apply(root);
    assert.equal((await stat(join(root, 'src', 'a.ts'))).mode & 0o777, 0o755 & ~process.umask());
  } finally {
    await cleanup(root);
  }
});

test('apply writes bytes unchanged, including content that is not UTF-8', async () => {
  const root = await applyProject({});
  try {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': bytes } });
    const { applied } = await apply(root);
    assert.deepEqual(await readFile(join(root, 'src', 'a.ts')), bytes);
    assert.equal(applied.files[0].sha256, sha256(bytes));
  } finally {
    await cleanup(root);
  }
});

test('apply follows a --base-run chain from the root run and ends at the final candidate', async () => {
  const root = await applyProject({ 'src/a.ts': 'v0\n' });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'v0\n' }, after: { 'src/a.ts': 'v1\n', 'src/b.ts': 'b1\n' } });
    // The revision's workspace-before is the project plus run one's candidate files.
    await fakeRun(root, RUN_TWO, {
      before: { 'src/a.ts': 'v1\n', 'src/b.ts': 'b1\n' },
      after: { 'src/a.ts': 'v2\n', 'src/b.ts': 'b1\n' },
      baseRun: { id: RUN_ONE, paths: ['src/a.ts', 'src/b.ts'] },
    });
    // Only the final retained packet binds apply; an ancestor packet may be stale.
    const ancestorPacketPath = join(root, '.tinysdd', 'runs', RUN_ONE, 'packet.json');
    const ancestorPacket = JSON.parse(await readFile(ancestorPacketPath, 'utf8'));
    ancestorPacket.approval.approvalDigest = 'f'.repeat(64);
    await writeFile(ancestorPacketPath, JSON.stringify(ancestorPacket));
    const { applied } = await apply(root, RUN_TWO);
    assert.equal(await readProject(root, 'src/a.ts'), 'v2\n');
    assert.equal(await readProject(root, 'src/b.ts'), 'b1\n');
    assert.equal(applied.runId, RUN_TWO);
    assert.equal(applied.rootRunId, RUN_ONE);
    assert.deepEqual(applied.files.map(({ path, change, status }) => [path, change, status]), [
      ['src/a.ts', 'modified', 'written'],
      ['src/b.ts', 'created', 'written'],
    ]);
  } finally {
    await cleanup(root);
  }
});

test('a --base-run revision of an already applied run conflicts, because the project left the lineage start', async () => {
  const root = await applyProject({ 'src/a.ts': 'v0\n' });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'v0\n' }, after: { 'src/a.ts': 'v1\n' } });
    await apply(root);
    await reviewTask(root, { id: 'one', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' });
    await fakeRun(root, RUN_TWO, { before: { 'src/a.ts': 'v1\n' }, after: { 'src/a.ts': 'v2\n' }, baseRun: { id: RUN_ONE, paths: ['src/a.ts'] } });
    await assert.rejects(apply(root, RUN_TWO), { code: 'APPLY_CONFLICT', details: { paths: ['src/a.ts'], runId: RUN_TWO, rootRunId: RUN_ONE } });
    assert.equal(await readProject(root, 'src/a.ts'), 'v1\n');
    // The next attempt dispatched from the applied project applies cleanly.
    await fakeRun(root, RUN_OTHER, { before: { 'src/a.ts': 'v1\n' }, after: { 'src/a.ts': 'v2\n' } });
    await apply(root, RUN_OTHER);
    assert.equal(await readProject(root, 'src/a.ts'), 'v2\n');
  } finally {
    await cleanup(root);
  }
});

test('a three-run chain applies from the earliest run', async () => {
  const root = await applyProject({ 'src/a.ts': 'v0\n' });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'v0\n' }, after: { 'src/a.ts': 'v1\n' } });
    await fakeRun(root, RUN_TWO, { before: { 'src/a.ts': 'v1\n' }, after: { 'src/a.ts': 'v2\n' }, baseRun: { id: RUN_ONE, paths: ['src/a.ts'] } });
    await fakeRun(root, RUN_OTHER, {
      before: { 'src/a.ts': 'v2\n' },
      after: { 'src/a.ts': 'v3\n' },
      baseRun: { id: RUN_TWO, paths: ['src/a.ts'], chain: [{ id: RUN_ONE, paths: ['src/a.ts'] }, { id: RUN_TWO, paths: ['src/a.ts'] }] },
    });
    const { applied } = await apply(root, RUN_OTHER);
    assert.equal(applied.rootRunId, RUN_ONE);
    assert.equal(await readProject(root, 'src/a.ts'), 'v3\n');
  } finally {
    await cleanup(root);
  }
});

test('apply plans only the paths the lineage recorded as changed, whatever the project held at a later dispatch', async () => {
  // B changed in the project between the two dispatches, so the revision's
  // workspaces carry the new B although neither run touched it.
  for (const projectB of ['b1\n', 'b2\n', 'b0\n']) {
    const root = await applyProject({ 'src/a.ts': 'a0\n', 'src/b.ts': projectB });
    try {
      await fakeRun(root, RUN_ONE, { before: { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n' }, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b0\n' } });
      await fakeRun(root, RUN_TWO, {
        before: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' },
        after: { 'src/a.ts': 'a2\n', 'src/b.ts': 'b1\n' },
        changedPaths: [{ path: 'src/a.ts', change: 'modified' }],
        baseRun: { id: RUN_ONE, paths: ['src/a.ts'] },
      });
      const { applied } = await apply(root, RUN_TWO);
      assert.deepEqual(applied.files.map(({ path, status }) => [path, status]), [['src/a.ts', 'written']], projectB);
      assert.equal(await readProject(root, 'src/a.ts'), 'a2\n');
      assert.equal(await readProject(root, 'src/b.ts'), projectB);
    } finally {
      await cleanup(root);
    }
  }
});

test('apply refuses a lineage that is cyclic, too deep, foreign, scope-violating or missing a run', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n' }, baseRun: { id: RUN_TWO, paths: [] } });
    await fakeRun(root, RUN_TWO, { after: { 'src/a.ts': 'x\n' }, baseRun: { id: RUN_ONE, paths: [] } });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_MALFORMED', message: /cycle/u });

    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n' }, baseRun: { id: RUN_OTHER, paths: [] } });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_NOT_FOUND' });

    await fakeRun(root, RUN_OTHER, { taskId: 'elsewhere', packet: false, after: { 'src/a.ts': 'x\n' } });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_TASK_MISMATCH' });

    await fakeRun(root, RUN_OTHER, { after: { 'src/a.ts': 'x\n' }, scopeViolations: [{ path: 'src/evil.ts', change: 'created' }] });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_SCOPE_VIOLATION', details: { runId: RUN_OTHER, paths: ['src/evil.ts'] } });

    await fakeRun(root, RUN_OTHER, { after: { 'src/a.ts': 'x\n' }, baselineRun: { id: RUN_TWO } });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_IS_REPLAY' });

    const deepIds = Array.from({ length: 34 }, (_, index) => `worker-deep-${String(index).padStart(2, '0')}`);
    for (const [index, runId] of deepIds.entries()) {
      await fakeRun(root, runId, { after: { 'src/a.ts': 'x\n' }, ...(index > 0 ? { baseRun: { id: deepIds[index - 1], paths: [] } } : {}) });
    }
    await assert.rejects(apply(root, deepIds[33]), { code: 'RUN_MALFORMED', message: /depth/u });
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('a project file that drifted from the lineage start refuses the whole apply and writes nothing', async () => {
  const files = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n', 'src/c.ts': 'c0\n' };
  const root = await applyProject(files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  try {
    await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n', 'src/c.ts': 'c1\n' } });
    await writeFile(join(root, 'src', 'b.ts'), 'edited by hand\n');
    await assert.rejects(apply(root), (error) => {
      assert.equal(error.code, 'APPLY_CONFLICT');
      assert.deepEqual(error.details.paths, ['src/b.ts']);
      return true;
    });
    await assertNothingApplied(root, { 'src/a.ts': 'a0\n', 'src/b.ts': 'edited by hand\n', 'src/c.ts': 'c0\n' });
  } finally {
    await cleanup(root);
  }
});

test('drift is detected for absent and unexpectedly present files and lists every conflict', async () => {
  const root = await applyProject({ 'src/b.ts': 'b0\n' });
  try {
    await fakeRun(root, RUN_ONE, { before: { 'src/b.ts': 'b0\n' }, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' } });
    await writeFile(join(root, 'src', 'a.ts'), 'someone else created this\n');
    await writeFile(join(root, 'src', 'b.ts'), 'b changed\n');
    await assert.rejects(apply(root), (error) => {
      assert.equal(error.code, 'APPLY_CONFLICT');
      assert.deepEqual(error.details.paths, ['src/a.ts', 'src/b.ts']);
      return true;
    });
    await assertNothingApplied(root, { 'src/a.ts': 'someone else created this\n', 'src/b.ts': 'b changed\n' });
    // A file deleted by hand where the run expected content is drift too.
    await rm(join(root, 'src', 'b.ts'));
    await rm(join(root, 'src', 'a.ts'));
    await fakeRun(root, RUN_TWO, { before: { 'src/b.ts': 'b0\n' }, after: { 'src/b.ts': 'b2\n' } });
    await assert.rejects(apply(root, RUN_TWO), (error) => error.code === 'APPLY_CONFLICT' && error.details.paths[0] === 'src/b.ts');
  } finally {
    await cleanup(root);
  }
});

test('a hand-applied project is recorded with already-applied entries and not rewritten', async () => {
  const before = { 'src/a.ts': 'a0\n', 'src/b.ts': 'b0\n', 'src/c.ts': 'c0\n' };
  const after = { 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n', 'src/c.ts': 'c1\n' };
  const root = await applyProject({ 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n', 'src/c.ts': 'c0\n' }, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  try {
    await fakeRun(root, RUN_ONE, { before, after });
    const { applied } = await apply(root);
    assert.deepEqual(applied.files.map(({ path, change, status }) => [path, change, status]), [
      ['src/a.ts', 'modified', 'already-applied'],
      ['src/b.ts', 'modified', 'already-applied'],
      ['src/c.ts', 'modified', 'written'],
    ]);
    assert.equal(await readProject(root, 'src/c.ts'), 'c1\n');
    assert.deepEqual((await rawState(root)).tasks.one.applied.files, applied.files);
    // Applying again changes nothing on disk and replaces the record.
    const again = await apply(root);
    assert.deepEqual(again.applied.files.map((file) => file.status), ['already-applied', 'already-applied', 'already-applied']);
    assert.equal((await rawState(root)).tasks.one.applied.files[2].status, 'already-applied');
  } finally {
    await cleanup(root);
  }
});

test('a later apply replaces the earlier record', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'one\n' } });
    await apply(root);
    await reviewTask(root, { id: 'one', verdict: 'revision', evidence: EVIDENCE, by: 'reviewer' });
    await fakeRun(root, RUN_TWO, { before: { 'src/a.ts': 'one\n' }, after: { 'src/a.ts': 'two\n' } });
    await apply(root, RUN_TWO, { by: 'other-operator' });
    const { applied } = (await rawState(root)).tasks.one;
    assert.equal(applied.runId, RUN_TWO);
    assert.equal(applied.by, 'other-operator');
    assert.equal(await readProject(root, 'src/a.ts'), 'two\n');
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a run of another task, a replay, an unknown run and a malformed id', async () => {
  const root = await applyProject({});
  try {
    const files = { 'src/a.ts': null, 'src/b.ts': null };
    await fakeRun(root, RUN_ONE, { taskId: 'elsewhere', packet: false, after: { 'src/a.ts': 'x\n' } });
    await assert.rejects(apply(root), { code: 'RUN_TASK_MISMATCH' });
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n' }, baselineRun: { id: RUN_TWO } });
    await assert.rejects(apply(root), { code: 'RUN_IS_REPLAY' });
    await assert.rejects(apply(root, RUN_TWO), { code: 'RUN_NOT_FOUND' });
    await mkdir(join(root, '.tinysdd', 'runs', RUN_TWO));
    await assert.rejects(apply(root, RUN_TWO), { code: 'RUN_NOT_FOUND' });
    for (const bad of ['../worker-x', 'worker-', 'run-1', 'worker-a/b', 'worker-a b', '.']) {
      await assert.rejects(apply(root, bad), { code: 'INVALID_RUN_ID' }, bad);
    }
    await assert.rejects(apply(root, ''), { code: 'INVALID_ARGUMENT' });
    await assertNothingApplied(root, files);
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a run whose outcome is not completed, with no override', async () => {
  const root = await applyProject({});
  try {
    for (const outcome of ['timeout', 'failed', 'stopped', 'tool_limit']) {
      await fakeRun(root, RUN_ONE, { outcome, after: { 'src/a.ts': 'complete candidate\n' } });
      await assert.rejects(apply(root), { code: 'RUN_INCOMPLETE', details: { runId: RUN_ONE, outcome } }, outcome);
      // The removed --allow-incomplete option is not honored through the library either.
      await assert.rejects(apply(root, RUN_ONE, { allowIncomplete: true }), { code: 'RUN_INCOMPLETE' }, outcome);
    }
    await assertNothingApplied(root, { 'src/a.ts': null });
    // The same task's completed run still applies.
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'v1\n' } });
    await apply(root);
  } finally {
    await cleanup(root);
  }
});

test('apply refuses scope violations even when the run is otherwise allowed', async () => {
  const root = await applyProject({});
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n', 'src/evil.ts': 'y\n' }, scopeViolations: [{ path: 'src/evil.ts', change: 'created', reason: 'outside' }] });
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_SCOPE_VIOLATION', details: { runId: RUN_ONE, paths: ['src/evil.ts'] } });
    // A recorded ordinary change outside the planned paths is retained and applied.
    await fakeRun(root, RUN_TWO, { after: { 'src/a.ts': 'x\n', 'src/evil.ts': 'y\n' } });
    await apply(root, RUN_TWO);
    assert.equal(await readProject(root, 'src/a.ts'), 'x\n');
    assert.equal(await readProject(root, 'src/evil.ts'), 'y\n');
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a malformed result.json without writing', async () => {
  const root = await applyProject({});
  try {
    const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n' } });
    await writeFile(join(directory, 'result.json'), '{not json');
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    await writeFile(join(directory, 'result.json'), JSON.stringify({ taskId: 'one', outcome: 'completed' }));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    await rm(join(directory, 'workspace-after'), { recursive: true });
    await writeFile(join(directory, 'result.json'), JSON.stringify({ taskId: 'one', outcome: 'completed', changedPaths: [], scopeViolations: [] }));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED' });
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('apply matches complete retained before and after identities before writing', async () => {
  const root = await applyProject({});
  try {
    const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'candidate\n' } });
    const resultPath = join(directory, 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    result.fileScope = { mode: 'ordinary-create-modify', actualPaths: ['src/a.ts'], ordinaryCreateModify: true, deletions: false };
    result.changedPaths = [{
      path: 'src/a.ts',
      change: 'created',
      before: null,
      after: { kind: 'file', sha256: '0'.repeat(64), size: Buffer.byteLength('candidate\n') },
    }];
    await writeFile(resultPath, JSON.stringify(result));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED', message: /identities do not match/u });
    await assert.rejects(readProject(root, 'src/a.ts'), { code: 'ENOENT' });
    assert.equal((await rawState(root)).tasks.one.applied, undefined);
  } finally {
    await cleanup(root);
  }
});

test('apply refuses missing scope or tampered full snapshot proof before writing', async () => {
  const root = await applyProject({});
  try {
    const directory = await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'candidate\n' } });
    const resultPath = join(directory, 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    delete result.fileScope;
    await writeFile(resultPath, JSON.stringify(result));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED', message: /complete file-scope evidence/u });
    await assertNothingApplied(root, { 'src/a.ts': null });

    result.fileScope = { mode: 'ordinary-create-modify', actualPaths: ['src/a.ts'], ordinaryCreateModify: true, deletions: false };
    await writeFile(resultPath, JSON.stringify(result));
    result.fileScope.actualPaths = ['src/a.ts', 'src/a.ts'];
    await writeFile(resultPath, JSON.stringify(result));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED', message: /unique canonical inventory/u });
    result.fileScope.actualPaths = ['src/a.ts'];
    await writeFile(resultPath, JSON.stringify(result));
    const snapshotPath = join(directory, 'after-snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    delete snapshot['src/a.ts'];
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    await assert.rejects(apply(root), { code: 'RUN_MALFORMED', message: /retained snapshots do not match/u });
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('apply follows the observed filesystem Unicode alias for absent preparation', async () => {
  const root = await project();
  try {
    const aliases = await detectFilesystemAliases(root);
    const nfc = 'specs/caf\u00e9.md';
    const nfd = nfc.normalize('NFD');
    await mkdir(join(root, 'specs'), { recursive: true });
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.ts'], preparation: [{ path: nfc, exists: false }] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'reserved future specification' });
    await fakeRun(root, RUN_ONE, { after: { [nfd]: 'candidate\n' } });
    if (aliases.unicodeInsensitive === true) {
      await assert.rejects(apply(root), { code: 'RUN_SCOPE_VIOLATION' });
      await assertNothingApplied(root, { [nfd]: null });
    } else if (aliases.unicodeInsensitive === false) {
      await apply(root);
      assert.equal(await readProject(root, nfd), 'candidate\n');
    } else {
      await assert.rejects(apply(root), { code: 'RUN_SCOPE_VIOLATION' });
      await assertNothingApplied(root, { [nfd]: null });
    }
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a retired task, an unknown task, and a task that is not ready', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'one', { allow: ['src/a.ts'] });
    await fakeRun(root, RUN_ONE, { packet: false, after: { 'src/a.ts': 'x\n' } });
    await assert.rejects(apply(root), { code: 'TASK_NOT_READY', details: { status: 'pending_approval', blockedBy: [] } });
    await assert.rejects(applyTask(root, { id: 'nope', run: RUN_ONE, by: 'operator' }), { code: 'TASK_NOT_FOUND' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'scope' });
    await writeFile(join(root, 'docs', 'brief.md'), '# Brief, changed\n');
    await assert.rejects(apply(root), { code: 'TASK_NOT_READY', details: { status: 'stale_approval', blockedBy: [] } });
    await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
    await writeFile(join(root, '.tinysdd', 'runs', RUN_ONE, 'packet.json'), JSON.stringify(await resolveTaskPacket(root, 'one')));
    await apply(root);
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    await assert.rejects(apply(root), { code: 'TASK_NOT_READY', details: { status: 'accepted', blockedBy: [] } });
    await addApprovedTask(root, 'two');
    await closeTask(root, { id: 'two', by: 'operator', reason: 'dropped' });
    await assert.rejects(applyTask(root, { id: 'two', run: RUN_ONE, by: 'operator' }), { code: 'TASK_CLOSED' });
    assert.equal((await rawState(root)).tasks.two.applied, undefined);
  } finally {
    await cleanup(root);
  }
});

test('apply requires a task id, a label and a run id', async () => {
  const root = await applyProject({});
  try {
    await assert.rejects(applyTask(root, { run: RUN_ONE, by: 'operator' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(applyTask(root, { id: 'one', run: RUN_ONE }), { code: 'INVALID_ARGUMENT', message: /apply by/u });
    await assert.rejects(applyTask(root, { id: 'one', by: 'operator' }), { code: 'INVALID_ARGUMENT', message: /run id/u });
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a symlinked parent directory or target and writes nothing', async (t) => {
  const root = await applyProject({}, ['lib/ok.ts', 'src/a.ts']);
  try {
    await fakeRun(root, RUN_ONE, { after: { 'lib/ok.ts': 'ok\n', 'src/a.ts': 'a\n' } });
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    try {
      await symlink(elsewhere, join(root, 'src'), 'dir');
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(apply(root), { code: 'SYMLINK_PATH' });
    await assert.rejects(readFile(join(elsewhere, 'a.ts')), { code: 'ENOENT' });
    await assert.rejects(readProject(root, 'lib/ok.ts'), { code: 'ENOENT' });

    await rm(join(root, 'src'));
    await mkdir(join(root, 'src'));
    await writeFile(join(elsewhere, 'target.ts'), 'untouched\n');
    await symlink(join(elsewhere, 'target.ts'), join(root, 'src', 'a.ts'));
    await assert.rejects(apply(root), { code: 'SYMLINK_PATH' });
    assert.equal(await readFile(join(elsewhere, 'target.ts'), 'utf8'), 'untouched\n');
    await assert.rejects(readProject(root, 'lib/ok.ts'), { code: 'ENOENT' });
    assert.equal((await rawState(root)).tasks.one.applied, undefined);
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a symlinked allowed file the run did not change before writing anything', async (t) => {
  const root = await applyProject({}, ['src/a.ts', 'src/b.ts']);
  try {
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'a\n' } });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'elsewhere.ts'), 'outside\n');
    try {
      await symlink(join(root, 'elsewhere.ts'), join(root, 'src', 'b.ts'));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(apply(root), { code: 'SYMLINK_PATH' });
    await assert.rejects(readProject(root, 'src/a.ts'), { code: 'ENOENT' });
    assert.equal((await rawState(root)).tasks.one.applied, undefined);
  } finally {
    await cleanup(root);
  }
});

test('apply refuses a symlinked run directory', async (t) => {
  const root = await applyProject({});
  try {
    const real = await fakeRun(root, RUN_TWO, { after: { 'src/a.ts': 'x\n' } });
    try {
      await symlink(real, join(root, '.tinysdd', 'runs', RUN_ONE), 'dir');
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(apply(root, RUN_ONE), { code: 'RUN_NOT_FOUND' });
    await assertNothingApplied(root, { 'src/a.ts': null });
  } finally {
    await cleanup(root);
  }
});

test('state without applied stays valid and an unapplied acceptance has no appliedFromRun', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'one');
    assert.equal((await controllerStatus(root)).tasks[0].applied, undefined);
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: EVIDENCE, by: 'reviewer' });
    const state = await rawState(root);
    assert.equal('applied' in state.tasks.one, false);
    assert.equal('appliedFromRun' in state.tasks.one.review, false);
    assert.equal(await taskStatus(root, 'one'), 'accepted');
    const publicReview = (await controllerStatus(root)).tasks[0].review;
    assert.equal('appliedFromRun' in publicReview, false);
  } finally {
    await cleanup(root);
  }
});

test('controller state validates the applied shape', async () => {
  const root = await project();
  try {
    await addOpenTask(root, 'one');
    const valid = {
      runId: RUN_ONE,
      rootRunId: RUN_ONE,
      appliedAt: '2026-01-01T00:00:00.000Z',
      by: 'operator',
      files: [
        { path: 'src/one.ts', change: 'created', sha256: sha256('x'), status: 'written' },
        { path: 'src/two.ts', change: 'deleted', sha256: null, status: 'already-applied' },
      ],
    };
    const file = valid.files[0];
    const cases = [
      null,
      'applied',
      [],
      { ...valid, runId: 'not-a-run' },
      { ...valid, runId: undefined },
      { ...valid, rootRunId: '../worker-x' },
      { ...valid, allowedDigest: 'abc' },
      { ...valid, allowedDigest: null },
      { ...valid, allowedDigest: 7 },
      { ...valid, allowedDigest: 'A'.repeat(64) },
      { ...valid, by: ' ' },
      { ...valid, appliedAt: 7 },
      { ...valid, files: 'src/one.ts' },
      { ...valid, files: [null] },
      { ...valid, files: [{ ...file, path: '../escape' }] },
      { ...valid, files: [{ ...file, path: '.tinysdd/runs/controller.json' }] },
      { ...valid, files: [{ ...file, path: undefined }] },
      { ...valid, files: [{ ...file, change: 'renamed' }] },
      { ...valid, files: [{ ...file, status: 'skipped' }] },
      { ...valid, files: [{ ...file, sha256: null }] },
      { ...valid, files: [{ ...file, sha256: 'abc' }] },
      { ...valid, files: [{ ...file, change: 'deleted', sha256: sha256('x') }] },
    ];
    for (const applied of cases) {
      const state = await rawState(root);
      state.tasks.one.applied = applied;
      await writeState(root, state);
      await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' }, JSON.stringify(applied));
    }
    const state = await rawState(root);
    state.tasks.one.applied = valid;
    await writeState(root, state);
    assert.deepEqual((await controllerStatus(root)).tasks[0].applied, { runId: RUN_ONE, appliedAt: valid.appliedAt, files: 2 });
    state.tasks.one.applied = { ...valid, allowedDigest: sha256('allowed') };
    await writeState(root, state);
    assert.equal((await controllerStatus(root)).tasks[0].applied.files, 2);
    // A record written while apply still stored an outcome stays valid.
    state.tasks.one.applied = { ...valid, outcome: 'completed' };
    await writeState(root, state);
    assert.equal((await controllerStatus(root)).tasks[0].applied.files, 2);
    delete state.tasks.one.applied;
    await writeState(root, state);
    assert.equal((await controllerStatus(root)).tasks[0].applied, undefined);
  } finally {
    await cleanup(root);
  }
});

test('applying leaves an existing approval fresh', async () => {
  const root = await project();
  try {
    await addApprovedTask(root, 'one', { allow: ['src/a.ts'] });
    await fakeRun(root, RUN_ONE, { after: { 'src/a.ts': 'x\n' } });
    const before = (await rawState(root)).tasks.one.approval;
    await apply(root);
    assert.deepEqual((await rawState(root)).tasks.one.approval, before);
    assert.equal((await controllerStatus(root)).tasks[0].approval.current, true);
  } finally {
    await cleanup(root);
  }
});

test('CLI task apply prints one line, reports already-applied files and returns the record as JSON', async () => {
  const files = { 'src/a.ts': 'a0\n' };
  const root = await applyProject(files);
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    await fakeRun(root, RUN_ONE, { before: files, after: { 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' } });
    const human = await cli('task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator');
    assert.equal(human.stdout, `one: applied 2 file(s) from ${RUN_ONE}\n`);
    assert.equal(human.stderr, '');

    const json = await cli('--json', 'task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator');
    assert.equal(json.stderr, '');
    const lines = json.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.task.status, 'ready');
    assert.deepEqual(parsed.data.task.applied, { runId: RUN_ONE, appliedAt: parsed.data.applied.appliedAt, files: 2 });
    assert.deepEqual(parsed.data.applied.files.map((file) => file.status), ['already-applied', 'already-applied']);
    const again = await cli('task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator');
    assert.equal(again.stdout, `one: applied 2 file(s) from ${RUN_ONE} (2 already applied)\n`);
    assert.match((await cli('--help')).stdout, /task apply --id ID --run RUN_ID --by LABEL\n/u);
    assert.doesNotMatch((await cli('--help')).stdout, /allow-incomplete/u);
  } finally {
    await cleanup(root);
  }
});

test('CLI task apply reports refusals and has no flags beyond id, run and by', async () => {
  const root = await applyProject({});
  try {
    const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
    const cli = (...args) => exec(process.execPath, [bin, '--project', root, ...args]);
    await fakeRun(root, RUN_ONE, { outcome: 'timeout', after: { 'src/a.ts': 'candidate\n' } });
    const refused = await cli('--json', 'task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator').catch((error) => error);
    assert.equal(refused.code, 1);
    assert.equal(refused.stderr, '');
    assert.equal(JSON.parse(refused.stdout).error.code, 'RUN_INCOMPLETE');
    const humanRefused = await cli('task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator').catch((error) => error);
    assert.match(humanRefused.stderr, /^ERROR \[RUN_INCOMPLETE\] /u);
    // --allow-incomplete was removed: it is an unknown option, not a silent override.
    for (const flag of [['--allow-incomplete'], ['--allow-incomplete=true']]) {
      const override = await cli('task', 'apply', '--id', 'one', '--run', RUN_ONE, '--by', 'operator', ...flag).catch((error) => error);
      assert.equal(override.code, 1);
      assert.match(override.stderr, /unknown option: --allow-incomplete/u);
    }
    assert.equal((await rawState(root)).tasks.one.applied, undefined);
    await assert.rejects(readProject(root, 'src/a.ts'), { code: 'ENOENT' });
    // Valued flags still need their value, and stray arguments are refused.
    const noValue = await cli('task', 'apply', '--id', '--by', 'operator').catch((error) => error);
    assert.match(noValue.stderr, /--id requires a value/u);
    const stray = await cli('task', 'apply', 'stray', '--id', 'one', '--run', RUN_ONE, '--by', 'operator').catch((error) => error);
    assert.match(stray.stderr, /unexpected argument: stray/u);
  } finally {
    await cleanup(root);
  }
});

test('protected contracts are normalized, public, and present in both packets', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'docs', 'contract.txt'), 'contract\n');
    const added = await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/new.ts', protect: 'docs/contract.txt,docs/brief.md,docs/contract.txt' });
    assert.deepEqual(added.task.protect, ['docs/brief.md', 'docs/contract.txt']);
    assert.deepEqual((await controllerStatus(root)).tasks[0].protect, added.task.protect);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'fixed contract' });
    assert.deepEqual((await resolveTaskPacket(root, 'one')).protectedPaths, added.task.protect);
    assert.deepEqual((await resolveBenchmarkPacket(root, 'one')).protectedPaths, added.task.protect);
  } finally {
    await cleanup(root);
  }
});

test('invalid protected contracts are rejected without changing state', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'existing', brief: 'docs/brief.md', allow: 'src/old.ts' });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const before = await readFile(statePath, 'utf8');
    for (const [protect, allow, code] of [
      ['docs/brief.md', 'docs/brief.md', 'PROTECT_ALLOW_OVERLAP'],
      ['docs/missing.txt', 'src/new.ts', 'PROTECT_MISSING'],
      ['docs', 'src/new.ts', 'INVALID_FILE'],
      ['.tinysdd/x', 'src/new.ts', 'INVALID_PATH'],
    ]) {
      await assert.rejects(addTask(root, { id: 'bad', brief: 'docs/brief.md', protect, allow }), { code });
      assert.equal(await readFile(statePath, 'utf8'), before);
    }
  } finally {
    await cleanup(root);
  }
});

test('protected content drift stales approval and acceptance, and reapproval restores readiness', async () => {
  const root = await project();
  try {
    const contract = join(root, 'docs', 'contract.txt');
    await writeFile(contract, 'original\n');
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/new.ts', protect: 'docs/contract.txt' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'fixed contract' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    await writeFile(contract, 'changed\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_NOT_READY' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked changed contract' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'operator' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await writeFile(contract, 'changed again\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale');
  } finally {
    await cleanup(root);
  }
});

test('missing or unreadable protected files fail closed after approval', async () => {
  const root = await project();
  try {
    const contract = join(root, 'docs', 'contract.txt');
    await writeFile(contract, 'original\n');
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/new.ts', protect: 'docs/contract.txt' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'fixed contract' });
    await rm(contract);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
    await assert.rejects(approveTask(root, { id: 'one', by: 'operator', reason: 'missing contract' }), { code: 'PROTECT_MISSING' });
    await mkdir(contract);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
  } finally {
    await cleanup(root);
  }
});

test('legacy approvals stay fresh without protect fields; malformed protected state is rejected', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/new.ts' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'legacy approval' });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.hasOwn(state.tasks.one, 'protect'), false);
    delete state.tasks.one.approval.protect;
    delete state.tasks.one.approval.protectDigest;
    await writeFile(statePath, JSON.stringify(state));
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    assert.equal(Object.hasOwn(await resolveTaskPacket(root, 'one'), 'protectedPaths'), false);
    for (const protect of ['docs/brief.md', [], [null], ['.tinysdd/x']]) {
      await writeFile(statePath, JSON.stringify({ ...state, tasks: { one: { ...state.tasks.one, protect } } }));
      await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' }, JSON.stringify(protect));
    }
  } finally {
    await cleanup(root);
  }
});

test('CLI task add exposes protected paths in its single JSON object', async () => {
  const root = await project();
  try {
    const cli = new URL('../bin/tinysdd.mjs', import.meta.url).pathname;
    const { stdout } = await exec(process.execPath, [cli, '--project', root, '--json', 'task', 'add', '--id', 'one', '--brief', 'docs/brief.md', '--allow', 'src/new.ts', '--protect', 'docs/brief.md']);
    assert.equal(stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(stdout).data.task.protect, ['docs/brief.md']);
  } finally {
    await cleanup(root);
  }
});

test('task update records shape history, preserves decisions, and requires reapproval', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/old.ts', protect: 'docs/brief.md' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'old scope' });
    await reviewTask(root, { id: 'one', verdict: 'revision', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    const before = (await rawState(root)).tasks.one;
    const result = await createController(root).updateTask({ id: 'one', by: 'operator', reason: 'smaller slice', allow: 'src/new.ts' });
    assert.equal(result.task.status, 'stale_approval');
    assert.deepEqual(result.revision.previous, { brief: before.brief, allow: before.allow, protect: before.protect, dependsOn: before.dependsOn });
    assert.equal(result.revision.by, 'operator');
    assert.equal(result.revision.reason, 'smaller slice');
    assert.ok(!Number.isNaN(Date.parse(result.revision.revisedAt)));
    assert.deepEqual(result.task.revisions, [result.revision]);
    assert.equal(result.sizing.allowedFiles, 1);
    const after = (await rawState(root)).tasks.one;
    assert.deepEqual(after.approval, before.approval);
    assert.deepEqual(after.review, before.review);
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_NOT_READY' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'new scope' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    const second = await updateTask(root, { id: 'one', by: 'operator', reason: 'split again', allow: ['src/final.ts'] });
    assert.equal(second.task.revisions.length, 2);
    assert.deepEqual(second.task.revisions[0], result.revision);
    assert.deepEqual(second.task.revisions[1].previous.allow, ['src/new.ts']);
    second.task.revisions[0].previous.allow.push('mutated-return.ts');
    assert.deepEqual((await controllerStatus(root)).tasks[0].revisions[0].previous.allow, ['src/old.ts']);
  } finally {
    await cleanup(root);
  }
});

test('task update rejects invalid shapes and dependency changes without changing state', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/one.ts', protect: 'docs/brief.md' });
    await addTask(root, { id: 'two', brief: 'docs/brief.md', allow: 'src/two.ts', dependsOn: 'one' });
    await writeFile(join(root, 'docs', 'bad.json'), '{}');
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const before = await readFile(statePath, 'utf8');
    for (const [fields, code] of [
      [{}, 'INVALID_ARGUMENT'],
      [{ allow: ['src/one.ts', 'src/one.ts'] }, 'TASK_UNCHANGED'],
      [{ allow: [] }, 'INVALID_ARGUMENT'],
      [{ allow: 'docs/brief.md' }, 'PROTECT_ALLOW_OVERLAP'],
      [{ allow: 'docs' }, 'INVALID_FILE'],
      [{ protect: 'docs/missing.txt' }, 'PROTECT_MISSING'],
      [{ protect: 'docs' }, 'INVALID_FILE'],
      [{ protect: '.tinysdd/x' }, 'INVALID_PATH'],
      [{ dependsOn: 'two' }, 'DEPENDENCY_CYCLE'],
      [{ dependsOn: 'missing' }, 'DEPENDENCY_NOT_FOUND'],
      [{ brief: 'docs/bad.json' }, 'INVALID_BRIEF'],
      [{ brief: 'docs/missing.md' }, 'PATH_NOT_FOUND'],
      [{ context: 'docs/bad.json' }, 'CONTEXT_MANIFEST_INVALID'],
      [{ checks: 'docs/bad.json' }, 'CHECKS_MANIFEST_INVALID'],
      [{ context: 'docs/brief.md' }, 'INVALID_CONTEXT'],
      [{ checks: 'docs/brief.md' }, 'INVALID_CHECKS'],
      [{ id: 'missing', allow: 'src/new.ts' }, 'TASK_NOT_FOUND'],
      [{ by: '', allow: 'src/new.ts' }, 'INVALID_ARGUMENT'],
      [{ reason: '', allow: 'src/new.ts' }, 'INVALID_ARGUMENT'],
    ]) {
      await assert.rejects(updateTask(root, { id: 'one', by: 'operator', reason: 'change scope', ...fields }), { code }, JSON.stringify(fields));
      assert.equal(await readFile(statePath, 'utf8'), before);
    }
  } finally {
    await cleanup(root);
  }
});

test('task update refuses accepted, stale accepted, and retired tasks', async () => {
  const root = await project();
  try {
    for (const id of ['accepted', 'closed', 'superseded', 'successor']) {
      await addTask(root, { id, brief: 'docs/brief.md', allow: `src/${id}.ts` });
    }
    await approveTask(root, { id: 'accepted', by: 'operator', reason: 'approved' });
    await reviewTask(root, { id: 'accepted', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'operator' });
    await closeTask(root, { id: 'closed', by: 'operator', reason: 'abandoned' });
    await supersedeTask(root, { id: 'superseded', by: 'operator', reason: 're-cut', with: 'successor' });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const before = await readFile(statePath, 'utf8');
    for (const [id, code] of [['accepted', 'TASK_ACCEPTED'], ['closed', 'TASK_CLOSED'], ['superseded', 'TASK_CLOSED']]) {
      await assert.rejects(updateTask(root, { id, by: 'operator', reason: 'new scope', allow: 'src/new.ts' }), { code });
      assert.equal(await readFile(statePath, 'utf8'), before);
    }
    await writeFile(join(root, 'docs', 'brief.md'), '# Changed brief\n');
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale');
    await assert.rejects(updateTask(root, { id: 'accepted', by: 'operator', reason: 'new scope', allow: 'src/new.ts' }), { code: 'TASK_ACCEPTED' });
    assert.equal(await readFile(statePath, 'utf8'), before);
  } finally {
    await cleanup(root);
  }
});

test('task update replaces all supported inputs and can explicitly clear optional fields', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'docs', 'next.md'), '# Next brief\n');
    await writeFile(join(root, 'docs', 'context.json'), JSON.stringify({ schemaVersion: 1, facts: ['fixed API'], resources: [] }));
    await writeFile(join(root, 'docs', 'checks.json'), JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node', '--test'] }] }));
    await addTask(root, { id: 'dependency', brief: 'docs/brief.md', allow: 'src/dependency.ts' });
    await approveTask(root, { id: 'dependency', by: 'operator', reason: 'approved' });
    await reviewTask(root, { id: 'dependency', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'operator' });
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/old.ts' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'approved' });
    const changed = await updateTask(root, { id: 'one', by: 'operator', reason: 'new shape', brief: 'docs/next.md', context: 'docs/context.json', checks: 'docs/checks.json', allow: 'src/new.ts', protect: ['docs/next.md'], dependsOn: ['dependency'] });
    assert.equal(changed.task.status, 'stale_approval');
    assert.equal(changed.task.context, 'docs/context.json');
    assert.equal(changed.task.checks, 'docs/checks.json');
    assert.deepEqual(changed.task.protect, ['docs/next.md']);
    assert.deepEqual(changed.task.dependsOn, ['dependency']);
    assert.ok(changed.sizing.compiledContextBytes > 0);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'approved new shape' });
    const packet = await resolveTaskPacket(root, 'one');
    assert.equal(packet.brief.path, 'docs/next.md');
    assert.equal(packet.context.path, 'docs/context.json');
    assert.equal(packet.checks.path, 'docs/checks.json');
    const cleared = await updateTask(root, { id: 'one', by: 'operator', reason: 'clear optional fields', context: '', checks: '', protect: [], dependsOn: [] });
    assert.equal(cleared.task.status, 'stale_approval');
    const task = (await rawState(root)).tasks.one;
    for (const field of ['context', 'checks', 'protect']) assert.equal(Object.hasOwn(task, field), false, field);
    assert.deepEqual(task.dependsOn, []);
    assert.equal(task.brief, 'docs/next.md');
    assert.deepEqual(task.allow, ['src/new.ts']);
    assert.equal(cleared.revision.previous.context, 'docs/context.json');
    assert.equal(cleared.revision.previous.checks, 'docs/checks.json');
    assert.deepEqual(cleared.revision.previous.protect, ['docs/next.md']);
    assert.deepEqual(cleared.revision.previous.dependsOn, ['dependency']);
  } finally {
    await cleanup(root);
  }
});

test('task update adding and clearing protect stales approval through its shape binding', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/one.ts' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'old approval' });
    assert.equal((await updateTask(root, { id: 'one', by: 'operator', reason: 'protect contract', protect: 'docs/brief.md' })).task.status, 'stale_approval');
    await approveTask(root, { id: 'one', by: 'operator', reason: 'protected approval' });
    const cleared = await updateTask(root, { id: 'one', by: 'operator', reason: 'clear contract', protect: [] });
    assert.equal(cleared.task.status, 'stale_approval');
    assert.equal(Object.hasOwn((await rawState(root)).tasks.one, 'protect'), false);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'unprotected approval' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
  } finally {
    await cleanup(root);
  }
});

test('task update moves an old apply into history before later review', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/old.ts' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'old approval' });
    const state = await rawState(root);
    const applied = { runId: 'worker-test', rootRunId: 'worker-test', by: 'operator', appliedAt: '2026-10-03T00:00:00Z', files: [{ path: 'src/old.ts', change: 'created', sha256: sha256('old'), status: 'written' }] };
    state.tasks.one.applied = applied;
    await writeState(root, state);
    const result = await updateTask(root, { id: 'one', by: 'operator', reason: 'changed scope', allow: 'src/new.ts' });
    assert.deepEqual(result.revision.previous.applied, applied);
    assert.equal(Object.hasOwn((await rawState(root)).tasks.one, 'applied'), false);
    await approveTask(root, { id: 'one', by: 'operator', reason: 'new approval' });
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'operator' });
    assert.equal(Object.hasOwn((await rawState(root)).tasks.one.review, 'appliedFromRun'), false);
  } finally {
    await cleanup(root);
  }
});

test('task revision history is optional in legacy state and rejects malformed entries', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/old.ts' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'legacy approval' });
    const state = await rawState(root);
    assert.equal(Object.hasOwn(state.tasks.one, 'revisions'), false);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    const valid = { revisedAt: '2026-10-03T00:00:00Z', by: 'operator', reason: 'old shape', previous: { brief: 'docs/brief.md', allow: ['src/older.ts'], dependsOn: [] } };
    for (const revisions of [
      null, {}, 'history', [null], [{}],
      [{ ...valid, by: '' }], [{ ...valid, reason: ' ' }], [{ ...valid, revisedAt: 1 }],
      [{ ...valid, previous: null }],
      [{ ...valid, previous: { ...valid.previous, brief: 'docs/brief.json' } }],
      [{ ...valid, previous: { ...valid.previous, allow: [] } }],
      [{ ...valid, previous: { ...valid.previous, allow: ['.tinysdd/x'] } }],
      [{ ...valid, previous: { ...valid.previous, dependsOn: [null] } }],
      [{ ...valid, previous: { ...valid.previous, context: 'context.md' } }],
      [{ ...valid, previous: { ...valid.previous, checks: 2 } }],
      [{ ...valid, previous: { ...valid.previous, protect: [] } }],
      [{ ...valid, previous: { ...valid.previous, applied: {} } }],
    ]) {
      await writeState(root, { ...state, tasks: { one: { ...state.tasks.one, revisions } } });
      await assert.rejects(controllerStatus(root), { code: 'STATE_MALFORMED' }, JSON.stringify(revisions));
    }
    await writeState(root, { ...state, tasks: { one: { ...state.tasks.one, revisions: [valid] } } });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
    assert.deepEqual((await controllerStatus(root)).tasks[0].revisions, [valid]);
  } finally {
    await cleanup(root);
  }
});

test('CLI task update emits one JSON object and distinguishes omitted lists from clearing', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: 'src/old.ts', protect: 'docs/brief.md' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'approved' });
    const cli = new URL('../bin/tinysdd.mjs', import.meta.url).pathname;
    const args = [cli, '--project', root, '--json', 'task', 'update', '--id', 'one', '--by', 'operator', '--reason', 'change scope'];
    const result = await exec(process.execPath, [...args, '--allow', 'src/new.ts']);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const updated = JSON.parse(result.stdout).data;
    assert.deepEqual(updated.task.protect, ['docs/brief.md']);
    assert.equal(updated.task.status, 'stale_approval');
    const cleared = await exec(process.execPath, [...args, '--protect=', '--depends-on=']);
    assert.equal(cleared.stdout.trim().split('\n').length, 1);
    assert.equal(Object.hasOwn(JSON.parse(cleared.stdout).data.task, 'protect'), false);
    assert.deepEqual((await rawState(root)).tasks.one.allow, ['src/new.ts']);
    const human = await exec(process.execPath, [cli, '--project', root, 'task', 'update', '--id', 'one', '--by', 'operator', '--reason', 'final scope', '--allow', 'src/final.ts']);
    assert.equal(human.stdout, 'one: stale_approval\n');
  } finally {
    await cleanup(root);
  }
});
