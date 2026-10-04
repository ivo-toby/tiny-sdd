import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApprovedPacketAnchor,
  DEFAULT_COMPACTION_LIMITS,
  DETERMINISTIC_COMPACTION_VERSION,
} from './deterministic-compaction.mjs';

export const COMPACTION_ANCHOR_ENV = 'TINYSDD_COMPACTION_ANCHOR';
export const COMPACTION_SCHEMA_VERSION = DETERMINISTIC_COMPACTION_VERSION;
export const COMPACTION_EXTENSION_ENTRY = 'entry.mjs';
export const COMPACTION_ANCHOR_FILE = 'anchor.json';

const BUNDLE_FILES = ['compaction-extension.mjs', 'deterministic-compaction.mjs', 'compaction-runtime.mjs'];
const SAFE_INTEGER = Number.isSafeInteger;

export class CompactionRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompactionRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function invalid(code, message, details = {}) {
  return new CompactionRuntimeError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertTokenCount(value, label, { allowZero = false } = {}) {
  if (!SAFE_INTEGER(value) || (allowZero ? value < 0 : value < 1)) {
    throw invalid('COMPACTION_PROFILE_INVALID', `${label} must be a ${allowZero ? 'nonnegative' : 'positive'} safe integer`);
  }
  return value;
}

/** Validate the optional profile runtime.compaction object without applying it. */
export function normalizeCompactionProfile(runtime = undefined) {
  const raw = runtime?.compaction;
  if (raw === undefined) return Object.freeze({ enabled: false });
  if (!isObject(raw)) throw invalid('COMPACTION_PROFILE_INVALID', 'profile.runtime.compaction must be an object');
  const allowed = new Set(['enabled', 'reserveTokens', 'keepRecentTokens']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw invalid('COMPACTION_PROFILE_INVALID', `profile.runtime.compaction.${key} is unsupported`);
  }
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== 'boolean') throw invalid('COMPACTION_PROFILE_INVALID', 'profile.runtime.compaction.enabled must be boolean');
  const reserveTokens = raw.reserveTokens === undefined ? undefined : assertTokenCount(raw.reserveTokens, 'profile.runtime.compaction.reserveTokens', { allowZero: true });
  const keepRecentTokens = raw.keepRecentTokens === undefined ? undefined : assertTokenCount(raw.keepRecentTokens, 'profile.runtime.compaction.keepRecentTokens', { allowZero: true });
  return Object.freeze({ enabled, ...(reserveTokens === undefined ? {} : { reserveTokens }), ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }) });
}

/** Resolve Pi's effective compaction settings and enforce the response reserve. */
export function resolveCompactionSettings(runtime, effectiveMaxTokens) {
  const profile = normalizeCompactionProfile(runtime);
  if (!profile.enabled) return Object.freeze({ enabled: false, profile });
  const maxTokens = assertTokenCount(effectiveMaxTokens, 'effectiveMaxTokens');
  const reserveTokens = profile.reserveTokens ?? maxTokens;
  if (reserveTokens < maxTokens) {
    throw invalid('COMPACTION_RESERVE_TOO_SMALL', `compaction reserveTokens ${reserveTokens} must be at least effective maxTokens ${maxTokens}`, { reserveTokens, effectiveMaxTokens: maxTokens });
  }
  return Object.freeze({
    enabled: true,
    reserveTokens,
    ...(profile.keepRecentTokens === undefined ? {} : { keepRecentTokens: profile.keepRecentTokens }),
    profile,
  });
}

export function piCompactionSettings(settings) {
  if (!settings?.enabled) return { enabled: false };
  return {
    enabled: true,
    reserveTokens: settings.reserveTokens,
    ...(settings.keepRecentTokens === undefined ? {} : { keepRecentTokens: settings.keepRecentTokens }),
  };
}

export function compactionIdentity(settings, anchor = null) {
  const enabled = settings?.enabled === true;
  return {
    enabled,
    mode: enabled ? 'deterministic' : 'off',
    reserveTokens: enabled ? settings.reserveTokens : null,
    keepRecentTokens: enabled ? (settings.keepRecentTokens ?? null) : null,
    extensionVersion: enabled ? COMPACTION_SCHEMA_VERSION : null,
    anchorId: enabled && anchor ? anchor.id : null,
    anchorSha256: enabled && anchor ? anchor.sha256 : null,
    anchorBytes: enabled && anchor ? anchor.bytes : null,
  };
}

