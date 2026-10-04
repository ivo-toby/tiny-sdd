import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  atomicWriteFile,
  assertNoSymlinkPath,
  canonicalProjectRoot,
  digestJson,
  ensureDirectory,
  normalizeProjectRelative,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import {
  BENCHMARK_UNKNOWN,
  benchmarkConfigDigest,
  validateBenchmarkConfigIdentity,
} from './benchmark-schema.mjs';
import { validateBenchmarkInvocation } from './benchmark-results.mjs';
import {
  mergeQualificationRecords,
  validateQualificationRecord,
} from './qualification.mjs';

export const QUALIFICATION_STORE_SCHEMA_VERSION = 1;
export const QUALIFICATION_STORE_DIRECTORY = '.tinysdd/qualifications';
export const QUALIFICATION_PROFILE_REFERENCES_PATH = `${QUALIFICATION_STORE_DIRECTORY}/profile-references.json`;
export const QUALIFICATION_STORE_LOCK_PATH = `${QUALIFICATION_STORE_DIRECTORY}/.lock`;
export const QUALIFICATION_EVIDENCE_INDEX_PATH = `${QUALIFICATION_STORE_DIRECTORY}/evidence.json`;
const MAX_STORE_BYTES = 4 * 1024 * 1024;

function boundedJson(value, label) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    invalid(`${label} could not be serialized`, { causeCode: error?.code });
  }
  if (typeof text !== 'string') invalid(`${label} could not be serialized`);
  const serialized = `${text}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) invalid(`${label} exceeds the ${MAX_STORE_BYTES}-byte write limit`);
  return serialized;
}

async function atomicWriteBoundedJson(target, value, label) {
  await atomicWriteFile(target, boundedJson(value, label));
}

function invalid(message, details = undefined) {
  throw tinyError('QUALIFICATION_STORE_INVALID', message, details);
}

function busy(message = 'qualification store is locked') {
  throw tinyError('QUALIFICATION_STORE_BUSY', message);
}

function contentRef(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  if (typeof value.path !== 'string' || value.path.length === 0) invalid(`${label}.path must be a nonempty string`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) invalid(`${label}.sha256 must be a lowercase SHA-256 digest`);
  let path;
  try {
    path = normalizeProjectRelative(value.path, `${label}.path`, { tinysddArtifactPrefix: '.tinysdd/' });
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  return { path, sha256: value.sha256 };
}

function evidenceSuite(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  if (typeof value.id !== 'string' || value.id.length === 0) invalid(`${label}.id must be a nonempty string`);
  if (typeof value.version !== 'string' || value.version.length === 0) invalid(`${label}.version must be a nonempty string`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) invalid(`${label}.sha256 must be a lowercase SHA-256 digest`);
  return { id: value.id, version: value.version, sha256: value.sha256 };
}

function evidenceSuitePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a project-relative path`);
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function evidenceWorkerName(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a nonempty string or null`);
  return value;
}

function evidenceContext(value, identity, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  if (!Object.hasOwn(value, 'verifier') || !Object.hasOwn(value, 'runChecks')) invalid(`${label} must contain verifier and runChecks`);
  const normalized = {
    verifier: value.verifier,
    runChecks: value.runChecks,
  };
  if (digestJson(normalized) !== digestJson({ verifier: identity.verifier, runChecks: identity.runChecks })) {
    invalid(`${label} does not match configIdentity`);
  }
  return normalized;
}

function evidenceEntry(value, label = 'qualification evidence entry') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const allowed = [
    'invocationId', 'invocation', 'caseResults', 'suitePath', 'suite', 'configDigest',
    'configIdentity', 'workerName', 'worker', 'verifierContext',
  ];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} contains unknown key: ${key}`);
  if (typeof value.invocationId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value.invocationId)) invalid(`${label}.invocationId is invalid`);
  const invocation = contentRef(value.invocation, `${label}.invocation`);
  if (!Array.isArray(value.caseResults)) invalid(`${label}.caseResults must be an array`);
  const caseResults = value.caseResults.map((entry, index) => contentRef(entry, `${label}.caseResults[${index}]`));
  if (new Set(caseResults.map((entry) => entry.path)).size !== caseResults.length) invalid(`${label}.caseResults contains duplicate paths`);
  const suite = evidenceSuite(value.suite, `${label}.suite`);
  const configIdentity = validateBenchmarkConfigIdentity(value.configIdentity);
  if (typeof value.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.configDigest)) invalid(`${label}.configDigest must be a lowercase SHA-256 digest`);
  if (benchmarkConfigDigest(configIdentity) !== value.configDigest) invalid(`${label}.configDigest does not match configIdentity`);
  if (suite.id !== configIdentity.suite.id || suite.version !== configIdentity.suite.version || suite.sha256 !== configIdentity.suite.contentSha256) {
    invalid(`${label}.suite does not match configIdentity`);
  }
  const worker = value.worker;
  if (!worker || typeof worker !== 'object' || Array.isArray(worker)
    || typeof worker.name !== 'string' || worker.name.length === 0
    || typeof worker.profileSha256 !== 'string' || !/^(?:UNKNOWN|[a-f0-9]{64})$/u.test(worker.profileSha256)) {
    invalid(`${label}.worker is invalid`);
  }
  const normalizedWorker = { name: worker.name, profileSha256: worker.profileSha256 };
  return {
    invocationId: value.invocationId,
    invocation,
    caseResults,
    suitePath: evidenceSuitePath(value.suitePath, `${label}.suitePath`),
    suite,
    configDigest: value.configDigest,
    configIdentity,
    workerName: evidenceWorkerName(value.workerName, `${label}.workerName`),
    worker: normalizedWorker,
    verifierContext: evidenceContext(value.verifierContext, configIdentity, `${label}.verifierContext`),
  };
}

function parseEvidenceIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('qualification evidence index must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'entries'].includes(key))) invalid('qualification evidence index contains unknown keys');
  if (value.schemaVersion !== QUALIFICATION_STORE_SCHEMA_VERSION) invalid(`qualification evidence index schemaVersion must be ${QUALIFICATION_STORE_SCHEMA_VERSION}`);
  if (!Array.isArray(value.entries)) invalid('qualification evidence index.entries must be an array');
  const entries = value.entries.map((entry, index) => evidenceEntry(entry, `qualification evidence index.entries[${index}]`));
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const entry of entries) {
    if (seenIds.has(entry.invocationId)) invalid(`qualification evidence index contains duplicate invocationId: ${entry.invocationId}`);
    if (seenPaths.has(entry.invocation.path)) invalid(`qualification evidence index contains duplicate invocation path: ${entry.invocation.path}`);
    seenIds.add(entry.invocationId);
    seenPaths.add(entry.invocation.path);
  }
  return {
    schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION,
    entries: entries.sort((left, right) => `${left.configDigest}\0${left.suite.id}\0${left.suite.version}\0${left.suite.sha256}\0${left.invocationId}\0${left.invocation.path}`
      .localeCompare(`${right.configDigest}\0${right.suite.id}\0${right.suite.version}\0${right.suite.sha256}\0${right.invocationId}\0${right.invocation.path}`)),
  };
}

function storePath(root, relativePath) {
  let normalized;
  try {
    normalized = normalizeProjectRelative(relativePath, 'qualification store path', { tinysddArtifactPrefix: '.tinysdd/' });
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (!normalized.startsWith(`${QUALIFICATION_STORE_DIRECTORY}/`)) invalid('qualification store path must be inside .tinysdd/qualifications');
  const target = resolve(root, ...normalized.split('/'));
  return { path: normalized, absolute: target };
}

async function regularJson(root, relativePath, label) {
  const target = storePath(root, relativePath);
  await assertNoSymlinkPath(target.absolute, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: label, causeCode: error?.code }));
  let info;
  try {
    info = await lstat(target.absolute);
  } catch (error) {
    invalid(`${label} is not readable`, { causeCode: error?.code });
  }
  if (!info.isFile() || info.isSymbolicLink()) invalid(`${label} must be a regular file`);
  if (info.size > MAX_STORE_BYTES) invalid(`${label} exceeds the ${MAX_STORE_BYTES}-byte read limit`);
  let bytes;
  try {
    bytes = await readFile(target.absolute);
  } catch (error) {
    invalid(`${label} could not be read`, { causeCode: error?.code });
  }
  if (bytes.byteLength > MAX_STORE_BYTES) invalid(`${label} exceeds the ${MAX_STORE_BYTES}-byte read limit`);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    invalid(`${label} is not valid JSON`, { causeCode: error?.code });
  }
  return { ...target, value, bytes, sha256: sha256(bytes) };
}

