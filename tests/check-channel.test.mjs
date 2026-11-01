import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCheckChannel, identifyDependencyMounts } from '../src/check-channel.mjs';
import { checkRunnerAvailable } from '../src/check-runner.mjs';

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
    // Docker access belongs to feature acceptance; run_checks never asks for it.
    assert.equal(Object.hasOwn(calls[0], 'docker'), false);
    // Vite resolves localhost at startup, so run_checks gets loopback like feature checks (#215).
    assert.equal(calls[0].loopback, true);
    const expected = createHash('sha256').update('before\n').digest('hex');
    assert.equal(channel.runs[0].allowedFileDigests['src/allowed.txt'], expected);
    assert.equal(channel.runs[0].candidateEntries['src'].kind, 'directory');
    assert.equal(channel.runs[0].candidateEntries['src/allowed.txt'].kind, 'file');
    assert.equal(channel.runs[0].candidateEntries['src/allowed.txt'].bytes, 7);
    assert.equal(channel.runs[0].candidateEntries['src/allowed.txt'].sha256, expected);
    assert.equal(Number.isInteger(channel.runs[0].candidateEntries['src/allowed.txt'].mode), true);
    assert.equal(channel.runs[0].candidateIdentity.algorithm, 'sha256-candidate-tree-v1');
    assert.equal(channel.runs[0].candidateIdentity.entries.some((entry) => entry.path === 'src/allowed.txt' && entry.sha256 === expected), true);
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

