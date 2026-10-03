import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/controller.mjs';

const exec = promisify(execFile);
// Project roots may not resolve through a symlink, and tmpdir() does on macOS
// (/var -> /private/var), so temp dirs are built from the real path.
const canonicalTmpdir = await realpath(tmpdir());
const cli = new URL('../bin/tinysdd.mjs', import.meta.url);

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-launch-cli-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
  await initProject(root);
  return root;
}

test('worker status rejects an unknown launch without creating controller state', async () => {
  const root = await project();
  try {
    await assert.rejects(
      exec(process.execPath, [cli.pathname, '--json', '--project', root, 'worker', 'status', '--id', 'launch-00000000-0000-0000-0000-000000000000']),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'LAUNCH_NOT_FOUND');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker status rejects malformed launch identifiers before reading a path', async () => {
  const root = await project();
  try {
    await assert.rejects(
      exec(process.execPath, [cli.pathname, '--json', '--project', root, 'worker', 'status', '--id', '../outside']),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'INVALID_LAUNCH_ID');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker status reports current state at data.status, not in the launch snapshot', async () => {
  const root = await project();
  const id = 'launch-11111111-2222-3333-4444-555555555555';
  try {
    const directory = join(root, '.tinysdd', 'launches', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'request.json'), JSON.stringify({ schemaVersion: 1, id, taskId: 'one', worker: 'qwen', status: 'running', pid: 0 }));
    const pending = JSON.parse((await exec(process.execPath, [cli.pathname, '--json', '--project', root, 'worker', 'status', '--id', id])).stdout);
    assert.equal(pending.data.status, 'interrupted');
    await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: true, data: { outcome: 'completed' } }));
    const { stdout } = await exec(process.execPath, [cli.pathname, '--json', '--project', root, 'worker', 'status', '--id', id]);
    const finished = JSON.parse(stdout);
    assert.equal(finished.data.status, 'finished');
    assert.equal(finished.data.request.launchStatus, 'running');
    assert.equal(Object.hasOwn(finished.data.request, 'status'), false);
    assert.doesNotMatch(stdout, /"status":"running"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker start fails before detaching when Pi cannot honor the thinking request', async () => {
  const root = await project();
  const agentDir = await mkdtemp(join(canonicalTmpdir, 'tinysdd-launch-agent-'));
  try {
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
      providers: { titan: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'qwen-bare', reasoning: false }] } },
    }));
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'high.json'), JSON.stringify({ schemaVersion: 1, id: 'high', runtime: { thinking: 'high' } }));
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'qwen',
      workers: { qwen: { type: 'pi', provider: 'titan', model: 'qwen-bare', profile: 'profiles/high.json' } },
    }));
    await assert.rejects(
      exec(process.execPath, [cli.pathname, '--json', '--project', root, 'worker', 'start', '--task', 'one'], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.error.code, 'WORKER_PREFLIGHT_FAILED');
        assert.match(result.error.message, /thinking "high" was requested but cannot be sent/u);
        assert.match(result.error.details.warnings.join('\n'), /no maxTokens/u);
        return true;
      },
    );
    await assert.rejects(readdir(join(root, '.tinysdd', 'launches')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// Stand-in for src/worker-launcher.mjs. It must keep that file name: `worker
// stop` only signals a process whose argv names worker-launcher.mjs and this
// launch's directory.
const FAKE_LAUNCHER = `
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.argv[5];
const delayMs = Number(process.env.FAKE_LAUNCHER_DELAY_MS ?? 0);
process.on('SIGTERM', () => {
  appendFileSync(process.env.FAKE_LAUNCHER_SIGNALS, 'x');
  setTimeout(() => {
    const temporary = join(directory, '.result.tmp');
    writeFileSync(temporary, JSON.stringify({ ok: false, error: { code: 'WORKER_STOPPED', message: 'stopped' }, data: { outcome: 'stopped' } }));
    renameSync(temporary, join(directory, 'result.json'));
    process.exit(0);
  }, delayMs);
});
writeFileSync(process.env.FAKE_LAUNCHER_READY, '');
setInterval(() => {}, 1000);
`;

// `worker stop` verifies a live launcher through /proc, so it can only get past
// that check on Linux. Stops that return earlier (finished, dead pid, bad
// arguments) run everywhere.
const LINUX_ONLY_STOP = process.platform !== 'linux' && 'worker stop needs Linux /proc';

const LAUNCH_ID = 'launch-11111111-2222-3333-4444-555555555555';

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launchDirectory(root, id = LAUNCH_ID) {
  const directory = join(await realpath(root), '.tinysdd', 'launches', id);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeRequest(directory, pid, id = LAUNCH_ID) {
  await writeFile(join(directory, 'request.json'), JSON.stringify({ schemaVersion: 1, id, taskId: 'one', worker: 'qwen', status: 'running', pid }));
}

// A launch directory whose request.json names `pid`.
async function launch(root, pid, id = LAUNCH_ID) {
  const directory = await launchDirectory(root, id);
  await writeRequest(directory, pid, id);
  return directory;
}

// Starts the fake launcher with the argv `worker start` would give the real one.
async function startFakeLauncher(root, directory, { delayMs = 0 } = {}) {
  const helperDirectory = await mkdtemp(join(canonicalTmpdir, 'tinysdd-fake-launcher-'));
  const script = join(helperDirectory, 'worker-launcher.mjs');
  const ready = join(helperDirectory, 'ready');
  const signals = join(helperDirectory, 'signals');
  await writeFile(script, FAKE_LAUNCHER);
  await writeFile(signals, '');
  const child = spawn(process.execPath, [script, await realpath(root), 'one', 'qwen', directory], {
    stdio: 'ignore',
    env: { ...process.env, FAKE_LAUNCHER_DELAY_MS: String(delayMs), FAKE_LAUNCHER_READY: ready, FAKE_LAUNCHER_SIGNALS: signals },
  });
  await waitFor(() => exists(ready), 'the fake launcher to install its SIGTERM handler');
  return {
    pid: child.pid,
    signals: () => readFile(signals, 'utf8'),
    async dispose() {
      child.kill('SIGKILL');
      await rm(helperDirectory, { recursive: true, force: true });
    },
  };
}

function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
}

function worker(root, ...args) {
  return exec(process.execPath, [cli.pathname, '--project', root, 'worker', ...args]);
}

async function workerJson(root, ...args) {
  return JSON.parse((await worker(root, '--json', ...args)).stdout);
}

test('worker stop signals the launcher and returns its finalized result', { skip: LINUX_ONLY_STOP }, async () => {
  const root = await project();
  let fake;
  try {
    const directory = await launchDirectory(root);
    fake = await startFakeLauncher(root, directory);
    await writeRequest(directory, fake.pid);
    const stopped = (await workerJson(root, 'stop', '--id', LAUNCH_ID)).data;
    assert.equal(stopped.status, 'finished');
    assert.equal(stopped.stopRequested, true);
    assert.equal(stopped.request.launchStatus, 'running');
    assert.equal(stopped.result.error.code, 'WORKER_STOPPED');
    assert.equal(stopped.result.data.outcome, 'stopped');
    const stop = JSON.parse(await readFile(join(directory, 'stop.json'), 'utf8'));
    assert.deepEqual(Object.keys(stop), ['schemaVersion', 'id', 'requestedAt']);
    assert.equal(stop.schemaVersion, 1);
    assert.equal(stop.id, LAUNCH_ID);
    assert.ok(!Number.isNaN(Date.parse(stop.requestedAt)));
    const status = (await workerJson(root, 'status', '--id', LAUNCH_ID)).data;
    assert.equal(status.status, 'finished');
    assert.equal(status.stopRequestedAt, stop.requestedAt);
  } finally {
    await fake?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker stop reports stopping when the launcher is still finalizing, and never signals twice', { skip: LINUX_ONLY_STOP }, async () => {
  const root = await project();
  let fake;
  try {
    const directory = await launchDirectory(root);
    fake = await startFakeLauncher(root, directory, { delayMs: 1500 });
    await writeRequest(directory, fake.pid);
    const before = (await workerJson(root, 'status', '--id', LAUNCH_ID)).data;
    assert.equal(before.status, 'running');
    assert.equal(Object.hasOwn(before, 'stopRequestedAt'), false);
    const stopping = (await workerJson(root, 'stop', '--id', LAUNCH_ID, '--wait-ms', '200')).data;
    assert.equal(stopping.status, 'stopping');
    assert.equal(stopping.stopRequested, true);
    assert.equal(stopping.statusCommand, `tinysdd worker status --id ${LAUNCH_ID}`);
    assert.equal(Object.hasOwn(stopping, 'result'), false);
    const status = (await workerJson(root, 'status', '--id', LAUNCH_ID)).data;
    assert.equal(status.status, 'stopping');
    assert.equal(typeof status.stopRequestedAt, 'string');
    // A second stop only waits: a second SIGTERM would kill the real launcher
    // (its handler is once-only) before it finalizes.
    const human = (await worker(root, 'stop', '--id', LAUNCH_ID, '--wait-ms', '200')).stdout;
    assert.equal(human, `Launch ${LAUNCH_ID}: stopping; poll: tinysdd worker status --id ${LAUNCH_ID}\n`);
    assert.equal(await fake.signals(), 'x');
    await waitFor(async () => (await workerJson(root, 'status', '--id', LAUNCH_ID)).data.status === 'finished', 'the delayed result');
    const finished = (await workerJson(root, 'status', '--id', LAUNCH_ID)).data;
    assert.equal(finished.stopRequestedAt, status.stopRequestedAt);
    assert.equal(finished.result.data.outcome, 'stopped');
    assert.equal(await fake.signals(), 'x');
  } finally {
    await fake?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker stop refuses to signal a live process that is not this launch\'s launcher', { skip: LINUX_ONLY_STOP }, async () => {
  const root = await project();
  const other = sleeper();
  let lookalike;
  try {
    const directory = await launch(root, other.pid);
    await assert.rejects(worker(root, '--json', 'stop', '--id', LAUNCH_ID), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'LAUNCH_NOT_OURS');
      return true;
    });
    assert.ok(alive(other.pid));
    assert.equal(await exists(join(directory, 'stop.json')), false);
    // A real launcher, but of another launch: the directory argument must match too.
    const otherId = 'launch-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const otherDirectory = await launchDirectory(root, otherId);
    lookalike = await startFakeLauncher(root, otherDirectory);
    await writeRequest(directory, lookalike.pid);
    await assert.rejects(worker(root, '--json', 'stop', '--id', LAUNCH_ID), (error) => {
      assert.equal(JSON.parse(error.stdout).error.code, 'LAUNCH_NOT_OURS');
      return true;
    });
    assert.ok(alive(lookalike.pid));
    assert.equal(await lookalike.signals(), '');
    assert.equal(await exists(join(directory, 'stop.json')), false);
  } finally {
    other.kill('SIGKILL');
    await lookalike?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker stop on a finished launch returns its result without signaling anything', async () => {
  const root = await project();
  const other = sleeper();
  try {
    const directory = await launch(root, other.pid);
    await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: true, data: { outcome: 'completed' } }));
    const finished = (await workerJson(root, 'stop', '--id', LAUNCH_ID)).data;
    assert.equal(finished.status, 'finished');
    assert.equal(finished.stopRequested, false);
    assert.equal(finished.result.data.outcome, 'completed');
    assert.ok(alive(other.pid));
    assert.equal(await exists(join(directory, 'stop.json')), false);
    const human = (await worker(root, 'stop', '--id', LAUNCH_ID)).stdout;
    assert.equal(human, `Launch ${LAUNCH_ID}: finished (outcome completed)\n`);
  } finally {
    other.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('worker stop on a launch whose process is gone reports interrupted', async () => {
  const root = await project();
  try {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    const directory = await launch(root, gone.pid);
    const interrupted = (await workerJson(root, 'stop', '--id', LAUNCH_ID)).data;
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.stopRequested, false);
    assert.equal(Object.hasOwn(interrupted, 'result'), false);
    assert.equal(await exists(join(directory, 'stop.json')), false);
    assert.equal((await worker(root, 'stop', '--id', LAUNCH_ID)).stdout, `Launch ${LAUNCH_ID}: interrupted\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker stop validates its launch id and --wait-ms before signaling', async () => {
  const root = await project();
  try {
    await assert.rejects(worker(root, '--json', 'stop', '--id', 'launch-00000000-0000-0000-0000-000000000000'), (error) => {
      assert.equal(JSON.parse(error.stdout).error.code, 'LAUNCH_NOT_FOUND');
      return true;
    });
    await assert.rejects(worker(root, '--json', 'stop', '--id', '../outside'), (error) => {
      assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_LAUNCH_ID');
      return true;
    });
    for (const waitMs of ['-1', '1.5', 'soon', '600001']) {
      await assert.rejects(worker(root, '--json', 'stop', '--id', LAUNCH_ID, '--wait-ms', waitMs), (error) => {
        assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_ARGUMENT');
        return true;
      });
    }
    const directory = await launch(root, 0);
    await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: true, data: { outcome: 'completed' } }));
    for (const waitMs of ['0', '600000']) {
      assert.equal((await workerJson(root, 'stop', '--id', LAUNCH_ID, '--wait-ms', waitMs)).data.status, 'finished');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
