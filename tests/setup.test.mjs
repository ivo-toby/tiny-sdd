import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CLI_VERSION,
  installRegistry,
  updateProfiles,
  updateSkills,
  DOWNLOAD_TIMEOUT_MS,
  MAX_ARCHIVE_BYTES,
  MAX_EXTRACTED_BYTES,
  PI_PACKAGE_NAME,
  PI_VERSION,
  checkNodeVersion,
  extractReleaseArchive,
  inspectPiInstallation,
  inspectPiModels,
  inspectPrerequisites,
  inspectSandbox,
  installBundle,
  downloadReleaseArchive,
  probeBubblewrapStartup,
  runSetup,
  validateBundle,
} from '../src/setup.mjs';

const root = await realpath(tmpdir());
const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');

async function temporary(prefix) {
  return mkdtemp(join(root, prefix));
}

async function cleanup(path) {
  await rm(path, { recursive: true, force: true });
}

function field(buffer, offset, length, value) {
  const text = String(value);
  buffer.write(text, offset, Math.min(length, Buffer.byteLength(text)), 'ascii');
}

function tarHeader(name, size, type = '0', mode = 0o644) {
  const header = Buffer.alloc(512);
  field(header, 0, 100, name);
  field(header, 100, 8, `${mode.toString(8).padStart(7, '0')} `);
  field(header, 108, 8, '0000000 ');
  field(header, 116, 8, '0000000 ');
  field(header, 124, 12, `${size.toString(8).padStart(11, '0')} `);
  field(header, 136, 12, '00000000000 ');
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  field(header, 257, 6, 'ustar\0');
  field(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')} \0`);
  return header;
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(`${key}=${value}\n`) + 3;
  while (String(length).length + Buffer.byteLength(`${key}=${value}\n`) + 1 !== length) {
    length += 1;
  }
  return Buffer.from(`${length} ${key}=${value}\n`);
}

function tarEntry(name, content, type = '0') {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = tarHeader(name, type === '5' ? 0 : data.length, type);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function archive(entries, { rootName = `tiny-sdd-${CLI_VERSION}`, includeGlobalPax = true } = {}) {
  const chunks = [];
  if (includeGlobalPax) chunks.push(tarEntry('pax_global_header', paxRecord('comment', 'synthetic archive'), 'g'));
  chunks.push(tarEntry(`${rootName}/`, '', '5'));
  for (const [path, content, type = '0'] of entries) {
    const full = `${rootName}/${path}`;
    if (type === '0' && Buffer.byteLength(full) > 100) {
      chunks.push(tarEntry(`${rootName}/PaxHeaders.0/resource`, paxRecord('path', full), 'x'));
      chunks.push(tarEntry(`${rootName}/resource`, content));
    } else {
      chunks.push(tarEntry(full, content, type));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

async function fakePi(home, version = PI_VERSION) {
  const nodeRoot = await temporary('tinysdd-pi-');
  const bin = join(nodeRoot, 'bin');
  await mkdir(bin, { recursive: true });
  const node = join(bin, 'node');
  const pi = join(bin, 'pi');
  await writeFile(node, '#!/bin/sh\n');
  await writeFile(pi, '#!/bin/sh\n');
  await chmod(node, 0o755);
  await chmod(pi, 0o755);
  await writeFile(join(bin, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version }));
  return { node, pi, root: nodeRoot };
}

function fakeProbe({ code = 0, signal = null, stderr = '', stdout = '', timeout = false, error = null, throwError = null } = {}) {
  const calls = [];
  let lastChild;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (throwError) throw throwError;
    const child = new EventEmitter();
    lastChild = child;
    child.killSignals = [];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (killSignal) => {
      child.killed = killSignal;
      child.killSignals.push(killSignal);
      if (!child.closed) {
        child.closed = true;
        queueMicrotask(() => child.emit('close', null, killSignal));
      }
      return true;
    };
    if (!timeout) {
      queueMicrotask(() => {
        if (error) child.emit('error', error);
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        if (!child.closed) {
          child.closed = true;
          child.emit('close', code, signal);
        }
      });
    }
    return child;
  };
  return { spawnImpl, calls, get lastChild() { return lastChild; } };
}

test('Node floor and Pi installation checks distinguish missing, unsupported, and ready states', async () => {
  assert.equal(checkNodeVersion('22.18.9').supported, false);
  assert.equal(checkNodeVersion('22.19.0').supported, true);
  const home = await temporary('tinysdd-setup-home-');
  const missingRoot = await temporary('tinysdd-node-');
  try {
    const missing = await inspectPiInstallation({ nodeExecutable: join(missingRoot, 'bin', 'node') });
    assert.equal(missing.status, 'missing');
    const pi = await fakePi(home);
    const ready = await inspectPiInstallation({ nodeExecutable: pi.node });
    assert.equal(ready.status, 'ready');
    const unsupported = await inspectPiInstallation({ nodeExecutable: pi.node, expectedVersion: '9.9.9' });
    assert.equal(unsupported.status, 'unsupported-version');
  } finally {
    await cleanup(home);
    await cleanup(missingRoot);
  }
});

test('Pi model metadata is secret-blind and distinguishes no explicit config from unusable config', async () => {
  const home = await temporary('tinysdd-model-home-');
  try {
    const missing = await inspectPiModels({ homeDir: home, sourceEnv: {} });
    assert.equal(missing.status, 'missing-explicit-config');
    const agent = join(home, 'agent');
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, 'models.json'), JSON.stringify({
      providers: {
        empty: { models: [] },
        local: {
          api: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          apiKey: 'do-not-report',
          models: [{ id: 'model-a', reasoning: true, headers: { Authorization: 'do-not-report' } }],
        },
      },
    }));
    const configured = await inspectPiModels({ sourceAgentDir: agent, sourceEnv: {} });
    assert.equal(configured.status, 'ready');
    assert.equal(configured.providers[1].models[0].id, 'model-a');
    assert.doesNotMatch(JSON.stringify(configured), /do-not-report/u);
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { empty: { models: [] } } }));
    const unusable = await inspectPiModels({ sourceAgentDir: agent, sourceEnv: {} });
    assert.equal(unusable.status, 'no-usable-models');
    assert.equal(unusable.usable, false);
  } finally {
    await cleanup(home);
  }
});

