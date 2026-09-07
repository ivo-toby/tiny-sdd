import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
