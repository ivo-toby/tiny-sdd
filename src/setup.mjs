import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tinyError } from './fs-utils.mjs';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const PACKAGE = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

export const CLI_VERSION = PACKAGE.version;
export const PACKAGE_NAME = PACKAGE.name;
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
export const PI_VERSION = '1.0.0';
export const NODE_MINIMUM = Object.freeze({ major: 22, minor: 19, patch: 0 });
export const GIT_REPOSITORY = 'https://github.com/ivo-toby/tiny-sdd';
export const SETUP_DOCS_URL = `${GIT_REPOSITORY}/blob/main/docs/setup.md`;
export const QUICKSTART_DOCS_URL = `${GIT_REPOSITORY}/blob/main/docs/quickstart.md`;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

const REQUIRED_FILES = Object.freeze([
  'package.json',
  'skills/tinysdd/SKILL.md',
  'skills/tinysdd/assets/setup/SKILL.md',
  'skills/tinysdd/references/cli-workflow.md',
  'docs/artifact-format.md',
  'docs/context-compiler.md',
  'docs/quickstart.md',
]);
const INSTALL_ROOT_NAME = 'tinysdd';
const LINK_TARGETS = Object.freeze([
  { name: 'tinysdd', target: ['skills', 'tinysdd'] },
  { name: 'tinysdd-setup', target: ['skills', 'tinysdd', 'assets', 'setup'] },
]);
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function setupError(code, message, details = undefined) {
  return tinyError(code, message, details);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function ensureDirectoryTree(path, label = 'directory') {
  const absolute = resolve(path);
  const pieces = absolute.split('/').filter(Boolean);
  let current = absolute.startsWith('/') ? '/' : '';
  for (const piece of pieces) {
    current = current === '/' ? `/${piece}` : current ? join(current, piece) : piece;
    const info = await lstatIfPresent(current);
    if (info?.isSymbolicLink()) throw setupError('SETUP_CONFLICT', `${label} contains a symbolic link: ${current}`);
    if (info && !info.isDirectory()) throw setupError('SETUP_CONFLICT', `${label} is not a directory: ${current}`);
    if (!info) await mkdir(current);
  }
  return absolute;
}

function parseVersion(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) {
    throw setupError('SETUP_INVALID_VERSION', `setup version must be a complete semantic version: ${version ?? 'missing'}`);
  }
  const [base] = version.split(/[+-]/u);
  return base.split('.').map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function checkNodeVersion(version = process.versions.node) {
  let parsed;
  try {
    parsed = parseVersion(version);
  } catch {
    return {
      supported: false,
      version,
      minimum: '22.19.0',
      reason: `Node version is not a supported semantic version: ${version}`,
    };
  }
  const minimum = [NODE_MINIMUM.major, NODE_MINIMUM.minor, NODE_MINIMUM.patch];
  const supported = parsed[0] > minimum[0]
    || (parsed[0] === minimum[0] && (parsed[1] > minimum[1] || (parsed[1] === minimum[1] && parsed[2] >= minimum[2])));
  return {
    supported,
    version,
    minimum: '22.19.0',
    reason: supported ? null : `TinySDD requires Node >=22.19.0; found ${version}`,
  };
}

async function executableInfo(path) {
  const info = await lstatIfPresent(path);
  if (!info) return null;
  let resolved;
  try {
    resolved = await realpath(path);
    const target = await lstat(resolved);
    if (!target.isFile() || (target.mode & 0o111) === 0) return null;
  } catch {
    return null;
  }
  if (!info.isFile() && !info.isSymbolicLink()) return null;
  return { path, resolved };
}

async function firstExecutable(paths) {
  for (const path of paths) {
    const found = await executableInfo(path);
    if (found) return found;
  }
  return null;
}

function defaultPiExecutable(nodeExecutable) {
  return join(dirname(nodeExecutable), 'pi');
}

async function findPiPackage(resolvedExecutable) {
  let current = dirname(resolvedExecutable);
  for (let count = 0; count < 8; count += 1) {
    try {
      const raw = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      if (raw.name === PI_PACKAGE_NAME) {
        return { root: current, name: raw.name, version: typeof raw.version === 'string' ? raw.version : null };
      }
    } catch {
      // Keep walking. A package directory can have intermediate folders.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export async function inspectPiInstallation({ nodeExecutable = process.execPath, expectedVersion = PI_VERSION } = {}) {
  const executable = defaultPiExecutable(nodeExecutable);
  const found = await executableInfo(executable);
  if (!found) {
    return {
      installed: false,
      supported: false,
      status: 'missing',
      executable,
      expectedVersion,
      version: null,
      packageRoot: null,
      reason: `Pi is not installed beside this Node executable: ${executable}`,
    };
  }
  const packageInfo = await findPiPackage(found.resolved);
  if (!packageInfo) {
    return {
      installed: true,
      supported: false,
      status: 'unqualified',
      executable,
      resolvedExecutable: found.resolved,
      expectedVersion,
      version: null,
      packageRoot: null,
      reason: `Pi executable has no nearby ${PI_PACKAGE_NAME} package identity`,
    };
  }
  const supported = packageInfo.version === expectedVersion;
  return {
    installed: true,
    supported,
    status: supported ? 'ready' : 'unsupported-version',
    executable,
    resolvedExecutable: found.resolved,
    expectedVersion,
    version: packageInfo.version,
    packageRoot: packageInfo.root,
    reason: supported ? null : `TinySDD requires ${PI_PACKAGE_NAME}@${expectedVersion}; found ${packageInfo.version ?? 'unknown version'}`,
  };
}

function parseJsonComments(text) {
  let output = '';
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      } else output += ' ';
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        index += 1;
      } else output += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      output += char;
    } else if (char === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index += 1;
    } else output += char;
  }
  return output;
}