test('bubblewrap startup probe uses the worker namespace and mount shape with a scrubbed environment', async () => {
  const fixture = fakeProbe();
  const opened = [];
  const openImpl = async (path) => ({
    read: async (buffer, offset, length) => {
      opened.push({ path, length });
      const value = path.endsWith('uid_map') ? '0 1000000 1000000000\n' : '1\n';
      buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
      return { bytesRead: Math.min(length, Buffer.byteLength(value)) };
    },
    close: async () => {},
  });
  const probe = await probeBubblewrapStartup({
    executable: '/usr/bin/bwrap',
    spawnImpl: fixture.spawnImpl,
    openImpl,
  });
  assert.equal(probe.status, 'passed');
  assert.equal(probe.supported, true);
  assert.deepEqual(probe.diagnostics, { uidMap: '0 1000000 1000000000', apparmorUnprivilegedUserns: '1' });
  assert.equal(fixture.calls.length, 1);
  const [call] = fixture.calls;
  assert.equal(call.command, '/usr/bin/bwrap');
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.env, { HOME: '/home', PATH: '/usr/bin:/bin', LC_ALL: 'C' });
  assert.equal(opened.length, 2);
  assert.ok(opened.every(({ length }) => length === 256));
  assert.ok(call.args.includes('--unshare-user'));
  assert.ok(call.args.includes('--unshare-pid'));
  // The worker runs without host networking, so the probe needs a network namespace too.
  assert.ok(call.args.includes('--unshare-net'));
  assert.ok(call.args.includes('--ro-bind'));
  assert.ok(call.args.includes('--bind'));
  assert.equal(call.args.at(-1), '/usr/bin/true');
  assert.match(probe.reproduction.command, /--unshare-user.*--unshare-pid.*--unshare-net.*\/usr\/bin\/true/u);
});

test('bubblewrap startup probe distinguishes silent failures, diagnostics, timeouts, and launch errors', async () => {
  const cases = [
    { name: 'silent failure', fixture: fakeProbe({ code: 1 }), status: 'failed-empty-stderr', expected: /without diagnostic output/u },
    { name: 'diagnostic failure', fixture: fakeProbe({ code: 1, stderr: 'unshare failed\n' }), status: 'failed', expected: /unshare failed/u },
    { name: 'timeout', fixture: fakeProbe({ timeout: true }), status: 'timeout', expected: /timed out/u },
    { name: 'launch error event', fixture: fakeProbe({ error: Object.assign(new Error('spawn denied'), { code: 'EPERM' }) }), status: 'launch-error', expected: /spawn denied/u },
    { name: 'launch error throw', fixture: fakeProbe({ throwError: new Error('spawn unavailable') }), status: 'launch-error', expected: /spawn unavailable/u },
  ];
  for (const entry of cases) {
    const probe = await probeBubblewrapStartup({ executable: '/usr/bin/bwrap', timeoutMs: 20, spawnImpl: entry.fixture.spawnImpl });
    assert.equal(probe.status, entry.status, entry.name);
    assert.equal(probe.supported, false, entry.name);
    assert.match(probe.reason, entry.expected, entry.name);
    if (entry.status === 'timeout') assert.ok(entry.fixture.lastChild.killSignals.includes('SIGTERM'));
  }
  const oversized = await probeBubblewrapStartup({ executable: '/usr/bin/bwrap', spawnImpl: fakeProbe({ code: 1, stderr: 'x'.repeat(10_000) }).spawnImpl });
  assert.equal(oversized.outputTruncated, true);
  assert.ok(Buffer.byteLength(oversized.stderr) <= 4 * 1024);
});

test('bubblewrap startup probe marks missing and non-Linux hosts without launching anything', async () => {
  let launches = 0;
  const spawnImpl = () => { launches += 1; throw new Error('must not launch'); };
  const missing = await probeBubblewrapStartup({ spawnImpl });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.attempted, false);
  const mac = await probeBubblewrapStartup({ platform: 'darwin', executable: '/usr/bin/bwrap', spawnImpl });
  assert.equal(mac.status, 'unsupported-platform');
  assert.equal(mac.attempted, false);
  assert.equal(launches, 0);
});

