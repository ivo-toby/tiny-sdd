import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  lstat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

export class TinySDDError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TinySDDError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function tinyError(code, message, details = undefined) {
  return new TinySDDError(code, message, details);
}

export function isTinySDDError(error) {
  return error instanceof TinySDDError || Boolean(error && typeof error.code === 'string');
}

export function publicError(error) {
  if (isTinySDDError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertPlainObject(value, code, label) {
  if (!isPlainObject(value)) throw tinyError(code, `${label} must be an object`);
  return value;
}

export function assertExactKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw tinyError(code, `${label} contains unknown key: ${key}`);
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestJson(value) {
  return sha256(stableStringify(value));
}

export function normalizeProjectRelative(input, field = 'path', options = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw tinyError('INVALID_PATH', `${field} must be a nonempty project-relative path`);
  }
  if (input.includes('\0')) throw tinyError('INVALID_PATH', `${field} contains a NUL byte`);
  if (isAbsolute(input) || win32.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw tinyError('INVALID_PATH', `${field} must be project-relative`);
  }
  if (/[\\]/.test(input)) {
    // Treat Windows separators as separators too, so a path is validated the
    // same way when a project is moved between platforms.
    input = input.replaceAll('\\', '/');
  }
  if (/[*?\[\]{}]/.test(input)) throw tinyError('INVALID_PATH', `${field} must not contain wildcards`);
  const parts = input.split('/');
  if (parts.some((part) => part === '..')) throw tinyError('INVALID_PATH', `${field} must not traverse a parent`);
  const cleaned = parts.filter((part) => part !== '' && part !== '.');
  if (cleaned.length === 0) throw tinyError('INVALID_PATH', `${field} must name a project path`);
  const normalized = cleaned.join('/');
  if (cleaned.includes('.git')) throw tinyError('INVALID_PATH', `${field} may not enter .git`);
  if (cleaned.includes('.tinysdd')) {
    const allowedPrefix = options.tinysddArtifactPrefix;
    if (
      typeof allowedPrefix !== 'string'
      || !normalized.startsWith(allowedPrefix)
      || normalized.length === allowedPrefix.length
    ) {
      throw tinyError('INVALID_PATH', `${field} may not enter .tinysdd`);
    }
  }
  return normalized;
}

export async function canonicalProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw tinyError('INVALID_PROJECT', 'project root must be a path');
  }
  let root;
  try {
    root = await realpathSafe(projectRoot);
  } catch (error) {
    if (error instanceof TinySDDError) throw error;
    throw tinyError('INVALID_PROJECT', `project root is not readable: ${projectRoot}`);
  }
  const info = await lstat(root);
  if (!info.isDirectory()) throw tinyError('INVALID_PROJECT', 'project root must be a directory');
  return root;
}

export async function realpathSafe(target) {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(target);
  } catch {
    throw tinyError('PATH_NOT_FOUND', `path does not exist: ${target}`);
  }
}

async function lstatIfPresent(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertNoSymlinkPath(target, { allowMissing = true, requireDirectory = false } = {}) {
  const absolute = resolve(target);
  const root = resolve(dirname(absolute), '.');
  // Walk from the filesystem root. This catches symlinked parents even when
  // the final file has not been created yet.
  const pieces = absolute.split('/').filter(Boolean);
  let current = absolute.startsWith('/') ? '/' : root;
  for (const piece of pieces) {
    current = current === '/' ? `/${piece}` : join(current, piece);
    const info = await lstatIfPresent(current);
    if (!info) {
      // Once an existing, checked parent is followed by a missing component,
      // the remainder is necessarily a new path.  This permits an allowed
      // path such as src/new-module/file.mjs before its parent directories
      // have been created, while still rejecting symlinked existing parents.
      if (allowMissing) break;
      throw tinyError('PATH_NOT_FOUND', `path does not exist: ${target}`);
    }
    if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `symlinked paths are not allowed: ${target}`);
    if (current !== absolute && !info.isDirectory()) {
      throw tinyError('INVALID_PATH', `path component is not a directory: ${target}`);
    }
    if (current === absolute && requireDirectory && !info.isDirectory()) {
      throw tinyError('INVALID_PATH', `path must be a directory: ${target}`);
    }
  }
  return absolute;
}

export async function resolveProjectPath(projectRoot, projectRelative, options = {}) {
  const relativePath = normalizeProjectRelative(projectRelative, options.field ?? 'path', options);
  const root = resolve(projectRoot);
  const absolute = resolve(root, ...relativePath.split('/'));
  const escaped = relative(root, absolute);
  if (escaped === '..' || escaped.startsWith(`..${'/'}`) || isAbsolute(escaped)) {
    throw tinyError('INVALID_PATH', `${options.field ?? 'path'} escapes the project root`);
  }
  await assertNoSymlinkPath(absolute, {
    allowMissing: options.allowMissing ?? true,
    requireDirectory: options.requireDirectory ?? false,
  });
  return { relativePath, absolutePath: absolute };
}

