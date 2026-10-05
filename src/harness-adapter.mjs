import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { resolveTaskPacket } from './controller.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import { DEFAULT_RUNTIME_SCOPE, classifyFileScopeChange, detectFilesystemAliases, observedPathError, preparationPaths } from './file-scope.mjs';
import { assertNoSymlinkPath, canonicalProjectRoot, normalizeProjectRelative, sha256, stableStringify, tinyError } from './fs-utils.mjs';
import {
  assertCopiedInputs,
  changedFiles,
  copyProjectTree,
  copyRegularTree,
  snapshotTree,
  workerCaptureLimits,
} from './worker.mjs';

export const HARNESS_CAPTURE_SCHEMA_VERSION = 1;
export const HARNESS_KINDS = Object.freeze(['claude-code', 'pi']);

const RUN_ID_PATTERN = /^worker-[0-9A-Za-z-]+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_FILES = workerCaptureLimits.MAX_COPY_FILES;
const MAX_CAPTURE_METADATA_BYTES = 8 * 1024 * 1024;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const UNKNOWN = 'UNKNOWN';

function captureError(code, message, details = undefined) {
  throw tinyError(code, message, details);
}

function isInside(root, target) {
  const escaped = relative(resolve(root), resolve(target));
  return escaped === '' || (escaped !== '..' && !escaped.startsWith(`..${'/'}`) && !escaped.startsWith('/'));
}

function digest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) return null;
  return value;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function safeRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) captureError('HARNESS_INVALID_RUN', 'runId must name a TinySDD worker run');
  return value;
}

function safeHarness(value) {
  if (typeof value !== 'string' || !HARNESS_KINDS.includes(value)) {
    captureError('HARNESS_REQUIRED', `harness must be one of ${HARNESS_KINDS.join(', ')}`);
  }
  return value;
}

function safeModel(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value) > 512) {
    captureError('HARNESS_MODEL_REQUIRED', 'model identity is required; TinySDD never chooses a fallback model');
  }
  return value;
}

function safeBundleRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/')) {
    captureError('HARNESS_BUNDLE_INVALID', `${label} must be a relative POSIX path`);
  }
  try {
    const normalized = normalizeProjectRelative(value, label);
    if (normalized !== value) captureError('HARNESS_BUNDLE_INVALID', `${label} is not normalized`);
    return normalized;
  } catch (error) {
    captureError('HARNESS_BUNDLE_INVALID', error instanceof Error ? error.message : String(error));
  }
}

async function existingCanonicalDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0) captureError('HARNESS_INVALID_PATH', `${label} is required`);
  const absolute = resolve(value);
  await assertNoSymlinkPath(absolute, { allowMissing: false, requireDirectory: true });
  const canonical = await realpath(absolute);
  if (canonical !== absolute) captureError('HARNESS_SYMLINK_PATH', `${label} must be a canonical directory`, { path: absolute });
  return { absolute, canonical, identity: await directoryIdentity(absolute, label) };
}

