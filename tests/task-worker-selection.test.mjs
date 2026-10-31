import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import { parseSliceDocument } from '../src/change-format.mjs';
import { validateConfigDocument } from '../src/config.mjs';
import {
  addTask,
  approveTask,
  controllerStatus,
  dispatchWorker,
  initProject,
  selectTaskWorker,
  suggestEscalation,
  updateTask,
} from '../src/controller.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const exec = promisify(execFile);

function sliceValue(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'one',
    brief: 'a.md',
    context: 'a.json',
    checks: 'a.json',
    implementationFiles: ['src/a.mjs'],
    sliceTests: ['src/a.test.mjs'],
    protect: [],
    interfaces: ['src/a.mjs'],
    dependsOn: [],
    budget: { maxImplementationFiles: null, maxSliceTestFiles: null, maxCompiledContextBytes: null },
    openDecisions: [],
    testReview: { schemaVersion: 1, workflow: 'slice-tests', criteria: [{ id: 'c', requirementIds: ['req'], question: 'Assess.', interfaces: ['src/a.mjs'], testPaths: ['src/a.test.mjs'] }] },
    ...overrides,
  };
}

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-task-worker-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
  await initProject(root);
  return root;
}

async function stateFile(root) {
  return join(root, '.tinysdd', 'runs', 'controller.json');
}

test('a slice may name its worker and a reason; the reason needs a worker', () => {
  const parsed = parseSliceDocument(JSON.stringify(sliceValue({ worker: 'strong', workerReason: 'three interfaces, async edges' })));
  assert.equal(parsed.worker, 'strong');
  assert.equal(parsed.workerReason, 'three interfaces, async edges');
  assert.equal(parseSliceDocument(JSON.stringify(sliceValue())).worker, undefined);
  assert.throws(() => parseSliceDocument(JSON.stringify(sliceValue({ workerReason: 'why' }))), { code: 'ARTIFACT_FORMAT_INVALID' });
  assert.throws(() => parseSliceDocument(JSON.stringify(sliceValue({ worker: 'Not Safe' }))), { code: 'ARTIFACT_FORMAT_INVALID' });
});

test('the task worker is part of the approval: changing it makes the approval stale', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.mjs'], worker: 'fast', workerReason: 'one file' });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    let [task] = (await controllerStatus(root)).tasks;
    assert.equal(task.status, 'ready');
    assert.equal(task.worker, 'fast');
    assert.equal(task.workerReason, 'one file');

    await updateTask(root, { id: 'one', by: 'operator', reason: 'harder than planned', worker: 'strong' });
    [task] = (await controllerStatus(root)).tasks;
    assert.equal(task.worker, 'strong');
    assert.equal(task.status, 'stale_approval');

    await updateTask(root, { id: 'one', by: 'operator', reason: 'back to the default', worker: '' });
    [task] = (await controllerStatus(root)).tasks;
    assert.equal(task.worker, undefined);
    assert.equal(task.workerReason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approvals from before per-task workers stay fresh for tasks without a worker', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.mjs'] });
    await approveTask(root, { id: 'one', by: 'operator', reason: 'checked scope' });
    const path = await stateFile(root);
    const state = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(state.tasks.one, 'worker'), false);
    assert.equal(Object.hasOwn(state.tasks.one.approval, 'worker'), false);
    assert.equal((await controllerStatus(root)).tasks[0].status, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task add rejects a worker reason without a worker and an unsafe worker name', async () => {
  const root = await project();
  try {
    await assert.rejects(addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.mjs'], workerReason: 'why' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(addTask(root, { id: 'one', brief: 'docs/brief.md', allow: ['src/a.mjs'], worker: '../strong' }), { code: 'INVALID_ARGUMENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker selection order is --worker, then the task worker, then defaultWorker', async () => {
  const root = await project();
  try {
    await addTask(root, { id: 'chosen', brief: 'docs/brief.md', allow: ['src/a.mjs'], worker: 'strong', workerReason: 'async edges' });
    await addTask(root, { id: 'plain', brief: 'docs/brief.md', allow: ['src/b.mjs'] });
    assert.deepEqual(await selectTaskWorker(root, 'chosen', 'fast'), { workerName: 'fast', source: 'option' });
    assert.deepEqual(await selectTaskWorker(root, 'chosen'), { workerName: 'strong', source: 'task', reason: 'async edges' });
    assert.deepEqual(await selectTaskWorker(root, 'plain'), { workerName: undefined, source: 'default' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('escalation suggests the next tier and never past the last one', () => {
  const tiers = ['fast', 'strong'];
  assert.deepEqual(suggestEscalation(tiers, 'fast', 'one', 'worker-1'), {
    suggestedWorker: 'strong',
    command: 'tinysdd worker run --task one --worker strong --escalated-from worker-1',
  });
  assert.equal(suggestEscalation(tiers, 'strong', 'one', 'worker-1'), undefined);
  assert.equal(suggestEscalation(tiers, 'other', 'one', 'worker-1'), undefined);
  assert.equal(suggestEscalation(undefined, 'fast', 'one', 'worker-1'), undefined);
});

test('workerTiers needs at least two distinct safe worker names', () => {
  const workers = { fast: { type: 'pi', provider: 'p', model: 'm' }, strong: { type: 'pi', provider: 'p', model: 'n' } };
  assert.deepEqual(validateConfigDocument({ schemaVersion: 1, workers, workerTiers: ['fast', 'strong'] }).workerTiers, ['fast', 'strong']);
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, workers, workerTiers: ['fast'] }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, workers, workerTiers: ['fast', 'fast'] }), { code: 'CONFIG_INVALID' });
});

async function dispatchFixture({ failing = false } = {}) {
  const root = await project();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.mjs'), 'before\n');
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        api: 'openai-completions',
        baseUrl: '$FAKE_BASE',
        apiKey: '$FAKE_TOKEN',
        models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false }],
      },
    },
  })}\n`);
  const pi = join(root, 'fake-pi.mjs');
  const body = failing
    ? 'process.exit(3);\n'
    : "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.cwd(), 'src', 'index.mjs'), 'changed\\n');\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }));\n";
  await writeFile(pi, `#!/usr/bin/env node\n${body}`);
  await chmod(pi, 0o755);
  const worker = { type: 'pi', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    defaultWorker: 'fast',
    workers: { fast: worker, strong: worker },
    workerTiers: ['fast', 'strong'],
  }));
  return {
    root,
    runtime: { test: true, piExecutable: pi, sourceAgentDir: agent, sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' } },
  };
}

