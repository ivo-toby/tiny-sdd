import { lstat, open } from 'node:fs/promises';

import {
  assertExactKeys,
  assertPlainObject,
  normalizeProjectRelative,
  resolveProjectPath,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import { isSecretPath } from './file-scope.mjs';

export const CONSTITUTION_SCHEMA_VERSION = 1;
export const MAX_CONSTITUTION_FILE_BYTES = 512 * 1024;
export const DEFAULT_CONSTITUTION_PATH = 'specs/constitution.md';
export const DEFAULT_CONSTITUTION_APPROVAL_PATH = 'specs/constitution.approval.json';

const REFERENCE_KEYS = ['path', 'approval'];
const APPROVAL_KEYS = [
  'schemaVersion',
  'version',
  'ratifiedAt',
  'amendedAt',
  'approvedAt',
  'by',
  'reason',
  'contentSha256',
];
const DIGEST = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

function invalid(message, details = undefined) {
  throw tinyError('CONSTITUTION_INVALID', message, details);
}

function approvalInvalid(message, details = undefined) {
  throw tinyError('CONSTITUTION_APPROVAL_INVALID', message, details);
}

function requireText(value, label, { maxBytes = 512 * 1024, allowEmpty = false, code = 'CONSTITUTION_INVALID' } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw tinyError(code, `${label} must be nonempty text`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw tinyError(code, `${label} exceeds its bounded size`, { bytes: Buffer.byteLength(value), limit: maxBytes });
  }
  return value;
}

function constitutionPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/')) {
    invalid(`${label} must be a project-relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    invalid(`${label} contains traversal or an empty path component`);
  }
  let normalized;
  try {
    normalized = normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { path: value });
  }
  if (normalized !== value) invalid(`${label} is not normalized`, { path: value });
  if (isSecretPath(normalized)) {
    throw tinyError('CONSTITUTION_CREDENTIAL_PATH', `${label} names a credential or secret path: ${normalized}`, { path: normalized });
  }
  return normalized;
}

function timestamp(value, label) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(value))) {
    approvalInvalid(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3) || 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== milliseconds) {
    approvalInvalid(`${label} must name a real UTC date and time`);
  }
  return value;
}

/** Parse the optional change-level reference without reading project files. */
export function parseConstitutionReference(value) {
  assertPlainObject(value, 'CONSTITUTION_INVALID', 'change.constitution');
  assertExactKeys(value, REFERENCE_KEYS, 'CONSTITUTION_INVALID', 'change.constitution');
  const path = constitutionPath(value.path === undefined ? DEFAULT_CONSTITUTION_PATH : value.path, 'change.constitution.path');
  const approval = constitutionPath(value.approval === undefined ? DEFAULT_CONSTITUTION_APPROVAL_PATH : value.approval, 'change.constitution.approval');
  if (path === approval) invalid('change.constitution.path and approval must be different files');
  return { path, approval };
}

/** Parse and validate the operator record's exact identity fields. */
export function parseConstitutionApproval(text) {
  if (typeof text !== 'string') approvalInvalid('constitution approval must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    approvalInvalid(`constitution approval is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, 'CONSTITUTION_APPROVAL_INVALID', 'constitution approval');
  assertExactKeys(value, APPROVAL_KEYS, 'CONSTITUTION_APPROVAL_INVALID', 'constitution approval');
  for (const key of APPROVAL_KEYS) {
    if (!Object.hasOwn(value, key)) approvalInvalid(`constitution approval is missing ${key}`);
  }
  if (value.schemaVersion !== CONSTITUTION_SCHEMA_VERSION) approvalInvalid(`constitution approval schemaVersion must be ${CONSTITUTION_SCHEMA_VERSION}`);
  const version = requireText(value.version, 'constitution approval.version', { maxBytes: 128, code: 'CONSTITUTION_APPROVAL_INVALID' });
  const by = requireText(value.by, 'constitution approval.by', { maxBytes: 256, code: 'CONSTITUTION_APPROVAL_INVALID' });
  const reason = requireText(value.reason, 'constitution approval.reason', { maxBytes: 4096, code: 'CONSTITUTION_APPROVAL_INVALID' });
  const contentSha256 = value.contentSha256;
  if (typeof contentSha256 !== 'string' || !DIGEST.test(contentSha256)) approvalInvalid('constitution approval.contentSha256 must be a SHA-256 digest');
  const ratifiedAt = timestamp(value.ratifiedAt, 'constitution approval.ratifiedAt');
  const amendedAt = timestamp(value.amendedAt, 'constitution approval.amendedAt');
  const approvedAt = timestamp(value.approvedAt, 'constitution approval.approvedAt');
  if (Date.parse(ratifiedAt) > Date.parse(amendedAt) || Date.parse(amendedAt) > Date.parse(approvedAt)) {
    approvalInvalid('constitution approval timestamps must be ordered ratifiedAt <= amendedAt <= approvedAt');
  }
  return {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    version,
    ratifiedAt,
    amendedAt,
    approvedAt,
    by,
    reason,
    contentSha256,
  };
}

