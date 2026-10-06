import { dirname, join, sep } from 'node:path';
import {
  lstat,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

import { reportFeature, withFeatureReport } from './controller.mjs';
import { normalizeFeatureEvent } from './feature-events.mjs';
import {
  assertExactKeys,
  assertNoSymlinkPath,
  canonicalProjectRoot,
  ensureDirectory,
  normalizeProjectRelative,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
  withExclusiveLock,
  atomicWriteFile,
} from './fs-utils.mjs';
import {
  parseChangeDocument,
  parseDeltaDocument,
  parseSliceDocument,
  validateChange,
  readBounded,
} from './change-format.mjs';

export const LIVING_SPEC_SCHEMA_VERSION = 1;
export const DEFAULT_ARCHIVE_PREFIX = 'changes/archive';
export const DEFAULT_MERGE_DRAFT_NAME = 'merge-draft.json';
export const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;

const DIGEST = /^[a-f0-9]{64}$/u;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/u;
const OPERATIONS = new Set(['add', 'modify', 'remove']);
const DRAFT_KEYS = ['schemaVersion', 'changeId', 'specs'];
const DRAFT_SPEC_KEYS = ['spec', 'baseSha256', 'outputSha256', 'changes'];
const DRAFT_CHANGE_KEYS = ['id', 'operation', 'baseStart', 'baseEnd', 'baseText', 'outputText'];
const ARCHIVE_KEYS = ['schemaVersion', 'type', 'changeId', 'sourceChangePath', 'draftPath', 'archivedAt', 'inputs', 'validation', 'acceptance', 'specs', 'files'];
const ARCHIVE_ACCEPTANCE_KEYS = ['eventId', 'timestamp', 'by', 'reason', 'eventPath', 'eventSha256', 'membership', 'activeAcceptanceDigests', 'reportSha256', 'integration', 'freshness'];
const ARCHIVE_SPEC_KEYS = ['spec', 'baseSha256', 'before', 'after', 'requirementIds'];
const ARCHIVE_FILE_KEYS = ['sourcePath', 'archivePath', 'bytes', 'sha256'];
const ARCHIVE_INPUT_KEYS = ['path', 'archivePath', 'bytes', 'sha256'];
const ARCHIVE_VALIDATION_KEYS = ['preparationFiles', 'deltaFiles', 'sliceFiles', 'requirementIds'];
const ARCHIVE_DELTA_KEYS = ['path', 'spec', 'baseSha256', 'sha256', 'requirementIds'];
const ARCHIVE_SLICE_KEYS = ['path', 'id', 'sha256'];
const ARCHIVE_MEMBER_KEYS = ['id', 'retired'];

function invalid(message, details) {
  throw tinyError('SPEC_MERGE_INVALID', message, details);
}

function conflict(message, details) {
  throw tinyError('SPEC_MERGE_CONFLICT', message, details);
}

function archiveError(message, details) {
  throw tinyError('ARCHIVE_INVALID', message, details);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be nonempty text`);
  return value;
}

function requireDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid(`${label} must be a SHA-256 digest`);
  return value;
}

function requireSlug(value, label) {
  if (typeof value !== 'string' || !SLUG.test(value)) invalid(`${label} must match /^[a-z0-9][a-z0-9_-]*$/`);
  return value;
}

function requirePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a project-relative path`);
  try {
    const normalized = normalizeProjectRelative(value, label);
    if (normalized !== value) invalid(`${label} is not normalized`);
    return normalized;
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function requireOffset(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a nonnegative safe integer`);
  return value;
}

function parseDraftChange(value, index) {
  const label = `merge draft change ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  assertExactKeys(value, DRAFT_CHANGE_KEYS, 'SPEC_MERGE_INVALID', label);
  for (const key of DRAFT_CHANGE_KEYS) {
    if (!Object.hasOwn(value, key)) invalid(`${label} is missing ${key}`);
  }
  const operation = value.operation;
  if (!OPERATIONS.has(operation)) invalid(`${label}.operation must be add, modify, or remove`);
  const parsed = {
    id: requireSlug(value.id, `${label}.id`),
    operation,
    baseStart: requireOffset(value.baseStart, `${label}.baseStart`),
    baseEnd: requireOffset(value.baseEnd, `${label}.baseEnd`),
    baseText: typeof value.baseText === 'string' ? value.baseText : invalid(`${label}.baseText must be text`),
    outputText: typeof value.outputText === 'string' ? value.outputText : invalid(`${label}.outputText must be text`),
  };
  if (parsed.baseEnd < parsed.baseStart) invalid(`${label}.baseEnd must be at least baseStart`);
  if (operation === 'add') {
    if (parsed.baseStart !== parsed.baseEnd || parsed.baseText !== '') invalid(`${label} add must point at an empty base range`);
    if (parsed.outputText.length === 0) invalid(`${label} add outputText must be nonempty`);
  } else {
    if (parsed.baseStart === parsed.baseEnd || parsed.baseText.length === 0) invalid(`${label} ${operation} must point at a nonempty base range`);
    if (operation === 'remove' && parsed.outputText !== '') invalid(`${label} remove outputText must be empty`);
    if (operation === 'modify' && parsed.outputText.length === 0) invalid(`${label} modify outputText must be nonempty`);
  }
  return parsed;
}

function parseDraftSpec(value, index) {
  const label = `merge draft spec ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  assertExactKeys(value, DRAFT_SPEC_KEYS, 'SPEC_MERGE_INVALID', label);
  for (const key of DRAFT_SPEC_KEYS) {
    if (!Object.hasOwn(value, key)) invalid(`${label} is missing ${key}`);
  }
  if (!Array.isArray(value.changes) || value.changes.length === 0) invalid(`${label}.changes must be a nonempty array`);
  const changes = value.changes.map(parseDraftChange);
  const ids = new Set();
  for (const change of changes) {
    if (ids.has(change.id)) invalid(`${label}.changes repeats requirement id: ${change.id}`);
    ids.add(change.id);
  }
  return {
    spec: requirePath(value.spec, `${label}.spec`),
    baseSha256: requireDigest(value.baseSha256, `${label}.baseSha256`, { nullable: true }),
    outputSha256: requireDigest(value.outputSha256, `${label}.outputSha256`),
    changes,
  };
}

/** Parse the local-model merge handoff without reading or changing project files. */
export function parseMergeDraft(text) {
  if (typeof text !== 'string') invalid('merge draft must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`merge draft is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('merge draft must be an object');
  assertExactKeys(value, DRAFT_KEYS, 'SPEC_MERGE_INVALID', 'merge draft');
  for (const key of DRAFT_KEYS) {
    if (!Object.hasOwn(value, key)) invalid(`merge draft is missing ${key}`);
  }
  if (value.schemaVersion !== LIVING_SPEC_SCHEMA_VERSION) invalid(`merge draft schemaVersion must be ${LIVING_SPEC_SCHEMA_VERSION}`);
  if (!Array.isArray(value.specs) || value.specs.length === 0) invalid('merge draft specs must be a nonempty array');
  const specs = value.specs.map(parseDraftSpec);
  const paths = new Set();
  for (const spec of specs) {
    if (paths.has(spec.spec)) invalid(`merge draft repeats spec: ${spec.spec}`);
    paths.add(spec.spec);
  }
  return { schemaVersion: LIVING_SPEC_SCHEMA_VERSION, changeId: requireSlug(value.changeId, 'merge draft.changeId'), specs };
}

function byteSlice(buffer, start, end) {
  return buffer.subarray(start, end).toString('utf8');
}

function assertUtf8Boundary(buffer, offset, label) {
  if (offset > 0 && offset < buffer.length) {
    const byte = buffer[offset];
    if ((byte & 0xc0) === 0x80) invalid(`${label} splits a UTF-8 code point`);
  }
}

/**
 * Apply an explicit draft mapping to one exact baseline. Offsets are UTF-8
 * byte offsets, so the generated bytes retain every unrelated source byte.
 */
export function mergeSpecText(baseText, deltaChanges, draftSpec) {
  if (typeof baseText !== 'string') invalid('spec baseline must be text');
  if (!Array.isArray(deltaChanges) || deltaChanges.length === 0) invalid('spec delta changes must be nonempty');
  if (!draftSpec || typeof draftSpec !== 'object') invalid('draft spec must be an object');
  const base = Buffer.from(baseText, 'utf8');
  const baseSha256 = sha256(base);
  if (draftSpec.baseSha256 !== null && draftSpec.baseSha256 !== baseSha256) {
    conflict('merge draft base digest does not match the supplied spec', { expected: draftSpec.baseSha256, actual: baseSha256 });
  }
  if (draftSpec.baseSha256 === null && base.length !== 0) {
    conflict('new spec merge received nonempty baseline');
  }
  const deltas = new Map();
  for (const change of deltaChanges) {
    if (!change || typeof change !== 'object' || !OPERATIONS.has(change.operation) || typeof change.id !== 'string') invalid('spec delta change is malformed');
    if (deltas.has(change.id)) invalid(`spec delta repeats requirement id: ${change.id}`);
    deltas.set(change.id, change);
  }
  const drafts = new Map();
  for (const change of draftSpec.changes) {
    if (drafts.has(change.id)) invalid(`merge draft repeats requirement id: ${change.id}`);
    drafts.set(change.id, change);
  }
  if (drafts.size !== deltas.size || [...deltas.keys()].some((id) => !drafts.has(id))) {
    invalid('merge draft requirement mapping does not match the delta');
  }
  if (draftSpec.baseSha256 === null && deltaChanges.some((change) => change.operation !== 'add')) {
    invalid('a new spec may contain add operations only');
  }
  const operations = [...drafts.values()].map((draft, index) => {
    const delta = deltas.get(draft.id);
    if (draft.operation !== delta.operation) invalid(`merge draft operation does not match delta for ${draft.id}`);
    if (draft.baseEnd > base.length) invalid(`merge draft range exceeds baseline for ${draft.id}`);
    assertUtf8Boundary(base, draft.baseStart, `merge draft ${draft.id}.baseStart`);
    assertUtf8Boundary(base, draft.baseEnd, `merge draft ${draft.id}.baseEnd`);
    if (byteSlice(base, draft.baseStart, draft.baseEnd) !== draft.baseText) {
      conflict(`merge draft base text does not match the baseline for ${draft.id}`, { id: draft.id });
    }
    if (draft.operation !== 'remove' && !draft.outputText.includes(delta.text)) {
      invalid(`merge draft outputText does not contain delta text for ${draft.id}`);
    }
    return { ...draft, index };
  });
  const ascending = [...operations].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd || left.index - right.index);
  for (let index = 1; index < ascending.length; index += 1) {
    const previous = ascending[index - 1];
    const current = ascending[index];
    if (previous.baseEnd > current.baseStart) {
      conflict(`merge draft ranges overlap: ${previous.id} and ${current.id}`);
    }
  }
  const descending = [...operations].sort((left, right) => right.baseStart - left.baseStart || right.baseEnd - left.baseEnd || right.index - left.index);
  let merged = Buffer.from(base);
  for (const operation of descending) {
    const replacement = Buffer.from(operation.outputText, 'utf8');
    merged = Buffer.concat([merged.subarray(0, operation.baseStart), replacement, merged.subarray(operation.baseEnd)]);
  }
  const output = merged.toString('utf8');
  const outputSha256 = sha256(merged);
  if (outputSha256 !== draftSpec.outputSha256) {
    conflict('merged spec does not match the draft output digest', { expected: draftSpec.outputSha256, actual: outputSha256 });
  }
  return { text: output, bytes: merged.length, sha256: outputSha256, baseSha256 };
}

function archiveRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) archiveError(`${label} must be a relative archive path`);
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) archiveError(`${label} contains traversal`);
  return value;
}

