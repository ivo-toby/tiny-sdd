import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckChannel } from '../src/check-channel.mjs';

const canonicalTmpdir = await realpath(tmpdir());

async function waitFor(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('check channel runs a declared request and records checked bytes and live mount identity', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-test-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  const dependencies = join(root, 'node_modules');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(dependencies, '.bin'), { recursive: true });
  await mkdir(artifactDir);
  await writeFile(join(workspace, 'src', 'allowed.txt'), 'before\n');
  await writeFile(join(dependencies, 'package.json'), '{"name":"fixture"}\n');
  const text = JSON.stringify({ schemaVersion: 1, dependencyMounts: ['node_modules'], checks: [{ id: 'unit', argv: ['node', '-e', ''], timeoutMs: 1000 }] });
  const calls = [];
  const channel = await createCheckChannel({
    manifest: JSON.parse(text),
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: ['src/allowed.txt'],
    maxCheckRuns: 2,
    nodeRoot: root,
    runner: async (options) => {
      calls.push(options);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 2,
        output: { text: 'ok\n', tail: 'ok\n', totalBytes: 3, truncated: false },
      };
    },
  });
  try {
    assert.equal(channel.mounts[0].source, dependencies);
    assert.equal(channel.dependencyIdentity.provenance, 'live-source-root');
    assert.equal(channel.dependencyIdentity.mounts[0].target, 'node_modules');
    assert.match(channel.dependencyIdentity.sha256, /^[a-f0-9]{64}$/u);
    channel.start(5000);
    const correlation = 'a'.repeat(64);
    await writeFile(join(channel.requests, `${correlation}.json`), JSON.stringify({ checkId: 'unit' }));
    channel.poll();
    const response = await waitFor(join(channel.responses, `${correlation}.json`));
    assert.equal(response.error, undefined);
    assert.equal(response.results[0].checkId, 'unit');
    assert.equal(response.runs, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].dependencyMounts, [{ source: dependencies, target: 'node_modules' }]);
    const expected = createHash('sha256').update('before\n').digest('hex');
    assert.equal(channel.runs[0].allowedFileDigests['src/allowed.txt'], expected);
    const log = (await readFile(channel.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, 'passed');
    assert.equal(log[0].outputSha256, createHash('sha256').update('ok\n').digest('hex'));
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel rejects dependency mounts that overlap an allowed path', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-overlap-'));
  try {
    await assert.rejects(
      createCheckChannel({
        manifest: { schemaVersion: 1, dependencyMounts: ['src'], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
        sourceRoot: root,
        workspace: join(root, 'workspace'),
        artifactDir: root,
        tempRoot: canonicalTmpdir,
        allowedPaths: ['src/allowed.txt'],
        maxCheckRuns: 1,
        nodeRoot: root,
        runner: async () => { throw new Error('unreachable'); },
      }),
      /overlaps an allowed path/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel rejects nested dependency mounts before starting', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-nested-'));
  try {
    await assert.rejects(
      createCheckChannel({
        manifest: { schemaVersion: 1, dependencyMounts: ['deps', 'deps/sub'], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
        sourceRoot: root,
        workspace: join(root, 'workspace'),
        artifactDir: root,
        tempRoot: canonicalTmpdir,
        allowedPaths: ['src/allowed.txt'],
        maxCheckRuns: 1,
        nodeRoot: root,
        runner: async () => { throw new Error('unreachable'); },
      }),
      /must not overlap/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel charges each check in an all-checks request and stops at the budget', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-budget-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  const calls = [];
  const channel = await createCheckChannel({
    manifest: {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [
        { id: 'first', argv: ['node', '-e', '0'], timeoutMs: 1000 },
        { id: 'second', argv: ['node', '-e', '0'], timeoutMs: 1000 },
      ],
    },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: [],
    maxCheckRuns: 1,
    nodeRoot: root,
    runner: async ({ check }) => {
      calls.push(check.id);
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'ok', tail: 'ok', totalBytes: 2, truncated: false } };
    },
  });
  try {
    channel.start(5000);
    const correlation = 'b'.repeat(64);
    await writeFile(join(channel.requests, `${correlation}.json`), '{}');
    channel.poll();
    const response = await waitFor(join(channel.responses, `${correlation}.json`));
    assert.deepEqual(calls, ['first']);
    assert.deepEqual(response.results.map(({ checkId }) => checkId), ['first']);
    assert.equal(response.runs, 1);
    assert.equal(response.error.code, 'CHECK_BUDGET_EXHAUSTED');
    const log = (await readFile(channel.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(log.map((record) => record.checkId), ['first', 'second']);
    assert.equal(log[1].error.code, 'CHECK_BUDGET_EXHAUSTED');
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel rejects unknown, malformed and replayed requests once each', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-reject-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  const channel = await createCheckChannel({
    manifest: { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: [],
    maxCheckRuns: 1,
    nodeRoot: root,
    runner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'ok', tail: 'ok', totalBytes: 2, truncated: false } }),
  });
  try {
    channel.start(5000);
    const unknown = 'c'.repeat(64);
    await writeFile(join(channel.requests, `${unknown}.json`), JSON.stringify({ checkId: 'missing' }));
    channel.poll();
    assert.equal((await waitFor(join(channel.responses, `${unknown}.json`))).error.code, 'CHECK_UNKNOWN_ID');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const malformed = 'd'.repeat(64);
    await writeFile(join(channel.requests, `${malformed}.json`), JSON.stringify({ checkId: 'unit', extra: true }));
    channel.poll();
    assert.equal((await waitFor(join(channel.responses, `${malformed}.json`))).error.code, 'CHECK_REQUEST_INVALID');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const valid = 'e'.repeat(64);
    await writeFile(join(channel.requests, `${valid}.json`), JSON.stringify({ checkId: 'unit' }));
    channel.poll();
    assert.equal((await waitFor(join(channel.responses, `${valid}.json`))).runs, 1);
    await writeFile(join(channel.requests, `${valid}.json`), JSON.stringify({ checkId: 'unit' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    channel.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = (await readFile(channel.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(log.filter((record) => record.error?.code === 'CHECK_REQUEST_REPLAY').map((record) => record.correlationId), [valid]);
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
