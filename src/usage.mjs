import { appendFile, lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertExactKeys,
  assertInternalPath,
  assertPlainObject,
  canonicalProjectRoot,
  ensureDirectory,
  sha256,
  stableStringify,
  tinyError,
  withExclusiveLock,
} from './fs-utils.mjs';

export const USAGE_SCHEMA_VERSION = 1;
export const USAGE_IMPORT_TYPE = 'usage-import';
export const USAGE_RECORD_TYPE = 'usage';
export const USAGE_PHASES = Object.freeze([
  'specify',
  'research',
  'plan',
  'slice',
  'write-tests',
  'review',
  'rescue',
]);
export const USAGE_LEDGER_RELATIVE_PATH = '.tinysdd/runs/usage.jsonl';
export const USAGE_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const USAGE_RECORD_MAX_BYTES = 64 * 1024;
export const USAGE_MAX_RECORDS = 4096;
export const USAGE_MAX_ID_LENGTH = 128;
export const USAGE_MAX_TEXT_LENGTH = 512;

const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/iu;
const ATTRIBUTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RECORD_KEYS = [
  'schemaVersion',
  'type',
  'id',
  'timestamp',
  'phase',
  'model',
  'taskId',
  'feature',
  'featureId',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'totalTokens',
  'provenance',
];
const PROVENANCE_KEYS = ['source', 'exportId', 'externalRecordId', 'sourceDigest'];
const IMPORT_KEYS = ['schemaVersion', 'type', 'source', 'exportId', 'sourceDigest', 'records'];
const IMPORT_RECORD_KEYS = [
  'schemaVersion',
  'type',
  'id',
  'timestamp',
  'phase',
  'model',
  'taskId',
  'feature',
  'featureId',
  'externalRecordId',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'totalTokens',
  'provenance',
];

function importInvalid(message, details = undefined) {
  throw tinyError('USAGE_IMPORT_INVALID', message, details);
}

function ledgerInvalid(message, details = undefined) {
  throw tinyError('USAGE_LEDGER_INVALID', message, details);
}

function assertObject(value, label, code = 'USAGE_INVALID') {
  try {
    const result = assertPlainObject(value, code, label);
    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) {
      throw tinyError(code, `${label} must be a plain object`);
    }
    return result;
  } catch (error) {
    if (error?.code === code) throw error;
    throw tinyError(code, error instanceof Error ? error.message : `${label} must be an object`);
  }
}

function assertText(value, label, { max = USAGE_MAX_TEXT_LENGTH, pattern = undefined, code = 'USAGE_INVALID' } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) throw tinyError(code, `${label} must be a nonempty string`);
  if (value.length > max) throw tinyError(code, `${label} exceeds ${max} characters`);
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) throw tinyError(code, `${label} contains a control character`);
  if (pattern && !pattern.test(value)) throw tinyError(code, `${label} has an invalid format`);
  return value;
}

function assertImportText(value, label, options = {}) {
  try {
    return assertText(value, label, options);
  } catch (error) {
    if (error?.code === 'USAGE_INVALID') {
      throw tinyError('USAGE_IMPORT_INVALID', error.message, error.details);
    }
    throw error;
  }
}

