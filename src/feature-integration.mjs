import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  chmod,
  lstat,
  stat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';

import { parseChecksManifest } from './checks-manifest.mjs';
import {
  assertExactKeys,
  assertInternalPath,
  assertNoSymlinkPath,
  assertPlainObject,
  atomicWriteFile,
  canonicalProjectRoot,
  containedSymlinkTarget,
  digestJson,
  ensureDirectory,
  gitProjectFileList,
  normalizeProjectRelative,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import { DOCKER_DAEMON_SOCKET_DEFAULT, checkRunnerAvailable, runCheck } from './check-runner.mjs';

export const FEATURE_INTEGRATION_SCHEMA_VERSION = 1;
export const FEATURE_INTEGRATION_DEFAULT_TIMEOUT_MS = 120_000;
export const FEATURE_INTEGRATION_MAX_TIMEOUT_MS = 600_000;
export const FEATURE_INTEGRATION_MAX_MANIFEST_BYTES = 512 * 1024;
export const FEATURE_INTEGRATION_MAX_TREE_FILES = 20_000;
// Dependency mounts use the check channel's limit (#195): an ordinary
// npm-workspaces node_modules has more than 30,000 entries.
export const FEATURE_INTEGRATION_MAX_DEPENDENCY_ENTRIES = 250_000;
export const FEATURE_INTEGRATION_MAX_FEATURES = 64;
export const FEATURE_INTEGRATION_MAX_TREE_BYTES = 512 * 1024 * 1024;
export const FEATURE_INTEGRATION_MAX_OUTPUT_BYTES = 1024 * 1024;
export const FEATURE_INTEGRATION_MAX_DECLARATIONS = 256;
export const FEATURE_INTEGRATION_MAX_PATH_BYTES = 4096;
export const FEATURE_INTEGRATION_MAX_PROOF_BYTES = 8 * 1024 * 1024;
export const FEATURE_INTEGRATION_TEST_ENV = 'TINYSDD_FEATURE_INTEGRATION_TEST';

const CONFIG_KEYS = ['schemaVersion', 'manifest', 'checkId', 'argv', 'command', 'timeoutMs', 'dependencyMounts', 'testPaths', 'entrypoints', 'docker', 'features'];
const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const SOURCE_SELECTIONS = ['git-ls-files', 'walk'];

function invalid(message, details = undefined) {
  throw tinyError('CONFIG_INVALID', message, details);
}

function path(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a project-relative path`);
  if (Buffer.byteLength(value) > FEATURE_INTEGRATION_MAX_PATH_BYTES) invalid(`${label} exceeds ${FEATURE_INTEGRATION_MAX_PATH_BYTES} bytes`);
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { field: label });
  }
}

function uniquePaths(value, label) {
  if (!Array.isArray(value) || value.length > FEATURE_INTEGRATION_MAX_DECLARATIONS) invalid(`${label} must contain at most ${FEATURE_INTEGRATION_MAX_DECLARATIONS} paths`);
  const paths = value.map((item, index) => path(item, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) invalid(`${label} contains duplicate paths`);
  return paths;
}

function command(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    invalid(`${label} must contain between 1 and 64 argv items`);
  }
  const argv = value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\0')) invalid(`${label}[${index}] must be a nonempty string without NUL`);
    if (Buffer.byteLength(item) > 4096) invalid(`${label}[${index}] exceeds 4096 bytes`);
    return item;
  });
  if (argv[0] !== 'node') {
    try {
      argv[0] = normalizeProjectRelative(argv[0], `${label}[0]`);
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error), { field: `${label}[0]` });
    }
  }
  return argv;
}

function socketPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/u.test(value) || Buffer.byteLength(value) > 1024) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

// Opt-in Docker access for this feature check. The check can then start
// containers, which is host-level access: only declare it for trusted tests.
function dockerConfig(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object with a socket path`);
  for (const key of Object.keys(value)) {
    if (key !== 'socket' && key !== 'daemonSocket') invalid(`${label} contains an unknown key: ${key}`);
  }
  if (value.socket === undefined) invalid(`${label}.socket is required`);
  return {
    socket: socketPath(value.socket, `${label}.socket`),
    daemonSocket: value.daemonSocket === undefined ? DOCKER_DAEMON_SOCKET_DEFAULT : socketPath(value.daemonSocket, `${label}.daemonSocket`),
  };
}