function anchorEnvelope(anchor) {
  const normalized = createApprovedPacketAnchor(anchor);
  const envelope = {
    schemaVersion: COMPACTION_SCHEMA_VERSION,
    anchor: {
      id: normalized.id,
      sha256: normalized.sha256,
      bytes: normalized.bytes,
      text: normalized.text,
      ...(normalized.path === undefined ? {} : { path: normalized.path }),
    },
  };
  const encoded = Buffer.from(JSON.stringify(envelope), 'utf8');
  return { normalized, envelope, encoded, sha256: digest(encoded) };
}

export function serializeCompactionAnchor(anchor) {
  return anchorEnvelope(anchor).encoded;
}

function parseCompactionAnchor(serialized, limits = DEFAULT_COMPACTION_LIMITS) {
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor artifact is not valid JSON');
  }
  if (!isObject(envelope) || envelope.schemaVersion !== COMPACTION_SCHEMA_VERSION || !isObject(envelope.anchor)) {
    throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor artifact has an unsupported schema');
  }
  const allowed = new Set(['id', 'sha256', 'bytes', 'text', 'path']);
  if (Object.keys(envelope.anchor).some((key) => !allowed.has(key))) throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor artifact has unsupported fields');
  const anchor = createApprovedPacketAnchor(envelope.anchor, { limits });
  if (envelope.anchor.bytes !== anchor.bytes) throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor byte count does not match its text');
  return Object.freeze(anchor);
}

function assertRegularAnchorFile(path, maxBytes) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw invalid('PACKET_ANCHOR_FILE_UNAVAILABLE', `cannot read compaction anchor artifact: ${error.message}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor artifact must be a regular file');
  if (info.size > maxBytes) throw invalid('PACKET_ANCHOR_FILE_OVERSIZE', 'compaction anchor artifact exceeds its byte limit', { bytes: info.size, limit: maxBytes });
}

export function loadCompactionAnchorSync(path, options = {}) {
  const limits = { ...DEFAULT_COMPACTION_LIMITS, ...(options.limits ?? {}) };
  assertRegularAnchorFile(path, Math.max(limits.maxPacketBytes * 2, 4096));
  return parseCompactionAnchor(readFileSync(path, 'utf8'), limits);
}

export async function loadCompactionAnchor(path, options = {}) {
  const limits = { ...DEFAULT_COMPACTION_LIMITS, ...(options.limits ?? {}) };
  let info;
  try {
    info = await (await import('node:fs/promises')).lstat(path);
  } catch (error) {
    throw invalid('PACKET_ANCHOR_FILE_UNAVAILABLE', `cannot read compaction anchor artifact: ${error.message}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw invalid('PACKET_ANCHOR_FILE_INVALID', 'compaction anchor artifact must be a regular file');
  const maxBytes = Math.max(limits.maxPacketBytes * 2, 4096);
  if (info.size > maxBytes) throw invalid('PACKET_ANCHOR_FILE_OVERSIZE', 'compaction anchor artifact exceeds its byte limit', { bytes: info.size, limit: maxBytes });
  return parseCompactionAnchor(await readFile(path, 'utf8'), limits);
}

export async function writeCompactionAnchor(path, anchor) {
  const { encoded, sha256 } = anchorEnvelope(anchor);
  await writeFile(path, encoded, { mode: 0o400, flag: 'wx' });
  await chmod(path, 0o400);
  return Object.freeze({ path, sha256, bytes: encoded.length, anchor: createApprovedPacketAnchor(anchor) });
}

/** Stage the extension, its deterministic implementation and immutable anchor. */
export async function writeCompactionBundle(directory, anchor) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const anchorPath = join(directory, COMPACTION_ANCHOR_FILE);
  await writeCompactionAnchor(anchorPath, anchor);
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  for (const file of BUNDLE_FILES) await copyFile(join(sourceDir, file), join(directory, file));
  const entryPath = join(directory, COMPACTION_EXTENSION_ENTRY);
  await writeFile(entryPath, "export { default } from './compaction-extension.mjs';\n", { mode: 0o400, flag: 'wx' });
  await chmod(entryPath, 0o400);
  return Object.freeze({ directory, entryPath, anchorPath, anchor: createApprovedPacketAnchor(anchor) });
}
