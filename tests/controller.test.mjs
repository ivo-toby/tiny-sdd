import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import {
  addTask,
  approveTask,
  closeTask,
  controllerNext,
  controllerStatus,
  initProject,
  resolveBenchmarkPacket,
  resolveTaskPacket,
  reviewTask,
  supersedeTask,
} from '../src/controller.mjs';
import { sha256 } from '../src/fs-utils.mjs';

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
    assert.deepEqual(packet.allowedPaths, ['src/new-file.ts']);
    await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
    assert.equal((await controllerStatus(root)).tasks[0].status, 'accepted');
    await assert.rejects(resolveTaskPacket(root, 'one'), { code: 'TASK_ALREADY_ACCEPTED' });
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
    assert.equal(packet.checks.path, checksPath);
    assert.equal(packet.checks.text, checksText);
    assert.equal(packet.checks.sha256, sha256(checksText));
    assert.equal((await controllerStatus(root)).tasks[0].checks, checksPath);
    await writeFile(join(root, ...checksPath.split('/')), `${checksText}\n`);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'stale_approval');
  } finally {
    await cleanup(root);
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
    assert.match(status.stdout, /^broker-s1: pending_approval$/mu);
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