export function qualificationRecordPath(projectRoot, configDigest) {
  if (typeof configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(configDigest)) invalid('qualification configDigest must be a lowercase SHA-256 digest');
  const root = resolve(projectRoot);
  return storePath(root, `${QUALIFICATION_STORE_DIRECTORY}/${configDigest}.json`);
}

async function lockPath(root) {
  const target = storePath(root, QUALIFICATION_STORE_LOCK_PATH);
  await ensureDirectory(dirnameFor(target.absolute));
  return target;
}

function dirnameFor(target) {
  return target.slice(0, target.lastIndexOf('/'));
}

async function acquireLock(root) {
  const target = await lockPath(root);
  await assertNoSymlinkPath(target.absolute, { allowMissing: true, requireDirectory: false });
  const token = randomUUID();
  const content = JSON.stringify({ schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, pid: process.pid, token, createdAt: new Date().toISOString() });
  try {
    await writeFile(target.absolute, `${content}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') busy();
    throw error;
  }
  return { ...target, token };
}

async function releaseLock(lock) {
  try {
    const current = await readFile(lock.absolute, 'utf8');
    const parsed = JSON.parse(current);
    if (parsed?.token === lock.token) await unlink(lock.absolute);
  } catch {
    // Preserve the original operation result. A lock left behind causes the
    // next operation to refuse rather than guessing whether it is stale.
  }
}

export async function withQualificationStoreLock(projectRoot, callback) {
  const root = await canonicalProjectRoot(projectRoot);
  const lock = await acquireLock(root);
  try {
    return await callback(root);
  } finally {
    await releaseLock(lock);
  }
}

async function readEvidenceIndexUnlocked(root) {
  const target = storePath(root, QUALIFICATION_EVIDENCE_INDEX_PATH);
  try {
    const loaded = await regularJson(root, target.path, 'qualification evidence index');
    return { target, data: parseEvidenceIndex(loaded.value), sha256: loaded.sha256 };
  } catch (error) {
    if (error?.details?.causeCode === 'ENOENT' || error?.details?.causeCode === 'PATH_NOT_FOUND') {
      return { target, data: { schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, entries: [] }, sha256: null };
    }
    throw error;
  }
}

export async function readQualificationEvidenceIndex(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const loaded = await readEvidenceIndexUnlocked(root);
  return { ...loaded.data, path: loaded.target.path, sha256: loaded.sha256 };
}

function sameEvidenceEntry(left, right) {
  return digestJson(left) === digestJson(right);
}

function registrationEntry({ invocationPath, invocationSha256, invocation, suitePath, workerName }) {
  let normalizedInvocation;
  try {
    normalizedInvocation = validateBenchmarkInvocation(invocation);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { causeCode: error?.code });
  }
  if (typeof invocationPath !== 'string' || invocationPath.length === 0) invalid('qualification evidence invocationPath is required');
  if (typeof invocationSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(invocationSha256)) invalid('qualification evidence invocationSha256 must be a lowercase SHA-256 digest');
  if (normalizedInvocation.invocationId === undefined) invalid('qualification evidence invocationId is required');
  const entry = {
    invocationId: normalizedInvocation.invocationId,
    invocation: { path: invocationPath, sha256: invocationSha256 },
    caseResults: normalizedInvocation.caseResults,
    suitePath,
    suite: normalizedInvocation.suite,
    configDigest: normalizedInvocation.configDigest,
    configIdentity: normalizedInvocation.configIdentity,
    workerName: workerName ?? null,
    worker: normalizedInvocation.worker,
    verifierContext: {
      verifier: normalizedInvocation.configIdentity.verifier,
      runChecks: normalizedInvocation.configIdentity.runChecks,
    },
  };
  return evidenceEntry(entry);
}

/** Register one immutable benchmark invocation for cumulative qualification discovery. */
export async function registerQualificationInvocation(projectRoot, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('qualification evidence registration must be an object');
  const entry = registrationEntry(input);
  return withQualificationStoreLock(projectRoot, async (root) => {
    const loaded = await readEvidenceIndexUnlocked(root);
    const previous = loaded.data.entries.find((candidate) => candidate.invocationId === entry.invocationId);
    if (previous !== undefined) {
      if (!sameEvidenceEntry(previous, entry)) {
        invalid(`qualification evidence invocationId is bound to different evidence: ${entry.invocationId}`);
      }
      return { entry: previous, path: loaded.target.path, sha256: loaded.sha256, index: loaded.data };
    }
    const snapshot = await snapshotStoreFile(root, QUALIFICATION_EVIDENCE_INDEX_PATH, 'qualification evidence index');
    const data = parseEvidenceIndex({
      schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION,
      entries: [...loaded.data.entries, entry],
    });
    try {
      await atomicWriteBoundedJson(loaded.target.absolute, data, 'qualification evidence index');
      const saved = await regularJson(root, loaded.target.path, 'qualification evidence index');
      return { entry, path: loaded.target.path, sha256: saved.sha256, index: data };
    } catch (error) {
      await restoreStoreFile(snapshot);
      throw error;
    }
  });
}

async function recordBytes(recordPath) {
  const info = await regularJson(recordPath.root, recordPath.path, 'qualification record');
  const record = validateQualificationRecord(info.value);
  return { ...info, record };
}

async function snapshotStoreFile(root, relativePath, label) {
  const target = storePath(root, relativePath);
  try {
    const info = await lstat(target.absolute);
    if (info.isSymbolicLink() || !info.isFile()) invalid(`${label} must be a regular file: ${target.path}`);
    if (info.size > MAX_STORE_BYTES) invalid(`${label} exceeds the ${MAX_STORE_BYTES}-byte read limit`);
    const bytes = await readFile(target.absolute);
    if (bytes.byteLength > MAX_STORE_BYTES) invalid(`${label} exceeds the ${MAX_STORE_BYTES}-byte read limit`);
    return { target, bytes };
  } catch (error) {
    if (error?.code === 'ENOENT') return { target, bytes: null };
    throw error;
  }
}

async function restoreStoreFile(snapshot) {
  if (snapshot.bytes === null) {
    await unlink(snapshot.target.absolute).catch(() => {});
    return;
  }
  await atomicWriteFile(snapshot.target.absolute, snapshot.bytes);
}

export async function readQualificationRecord(projectRoot, recordPath) {
  const root = await canonicalProjectRoot(projectRoot);
  const requested = typeof recordPath === 'string' && recordPath.length > 0
    ? storePath(root, recordPath)
    : invalid('qualification record path is required');
  const loaded = await recordBytes({ root, path: requested.path });
  return { ...loaded.record, record: loaded.record, path: requested.path, sha256: loaded.sha256 };
}

async function writeRecordUnlocked(root, record, { replace = false } = {}) {
  const normalized = validateQualificationRecord(record);
  const target = qualificationRecordPath(root, normalized.configDigest);
  let existing;
  try {
    existing = await lstat(target.absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing !== undefined && !replace) invalid(`qualification record already exists: ${target.path}`);
  if (existing?.isSymbolicLink()) invalid(`qualification record may not be a symlink: ${target.path}`);
  await atomicWriteFile(target.absolute, boundedJson(normalized, 'qualification record'));
  const saved = await recordBytes({ root, path: target.path });
  return { record: saved.record, path: target.path, sha256: saved.sha256 };
}

async function snapshotRecordFile(root, configDigest) {
  const target = qualificationRecordPath(root, configDigest);
  try {
    const info = await lstat(target.absolute);
    if (info.isSymbolicLink() || !info.isFile()) invalid(`qualification record must be a regular file: ${target.path}`);
    if (info.size > MAX_STORE_BYTES) invalid(`qualification record exceeds the ${MAX_STORE_BYTES}-byte read limit`);
    const bytes = await readFile(target.absolute);
    if (bytes.byteLength > MAX_STORE_BYTES) invalid(`qualification record exceeds the ${MAX_STORE_BYTES}-byte read limit`);
    return { target, bytes };
  } catch (error) {
    if (error?.code === 'ENOENT') return { target, bytes: null };
    throw error;
  }
}

async function restoreRecordFile(snapshot, saved) {
  if (snapshot.bytes === null) {
    await unlink(saved.absolute).catch(() => {});
    return;
  }
  await atomicWriteFile(snapshot.target.absolute, snapshot.bytes);
}

export async function writeQualificationRecord(projectRoot, record, { replace = false } = {}) {
  const normalized = validateQualificationRecord(record);
  if (replace) return replaceQualificationRecord(projectRoot, normalized);
  return withQualificationStoreLock(projectRoot, async (root) => {
    const snapshot = await snapshotRecordFile(root, normalized.configDigest);
    let writeAttempted = false;
    try {
      writeAttempted = true;
      return await writeRecordUnlocked(root, normalized, { replace });
    } catch (error) {
      if (writeAttempted) await restoreRecordFile(snapshot, { absolute: snapshot.target.absolute });
      throw error;
    }
  });
}

function profileReference(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const allowed = ['profilePath', 'profileDigest', 'workerName', 'record', 'configDigest', 'suite'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} contains unknown key: ${key}`);
  const profilePath = value.profilePath === null ? null : (() => {
    if (typeof value.profilePath !== 'string' || value.profilePath.length === 0) invalid(`${label}.profilePath must be a path or null`);
    try {
      return normalizeProjectRelative(value.profilePath, `${label}.profilePath`);
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
  })();
  const profileDigest = value.profileDigest === BENCHMARK_UNKNOWN
    ? BENCHMARK_UNKNOWN
    : (() => {
      if (typeof value.profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.profileDigest)) invalid(`${label}.profileDigest must be a digest or UNKNOWN`);
      return value.profileDigest;
    })();
  if (profilePath === null && profileDigest !== BENCHMARK_UNKNOWN) invalid(`${label}.profileDigest must be UNKNOWN when profilePath is null`);
  if (profilePath !== null && profileDigest === BENCHMARK_UNKNOWN) invalid(`${label}.profileDigest must be known when profilePath is set`);
  if (typeof value.workerName !== 'string' || value.workerName.length === 0) invalid(`${label}.workerName must be a nonempty string`);
  const record = contentRef(value.record, `${label}.record`);
  if (typeof value.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.configDigest)) invalid(`${label}.configDigest must be a lowercase SHA-256 digest`);
  if (!value.suite || typeof value.suite !== 'object' || Array.isArray(value.suite)) invalid(`${label}.suite must be an object`);
  if (typeof value.suite.id !== 'string' || typeof value.suite.version !== 'string' || typeof value.suite.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.suite.sha256)) invalid(`${label}.suite is invalid`);
  return {
    profilePath,
    profileDigest,
    workerName: value.workerName,
    record,
    configDigest: value.configDigest,
    suite: { id: value.suite.id, version: value.suite.version, sha256: value.suite.sha256 },
  };
}

function parseProfileReferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('qualification profile references must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'associations'].includes(key))) invalid('qualification profile references contain unknown keys');
  if (value.schemaVersion !== QUALIFICATION_STORE_SCHEMA_VERSION) invalid(`qualification profile references schemaVersion must be ${QUALIFICATION_STORE_SCHEMA_VERSION}`);
  if (!Array.isArray(value.associations)) invalid('qualification profile references.associations must be an array');
  const seen = new Set();
  const associations = value.associations.map((entry, index) => {
    const normalized = profileReference(entry, `qualification profile references.associations[${index}]`);
    const key = `${normalized.profilePath ?? ''}\0${normalized.profileDigest}\0${normalized.workerName}\0${normalized.configDigest}\0${normalized.record.path}`;
    if (seen.has(key)) invalid(`qualification profile references contains duplicate association: ${key.replaceAll('\0', '/')}`);
    seen.add(key);
    return normalized;
  });
  return { schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, associations };
}

async function readProfileReferencesUnlocked(root) {
  const target = storePath(root, QUALIFICATION_PROFILE_REFERENCES_PATH);
  try {
    const loaded = await regularJson(root, target.path, 'qualification profile references');
    return { target, data: parseProfileReferences(loaded.value), sha256: loaded.sha256 };
  } catch (error) {
    if (error?.details?.causeCode === 'ENOENT' || error?.details?.causeCode === 'PATH_NOT_FOUND') return { target, data: { schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, associations: [] }, sha256: null };
    throw error;
  }
}

