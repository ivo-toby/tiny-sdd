import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import {
  addTask,
  approveTask,
  controllerNext,
  controllerStatus,
  initProject,
  resolveTaskPacket,
  reviewTask,
} from '../src/controller.mjs';

const exec = promisify(execFile);

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-controller-'));
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
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-cli-'));
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
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-cli-help-'));
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