function checkId(value, label) {
  if (typeof value !== 'string' || !CHECK_ID_PATTERN.test(value)) invalid(`${label} must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
  return value;
}

function timeout(value, label) {
  if (value === undefined) return FEATURE_INTEGRATION_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1000 || value > FEATURE_INTEGRATION_MAX_TIMEOUT_MS) {
    invalid(`${label} must be an integer from 1000 to ${FEATURE_INTEGRATION_MAX_TIMEOUT_MS}`);
  }
  return value;
}

async function readBoundedFile(path, { maxBytes = FEATURE_INTEGRATION_MAX_MANIFEST_BYTES, label = path } = {}) {
  await assertNoSymlinkPath(path, { allowMissing: false, requireDirectory: false });
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile()) throw tinyError('FEATURE_INTEGRATION_CONFIG', `${label} must be a regular file`, { path });
    if (opened.size > maxBytes) throw tinyError('FEATURE_INTEGRATION_CONFIG', `${label} exceeds ${maxBytes} bytes`, { path, bytes: opened.size, limit: maxBytes });
    const chunks = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
    const current = await handle.stat();
    if (bytes > maxBytes || opened.dev !== current.dev || opened.ino !== current.ino || opened.size !== current.size) {
      throw tinyError('FEATURE_INTEGRATION_CONFIG', `${label} changed while it was read`, { path });
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') throw tinyError('SYMLINK_PATH', `${label} may not be a symlink`, { path });
    if (error?.code === 'ENOENT') throw tinyError('FEATURE_INTEGRATION_CONFIG', `${label} is missing`, { path });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Validate the optional host-owned feature integration command. The command is
 * retained as argv and is later passed to runCheck; it is never shell text.
 */
export function validateFeatureIntegrationConfig(value, label = 'config.featureIntegration', { allowFeatures = true } = {}) {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  try {
    assertExactKeys(value, allowFeatures ? CONFIG_KEYS : CONFIG_KEYS.filter((key) => key !== 'features'), 'CONFIG_INVALID', label);
  } catch (error) {
    if (error?.code === 'CONFIG_INVALID') throw error;
    invalid(error instanceof Error ? error.message : `${label} contains an unknown key`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== FEATURE_INTEGRATION_SCHEMA_VERSION) {
    invalid(`${label}.schemaVersion must be ${FEATURE_INTEGRATION_SCHEMA_VERSION}`);
  }
  const features = value.features === undefined ? undefined : featureConfigs(value.features, `${label}.features`);
  const manifest = value.manifest === undefined ? undefined : path(value.manifest, `${label}.manifest`);
  const suppliedArgv = value.argv === undefined ? undefined : command(value.argv, `${label}.argv`);
  const suppliedCommand = value.command === undefined ? undefined : command(value.command, `${label}.command`);
  if (suppliedArgv !== undefined && suppliedCommand !== undefined) invalid(`${label} must use argv or command, not both`);
  const argv = suppliedArgv ?? suppliedCommand;
  if (manifest === undefined && argv === undefined) {
    if (features === undefined) invalid(`${label} requires manifest or argv`);
    const stray = ['checkId', 'timeoutMs', 'dependencyMounts', 'testPaths', 'entrypoints', 'docker'].filter((key) => value[key] !== undefined);
    if (stray.length > 0) invalid(`${label}.${stray[0]} requires a default manifest or argv; put it under ${label}.features`);
    return { schemaVersion: FEATURE_INTEGRATION_SCHEMA_VERSION, features };
  }
  if (manifest !== undefined && argv !== undefined) invalid(`${label} cannot combine manifest and argv`);
  if (manifest !== undefined && value.timeoutMs !== undefined && !(value.schemaVersion === FEATURE_INTEGRATION_SCHEMA_VERSION && value.timeoutMs === FEATURE_INTEGRATION_DEFAULT_TIMEOUT_MS)) invalid(`${label}.timeoutMs belongs in the checks manifest when manifest is used`);
  if (manifest !== undefined && value.dependencyMounts !== undefined && value.dependencyMounts.length > 0) invalid(`${label}.dependencyMounts belongs in the checks manifest when manifest is used`);
  const checkId = checkIdValue(value.checkId ?? 'feature-integration', `${label}.checkId`);
  const dependencyMounts = value.dependencyMounts === undefined ? [] : uniquePaths(value.dependencyMounts, `${label}.dependencyMounts`);
  for (const [index, mount] of dependencyMounts.entries()) {
    for (const other of dependencyMounts.slice(index + 1)) {
      if (mount === other || mount.startsWith(`${other}/`) || other.startsWith(`${mount}/`)) {
        invalid(`${label}.dependencyMounts must not contain nested paths`);
      }
    }
  }
  const testPaths = value.testPaths === undefined ? [] : uniquePaths(value.testPaths, `${label}.testPaths`);
  const entrypoints = value.entrypoints === undefined ? [] : uniquePaths(value.entrypoints, `${label}.entrypoints`);
  const docker = value.docker === undefined ? undefined : dockerConfig(value.docker, `${label}.docker`);
  const normalized = {
    schemaVersion: FEATURE_INTEGRATION_SCHEMA_VERSION,
    ...(manifest === undefined ? {} : { manifest }),
    checkId,
    ...(argv === undefined ? {} : { argv }),
    timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
    dependencyMounts,
    testPaths,
    entrypoints,
    ...(docker === undefined ? {} : { docker }),
    ...(features === undefined ? {} : { features }),
  };
  if (argv !== undefined) {
    try {
      parseChecksManifest(JSON.stringify({
        schemaVersion: 1,
        dependencyMounts,
        checks: [{ id: checkId, argv, timeoutMs: normalized.timeoutMs }],
      }));
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
  }
  return normalized;
}

function checkIdValue(value, label) {
  return checkId(value, label);
}

function featureConfigs(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object keyed by feature`);
  const names = Object.keys(value).sort();
  if (names.length === 0 || names.length > FEATURE_INTEGRATION_MAX_FEATURES) invalid(`${label} must name between 1 and ${FEATURE_INTEGRATION_MAX_FEATURES} features`);
  const features = {};
  for (const name of names) {
    if (!FEATURE_PATTERN.test(name)) invalid(`${label} key must be a feature label: ${name}`);
    features[name] = validateFeatureIntegrationConfig(value[name], `${label}.${name}`, { allowFeatures: false });
  }
  return features;
}

/**
 * The integration configuration that applies to one feature: its own entry
 * under `features`, else the project-wide command, else undefined.
 */
export function featureIntegrationConfigFor(config, feature) {
  if (config === undefined || config === null) return undefined;
  if (config.features && Object.hasOwn(config.features, feature)) return config.features[feature];
  if (config.argv === undefined && config.manifest === undefined) return undefined;
  const { features: _features, ...fallback } = config;
  return fallback;
}

/** Build the checks-manifest shape used by runCheck for an inline argv. */
export function inlineFeatureIntegrationManifest(config) {
  const normalized = validateFeatureIntegrationConfig(config, 'config.featureIntegration', { allowFeatures: false });
  if (!normalized.argv) return null;
  return {
    schemaVersion: 1,
    dependencyMounts: [...normalized.dependencyMounts],
    checks: [{ id: normalized.checkId, argv: [...normalized.argv], timeoutMs: normalized.timeoutMs }],
  };
}

/**
 * Resolve either an inline command or a project-relative checks manifest.
 * Manifest bytes are returned so proof can bind the exact declaration.
 */
export async function resolveFeatureIntegrationCommand(projectRoot, config, { read = readBoundedFile } = {}) {
  const normalized = validateFeatureIntegrationConfig(config, 'config.featureIntegration', { allowFeatures: false });
  if (normalized.argv) {
    const manifestText = JSON.stringify(inlineFeatureIntegrationManifest(normalized));
    const parsed = parseChecksManifest(JSON.stringify(inlineFeatureIntegrationManifest(normalized)));
    return {
      config: normalized,
      manifest: parsed,
      manifestPath: null,
      manifestText,
      check: parsed.checks[0],
    };
  }
  const resolved = await resolveProjectPath(projectRoot, normalized.manifest, { field: 'config.featureIntegration.manifest', allowMissing: false });
  const absolute = resolved.absolutePath;
  let text;
  try {
    text = await read(absolute, { label: `feature integration manifest ${normalized.manifest}` });
  } catch (error) {
    if (error?.code === 'SYMLINK_PATH') throw error;
    throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration manifest cannot be read: ${normalized.manifest}`, { path: normalized.manifest, cause: error?.code });
  }
  const manifest = parseChecksManifest(text);
  if (normalized.dependencyMounts.length > 0 && stableStringify(normalized.dependencyMounts) !== stableStringify(manifest.dependencyMounts)) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration dependency mounts do not match the checks manifest', {
      configured: normalized.dependencyMounts,
      manifest: manifest.dependencyMounts,
      path: normalized.manifest,
    });
  }
  const check = manifest.checks.find((item) => item.id === normalized.checkId);
  if (!check) throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration check is not declared: ${normalized.checkId}`, { checkId: normalized.checkId, path: normalized.manifest });
  return { config: normalized, manifest, manifestPath: normalized.manifest, manifestText: text, check };
}

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const SECRET_DIRECTORY = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;