async function directoryIdentity(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    captureError('HARNESS_CAPTURE_STALE', `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) captureError('HARNESS_INVALID_PATH', `${label} must be a real directory`, { path });
  return { realpath: await realpath(path), dev: info.dev, ino: info.ino };
}

function assertOutside(sourceRoot, target, label) {
  if (isInside(sourceRoot, target)) captureError('HARNESS_PATH_OVERLAP', `${label} must be outside the source project`, { path: target });
}

async function boundedBytes(path, { maxBytes = MAX_BUNDLE_FILE_BYTES, label = path } = {}) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) captureError('HARNESS_BUNDLE_INVALID', `${label} must be a regular file`, { path });
    if (opened.size > maxBytes) captureError('HARNESS_BUNDLE_LIMIT', `${label} exceeds the ${maxBytes}-byte limit`, { path, bytes: opened.size, limit: maxBytes });
    const chunks = [];
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytesRead));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
      if (bytesRead > maxBytes) break;
    }
    const current = await handle.stat();
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || bytesRead > maxBytes) {
      captureError('HARNESS_CAPTURE_STALE', `${label} changed while being read`, { path });
    }
    return Buffer.concat(chunks, bytesRead);
  } catch (error) {
    if (error?.code === 'ELOOP') captureError('HARNESS_SYMLINK_PATH', `${label} may not be a symlink`, { path });
    if (error?.code === 'ENOENT') captureError('HARNESS_BUNDLE_INVALID', `${label} is missing`, { path });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function boundedJson(path, label) {
  const bytes = await boundedBytes(path, { maxBytes: MAX_CAPTURE_METADATA_BYTES, label });
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    captureError('HARNESS_JSON_INVALID', `${label} is not valid JSON`, { path });
  }
}

async function writeExclusive(path, content, { mode = 0o600 } = {}) {
  await assertNoSymlinkPath(dirname(path), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, content, { flag: 'wx', mode });
  } catch (error) {
    if (error?.code === 'EEXIST') captureError('HARNESS_OUTPUT_COLLISION', `capture output already exists: ${path}`, { path });
    throw error;
  }
}

async function writeJsonExclusive(path, value) {
  await writeExclusive(path, jsonBytes(value));
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertIdentity(path, expected, label) {
  const actual = await directoryIdentity(path, label);
  if (actual.realpath !== expected.realpath || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    captureError('HARNESS_CAPTURE_STALE', `${label} identity changed`, { expected, actual, path });
  }
  return actual;
}

async function readBundle(bundleDir) {
  const directory = await existingCanonicalDirectory(bundleDir, 'bundle directory');
  const manifestPath = join(directory.canonical, 'bundle.json');
  const manifestRead = await boundedJson(manifestPath, 'bundle.json');
  const manifest = manifestRead.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1 || manifest.bundleType !== 'tinysdd-slice') {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle.json has an unsupported shape');
  }
  if (stableStringify(manifest.runtimeScope) !== stableStringify(DEFAULT_RUNTIME_SCOPE)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle runtimeScope must use ordinary-create-modify');
  }
  if (!manifest.packet || manifest.packet.path !== 'packet.json') captureError('HARNESS_BUNDLE_INVALID', 'bundle packet reference is missing');
  const references = new Map();
  for (const field of ['files', 'retainedFiles']) {
    if (!Array.isArray(manifest[field]) || manifest[field].length > MAX_BUNDLE_FILES) captureError('HARNESS_BUNDLE_INVALID', `bundle ${field} is not a bounded list`);
    for (const reference of manifest[field]) {
      if (!reference || typeof reference !== 'object') captureError('HARNESS_BUNDLE_INVALID', `bundle ${field} contains an invalid reference`);
      const path = safeBundleRelative(reference.path, `bundle ${field} path`);
      if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > MAX_BUNDLE_FILE_BYTES || !digest(reference.sha256)) {
        captureError('HARNESS_BUNDLE_INVALID', `bundle ${field} reference has invalid identity`, { path });
      }
      const existing = references.get(path);
      if (existing && stableStringify(existing) !== stableStringify({ path, bytes: reference.bytes, sha256: reference.sha256 })) {
        captureError('HARNESS_BUNDLE_INVALID', `bundle reference identity conflicts for ${path}`, { path });
      }
      references.set(path, { path, bytes: reference.bytes, sha256: reference.sha256 });
    }
  }
  if (!references.has('packet.json')) captureError('HARNESS_BUNDLE_INVALID', 'bundle does not retain packet.json');
  const files = new Map();
  let totalBytes = 0;
  for (const reference of references.values()) {
    if (totalBytes > MAX_CAPTURE_METADATA_BYTES * 4 || reference.bytes > MAX_CAPTURE_METADATA_BYTES * 4 - totalBytes) {
      captureError('HARNESS_BUNDLE_LIMIT', `bundle exceeds the ${MAX_CAPTURE_METADATA_BYTES * 4}-byte retained limit`);
    }
    const path = join(directory.canonical, ...reference.path.split('/'));
    await assertNoSymlinkPath(path, { allowMissing: false, requireDirectory: false });
    const bytes = await boundedBytes(path, { maxBytes: MAX_BUNDLE_FILE_BYTES, label: `bundle/${reference.path}` });
    if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
      captureError('HARNESS_BUNDLE_INVALID', `bundle/${reference.path} does not match its manifest identity`, { path: reference.path });
    }
    totalBytes += bytes.byteLength;
    files.set(reference.path, bytes);
  }
  const packetBytes = files.get('packet.json');
  let packet;
  try {
    packet = JSON.parse(packetBytes.toString('utf8'));
  } catch {
    captureError('HARNESS_JSON_INVALID', 'bundle packet.json is not valid JSON');
  }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.schemaVersion !== 1 || typeof packet.taskId !== 'string') {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle packet.json has an unsupported shape');
  }
  if (manifest.taskId !== packet.taskId || manifest.packet.sha256 !== sha256(packetBytes)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle task or packet identity does not match packet.json');
  }
  if (!packet.approval || typeof packet.approval !== 'object' || !digest(packet.approval.approvalDigest)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle packet has no approval digest');
  }
  if (!Array.isArray(packet.allowedPaths) || packet.allowedPaths.length === 0 || stableStringify(packet.runtimeScope) !== stableStringify(DEFAULT_RUNTIME_SCOPE)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle packet lacks the bounded runtime scope or allowed paths');
  }
  return {
    directory,
    manifest,
    manifestBytes: manifestRead.bytes,
    manifestSha256: sha256(manifestRead.bytes),
    files,
    packet,
    packetBytes,
    packetSha256: sha256(packetBytes),
  };
}

function sourceReadOptions(path) {
  const prefix = ['.tinysdd/tasks/', '.tinysdd/reviews/', '.tinysdd/runs/'].find((candidate) => path.startsWith(candidate));
  return prefix ? { tinysddArtifactPrefix: prefix } : {};
}

async function sourceIdentity(projectRoot, projectPath) {
  const normalized = normalizeProjectRelative(projectPath, 'source snapshot path', sourceReadOptions(projectPath));
  const absolute = resolve(projectRoot, ...normalized.split('/'));
  await assertNoSymlinkPath(absolute, { allowMissing: true, requireDirectory: false });
  const info = await lstatIfPresent(absolute);
  if (!info) return { path: normalized, exists: false };
  if (!info.isFile() || info.isSymbolicLink()) captureError('HARNESS_SOURCE_CHANGED', `source snapshot path is not a regular file: ${normalized}`, { path: normalized });
  const bytes = await boundedBytes(absolute, { maxBytes: MAX_BUNDLE_FILE_BYTES, label: `source/${normalized}` });
  return { path: normalized, exists: true, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function verifyCheckoutSnapshot(projectRoot, snapshots, label) {
  if (!Array.isArray(snapshots)) captureError('HARNESS_BUNDLE_INVALID', `${label} is missing`);
  const actual = [];
  for (const expected of snapshots) {
    if (!expected || typeof expected.path !== 'string' || typeof expected.exists !== 'boolean') captureError('HARNESS_BUNDLE_INVALID', `${label} contains an invalid entry`);
    const observed = await sourceIdentity(projectRoot, expected.path);
    if (stableStringify(observed) !== stableStringify(expected)) {
      captureError('HARNESS_SOURCE_CHANGED', `${label} no longer matches the source: ${expected.path}`, { expected, actual: observed });
    }
    actual.push(observed);
  }
  return actual;
}

async function currentPacket(projectRoot, expectedPacket, expectedDigest) {
  let packet;
  try {
    packet = await resolveTaskPacket(projectRoot, expectedPacket.taskId);
  } catch (error) {
    captureError('HARNESS_APPROVAL_STALE', `task ${expectedPacket.taskId} is no longer ready with the captured approval`, { cause: error?.code ?? error?.message });
  }
  const bytes = jsonBytes(packet);
  if (sha256(bytes) !== expectedDigest || stableStringify(packet) !== stableStringify(expectedPacket)) {
    captureError('HARNESS_APPROVAL_STALE', `task ${expectedPacket.taskId} packet or approval changed since capture began`, { taskId: expectedPacket.taskId });
  }
  return packet;
}

function contextResources(manifest) {
  return (manifest.identity?.context?.sourceDigests ?? []).map((resource) => ({ path: resource.path }));
}

async function makeCandidateParent(projectRoot, value) {
  const requested = value === undefined ? await realpath(tmpdir()) : value;
  const parent = await existingCanonicalDirectory(requested, 'candidate parent');
  assertOutside(projectRoot, parent.canonical, 'candidate parent');
  return parent;
}

async function makeRunDirectory(projectRoot, runId) {
  const runs = resolve(projectRoot, '.tinysdd', 'runs');
  await assertNoSymlinkPath(runs, { allowMissing: false, requireDirectory: true });
  const directory = resolve(runs, runId);
  await assertNoSymlinkPath(directory, { allowMissing: true, requireDirectory: false });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') captureError('HARNESS_OUTPUT_COLLISION', `run already exists: ${runId}`, { runId });
    throw error;
  }
  return directory;
}

function newRunId() {
  return `worker-harness-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

async function retainCandidateTree(sourceRoot, destinationRoot) {
  const counters = { files: 0, bytes: 0, entries: 0 };
  async function visit(source, destination) {
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      counters.entries += 1;
      if (counters.entries > workerCaptureLimits.MAX_COPY_FILES) captureError('HARNESS_CANDIDATE_LIMIT', 'candidate exceeds the bounded entry limit');
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), destinationPath);
      } else if (info.isDirectory()) {
        await visit(sourcePath, destinationPath);
      } else if (info.isFile()) {
        if (info.size > workerCaptureLimits.MAX_COPY_BYTES || counters.bytes > workerCaptureLimits.MAX_COPY_BYTES - info.size) {
          captureError('HARNESS_CANDIDATE_LIMIT', 'candidate exceeds the bounded byte limit');
        }
        await copyFile(sourcePath, destinationPath);
        counters.files += 1;
        counters.bytes += info.size;
      } else {
        captureError('HARNESS_CANDIDATE_INVALID', `candidate contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  }
  await visit(sourceRoot, destinationRoot);
  return counters;
}

function completionRecord(value) {
  if (typeof value !== 'boolean') captureError('HARNESS_COMPLETION_REQUIRED', 'finalize requires an explicit completed=true or completed=false declaration');
  return { completed: value, source: 'caller-declared' };
}

async function loadCapture(projectRoot, runId) {
  const artifactDir = resolve(projectRoot, '.tinysdd', 'runs', safeRunId(runId));
  await assertNoSymlinkPath(artifactDir, { allowMissing: false, requireDirectory: true });
  const captureRead = await boundedJson(join(artifactDir, 'capture.json'), 'capture.json');
  const capture = captureRead.value;
  if (!capture || typeof capture !== 'object' || capture.schemaVersion !== HARNESS_CAPTURE_SCHEMA_VERSION || capture.kind !== 'tinysdd-harness-capture' || capture.runId !== runId) {
    captureError('HARNESS_CAPTURE_INVALID', `run ${runId} has an invalid capture record`);
  }
  const result = await lstatIfPresent(join(artifactDir, 'result.json'));
  if (result) captureError('HARNESS_ALREADY_FINALIZED', `run ${runId} already has a final result`, { runId });
  if (!capture.candidate?.path || !capture.bundle?.path || !capture.project?.root) captureError('HARNESS_CAPTURE_INVALID', `run ${runId} lacks immutable path identities`);
  return { artifactDir, capture };
}

async function ensureBundleIdentity(bundlePath, expected, label) {
  const directory = await existingCanonicalDirectory(bundlePath, label);
  if (directory.canonical !== expected.realpath || directory.identity.dev !== expected.dev || directory.identity.ino !== expected.ino) {
    captureError('HARNESS_CAPTURE_STALE', `${label} identity changed`, { expected, actual: directory.identity });
  }
  return directory;
}

async function captureSourceCheck(projectRoot, artifactDir) {
  const sourceCheck = join(artifactDir, 'source-current');
  await mkdir(sourceCheck, { mode: 0o700 });
  const copy = await copyProjectTree(projectRoot, sourceCheck, { useGit: true });
  const snapshot = await snapshotTree(sourceCheck);
  return { sourceCheck, copy, snapshot };
}

async function retainBundle(bundle, artifactDir) {
  const retainedPath = join(artifactDir, 'bundle');
  await mkdir(retainedPath, { mode: 0o700 });
  await writeExclusive(join(retainedPath, 'bundle.json'), bundle.manifestBytes);
  for (const [path, bytes] of bundle.files) await writeExclusive(join(retainedPath, ...path.split('/')), bytes);
  return retainedPath;
}

async function verifyRetainedBundle(retainedPath, bundle) {
  const manifest = await boundedBytes(join(retainedPath, 'bundle.json'), { maxBytes: MAX_CAPTURE_METADATA_BYTES, label: 'retained bundle.json' });
  if (!manifest.equals(bundle.manifestBytes)) captureError('HARNESS_BUNDLE_CHANGED', 'retained bundle.json changed');
  for (const [path, expected] of bundle.files) {
    const actual = await boundedBytes(join(retainedPath, ...path.split('/')), { maxBytes: MAX_BUNDLE_FILE_BYTES, label: `retained bundle/${path}` });
    if (!actual.equals(expected)) captureError('HARNESS_BUNDLE_CHANGED', `retained bundle/${path} changed`);
  }
}

/**
 * Start a host-managed foreign-harness capture from an exported slice bundle.
 * This copies the source into a new external candidate and only writes the
 * run's own evidence under .tinysdd/runs; it does not execute a harness.
 */
export async function beginHarnessCapture({ projectRoot, bundleDir, harness, model, candidateParent = undefined } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const kind = safeHarness(harness);
  const requestedModel = safeModel(model);
  const bundle = await readBundle(bundleDir);
  assertOutside(root, bundle.directory.canonical, 'bundle directory');
  const packet = await currentPacket(root, bundle.packet, bundle.packetSha256);
  await verifyCheckoutSnapshot(root, bundle.manifest.checkoutSnapshot, 'bundle checkoutSnapshot');
  const source = await directoryIdentity(root, 'source project');
  const aliases = await detectFilesystemAliases(root);
  const parent = await makeCandidateParent(root, candidateParent);
  const runId = newRunId();
  const artifactDir = await makeRunDirectory(root, runId);
  const candidatePath = await mkdtemp(join(parent.canonical, `.tinysdd-harness-${runId}-`));
  assertOutside(root, candidatePath, 'candidate');
  if (isInside(bundle.directory.canonical, candidatePath)) captureError('HARNESS_PATH_OVERLAP', 'candidate must not be created inside the exported bundle');
  const candidate = await directoryIdentity(candidatePath, 'candidate');
  let copy;
  try {
    copy = await copyProjectTree(root, candidatePath, { useGit: true });
    await assertCopiedInputs(root, copy, packet.allowedPaths, packet.protectedPaths ?? [], packet.preparation ?? [], { resources: contextResources(bundle.manifest) });
  } catch (error) {
    captureError('HARNESS_COPY_INVALID', error instanceof Error ? error.message : String(error));
  }
  const before = await snapshotTree(candidatePath);
  const beforeArtifact = join(artifactDir, 'workspace-before');
  await copyRegularTree(candidatePath, beforeArtifact);
  const copySummary = {
    mode: copy.mode,
    ...(copy.fallbackReason ? { fallbackReason: copy.fallbackReason } : {}),
    files: copy.files,
    bytes: copy.bytes,
    missingSkipped: copy.missingSkipped,
  };
  const retainedBundlePath = await retainBundle(bundle, artifactDir);
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const beginBundle = {
    path: bundle.directory.canonical,
    realpath: bundle.directory.identity.realpath,
    dev: bundle.directory.identity.dev,
    ino: bundle.directory.identity.ino,
    manifestSha256: bundle.manifestSha256,
    packetSha256: bundle.packetSha256,
    retainedPath: retainedBundlePath,
  };
  await writeExclusive(join(artifactDir, 'packet.json'), bundle.packetBytes);
  await writeJsonExclusive(join(artifactDir, 'before-snapshot.json'), before);
  await writeJsonExclusive(join(artifactDir, 'runtime.json'), {
    schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
    source: 'foreign-harness',
    harness: { id: kind, source: 'caller-declared' },
    model: { id: requestedModel, source: 'caller-declared', observedId: UNKNOWN, observed: false },
    sandbox: { status: UNKNOWN, source: 'unobserved foreign harness' },
    checks: { status: 'unrun', source: 'foreign harness checks are not observed by TinySDD' },
    usage: UNKNOWN,
    session: { id: sessionId, status: 'open', source: 'host capture' },
  });
  await writeJsonExclusive(join(artifactDir, 'capture.json'), {
    schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
    kind: 'tinysdd-harness-capture',
    runId,
    taskId: packet.taskId,
    harness: { id: kind, source: 'caller-declared' },
    model: { id: requestedModel, source: 'caller-declared', observedId: UNKNOWN },
    sessionId,
    startedAt,
    project: { root: source.realpath, ...source },
    candidate: { path: candidatePath, ...candidate },
    bundle: beginBundle,
    filesystemAliases: aliases,
    copy: copySummary,
    packetSha256: bundle.packetSha256,
    beforeSnapshotSha256: sha256(jsonBytes(before)),
  });
  return {
    schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
    runId,
    taskId: packet.taskId,
    harness: kind,
    model: { id: requestedModel, source: 'caller-declared', observedId: UNKNOWN },
    sessionId,
    artifactDir,
    candidatePath,
    packetPath: join(artifactDir, 'packet.json'),
    workspaceBefore: beforeArtifact,
    beforeSnapshotPath: join(artifactDir, 'before-snapshot.json'),
    runtimePath: join(artifactDir, 'runtime.json'),
  };
}

/**
 * Finalize a begin-owned candidate into the normal TinySDD result shape.
 * No checks, model calls, or arbitrary commands are run here.
 */
export async function finalizeHarnessCapture({ projectRoot, runId, completed, callerClaims = undefined } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const completion = completionRecord(completed);
  const loaded = await loadCapture(root, runId);
  const { artifactDir, capture } = loaded;
  const source = await directoryIdentity(root, 'source project');
  if (source.realpath !== capture.project.root || source.dev !== capture.project.dev || source.ino !== capture.project.ino) {
    captureError('HARNESS_SOURCE_CHANGED', 'source project identity changed since capture began', { expected: capture.project, actual: source });
  }
  const candidate = await assertIdentity(capture.candidate.path, capture.candidate, 'candidate');
  await ensureBundleIdentity(capture.bundle.path, capture.bundle, 'bundle directory');
  const bundle = await readBundle(capture.bundle.path);
  if (bundle.manifestSha256 !== capture.bundle.manifestSha256 || bundle.packetSha256 !== capture.bundle.packetSha256) {
    captureError('HARNESS_BUNDLE_CHANGED', 'bundle bytes changed since capture began');
  }
  await verifyRetainedBundle(capture.bundle.retainedPath, bundle);
  const packetBytes = await boundedBytes(join(artifactDir, 'packet.json'), { maxBytes: MAX_BUNDLE_FILE_BYTES, label: 'retained packet.json' });
  if (sha256(packetBytes) !== capture.packetSha256 || !packetBytes.equals(bundle.packetBytes)) captureError('HARNESS_BUNDLE_CHANGED', 'retained approval packet changed');
  const packet = await currentPacket(root, bundle.packet, capture.packetSha256);
  await verifyCheckoutSnapshot(root, bundle.manifest.checkoutSnapshot, 'bundle checkoutSnapshot');
  const beforeRead = await boundedJson(join(artifactDir, 'before-snapshot.json'), 'before-snapshot.json');
  const before = beforeRead.value;
  if (sha256(beforeRead.bytes) !== capture.beforeSnapshotSha256) captureError('HARNESS_CAPTURE_INVALID', 'retained baseline snapshot changed');
  const sourceCurrent = await captureSourceCheck(root, artifactDir);
  if (stableStringify(sourceCurrent.snapshot) !== stableStringify(before)) {
    captureError('HARNESS_SOURCE_CHANGED', 'source project files changed since capture began');
  }
  const aliases = await detectFilesystemAliases(root);
  if (stableStringify(aliases) !== stableStringify(capture.filesystemAliases)) {
    captureError('HARNESS_SOURCE_CHANGED', 'source-derived filesystem alias behavior changed since capture began');
  }
  const after = await snapshotTree(capture.candidate.path);
  const afterArtifact = join(artifactDir, 'workspace-after');
  await retainCandidateTree(capture.candidate.path, afterArtifact);
  const retainedAfter = await snapshotTree(afterArtifact);
  if (stableStringify(after) !== stableStringify(retainedAfter)) captureError('HARNESS_CAPTURE_STALE', 'candidate changed while being retained');
  await writeJsonExclusive(join(artifactDir, 'after-snapshot.json'), after);
  let dependencyMounts = [];
  if (packet.checks?.text !== undefined) {
    try {
      dependencyMounts = parseChecksManifest(packet.checks.text).dependencyMounts;
    } catch (error) {
      captureError('HARNESS_BUNDLE_INVALID', `approved checks manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const changes = changedFiles(before, after).map((change) => ({ ...change, path: change.path.replaceAll('\\', '/') }));
  const violations = changes.map((change) => classifyFileScopeChange(change, {
    protectedPaths: packet.protectedPaths ?? [],
    inputPaths: [packet.brief?.path, packet.context?.path, packet.checks?.path].filter(Boolean),
    preparationPaths: preparationPaths(packet.preparation ?? []),
    dependencyMounts,
    caseInsensitive: aliases.caseInsensitive,
    unicodeInsensitive: aliases.unicodeInsensitive,
    filesystemAliases: aliases,
  })).filter(Boolean);
  const actualPaths = [...new Set(changes.map(({ path }) => path))].sort();
  const extraPaths = actualPaths.filter((path) => !(packet.allowedPaths ?? []).includes(path));
  if (callerClaims !== undefined && (typeof callerClaims !== 'string' || Buffer.byteLength(callerClaims) > 128 * 1024)) {
    captureError('HARNESS_CLAIM_LIMIT', 'callerClaims must be bounded text');
  }
  const model = {
    id: capture.model.id,
    source: 'caller-declared',
    observedId: UNKNOWN,
    observedSource: 'unobserved',
  };
  const result = {
    schemaVersion: 1,
    runId,
    taskId: packet.taskId,
    runtimeScope: { ...DEFAULT_RUNTIME_SCOPE },
    harness: { id: capture.harness.id, source: 'caller-declared' },
    model,
    completion,
    outcome: completion.completed ? 'completed' : 'incomplete',
    runChecks: { declared: Boolean(packet.checks), available: false, status: 'unrun', source: 'foreign harness' },
    taskShape: { allowedFiles: packet.allowedPaths.length },
    fileScope: {
      mode: 'ordinary-create-modify',
      plannedPaths: [...packet.allowedPaths],
      actualPaths,
      extraPaths,
      ordinaryCreateModify: true,
      deletions: false,
    },
    workspaceCopy: capture.copy,
    changedPaths: changes,
    scopeViolations: violations,
    observed: {
      processTermination: { observed: false, status: UNKNOWN, source: 'foreign harness not observed' },
      assistantTermination: { observed: false, status: UNKNOWN, source: 'foreign harness not observed' },
      usage: UNKNOWN,
      usageScope: UNKNOWN,
      cumulativeUsage: UNKNOWN,
      checks: 'unrun',
      sandbox: UNKNOWN,
      rawOutputBytes: UNKNOWN,
    },
    artifactPaths: {
      directory: artifactDir,
      capture: join(artifactDir, 'capture.json'),
      bundle: capture.bundle.retainedPath,
      bundleSource: capture.bundle.path,
      packet: join(artifactDir, 'packet.json'),
      runtime: join(artifactDir, 'runtime.json'),
      beforeSnapshot: join(artifactDir, 'before-snapshot.json'),
      afterSnapshot: join(artifactDir, 'after-snapshot.json'),
      workspaceBefore: join(artifactDir, 'workspace-before'),
      workspaceAfter: afterArtifact,
      candidate: capture.candidate.path,
    },
    patch: { available: false, reason: 'foreign harness capture does not execute git' },
    modelClaims: {
      observed: false,
      source: 'caller-declared unverified harness claim',
      unverified: true,
      ...(callerClaims === undefined ? { text: null } : { text: String(callerClaims) }),
    },
    warnings: [
      'Foreign harness output is not TinySDD verification or acceptance evidence.',
      'Model identity is caller-declared; observed model identity is UNKNOWN.',
      'Usage and sandbox behavior are UNKNOWN; checks were not run by TinySDD.',
      ...(violations.length > 0 ? ['Candidate contains retained file-scope violations.'] : []),
      ...(!completion.completed ? ['Caller declared the foreign session incomplete.'] : []),
    ],
  };
  await writeJsonExclusive(join(artifactDir, 'result.json'), result);
  await writeJsonExclusive(join(artifactDir, 'finalization.json'), {
    schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
    runId,
    finalizedAt: new Date().toISOString(),
    completion,
    resultSha256: sha256(jsonBytes(result)),
    candidate: { ...candidate },
    afterSnapshotSha256: sha256(jsonBytes(after)),
  });
  return result;
}