async function writeStagedFile(target, content) {
  await ensureDirectory(dirname(target));
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
}

async function copyFileInto(source, target, sourcePath, archivePath, records, total) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) archiveError(`refusing symlink evidence: ${sourcePath}`);
  if (!info.isFile()) archiveError(`archive source must be a regular file: ${sourcePath}`);
  if (info.size > MAX_ARCHIVE_FILE_BYTES) archiveError(`archive source exceeds file limit: ${sourcePath}`);
  const content = await readFile(source);
  if (content.length !== info.size) archiveError(`archive source changed while reading: ${sourcePath}`);
  total.bytes += content.length;
  if (total.bytes > MAX_ARCHIVE_TOTAL_BYTES) archiveError(`archive exceeds ${MAX_ARCHIVE_TOTAL_BYTES} bytes`);
  await writeStagedFile(target, content);
  records.push({ sourcePath, archivePath, bytes: content.length, sha256: sha256(content) });
}

async function copyTreeInto(source, target, sourceRoot, archivePrefix, records, total) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) archiveError(`refusing symlink archive source: ${sourceRoot}`);
  if (!info.isDirectory()) archiveError(`archive source must be a directory: ${sourceRoot}`);
  await ensureDirectory(target);
  const names = [];
  for await (const entry of await opendir(source)) names.push(entry.name);
  names.sort();
  for (const name of names) {
    const from = join(source, name);
    const to = join(target, name);
    const sourcePath = sourceRoot ? `${sourceRoot}/${name}` : name;
    const archivePath = `${archivePrefix}/${name}`;
    const child = await lstat(from);
    if (child.isSymbolicLink()) archiveError(`refusing symlink archive source: ${sourcePath}`);
    if (child.isDirectory()) await copyTreeInto(from, to, sourcePath, archivePath, records, total);
    else if (child.isFile()) await copyFileInto(from, to, sourcePath, archivePath, records, total);
    else archiveError(`archive source contains a special file: ${sourcePath}`);
  }
}

async function copyInternalFile(root, projectPath, target, archivePath, records, total) {
  const absolute = await assertNoSymlinkPath(join(root, ...projectPath.split('/')), { allowMissing: false, requireDirectory: false });
  await copyFileInto(absolute, target, projectPath, archivePath, records, total);
}

function assertFreshFeatureAcceptance(feature, state) {
  if (!state || state.feature !== feature || state.accepted !== true) {
    throw tinyError('FEATURE_ACCEPTANCE_REQUIRED', `feature ${feature} has no explicit operator acceptance`);
  }
  const reasons = [
    ...(Array.isArray(state.staleReasons) ? state.staleReasons : []),
    ...(state.integration?.fresh === false ? (state.integration.reasons ?? ['integration evidence is stale']) : []),
  ];
  if (state.stale === true || state.eligible !== true || state.integration?.fresh !== true || reasons.length > 0) {
    throw tinyError('FEATURE_ACCEPTANCE_STALE', `feature ${feature} acceptance is stale`, { reasons: [...new Set(reasons)] });
  }
  const event = normalizeFeatureEvent(state.acceptance);
  if (!event || event.integration?.status !== 'passed') {
    throw tinyError('FEATURE_INTEGRATION_REQUIRED', `feature ${feature} acceptance has no passed integration evidence`);
  }
  return event;
}