async function validateAssociationBindings(root, data) {
  const profileStatuses = [];
  for (const association of data.associations) {
    const recordPath = storePath(root, association.record.path);
    const record = await recordBytes({ root, path: recordPath.path });
    if (record.sha256 !== association.record.sha256) invalid(`qualification profile reference record hash does not match: ${association.record.path}`);
    if (record.record.configDigest !== association.configDigest) invalid(`qualification profile reference configDigest does not match: ${association.record.path}`);
    const suite = record.record.suite;
    if (suite.id !== association.suite.id || suite.version !== association.suite.version || suite.sha256 !== association.suite.sha256) {
      invalid(`qualification profile reference suite does not match: ${association.record.path}`);
    }
    if (association.profilePath === null) {
      if (association.profileDigest !== BENCHMARK_UNKNOWN) invalid('qualification profile reference without a profile path must use UNKNOWN digest');
      profileStatuses.push({ profilePath: null, workerName: association.workerName, configDigest: association.configDigest, status: 'current' });
    } else {
      // Resolve the project-relative profile separately from the store path.
      let profileRelative;
      try {
        profileRelative = normalizeProjectRelative(association.profilePath, 'qualification profile path');
      } catch (error) {
        invalid(error instanceof Error ? error.message : String(error));
      }
      const profileAbsolute = resolve(root, ...profileRelative.split('/'));
      try {
        await assertNoSymlinkPath(profileAbsolute, { allowMissing: false, requireDirectory: false });
      } catch (error) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      let info;
      try {
        info = await lstat(profileAbsolute);
      } catch (error) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      let profileText;
      try {
        profileText = await readFile(profileAbsolute, 'utf8');
      } catch (error) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      if (Buffer.byteLength(profileText) > MAX_STORE_BYTES) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      let profileValue;
      try {
        profileValue = JSON.parse(profileText);
      } catch (error) {
        profileStatuses.push({ profilePath: association.profilePath, workerName: association.workerName, configDigest: association.configDigest, status: 'stale', reason: 'profile_unavailable' });
        continue;
      }
      const currentDigest = digestJson(profileValue);
      const current = association.profileDigest !== BENCHMARK_UNKNOWN && currentDigest === association.profileDigest;
      profileStatuses.push({
        profilePath: association.profilePath,
        workerName: association.workerName,
        configDigest: association.configDigest,
        status: current ? 'current' : 'stale',
        ...(current ? {} : { reason: 'profile_changed' }),
      });
    }
  }
  return { ...data, profileStatuses };
}