function excludedProjectPath(path, excluded, secretNames = true) {
  const parts = path.split('/');
  if (secretNames && parts.some((part, index) => SECRET_NAME.test(part) || (index < parts.length - 1 && SECRET_DIRECTORY.test(part)))) return true;
  return excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function readAndCopyFile(source, target, info, state, label, { mountReadable = false } = {}) {
  let input;
  let output;
  try {
    input = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK);
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw tinyError('FEATURE_INTEGRATION_INPUT_CHANGED', `integration input changed while opening ${label}`, { path: label });
    }
    if (state.bytes > FEATURE_INTEGRATION_MAX_TREE_BYTES || opened.size > FEATURE_INTEGRATION_MAX_TREE_BYTES - state.bytes) {
      throw tinyError('FEATURE_INTEGRATION_INPUT_LIMIT', `integration input exceeds ${FEATURE_INTEGRATION_MAX_TREE_BYTES} bytes`, { limit: FEATURE_INTEGRATION_MAX_TREE_BYTES });
    }
    const targetMode = (opened.mode & 0o7777) | 0o400 | (mountReadable ? 0o0444 : 0);
    output = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, targetMode);
    await chmod(target, targetMode);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (position > opened.size || bytesRead > opened.size - position) {
        throw tinyError('FEATURE_INTEGRATION_INPUT_CHANGED', `integration input grew while reading ${label}`, { path: label });
      }
      if (state.bytes > FEATURE_INTEGRATION_MAX_TREE_BYTES
        || position > FEATURE_INTEGRATION_MAX_TREE_BYTES - state.bytes
        || bytesRead > FEATURE_INTEGRATION_MAX_TREE_BYTES - state.bytes - position) {
        throw tinyError('FEATURE_INTEGRATION_INPUT_LIMIT', `integration input exceeds ${FEATURE_INTEGRATION_MAX_TREE_BYTES} bytes`, { limit: FEATURE_INTEGRATION_MAX_TREE_BYTES });
      }
      const chunk = buffer.subarray(0, bytesRead);
      await output.write(chunk);
      hash.update(chunk);
      position += bytesRead;
    }
    const current = await input.stat();
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || position !== opened.size) {
      throw tinyError('FEATURE_INTEGRATION_INPUT_CHANGED', `integration input changed while reading ${label}`, { path: label });
    }
    state.bytes += position;
    return { kind: 'file', mode: targetMode, bytes: position, sha256: hash.digest('hex') };
  } catch (error) {
    if (error?.code === 'ELOOP') throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration input contains a symlink: ${label}`, { path: label });
    throw error;
  } finally {
    await input?.close().catch(() => {});
    await output?.close().catch(() => {});
  }
}

/**
 * Copy a bounded tree into a disposable retained directory. Regular files and
 * directories are copied; a relative symlink that stays inside the project is
 * recreated as the same link. `paths` selects project files (from Git) instead
 * of walking the whole source. `symlinkBase` is the tree's project-relative
 * location, so a dependency mount's links are checked against the project.
 * The returned identity describes the bytes actually mounted into runCheck.
 */
export async function copyIntegrationTree(source, destination, {
  excluded = [],
  identityAlgorithm = 'sha256-candidate-tree-v1',
  mountReadable = false,
  paths = null,
  symlinkBase = '',
  maxEntries = FEATURE_INTEGRATION_MAX_TREE_FILES,
  secretNames = true,
} = {}) {
  await assertNoSymlinkPath(source, { allowMissing: false, requireDirectory: true });
  const sourceRealpath = await realpath(source);
  if (sourceRealpath !== source) throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration source must be canonical: ${source}`, { path: source });
  await assertNoSymlinkPath(destination, { allowMissing: true, requireDirectory: false });
  const destinationMode = mountReadable ? 0o755 : 0o700;
  await mkdir(destination, { recursive: true, mode: destinationMode });
  if (mountReadable) await chmod(destination, destinationMode);
  const state = { bytes: 0, files: 0, entries: 0 };
  const entries = [];
  const directories = new Set();
  const limit = () => {
    if (++state.entries > maxEntries) {
      throw tinyError('FEATURE_INTEGRATION_INPUT_LIMIT', `integration input exceeds ${maxEntries} entries`, { limit: maxEntries });
    }
  };
  async function makeDirectory(from, to, path, info) {
    if (await realpath(from) !== from) throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration input directory is not canonical: ${path}`, { path });
    const targetMode = (info.mode & 0o7777) | 0o700 | (mountReadable ? 0o0555 : 0);
    await mkdir(to, { recursive: false, mode: targetMode });
    await chmod(to, targetMode);
    entries.push({ path, kind: 'directory', mode: targetMode });
    directories.add(path);
  }
  async function copyEntry(from, to, path, info, nested) {
    if (info.isSymbolicLink()) {
      const target = await readlink(from);
      const linkPath = symlinkBase ? `${symlinkBase}/${path}` : path;
      if (containedSymlinkTarget(linkPath, target) === null) {
        throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration input symlink leaves the project or is not a plain relative path: ${path} -> ${target}`, { path, target });
      }
      await symlink(target, to);
      entries.push({ path, kind: 'symlink', target });
    } else if (info.isDirectory()) {
      await makeDirectory(from, to, path, info);
      await visit(from, to, path, nested);
    } else if (info.isFile()) {
      const copied = await readAndCopyFile(from, to, info, state, path, { mountReadable });
      entries.push({ path, ...copied });
    } else {
      throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration input contains a special file: ${path}`, { path });
    }
  }
  // nested: a directory Git listed as one entry (a submodule or nested
  // repository); its own .git is repository state, not project source.
  async function visit(current, target, prefix = '', nested = false) {
    const names = [];
    for await (const entry of await opendir(current)) {
      limit();
      names.push(entry.name);
    }
    names.sort();
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (excludedProjectPath(path, excluded, secretNames) || (nested && name === '.git')) continue;
      state.files += 1;
      await copyEntry(join(current, name), join(target, name), path, await lstat(join(current, name)), nested);
    }
  }
  async function copyListed(listedPaths) {
    for (const listed of listedPaths) {
      // An untracked nested repository is listed once, as "dir/".
      const path = listed.endsWith('/') ? listed.slice(0, -1) : listed;
      if (path.length === 0 || excludedProjectPath(path, excluded, secretNames)) continue;
      let normalized;
      try {
        normalized = normalizeProjectRelative(path, 'git-listed path');
      } catch {
        normalized = null;
      }
      if (normalized !== path) throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `git listed a path that is not project-relative: ${path}`, { path });
      const parts = path.split('/');
      let parentMissing = false;
      for (let index = 1; index < parts.length; index += 1) {
        const directory = parts.slice(0, index).join('/');
        if (directories.has(directory)) continue;
        const from = join(source, ...parts.slice(0, index));
        let info;
        try {
          info = await lstat(from);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          parentMissing = true;
          break;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) throw tinyError('FEATURE_INTEGRATION_UNSAFE_INPUT', `integration input path passes through a non-directory: ${directory}`, { path: directory });
        limit();
        await makeDirectory(from, join(destination, ...parts.slice(0, index)), directory, info);
      }
      if (parentMissing || directories.has(path)) continue;
      const from = join(source, ...parts);
      let info;
      try {
        info = await lstat(from);
      } catch (error) {
        // Tracked but deleted in the working tree (not yet staged).
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      limit();
      state.files += 1;
      await copyEntry(from, join(destination, ...parts), path, info, true);
    }
  }
  if (paths === null) await visit(source, destination);
  else await copyListed(paths);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    identity: {
      algorithm: identityAlgorithm,
      entries,
      bytes: state.bytes,
      sha256: digestJson(entries),
    },
    files: state.files,
    bytes: state.bytes,
  };
}

const FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION = 1;
const FEATURE_INTEGRATION_ARTIFACT_PREFIX = '.tinysdd/runs/feature-integration/';
const CONFIG_FILES = ['.tinysdd/config.json', '.tinysdd/config.local.json'];

function integrationFailure(message, details = undefined) {
  throw tinyError('FEATURE_INTEGRATION_FAILED', message, details);
}

function integrationUnavailable(message, details = undefined) {
  throw tinyError('CHECK_RUNNER_UNAVAILABLE', message, details);
}

function normalizedFeaturePath(value, label) {
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', error instanceof Error ? error.message : String(error), { field: label });
  }
}

function normalizeFeatureMembership(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration membership must contain 1 to 256 tasks');
  }
  const membership = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || typeof item.retired !== 'boolean') {
      throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration membership[${index}] is invalid`);
    }
    return { id: item.id, retired: item.retired };
  });
  for (let index = 1; index < membership.length; index += 1) {
    if (membership[index - 1].id.localeCompare(membership[index].id) >= 0) {
      throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration membership must be sorted and unique');
    }
  }
  return membership;
}