function normalizeTimestamp(value, label = 'timestamp', code = 'USAGE_INVALID') {
  if (typeof value !== 'string' || value.length === 0) throw tinyError(code, `${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw tinyError(code, `${label} must be an ISO timestamp`);
  return date.toISOString();
}

function normalizeId(value, label, code = 'USAGE_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.length > USAGE_MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw tinyError(code, `${label} must be a stable identifier`);
  }
  return value;
}

function normalizeAttribution(value, label, code = 'USAGE_INVALID') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || !ATTRIBUTION_PATTERN.test(value)) {
    throw tinyError(code, `${label} must use lowercase letters, digits, hyphens, or underscores`);
  }
  return value;
}

function normalizeModel(value, { imported = false, code = 'USAGE_INVALID' } = {}) {
  if (value === undefined || value === null) {
    if (imported) return null;
    throw tinyError(code, 'model is required');
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > USAGE_MAX_TEXT_LENGTH) {
    throw tinyError(code, 'model must be a nonempty string');
  }
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) throw tinyError(code, 'model contains a control character');
  return value;
}

function normalizeToken(value, label, { required = false, code = 'USAGE_INVALID' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw tinyError(code, `${label} must be a nonnegative safe integer`);
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw tinyError(code, `${label} must be a nonnegative safe integer`);
  }
  return value;
}

function tokenValue(input, primary, alias, label, options) {
  if (input[primary] !== undefined && input[alias] !== undefined && input[primary] !== input[alias]) {
    throw tinyError(options.code ?? 'USAGE_INVALID', `${label} has conflicting values`);
  }
  return normalizeToken(input[primary] ?? input[alias], label, options);
}

function optionalDigest(value, label, code = 'USAGE_INVALID') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw tinyError(code, `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function provenanceForRecord(value, { imported = false, source = undefined, exportId = undefined, externalRecordId = undefined, sourceDigest = undefined, code = 'USAGE_INVALID' } = {}) {
  const supplied = value === undefined ? {} : assertObject(value, 'record provenance', code);
  try {
    assertExactKeys(supplied, PROVENANCE_KEYS, code, 'record provenance');
  } catch (error) {
    if (error?.code === code) throw error;
    throw tinyError(code, error instanceof Error ? error.message : 'record provenance has unknown fields');
  }
  const normalizedSource = assertText(source ?? supplied.source ?? (imported ? undefined : 'tinysdd'), 'provenance.source', { code });
  const exportValue = exportId ?? supplied.exportId;
  const externalValue = externalRecordId ?? supplied.externalRecordId;
  const normalizedExportId = exportValue === undefined
    ? undefined
    : normalizeId(exportValue, 'provenance.exportId', code);
  const normalizedExternalId = externalValue === undefined
    ? undefined
    : normalizeId(externalValue, 'provenance.externalRecordId', code);
  const normalizedSourceDigest = optionalDigest(sourceDigest ?? supplied.sourceDigest, 'provenance.sourceDigest', code);
  const result = { source: normalizedSource };
  if (normalizedExportId !== undefined) result.exportId = normalizedExportId;
  if (normalizedExternalId !== undefined) result.externalRecordId = normalizedExternalId;
  if (normalizedSourceDigest !== undefined) result.sourceDigest = normalizedSourceDigest;
  if (imported && (result.exportId === undefined || result.externalRecordId === undefined)) {
    throw tinyError(code, 'imported records require provenance.exportId and provenance.externalRecordId');
  }
  return result;
}

function deterministicImportId(source, exportId, externalRecordId) {
  return `usage-${sha256(stableStringify({ source, exportId, externalRecordId }))}`;
}

function normalizeRecord(input, {
  imported = false,
  source = undefined,
  exportId = undefined,
  sourceDigest = undefined,
  externalRecordId = undefined,
  allowUnknownTokens = imported,
  allowUnknownModel = imported,
  errorCode = 'USAGE_INVALID',
} = {}) {
  const raw = assertObject(input, 'usage record', errorCode);
  if (!imported) {
    try {
      assertExactKeys(raw, [...RECORD_KEYS, 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'total'], errorCode, 'usage record');
    } catch (error) {
      if (error?.code === errorCode) throw error;
      throw tinyError(errorCode, error instanceof Error ? error.message : 'usage record has unknown fields');
    }
  } else {
    try {
      assertExactKeys(raw, IMPORT_RECORD_KEYS, errorCode, 'import record');
    } catch (error) {
      if (error?.code === errorCode) throw error;
      throw tinyError(errorCode, error instanceof Error ? error.message : 'import record has unknown fields');
    }
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== USAGE_SCHEMA_VERSION) {
    throw tinyError(errorCode, `usage record schemaVersion must be ${USAGE_SCHEMA_VERSION}`);
  }
  if (raw.type !== undefined && raw.type !== USAGE_RECORD_TYPE) throw tinyError(errorCode, 'usage record type must be usage');

  const phase = raw.phase;
  if (!USAGE_PHASES.includes(phase)) throw tinyError(errorCode, `phase must be one of ${USAGE_PHASES.join(', ')}`);
  const model = normalizeModel(raw.model, { imported: allowUnknownModel, code: errorCode });
  const taskId = normalizeAttribution(raw.taskId, 'taskId', errorCode);
  const feature = normalizeAttribution(raw.feature ?? raw.featureId, 'feature', errorCode);
  if (taskId === undefined && feature === undefined) throw tinyError(errorCode, 'taskId or feature attribution is required');

  const timestamp = normalizeTimestamp(raw.timestamp ?? new Date().toISOString(), 'timestamp', errorCode);
  const inputTokens = tokenValue(raw, 'input', 'inputTokens', 'input', { required: !allowUnknownTokens, code: errorCode });
  const outputTokens = tokenValue(raw, 'output', 'outputTokens', 'output', { required: !allowUnknownTokens, code: errorCode });
  const reasoning = tokenValue(raw, 'reasoning', 'reasoningTokens', 'reasoning', { code: errorCode });
  const cacheRead = normalizeToken(raw.cacheRead ?? raw.cacheReadTokens, 'cacheRead', { code: errorCode });
  const cacheWrite = normalizeToken(raw.cacheWrite ?? raw.cacheWriteTokens, 'cacheWrite', { code: errorCode });
  const totalTokens = tokenValue(raw, 'totalTokens', 'total', 'totalTokens', { code: errorCode });

  const normalizedSource = source ?? raw.provenance?.source;
  const normalizedExportId = exportId ?? raw.provenance?.exportId;
  const normalizedExternalId = externalRecordId ?? raw.externalRecordId ?? raw.provenance?.externalRecordId;
  const provenance = provenanceForRecord(raw.provenance, {
    imported,
    source: normalizedSource,
    exportId: normalizedExportId,
    externalRecordId: normalizedExternalId,
    sourceDigest: sourceDigest ?? raw.provenance?.sourceDigest,
    code: errorCode,
  });
  const id = raw.id === undefined
    ? (imported ? deterministicImportId(provenance.source, provenance.exportId, provenance.externalRecordId) : `usage-${randomUUID()}`)
    : normalizeId(raw.id, 'id', errorCode);

  const result = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    type: USAGE_RECORD_TYPE,
    id,
    timestamp,
    phase,
    model,
    ...(taskId === undefined ? {} : { taskId }),
    ...(feature === undefined ? {} : { feature }),
    input: inputTokens,
    output: outputTokens,
    ...(reasoning === null ? {} : { reasoning }),
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
    ...(totalTokens === null ? {} : { totalTokens }),
    provenance,
  };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > USAGE_RECORD_MAX_BYTES) throw tinyError(errorCode, `usage record exceeds ${USAGE_RECORD_MAX_BYTES} bytes`);
  return result;
}