export async function readQualificationProfileReferences(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const loaded = await readProfileReferencesUnlocked(root);
  return validateAssociationBindings(root, loaded.data);
}

export async function persistQualificationRecord(projectRoot, record, {
  replace = false,
  profilePath = null,
  profile,
  workerName,
} = {}) {
  const normalizedRecord = validateQualificationRecord(record);
  boundedJson(normalizedRecord, 'qualification record');
  if (workerName === undefined) return writeQualificationRecord(projectRoot, normalizedRecord, { replace });
  if (typeof workerName !== 'string' || workerName.length === 0) invalid('qualification profile association requires workerName');
  return withQualificationStoreLock(projectRoot, async (root) => {
    const loaded = await readProfileReferencesUnlocked(root);
    await validateAssociationBindings(root, loaded.data);
    const profileDigest = profile === undefined ? BENCHMARK_UNKNOWN : digestJson(profile);
    const snapshot = await snapshotRecordFile(root, normalizedRecord.configDigest);
    const sidecarSnapshot = await snapshotStoreFile(root, QUALIFICATION_PROFILE_REFERENCES_PATH, 'qualification profile references');
    const existing = snapshot.bytes === null ? null : (await recordBytes({ root, path: snapshot.target.path }));
    const normalizedToWrite = existing !== null && replace
      ? mergeQualificationRecords(existing.record, normalizedRecord, { preferIncomingTargets: true })
      : normalizedRecord;
    const target = qualificationRecordPath(root, normalizedToWrite.configDigest);
    const associationTemplate = profileReference({
      profilePath,
      profileDigest,
      workerName,
      record: { path: target.path, sha256: '0'.repeat(64) },
      configDigest: normalizedToWrite.configDigest,
      suite: normalizedToWrite.suite,
    }, 'qualification profile association');
    let saved;
    let writeAttempted = false;
    try {
      writeAttempted = true;
      saved = await writeRecordUnlocked(root, normalizedToWrite, { replace });
      const association = { ...associationTemplate, record: { path: saved.path, sha256: saved.sha256 } };
      const key = `${association.profilePath ?? ''}\0${association.profileDigest}\0${association.workerName}\0${association.configDigest}\0${association.record.path}`;
      const refreshed = loaded.data.associations.map((entry) => entry.record.path === saved.path
        ? { ...entry, record: { path: saved.path, sha256: saved.sha256 } }
        : entry);
      const withoutSame = refreshed.filter((entry) => {
        const entryKey = `${entry.profilePath ?? ''}\0${entry.profileDigest}\0${entry.workerName}\0${entry.configDigest}\0${entry.record.path}`;
        return entryKey !== key;
      });
      withoutSame.push(association);
      const data = { schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, associations: withoutSame };
      const sidecar = storePath(root, QUALIFICATION_PROFILE_REFERENCES_PATH);
      await atomicWriteBoundedJson(sidecar.absolute, data, 'qualification profile references');
      return { ...saved, association, profileReferences: data };
    } catch (error) {
      if (writeAttempted) {
        await restoreRecordFile(snapshot, { absolute: snapshot.target.absolute });
        await restoreStoreFile(sidecarSnapshot);
      }
      throw error;
    }
  });
}