test('bubblewrap startup probe can spawn a deterministic executable and cleans a timed-out child', async () => {
  const fixtureRoot = await temporary('tinysdd-bwrap-executable-');
  const passingExecutable = join(fixtureRoot, 'passing-bwrap');
  const hangingExecutable = join(fixtureRoot, 'hanging-bwrap');
  try {
    await writeFile(passingExecutable, '#!/bin/sh\nexit 0\n');
    await writeFile(hangingExecutable, '#!/bin/sh\nwhile :; do :; done\n');
    await chmod(passingExecutable, 0o755);
    await chmod(hangingExecutable, 0o755);
    const passing = await probeBubblewrapStartup({ executable: passingExecutable });
    assert.equal(passing.status, 'passed');
    const timedOut = await probeBubblewrapStartup({ executable: hangingExecutable, timeoutMs: 25 });
    assert.equal(timedOut.status, 'timeout');
    assert.equal(timedOut.timedOut, true);
  } finally {
    await cleanup(fixtureRoot);
  }
});

test('sandbox inspection reports macOS inference support with Linux-only check limitation', async () => {
  const home = await temporary('tinysdd-sandbox-');
  try {
    const bwrap = join(home, 'bwrap');
    const prlimit = join(home, 'prlimit');
    await writeFile(bwrap, '');
    await writeFile(prlimit, '');
    await chmod(bwrap, 0o755);
    await chmod(prlimit, 0o755);
    const passingProbe = fakeProbe();
    const linux = await inspectSandbox({ platform: 'linux', privileged: false, executablePaths: { bwrap, prlimit }, probe: { spawnImpl: passingProbe.spawnImpl } });
    assert.equal(linux.worker.supported, true);
    assert.equal(linux.checks.available, true);
    const missingRunnerTool = await inspectSandbox({ platform: 'linux', privileged: false, executablePaths: { bwrap, prlimit: join(home, 'missing-prlimit') }, probe: { spawnImpl: fakeProbe().spawnImpl } });
    assert.equal(missingRunnerTool.worker.supported, true);
    assert.equal(missingRunnerTool.checks.available, false);
    assert.match(missingRunnerTool.checks.reason, /prlimit/u);
    const blocked = await inspectSandbox({ platform: 'linux', privileged: false, executablePaths: { bwrap, prlimit }, probe: { spawnImpl: fakeProbe({ code: 1 }).spawnImpl } });
    assert.equal(blocked.worker.supported, false);
    assert.equal(blocked.worker.probe.status, 'failed-empty-stderr');
    assert.equal(blocked.checks.available, false);
    const mac = await inspectSandbox({ platform: 'darwin', executablePaths: { sandboxExec: bwrap } });
    assert.equal(mac.worker.supported, true);
    assert.equal(mac.checks.available, false);
    assert.match(mac.checks.reason, /macOS|Linux/u);
  } finally {
    await cleanup(home);
  }
});

test('versioned PAX archive extraction rejects traversal and preserves long resource paths', async () => {
  const destination = await temporary('tinysdd-extract-');
  const longPath = `skills/tinysdd/assets/harness/claude/tinysdd-frontier/templates/${'long-'.repeat(20)}.md`;
  try {
    const source = await extractReleaseArchive(archive([[longPath, 'resource\n']]), destination);
    assert.equal(await readFile(join(source, ...longPath.split('/')), 'utf8'), 'resource\n');
    await assert.rejects(extractReleaseArchive(archive([['../escape.txt', 'bad']]), destination), { code: 'SETUP_ARCHIVE_INVALID' });
  } finally {
    await cleanup(destination);
  }
});

test('archive extraction ignores native registration links and rejects payload links', async () => {
  const destination = await temporary('tinysdd-links-');
  try {
    const source = await extractReleaseArchive(archive([
      ['.agents/skills/tinysdd', '../../skills/tinysdd', '2'],
      ['.claude/skills/tinysdd', '../../.agents/skills/tinysdd', '2'],
    ]), destination);
    await assert.rejects(lstat(join(source, '.agents')), { code: 'ENOENT' });
    await assert.rejects(extractReleaseArchive(archive([
      ['skills/tinysdd/conflicting-link', '../outside', '2'],
    ]), destination), { code: 'SETUP_ARCHIVE_INVALID' });
  } finally {
    await cleanup(destination);
  }
});

test('archive download bounds streaming bodies, cancels oversized reads, and times out hung reads', async () => {
  let cancelled = false;
  await assert.rejects(downloadReleaseArchive({ fetchImpl: async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: Buffer.alloc(MAX_ARCHIVE_BYTES + 1) }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    },
  }) }), { code: 'SETUP_ARCHIVE_INVALID' });
  assert.equal(cancelled, true);

  let timeoutSignal;
  let timeoutCancelled = false;
  await assert.rejects(downloadReleaseArchive({ timeoutMs: DOWNLOAD_TIMEOUT_MS < 20 ? DOWNLOAD_TIMEOUT_MS : 10, fetchImpl: async (_url, options) => {
    timeoutSignal = options.signal;
    return {
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: async () => { timeoutCancelled = true; },
          releaseLock: () => {},
        }),
      },
    };
  } }), { code: 'SETUP_RELEASE_UNAVAILABLE' });
  assert.equal(timeoutSignal.aborted, true);
  assert.equal(timeoutCancelled, true);
});