export function usageRecord(options) {
  return normalizeRecord(options);
}

export function normalizeUsageRecord(value, options = {}) {
  return normalizeRecord(value, options);
}

export function validateUsageRecord(value, { imported = false } = {}) {
  const raw = assertObject(value, 'usage record', imported ? 'USAGE_IMPORT_INVALID' : 'USAGE_INVALID');
  try {
    assertExactKeys(raw, RECORD_KEYS, imported ? 'USAGE_IMPORT_INVALID' : 'USAGE_INVALID', 'usage record');
  } catch (error) {
    if (error?.code) throw error;
    throw tinyError(imported ? 'USAGE_IMPORT_INVALID' : 'USAGE_INVALID', 'usage record has unknown fields');
  }
  return normalizeRecord(raw, {
    imported: false,
    allowUnknownModel: true,
    allowUnknownTokens: true,
    errorCode: imported ? 'USAGE_IMPORT_INVALID' : 'USAGE_LEDGER_INVALID',
  });
}

function parseImportText(value) {
  if (typeof value !== 'string') return value;
  const bytes = Buffer.byteLength(value);
  if (bytes > USAGE_LEDGER_MAX_BYTES) throw tinyError('USAGE_IMPORT_TOO_LARGE', `usage import exceeds ${USAGE_LEDGER_MAX_BYTES} bytes`);
  try {
    return JSON.parse(value);
  } catch {
    importInvalid('usage import must be valid JSON');
  }
}