/** Append retained observations for one exact config digest, preserving prior evidence. */
export async function accumulateQualificationRecord(projectRoot, record, {
  profilePath = null,
  profile,
  workerName,
  targets,
  target,
} = {}) {
  const normalizedRecord = validateQualificationRecord(record);
  boundedJson(normalizedRecord, 'qualification record');
  if (workerName !== undefined && (typeof workerName !== 'string' || workerName.length === 0)) {
    invalid('qualification profile association requires workerName');
  }
  return withQualificationStoreLock(projectRoot, async (root) => {
    const loaded = await readProfileReferencesUnlocked(root);
    await validateAssociationBindings(root, loaded.data);
    const snapshot = await snapshotRecordFile(root, normalizedRecord.configDigest);
    const sidecarSnapshot = await snapshotStoreFile(root, QUALIFICATION_PROFILE_REFERENCES_PATH, 'qualification profile references');
    const existing = snapshot.bytes === null ? null : (await recordBytes({ root, path: snapshot.target.path }));
    const merged = existing === null
      ? mergeQualificationRecords([normalizedRecord], undefined, { targets: targets ?? target })
      : mergeQualificationRecords(existing.record, normalizedRecord, { targets: targets ?? target });
    let saved;
    try {
      saved = await writeRecordUnlocked(root, merged, { replace: existing !== null });
      let association;
      let data = loaded.data;
      if (workerName !== undefined) {
        const profileDigest = profile === undefined ? BENCHMARK_UNKNOWN : digestJson(profile);
        const associationTemplate = profileReference({
          profilePath,
          profileDigest,
          workerName,
          record: { path: saved.path, sha256: '0'.repeat(64) },
          configDigest: merged.configDigest,
          suite: merged.suite,
        }, 'qualification profile association');
        association = { ...associationTemplate, record: { path: saved.path, sha256: saved.sha256 } };
        const key = `${association.profilePath ?? ''}\0${association.profileDigest}\0${association.workerName}\0${association.configDigest}\0${association.record.path}`;
        const refreshed = loaded.data.associations.map((entry) => entry.record.path === saved.path
          ? { ...entry, record: { path: saved.path, sha256: saved.sha256 } }
          : entry);
        data = {
          schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION,
          associations: refreshed.filter((entry) => {
            const entryKey = `${entry.profilePath ?? ''}\0${entry.profileDigest}\0${entry.workerName}\0${entry.configDigest}\0${entry.record.path}`;
            return entryKey !== key;
          }).concat(association),
        };
        await atomicWriteBoundedJson(loaded.target.absolute, data, 'qualification profile references');
      } else if (loaded.sha256 !== null) {
        data = {
          schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION,
          associations: loaded.data.associations.map((entry) => entry.record.path === saved.path
            ? { ...entry, record: { path: saved.path, sha256: saved.sha256 } }
            : entry),
        };
        await atomicWriteBoundedJson(loaded.target.absolute, data, 'qualification profile references');
      }
      return { ...saved, ...(association === undefined ? {} : { association }), profileReferences: data };
    } catch (error) {
      await restoreRecordFile(snapshot, { absolute: snapshot.target.absolute });
      await restoreStoreFile(sidecarSnapshot);
      throw error;
    }
  });
}