test('gzip expansion is bounded before tar parsing', async () => {
  const destination = await temporary('tinysdd-gzip-limit-');
  try {
    const oversized = gzipSync(Buffer.alloc(MAX_EXTRACTED_BYTES + 2));
    await assert.rejects(extractReleaseArchive(oversized, destination), { code: 'SETUP_ARCHIVE_INVALID' });
  } finally {
    await cleanup(destination);
  }
});

test('bundle validation and global installation preserve resources, config, links, and repeatability', async () => {
  const home = await temporary('tinysdd-install-home-');
  try {
    const metadata = await validateBundle(repoRoot);
    assert.equal(metadata.version, CLI_VERSION);
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), 'keep this config\n');
    await mkdir(join(home, '.agents', 'skills', 'unrelated'), { recursive: true });
    await writeFile(join(home, '.agents', 'skills', 'unrelated', 'SKILL.md'), 'keep this skill\n');
    const first = await installBundle({ sourceRoot: repoRoot, homeDir: home });
    assert.ok(first.filesWritten.length > 10);
    assert.equal(await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8'), 'keep this config\n');
    assert.equal(await readFile(join(home, '.agents', 'skills', 'unrelated', 'SKILL.md'), 'utf8'), 'keep this skill\n');
    const codexLink = join(home, '.agents', 'skills', 'tinysdd');
    const claudeLink = join(home, '.claude', 'skills', 'tinysdd');
    assert.equal((await realpath(codexLink)), join(home, '.agents', 'tinysdd', 'skills', 'tinysdd'));
    assert.equal((await realpath(claudeLink)), join(home, '.agents', 'tinysdd', 'skills', 'tinysdd'));
    assert.equal(await readFile(join(home, '.agents', 'tinysdd', 'docs', 'context-compiler.md'), 'utf8'), await readFile(join(repoRoot, 'docs', 'context-compiler.md'), 'utf8'));
    const second = await installBundle({ sourceRoot: repoRoot, homeDir: home });
    assert.equal(second.filesWritten.length, 0);
    assert.equal(second.filesPreserved.length, first.filesWritten.length);
    assert.equal(second.linksCreated.length, 0);
    assert.equal(second.linksPreserved.length, 4);
    await writeFile(join(home, '.agents', 'tinysdd', 'skills', 'tinysdd', 'SKILL.md'), 'operator-owned change\n');
    await assert.rejects(installBundle({ sourceRoot: repoRoot, homeDir: home }), { code: 'SETUP_CONFLICT' });
  } finally {
    await cleanup(home);
  }
});

test('runSetup installs a version-matched archive and reports metadata-only readiness', async () => {
  const home = await temporary('tinysdd-run-setup-home-');
  const pi = await fakePi(home);
  const agent = join(home, 'agent');
  try {
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { local: { models: [{ id: 'model-a' }] } } }));
    const entries = [];
    for (const path of ['package.json', 'skills/tinysdd/SKILL.md', 'skills/tinysdd/assets/setup/SKILL.md', 'skills/tinysdd/references/cli-workflow.md', 'docs/artifact-format.md', 'docs/context-compiler.md', 'docs/quickstart.md', 'profiles/titan-gemma4-26b-a4b-2x64k-v1.json']) {
      entries.push([path, await readFile(join(repoRoot, path))]);
    }
    const result = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: pi.pi } }, configDir: join(home, 'config'), archiveBytes: archive(entries) });
    assert.equal(result.version, CLI_VERSION);
    assert.equal(result.checks.pi.status, 'ready');
    assert.equal(result.checks.models.status, 'ready');
    assert.equal(result.checks.sandbox.worker.supported, true);
    assert.equal(result.checks.authentication.status, 'unknown');
    assert.match(result.nextSteps.join('\n'), /Linux-only|authorized worker smoke|metadata/u);
    const linuxResult = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'linux', sandbox: { privileged: false, executablePaths: { bwrap: pi.pi, prlimit: join(home, 'missing-prlimit') }, probe: { spawnImpl: fakeProbe().spawnImpl } }, configDir: join(home, 'config'), archiveBytes: archive(entries) });
    assert.equal(linuxResult.ready, true);
    assert.equal(linuxResult.checks.sandbox.checks.available, false);
    assert.match(linuxResult.nextSteps.join('\n'), /Linux run_checks is unavailable/u);
    assert.match(linuxResult.warnings.join('\n'), /check-runner readiness/u);
    const blockedResult = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'linux', sandbox: { privileged: false, executablePaths: { bwrap: pi.pi, prlimit: pi.pi }, probe: { spawnImpl: fakeProbe({ code: 1 }).spawnImpl } }, configDir: join(home, 'config'), archiveBytes: archive(entries) });
    assert.equal(blockedResult.ready, false);
    assert.equal(blockedResult.checks.sandbox.worker.supported, false);
    assert.equal(blockedResult.checks.sandbox.worker.probe.status, 'failed-empty-stderr');
    assert.match(blockedResult.nextSteps.join('\n'), /Reproduce the bounded probe with:.*--unshare-user/u);
    assert.match(blockedResult.warnings.join('\n'), /prerequisites are not ready/u);
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('release download is version-pinned and reports a missing tag without falling back', async () => {
  let requested;
  await assert.rejects(downloadReleaseArchive({ fetchImpl: async (url) => {
    requested = url;
    return { ok: false, status: 404 };
  } }), (error) => {
    assert.equal(error.code, 'SETUP_RELEASE_UNAVAILABLE');
    assert.ok(error.message.includes(`versioned Git tag v${CLI_VERSION}`));
    return true;
  });
  assert.equal(requested, `https://codeload.github.com/ivo-toby/tiny-sdd/tar.gz/refs/tags/v${CLI_VERSION}`);
});