function normalizeAcceptanceDigests(value, membership) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration active acceptance digests must be an object');
  }
  const active = membership.filter((item) => !item.retired).map((item) => item.id);
  const keys = Object.keys(value).sort();
  if (keys.length !== active.length || keys.some((key, index) => key !== active[index] || !/^[a-f0-9]{64}$/u.test(value[key]))) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration active acceptance digests do not match membership');
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function assertMountPaths(mounts) {
  if (!Array.isArray(mounts) || mounts.length > 8) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration dependency mounts must contain at most 8 paths');
  }
  for (const [index, mount] of mounts.entries()) {
    normalizedFeaturePath(mount, `feature integration dependency mount[${index}]`);
    for (const other of mounts.slice(index + 1)) {
      if (mount === other || mount.startsWith(`${other}/`) || other.startsWith(`${mount}/`)) {
        throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration dependency mount paths must not nest');
      }
    }
  }
  return [...mounts];
}

function underPath(path, boundary) {
  return path === boundary || path.startsWith(`${boundary}/`);
}

async function assertDeclaredFiles(root, paths, label, protectedPaths, dependencyMounts) {
  if (paths.length === 0) throw tinyError('FEATURE_INTEGRATION_PROOF_REQUIRED', `${label} must declare at least one path`);
  const normalizedProtected = new Set((protectedPaths ?? []).map((item, index) => normalizedFeaturePath(item, `protectedPaths[${index}]`)));
  for (const [index, projectPath] of paths.entries()) {
    if (dependencyMounts.some((mount) => underPath(projectPath, mount))) {
      throw tinyError('FEATURE_INTEGRATION_PROOF_REQUIRED', `${label}[${index}] is inside a dependency mount: ${projectPath}`, { path: projectPath });
    }
    const resolved = await resolveProjectPath(root, projectPath, { field: `${label}[${index}]`, allowMissing: false });
    const info = await lstat(resolved.absolutePath);
    if (!info.isFile()) throw tinyError('FEATURE_INTEGRATION_PROOF_REQUIRED', `${label}[${index}] must be a regular file: ${projectPath}`, { path: projectPath });
    if (label === 'testPaths' && !normalizedProtected.has(projectPath)) {
      throw tinyError('FEATURE_INTEGRATION_PROOF_REQUIRED', `integration test is not a protected feature test: ${projectPath}`, { path: projectPath });
    }
  }
}

async function configFilesIdentity(root) {
  const files = [];
  for (const projectPath of CONFIG_FILES) {
    const absolute = join(root, ...projectPath.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        files.push({ path: projectPath, exists: false });
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink config path: ${projectPath}`);
    if (!info.isFile()) throw tinyError('FEATURE_INTEGRATION_CONFIG', `${projectPath} must be a regular file`);
    const content = await readBoundedFile(absolute, { label: projectPath });
    files.push({ path: projectPath, exists: true, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  return { files, sha256: digestJson(files) };
}

function commandIdentity(resolved) {
  const docker = resolved.config.docker;
  return {
    schemaVersion: FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION,
    checkId: resolved.check.id,
    argv: [...resolved.check.argv],
    timeoutMs: resolved.check.timeoutMs,
    dependencyMounts: [...resolved.manifest.dependencyMounts],
    manifestSha256: sha256(resolved.manifestText),
    ...(docker === undefined ? {} : { docker: { ...docker } }),
    // Docker is added only when declared, so earlier command digests hold.
    sha256: digestJson({
      check: resolved.check,
      dependencyMounts: resolved.manifest.dependencyMounts,
      manifestText: resolved.manifestText,
      testPaths: resolved.config.testPaths,
      entrypoints: resolved.config.entrypoints,
      ...(docker === undefined ? {} : { docker }),
    }),
  };
}

// node_modules is gitignored, so it reaches the check only as a dependency
// mount. An argv path into it without one fails inside the check with a
// confusing "Cannot find module"; say what to declare instead.
async function assertArgvInputs(candidatePath, check, dependencyMounts) {
  for (const [index, item] of check.argv.entries()) {
    const first = item.split('/')[0];
    if (first !== 'node_modules' || !item.includes('/')) continue;
    if (dependencyMounts.some((mount) => item === mount || item.startsWith(`${mount}/`))) continue;
    try {
      await lstat(join(candidatePath, ...item.split('/')));
    } catch {
      throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration argv[${index}] names ${item}, but node_modules is not a dependency mount; declare "dependencyMounts": ["node_modules"]`, { argv: index, path: item });
    }
  }
}