export function normalizeUsageImport(input) {
  const raw = parseImportText(input);
  const envelope = assertObject(raw, 'usage import', 'USAGE_IMPORT_INVALID');
  try {
    assertExactKeys(envelope, IMPORT_KEYS, 'USAGE_IMPORT_INVALID', 'usage import');
  } catch (error) {
    if (error?.code === 'USAGE_IMPORT_INVALID') throw error;
    throw tinyError('USAGE_IMPORT_INVALID', error instanceof Error ? error.message : 'usage import has unknown fields');
  }
  if (envelope.schemaVersion !== USAGE_SCHEMA_VERSION) importInvalid(`usage import schemaVersion must be ${USAGE_SCHEMA_VERSION}`);
  if (envelope.type !== undefined && envelope.type !== USAGE_IMPORT_TYPE) importInvalid(`usage import type must be ${USAGE_IMPORT_TYPE}`);
  const source = assertImportText(envelope.source, 'usage import source');
  const exportId = normalizeId(envelope.exportId, 'usage import exportId', 'USAGE_IMPORT_INVALID');
  const sourceDigest = optionalDigest(envelope.sourceDigest, 'usage import sourceDigest', 'USAGE_IMPORT_INVALID');
  if (!Array.isArray(envelope.records) || envelope.records.length === 0) importInvalid('usage import records must be a nonempty array');
  if (envelope.records.length > USAGE_MAX_RECORDS) importInvalid(`usage import contains more than ${USAGE_MAX_RECORDS} records`);

  const records = envelope.records.map((record, index) => {
    const rawRecord = assertObject(record, `usage import records[${index}]`, 'USAGE_IMPORT_INVALID');
    const external = rawRecord.externalRecordId ?? rawRecord.provenance?.externalRecordId;
    if (external === undefined) importInvalid(`usage import records[${index}] requires externalRecordId`);
    return normalizeRecord(rawRecord, {
      imported: true,
      source,
      exportId,
      sourceDigest,
      externalRecordId: external,
      errorCode: 'USAGE_IMPORT_INVALID',
    });
  });
  assertUniqueRecords(records, 'USAGE_IMPORT_INVALID');
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    type: USAGE_IMPORT_TYPE,
    source,
    exportId,
    ...(sourceDigest === undefined ? {} : { sourceDigest }),
    records,
  };
}

function recordKey(record) {
  const external = record.provenance?.externalRecordId;
  if (external !== undefined) return `external:${record.provenance.source}\0${record.provenance.exportId}\0${external}`;
  return `id:${record.id}`;
}

function assertUniqueRecords(records, code = 'USAGE_DUPLICATE') {
  const ids = new Set();
  const keys = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw tinyError(code, `duplicate usage record id: ${record.id}`);
    ids.add(record.id);
    const key = recordKey(record);
    if (keys.has(key)) throw tinyError(code, `duplicate usage provenance: ${record.provenance.externalRecordId}`);
    keys.add(key);
  }
}

async function ledgerInfo(projectRoot, { create = false } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const ledger = await assertInternalPath(root, ['.tinysdd', 'runs', 'usage.jsonl'], { allowMissing: true });
  const lock = await assertInternalPath(root, ['.tinysdd', 'runs', 'usage.lock'], { allowMissing: true });
  if (create) await ensureDirectory(dirname(ledger));
  return { root, ledger, lock };
}