function fileRecord(path, text) {
  return { path, text, bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

async function readConstitutionFile(projectRoot, projectPath, label) {
  const path = constitutionPath(projectPath, label);
  let resolved;
  try {
    resolved = await resolveProjectPath(projectRoot, path, { allowMissing: false });
  } catch (error) {
    if (error?.code && !['PATH_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
    throw tinyError('CONSTITUTION_MISSING', `${label} cannot be read: ${path}`, { path, cause: error?.code });
  }
  let info;
  try {
    info = await lstat(resolved.absolutePath);
  } catch (error) {
    throw tinyError('CONSTITUTION_MISSING', `${label} cannot be read: ${path}`, { path, cause: error?.code });
  }
  if (!info.isFile()) throw tinyError('CONSTITUTION_INVALID_FILE', `${label} must be a regular file: ${path}`, { path });
  if (info.size > MAX_CONSTITUTION_FILE_BYTES) {
    throw tinyError('CONSTITUTION_READ_LIMIT', `${path} exceeds the ${MAX_CONSTITUTION_FILE_BYTES}-byte ordinary-file limit`, { path, bytes: info.size, limit: MAX_CONSTITUTION_FILE_BYTES });
  }
  const handle = await open(resolved.absolutePath, 'r');
  const buffer = Buffer.alloc(MAX_CONSTITUTION_FILE_BYTES + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytesRead > MAX_CONSTITUTION_FILE_BYTES) {
    throw tinyError('CONSTITUTION_READ_LIMIT', `${path} exceeds the ${MAX_CONSTITUTION_FILE_BYTES}-byte ordinary-file limit`, { path, bytes: bytesRead, limit: MAX_CONSTITUTION_FILE_BYTES });
  }
  const raw = buffer.subarray(0, bytesRead);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw tinyError('CONSTITUTION_UTF8_BOM', `ordinary text input must not contain a UTF-8 BOM: ${path}`, { path });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw tinyError('CONSTITUTION_UTF8_INVALID', `ordinary text input is not valid UTF-8: ${path}`, { path });
  }
  return fileRecord(path, text);
}

/**
 * Validate the referenced Markdown and operator record. The optional reader
 * keeps change-format validation on its existing bounded-read implementation.
 */
export async function validateConstitution(projectRoot, reference, { readFile = undefined } = {}) {
  const parsed = parseConstitutionReference(reference);
  const reader = readFile ?? ((path, label) => readConstitutionFile(projectRoot, path, label));
  const markdown = await reader(parsed.path, 'constitution Markdown');
  const approvalFile = await reader(parsed.approval, 'constitution approval');
  requireText(markdown.text, 'constitution Markdown', { maxBytes: MAX_CONSTITUTION_FILE_BYTES });
  requireText(approvalFile.text, 'constitution approval', { maxBytes: MAX_CONSTITUTION_FILE_BYTES });
  const approval = parseConstitutionApproval(approvalFile.text);
  if (approval.contentSha256 !== markdown.sha256) {
    throw tinyError('CONSTITUTION_DIGEST_MISMATCH', 'constitution approval contentSha256 does not match the exact Markdown bytes', {
      path: parsed.path,
      expected: approval.contentSha256,
      actual: markdown.sha256,
    });
  }
  return {
    ...parsed,
    markdown,
    approvalFile,
    approvalRecord: approval,
    lineCount: constitutionLineCount(markdown.text),
  };
}

export function constitutionLineCount(text) {
  const lines = String(text).split(/\r?\n/u);
  return String(text).endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Return exact source-line coverage for a parsed context manifest. */
export function constitutionContextCoverage(manifest, constitution) {
  if (!constitution || typeof constitution.path !== 'string' || !Number.isSafeInteger(constitution.lineCount) || constitution.lineCount < 1) {
    invalid('constitution context coverage requires a validated constitution');
  }
  const lineCount = constitution.lineCount;
  const ranges = (manifest?.resources ?? [])
    .filter((resource) => resource.path === constitution.path)
    .map((resource) => ({ startLine: resource.startLine, endLine: resource.endLine }));
  const covered = new Set();
  for (const range of ranges) {
    for (let line = range.startLine; line <= Math.min(range.endLine, lineCount); line += 1) covered.add(line);
  }
  const missingLines = [];
  for (let line = 1; line <= lineCount; line += 1) {
    if (!covered.has(line)) missingLines.push(line);
  }
  return {
    path: constitution.path,
    lineCount,
    ranges,
    complete: missingLines.length === 0,
    missingLines,
  };
}

export const parseConstitutionRecord = parseConstitutionApproval;