async function assertDockerSocket(docker) {
  const refuse = (message, cause) => tinyError('FEATURE_INTEGRATION_DOCKER_SOCKET', message, { socket: docker.socket, ...(cause ? { cause } : {}) });
  let info;
  try {
    info = await stat(docker.socket);
  } catch (error) {
    throw refuse(`declared docker socket does not exist: ${docker.socket} (is Docker running?)`, error?.code);
  }
  if (!info.isSocket()) throw refuse(`declared docker socket is not a unix socket: ${docker.socket}`);
}

function identityDigest(identity) {
  return identity?.sha256 ?? digestJson(identity);
}

function pathForArtifact(id, name) {
  return `${FEATURE_INTEGRATION_ARTIFACT_PREFIX}${id}/${name}`;
}

async function makeTemporaryDirectory(prefix) {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

async function createArtifact(root, id) {
  if (!/^[0-9a-f-]{20,64}$/u.test(id)) throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature integration artifact id is invalid');
  const artifact = await assertInternalPath(root, ['.tinysdd', 'runs', 'feature-integration', id], { allowMissing: true });
  await ensureDirectory(artifact);
  await chmod(artifact, 0o755);
  return artifact;
}

// selection 'auto' lists project files with Git (tracked plus untracked and
// not ignored, as the worker copy does) and walks the tree when Git cannot
// list it. A recorded selection is replayed exactly, so freshness compares
// like with like; proofs written before the Git selection have none and walk.
async function copySourceSnapshot(root, destination, dependencyMounts, selection = 'auto') {
  let paths = null;
  if (selection !== 'walk') {
    const listing = await gitProjectFileList(root);
    if (listing.paths !== null && listing.paths.length > 0) paths = listing.paths;
    else if (selection === 'git-ls-files') {
      throw tinyError('FEATURE_INTEGRATION_STALE', `project files can no longer be listed with git: ${listing.reason ?? 'no files listed'}`);
    }
  }
  const copied = await copyIntegrationTree(root, destination, {
    excluded: ['.git', '.tinysdd', ...dependencyMounts],
    identityAlgorithm: 'sha256-candidate-tree-v1',
    paths,
  });
  return { ...copied, selection: paths === null ? 'walk' : 'git-ls-files' };
}

function mountName(index) {
  return `mount-${String(index).padStart(2, '0')}`;
}

// A mount is retained at mount-NN/<target> (mount-00/node_modules), not at
// mount-NN itself: Node resolves a package's real path and looks for a
// node_modules directory above it, so the retained tree must keep its name
// (#209). Proofs written before carry no layout and hold the tree at mount-NN.
const MOUNT_LAYOUT = 'target';

function retainedMountRoot(base, index, target, layout = MOUNT_LAYOUT) {
  return layout === MOUNT_LAYOUT ? join(base, mountName(index), ...target.split('/')) : join(base, mountName(index));
}

async function copyDependencySnapshots(root, destination, dependencyMounts) {
  const dependencies = [];
  for (const [index, target] of dependencyMounts.entries()) {
    const resolved = await resolveProjectPath(root, target, { field: `dependencyMounts[${index}]`, allowMissing: false, requireDirectory: true });
    const retainedPath = retainedMountRoot(destination, index, target);
    const copied = await copyIntegrationTree(resolved.absolutePath, retainedPath, {
      excluded: ['.git', '.tinysdd'],
      identityAlgorithm: 'sha256-dependency-tree-v1',
      mountReadable: true,
      symlinkBase: target,
      maxEntries: FEATURE_INTEGRATION_MAX_DEPENDENCY_ENTRIES,
      // Mounted as-is, like run_checks: package files such as
      // dockerode/lib/secret.js are code, not project secrets.
      secretNames: false,
    });
    dependencies.push({ target, sourcePath: target, retainedPath, identity: copied.identity });
  }
  return dependencies;
}

async function copyDependencySnapshotsFromRetained(sourceRoot, dependencyMounts, destination) {
  const dependencies = [];
  for (const [index, target] of dependencyMounts.entries()) {
    const source = retainedMountRoot(sourceRoot, index, target);
    const retainedPath = retainedMountRoot(destination, index, target);
    const copied = await copyIntegrationTree(source, retainedPath, {
      excluded: [],
      identityAlgorithm: 'sha256-dependency-tree-v1',
      mountReadable: true,
      symlinkBase: target,
      maxEntries: FEATURE_INTEGRATION_MAX_DEPENDENCY_ENTRIES,
      // Mounted as-is, like run_checks: package files such as
      // dockerode/lib/secret.js are code, not project secrets.
      secretNames: false,
    });
    dependencies.push({ target, retainedPath, identity: copied.identity });
  }
  return dependencies;
}

function dependencyDigest(dependencies) {
  return digestJson(dependencies.map((item) => ({ target: item.target, identity: item.identity })));
}

function boundedResult(raw, check) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrationFailure('integration runner returned an invalid result');
  if (raw.id !== undefined && raw.id !== check.id) integrationFailure('integration runner returned a different check id');
  if (raw.argv !== undefined && stableStringify(raw.argv) !== stableStringify(check.argv)) integrationFailure('integration runner returned a different argv');
  const exitCode = raw.exitCode === null || raw.exitCode === undefined ? null : raw.exitCode;
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) integrationFailure('integration runner returned an invalid exit code');
  const signal = raw.signal === undefined ? null : raw.signal;
  if (signal !== null && typeof signal !== 'string') integrationFailure('integration runner returned an invalid signal');
  const timedOut = raw.timedOut === true;
  const durationMs = raw.durationMs === undefined ? null : raw.durationMs;
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) integrationFailure('integration runner returned an invalid duration');
  const output = raw.output === undefined ? {
    totalBytes: 0,
    storedBytes: 0,
    truncated: false,
    tailTruncated: false,
    text: '',
    tail: '',
  } : raw.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) integrationFailure('integration runner returned invalid output');
  for (const field of ['text', 'tail']) {
    if (output[field] !== undefined && (typeof output[field] !== 'string' || Buffer.byteLength(output[field]) > FEATURE_INTEGRATION_MAX_OUTPUT_BYTES)) {
      integrationFailure(`integration runner ${field} exceeds the bounded output limit`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(output)) > FEATURE_INTEGRATION_MAX_OUTPUT_BYTES) integrationFailure('integration runner output exceeds the bounded output limit');
  const result = {
    id: check.id,
    argv: [...check.argv],
    exitCode,
    signal,
    timedOut,
    durationMs,
    output,
    ...(raw.limits === undefined ? {} : { limits: raw.limits }),
    ...(raw.sandbox === undefined ? {} : { sandbox: raw.sandbox }),
  };
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(result));
  } catch {
    integrationFailure('integration runner returned a non-serializable result');
  }
  if (bytes > FEATURE_INTEGRATION_MAX_PROOF_BYTES) integrationFailure('integration runner result exceeds the retained proof limit');
  return result;
}