function assertFeatureScope(plan, state, controllerState) {
  const expectedSliceIds = plan.validation.slices.map((slice) => slice.value.id).sort();
  const event = state.acceptance;
  const actualMembership = (event.membership ?? []).map((item) => item.id).sort();
  if (stableStringify(actualMembership) !== stableStringify(expectedSliceIds)
    || event.membership.some((item) => item.retired)) {
    throw tinyError('FEATURE_ACCEPTANCE_SCOPE_MISMATCH', 'feature acceptance does not cover exactly the change slices', {
      expected: expectedSliceIds,
      actual: event.membership,
    });
  }
  const currentMembership = (state.current?.membership ?? []).map((item) => item.id).sort();
  if (stableStringify(currentMembership) !== stableStringify(expectedSliceIds)) {
    throw tinyError('FEATURE_ACCEPTANCE_SCOPE_MISMATCH', 'current feature membership does not match the change slices', {
      expected: expectedSliceIds,
      actual: state.current?.membership,
    });
  }
  for (const slice of plan.validation.slices) {
    if (state.current?.statuses?.[slice.value.id] !== 'accepted') {
      throw tinyError('FEATURE_ACCEPTANCE_SCOPE_MISMATCH', `change slice is not currently accepted: ${slice.value.id}`);
    }
    if (state.current?.activeAcceptanceDigests?.[slice.value.id] !== event.activeAcceptanceDigests?.[slice.value.id]) {
      throw tinyError('FEATURE_ACCEPTANCE_SCOPE_MISMATCH', `change slice acceptance digest is not current: ${slice.value.id}`);
    }
    const task = controllerState?.tasks?.[slice.value.id];
    const registration = plan.validation.registrationPlan.find((item) => item.id === slice.value.id);
    if (!task || task.feature !== plan.change.id || !registration
      || stableStringify(task.preparation ?? []) !== stableStringify(registration.preparation ?? [])) {
      throw tinyError('FEATURE_ACCEPTANCE_SCOPE_MISMATCH', `accepted task does not retain the validated preparation for ${slice.value.id}`);
    }
  }
}

function acceptanceDigest(event) {
  return sha256(JSON.stringify(event));
}

function reportDigest(report) {
  return sha256(JSON.stringify(report));
}

function normalizeArchiveRecord(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) archiveError(`${label} must be an object`);
  assertExactKeys(record, ARCHIVE_FILE_KEYS, 'ARCHIVE_INVALID', label);
  for (const key of ARCHIVE_FILE_KEYS) if (!Object.hasOwn(record, key)) archiveError(`${label} is missing ${key}`);
  archiveRelativePath(record.sourcePath, `${label}.sourcePath`);
  archiveRelativePath(record.archivePath, `${label}.archivePath`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) archiveError(`${label}.bytes must be a nonnegative safe integer`);
  requireDigest(record.sha256, `${label}.sha256`);
  return { ...record };
}

function normalizeArchiveInput(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) archiveError(`${label} must be an object`);
  assertExactKeys(record, ARCHIVE_INPUT_KEYS, 'ARCHIVE_INVALID', label);
  for (const key of ARCHIVE_INPUT_KEYS) if (!Object.hasOwn(record, key)) archiveError(`${label} is missing ${key}`);
  requirePath(record.path, `${label}.path`);
  archiveRelativePath(record.archivePath, `${label}.archivePath`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) archiveError(`${label}.bytes must be a nonnegative safe integer`);
  requireDigest(record.sha256, `${label}.sha256`);
  return { ...record };
}

function normalizeValidationFile(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) archiveError(`${label} must be an object`);
  const keys = ['path', 'exists', 'bytes', 'sha256'];
  assertExactKeys(record, keys, 'ARCHIVE_INVALID', label);
  for (const key of keys) if (!Object.hasOwn(record, key)) archiveError(`${label} is missing ${key}`);
  requirePath(record.path, `${label}.path`);
  if (typeof record.exists !== 'boolean') archiveError(`${label}.exists must be boolean`);
  if (record.exists) {
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) archiveError(`${label}.bytes must be a nonnegative safe integer`);
    requireDigest(record.sha256, `${label}.sha256`);
  } else if (record.bytes !== null || record.sha256 !== null) {
    archiveError(`${label} missing files must use null bytes and sha256`);
  }
  return { ...record };
}

function normalizeValidationDelta(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) archiveError(`${label} must be an object`);
  assertExactKeys(record, ARCHIVE_DELTA_KEYS, 'ARCHIVE_INVALID', label);
  for (const key of ARCHIVE_DELTA_KEYS) if (!Object.hasOwn(record, key)) archiveError(`${label} is missing ${key}`);
  requirePath(record.path, `${label}.path`);
  requirePath(record.spec, `${label}.spec`);
  requireDigest(record.baseSha256, `${label}.baseSha256`, { nullable: true });
  requireDigest(record.sha256, `${label}.sha256`);
  if (!Array.isArray(record.requirementIds) || record.requirementIds.length === 0) archiveError(`${label}.requirementIds must be nonempty`);
  for (const id of record.requirementIds) requireSlug(id, `${label}.requirementIds`);
  if (new Set(record.requirementIds).size !== record.requirementIds.length) archiveError(`${label}.requirementIds contains duplicates`);
  return { ...record };
}

function normalizeValidationSlice(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) archiveError(`${label} must be an object`);
  assertExactKeys(record, ARCHIVE_SLICE_KEYS, 'ARCHIVE_INVALID', label);
  for (const key of ARCHIVE_SLICE_KEYS) if (!Object.hasOwn(record, key)) archiveError(`${label} is missing ${key}`);
  requirePath(record.path, `${label}.path`);
  requireSlug(record.id, `${label}.id`);
  requireDigest(record.sha256, `${label}.sha256`);
  return { ...record };
}

