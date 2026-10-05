import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const FIXTURE = dirname(dirname(fileURLToPath(import.meta.url)));
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
delete childEnv.NODE_TEST_CONTEXT;

const DISCONNECTIONS = [
  ['S1', '  const lease = invalidLease();', "  const lease = new Error('disconnected');"],
  ['S2', '  const path = validateBrokerPath(key);', '  const path = key;'],
  ['S3', '  const backend = createBackend();', "  const backend = { get: () => undefined, set: () => {} };"],
  ['S4', '  const allowed = allowlisted(declaredAllowlist, path);', '  const allowed = true;'],
  ['S5a', '  const sequential = runLifecycle(path, value);', "  const sequential = 'disconnected';"],
  ['S5b', '  const asynchronous = await runAsyncLifecycle(path, value);', "  const asynchronous = { key: 'disconnected', value };"],
];

test('disconnecting each declared slice fails the protected real-entrypoint feature test', async () => {
  for (const [slice, before, after] of DISCONNECTIONS) {
    const root = await mkdtemp(join(tmpdir(), 'tinysdd-fixture-' + slice.toLowerCase() + '-'));
    try {
      const copy = join(root, 'fixture');
      await cp(FIXTURE, copy, { recursive: true });
      const entrypoint = join(copy, 'src', 'entrypoint.mjs');
      const source = await readFile(entrypoint, 'utf8');
      assert.ok(source.includes(before), slice + ' mutation marker must exist');
      await writeFile(entrypoint, source.replace(before, after));
      try {
        await run(process.execPath, ['--test', 'tests/feature-integration.test.mjs'], { cwd: copy, env: childEnv });
        assert.fail(slice + ' remained connected');
      } catch (error) {
        if (error?.code === 'ERR_ASSERTION') throw error;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