function passedResult(result) {
  return result.exitCode === 0 && result.signal === null && result.timedOut === false;
}

async function writeRetainedJson(path, value, maxBytes = FEATURE_INTEGRATION_MAX_PROOF_BYTES) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw tinyError('FEATURE_INTEGRATION_INPUT_LIMIT', `retained integration record exceeds ${maxBytes} bytes`, { limit: maxBytes });
  await atomicWriteFile(path, text);
  return { path, sha256: sha256(text) };
}

async function retainSnapshot(root, artifact, resolved, dependencies, id, feature, membership, activeAcceptanceDigests, protectedPaths, result) {
  const candidatePath = join(artifact, 'candidate');
  const dependencyPath = join(artifact, 'dependencies');
  const candidate = await copySourceSnapshot(root, candidatePath, dependencies);
  const retainedDependencies = await copyDependencySnapshots(root, dependencyPath, dependencies);
  const configIdentity = await configFilesIdentity(root);
  const command = commandIdentity(resolved);
  const resultPath = join(artifact, 'result.json');
  const resultFile = await writeRetainedJson(resultPath, result);
  const proof = {
    schemaVersion: FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION,
    status: 'passed',
    feature,
    membership: structuredClone(membership),
    activeAcceptanceDigests: structuredClone(activeAcceptanceDigests),
    protectedPaths: [...protectedPaths].sort(),
    command,
    config: configIdentity,
    candidate: { path: pathForArtifact(id, 'candidate'), selection: candidate.selection, identity: candidate.identity, sha256: identityDigest(candidate.identity) },
    dependencies: retainedDependencies.map((item, index) => ({
      target: item.target,
      path: pathForArtifact(id, `dependencies/${mountName(index)}`),
      layout: MOUNT_LAYOUT,
      identity: item.identity,
      sha256: identityDigest(item.identity),
    })),
    result: { path: pathForArtifact(id, 'result.json'), sha256: resultFile.sha256 },
  };
  const proofPath = join(artifact, 'proof.json');
  const proofFile = await writeRetainedJson(proofPath, proof);
  const reference = {
    schemaVersion: FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION,
    status: 'passed',
    proofPath: pathForArtifact(id, 'proof.json'),
    proofSha256: proofFile.sha256,
    resultPath: proof.result.path,
    resultSha256: proof.result.sha256,
    commandSha256: command.sha256,
    configSha256: configIdentity.sha256,
    candidateSha256: proof.candidate.sha256,
    dependenciesSha256: dependencyDigest(retainedDependencies),
  };
  return { reference, proof, artifact, candidate, dependencies: retainedDependencies };
}

async function verifySourceSnapshot(root, destination, dependencyMounts, expected, selection) {
  const candidate = await copySourceSnapshot(root, destination, dependencyMounts, selection);
  if (identityDigest(candidate.identity) !== expected) throw tinyError('FEATURE_INTEGRATION_STALE', 'project changed while integration check was running');
  return candidate;
}

async function verifyDependencySnapshots(root, destination, dependencyMounts, expected) {
  const actual = await copyDependencySnapshots(root, destination, dependencyMounts);
  if (dependencyDigest(actual) !== expected) throw tinyError('FEATURE_INTEGRATION_STALE', 'dependency mount changed while integration check was running');
  return actual;
}

function assertInjectedRunner(runner) {
  if (runner !== runCheck && process.env[FEATURE_INTEGRATION_TEST_ENV] !== '1') {
    throw tinyError('FEATURE_INTEGRATION_RUNNER_INVALID', 'normal feature integration configuration cannot inject a runner');
  }
}

/**
 * Execute the configured integration check against retained bytes. The only
 * runner used by normal controller calls is the host-owned check runner.
 */