test('setup rejects a requested version different from the installed CLI', async () => {
  await assert.rejects(runSetup({ version: '9.9.9', archiveBytes: Buffer.from('not-an-archive') }), { code: 'SETUP_VERSION_MISMATCH' });
});

test('setup rejects a project-scoped invocation before setup work', async () => {
  const cli = new URL('../bin/tinysdd.mjs', import.meta.url);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await assert.rejects(exec(process.execPath, [cli.pathname, '--json', '--project', root, 'setup']), (error) => {
    assert.equal(error.stdout.trim().split('\n').length, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.error.code, 'SETUP_PROJECT_UNSUPPORTED');
    return true;
  });
});

test('global setup is cwd-independent and leaves a project config untouched', async () => {
  const cwd = await temporary('tinysdd-cli-project-');
  const home = await temporary('tinysdd-cli-home-');
  const pi = await fakePi(home);
  const agent = join(home, 'agent');
  const previousCwd = process.cwd();
  try {
    await mkdir(join(cwd, '.tinysdd'), { recursive: true });
    await writeFile(join(cwd, '.tinysdd', 'config.json'), '{"workers":{}}\n');
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { local: { models: [{ id: 'model-a' }] } } }));
    const entries = [];
    for (const path of ['package.json', 'skills/tinysdd/SKILL.md', 'skills/tinysdd/assets/setup/SKILL.md', 'skills/tinysdd/references/cli-workflow.md', 'docs/artifact-format.md', 'docs/context-compiler.md', 'docs/quickstart.md', 'profiles/titan-gemma4-26b-a4b-2x64k-v1.json']) {
      entries.push([path, await readFile(join(repoRoot, path))]);
    }
    const before = await readFile(join(cwd, '.tinysdd', 'config.json'));
    process.chdir(cwd);
    const result = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: pi.pi } }, configDir: join(home, 'config'), archiveBytes: archive(entries) });
    assert.equal(result.installation.bundleRoot, join(home, '.agents', 'tinysdd'));
    assert.deepEqual(await readFile(join(cwd, '.tinysdd', 'config.json')), before);
  } finally {
    process.chdir(previousCwd);
    await cleanup(cwd);
    await cleanup(home);
    await cleanup(pi.root);
  }
});

const RELEASE_FILES = ['package.json', 'skills/tinysdd/SKILL.md', 'skills/tinysdd/assets/setup/SKILL.md', 'skills/tinysdd/references/cli-workflow.md', 'docs/artifact-format.md', 'docs/context-compiler.md', 'docs/quickstart.md'];

async function releaseEntries({ profiles = ['titan-gemma4-26b-a4b-2x64k-v1.json', 'titan-qwen36-35b-a3b-2x128k-mt32-v1.json'], extra = [] } = {}) {
  const entries = [];
  for (const path of RELEASE_FILES) entries.push([path, await readFile(join(repoRoot, path))]);
  for (const name of profiles) entries.push([`profiles/${name}`, await readFile(join(repoRoot, 'profiles', name))]);
  return [...entries, ...extra];
}

async function setupHome() {
  const home = await temporary('tinysdd-registry-home-');
  const pi = await fakePi(home);
  const agent = join(home, 'agent');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { local: { models: [{ id: 'model-a' }] } } }));
  const options = { homeDir: home, configDir: join(home, 'config'), nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: pi.pi } } };
  return { home, pi, options, registry: join(home, 'config', 'registry') };
}

