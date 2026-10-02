import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/controller.mjs';

const exec = promisify(execFile);
const cli = new URL('../bin/tinysdd.mjs', import.meta.url);

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-launch-cli-'));
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
  const agentDir = await mkdtemp(join(tmpdir(), 'tinysdd-launch-agent-'));
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