export async function runFeatureIntegration(projectRoot, {
  feature,
  membership,
  activeAcceptanceDigests,
  config,
  protectedPaths = [],
  runner = runCheck,
  nodeRoot,
  tempRoot,
  signal,
  integrationId = randomUUID(),
} = {}) {
  assertInjectedRunner(runner);
  const root = await canonicalProjectRoot(projectRoot);
  const normalized = validateFeatureIntegrationConfig(config, 'config.featureIntegration', { allowFeatures: false });
  const normalizedMembership = normalizeFeatureMembership(membership);
  const normalizedDigests = normalizeAcceptanceDigests(activeAcceptanceDigests, normalizedMembership);
  const protectedSet = new Set(protectedPaths.map((item, index) => normalizedFeaturePath(item, `protectedPaths[${index}]`)));
  const resolved = await resolveFeatureIntegrationCommand(root, normalized);
  const dependencyMounts = assertMountPaths(resolved.manifest.dependencyMounts);
  await assertDeclaredFiles(root, normalized.testPaths, 'testPaths', [...protectedSet], dependencyMounts);
  await assertDeclaredFiles(root, normalized.entrypoints, 'entrypoints', [...protectedSet], dependencyMounts);
  if (normalized.docker !== undefined) await assertDockerSocket(normalized.docker);
  const available = checkRunnerAvailable();
  if (runner === runCheck && !available.available) integrationUnavailable(available.reason);
  const artifact = await createArtifact(root, integrationId);
  const comparison = join(artifact, 'comparison');
  const candidatePath = join(artifact, 'candidate');
  const dependencyPath = join(artifact, 'dependencies');
  let retained;
  try {
    retained = await retainSnapshot(root, artifact, resolved, dependencyMounts, integrationId, feature, normalizedMembership, normalizedDigests, [...protectedSet], {
      id: resolved.check.id,
      argv: resolved.check.argv,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: null,
      output: { totalBytes: 0, storedBytes: 0, truncated: false, tailTruncated: false, text: '', tail: '' },
    });
    await assertArgvInputs(candidatePath, resolved.check, dependencyMounts);
    const raw = await runner({
      candidateDir: candidatePath,
      check: resolved.check,
      dependencyMounts: retained.dependencies.map((item) => ({ source: item.retainedPath, target: item.target })),
      ...(normalized.docker === undefined ? {} : { docker: { ...normalized.docker } }),
      ...(nodeRoot === undefined ? {} : { nodeRoot }),
      ...(tempRoot === undefined ? {} : { tempRoot }),
      ...(signal === undefined ? {} : { signal }),
    });
    const result = boundedResult(raw, resolved.check);
    if (!passedResult(result)) {
      const resultFile = await writeRetainedJson(join(artifact, 'result.json'), result);
      if (result.timedOut) throw tinyError('FEATURE_INTEGRATION_TIMEOUT', `feature integration check timed out: ${resolved.check.id}`, { resultPath: pathForArtifact(integrationId, 'result.json'), resultSha256: resultFile.sha256 });
      integrationFailure(`feature integration check failed: ${resolved.check.id}`, { resultPath: pathForArtifact(integrationId, 'result.json'), resultSha256: resultFile.sha256, exitCode: result.exitCode, signal: result.signal });
    }
    // Re-read the command declaration and every mounted source after execution.
    const postResolved = await resolveFeatureIntegrationCommand(root, normalized);
    if (commandIdentity(postResolved).sha256 !== retained.proof.command.sha256) throw tinyError('FEATURE_INTEGRATION_STALE', 'feature integration command changed while the check was running');
    const postConfig = await configFilesIdentity(root);
    if (postConfig.sha256 !== retained.proof.config.sha256) throw tinyError('FEATURE_INTEGRATION_STALE', 'feature integration configuration changed while the check was running');
    await verifySourceSnapshot(root, join(comparison, 'source-candidate'), dependencyMounts, retained.proof.candidate.sha256, retained.proof.candidate.selection);
    await verifyDependencySnapshots(root, join(comparison, 'source-dependencies'), dependencyMounts, dependencyDigest(retained.proof.dependencies));
    const retainedCandidate = await copyIntegrationTree(candidatePath, join(comparison, 'retained-candidate'), {
      excluded: [],
      identityAlgorithm: 'sha256-candidate-tree-v1',
    });
    if (identityDigest(retainedCandidate.identity) !== retained.proof.candidate.sha256) throw tinyError('FEATURE_INTEGRATION_STALE', 'retained candidate changed while the integration check was running');
    const retainedDependencies = await copyDependencySnapshotsFromRetained(join(artifact, 'dependencies'), dependencyMounts, join(comparison, 'retained-dependencies'));
    if (dependencyDigest(retainedDependencies) !== dependencyDigest(retained.proof.dependencies)) throw tinyError('FEATURE_INTEGRATION_STALE', 'retained dependencies changed while the integration check was running');
    // The retained proof was written with a placeholder result; replace it only
    // after all source and configuration freshness checks have succeeded.
    const resultFile = await writeRetainedJson(join(artifact, 'result.json'), result);
    retained.proof.result = { path: pathForArtifact(integrationId, 'result.json'), sha256: resultFile.sha256 };
    retained.proof.status = 'passed';
    if (normalized.docker !== undefined) {
      retained.proof.dockerAccess = {
        granted: true,
        socket: normalized.docker.socket,
        daemonSocket: normalized.docker.daemonSocket,
        ...(result.sandbox?.docker === undefined ? {} : { sandbox: { network: result.sandbox.network, ...result.sandbox.docker } }),
      };
    }
    const proofFile = await writeRetainedJson(join(artifact, 'proof.json'), retained.proof);
    const reference = {
      schemaVersion: FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION,
      status: 'passed',
      proofPath: pathForArtifact(integrationId, 'proof.json'),
      proofSha256: proofFile.sha256,
      resultPath: retained.proof.result.path,
      resultSha256: retained.proof.result.sha256,
      commandSha256: retained.proof.command.sha256,
      configSha256: retained.proof.config.sha256,
      candidateSha256: retained.proof.candidate.sha256,
      dependenciesSha256: dependencyDigest(retained.proof.dependencies),
    };
    return { reference, proof: retained.proof, result, artifactPath: pathForArtifact(integrationId, '') };
  } catch (error) {
    if (error?.code === 'CHECK_RUNNER_UNAVAILABLE' || error?.code === 'FEATURE_INTEGRATION_TIMEOUT' || error?.code === 'FEATURE_INTEGRATION_FAILED' || error?.code === 'FEATURE_INTEGRATION_STALE') throw error;
    throw error;
  } finally {
    await rm(comparison, { recursive: true, force: true }).catch(() => {});
  }
}

async function readBoundedJson(root, projectPath, maxBytes) {
  const absolute = await assertInternalPath(root, projectPath.split('/'), { allowMissing: false, requireDirectory: false });
  const text = await readBoundedFile(absolute, { maxBytes, label: projectPath });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', `${projectPath} is not valid JSON`);
  }
  return { absolute, text, value };
}