function endpointSummary(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return `${parsed.origin}${parsed.pathname || '/'}`;
  } catch {
    return null;
  }
}

function modelMetadata(providerId, provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const entries = [];
  for (const model of models) {
    if (!model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string' || model.id.length === 0) continue;
    entries.push({
      id: model.id,
      ...(typeof model.api === 'string' ? { api: model.api } : {}),
      ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
      ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
      ...(endpointSummary(model.baseUrl ?? provider.baseUrl) ? { endpoint: endpointSummary(model.baseUrl ?? provider.baseUrl) } : {}),
    });
  }
  return {
    id: providerId,
    ...(typeof provider?.api === 'string' ? { api: provider.api } : {}),
    ...(endpointSummary(provider?.baseUrl) ? { endpoint: endpointSummary(provider.baseUrl) } : {}),
    modelCount: entries.length,
    models: entries,
  };
}

export async function inspectPiModels({ homeDir = homedir(), sourceAgentDir, sourceEnv = process.env } = {}) {
  const agentDir = sourceAgentDir || sourceEnv?.PI_CODING_AGENT_DIR || join(homeDir, '.config', 'pi', 'agent');
  const modelsPath = join(agentDir, 'models.json');
  let raw;
  try {
    raw = await readFile(modelsPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return {
        configured: false,
        usable: false,
        status: 'missing-explicit-config',
        agentDir,
        modelsPath,
        providers: [],
        reason: 'TinySDD needs explicit provider/model entries in Pi models.json; interactive Pi built-ins may still be available.',
      };
    }
    return {
      configured: false,
      usable: false,
      status: 'unreadable',
      agentDir,
      modelsPath,
      providers: [],
      reason: `Pi models.json could not be read: ${modelsPath}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(parseJsonComments(raw));
  } catch {
    return {
      configured: true,
      usable: false,
      status: 'invalid',
      agentDir,
      modelsPath,
      providers: [],
      reason: 'Pi models.json is not valid JSON',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    return {
      configured: true,
      usable: false,
      status: 'no-usable-models',
      agentDir,
      modelsPath,
      providers: [],
      reason: 'Pi models.json has no providers with explicit model entries',
    };
  }
  const providers = Object.entries(parsed.providers)
    .filter(([id, provider]) => typeof id === 'string' && provider && typeof provider === 'object' && !Array.isArray(provider))
    .map(([id, provider]) => modelMetadata(id, provider));
  const usable = providers.some((provider) => provider.modelCount > 0);
  return {
    configured: true,
    usable,
    status: usable ? 'ready' : 'no-usable-models',
    agentDir,
    modelsPath,
    providers,
    reason: usable ? null : 'Pi models.json has no provider/model pair TinySDD can resolve explicitly',
  };
}

export async function inspectSandbox({ platform = process.platform, privileged = typeof process.getuid === 'function' && process.getuid() === 0, executablePaths = {} } = {}) {
  if (platform === 'linux') {
    const bwrap = await firstExecutable(executablePaths.bwrap ? [executablePaths.bwrap] : ['/usr/bin/bwrap', '/bin/bwrap']);
    const prlimit = await firstExecutable(executablePaths.prlimit ? [executablePaths.prlimit] : ['/usr/bin/prlimit']);
    const setpriv = privileged
      ? await firstExecutable(executablePaths.setpriv ? [executablePaths.setpriv] : ['/usr/bin/setpriv', '/bin/setpriv'])
      : null;
    const checksAvailable = Boolean(bwrap && prlimit && (!privileged || setpriv));
    return {
      platform,
      worker: bwrap ? { supported: true, sandbox: 'bubblewrap', executable: bwrap.path } : { supported: false, sandbox: 'bubblewrap', executable: null, reason: 'bubblewrap is not an executable file at /usr/bin/bwrap or /bin/bwrap' },
      checks: checksAvailable
        ? { available: true, runner: 'linux-bubblewrap', bwrap: bwrap.path, prlimit: prlimit.path, ...(setpriv ? { setpriv: setpriv.path } : {}) }
        : { available: false, runner: 'linux-bubblewrap', reason: privileged && !setpriv ? 'root setup requires setpriv for the check runner' : 'the check runner requires bubblewrap and prlimit' },
    };
  }
  if (platform === 'darwin') {
    const sandboxExec = await firstExecutable(executablePaths.sandboxExec ? [executablePaths.sandboxExec] : ['/usr/bin/sandbox-exec']);
    return {
      platform,
      worker: sandboxExec ? { supported: true, sandbox: 'seatbelt', executable: sandboxExec.path } : { supported: false, sandbox: 'seatbelt', executable: null, reason: 'macOS sandbox-exec is not available at /usr/bin/sandbox-exec' },
      checks: { available: false, runner: 'linux-bubblewrap', reason: 'run_checks is unavailable on macOS by design' },
    };
  }
  return {
    platform,
    worker: { supported: false, sandbox: null, executable: null, reason: 'TinySDD requires Linux bubblewrap or macOS Seatbelt' },
    checks: { available: false, runner: null, reason: 'unsupported host platform' },
  };
}

export async function inspectPrerequisites({ nodeVersion = process.versions.node, nodeExecutable = process.execPath, platform = process.platform, homeDir = homedir(), sourceAgentDir, sourceEnv = process.env, sandbox = {} } = {}) {
  const node = checkNodeVersion(nodeVersion);
  const pi = await inspectPiInstallation({ nodeExecutable });
  const models = await inspectPiModels({ homeDir, sourceAgentDir, sourceEnv });
  const host = await inspectSandbox({ platform, ...sandbox });
  const ready = node.supported && pi.supported && host.worker.supported && models.usable;
  return {
    schemaVersion: 1,
    ready,
    node: { ...node, executable: nodeExecutable },
    pi,
    sandbox: host,
    models,
    authentication: { status: 'unknown', reason: 'metadata discovery does not authenticate a provider or run inference' },
  };
}

function archiveUrlForVersion(version, repository = GIT_REPOSITORY) {
  parseVersion(version);
  const base = repository.replace(/\/$/u, '');
  const parsed = new URL(base);
  if (parsed.hostname === 'github.com') {
    return `https://codeload.github.com${parsed.pathname}/tar.gz/refs/tags/v${version}`;
  }
  return `${base}/archive/refs/tags/v${version}.tar.gz`;
}

function assertVersionedArchiveUrl(url, version) {
  const expected = archiveUrlForVersion(version);
  if (url !== expected && !new RegExp(`/tar\\.gz/[0-9a-f]{40}$`, 'u').test(url)) {
    throw setupError('SETUP_ARCHIVE_INVALID', `skills archive must be pinned to release ${version} or a commit: ${url}`);
  }
}

async function responseBytes(response, url, version, { signal } = {}) {
  if (!response || response.ok !== true) {
    const status = response?.status === undefined ? 'unavailable' : response.status;
    throw setupError('SETUP_RELEASE_UNAVAILABLE', `TinySDD release archive is unavailable (${status}) at ${url}. Publish the versioned Git tag v${version} before running setup. See ${SETUP_DOCS_URL}`);
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_ARCHIVE_BYTES) {
    throw setupError('SETUP_ARCHIVE_INVALID', `release archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const readChunk = () => {
      if (!signal) return reader.read();
      if (signal.aborted) throw setupError('SETUP_RELEASE_UNAVAILABLE', `release archive download was aborted at ${url}`);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(setupError('SETUP_RELEASE_UNAVAILABLE', `release archive download was aborted at ${url}`));
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then((value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        }, (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    };
    try {
      while (true) {
        const next = await readChunk();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > MAX_ARCHIVE_BYTES) throw setupError('SETUP_ARCHIVE_INVALID', `release archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
        chunks.push(chunk);
      }
    } catch (error) {
      try { void Promise.resolve(reader.cancel?.(error)).catch(() => {}); } catch {}
      throw error;
    } finally {
      await reader.releaseLock?.();
    }
    if (total === 0) throw setupError('SETUP_ARCHIVE_INVALID', 'release archive is empty');
    return Buffer.concat(chunks, total);
  }
  throw setupError('SETUP_RELEASE_INVALID', `release response did not expose a bounded body stream: ${url}`);
}

export async function downloadReleaseArchive({ version = CLI_VERSION, repository = GIT_REPOSITORY, fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal: callerSignal } = {}) {
  if (typeof fetchImpl !== 'function') throw setupError('SETUP_RELEASE_UNAVAILABLE', `setup needs network access to download the versioned skills archive. See ${SETUP_DOCS_URL}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw setupError('SETUP_INVALID_TIMEOUT', `setup download timeout must be a positive safe integer: ${timeoutMs}`);
  const url = archiveUrlForVersion(version, repository);
  assertVersionedArchiveUrl(url, version);
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`setup archive download timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/gzip, application/octet-stream' }, signal: controller.signal });
    } catch (error) {
      const message = controller.signal.aborted
        ? `release archive download timed out or was aborted after ${timeoutMs} ms`
        : `could not download release ${version}: ${error instanceof Error ? error.message : String(error)}`;
      throw setupError('SETUP_RELEASE_UNAVAILABLE', `${message}. See ${SETUP_DOCS_URL}`);
    }
    const bytes = await responseBytes(response, url, version, { signal: controller.signal });
    return { version, url, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function readTarString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.slice(0, end < 0 ? buffer.length : end).toString('utf8').replace(/\s+$/u, '');
}

function readTarNumber(buffer) {
  const text = readTarString(buffer).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains a non-octal tar field');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains an unsafe tar size');
  return value;
}

function validateTarChecksum(header) {
  const expected = readTarNumber(header.slice(148, 156));
  const actual = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
  if (expected !== actual) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains an invalid tar checksum');
}

function paxAttributes(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(0x20, offset);
    if (end < 0) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains malformed PAX metadata');
    const length = Number.parseInt(data.slice(offset, end).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length < 5 || offset + length > data.length) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains malformed PAX length');
    const record = data.slice(end + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw setupError('SETUP_ARCHIVE_INVALID', 'archive contains malformed PAX record');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    throw setupError('SETUP_ARCHIVE_INVALID', `archive contains an unsafe path: ${value}`);
  }
  if (value.split('/').some((part) => part === '..')) {
    throw setupError('SETUP_ARCHIVE_INVALID', `archive path escapes its root: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw setupError('SETUP_ARCHIVE_INVALID', `archive path escapes its root: ${value}`);
  }
  return normalized.replace(/^\.\//u, '');
}

function parseTarGzip(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) throw setupError('SETUP_ARCHIVE_INVALID', 'archive size is outside the supported range');
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES + 1 });
  } catch {
    throw setupError('SETUP_ARCHIVE_INVALID', 'release is not a valid gzip archive');
  }
  if (tar.length > MAX_EXTRACTED_BYTES) throw setupError('SETUP_ARCHIVE_INVALID', 'expanded archive is too large');
  const entries = [];
  const paths = new Set();
  let offset = 0;
  let extractedBytes = 0;
  let pax = null;
  let longPath = null;
  let seenEntries = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((value) => value === 0)) break;
    seenEntries += 1;
    if (seenEntries > MAX_ARCHIVE_ENTRIES) throw setupError('SETUP_ARCHIVE_INVALID', `archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
    validateTarChecksum(header);
    const size = readTarNumber(header.slice(124, 136));
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) throw setupError('SETUP_ARCHIVE_INVALID', 'archive entry extends beyond the archive');
    const data = tar.subarray(offset, offset + size);
    offset += padded;
    const type = String.fromCharCode(header[156] || 0);
    if (type === 'x' || type === 'g') {
      pax = type === 'x' ? paxAttributes(data) : pax;
      continue;
    }
    if (type === 'L') {
      longPath = readTarString(data);
      continue;
    }
    const base = readTarString(header.slice(0, 100));
    const prefix = readTarString(header.slice(345, 500));
    const path = safeArchivePath(pax?.path ?? longPath ?? (prefix ? `${prefix}/${base}` : base));
    const rootName = path.split('/')[0];
    const payload = path === rootName || path === `${rootName}/` || path === `${rootName}/package.json` || path.startsWith(`${rootName}/skills/`) || path.startsWith(`${rootName}/docs/`);
    pax = null;
    longPath = null;
    // GitHub source archives include native repository links such as .agents
    // and .claude. They are outside the install payload and must not be
    // followed or materialized. Links inside skills/docs remain invalid.
    if (!payload) continue;
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      throw setupError('SETUP_ARCHIVE_INVALID', `archive contains a link or special filesystem entry in the install payload: ${path}`);
    }
    if (type !== '\0' && type !== '0' && type !== '5') throw setupError('SETUP_ARCHIVE_INVALID', `archive contains unsupported entry type: ${type}`);
    const isDirectory = type === '5' || path.endsWith('/');
    if (paths.has(path)) throw setupError('SETUP_ARCHIVE_INVALID', `archive contains a duplicate path: ${path}`);
    paths.add(path);
    if (entries.length >= MAX_ARCHIVE_ENTRIES) throw setupError('SETUP_ARCHIVE_INVALID', `archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
    if (!isDirectory) {
      extractedBytes += data.length;
      if (extractedBytes > MAX_EXTRACTED_BYTES) throw setupError('SETUP_ARCHIVE_INVALID', 'expanded files are too large');
    }
    entries.push({ path, directory: isDirectory, data: isDirectory ? null : Buffer.from(data), mode: readTarNumber(header.slice(100, 108)) & 0o777 });
  }
  if (offset > tar.length || entries.length === 0) throw setupError('SETUP_ARCHIVE_INVALID', 'archive is empty or truncated');
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]));
  if (roots.size !== 1) throw setupError('SETUP_ARCHIVE_INVALID', 'archive must contain one top-level source directory');
  return entries;
}

export async function extractReleaseArchive(bytes, destination) {
  const entries = parseTarGzip(bytes);
  await ensureDirectoryTree(destination, 'archive destination');
  const rootName = [...new Set(entries.map((entry) => entry.path.split('/')[0]))][0];
  const rootPath = join(destination, rootName);
  await ensureDirectoryTree(rootPath, 'archive root');
  for (const entry of entries) {
    const relativePath = entry.path.slice(rootName.length).replace(/^\/+/, '');
    if (!relativePath) continue;
    const target = resolve(rootPath, ...relativePath.split('/'));
    const escaped = relative(rootPath, target);
    if (escaped === '..' || escaped.startsWith(`..${'/'}`) || escaped.startsWith('/')) throw setupError('SETUP_ARCHIVE_INVALID', `archive path escapes destination: ${entry.path}`);
    if (entry.directory) {
      await ensureDirectoryTree(target, 'archive directory');
      continue;
    }
    await ensureDirectoryTree(dirname(target), 'archive parent');
    const existing = await lstatIfPresent(target);
    if (existing) throw setupError('SETUP_ARCHIVE_INVALID', `archive extraction would overwrite a path: ${relativePath}`);
    await writeFile(target, entry.data, { flag: 'wx', mode: entry.mode || 0o644 });
    if (entry.mode) await chmod(target, entry.mode).catch(() => {});
  }
  return join(destination, rootName);
}

async function assertRegularFile(root, relativePath) {
  const target = resolve(root, ...relativePath.split('/'));
  const escaped = relative(root, target);
  if (escaped === '..' || escaped.startsWith(`..${'/'}`) || escaped.startsWith('/')) throw setupError('SETUP_ARCHIVE_INVALID', `required resource escapes bundle: ${relativePath}`);
  const info = await lstatIfPresent(target);
  if (!info || info.isSymbolicLink() || !info.isFile()) throw setupError('SETUP_ARCHIVE_INVALID', `release is missing required resource: ${relativePath}`);
  return target;
}

export async function validateBundle(sourceRoot, { expectedVersion = CLI_VERSION } = {}) {
  const packagePath = await assertRegularFile(sourceRoot, 'package.json');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    throw setupError('SETUP_ARCHIVE_INVALID', 'release package.json is not valid JSON');
  }
  if (metadata.name !== PACKAGE_NAME) throw setupError('SETUP_ARCHIVE_INVALID', `release package name is not ${PACKAGE_NAME}`);
  if (metadata.version !== expectedVersion || compareVersions(metadata.version, expectedVersion) !== 0) {
    throw setupError('SETUP_ARCHIVE_INVALID', `release package version ${metadata.version ?? 'missing'} does not match CLI version ${expectedVersion}`);
  }
  for (const required of REQUIRED_FILES) await assertRegularFile(sourceRoot, required);
  return { name: metadata.name, version: metadata.version, requiredFiles: [...REQUIRED_FILES] };
}

async function collectFiles(root, relativePath = '') {
  const target = relativePath ? join(root, ...relativePath.split('/')) : root;
  const info = await lstatIfPresent(target);
  if (!info || info.isSymbolicLink()) throw setupError('SETUP_ARCHIVE_INVALID', `bundle resource is missing or symlinked: ${relativePath || '.'}`);
  if (info.isFile()) return [relativePath];
  if (!info.isDirectory()) throw setupError('SETUP_ARCHIVE_INVALID', `bundle resource is not a regular file or directory: ${relativePath}`);
  const result = [];
  for (const entry of (await readdir(target)).sort()) {
    const child = relativePath ? `${relativePath}/${entry}` : entry;
    result.push(...await collectFiles(root, child));
  }
  return result;
}

async function checkFilePlan(sourceRoot, bundleRoot, paths) {
  const actions = [];
  for (const path of paths) {
    const source = resolve(sourceRoot, ...path.split('/'));
    const destination = resolve(bundleRoot, ...path.split('/'));
    const escaped = relative(bundleRoot, destination);
    if (escaped === '..' || escaped.startsWith(`..${'/'}`) || escaped.startsWith('/')) throw setupError('SETUP_ARCHIVE_INVALID', `bundle resource escapes install root: ${path}`);
    const parentParts = path.split('/');
    parentParts.pop();
    let parent = bundleRoot;
    for (const part of parentParts) {
      parent = join(parent, part);
      const info = await lstatIfPresent(parent);
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw setupError('SETUP_CONFLICT', `installed resource parent conflicts with existing path: ${parent}`);
    }
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw setupError('SETUP_ARCHIVE_INVALID', `bundle resource is not a regular file: ${path}`);
    const existing = await lstatIfPresent(destination);
    if (!existing) {
      actions.push({ path, source, destination, action: 'write', mode: sourceInfo.mode & 0o777 });
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isFile()) throw setupError('SETUP_CONFLICT', `existing installed resource conflicts with the release: ${path}`);
    const [before, after] = await Promise.all([readFile(destination), readFile(source)]);
    if (!before.equals(after)) throw setupError('SETUP_CONFLICT', `existing installed resource differs; refusing to overwrite: ${destination}`);
    actions.push({ path, source, destination, action: 'preserve', mode: sourceInfo.mode & 0o777 });
  }
  return actions;
}

function globalLayout(homeDir) {
  const agentsRoot = join(homeDir, '.agents');
  const bundleRoot = join(agentsRoot, INSTALL_ROOT_NAME);
  const codexSkills = join(agentsRoot, 'skills');
  const claudeSkills = join(homeDir, '.claude', 'skills');
  return {
    agentsRoot,
    bundleRoot,
    codexSkills,
    claudeSkills,
    links: [
      ...LINK_TARGETS.map((entry) => ({ agent: 'codex', ...entry, path: join(codexSkills, entry.name), target: relative(codexSkills, join(bundleRoot, ...entry.target)) })),
      ...LINK_TARGETS.map((entry) => ({ agent: 'claude', ...entry, path: join(claudeSkills, entry.name), target: relative(claudeSkills, join(bundleRoot, ...entry.target)) })),
    ],
  };
}

async function checkLinkPlan(links) {
  const actions = [];
  for (const link of links) {
    const existing = await lstatIfPresent(link.path);
    if (!existing) {
      actions.push({ ...link, action: 'create' });
      continue;
    }
    if (!existing.isSymbolicLink()) throw setupError('SETUP_CONFLICT', `existing ${link.agent} skill entry is not a link: ${link.path}`);
    const actual = await readlink(link.path);
    if (actual !== link.target) {
      let sameTarget = false;
      try { sameTarget = (await realpath(link.path)) === resolve(dirname(link.path), link.target); } catch {}
      if (!sameTarget) throw setupError('SETUP_CONFLICT', `existing ${link.agent} skill link points elsewhere: ${link.path}`);
    }
    actions.push({ ...link, action: 'preserve' });
  }
  return actions;
}

export async function installBundle({ sourceRoot, homeDir = homedir(), expectedVersion = CLI_VERSION } = {}) {
  const metadata = await validateBundle(sourceRoot, { expectedVersion });
  const layout = globalLayout(homeDir);
  await ensureDirectoryTree(layout.agentsRoot, 'global agents directory');
  const existingBundle = await lstatIfPresent(layout.bundleRoot);
  if (existingBundle?.isSymbolicLink() || (existingBundle && !existingBundle.isDirectory())) throw setupError('SETUP_CONFLICT', `global TinySDD bundle path conflicts: ${layout.bundleRoot}`);
  await ensureDirectoryTree(layout.codexSkills, 'Codex skills directory');
  await ensureDirectoryTree(layout.claudeSkills, 'Claude skills directory');
  const sourcePaths = ['package.json', 'skills', 'docs'];
  const paths = [];
  for (const path of sourcePaths) paths.push(...await collectFiles(sourceRoot, path));
  const fileActions = await checkFilePlan(sourceRoot, layout.bundleRoot, paths);
  const linkActions = await checkLinkPlan(layout.links);
  await ensureDirectoryTree(layout.bundleRoot, 'global TinySDD bundle');
  for (const action of fileActions) {
    if (action.action !== 'write') continue;
    await ensureDirectoryTree(dirname(action.destination), 'installed resource parent');
    await writeFile(action.destination, await readFile(action.source), { flag: 'wx', mode: action.mode || 0o644 });
    if (action.mode) await chmod(action.destination, action.mode).catch(() => {});
  }
  for (const action of linkActions) {
    if (action.action === 'create') await symlink(action.target, action.path, 'dir');
  }
  return {
    schemaVersion: 1,
    version: metadata.version,
    bundleRoot: layout.bundleRoot,
    codexSkills: layout.codexSkills,
    claudeSkills: layout.claudeSkills,
    filesWritten: fileActions.filter((action) => action.action === 'write').map((action) => action.path),
    filesPreserved: fileActions.filter((action) => action.action === 'preserve').map((action) => action.path),
    linksCreated: linkActions.filter((action) => action.action === 'create').map((action) => ({ agent: action.agent, name: action.name, path: action.path, target: action.target })),
    linksPreserved: linkActions.filter((action) => action.action === 'preserve').map((action) => ({ agent: action.agent, name: action.name, path: action.path, target: action.target })),
  };
}

function setupInstructions(checks) {
  const instructions = [];
  if (!checks.node.supported) instructions.push(`Use Node >=22.19.0 and rerun setup: ${SETUP_DOCS_URL}`);
  if (checks.pi.status === 'missing') instructions.push(`Install ${PI_PACKAGE_NAME}@${PI_VERSION} beside this Node executable, then rerun setup: ${SETUP_DOCS_URL}`);
  else if (checks.pi.status === 'unsupported-version' || checks.pi.status === 'unqualified') instructions.push(`Use the supported ${PI_PACKAGE_NAME}@${PI_VERSION} beside this Node executable: ${SETUP_DOCS_URL}`);
  if (!checks.sandbox.worker.supported) instructions.push(`Install or enable the supported ${checks.sandbox.platform === 'linux' ? 'bubblewrap' : checks.sandbox.platform === 'darwin' ? 'macOS Seatbelt' : 'worker sandbox'}; no automatic installation is performed: ${SETUP_DOCS_URL}`);
  if (checks.sandbox.platform === 'linux' && checks.sandbox.checks.available === false) instructions.push(`Linux run_checks is unavailable (${checks.sandbox.checks.reason}); install the missing bubblewrap, prlimit or setpriv executable without automatic setup, then rerun setup: ${SETUP_DOCS_URL}`);
  if (!checks.models.usable) instructions.push(`Add an explicit provider/model entry to ${checks.models.modelsPath}; credentials remain environment references and are not inspected: ${SETUP_DOCS_URL}`);
  if (checks.sandbox.checks.available === false && checks.sandbox.platform === 'darwin') instructions.push(`macOS worker setup is supported; run_checks is Linux-only: ${SETUP_DOCS_URL}`);
  if (instructions.length === 0) instructions.push(`Run an authorized worker smoke when you are ready; setup metadata does not prove authentication or inference: ${QUICKSTART_DOCS_URL}`);
  return instructions;
}

export async function runSetup({ version = CLI_VERSION, homeDir = homedir(), nodeVersion = process.versions.node, nodeExecutable = process.execPath, platform = process.platform, sourceAgentDir, sourceEnv = process.env, sandbox = {}, archiveBytes, fetchImpl = globalThis.fetch } = {}) {
  if (version !== CLI_VERSION) throw setupError('SETUP_VERSION_MISMATCH', `this CLI supports setup archive version ${CLI_VERSION}; requested ${version}`);
  const checks = await inspectPrerequisites({ nodeVersion, nodeExecutable, platform, homeDir, sourceAgentDir, sourceEnv, sandbox });
  const archive = archiveBytes === undefined ? await downloadReleaseArchive({ version, fetchImpl }) : { version, url: null, bytes: Buffer.from(archiveBytes), sha256: createHash('sha256').update(archiveBytes).digest('hex') };
  if (archive.bytes.length === 0 || archive.bytes.length > MAX_ARCHIVE_BYTES) throw setupError('SETUP_ARCHIVE_INVALID', 'release archive size is outside the supported range');
  const extraction = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-setup-'));
  try {
    const sourceRoot = await extractReleaseArchive(archive.bytes, extraction);
    const installation = await installBundle({ sourceRoot, homeDir, expectedVersion: version });
    return {
      schemaVersion: 1,
      version,
      ready: checks.ready,
      checks,
      archive: { ...(archive.url ? { url: archive.url } : {}), sha256: archive.sha256 },
      installation,
      warnings: [
        ...(checks.ready ? [] : ['setup installed the skills, but prerequisites are not ready for a TinySDD worker']),
        ...(checks.sandbox.checks.available ? [] : [`${checks.sandbox.platform === 'darwin' ? 'macOS' : 'Linux'} run_checks is unavailable; worker readiness does not prove check-runner readiness`]),
      ],
      nextSteps: setupInstructions(checks),
    };
  } finally {
    await rm(extraction, { recursive: true, force: true }).catch(() => {});
  }
}

export const setupLayoutForHome = globalLayout;
export const releaseArchiveUrl = archiveUrlForVersion;
