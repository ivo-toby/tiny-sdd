import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CLI_VERSION,
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

test('sandbox inspection reports macOS inference support with Linux-only check limitation', async () => {
  const home = await temporary('tinysdd-sandbox-');
  try {
    const bwrap = join(home, 'bwrap');
    const prlimit = join(home, 'prlimit');
    await writeFile(bwrap, '');
    await writeFile(prlimit, '');
    await chmod(bwrap, 0o755);
    await chmod(prlimit, 0o755);
    const linux = await inspectSandbox({ platform: 'linux', privileged: false, executablePaths: { bwrap, prlimit } });
    assert.equal(linux.worker.supported, true);
    assert.equal(linux.checks.available, true);
    const missingRunnerTool = await inspectSandbox({ platform: 'linux', privileged: false, executablePaths: { bwrap, prlimit: join(home, 'missing-prlimit') } });
    assert.equal(missingRunnerTool.worker.supported, true);
    assert.equal(missingRunnerTool.checks.available, false);
    assert.match(missingRunnerTool.checks.reason, /prlimit/u);
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
    for (const path of ['package.json', 'skills/tinysdd/SKILL.md', 'skills/tinysdd/assets/setup/SKILL.md', 'skills/tinysdd/references/cli-workflow.md', 'docs/artifact-format.md', 'docs/context-compiler.md', 'docs/quickstart.md']) {
      entries.push([path, await readFile(join(repoRoot, path))]);
    }
    const result = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: pi.pi } }, archiveBytes: archive(entries) });
    assert.equal(result.version, CLI_VERSION);
    assert.equal(result.checks.pi.status, 'ready');
    assert.equal(result.checks.models.status, 'ready');
    assert.equal(result.checks.sandbox.worker.supported, true);
    assert.equal(result.checks.authentication.status, 'unknown');
    assert.match(result.nextSteps.join('\n'), /Linux-only|authorized worker smoke|metadata/u);
    const linuxResult = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'linux', sandbox: { privileged: false, executablePaths: { bwrap: pi.pi, prlimit: join(home, 'missing-prlimit') } }, archiveBytes: archive(entries) });
    assert.equal(linuxResult.ready, true);
    assert.equal(linuxResult.checks.sandbox.checks.available, false);
    assert.match(linuxResult.nextSteps.join('\n'), /Linux run_checks is unavailable/u);
    assert.match(linuxResult.warnings.join('\n'), /check-runner readiness/u);
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
    assert.match(error.message, /versioned Git tag v0\.1\.0|docs\/setup\.md/u);
    return true;
  });
  assert.equal(requested, 'https://codeload.github.com/ivo-toby/tiny-sdd/tar.gz/refs/tags/v0.1.0');
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
    for (const path of ['package.json', 'skills/tinysdd/SKILL.md', 'skills/tinysdd/assets/setup/SKILL.md', 'skills/tinysdd/references/cli-workflow.md', 'docs/artifact-format.md', 'docs/context-compiler.md', 'docs/quickstart.md']) {
      entries.push([path, await readFile(join(repoRoot, path))]);
    }
    const before = await readFile(join(cwd, '.tinysdd', 'config.json'));
    process.chdir(cwd);
    const result = await runSetup({ homeDir: home, nodeExecutable: pi.node, nodeVersion: '22.19.0', sourceAgentDir: agent, sourceEnv: {}, platform: 'darwin', sandbox: { executablePaths: { sandboxExec: pi.pi } }, archiveBytes: archive(entries) });
    assert.equal(result.installation.bundleRoot, join(home, '.agents', 'tinysdd'));
    assert.deepEqual(await readFile(join(cwd, '.tinysdd', 'config.json')), before);
  } finally {
    process.chdir(previousCwd);
    await cleanup(cwd);
    await cleanup(home);
    await cleanup(pi.root);
  }
});