export async function readProjectFile(projectRoot, projectRelative, options = {}) {
  const resolved = await resolveProjectPath(projectRoot, projectRelative, {
    ...options,
    allowMissing: false,
  });
  const info = await lstat(resolved.absolutePath);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `${projectRelative} is not a regular file`);
  try {
    return await readFile(resolved.absolutePath, options.encoding ?? 'utf8');
  } catch {
    throw tinyError('FILE_READ_FAILED', `could not read ${projectRelative}`);
  }
}

export async function digestProjectFile(projectRoot, projectRelative, options = {}) {
  const content = await readProjectFile(projectRoot, projectRelative, options);
  return sha256(content);
}

export async function snapshotProjectFiles(projectRoot, paths) {
  const result = [];
  for (const projectRelative of paths) {
    const resolved = await resolveProjectPath(projectRoot, projectRelative, { allowMissing: true });
    const info = await lstatIfPresent(resolved.absolutePath);
    if (!info) {
      result.push({ path: projectRelative, exists: false });
      continue;
    }
    if (!info.isFile()) throw tinyError('INVALID_FILE', `${projectRelative} is not a regular file`);
    const content = await readFile(resolved.absolutePath);
    result.push({ path: projectRelative, exists: true, bytes: content.byteLength, sha256: sha256(content) });
  }
  return result;
}

export async function ensureDirectory(target) {
  await assertNoSymlinkPath(target, { allowMissing: true, requireDirectory: false });
  await mkdir(target, { recursive: true });
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: true });
  return target;
}

export async function assertInternalPath(projectRoot, segments, { allowMissing = true, requireDirectory = false } = {}) {
  const root = resolve(projectRoot);
  const target = resolve(root, ...segments);
  const escaped = relative(root, target);
  if (escaped === '..' || escaped.startsWith(`..${'/'}`) || isAbsolute(escaped)) {
    throw tinyError('INVALID_INTERNAL_PATH', 'internal path escapes the project root');
  }
  return assertNoSymlinkPath(target, { allowMissing, requireDirectory });
}

export async function atomicWriteFile(target, content, { mode = 0o600 } = {}) {
  const absolute = resolve(target);
  await ensureDirectory(dirname(absolute));
  const existing = await lstatIfPresent(absolute);
  if (existing?.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink target: ${target}`);
  const temporary = join(dirname(absolute), `.${absolute.split('/').pop()}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    await rename(temporary, absolute);
  } catch (error) {
    if (error instanceof TinySDDError) throw error;
    throw tinyError('WRITE_FAILED', `could not atomically write ${target}`);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function atomicWriteJson(target, value) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile(target, { code = 'MALFORMED_JSON' } = {}) {
  const info = await lstatIfPresent(target);
  if (!info) return null;
  if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink path: ${target}`);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `expected a regular file: ${target}`);
  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch {
    throw tinyError('FILE_READ_FAILED', `could not read ${target}`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw tinyError(code, `malformed JSON: ${target}`);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function withExclusiveLock(lockPath, callback) {
  const absolute = resolve(lockPath);
  await ensureDirectory(dirname(absolute));
  const existing = await lstatIfPresent(absolute);
  if (existing?.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink lock: ${lockPath}`);
  if (existing && !existing.isDirectory()) throw tinyError('LOCK_AMBIGUOUS', `controller lock path is not a directory`);
  try {
    await mkdir(absolute);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw tinyError('LOCK_FAILED', `could not acquire controller lock`);
    const ownerPath = join(absolute, 'owner.json');
    const owner = await readJsonFile(ownerPath, { code: 'LOCK_AMBIGUOUS' }).catch((readError) => {
      if (readError instanceof TinySDDError && readError.code === 'PATH_NOT_FOUND') return null;
      throw readError;
    });
    const pid = owner?.value?.pid;
    const ownerHost = owner?.value?.hostname;
    if (!Number.isInteger(pid) || pid <= 0 || typeof ownerHost !== 'string' || ownerHost.length === 0) {
      throw tinyError('LOCK_AMBIGUOUS', 'controller lock owner is unavailable', { owner: owner?.value ?? null });
    }
    if (ownerHost !== hostname()) {
      throw tinyError('LOCK_AMBIGUOUS', `controller lock belongs to another host: ${ownerHost}`, { owner: owner.value });
    }
    if (processIsAlive(pid)) throw tinyError('LOCKED', `controller state is locked by process ${pid}`, { owner: owner.value });
    // Do not reclaim a dead-looking lock automatically.  A second contender
    // could otherwise remove a newly acquired lock after observing stale data.
    throw tinyError('LOCK_STALE', `controller lock owner is no longer running (pid ${pid})`, { owner: owner.value });
  }
  const owner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  try {
    await writeFile(join(absolute, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    return await callback(owner);
  } finally {
    await rm(absolute, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