/** Validate the immutable archive marker before a recovery or idempotent return. */
export function parseArchiveManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) archiveError('archive manifest must be an object');
  assertExactKeys(value, ARCHIVE_KEYS, 'ARCHIVE_INVALID', 'archive manifest');
  for (const key of ARCHIVE_KEYS) if (!Object.hasOwn(value, key)) archiveError(`archive manifest is missing ${key}`);
  if (value.schemaVersion !== LIVING_SPEC_SCHEMA_VERSION || value.type !== 'tinysdd-change-archive') archiveError('archive manifest schema or type is unsupported');
  requireSlug(value.changeId, 'archive manifest.changeId');
  requirePath(value.sourceChangePath, 'archive manifest.sourceChangePath');
  requirePath(value.draftPath, 'archive manifest.draftPath');
  if (typeof value.archivedAt !== 'string' || !Number.isFinite(new Date(value.archivedAt).getTime())) archiveError('archive manifest.archivedAt must be an ISO timestamp');
  if (!value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)) archiveError('archive manifest.inputs must be an object');
  assertExactKeys(value.inputs, ['change', 'draft'], 'ARCHIVE_INVALID', 'archive manifest.inputs');
  if (!Object.hasOwn(value.inputs, 'change') || !Object.hasOwn(value.inputs, 'draft')) archiveError('archive manifest.inputs must contain change and draft');
  const inputs = {
    change: normalizeArchiveInput(value.inputs.change, 'archive manifest.inputs.change'),
    draft: normalizeArchiveInput(value.inputs.draft, 'archive manifest.inputs.draft'),
  };
  if (inputs.change.path !== value.sourceChangePath || inputs.draft.path !== value.draftPath) archiveError('archive manifest input paths do not match its source paths');
  if (!value.validation || typeof value.validation !== 'object' || Array.isArray(value.validation)) archiveError('archive manifest.validation must be an object');
  assertExactKeys(value.validation, ARCHIVE_VALIDATION_KEYS, 'ARCHIVE_INVALID', 'archive manifest.validation');
  for (const key of ARCHIVE_VALIDATION_KEYS) if (!Object.hasOwn(value.validation, key)) archiveError(`archive manifest.validation is missing ${key}`);
  const validation = {
    preparationFiles: Array.isArray(value.validation.preparationFiles)
      ? value.validation.preparationFiles.map((item, index) => normalizeValidationFile(item, `archive validation.preparationFiles[${index}]`))
      : archiveError('archive validation.preparationFiles must be an array'),
    deltaFiles: Array.isArray(value.validation.deltaFiles)
      ? value.validation.deltaFiles.map((item, index) => normalizeValidationDelta(item, `archive validation.deltaFiles[${index}]`))
      : archiveError('archive validation.deltaFiles must be an array'),
    sliceFiles: Array.isArray(value.validation.sliceFiles)
      ? value.validation.sliceFiles.map((item, index) => normalizeValidationSlice(item, `archive validation.sliceFiles[${index}]`))
      : archiveError('archive validation.sliceFiles must be an array'),
    requirementIds: Array.isArray(value.validation.requirementIds)
      ? value.validation.requirementIds.map((id, index) => requireSlug(id, `archive validation.requirementIds[${index}]`))
      : archiveError('archive validation.requirementIds must be an array'),
  };
  if (validation.preparationFiles.length === 0 || validation.deltaFiles.length === 0 || validation.sliceFiles.length === 0 || validation.requirementIds.length === 0) {
    archiveError('archive validation records must be nonempty');
  }
  if (new Set(validation.requirementIds).size !== validation.requirementIds.length) archiveError('archive validation.requirementIds contains duplicates');
  if (new Set(validation.deltaFiles.map((item) => item.path)).size !== validation.deltaFiles.length) archiveError('archive validation.deltaFiles contains duplicates');
  if (new Set(validation.sliceFiles.map((item) => item.path)).size !== validation.sliceFiles.length) archiveError('archive validation.sliceFiles contains duplicates');
  const acceptance = value.acceptance;
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) archiveError('archive manifest.acceptance must be an object');
  assertExactKeys(acceptance, ARCHIVE_ACCEPTANCE_KEYS, 'ARCHIVE_INVALID', 'archive manifest.acceptance');
  for (const key of ARCHIVE_ACCEPTANCE_KEYS) if (!Object.hasOwn(acceptance, key)) archiveError(`archive manifest.acceptance is missing ${key}`);
  requireText(acceptance.eventId, 'archive acceptance.eventId');
  if (typeof acceptance.timestamp !== 'string' || !Number.isFinite(new Date(acceptance.timestamp).getTime())) archiveError('archive acceptance.timestamp must be an ISO timestamp');
  requireText(acceptance.by, 'archive acceptance.by');
  requireText(acceptance.reason, 'archive acceptance.reason');
  archiveRelativePath(acceptance.eventPath, 'archive acceptance.eventPath');
  requireDigest(acceptance.eventSha256, 'archive acceptance.eventSha256');
  requireDigest(acceptance.reportSha256, 'archive acceptance.reportSha256');
  if (!Array.isArray(acceptance.membership)) archiveError('archive acceptance.membership must be an array');
  for (const member of acceptance.membership) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) archiveError('archive acceptance membership entry must be an object');
    assertExactKeys(member, ARCHIVE_MEMBER_KEYS, 'ARCHIVE_INVALID', 'archive acceptance membership entry');
    if (typeof member.id !== 'string' || typeof member.retired !== 'boolean') archiveError('archive acceptance membership entry is malformed');
  }
  if (!acceptance.activeAcceptanceDigests || typeof acceptance.activeAcceptanceDigests !== 'object' || Array.isArray(acceptance.activeAcceptanceDigests)) archiveError('archive acceptance activeAcceptanceDigests must be an object');
  for (const digest of Object.values(acceptance.activeAcceptanceDigests)) requireDigest(digest, 'archive acceptance task digest');
  if (!acceptance.integration || typeof acceptance.integration !== 'object' || Array.isArray(acceptance.integration)) archiveError('archive acceptance integration is missing');
  if (acceptance.integration.status !== 'passed') archiveError('archive acceptance integration is not passed');
  for (const field of ['proofPath', 'resultPath', 'proofSha256', 'resultSha256', 'commandSha256', 'configSha256', 'candidateSha256', 'dependenciesSha256']) {
    if (typeof acceptance.integration[field] !== 'string' || !DIGEST.test(acceptance.integration[field]) && field.endsWith('Sha256')) archiveError(`archive acceptance integration.${field} is malformed`);
  }
  if (!acceptance.freshness || typeof acceptance.freshness !== 'object' || Array.isArray(acceptance.freshness)) archiveError('archive acceptance freshness is missing');
  assertExactKeys(acceptance.freshness, ['stale', 'eligible', 'integrationFresh'], 'ARCHIVE_INVALID', 'archive acceptance freshness');
  if (acceptance.freshness.stale !== false || acceptance.freshness.eligible !== true || acceptance.freshness.integrationFresh !== true) archiveError('archive acceptance freshness is not current');
  if (!Array.isArray(value.specs) || value.specs.length === 0) archiveError('archive manifest.specs must be nonempty');
  const specs = value.specs.map((spec, index) => {
    const label = `archive manifest.specs[${index}]`;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) archiveError(`${label} must be an object`);
    assertExactKeys(spec, ARCHIVE_SPEC_KEYS, 'ARCHIVE_INVALID', label);
    for (const key of ARCHIVE_SPEC_KEYS) if (!Object.hasOwn(spec, key)) archiveError(`${label} is missing ${key}`);
    requirePath(spec.spec, `${label}.spec`);
    requireDigest(spec.baseSha256, `${label}.baseSha256`, { nullable: true });
    if (!Array.isArray(spec.requirementIds) || spec.requirementIds.length === 0 || spec.requirementIds.some((id) => typeof id !== 'string')) archiveError(`${label}.requirementIds must be nonempty strings`);
    for (const id of spec.requirementIds) requireSlug(id, `${label}.requirementIds`);
    const before = normalizeArchiveRecord(spec.before, `${label}.before`);
    const after = normalizeArchiveRecord(spec.after, `${label}.after`);
    if (before.sourcePath !== spec.spec || after.sourcePath !== spec.spec) archiveError(`${label} before/after source paths must match the spec`);
    if (before.archivePath !== archiveSpecPath('specs', spec.spec, 'before') || after.archivePath !== archiveSpecPath('specs', spec.spec, 'after')) {
      archiveError(`${label} before/after archive paths are not canonical`);
    }
    return { ...spec, before, after };
  });
  const seenSpecs = new Set();
  for (const spec of specs) {
    if (seenSpecs.has(spec.spec)) archiveError(`archive manifest repeats spec: ${spec.spec}`);
    seenSpecs.add(spec.spec);
  }
  if (!Array.isArray(value.files)) archiveError('archive manifest.files must be an array');
  const files = value.files.map((file, index) => normalizeArchiveRecord(file, `archive manifest.files[${index}]`));
  const allRecords = [...files, ...specs.flatMap((spec) => [spec.before, spec.after])];
  const recordsByArchive = new Map();
  for (const record of allRecords) {
    const prior = recordsByArchive.get(record.archivePath);
    if (prior && (prior.bytes !== record.bytes || prior.sha256 !== record.sha256 || prior.sourcePath !== record.sourcePath)) {
      archiveError(`archive records disagree for ${record.archivePath}`);
    }
    recordsByArchive.set(record.archivePath, record);
  }
  for (const input of [inputs.change, inputs.draft]) {
    const record = recordsByArchive.get(input.archivePath);
    if (!record || record.sourcePath !== input.path || record.bytes !== input.bytes || record.sha256 !== input.sha256) {
      archiveError(`archive input is not retained in files: ${input.path}`);
    }
  }
  return { ...value, inputs, validation, acceptance: { ...acceptance }, specs, files };
}

async function verifyArchiveFiles(archiveDir, manifest) {
  let total = 0;
  const records = [
    ...manifest.files,
    ...manifest.specs.flatMap((spec) => [spec.before, spec.after]),
  ];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.archivePath)) continue;
    seen.add(record.archivePath);
    const target = join(archiveDir, ...record.archivePath.split('/'));
    await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false });
    const info = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') archiveError(`archive file is missing: ${record.archivePath}`);
      throw error;
    });
    if (info.isSymbolicLink() || !info.isFile()) archiveError(`archive file is not regular: ${record.archivePath}`);
    if (info.size !== record.bytes || info.size > MAX_ARCHIVE_FILE_BYTES) archiveError(`archive file size changed: ${record.archivePath}`);
    const content = await readFile(target);
    total += content.length;
    if (total > MAX_ARCHIVE_TOTAL_BYTES) archiveError(`archive exceeds ${MAX_ARCHIVE_TOTAL_BYTES} bytes`);
    if (sha256(content) !== record.sha256) archiveError(`archive file digest changed: ${record.archivePath}`);
  }
}

