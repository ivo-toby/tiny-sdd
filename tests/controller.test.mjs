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
import { sha256 } from '../src/fs-utils.mjs';

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
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-gate-'));
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
