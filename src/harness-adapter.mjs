import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
  rename,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { resolveTaskPacket } from './controller.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import { compileContext } from './context-compiler.mjs';
import { validateChange } from './change-format.mjs';
import { DEFAULT_RUNTIME_SCOPE, classifyFileScopeChange, detectFilesystemAliases, observedPathError, preparationPaths } from './file-scope.mjs';
import { assertNoSymlinkPath, canonicalProjectRoot, digestJson, normalizeProjectRelative, sha256, stableStringify, tinyError } from './fs-utils.mjs';
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
const MAX_CALLER_CLAIMS_BYTES = 128 * 1024;
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

async function boundedBytes(path, { maxBytes = MAX_BUNDLE_FILE_BYTES, label = path, expectedInfo = null } = {}) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) captureError('HARNESS_BUNDLE_INVALID', `${label} must be a regular file`, { path });
    if (expectedInfo && (opened.dev !== expectedInfo.dev || opened.ino !== expectedInfo.ino || opened.size !== expectedInfo.size)) {
      captureError('HARNESS_CAPTURE_STALE', `${label} changed before it could be retained`, { path });
    }
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

function contextResources(compiled) {
  return (compiled?.resources ?? []).map((resource) => ({ path: resource.path }));
}

async function readSourceText(projectRoot, projectPath) {
  const normalized = normalizeProjectRelative(projectPath, 'context resource', sourceReadOptions(projectPath));
  const absolute = resolve(projectRoot, ...normalized.split('/'));
  await assertNoSymlinkPath(absolute, { allowMissing: false, requireDirectory: false });
  const bytes = await boundedBytes(absolute, { maxBytes: MAX_BUNDLE_FILE_BYTES, label: `context resource ${normalized}` });
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    captureError('HARNESS_BUNDLE_INVALID', `context resource has a UTF-8 BOM: ${normalized}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    captureError('HARNESS_BUNDLE_INVALID', `context resource is not valid UTF-8: ${normalized}`);
  }
}

function sortedRecords(value) {
  return [...value].sort((left, right) => left.path.localeCompare(right.path));
}

function assertRecordsEqual(actual, expected, label) {
  if (!Array.isArray(actual) || stableStringify(sortedRecords(actual)) !== stableStringify(sortedRecords(expected))) {
    captureError('HARNESS_BUNDLE_INVALID', `${label} does not match the approved packet semantics`);
  }
}

function comparePacketShape(packet, plan) {
  const expected = {
    runtimeScope: { ...DEFAULT_RUNTIME_SCOPE },
    brief: plan.brief,
    context: plan.context,
    checks: plan.checks,
    allow: plan.allow,
    protect: plan.protect,
    preparation: plan.preparation,
    dependsOn: plan.dependsOn,
  };
  const actual = {
    runtimeScope: packet.runtimeScope,
    brief: packet.brief?.path,
    context: packet.context?.path,
    checks: packet.checks?.path,
    allow: packet.allowedPaths,
    protect: packet.protectedPaths ?? [],
    preparation: packet.preparation ?? [],
    dependsOn: (packet.dependencies ?? []).map((dependency) => dependency.id),
  };
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw tinyError('TASK_DESCRIPTOR_MISMATCH', `registered task ${packet.taskId} does not match the format plan`, { expected, actual });
  }
}

async function validateBundleSemantics(projectRoot, bundle, packet) {
  const manifest = bundle.manifest;
  const descriptorFiles = manifest.descriptorSet?.descriptorFiles;
  if (!Array.isArray(descriptorFiles) || descriptorFiles.length === 0) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle descriptorSet is missing its complete descriptorFiles list');
  }
  const changeDescriptors = descriptorFiles.filter((descriptor) => typeof descriptor?.path === 'string' && descriptor.path.endsWith('/change.json'));
  if (changeDescriptors.length !== 1) captureError('HARNESS_BUNDLE_INVALID', 'bundle descriptorSet must identify exactly one change.json');
  let validated;
  try {
    validated = await validateChange({ projectRoot, changePath: changeDescriptors[0].path });
  } catch (error) {
    captureError('HARNESS_BUNDLE_INVALID', `bundle change descriptors are not current: ${error instanceof Error ? error.message : String(error)}`);
  }
  const slice = validated.slices.find((item) => item.value.id === packet.taskId);
  const plan = validated.registrationPlan.find((item) => item.id === packet.taskId);
  if (!slice || !plan) captureError('HARNESS_BUNDLE_INVALID', `bundle task ${packet.taskId} is absent from its change registration plan`);
  try {
    comparePacketShape(packet, plan);
  } catch (error) {
    captureError('HARNESS_BUNDLE_INVALID', `bundle packet does not match its current registration plan: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.changeId !== validated.change.id || manifest.sliceId !== packet.taskId || manifest.taskId !== packet.taskId) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle task identity does not match the approved change');
  }
  if (stableStringify(manifest.descriptorSet) !== stableStringify(validated.preparationIdentity)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle descriptorSet is not the current preparation identity');
  }

  let compiled = null;
  let contextBinding = 'none';
  if (packet.context) {
    try {
      compiled = await compileContext(projectRoot, packet.context, { readSource: (path) => readSourceText(projectRoot, path) });
    } catch (error) {
      captureError('HARNESS_BUNDLE_INVALID', `bundle context cannot be recompiled from the source: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (packet.context.compiledSha256 !== compiled.sha256) captureError('HARNESS_BUNDLE_INVALID', 'bundle packet context is not current');
    if (packet.approval.contextDigest === compiled.sha256) contextBinding = 'current';
    else if (packet.approval.contextDigest === compiled.legacySha256) contextBinding = 'legacy';
    else captureError('HARNESS_BUNDLE_INVALID', 'bundle approval context digest matches neither current nor legacy compiled context');
    const compiledContext = bundle.files.get('compiled-context.md');
    if (!compiledContext || !compiledContext.equals(Buffer.from(compiled.rendered))) {
      captureError('HARNESS_BUNDLE_INVALID', 'bundle compiled-context.md is not derived from the approved packet and source');
    }
  } else if ((packet.approval.contextDigest ?? null) !== null || bundle.files.has('compiled-context.md')) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle context references are inconsistent with the approved packet');
  }
  if (!packet.checks || typeof packet.checks.text !== 'string') captureError('HARNESS_BUNDLE_INVALID', 'bundle packet checks are required');

  const expectedIdentity = {
    schemaVersion: 1,
    changeId: validated.change.id,
    sliceId: slice.value.id,
    descriptorSetSha256: validated.preparationIdentity.descriptorSetSha256,
    testReviewContractSha256: validated.preparationIdentity.testReviewContractSha256,
    currentApprovalDigest: packet.approval.approvalDigest,
    approvalDigest: packet.approval.approvalDigest,
    brief: {
      path: packet.brief.path,
      bytes: Buffer.byteLength(packet.brief.text),
      sha256: sha256(packet.brief.text),
    },
    context: compiled === null ? null : {
      path: packet.context.path,
      manifestSha256: packet.context.sha256,
      compiledSha256: compiled.sha256,
      compiledBytes: compiled.bytes,
      approvalContextDigest: packet.approval.contextDigest ?? null,
      approvalContextBinding: contextBinding,
      approvalComparison: contextBinding === 'legacy' ? 'approval.contextDigest=compiled.legacySha256' : contextBinding === 'current' ? 'approval.contextDigest=compiled.sha256' : 'none',
      legacySha256: compiled.legacySha256,
      sourceDigests: compiled.resources.map((resource) => ({ path: resource.path, sha256: resource.sourceSha256, bytes: resource.sourceBytes })),
    },
    checks: { path: packet.checks.path, bytes: Buffer.byteLength(packet.checks.text), sha256: sha256(packet.checks.text) },
  };
  if (stableStringify(manifest.identity) !== stableStringify(expectedIdentity) || manifest.identityDigest !== digestJson(expectedIdentity)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle identity is not derived from the approved packet and source');
  }
  const expectedPreparation = {
    brief: { path: packet.brief.path, testReviewContractSha256: validated.preparationIdentity.testReviewContractSha256 },
    testReview: slice.value.testReview,
    resolvedBudget: { ...slice.resolvedBudget },
    advisoryCounts: {
      implementationFiles: slice.value.implementationFiles.length,
      sliceTests: slice.value.sliceTests.length,
    },
    expectedOutputs: {
      implementationFiles: [...slice.value.implementationFiles],
      sliceTests: [...slice.value.sliceTests],
    },
    featureTests: [...validated.change.featureTests],
    integration: validated.change.integration.filter((item) => item.wiringSlice === slice.value.id || item.testPaths.some((testPath) => validated.change.featureTests.includes(testPath))),
    descriptors: validated.preparationIdentity.descriptorFiles,
    paths: plan.preparation ?? [],
  };
  if (stableStringify(manifest.preparation) !== stableStringify(expectedPreparation)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle preparation metadata is not derived from the registration plan');
  }
  const expectedPacket = {
    path: 'packet.json',
    sha256: sha256(bundle.packetBytes),
    approval: { ...packet.approval },
    dependencies: packet.dependencies ?? [],
  };
  if (stableStringify(manifest.packet) !== stableStringify(expectedPacket)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle packet reference is not tied to the approved packet');
  }
  if (stableStringify(manifest.citedSourceSnapshots) !== stableStringify(validated.sourceSnapshots)) {
    captureError('HARNESS_BUNDLE_INVALID', 'bundle cited source snapshots are not current');
  }

  const contextPaths = compiled?.resources.map((resource) => resource.path) ?? [];
  const preparation = plan.preparation ?? [];
  const references = [...new Set([...plan.allow, ...plan.protect, ...contextPaths, ...preparation.map((item) => item.path)])];
  const allowedMissing = new Set([...plan.allow, ...preparation.filter((item) => item.exists === false).map((item) => item.path)]);
  const sourceSnapshots = new Map();
  for (const projectPath of references) {
    const observed = await sourceIdentity(projectRoot, projectPath);
    if (!observed.exists && !allowedMissing.has(projectPath)) {
      captureError('HARNESS_BUNDLE_INVALID', `bundle checkoutSnapshot omits a required source file: ${projectPath}`);
    }
    sourceSnapshots.set(projectPath, observed);
  }
  const expectedCheckout = references.map((projectPath) => sourceSnapshots.get(projectPath));
  assertRecordsEqual(manifest.checkoutSnapshot, expectedCheckout, 'bundle checkoutSnapshot');
  const expectedBaselines = plan.allow.flatMap((projectPath) => {
    const observed = sourceSnapshots.get(projectPath);
    return observed?.exists ? [{ path: projectPath, bundlePath: `baselines/${projectPath}`, bytes: observed.bytes, sha256: observed.sha256 }] : [];
  });
  assertRecordsEqual(manifest.retainedBaselines, expectedBaselines, 'bundle retainedBaselines');

  const expectedFiles = new Map();
  const addExpected = (path, bytes, sha) => expectedFiles.set(path, { path, bytes, sha256: sha });
  addExpected('packet.json', bundle.packetBytes.byteLength, sha256(bundle.packetBytes));
  addExpected('brief.md', Buffer.byteLength(packet.brief.text), sha256(packet.brief.text));
  if (compiled) addExpected('compiled-context.md', compiled.bytes, compiled.sha256);
  addExpected('checks.json', Buffer.byteLength(packet.checks.text), sha256(packet.checks.text));
  for (const baseline of expectedBaselines) addExpected(baseline.bundlePath, baseline.bytes, baseline.sha256);
  for (const descriptor of validated.preparationIdentity.descriptorFiles) addExpected(`preparation/${descriptor.path}`, descriptor.bytes, descriptor.sha256);
  const expectedRefs = [...expectedFiles.values()];
  assertRecordsEqual(manifest.files, expectedRefs, 'bundle files');
  assertRecordsEqual(manifest.retainedFiles, expectedRefs, 'bundle retainedFiles');
  for (const expected of expectedRefs) {
    const bytes = bundle.files.get(expected.path);
    if (!bytes || bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      captureError('HARNESS_BUNDLE_INVALID', `bundle/${expected.path} is not the retained approved content`);
    }
  }
  if (bundle.files.size !== expectedFiles.size) captureError('HARNESS_BUNDLE_INVALID', 'bundle contains unregistered retained files');
  return { compiled, contextResources: contextResources(compiled) };
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
        const bytes = await boundedBytes(sourcePath, {
          maxBytes: workerCaptureLimits.MAX_COPY_BYTES - counters.bytes,
          label: `candidate/${entry.name}`,
          expectedInfo: info,
        });
        if (bytes.byteLength !== info.size) captureError('HARNESS_CAPTURE_STALE', `candidate file changed while being retained: ${entry.name}`);
        await writeFile(destinationPath, bytes, { flag: 'wx', mode: info.mode & 0o777 });
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

function validateCallerClaims(value) {
  if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CALLER_CLAIMS_BYTES)) {
    captureError('HARNESS_CLAIM_LIMIT', 'callerClaims must be bounded text');
  }
  return value;
}

function assertBeginBinding(capture, binding, captureBytes) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.schemaVersion !== HARNESS_CAPTURE_SCHEMA_VERSION
    || binding.kind !== 'tinysdd-harness-binding'
    || binding.runId !== capture.runId
    || typeof binding.sessionId !== 'string'
    || typeof binding.captureSha256 !== 'string') {
    captureError('HARNESS_CAPTURE_INVALID', `run ${capture.runId} has an invalid begin binding`);
  }
  if (sha256(captureBytes) !== binding.captureSha256
    || binding.sessionId !== capture.sessionId
    || binding.taskId !== capture.taskId
    || stableStringify(binding.source) !== stableStringify(capture.project)
    || stableStringify(binding.candidate) !== stableStringify(capture.candidate)
    || stableStringify(binding.bundle) !== stableStringify(capture.bundle)
    || binding.packetSha256 !== capture.packetSha256
    || binding.beforeSnapshotSha256 !== capture.beforeSnapshotSha256) {
    captureError('HARNESS_CAPTURE_INVALID', `run ${capture.runId} capture metadata no longer matches its begin binding`);
  }
  return binding;
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
  const bindingRead = await boundedJson(join(artifactDir, 'begin-binding.json'), 'begin-binding.json');
  const binding = assertBeginBinding(capture, bindingRead.value, captureRead.bytes);
  if (!capture.candidate?.path || !capture.bundle?.path || !capture.project?.root) captureError('HARNESS_CAPTURE_INVALID', `run ${runId} lacks immutable path identities`);
  return { artifactDir, capture, binding };
}

async function acquireFinalizationLock(artifactDir, runId) {
  const path = join(artifactDir, 'finalization.lock');
  try {
    await writeFile(path, jsonBytes({ schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION, runId, acquiredAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') captureError('HARNESS_FINALIZATION_IN_PROGRESS', `run ${runId} is already being finalized`, { runId });
    throw error;
  }
  return path;
}

async function releaseFinalizationLock(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
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

async function stageFinalizeDirectory(artifactDir) {
  return mkdtemp(join(artifactDir, '.finalize-'));
}

async function commitStagedDirectory(stagedPath, finalPath, expectedSnapshot, label) {
  const existing = await lstatIfPresent(finalPath);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) captureError('HARNESS_CAPTURE_STALE', `${label} already exists with the wrong type`);
    const actual = await snapshotTree(finalPath);
    if (stableStringify(actual) !== stableStringify(expectedSnapshot)) captureError('HARNESS_CAPTURE_STALE', `${label} already exists with different contents`);
    return;
  }
  await rename(stagedPath, finalPath);
}

async function commitStagedJson(stagedPath, finalPath, expectedValue, label) {
  const existing = await lstatIfPresent(finalPath);
  if (existing) {
    const actual = await boundedJson(finalPath, label);
    if (stableStringify(actual.value) !== stableStringify(expectedValue)) captureError('HARNESS_CAPTURE_STALE', `${label} already exists with different contents`);
    return;
  }
  await rename(stagedPath, finalPath);
}

async function writeJsonOrVerify(path, value, label) {
  const existing = await lstatIfPresent(path);
  if (existing) {
    const actual = await boundedJson(path, label);
    if (stableStringify(actual.value) !== stableStringify(value)) captureError('HARNESS_CAPTURE_STALE', `${label} already exists with different contents`);
    return;
  }
  await writeJsonExclusive(path, value);
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
  const semantics = await validateBundleSemantics(root, bundle, packet);
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
    await assertCopiedInputs(root, copy, packet.allowedPaths, packet.protectedPaths ?? [], packet.preparation ?? [], { resources: semantics.contextResources });
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
  const capture = {
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
  };
  const captureBytes = jsonBytes(capture);
  await writeExclusive(join(artifactDir, 'capture.json'), captureBytes);
  await writeJsonExclusive(join(artifactDir, 'begin-binding.json'), {
    schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
    kind: 'tinysdd-harness-binding',
    runId,
    taskId: packet.taskId,
    sessionId,
    source: capture.project,
    candidate: capture.candidate,
    bundle: capture.bundle,
    packetSha256: capture.packetSha256,
    beforeSnapshotSha256: capture.beforeSnapshotSha256,
    captureSha256: sha256(captureBytes),
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
    beginBindingPath: join(artifactDir, 'begin-binding.json'),
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
  const completion = completionRecord(completed);
  validateCallerClaims(callerClaims);
  const root = await canonicalProjectRoot(projectRoot);
  const loaded = await loadCapture(root, runId);
  const { artifactDir, capture, binding } = loaded;
  const lockPath = await acquireFinalizationLock(artifactDir, runId);
  try {
    if (await lstatIfPresent(join(artifactDir, 'result.json'))) {
      captureError('HARNESS_ALREADY_FINALIZED', `run ${runId} already has a final result`, { runId });
    }
    const source = await directoryIdentity(root, 'source project');
    if (source.realpath !== binding.source.root || source.dev !== binding.source.dev || source.ino !== binding.source.ino) {
      captureError('HARNESS_SOURCE_CHANGED', 'source project identity changed since capture began', { expected: binding.source, actual: source });
    }
    const candidate = await assertIdentity(binding.candidate.path, binding.candidate, 'candidate');
    await ensureBundleIdentity(binding.bundle.path, binding.bundle, 'bundle directory');
    const bundle = await readBundle(binding.bundle.path);
    if (bundle.manifestSha256 !== binding.bundle.manifestSha256 || bundle.packetSha256 !== binding.bundle.packetSha256) {
      captureError('HARNESS_BUNDLE_CHANGED', 'bundle bytes changed since capture began');
    }
    await verifyRetainedBundle(binding.bundle.retainedPath, bundle);
    const packetBytes = await boundedBytes(join(artifactDir, 'packet.json'), { maxBytes: MAX_BUNDLE_FILE_BYTES, label: 'retained packet.json' });
    if (sha256(packetBytes) !== binding.packetSha256 || !packetBytes.equals(bundle.packetBytes)) captureError('HARNESS_BUNDLE_CHANGED', 'retained approval packet changed');
    const packet = await currentPacket(root, bundle.packet, binding.packetSha256);
    await validateBundleSemantics(root, bundle, packet);
    await verifyCheckoutSnapshot(root, bundle.manifest.checkoutSnapshot, 'bundle checkoutSnapshot');
    const beforeRead = await boundedJson(join(artifactDir, 'before-snapshot.json'), 'before-snapshot.json');
    const before = beforeRead.value;
    if (sha256(beforeRead.bytes) !== binding.beforeSnapshotSha256) captureError('HARNESS_CAPTURE_INVALID', 'retained baseline snapshot changed');
    const retainedBeforePath = join(artifactDir, 'workspace-before');
    await assertNoSymlinkPath(retainedBeforePath, { allowMissing: false, requireDirectory: true });
    const retainedBefore = await snapshotTree(retainedBeforePath);
    if (stableStringify(retainedBefore) !== stableStringify(before)) {
      captureError('HARNESS_CAPTURE_STALE', 'retained workspace-before changed since capture began');
    }
    const aliases = await detectFilesystemAliases(root);
    if (stableStringify(aliases) !== stableStringify(capture.filesystemAliases)) {
      captureError('HARNESS_SOURCE_CHANGED', 'source-derived filesystem alias behavior changed since capture began');
    }

    const stagingDir = await stageFinalizeDirectory(artifactDir);
    const sourceCurrent = await captureSourceCheck(root, stagingDir);
    if (stableStringify(sourceCurrent.snapshot) !== stableStringify(before)) {
      captureError('HARNESS_SOURCE_CHANGED', 'source project files changed since capture began');
    }
    const after = await snapshotTree(binding.candidate.path);
    const stagedAfter = join(stagingDir, 'workspace-after');
    await retainCandidateTree(binding.candidate.path, stagedAfter);
    const retainedAfter = await snapshotTree(stagedAfter);
    if (stableStringify(after) !== stableStringify(retainedAfter)) captureError('HARNESS_CAPTURE_STALE', 'candidate changed while being retained');
    const stagedAfterSnapshot = join(stagingDir, 'after-snapshot.json');
    await writeJsonExclusive(stagedAfterSnapshot, after);
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
    const model = {
      id: capture.model.id,
      source: 'caller-declared',
      observedId: UNKNOWN,
      observedSource: 'unobserved',
    };
    const finalWorkspaceAfter = join(artifactDir, 'workspace-after');
    const finalAfterSnapshot = join(artifactDir, 'after-snapshot.json');
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
        bundle: binding.bundle.retainedPath,
        bundleSource: binding.bundle.path,
        packet: join(artifactDir, 'packet.json'),
        runtime: join(artifactDir, 'runtime.json'),
        beforeSnapshot: join(artifactDir, 'before-snapshot.json'),
        afterSnapshot: finalAfterSnapshot,
        sourceCurrent: join(artifactDir, 'source-current'),
        workspaceBefore: join(artifactDir, 'workspace-before'),
        workspaceAfter: finalWorkspaceAfter,
        candidate: binding.candidate.path,
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
    const finalization = {
      schemaVersion: HARNESS_CAPTURE_SCHEMA_VERSION,
      runId,
      finalizedAt: new Date().toISOString(),
      completion,
      resultSha256: sha256(jsonBytes(result)),
      candidate: { ...candidate },
      afterSnapshotSha256: sha256(jsonBytes(after)),
    };
    await commitStagedDirectory(sourceCurrent.sourceCheck, join(artifactDir, 'source-current'), sourceCurrent.snapshot, 'source-current');
    await commitStagedDirectory(stagedAfter, finalWorkspaceAfter, after, 'workspace-after');
    await commitStagedJson(stagedAfterSnapshot, finalAfterSnapshot, after, 'after-snapshot.json');
    // Publish the finalization marker first. A result without its marker would
    // be applyable after a later write failure; an existing marker is verified
    // on retry so no evidence is overwritten.
    await writeJsonOrVerify(join(artifactDir, 'finalization.json'), finalization, 'finalization.json');
    await writeJsonExclusive(join(artifactDir, 'result.json'), result);
    return result;
  } finally {
    await releaseFinalizationLock(lockPath);
  }
}