async function readExistingArchive(archiveDir) {
  const manifestPath = join(archiveDir, 'manifest.json');
  await assertNoSymlinkPath(manifestPath, { allowMissing: false, requireDirectory: false });
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) archiveError(`archive manifest is not a regular file: ${archiveDir}`);
  if (info.size > MAX_ARCHIVE_FILE_BYTES) archiveError('archive manifest exceeds its size limit');
  const manifest = parseArchiveManifest(parseArchiveJson(await readFile(manifestPath, 'utf8'), 'archive manifest'));
  await verifyArchiveFiles(archiveDir, manifest);
  return manifest;
}

function recordForSource(manifest, sourcePath, label) {
  const records = manifest.files.filter((record) => record.sourcePath === sourcePath);
  if (records.length !== 1) archiveError(`${label} must have exactly one retained source record: ${sourcePath}`);
  return records[0];
}

async function readArchiveRecord(archiveDir, record, label = record.archivePath) {
  const target = join(archiveDir, ...record.archivePath.split('/'));
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false });
  const info = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') archiveError(`archive file is missing: ${record.archivePath}`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) archiveError(`${label} is not a regular archive file`);
  if (info.size !== record.bytes || info.size > MAX_ARCHIVE_FILE_BYTES) archiveError(`${label} size changed`);
  const content = await readFile(target);
  if (sha256(content) !== record.sha256) archiveError(`${label} digest changed`);
  return content.toString('utf8');
}

function parseArchiveJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    archiveError(`${label} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compareRecord(expected, actual, label) {
  if (!actual || (actual.exists !== undefined && actual.exists !== true) || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    archiveError(`${label} changed`, { path: expected.path, expected, actual });
  }
}

async function validateArchivedDerivation(archiveDir, manifest) {
  const eventRecord = manifest.files.find((record) => record.archivePath === manifest.acceptance.eventPath);
  if (!eventRecord) archiveError('archive acceptance event is not retained');
  const eventText = await readArchiveRecord(archiveDir, eventRecord, 'feature acceptance event');
  if (sha256(eventText) !== manifest.acceptance.eventSha256) archiveError('archive acceptance event digest does not match manifest');
  const event = normalizeFeatureEvent(parseArchiveJson(eventText, 'feature acceptance event'));
  if (event.id !== manifest.acceptance.eventId || event.feature !== manifest.changeId
    || stableStringify(event.membership) !== stableStringify(manifest.acceptance.membership)
    || stableStringify(event.activeAcceptanceDigests) !== stableStringify(manifest.acceptance.activeAcceptanceDigests)
    || stableStringify(event.integration) !== stableStringify(manifest.acceptance.integration)
    || sha256(JSON.stringify(event.report)) !== manifest.acceptance.reportSha256) {
    archiveError('archive acceptance event does not match manifest');
  }
  const ledgerRecord = manifest.files.find((record) => record.archivePath === 'evidence/feature-events.jsonl');
  if (!ledgerRecord) archiveError('archive feature event ledger is not retained');
  const ledgerText = await readArchiveRecord(archiveDir, ledgerRecord, 'feature event ledger');
  const ledgerEvents = ledgerText.trim().length === 0
    ? []
    : ledgerText.trimEnd().split('\n').map((line, index) => normalizeFeatureEvent(parseArchiveJson(line, `feature event ledger line ${index + 1}`)));
  const ledgerEvent = ledgerEvents.find((item) => item.id === event.id);
  if (!ledgerEvent || stableStringify(ledgerEvent) !== stableStringify(event)) archiveError('archive event ledger does not retain the accepted event');
  for (const [field, digestField] of [['proofPath', 'proofSha256'], ['resultPath', 'resultSha256']]) {
    const integrationRecord = manifest.files.find((record) => record.sourcePath === event.integration[field]);
    if (!integrationRecord || integrationRecord.sha256 !== event.integration[digestField]) {
      archiveError(`archive integration evidence is not retained: ${event.integration[field]}`);
    }
  }
  for (const reference of event.report.provenance.runReferences) {
    const prefix = `evidence/runs/${reference.runId}/`;
    if (!manifest.files.some((record) => record.archivePath.startsWith(prefix))) {
      archiveError(`archive is missing accepted run evidence: ${reference.runId}`);
    }
  }
  const controllerRecord = manifest.files.find((record) => record.archivePath === 'evidence/controller.json');
  if (!controllerRecord) archiveError('archive controller state is not retained');
  const controller = parseArchiveJson(await readArchiveRecord(archiveDir, controllerRecord, 'archived controller state'), 'archived controller state');
  const syntheticSpecArchives = new Set(manifest.specs.flatMap((spec) => [spec.before.archivePath, spec.after.archivePath]));
  for (const preparation of manifest.validation.preparationFiles) {
    const records = manifest.files.filter((record) => record.sourcePath === preparation.path);
    if (!preparation.exists) {
      if (records.some((record) => !syntheticSpecArchives.has(record.archivePath))) {
        archiveError(`archive retained a file marked absent: ${preparation.path}`);
      }
    } else if (!records.some((record) => record.bytes === preparation.bytes && record.sha256 === preparation.sha256)) {
      archiveError(`archive does not retain validated preparation bytes: ${preparation.path}`);
    }
  }
  const expectedPreparation = manifest.validation.preparationFiles.map((item) => item.exists
    ? { path: item.path, exists: true, bytes: item.bytes, sha256: item.sha256 }
    : { path: item.path, exists: false });
  const expectedTaskIds = manifest.validation.sliceFiles.map((slice) => slice.id);
  for (const taskId of expectedTaskIds) {
    const task = controller.tasks?.[taskId];
    if (!task || task.feature !== manifest.changeId || stableStringify(task.preparation ?? []) !== stableStringify(expectedPreparation)) {
      archiveError(`archived controller task does not retain validated preparation: ${taskId}`);
    }
    for (const runId of [task.applied?.runId, task.applied?.rootRunId].filter((value) => typeof value === 'string')) {
      const prefix = `evidence/runs/${runId}/`;
      if (!manifest.files.some((record) => record.archivePath.startsWith(prefix))) archiveError(`archive is missing applied run evidence: ${runId}`);
    }
  }

  const changeText = await readArchiveRecord(archiveDir, manifest.inputs.change, 'archived change descriptor');
  const change = parseChangeDocument(changeText);
  if (change.id !== manifest.changeId || stableStringify(change.specDeltas) !== stableStringify(manifest.validation.deltaFiles.map((item) => item.path))
    || stableStringify(change.slices) !== stableStringify(manifest.validation.sliceFiles.map((item) => item.path))) {
    archiveError('archived change descriptor does not match validation records');
  }
  const draftText = await readArchiveRecord(archiveDir, manifest.inputs.draft, 'archived merge draft');
  const draft = parseMergeDraft(draftText);
  if (draft.changeId !== manifest.changeId) archiveError('archived merge draft does not match the change');
  const expectedRequirementIds = [];
  const deltasBySpec = new Map();
  for (const [index, descriptor] of manifest.validation.deltaFiles.entries()) {
    const record = recordForSource(manifest, descriptor.path, `validation delta ${index + 1}`);
    if (record.sha256 !== descriptor.sha256) archiveError(`archived delta digest does not match validation record: ${descriptor.path}`);
    const delta = parseDeltaDocument(await readArchiveRecord(archiveDir, record, descriptor.path));
    if (delta.spec !== descriptor.spec || delta.baseSha256 !== descriptor.baseSha256 || delta.changes.map((item) => item.id).join('\0') !== descriptor.requirementIds.join('\0')) {
      archiveError(`archived delta does not match validation record: ${descriptor.path}`);
    }
    if (!deltasBySpec.has(delta.spec)) deltasBySpec.set(delta.spec, { spec: delta.spec, baseSha256: delta.baseSha256, changes: [] });
    const group = deltasBySpec.get(delta.spec);
    if (group.baseSha256 !== delta.baseSha256) archiveError(`archived deltas disagree on base: ${delta.spec}`);
    for (const changeEntry of delta.changes) {
      if (group.changes.some((existing) => existing.id === changeEntry.id)) archiveError(`archived deltas repeat requirement: ${changeEntry.id}`);
      group.changes.push(changeEntry);
      expectedRequirementIds.push(changeEntry.id);
    }
  }
  for (const descriptor of manifest.validation.sliceFiles) {
    const record = recordForSource(manifest, descriptor.path, `validation slice ${descriptor.id}`);
    if (record.sha256 !== descriptor.sha256) archiveError(`archived slice digest does not match validation record: ${descriptor.path}`);
    const slice = parseSliceDocument(await readArchiveRecord(archiveDir, record, descriptor.path));
    if (slice.id !== descriptor.id) archiveError(`archived slice does not match validation record: ${descriptor.path}`);
  }
  if (stableStringify([...new Set(expectedRequirementIds)].sort()) !== stableStringify(manifest.validation.requirementIds.slice().sort())) {
    archiveError('archived requirement ids do not match the delta graph');
  }
  const deltaSpecPaths = [...deltasBySpec.keys()].sort();
  if (stableStringify(draft.specs.map((spec) => spec.spec).sort()) !== stableStringify(deltaSpecPaths)) {
    archiveError('archived merge draft specs do not match the delta graph');
  }
  if (new Set(manifest.specs.map((spec) => spec.spec)).size !== deltasBySpec.size) archiveError('archived specs do not match delta specs');
  for (const [specPath, group] of deltasBySpec) {
    const manifestSpec = manifest.specs.find((item) => item.spec === specPath);
    const draftSpec = draft.specs.find((item) => item.spec === specPath);
    if (!manifestSpec || !draftSpec || draftSpec.baseSha256 !== group.baseSha256) archiveError(`archived merge mapping is missing ${specPath}`);
    const beforeText = await readArchiveRecord(archiveDir, manifestSpec.before, `${specPath} before spec`);
    const afterText = await readArchiveRecord(archiveDir, manifestSpec.after, `${specPath} after spec`);
    const expectedBaseSha = group.baseSha256 === null ? sha256('') : sha256(beforeText);
    if (expectedBaseSha !== (group.baseSha256 ?? sha256(''))) archiveError(`archived before spec does not match delta base: ${specPath}`);
    const merged = mergeSpecText(beforeText, group.changes, draftSpec);
    if (merged.text !== afterText || merged.sha256 !== manifestSpec.after.sha256 || manifestSpec.baseSha256 !== group.baseSha256
      || stableStringify(manifestSpec.requirementIds.slice().sort()) !== stableStringify(group.changes.map((item) => item.id).sort())) {
      archiveError(`archived merged spec is not a deterministic delta result: ${specPath}`);
    }
  }
  return event;
}

async function verifyLiveInputs(root, manifest) {
  const change = await readBounded(root, manifest.sourceChangePath, { label: 'archive source change descriptor' });
  const draft = await readBounded(root, manifest.draftPath, { label: 'archive source merge draft' });
  compareRecord(manifest.inputs.change, change, 'archive source change descriptor');
  compareRecord(manifest.inputs.draft, draft, 'archive source merge draft');
  const specPaths = new Set(manifest.specs.map((item) => item.spec));
  for (const expected of manifest.validation.preparationFiles) {
    if (specPaths.has(expected.path) || expected.path === manifest.sourceChangePath || expected.path === manifest.draftPath) continue;
    const current = await readBounded(root, expected.path, { allowMissing: true, label: `archive preparation ${expected.path}` });
    if (!expected.exists) {
      if (current) archiveError(`archive preparation appeared after archival: ${expected.path}`);
    } else {
      compareRecord(expected, current, `archive preparation ${expected.path}`);
    }
  }
  const currentChange = parseChangeDocument(change.text);
  const currentDraft = parseMergeDraft(draft.text);
  if (currentChange.id !== manifest.changeId || currentDraft.changeId !== manifest.changeId) archiveError('requested archive inputs belong to another change');
  return { change: currentChange, draft: currentDraft };
}

function archiveSpecPath(prefix, spec, kind) {
  return `${prefix}/${kind}/${spec}`;
}

async function preparePlan(root, changePath, draftPath) {
  const validation = await validateChange(root, changePath);
  if (!validation.readiness?.ready) {
    invalid('change preparation is not ready for archival', { issues: validation.readiness?.issues ?? [] });
  }
  const changeFile = await readBounded(root, changePath, { label: 'change descriptor' });
  const change = parseChangeDocument(changeFile.text);
  const draftFile = await readBounded(root, draftPath, { label: 'merge draft' });
  const draft = parseMergeDraft(draftFile.text);
  if (draft.changeId !== change.id) invalid(`merge draft changeId does not match change: ${change.id}`);
  const bySpec = new Map();
  for (const deltaPath of change.specDeltas) {
    const file = await readBounded(root, deltaPath, { label: `delta descriptor ${deltaPath}` });
    const delta = parseDeltaDocument(file.text);
    if (!bySpec.has(delta.spec)) bySpec.set(delta.spec, { spec: delta.spec, baseSha256: delta.baseSha256, changes: [], deltaPaths: [], deltaFiles: [] });
    const group = bySpec.get(delta.spec);
    if (group.baseSha256 !== delta.baseSha256) conflict(`deltas for ${delta.spec} use different base digests`);
    for (const changeEntry of delta.changes) {
      if (group.changes.some((existing) => existing.id === changeEntry.id)) conflict(`requirement id is repeated for ${changeEntry.id}`);
      group.changes.push(changeEntry);
    }
    group.deltaPaths.push(deltaPath);
    group.deltaFiles.push(file);
  }
  if (bySpec.size !== draft.specs.length || [...bySpec.keys()].some((spec) => !draft.specs.some((entry) => entry.spec === spec))) {
    invalid('merge draft specs do not match the change deltas');
  }
  const specs = [];
  for (const draftSpec of draft.specs) {
    const group = bySpec.get(draftSpec.spec);
    if (draftSpec.baseSha256 !== group.baseSha256) conflict(`merge draft base digest does not match delta for ${draftSpec.spec}`);
    const current = await readBounded(root, group.spec, { allowMissing: group.baseSha256 === null, label: `spec ${group.spec}` });
    if (group.baseSha256 === null) {
      if (current) conflict(`new spec already exists: ${group.spec}`);
      const merged = mergeSpecText('', group.changes, draftSpec);
      specs.push({ ...group, draft: draftSpec, before: null, current: null, merged });
    } else {
      if (!current) conflict(`spec base is missing: ${group.spec}`);
      if (current.sha256 !== group.baseSha256) conflict(`spec base digest does not match ${group.spec}`, { expected: group.baseSha256, actual: current.sha256 });
      const merged = mergeSpecText(current.text, group.changes, draftSpec);
      specs.push({ ...group, draft: draftSpec, before: current, current, merged });
    }
  }
  return { changeFile, draftFile, draft, change, specs, validation };
}

function archiveValidation(validation) {
  return {
    preparationFiles: validation.preparationFiles.map((file) => ({
      path: file.path,
      exists: file.exists,
      bytes: file.exists ? file.bytes : null,
      sha256: file.exists ? file.sha256 : null,
    })),
    deltaFiles: validation.deltas.map((delta) => ({
      path: delta.descriptor,
      spec: delta.value.spec,
      baseSha256: delta.value.baseSha256,
      sha256: delta.file.sha256,
      requirementIds: delta.value.changes.map((change) => change.id),
    })),
    sliceFiles: validation.slices.map((slice) => ({
      path: slice.descriptor,
      id: slice.value.id,
      sha256: slice.descriptorFile.sha256,
    })),
    requirementIds: [...validation.requirementMap.keys()].sort(),
  };
}

async function archivePathFor(root, projectPath, changeId, supplied) {
  const path = supplied === undefined ? `${DEFAULT_ARCHIVE_PREFIX}/${changeId}` : requirePath(supplied, 'archivePath');
  const resolved = await resolveProjectPath(root, path, { allowMissing: true });
  return { path, absolute: resolved.absolutePath };
}

function draftPathFor(changePath, supplied) {
  if (supplied !== undefined) return requirePath(supplied, 'draftPath');
  const directory = dirname(changePath).split(sep).join('/');
  return directory === '.' ? DEFAULT_MERGE_DRAFT_NAME : `${directory}/${DEFAULT_MERGE_DRAFT_NAME}`;
}

function ensureArchiveSeparate(changeDir, archivePath) {
  if (changeDir === '.') archiveError('change descriptor must be inside a source change directory');
  const changeRoot = changeDir.endsWith('/') ? changeDir : `${changeDir}/`;
  if (archivePath === changeDir || archivePath.startsWith(changeRoot)) archiveError('archivePath must be outside the source change directory');
}

function eventRunIds(event, state) {
  const ids = new Set();
  for (const ref of event.report?.provenance?.runReferences ?? []) if (typeof ref.runId === 'string') ids.add(ref.runId);
  for (const task of Object.values(state?.tasks ?? {})) {
    if (task?.feature !== event.feature) continue;
    if (typeof task.applied?.runId === 'string') ids.add(task.applied.runId);
    if (typeof task.applied?.rootRunId === 'string') ids.add(task.applied.rootRunId);
  }
  return [...ids].sort();
}

async function loadControllerState(root) {
  const path = '.tinysdd/runs/controller.json';
  const absolute = await assertNoSymlinkPath(join(root, ...path.split('/')), { allowMissing: true, requireDirectory: false });
  const info = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { path, value: null, text: null };
  if (!info.isFile() || info.isSymbolicLink()) archiveError('controller state must be a regular file');
  const text = await readFile(absolute, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    archiveError('controller state is malformed JSON');
  }
  return { path, value, text };
}

async function stageArchive(root, archiveDir, plan, featureState, options) {
  // Keep the pending snapshot under .tinysdd: integration candidate snapshots
  // intentionally exclude operator/runtime evidence, so staging must not make
  // a fresh accepted feature appear stale before the final acceptance check.
  const temporary = join(root, '.tinysdd', 'runs', `archive-pending-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await rm(temporary, { recursive: true, force: true });
  await ensureDirectory(temporary);
  const records = [];
  const total = { bytes: 0 };
  try {
    const controller = await loadControllerState(root);
    const changeDir = dirname(join(root, ...plan.changePath.split('/')));
    const changePrefix = dirname(plan.changePath).split(sep).join('/') === '.'
      ? ''
      : dirname(plan.changePath).split(sep).join('/');
    await copyTreeInto(changeDir, join(temporary, 'change'), changePrefix, 'change', records, total);
    if (!records.some((record) => record.sourcePath === plan.draftPath)) {
      await copyInternalFile(root, plan.draftPath, join(temporary, 'merge', DEFAULT_MERGE_DRAFT_NAME), `merge/${DEFAULT_MERGE_DRAFT_NAME}`, records, total);
    }
    const changeRecord = records.find((record) => record.sourcePath === plan.changePath);
    const draftRecord = records.find((record) => record.sourcePath === plan.draftPath);
    if (!changeRecord || !draftRecord) archiveError('archive inputs were not retained in the staged change snapshot');
    const mergedSpecPaths = new Set(plan.specs.map((spec) => spec.spec));
    for (const preparation of plan.validation.preparationFiles) {
      if (!preparation.exists || mergedSpecPaths.has(preparation.path) || records.some((record) => record.sourcePath === preparation.path)) continue;
      await copyInternalFile(
        root,
        preparation.path,
        join(temporary, 'inputs', ...preparation.path.split('/')),
        `inputs/${preparation.path}`,
        records,
        total,
      );
    }
    for (const spec of plan.specs) {
      const beforePath = archiveSpecPath('specs', spec.spec, 'before');
      const afterPath = archiveSpecPath('specs', spec.spec, 'after');
      const beforeTarget = join(temporary, beforePath.split('/').join(sep));
      const afterTarget = join(temporary, afterPath.split('/').join(sep));
      const beforeText = spec.before?.text ?? '';
      await writeStagedFile(beforeTarget, beforeText);
      await writeStagedFile(afterTarget, spec.merged.text);
      const beforeRecord = { sourcePath: spec.spec, archivePath: beforePath, bytes: Buffer.byteLength(beforeText), sha256: sha256(beforeText) };
      const afterRecord = { sourcePath: spec.spec, archivePath: afterPath, bytes: spec.merged.bytes, sha256: spec.merged.sha256 };
      records.push(beforeRecord, afterRecord);
      total.bytes += beforeRecord.bytes + afterRecord.bytes;
      if (total.bytes > MAX_ARCHIVE_TOTAL_BYTES) archiveError(`archive exceeds ${MAX_ARCHIVE_TOTAL_BYTES} bytes`);
    }

    const acceptance = featureState.acceptance;
    const eventText = JSON.stringify(acceptance);
    await writeStagedFile(join(temporary, 'evidence', 'feature-acceptance.json'), eventText);
    const acceptanceRecord = { sourcePath: '.tinysdd/runs/feature-events.jsonl', archivePath: 'evidence/feature-acceptance.json', bytes: Buffer.byteLength(eventText), sha256: sha256(eventText) };
    records.push(acceptanceRecord);
    total.bytes += acceptanceRecord.bytes;
    const ledgerPath = '.tinysdd/runs/feature-events.jsonl';
    const ledgerTarget = join(temporary, 'evidence', 'feature-events.jsonl');
    const ledgerAbsolute = await assertNoSymlinkPath(join(root, ...ledgerPath.split('/')), { allowMissing: true, requireDirectory: false });
    const ledgerInfo = await lstat(ledgerAbsolute).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!ledgerInfo || !ledgerInfo.isFile() || ledgerInfo.isSymbolicLink()) archiveError('feature acceptance ledger is missing or unsafe');
    await copyInternalFile(root, ledgerPath, ledgerTarget, 'evidence/feature-events.jsonl', records, total);
    if (controller.text !== null) {
      await copyInternalFile(root, controller.path, join(temporary, 'evidence', 'controller.json'), 'evidence/controller.json', records, total);
    }
    const state = controller.value;
    for (const runId of eventRunIds(acceptance, state)) {
      const runPath = `.tinysdd/runs/${runId}`;
      const runAbsolute = await assertNoSymlinkPath(join(root, ...runPath.split('/')), { allowMissing: true, requireDirectory: true });
      const runInfo = await lstat(runAbsolute).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!runInfo) archiveError(`accepted run evidence is missing: ${runId}`);
      await copyTreeInto(runAbsolute, join(temporary, 'evidence', 'runs', runId), runPath, `evidence/runs/${runId}`, records, total);
    }
    const integration = acceptance.integration;
    const proofPath = integration.proofPath;
    const integrationPrefix = proofPath.slice(0, proofPath.lastIndexOf('/'));
    const integrationAbsolute = await assertNoSymlinkPath(join(root, ...integrationPrefix.split('/')), { allowMissing: true, requireDirectory: true });
    const integrationInfo = await lstat(integrationAbsolute).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!integrationInfo) archiveError(`accepted integration evidence is missing: ${integrationPrefix}`);
    await copyTreeInto(integrationAbsolute, join(temporary, 'evidence', 'feature-integration'), integrationPrefix, 'evidence/feature-integration', records, total);

    const manifest = {
      schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
      type: 'tinysdd-change-archive',
      changeId: plan.change.id,
      sourceChangePath: plan.changePath,
      draftPath: plan.draftPath,
      archivedAt: new Date().toISOString(),
      acceptance: {
        eventId: acceptance.id,
        timestamp: acceptance.timestamp,
        by: acceptance.by,
        reason: acceptance.reason,
        eventPath: 'evidence/feature-acceptance.json',
        eventSha256: sha256(eventText),
        membership: structuredClone(acceptance.membership),
        activeAcceptanceDigests: structuredClone(acceptance.activeAcceptanceDigests),
        reportSha256: reportDigest(acceptance.report),
        integration: structuredClone(acceptance.integration),
        freshness: { stale: false, eligible: true, integrationFresh: true },
      },
      inputs: {
        change: { path: plan.changePath, archivePath: changeRecord.archivePath, bytes: changeRecord.bytes, sha256: changeRecord.sha256 },
        draft: { path: plan.draftPath, archivePath: draftRecord.archivePath, bytes: draftRecord.bytes, sha256: draftRecord.sha256 },
      },
      validation: archiveValidation(plan.validation),
      specs: plan.specs.map((spec) => ({
        spec: spec.spec,
        baseSha256: spec.baseSha256,
        before: records.find((record) => record.archivePath === archiveSpecPath('specs', spec.spec, 'before')),
        after: records.find((record) => record.archivePath === archiveSpecPath('specs', spec.spec, 'after')),
        requirementIds: spec.changes.map((change) => change.id),
      })),
      files: records,
    };
    parseArchiveManifest(manifest);
    await writeStagedFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const stagedManifest = parseArchiveManifest(parseArchiveJson(await readFile(join(temporary, 'manifest.json'), 'utf8'), 'staged archive manifest'));
    await verifyArchiveFiles(temporary, stagedManifest);
    return { manifest: stagedManifest, temporary };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readCurrentSpec(root, spec) {
  const value = await readBounded(root, spec, { allowMissing: true, label: `spec ${spec}` });
  return value;
}

