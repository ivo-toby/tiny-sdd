import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/controller.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const canonicalTmpdir = await realpath(tmpdir());

async function invoke(project, ...args) {
  try {
    const result = await exec(process.execPath, [cli, '--json', '--project', project, ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function parseSingleJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test('bench run validates worker and repeat flags without polluting JSON stdout', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-benchmark-cli-args-'));
  try {
    const cases = [
      { args: ['bench', 'run'], message: /--worker requires a value/u },
      { args: ['bench', 'run', '--worker', 'qwen', '--repeat', '0'], message: /--repeat must be an integer/u },
      { args: ['bench', 'run', '--worker', 'qwen', '--repeat', '1.5'], message: /--repeat must be an integer/u },
      { args: ['bench', 'run', '--worker', 'qwen', '--unknown', 'value'], message: /unknown option: --unknown/u },
    ];
    for (const entry of cases) {
      const result = await invoke(root, ...entry.args);
      assert.equal(result.status, 1);
      const parsed = parseSingleJson(result);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'INVALID_ARGUMENT');
      assert.match(parsed.error.message, entry.message);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bench run resolves a project-relative suite and reports missing suite content as JSON', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-benchmark-cli-suite-'));
  try {
    await initProject(root, { worker: 'fake', provider: 'fake', model: 'fake/model' });
    await mkdir(join(root, 'bench'), { recursive: true });
    const result = await invoke(root, 'bench', 'run', '--worker', 'fake', '--suite', 'bench', '--repeat', '1');
    assert.equal(result.status, 1);
    const parsed = parseSingleJson(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'BENCHMARK_RUNNER_INVALID');
    assert.match(parsed.error.message, /suite\.json/u);
    assert.match(result.stderr, /Benchmark bench started with worker fake/u);
    await assert.rejects(readFile(join(root, '.tinysdd', 'bench', 'missing')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('help advertises the benchmark command without creating project state', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-benchmark-cli-help-'));
  try {
    const result = await invoke(root, '--help');
    assert.equal(result.status, 0);
    const parsed = parseSingleJson(result);
    assert.equal(parsed.ok, true);
    assert.match(parsed.data.help, /bench run --worker NAME \[--suite PATH\] \[--repeat K\]/u);
    await assert.rejects(readFile(join(root, '.tinysdd', 'config.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