/** Replace a rescored record while retaining every existing profile association. */
export async function replaceQualificationRecord(projectRoot, record) {
  const normalizedRecord = validateQualificationRecord(record);
  boundedJson(normalizedRecord, 'qualification record');
  return withQualificationStoreLock(projectRoot, async (root) => {
    const loaded = await readProfileReferencesUnlocked(root);
    await validateAssociationBindings(root, loaded.data);
    const snapshot = await snapshotRecordFile(root, normalizedRecord.configDigest);
    const sidecarSnapshot = await snapshotStoreFile(root, QUALIFICATION_PROFILE_REFERENCES_PATH, 'qualification profile references');
    const existing = snapshot.bytes === null ? null : (await recordBytes({ root, path: snapshot.target.path }));
    const normalizedToWrite = existing === null
      ? normalizedRecord
      : mergeQualificationRecords(existing.record, normalizedRecord, { preferIncomingTargets: true });
    let saved;
    try {
      saved = await writeRecordUnlocked(root, normalizedToWrite, { replace: true });
      const associations = loaded.data.associations
        .filter((entry) => entry.record.path !== saved.path)
        .concat(loaded.data.associations
          .filter((entry) => entry.record.path === saved.path)
          .map((entry) => ({ ...entry, record: { path: saved.path, sha256: saved.sha256 } })));
      const data = { schemaVersion: QUALIFICATION_STORE_SCHEMA_VERSION, associations };
      const sidecar = storePath(root, QUALIFICATION_PROFILE_REFERENCES_PATH);
      if (associations.length > 0 || loaded.sha256 !== null) await atomicWriteBoundedJson(sidecar.absolute, data, 'qualification profile references');
      return { ...saved, profileReferences: data };
    } catch (error) {
      await restoreRecordFile(snapshot, { absolute: snapshot.target.absolute });
      await restoreStoreFile(sidecarSnapshot);
      throw error;
    }
  });
}

export function compareQualificationApplicability(record, currentIdentity) {
  const normalized = validateQualificationRecord(record);
  if (currentIdentity === undefined || currentIdentity === null) return { status: 'not_checked', reason: 'current_identity_unavailable' };
  const identity = currentIdentity.identity ?? currentIdentity;
  const currentDigest = currentIdentity.configDigest ?? benchmarkConfigDigest(identity);
  if (currentDigest === normalized.configDigest && benchmarkConfigDigest(identity) === normalized.configDigest) {
    return { status: 'applicable', reason: null };
  }
  return { status: 'stale', reason: 'config_identity_mismatch' };
}