test('setup installs the profile registry and refuses to overwrite a changed one', async () => {
  const { home, pi, options, registry } = await setupHome();
  try {
    const first = await runSetup({ ...options, archiveBytes: archive(await releaseEntries()) });
    assert.equal(first.registry.action, 'install');
    assert.deepEqual(first.registry.profiles, ['titan-gemma4-26b-a4b-2x64k-v1', 'titan-qwen36-35b-a3b-2x128k-mt32-v1']);
    assert.deepEqual(
      await readFile(join(registry, 'titan-gemma4-26b-a4b-2x64k-v1.json')),
      await readFile(join(repoRoot, 'profiles', 'titan-gemma4-26b-a4b-2x64k-v1.json')),
    );
    const manifest = JSON.parse(await readFile(join(registry, '.registry.json'), 'utf8'));
    assert.equal(manifest.version, CLI_VERSION);
    const again = await runSetup({ ...options, archiveBytes: archive(await releaseEntries()) });
    assert.equal(again.registry.action, 'preserve');

    await writeFile(join(registry, 'titan-gemma4-26b-a4b-2x64k-v1.json'), '{"edited":true}\n');
    const skillsBefore = await readFile(join(home, '.agents', 'tinysdd', 'skills', 'tinysdd', 'SKILL.md'));
    await assert.rejects(runSetup({ ...options, archiveBytes: archive(await releaseEntries()) }), (error) => {
      assert.equal(error.code, 'SETUP_CONFLICT');
      assert.match(error.message, /tinysdd profiles update/u);
      return true;
    });
    assert.deepEqual(await readFile(join(home, '.agents', 'tinysdd', 'skills', 'tinysdd', 'SKILL.md')), skillsBefore);
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('profiles update replaces the registry and leaves local profiles alone', async () => {
  const { home, pi, options, registry } = await setupHome();
  try {
    await runSetup({ ...options, archiveBytes: archive(await releaseEntries()) });
    await writeFile(join(registry, '.registry.json'), JSON.stringify({ schemaVersion: 1, version: '0.0.1' }));
    await writeFile(join(registry, 'titan-gemma4-26b-a4b-2x64k-v1.json'), '{"stale":true}\n');
    await writeFile(join(registry, 'retired-v1.json'), '{"retired":true}\n');
    await mkdir(join(options.configDir, 'profiles'), { recursive: true });
    await writeFile(join(options.configDir, 'profiles', 'mine.json'), '{"mine":true}\n');

    const result = await updateProfiles({ configDir: options.configDir, archiveBytes: archive(await releaseEntries({ profiles: ['titan-gemma4-26b-a4b-2x64k-v1.json'] })) });
    assert.equal(result.registry.action, 'replace');
    assert.equal(result.registry.previousVersion, '0.0.1');
    assert.deepEqual(result.registry.profiles, ['titan-gemma4-26b-a4b-2x64k-v1']);
    assert.deepEqual(
      await readFile(join(registry, 'titan-gemma4-26b-a4b-2x64k-v1.json')),
      await readFile(join(repoRoot, 'profiles', 'titan-gemma4-26b-a4b-2x64k-v1.json')),
    );
    await assert.rejects(lstat(join(registry, 'retired-v1.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(options.configDir, 'profiles', 'mine.json'), 'utf8'), '{"mine":true}\n');
    assert.equal(JSON.parse(await readFile(join(registry, '.registry.json'), 'utf8')).version, CLI_VERSION);
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('a release without a valid profile registry is rejected before anything is written', async () => {
  const { home, pi, options, registry } = await setupHome();
  try {
    await assert.rejects(updateProfiles({ configDir: options.configDir, archiveBytes: archive(await releaseEntries({ profiles: [] })) }), (error) => {
      assert.equal(error.code, 'SETUP_ARCHIVE_INVALID');
      assert.match(error.message, /profiles\/ registry/u);
      return true;
    });
    const broken = await releaseEntries({ extra: [['profiles/broken.json', '{"schemaVersion":1,"id":"broken","status":"great"}']] });
    await assert.rejects(runSetup({ ...options, archiveBytes: archive(broken) }), (error) => {
      assert.equal(error.code, 'SETUP_ARCHIVE_INVALID');
      assert.match(error.message, /profiles\/broken\.json/u);
      return true;
    });
    await assert.rejects(lstat(registry), { code: 'ENOENT' });
    await assert.rejects(lstat(join(home, '.agents', 'tinysdd')), { code: 'ENOENT' });
    const duplicate = await releaseEntries({ extra: [['profiles/copy.json', await readFile(join(repoRoot, 'profiles', 'titan-gemma4-26b-a4b-2x64k-v1.json'))]] });
    const extraction = await temporary('tinysdd-extract-');
    try {
      const sourceRoot = await extractReleaseArchive(archive(duplicate), extraction);
      await assert.rejects(installRegistry({ sourceRoot, configDir: options.configDir }), { code: 'SETUP_ARCHIVE_INVALID' });
    } finally {
      await cleanup(extraction);
    }
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('skills update replaces a changed bundle that setup refuses to overwrite', async () => {
  const { home, pi, options } = await setupHome();
  try {
    await runSetup({ ...options, archiveBytes: archive(await releaseEntries()) });
    const skill = join(home, '.agents', 'tinysdd', 'skills', 'tinysdd', 'SKILL.md');
    await writeFile(skill, 'old skill\n');
    await writeFile(join(home, '.agents', 'tinysdd', 'docs', 'removed.md'), 'gone in this release\n');
    await assert.rejects(installBundle({ sourceRoot: repoRoot, homeDir: home }), { code: 'SETUP_CONFLICT' });

    const result = await updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) });
    assert.equal(result.version, CLI_VERSION);
    assert.equal(result.previousVersion, CLI_VERSION);
    assert.deepEqual(await readFile(skill), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));
    await assert.rejects(lstat(join(home, '.agents', 'tinysdd', 'docs', 'removed.md')), { code: 'ENOENT' });
    assert.deepEqual(result.linksCreated, []);
    assert.deepEqual(await readFile(join(home, '.claude', 'skills', 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));

    const fresh = await temporary('tinysdd-fresh-home-');
    try {
      const installed = await updateSkills({ homeDir: fresh, archiveBytes: archive(await releaseEntries()) });
      assert.equal(installed.previousVersion, null);
      assert.equal(installed.linksCreated.length, 4);
    } finally {
      await cleanup(fresh);
    }
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('setup and skills update resolve a symlinked skills directory and bundle root', async () => {
  const home = await temporary('tinysdd-symlink-home-');
  const dotfiles = await temporary('tinysdd-dotfiles-');
  try {
    const realAgents = join(dotfiles, 'agents');
    const realClaudeSkills = join(dotfiles, 'claude-skills');
    await mkdir(join(realAgents, 'skills', 'unrelated'), { recursive: true });
    await writeFile(join(realAgents, 'skills', 'unrelated', 'SKILL.md'), 'keep this skill\n');
    await mkdir(realClaudeSkills, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(realAgents, join(home, '.agents'));
    await symlink(realClaudeSkills, join(home, '.claude', 'skills'));

    const first = await installBundle({ sourceRoot: repoRoot, homeDir: home });
    assert.equal(first.bundleRoot, join(realAgents, 'tinysdd'));
    assert.equal(await readFile(join(realAgents, 'skills', 'unrelated', 'SKILL.md'), 'utf8'), 'keep this skill\n');
    assert.equal((await realpath(join(home, '.claude', 'skills', 'tinysdd'))), join(realAgents, 'tinysdd', 'skills', 'tinysdd'));
    assert.deepEqual(await readFile(join(realClaudeSkills, 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));

    await writeFile(join(realAgents, 'tinysdd', 'skills', 'tinysdd', 'SKILL.md'), 'operator-owned change\n');
    await assert.rejects(installBundle({ sourceRoot: repoRoot, homeDir: home }), { code: 'SETUP_CONFLICT' });

    const result = await updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) });
    assert.equal(result.bundleRoot, join(realAgents, 'tinysdd'));
    assert.equal(result.previousVersion, CLI_VERSION);
    assert.deepEqual(await readFile(join(realAgents, 'tinysdd', 'skills', 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));
    assert.deepEqual(await readFile(join(realClaudeSkills, 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));
  } finally {
    await cleanup(home);
    await cleanup(dotfiles);
  }
});

test('skills update resolves a symlinked bundle root and keeps unrelated entries', async () => {
  const home = await temporary('tinysdd-symlink-bundle-home-');
  const dotfiles = await temporary('tinysdd-bundle-dotfiles-');
  try {
    await runSetup({ homeDir: home, configDir: join(home, 'config'), nodeExecutable: process.execPath, nodeVersion: process.versions.node, sourceAgentDir: home, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: process.execPath } }, archiveBytes: archive(await releaseEntries()) });
    const realBundle = join(dotfiles, 'tinysdd-bundle');
    await mkdir(realBundle, { recursive: true });
    await rm(join(home, '.agents', 'tinysdd'), { recursive: true, force: true });
    await symlink(realBundle, join(home, '.agents', 'tinysdd'));
    await writeFile(join(realBundle, 'package.json'), JSON.stringify({ name: 'tinysdd', version: CLI_VERSION }));
    await mkdir(join(realBundle, 'skills', 'tinysdd'), { recursive: true });
    await mkdir(join(realBundle, 'docs'), { recursive: true });
    await writeFile(join(realBundle, 'skills', 'tinysdd', 'SKILL.md'), 'old skill\n');
    await writeFile(join(realBundle, 'docs', 'stale.md'), 'gone in this release\n');

    const result = await updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) });
    assert.equal(result.bundleRoot, realBundle);
    assert.equal(result.previousVersion, CLI_VERSION);
    await assert.rejects(lstat(join(realBundle, 'docs', 'stale.md')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(realBundle, 'skills', 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));
    const bundleInfo = await lstat(join(home, '.agents', 'tinysdd'));
    assert.equal(bundleInfo.isSymbolicLink(), true);
  } finally {
    await cleanup(home);
    await cleanup(dotfiles);
  }
});

test('skills update rejects a symlinked skills entry that points elsewhere', async () => {
  const { home, pi, options } = await setupHome();
  try {
    await runSetup({ ...options, archiveBytes: archive(await releaseEntries()) });
    await rm(join(home, '.claude', 'skills', 'tinysdd'), { force: true });
    await symlink('../../elsewhere', join(home, '.claude', 'skills', 'tinysdd'));
    await assert.rejects(updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) }), (error) => {
      assert.equal(error.code, 'SETUP_CONFLICT');
      assert.match(error.message, /points elsewhere/u);
      return true;
    });
  } finally {
    await cleanup(home);
    await cleanup(pi.root);
  }
});

test('setup and skills update follow a dangling symlink to a not-yet-created target', async () => {
  const home = await temporary('tinysdd-dangling-home-');
  const dotfiles = await temporary('tinysdd-dangling-dotfiles-');
  try {
    const realAgents = join(dotfiles, 'agents');
    await mkdir(realAgents, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(realAgents, join(home, '.agents'));
    await symlink(join(dotfiles, 'claude-skills'), join(home, '.claude', 'skills'));
    await symlink(join(dotfiles, 'bundle'), join(realAgents, 'tinysdd'));

    const first = await installBundle({ sourceRoot: repoRoot, homeDir: home });
    assert.equal(first.bundleRoot, join(dotfiles, 'bundle'));
    assert.equal((await lstat(join(realAgents, 'tinysdd'))).isSymbolicLink(), true);
    assert.deepEqual(await readFile(join(dotfiles, 'claude-skills', 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));

    await writeFile(join(dotfiles, 'bundle', 'skills', 'tinysdd', 'SKILL.md'), 'operator-owned change\n');
    const result = await updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) });
    assert.equal(result.bundleRoot, join(dotfiles, 'bundle'));
    assert.deepEqual(await readFile(join(dotfiles, 'bundle', 'skills', 'tinysdd', 'SKILL.md')), await readFile(join(repoRoot, 'skills', 'tinysdd', 'SKILL.md')));
    assert.equal((await lstat(join(realAgents, 'tinysdd'))).isSymbolicLink(), true);
  } finally {
    await cleanup(home);
    await cleanup(dotfiles);
  }
});

test('skills update refuses to replace a symlinked bundle root that is not a TinySDD bundle', async () => {
  const home = await temporary('tinysdd-unsafe-bundle-home-');
  const dotfiles = await temporary('tinysdd-unsafe-dotfiles-');
  try {
    await runSetup({ homeDir: home, configDir: join(home, 'config'), nodeExecutable: process.execPath, nodeVersion: process.versions.node, sourceAgentDir: home, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: process.execPath } }, archiveBytes: archive(await releaseEntries()) });
    const other = join(dotfiles, 'some-repo');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'README.md'), 'not a tinysdd bundle\n');
    await rm(join(home, '.agents', 'tinysdd'), { recursive: true, force: true });
    await symlink(other, join(home, '.agents', 'tinysdd'));

    await assert.rejects(updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) }), (error) => {
      assert.equal(error.code, 'SETUP_CONFLICT');
      assert.match(error.message, /not a TinySDD bundle/u);
      return true;
    });
    assert.equal(await readFile(join(other, 'README.md'), 'utf8'), 'not a tinysdd bundle\n');
    assert.equal((await lstat(join(home, '.agents', 'tinysdd'))).isSymbolicLink(), true);
  } finally {
    await cleanup(home);
    await cleanup(dotfiles);
  }
});