async function withWorkerTest(callback) {
  const previous = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previous;
  }
}

test('a run uses the approved task worker and records why it was chosen', async () => {
  const fixture = await dispatchFixture();
  try {
    await withWorkerTest(async () => {
      await addTask(fixture.root, { id: 'one', brief: 'docs/brief.md', allow: ['src/index.mjs'], worker: 'strong', workerReason: 'async edges' });
      await approveTask(fixture.root, { id: 'one', by: 'operator', reason: 'checked scope' });
      const result = await dispatchWorker(fixture.root, { taskId: 'one', runtime: fixture.runtime });
      assert.equal(result.outcome, 'completed');
      assert.deepEqual(result.workerSelection, { workerName: 'strong', source: 'task', reason: 'async edges' });
      assert.equal(result.escalation, undefined);
      const runtime = JSON.parse(await readFile(result.artifactPaths.runtime, 'utf8'));
      assert.deepEqual(runtime.workerSelection, result.workerSelection);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a dispatched run records profile-defaulted limits as source "profile" in runtime.json (#174)', async () => {
  const fixture = await dispatchFixture();
  try {
    await mkdir(join(fixture.root, '.tinysdd', 'profiles'), { recursive: true });
    await writeFile(join(fixture.root, '.tinysdd', 'profiles', 'measured-v1.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'measured-v1',
      model: { route: 'fake/model' },
      limits: { timeoutMs: 600000, maxToolCalls: 100 },
    }));
    await writeFile(join(fixture.root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'fast',
      workers: {
        fast: { type: 'pi', provider: 'fake', model: 'fake/model', profile: 'measured-v1', limits: { timeoutMs: 900000 } },
        strong: { type: 'pi', provider: 'fake', model: 'fake/model', profile: 'measured-v1', limits: { timeoutMs: 900000 } },
      },
      workerTiers: ['fast', 'strong'],
    }));
    await withWorkerTest(async () => {
      await addTask(fixture.root, { id: 'one', brief: 'docs/brief.md', allow: ['src/index.mjs'] });
      await approveTask(fixture.root, { id: 'one', by: 'operator', reason: 'checked scope' });
      const result = await dispatchWorker(fixture.root, { taskId: 'one', runtime: fixture.runtime });
      assert.equal(result.outcome, 'completed');
      const runtime = JSON.parse(await readFile(result.artifactPaths.runtime, 'utf8'));
      assert.equal(runtime.limits.timeoutMs, 900000);
      assert.deepEqual(runtime.limitProvenance, {
        timeoutMs: { measured: 600000, effective: 900000, source: 'worker' },
        maxToolCalls: { measured: 100, effective: 100, source: 'profile' },
      });
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a failed run suggests the next tier, and the escalated run records where it came from', async () => {
  const fixture = await dispatchFixture({ failing: true });
  try {
    await withWorkerTest(async () => {
      await addTask(fixture.root, { id: 'one', brief: 'docs/brief.md', allow: ['src/index.mjs'] });
      await approveTask(fixture.root, { id: 'one', by: 'operator', reason: 'checked scope' });
      const failed = await dispatchWorker(fixture.root, { taskId: 'one', runtime: fixture.runtime });
      assert.notEqual(failed.outcome, 'completed');
      assert.deepEqual(failed.workerSelection, { workerName: 'fast', source: 'default' });
      assert.equal(failed.escalation.suggestedWorker, 'strong');
      assert.equal(failed.escalation.command, `tinysdd worker run --task one --worker strong --escalated-from ${failed.runId}`);

      const escalated = await dispatchWorker(fixture.root, { taskId: 'one', worker: 'strong', escalatedFrom: failed.runId, runtime: fixture.runtime });
      assert.equal(escalated.workerSelection.workerName, 'strong');
      assert.equal(escalated.workerSelection.source, 'option');
      assert.equal(escalated.workerSelection.escalatedFrom.runId, failed.runId);
      assert.equal(escalated.workerSelection.escalatedFrom.workerName, 'fast');
      assert.equal(escalated.escalation, undefined);

      await assert.rejects(dispatchWorker(fixture.root, { taskId: 'one', worker: 'strong', escalatedFrom: 'worker-missing', runtime: fixture.runtime }));
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('task add and task update accept --worker and --worker-reason on the CLI', async () => {
  const root = await project();
  try {
    const cli = new URL('../bin/tinysdd.mjs', import.meta.url).pathname;
    const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, '--json', '--project', root, ...args])).stdout);
    const added = await run('task', 'add', '--id', 'one', '--brief', 'docs/brief.md', '--allow', 'src/a.mjs', '--worker', 'strong', '--worker-reason', 'async edges');
    assert.equal(added.data.task.worker, 'strong');
    assert.equal(added.data.task.workerReason, 'async edges');
    const updated = await run('task', 'update', '--id', 'one', '--by', 'operator', '--reason', 'simpler', '--worker', 'fast');
    assert.equal(updated.data.task.worker, 'fast');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