async function applyArchivedSpecs(root, archiveDir, manifest) {
  const pending = [];
  const applied = [];
  for (const spec of manifest.specs) {
    const current = await readCurrentSpec(root, spec.spec);
    const currentSha = current?.sha256 ?? null;
    const beforeSha = spec.baseSha256;
    const afterSha = spec.after.sha256;
    if (currentSha === afterSha) {
      applied.push({ spec: spec.spec, status: 'already-applied', beforeSha256: beforeSha, afterSha256: afterSha });
      continue;
    }
    const canApply = beforeSha === null ? current === null : currentSha === beforeSha;
    if (!canApply) {
      throw tinyError('ARCHIVE_RESULT_CONFLICT', `current spec does not match the archived before or after bytes: ${spec.spec}`, { path: spec.spec, expectedBefore: beforeSha, expectedAfter: afterSha, actual: currentSha });
    }
    const target = await resolveProjectPath(root, spec.spec, { allowMissing: true });
    const afterTarget = join(archiveDir, ...spec.after.archivePath.split('/'));
    await assertNoSymlinkPath(afterTarget, { allowMissing: false, requireDirectory: false });
    const afterText = await readFile(afterTarget, 'utf8');
    if (sha256(afterText) !== afterSha) archiveError(`archived after spec digest changed: ${spec.spec}`);
    pending.push({ spec, target, afterText });
  }
  // All conflict checks happen before the first write. If a later write is
  // interrupted, the committed archive remains the recovery source for the
  // next invocation.
  for (const { spec, target, afterText } of pending) {
    await atomicWriteFile(target.absolutePath, afterText);
    applied.push({ spec: spec.spec, status: 'written', beforeSha256: spec.baseSha256, afterSha256: spec.after.sha256 });
  }
  return applied;
}