test('skills update refuses to replace a symlinked bundle root that is a source checkout', async () => {
  const home = await temporary('tinysdd-checkout-bundle-home-');
  const dotfiles = await temporary('tinysdd-checkout-dotfiles-');
  try {
    await runSetup({ homeDir: home, configDir: join(home, 'config'), nodeExecutable: process.execPath, nodeVersion: process.versions.node, sourceAgentDir: home, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: process.execPath } }, archiveBytes: archive(await releaseEntries()) });
    const checkout = join(dotfiles, 'tiny-sdd-clone');
    await mkdir(join(checkout, 'skills', 'tinysdd'), { recursive: true });
    await mkdir(join(checkout, '.git'), { recursive: true });
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'tinysdd', version: CLI_VERSION }));
    await writeFile(join(checkout, 'skills', 'tinysdd', 'SKILL.md'), 'clone skill\n');
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await rm(join(home, '.agents', 'tinysdd'), { recursive: true, force: true });
    await symlink(checkout, join(home, '.agents', 'tinysdd'));

    await assert.rejects(updateSkills({ homeDir: home, archiveBytes: archive(await releaseEntries()) }), (error) => {
      assert.equal(error.code, 'SETUP_CONFLICT');
      assert.match(error.message, /not a TinySDD bundle/u);
      return true;
    });
    assert.equal(await readFile(join(checkout, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    assert.equal(await readFile(join(checkout, 'skills', 'tinysdd', 'SKILL.md'), 'utf8'), 'clone skill\n');
    assert.equal((await lstat(join(home, '.agents', 'tinysdd'))).isSymbolicLink(), true);
  } finally {
    await cleanup(home);
    await cleanup(dotfiles);
  }
});

test('a conflicting install leaves no empty bundle root behind', async () => {
  const home = await temporary('tinysdd-conflict-leftover-home-');
  try {
    await mkdir(join(home, '.agents', 'skills'), { recursive: true });
    await writeFile(join(home, '.agents', 'skills', 'tinysdd'), 'not a link\n');
    await assert.rejects(installBundle({ sourceRoot: repoRoot, homeDir: home }), { code: 'SETUP_CONFLICT' });
    await assert.rejects(lstat(join(home, '.agents', 'tinysdd')), { code: 'ENOENT' });
  } finally {
    await cleanup(home);
  }
});