async function readLedgerText(ledger) {
  let info;
  try {
    info = await lstat(ledger);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink usage ledger: ${ledger}`);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `usage ledger must be a regular file: ${ledger}`);
  if (info.size > USAGE_LEDGER_MAX_BYTES) throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage ledger exceeds ${USAGE_LEDGER_MAX_BYTES} bytes`);
  let text;
  try {
    text = await readFile(ledger, 'utf8');
  } catch {
    throw tinyError('FILE_READ_FAILED', `could not read usage ledger: ${ledger}`);
  }
  if (Buffer.byteLength(text) > USAGE_LEDGER_MAX_BYTES) throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage ledger exceeds ${USAGE_LEDGER_MAX_BYTES} bytes`);
  return text;
}

function parseLedgerText(text) {
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) throw tinyError('USAGE_LEDGER_PARTIAL', 'usage ledger has a partial trailing record');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > USAGE_MAX_RECORDS) throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage ledger contains more than ${USAGE_MAX_RECORDS} records`);
  const records = lines.map((line, index) => {
    if (line.length === 0) throw ledgerInvalid(`usage ledger line ${index + 1} is empty`);
    if (Buffer.byteLength(line) > USAGE_RECORD_MAX_BYTES) throw tinyError('USAGE_RECORD_TOO_LARGE', `usage ledger line ${index + 1} exceeds ${USAGE_RECORD_MAX_BYTES} bytes`);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw tinyError('USAGE_LEDGER_PARTIAL', `usage ledger line ${index + 1} is malformed JSON`);
    }
    return validateUsageRecord(parsed);
  });
  assertUniqueRecords(records, 'USAGE_DUPLICATE');
  return records;
}

async function readLedgerRecords(info) {
  return parseLedgerText(await readLedgerText(info.ledger));
}

async function appendNormalizedRecords(info, records) {
  assertUniqueRecords(records, 'USAGE_DUPLICATE');
  return withExclusiveLock(info.lock, async () => {
    await assertInternalPath(info.root, ['.tinysdd', 'runs', 'usage.jsonl'], { allowMissing: true });
    const existing = await readLedgerRecords(info);
    const existingKeys = new Set(existing.map(recordKey));
    for (const record of records) {
      if (existingKeys.has(recordKey(record)) || existing.some((entry) => entry.id === record.id)) {
        throw tinyError('USAGE_DUPLICATE', `usage record already exists: ${record.id}`);
      }
    }
    const lines = records.map((record) => JSON.stringify(record));
    const content = `${lines.join('\n')}\n`;
    const existingBytes = existing.length === 0 ? 0 : Buffer.byteLength(await readLedgerText(info.ledger));
    if (existingBytes + Buffer.byteLength(content) > USAGE_LEDGER_MAX_BYTES) {
      throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage ledger exceeds ${USAGE_LEDGER_MAX_BYTES} bytes`);
    }
    if (existing.length + records.length > USAGE_MAX_RECORDS) {
      throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage ledger contains more than ${USAGE_MAX_RECORDS} records`);
    }
    try {
      await appendFile(info.ledger, content, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw tinyError('USAGE_LEDGER_WRITE_FAILED', `could not append usage ledger: ${info.ledger}`);
    }
    return records;
  });
}

export async function appendUsageRecords(projectRoot, records) {
  if (!Array.isArray(records) || records.length === 0) throw tinyError('USAGE_INVALID', 'usage records must be a nonempty array');
  if (records.length > USAGE_MAX_RECORDS) throw tinyError('USAGE_LEDGER_TOO_LARGE', `usage append contains more than ${USAGE_MAX_RECORDS} records`);
  const normalized = records.map((record) => {
    if (record?.schemaVersion === USAGE_SCHEMA_VERSION && record?.type === USAGE_RECORD_TYPE) return validateUsageRecord(record, { imported: true });
    return usageRecord(record);
  });
  const info = await ledgerInfo(projectRoot, { create: true });
  return appendNormalizedRecords(info, normalized);
}

export async function appendUsageRecord(projectRoot, record) {
  const records = await appendUsageRecords(projectRoot, [record]);
  return records[0];
}

export async function readUsageRecords(projectRoot) {
  const info = await ledgerInfo(projectRoot);
  return withExclusiveLock(info.lock, async () => readLedgerRecords(info));
}

export async function importUsageRecords(projectRoot, input) {
  const normalizedImport = normalizeUsageImport(input);
  const info = await ledgerInfo(projectRoot, { create: true });
  return appendNormalizedRecords(info, normalizedImport.records);
}

export const readUsageLedger = readUsageRecords;
export const importUsageExport = importUsageRecords;