test('check channel counts the omitted tail marker outside the original output bytes', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-tail-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  const tail = `[... 1 earlier bytes omitted ...]\n${'x'.repeat(16 * 1024)}`;
  const channel = await createCheckChannel({
    manifest: { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: [],
    maxCheckRuns: 1,
    nodeRoot: root,
    runner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'x'.repeat(16385), tail, totalBytes: 16385, truncated: false } }),
  });
  try {
    channel.start(5000);
    const correlation = 'f'.repeat(64);
    await writeFile(join(channel.requests, `${correlation}.json`), JSON.stringify({ checkId: 'unit' }));
    channel.poll();
    const response = await waitFor(join(channel.responses, `${correlation}.json`));
    assert.equal(response.results[0].truncated, true);
    const log = (await readFile(channel.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(log[0].truncated, true);
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel aborts an in-flight runner and drains its response', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-cancel-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  let started;
  let markStarted;
  let cancelled = false;
  started = new Promise((resolve) => { markStarted = resolve; });
  const channel = await createCheckChannel({
    manifest: { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: [],
    maxCheckRuns: 1,
    nodeRoot: root,
    runner: async ({ signal }) => {
      markStarted();
      await new Promise((resolve, reject) => {
        const cancel = () => { cancelled = true; reject(Object.assign(new Error('cancelled'), { code: 'CHECK_CANCELLED' })); };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    },
  });
  try {
    channel.start(5000);
    const correlation = 'a'.repeat(64);
    await writeFile(join(channel.requests, `${correlation}.json`), JSON.stringify({ checkId: 'unit' }));
    channel.poll();
    await started;
    await channel.drain();
    const response = await waitFor(join(channel.responses, `${correlation}.json`));
    assert.equal(cancelled, true);
    assert.equal(response.error.code, 'CHECK_CANCELLED');
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('run_checks extension writes a request and returns the channel response', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-extension-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  const extensionDir = join(root, 'extension');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  await mkdir(join(extensionDir, 'node_modules', 'typebox'), { recursive: true });
  await copyFile(new URL('../src/run-checks-extension.mjs', import.meta.url), join(extensionDir, 'run-checks-extension.mjs'));
  await writeFile(join(extensionDir, 'node_modules', 'typebox', 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  await writeFile(join(extensionDir, 'node_modules', 'typebox', 'index.js'), 'export const Type = { String: () => ({}), Optional: (value) => value, Object: () => ({}) };\n');
  const channel = await createCheckChannel({
    manifest: { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: [],
    maxCheckRuns: 2,
    nodeRoot: root,
    runner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'ok', tail: 'ok', totalBytes: 2, truncated: false } }),
  });
  const previousRoot = process.env.TINYSDD_CHECK_CHANNEL;
  const previousDeadline = process.env.TINYSDD_CHECK_DEADLINE;
  try {
    const modulePath = join(extensionDir, 'run-checks-extension.mjs');
    const { default: install } = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
    let tool;
    install({ registerTool(definition) { tool = definition; } });
    process.env.TINYSDD_CHECK_CHANNEL = channel.root;
    process.env.TINYSDD_CHECK_DEADLINE = String(Date.now() + 5000);
    channel.start(5000);
    const poller = setInterval(() => channel.poll(), 5);
    try {
      const response = await tool.execute('extension-call', { checkId: 'unit' }, new AbortController().signal);
      assert.equal(response.details.results[0].checkId, 'unit');
      assert.equal(response.details.runs, 1);
    } finally {
      clearInterval(poller);
    }
  } finally {
    if (previousRoot === undefined) delete process.env.TINYSDD_CHECK_CHANNEL;
    else process.env.TINYSDD_CHECK_CHANNEL = previousRoot;
    if (previousDeadline === undefined) delete process.env.TINYSDD_CHECK_DEADLINE;
    else process.env.TINYSDD_CHECK_DEADLINE = previousDeadline;
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

// Loads a fresh copy of the installed OpenCode plugin against a real channel,
// with the hooks and tool it registers, and runs `body` with the channel polled.
async function withOpenCodePlugin(body) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-opencode-'));
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
    maxCheckRuns: 4,
    nodeRoot: root,
    tool: 'opencode-plugin',
    runner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: 'ok', tail: 'ok', totalBytes: 2, truncated: false } }),
  });
  const previousRoot = process.env.TINYSDD_CHECK_CHANNEL;
  const previousDeadline = process.env.TINYSDD_CHECK_DEADLINE;
  const poller = setInterval(() => channel.poll(), 5);
  try {
    const { default: plugin } = await import(`${pathToFileURL(join(channel.extension, 'index.js')).href}?test=${Date.now()}`);
    const hooks = { 'execute.before': [], 'execute.after': [] };
    let tool;
    await plugin.setup({ tool: {
      hook: async (name, callback) => { hooks[name].push(callback); },
      transform: async (edit) => { edit({ add: (definition) => { tool = definition; } }); },
    } });
    process.env.TINYSDD_CHECK_CHANNEL = channel.root;
    process.env.TINYSDD_CHECK_DEADLINE = String(Date.now() + 20000);
    channel.start(20000);
    await body({ tool, hooks, channel });
  } finally {
    clearInterval(poller);
    if (previousRoot === undefined) delete process.env.TINYSDD_CHECK_CHANNEL;
    else process.env.TINYSDD_CHECK_CHANNEL = previousRoot;
    if (previousDeadline === undefined) delete process.env.TINYSDD_CHECK_DEADLINE;
    else process.env.TINYSDD_CHECK_DEADLINE = previousDeadline;
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

test('OpenCode run_checks refuses a call without a tool call id instead of reusing a response', async () => {
  await withOpenCodePlugin(async ({ tool }) => {
    const signal = new AbortController().signal;
    const first = await tool.execute({ checkId: 'unit' }, { id: 'call_1', messageID: 'msg_1', signal });
    assert.equal(JSON.parse(first.content[0].text).results[0].checkId, 'unit');
    await assert.rejects(tool.execute({ checkId: 'unit' }, { messageID: 'msg_1', signal }), /run_checks needs the tool call id/u);
    await assert.rejects(tool.execute({ checkId: 'unit' }, { id: '', messageID: 'msg_1', signal }), /run_checks needs the tool call id/u);
  });
});

test('OpenCode run_checks stops waiting for a write whose execute.after never arrives', async () => {
  await withOpenCodePlugin(async ({ tool, hooks }) => {
    for (const hook of hooks['execute.before']) await hook({ tool: 'write', id: 'call_lost_write', messageID: 'msg_1' });
    const started = Date.now();
    const response = await tool.execute({ checkId: 'unit' }, { id: 'call_check', messageID: 'msg_1', signal: new AbortController().signal });
    const elapsed = Date.now() - started;
    assert.equal(JSON.parse(response.content[0].text).results[0].checkId, 'unit');
    assert.ok(elapsed < 10000, `the check waited ${elapsed} ms for a write that never finished`);
  });
});

const mountManifest = { schemaVersion: 1, dependencyMounts: ['node_modules'], checks: [{ id: 'unit', argv: ['node'], timeoutMs: 1000 }] };

test('dependency identity accepts workspace links that stay inside the project', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-workspace-link-'));
  try {
    await mkdir(join(root, 'packages', 'pkg'), { recursive: true });
    await mkdir(join(root, 'cli'), { recursive: true });
    await mkdir(join(root, 'node_modules', '@scope'), { recursive: true });
    await symlink('../../packages/pkg', join(root, 'node_modules', '@scope', 'pkg'));
    await symlink('../cli', join(root, 'node_modules', 'cli'));
    const { mounts, dependencyIdentity } = await identifyDependencyMounts({ manifest: mountManifest, sourceRoot: root, allowedPaths: ['src/allowed.txt'] });
    assert.deepEqual(mounts, [{ source: join(root, 'node_modules'), target: 'node_modules' }]);
    assert.equal(dependencyIdentity.mounts[0].entries, 3);
    await rm(join(root, 'node_modules', 'cli'));
    await symlink('../packages/pkg', join(root, 'node_modules', 'cli'));
    const retargeted = await identifyDependencyMounts({ manifest: mountManifest, sourceRoot: root, allowedPaths: [] });
    assert.notEqual(retargeted.dependencyIdentity.sha256, dependencyIdentity.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency identity is unavailable, not a configuration error, for links that leave the project', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-escape-'));
  const outside = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-outside-'));
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(outside, join(root, 'node_modules', 'escape'));
    await assert.rejects(
      identifyDependencyMounts({ manifest: mountManifest, sourceRoot: root, allowedPaths: [] }),
      (error) => error.code === 'DEPENDENCY_IDENTITY_UNAVAILABLE' && /symlink escapes the project: escape/u.test(error.message),
    );
    await assert.rejects(
      identifyDependencyMounts({ manifest: { ...mountManifest, dependencyMounts: ['missing'] }, sourceRoot: root, allowedPaths: [] }),
      (error) => error.code !== 'DEPENDENCY_IDENTITY_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('dependency identity covers a node_modules tree above the old 20k entry limit', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-entries-'));
  try {
    const packages = join(root, 'node_modules', 'many');
    await mkdir(packages, { recursive: true });
    const names = Array.from({ length: 20050 }, (_, index) => `f${index}`);
    for (let index = 0; index < names.length; index += 500) {
      await Promise.all(names.slice(index, index + 500).map((name) => writeFile(join(packages, name), '')));
    }
    const { dependencyIdentity } = await identifyDependencyMounts({ manifest: mountManifest, sourceRoot: root, allowedPaths: [] });
    assert.equal(dependencyIdentity.mounts[0].entries, 20051);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency identity for an in-mount link keeps its sha256-tree-v1 serialization', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-compat-'));
  try {
    const mount = join(root, 'node_modules');
    await mkdir(join(mount, 'a'), { recursive: true });
    await writeFile(join(mount, 'a', 'index.js'), 'x\n');
    await symlink('a', join(mount, 'b'));
    const mode = async (path) => (await lstat(path)).mode & 0o7777;
    const records = [
      { path: 'a', kind: 'directory', mode: await mode(join(mount, 'a')) },
      { path: 'a/index.js', kind: 'file', mode: await mode(join(mount, 'a', 'index.js')), bytes: 2, sha256: createHash('sha256').update('x\n').digest('hex') },
      { path: 'b', kind: 'symlink', target: 'a' },
    ];
    const { dependencyIdentity } = await identifyDependencyMounts({ manifest: mountManifest, sourceRoot: root, allowedPaths: [] });
    assert.equal(dependencyIdentity.mounts[0].algorithm, 'sha256-tree-v1');
    assert.equal(dependencyIdentity.mounts[0].sha256, createHash('sha256').update(JSON.stringify(records)).digest('hex'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check channel installs the worker check tool its runner needs', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-tool-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  const manifest = { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'unit', argv: ['node', '-e', ''], timeoutMs: 1000 }] };
  const options = { manifest, sourceRoot: root, workspace, artifactDir, tempRoot: root, allowedPaths: [], maxCheckRuns: 1, nodeRoot: root, runner: async () => { throw new Error('not called'); } };
  const pi = await createCheckChannel(options);
  const opencode = await createCheckChannel({ ...options, tool: 'opencode-plugin' });
  try {
    assert.equal(pi.extension, join(pi.root, 'run-checks.mjs'));
    assert.equal(pi.extensionTarget, '/opt/tinysdd/run-checks.mjs');
    assert.equal(await readFile(pi.extension, 'utf8'), await readFile(new URL('../src/run-checks-extension.mjs', import.meta.url), 'utf8'));
    // OpenCode loads a configured local plugin only from a directory.
    assert.equal(opencode.extension, join(opencode.root, 'run-checks-plugin'));
    assert.equal(opencode.extensionTarget, '/opt/tinysdd/run-checks-plugin');
    assert.equal(await readFile(join(opencode.extension, 'index.js'), 'utf8'), await readFile(new URL('../src/run-checks-opencode-plugin.mjs', import.meta.url), 'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(opencode.extension, 'package.json'), 'utf8')), { type: 'module' });
    const plugin = (await import(pathToFileURL(join(opencode.extension, 'index.js')).href)).default;
    assert.equal(plugin.id, 'tinysdd-run-checks');
    assert.equal(typeof plugin.setup, 'function');
    await assert.rejects(createCheckChannel({ ...options, tool: 'shell' }), /unknown check tool/u);
  } finally {
    await pi.cleanup();
    await opencode.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

// Real sandbox-exec, so it runs on macOS only; Linux CI covers bubblewrap in
// tests/check-runner.test.mjs.
const SEATBELT_SKIP = process.platform !== 'darwin' ? 'needs macOS sandbox-exec' : checkRunnerAvailable().available ? false : checkRunnerAvailable().reason;

test('a run_checks check resolves and reaches localhost but no other host in the seatbelt sandbox (#215)', { skip: SEATBELT_SKIP }, async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-channel-loopback-'));
  const workspace = join(root, 'workspace');
  const artifactDir = join(root, 'artifact');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir);
  await writeFile(join(workspace, 'probe.mjs'), [
    "import { lookup } from 'node:dns/promises';",
    "import { connect, createServer } from 'node:net';",
    "const resolved = await lookup('localhost');",
    "const server = createServer((socket) => socket.end('pong'));",
    "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
    "const reply = await new Promise((resolve, reject) => {",
    "  const socket = connect(server.address().port, 'localhost');",
    "  let text = '';",
    "  socket.on('data', (chunk) => { text += chunk; }).on('end', () => resolve(text)).on('error', reject);",
    "});",
    "server.close();",
    "const outbound = await new Promise((resolve) => {",
    "  const socket = connect({ host: '1.1.1.1', port: 80, timeout: 3000 });",
    "  socket.on('connect', () => { socket.destroy(); resolve('connected'); });",
    "  socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });",
    "  socket.on('error', (error) => resolve(error.code));",
    "});",
    "console.log(JSON.stringify({ address: resolved.address, reply, outbound }));",
    '',
  ].join('\n'));
  const channel = await createCheckChannel({
    manifest: { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'probe', argv: ['node', 'probe.mjs'], timeoutMs: 20000 }] },
    sourceRoot: root,
    workspace,
    artifactDir,
    tempRoot: canonicalTmpdir,
    allowedPaths: ['probe.mjs'],
    maxCheckRuns: 1,
    nodeRoot: dirname(dirname(await realpath(process.execPath))),
  });
  try {
    channel.start(30000);
    const correlation = 'c'.repeat(64);
    await writeFile(join(channel.requests, `${correlation}.json`), JSON.stringify({ checkId: 'probe' }));
    let response;
    for (let attempt = 0; attempt < 600 && response === undefined; attempt += 1) {
      channel.poll();
      response = await readFile(join(channel.responses, `${correlation}.json`), 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (response === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(response, 'no check response');
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const [result] = response.results;
    assert.equal(result.exitCode, 0, result.tail);
    const seen = JSON.parse(result.tail.trim().split('\n').at(-1));
    assert.match(seen.address, /^(127\.0\.0\.1|::1)$/u);
    assert.equal(seen.reply, 'pong');
    assert.notEqual(seen.outbound, 'connected');
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