function validateReference(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof reference is invalid');
  const keys = ['schemaVersion', 'status', 'proofPath', 'proofSha256', 'resultPath', 'resultSha256', 'commandSha256', 'configSha256', 'candidateSha256', 'dependenciesSha256'];
  assertExactKeys(reference, keys, 'FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof reference');
  if (reference.schemaVersion !== FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION || reference.status !== 'passed') throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof reference has an unsupported schema or status');
  for (const field of ['proofSha256', 'resultSha256', 'commandSha256', 'configSha256', 'candidateSha256', 'dependenciesSha256']) {
    if (typeof reference[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(reference[field])) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', `${field} must be a digest`);
  }
  for (const field of ['proofPath', 'resultPath']) {
    if (typeof reference[field] !== 'string' || !reference[field].startsWith(FEATURE_INTEGRATION_ARTIFACT_PREFIX) || reference[field].includes('..')) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', `${field} must point inside the feature integration artifact`);
  }
  return reference;
}

function validateProof(value, feature, membership, activeAcceptanceDigests) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof must be an object');
  if (value.schemaVersion !== FEATURE_INTEGRATION_PROOF_SCHEMA_VERSION || value.status !== 'passed' || value.feature !== feature) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof has an unsupported schema, status or feature');
  if (stableStringify(value.membership) !== stableStringify(membership) || stableStringify(value.activeAcceptanceDigests) !== stableStringify(activeAcceptanceDigests)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof membership is stale');
  if (!value.command || !value.config || !value.candidate || !Array.isArray(value.dependencies) || value.dependencies.length > 8 || !value.result || !Array.isArray(value.protectedPaths)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof is incomplete');
  if (!value.candidate.path.startsWith(FEATURE_INTEGRATION_ARTIFACT_PREFIX) || !value.candidate.path.endsWith('/candidate')) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof candidate path is invalid');
  if (typeof value.candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.candidate.sha256)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof candidate identity is invalid');
  if (value.candidate.selection !== undefined && !SOURCE_SELECTIONS.includes(value.candidate.selection)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof candidate selection is invalid');
  if (typeof value.config.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.config.sha256)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof configuration identity is invalid');
  if (typeof value.command.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.command.sha256)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof command identity is invalid');
  if (typeof value.result.path !== 'string' || !value.result.path.startsWith(FEATURE_INTEGRATION_ARTIFACT_PREFIX) || !value.result.path.endsWith('/result.json') || typeof value.result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.result.sha256)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof result is invalid');
  const candidatePrefix = value.candidate.path.slice(0, value.candidate.path.lastIndexOf('/'));
  const resultPrefix = value.result.path.slice(0, value.result.path.lastIndexOf('/'));
  if (candidatePrefix !== resultPrefix || value.protectedPaths.some((item) => typeof item !== 'string')) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof artifact paths are inconsistent');
  const targets = [];
  for (const [index, dependency] of value.dependencies.entries()) {
    if (!dependency || typeof dependency !== 'object' || typeof dependency.target !== 'string' || typeof dependency.path !== 'string' || !dependency.path.startsWith(`${candidatePrefix}/dependencies/mount-`) || !/\/mount-0[0-7]$/u.test(dependency.path) || typeof dependency.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(dependency.sha256)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', `integration proof dependency ${index} is invalid`);
    const target = normalizedFeaturePath(dependency.target, `integration proof dependency ${index}.target`);
    if (dependency.layout !== undefined && dependency.layout !== MOUNT_LAYOUT) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', `integration proof dependency ${index} has an unknown layout`);
    if (targets.includes(target)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof dependency targets are duplicated');
    targets.push(target);
  }
  if (value.dependencies.some((dependency, index) => dependency.path !== `${candidatePrefix}/dependencies/mount-${String(index).padStart(2, '0')}`)) throw tinyError('FEATURE_INTEGRATION_PROOF_INVALID', 'integration proof dependencies are not in manifest order');
  return value;
}

/** Check a retained proof and compare it with the current project/configuration. */
export async function featureIntegrationFreshness(projectRoot, {
  feature,
  eventIntegration,
  membership,
  activeAcceptanceDigests,
  config,
  protectedPaths = [],
} = {}) {
  if (!eventIntegration) return { required: true, fresh: false, reasons: [config ? 'integration proof missing' : 'integration configuration missing'], status: 'missing' };
  if (!config) return { required: true, fresh: false, reasons: ['integration configuration missing'], status: 'stale' };
  const reasons = [];
  try {
    const root = await canonicalProjectRoot(projectRoot);
    const reference = validateReference(eventIntegration);
    const normalizedMembership = normalizeFeatureMembership(membership);
    const normalizedDigests = normalizeAcceptanceDigests(activeAcceptanceDigests, normalizedMembership);
    const normalizedProtected = protectedPaths.map((item, index) => normalizedFeaturePath(item, `protectedPaths[${index}]`));
    const resolved = await resolveFeatureIntegrationCommand(root, config);
    const dependencyMounts = assertMountPaths(resolved.manifest.dependencyMounts);
    await assertDeclaredFiles(root, resolved.config.testPaths, 'testPaths', normalizedProtected, dependencyMounts);
    await assertDeclaredFiles(root, resolved.config.entrypoints, 'entrypoints', normalizedProtected, dependencyMounts);
    const command = commandIdentity(resolved);
    const configIdentity = await configFilesIdentity(root);
    if (command.sha256 !== reference.commandSha256) reasons.push('integration command changed');
    if (configIdentity.sha256 !== reference.configSha256) reasons.push('integration configuration changed');
    const proof = await readBoundedJson(root, reference.proofPath, FEATURE_INTEGRATION_MAX_PROOF_BYTES);
    if (sha256(proof.text) !== reference.proofSha256) reasons.push('retained integration proof changed');
    const value = validateProof(proof.value, feature, normalizedMembership, normalizedDigests);
    const artifactPrefix = reference.proofPath.slice(0, reference.proofPath.lastIndexOf('/'));
    if (value.candidate.path !== `${artifactPrefix}/candidate` || value.result.path !== reference.resultPath || value.dependencies.some((item, index) => item.path !== `${artifactPrefix}/dependencies/mount-${String(index).padStart(2, '0')}`)) reasons.push('retained integration artifact paths changed');
    if (value.command.sha256 !== reference.commandSha256 || value.candidate.sha256 !== reference.candidateSha256 || value.config.sha256 !== reference.configSha256) reasons.push('retained integration identity changed');
    if (value.result.path !== reference.resultPath || value.result.sha256 !== reference.resultSha256) reasons.push('retained integration result reference changed');
    if (stableStringify(value.protectedPaths) !== stableStringify([...new Set(normalizedProtected)].sort())) reasons.push('protected integration test paths changed');
    if (stableStringify(value.dependencies.map((item) => item.target)) !== stableStringify(dependencyMounts)) reasons.push('integration dependency mounts changed');
    const result = await readBoundedJson(root, reference.resultPath, FEATURE_INTEGRATION_MAX_PROOF_BYTES);
    if (sha256(result.text) !== reference.resultSha256 || value.result.sha256 !== reference.resultSha256 || !passedResult(result.value)) reasons.push('retained integration result is not passing');
    const artifactRoot = dirname(proof.absolute);
    const candidateTemporaryRoot = await makeTemporaryDirectory('tinysdd-feature-verify-');
    try {
      const retainedCandidate = await copyIntegrationTree(join(artifactRoot, 'candidate'), join(candidateTemporaryRoot, 'candidate'), { excluded: [], identityAlgorithm: 'sha256-candidate-tree-v1' });
      if (identityDigest(retainedCandidate.identity) !== reference.candidateSha256) reasons.push('retained candidate bytes changed');
    } finally {
      await rm(candidateTemporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
    const retainedDependencies = [];
    for (const [index, dependency] of value.dependencies.entries()) {
      const temporary = await makeTemporaryDirectory('tinysdd-feature-dependency-');
      try {
        const copied = await copyIntegrationTree(retainedMountRoot(join(artifactRoot, 'dependencies'), index, dependency.target, dependency.layout ?? 'legacy'), temporary, { excluded: [], identityAlgorithm: 'sha256-dependency-tree-v1', mountReadable: true, symlinkBase: dependency.target, maxEntries: FEATURE_INTEGRATION_MAX_DEPENDENCY_ENTRIES, secretNames: false });
        retainedDependencies.push({ target: dependency.target, identity: copied.identity });
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
      if (index > 8) break;
    }
    if (dependencyDigest(retainedDependencies) !== reference.dependenciesSha256) reasons.push('retained dependency bytes changed');
    const dependencyTemporaryRoot = await makeTemporaryDirectory('tinysdd-feature-source-dependencies-');
    try {
      const currentDependencies = await copyDependencySnapshots(root, dependencyTemporaryRoot, dependencyMounts);
      if (dependencyDigest(currentDependencies) !== reference.dependenciesSha256) reasons.push('project dependency bytes changed');
    } finally {
      await rm(dependencyTemporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
    const sourceTemporaryRoot = await makeTemporaryDirectory('tinysdd-feature-source-');
    try {
      const current = await copySourceSnapshot(root, join(sourceTemporaryRoot, 'candidate'), dependencyMounts, value.candidate.selection ?? 'walk');
      if (identityDigest(current.identity) !== reference.candidateSha256) reasons.push('project or tested bytes changed');
    } finally {
      await rm(sourceTemporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    reasons.push(error?.message ?? String(error));
  }
  return { required: true, fresh: reasons.length === 0, reasons, status: reasons.length === 0 ? 'fresh' : 'stale' };
}