/**
 * Archive a change after an explicit current feature acceptance and apply its
 * mechanically validated living-spec merge. The first call creates the
 * immutable archive marker before writing any living spec. Later calls verify
 * that marker and only recover missing spec writes.
 */
export async function archiveChange(projectRootOrOptions, optionsArgument = {}) {
  const options = typeof projectRootOrOptions === 'object' && projectRootOrOptions !== null
    ? projectRootOrOptions
    : { projectRoot: projectRootOrOptions, ...optionsArgument };
  const root = await canonicalProjectRoot(options.projectRoot);
  const changePath = requirePath(options.changePath, 'changePath');
  const draftPath = draftPathFor(changePath, options.draftPath ?? options.mergeDraftPath);
  const sourceChange = await readBounded(root, changePath, { label: 'change descriptor' });
  const declaredChange = parseChangeDocument(sourceChange.text);
  const archiveInfo = await archivePathFor(root, changePath, declaredChange.id, options.archivePath);
  const changeDir = dirname(changePath).split(sep).join('/');
  ensureArchiveSeparate(changeDir, archiveInfo.path);
  const lockPath = join(root, '.tinysdd', 'runs', 'archive.lock');
  return withExclusiveLock(lockPath, async () => {
    const lockedSourceChange = await readBounded(root, changePath, { label: 'change descriptor' });
    if (lockedSourceChange.sha256 !== sourceChange.sha256 || lockedSourceChange.bytes !== sourceChange.bytes) {
      archiveError('change descriptor changed while archive lock was acquired');
    }
    const existingInfo = await lstat(archiveInfo.absolute).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (existingInfo) {
      if (!existingInfo.isDirectory() || existingInfo.isSymbolicLink()) archiveError(`archive path is not a regular directory: ${archiveInfo.path}`);
      const manifest = await readExistingArchive(archiveInfo.absolute);
      if (manifest.changeId !== declaredChange.id || manifest.sourceChangePath !== changePath || manifest.draftPath !== draftPath) {
        archiveError('archive belongs to different requested inputs');
      }
      await verifyLiveInputs(root, manifest);
      await validateArchivedDerivation(archiveInfo.absolute, manifest);
      const applied = await applyArchivedSpecs(root, archiveInfo.absolute, manifest);
      return {
        schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
        changeId: manifest.changeId,
        archivePath: archiveInfo.path,
        manifestPath: `${archiveInfo.path}/manifest.json`,
        alreadyArchived: true,
        acceptanceId: manifest.acceptance.eventId,
        specs: applied,
      };
    }

    const plan = await preparePlan(root, changePath, draftPath);
    plan.changePath = changePath;
    plan.draftPath = draftPath;
    if (options.featureReport !== undefined && process.env.TINYSDD_LIVING_SPEC_TEST !== '1') {
      throw tinyError('FEATURE_ACCEPTANCE_REQUIRED', 'featureReport injection is available only to explicit offline tests');
    }
    const featureReader = options.featureReport ?? reportFeature;
    const controller = await loadControllerState(root);
    const firstState = await featureReader(root, { feature: plan.change.id });
    const firstAcceptance = assertFreshFeatureAcceptance(plan.change.id, firstState);
    assertFeatureScope(plan, firstState, controller.value);
    let staged;
    try {
      staged = await stageArchive(root, archiveInfo.absolute, plan, firstState, options);
      return await withFeatureReport(root, { feature: plan.change.id }, async (secondState) => {
        const secondAcceptance = assertFreshFeatureAcceptance(plan.change.id, secondState);
        if (secondAcceptance.id !== firstAcceptance.id || acceptanceDigest(secondAcceptance) !== acceptanceDigest(firstAcceptance)) {
          throw tinyError('FEATURE_ACCEPTANCE_STALE', 'feature acceptance changed while archive was being prepared', { first: firstAcceptance.id, current: secondAcceptance.id });
        }
        const finalController = await loadControllerState(root);
        assertFeatureScope(plan, secondState, finalController.value);
        await validateArchivedDerivation(staged.temporary, staged.manifest);
        await ensureDirectory(dirname(archiveInfo.absolute));
        await rename(staged.temporary, archiveInfo.absolute);
        const manifest = staged.manifest;
        const applied = await applyArchivedSpecs(root, archiveInfo.absolute, manifest);
        return {
          schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
          changeId: manifest.changeId,
          archivePath: archiveInfo.path,
          manifestPath: `${archiveInfo.path}/manifest.json`,
          alreadyArchived: false,
          acceptanceId: manifest.acceptance.eventId,
          specs: applied,
        };
      });
    } catch (error) {
      if (staged?.temporary) await rm(staged.temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

export const mergeSpecDelta = mergeSpecText;
export const archiveLivingSpecChange = archiveChange;
