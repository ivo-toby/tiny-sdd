import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const SECRET_DIRECTORY = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;

export const DEFAULT_RUNTIME_SCOPE = Object.freeze({
  mode: 'ordinary-create-modify',
  ordinaryCreateModify: true,
  deletions: false,
});

export const PROJECT_SECRET_NAME = SECRET_NAME;
export const PROJECT_SECRET_DIR = SECRET_DIRECTORY;

const MAX_ALIAS_SCAN_ENTRIES = 20_000;
const MAX_ALIAS_SCAN_DEPTH = 512;
const ALIAS_PROBE_ERROR = 'FILESYSTEM_ALIAS_PROBE_UNAVAILABLE';

export function isSecretPath(path) {
  const parts = path.split('/');
  return parts.some((part, index) => SECRET_NAME.test(part) || (index < parts.length - 1 && SECRET_DIRECTORY.test(part)));
}

export function isInternalPath(path) {
  return path.split('/').some((part) => ['.git', '.tinysdd', 'node_modules'].includes(unicodeCaseFold(part)));
}

export function isDependencyPath(path, dependencyMounts = [], caseInsensitive = null, unicodeInsensitive = null, filesystemAliases = null) {
  return dependencyMounts.some((mount) => touchesPath(path, mount, { caseInsensitive, unicodeInsensitive, filesystemAliases }));
}

function aliasProbeError(message, details = undefined) {
  const error = new Error(message);
  error.code = ALIAS_PROBE_ERROR;
  if (details !== undefined) error.details = details;
  return error;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function alternateCase(value) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    if (lower !== upper) return `${value.slice(0, index)}${character === lower ? upper : lower}${value.slice(index + 1)}`;
  }
  return null;
}

function alternateUnicode(value) {
  const normalized = value.normalize('NFC');
  const decomposed = value.normalize('NFD');
  if (normalized !== decomposed) return value === normalized ? decomposed : normalized;
  return null;
}

export function unicodeCaseFold(value) {
  return value.normalize('NFC').toUpperCase().toLowerCase();
}

function rawCaseFold(value) {
  return value.toUpperCase().toLowerCase();
}

function summarizeModes(modes) {
  const known = modes.filter((mode) => mode !== null);
  if (known.length === 0) return null;
  return known.every((mode) => mode === known[0]) ? known[0] : null;
}

function validAliasMode(value) {
  return value === true || value === false || value === null;
}

function modeForDifference(path, boundary, index, kind, options) {
  const aliases = options.filesystemAliases;
  if (aliases && aliases.directoryModes) {
    const directory = aliases.directoryModes[path.split('/').slice(0, index).join('/')]
      ?? aliases.directoryModes[boundary.split('/').slice(0, index).join('/')];
    if (!directory || !validAliasMode(directory[kind])) return null;
    return directory[kind];
  }
  const value = options[kind];
  return validAliasMode(value) ? value : null;
}

function componentsMayAlias(path, boundary, index, options) {
  const candidate = path.split('/')[index];
  const reserved = boundary.split('/')[index];
  if (candidate === reserved) return true;
  const candidateUnicode = candidate.normalize('NFC');
  const reservedUnicode = reserved.normalize('NFC');
  const sameCanonicalFold = unicodeCaseFold(candidateUnicode) === unicodeCaseFold(reservedUnicode);
  if (!sameCanonicalFold) return false;
  const caseDifference = candidateUnicode !== reservedUnicode;
  const unicodeDifference = candidate !== reserved && (candidateUnicode === reservedUnicode || rawCaseFold(candidate) !== rawCaseFold(reserved));
  if (caseDifference
    && modeForDifference(path, boundary, index, 'caseInsensitive', options) === false) return false;
  if (unicodeDifference
    && modeForDifference(path, boundary, index, 'unicodeInsensitive', options) === false) return false;
  return true;
}

function touchesPath(path, boundary, options = {}) {
  const candidateParts = path.split('/');
  const boundaryParts = boundary.split('/');
  const shared = Math.min(candidateParts.length, boundaryParts.length);
  for (let index = 0; index < shared; index += 1) {
    if (!componentsMayAlias(path, boundary, index, options)) return false;
  }
  return true;
}

export function pathsOverlap(path, boundary, { caseInsensitive = null, unicodeInsensitive = null, filesystemAliases = null } = {}) {
  return touchesPath(path, boundary, { caseInsensitive, unicodeInsensitive, filesystemAliases });
}

function kindOf(value) {
  return value?.kind ?? null;
}

export function classifyFileScopeChange(change, { protectedPaths = [], inputPaths = [], preparationPaths = [], dependencyMounts = [], caseInsensitive = null, unicodeInsensitive = null, filesystemAliases = null } = {}) {
  const path = change?.path;
  if (typeof path !== 'string' || path.length === 0) return { path: path ?? null, change: change?.change ?? null, reason: 'invalid candidate path' };
  const pathError = observedPathError(path);
  if (pathError) return { path, change: change?.change ?? null, reason: pathError };
  const beforeKind = kindOf(change.before);
  const afterKind = kindOf(change.after);
  if (isInternalPath(path)) return { path, change: change.change, reason: 'internal controller path' };
  if (isSecretPath(path)) return { path, change: change.change, reason: 'credential or secret path' };
  if (isDependencyPath(path, dependencyMounts, caseInsensitive, unicodeInsensitive, filesystemAliases)) return { path, change: change.change, reason: 'dependency mount path' };
  if (protectedPaths.some((boundary) => touchesPath(path, boundary, { caseInsensitive, unicodeInsensitive, filesystemAliases }))) return { path, change: change.change, reason: 'protected contract file' };
  if (inputPaths.some((boundary) => touchesPath(path, boundary, { caseInsensitive, unicodeInsensitive, filesystemAliases }))) return { path, change: change.change, reason: 'task packet input' };
  if (preparationPaths.some((boundary) => touchesPath(path, boundary, { caseInsensitive, unicodeInsensitive, filesystemAliases }))) return { path, change: change.change, reason: 'immutable preparation input' };
  if (change.change === 'deleted' || !change.after) return { path, change: change.change, reason: 'file deletion is not authorized' };
  if (change.change === 'created' && beforeKind !== null || change.change === 'modified' && beforeKind === null) {
    return { path, change: change.change, reason: 'candidate identity is inconsistent' };
  }
  if (change.change === 'type_changed' || beforeKind !== null && beforeKind !== afterKind || afterKind !== 'file') {
    return { path, change: change.change, reason: 'filesystem type changes are not authorized' };
  }
  if (!['created', 'modified'].includes(change.change)) return { path, change: change.change, reason: 'unsupported candidate change' };
  return null;
}

async function inspectDirectoryAliases(absolute, relative, state, depth) {
  if (depth > MAX_ALIAS_SCAN_DEPTH) throw aliasProbeError('filesystem alias scan exceeded its directory depth');
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    throw aliasProbeError('filesystem alias scan could not read a source directory', { cause: error?.code ?? 'unknown' });
  }
  state.entries += entries.length;
  if (state.entries > MAX_ALIAS_SCAN_ENTRIES) throw aliasProbeError('filesystem alias scan exceeded its entry limit');
  const names = new Set(entries.map((entry) => entry.name));
  const caseModes = [];
  const unicodeModes = [];
  for (const entry of entries) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (isInternalPath(relativePath) || isSecretPath(relativePath)) continue;
    const exact = join(absolute, entry.name);
    let exactInfo;
    try {
      exactInfo = await lstat(exact);
    } catch (error) {
      throw aliasProbeError('filesystem alias scan could not inspect a source entry', { cause: error?.code ?? 'unknown' });
    }
    if (exactInfo.isSymbolicLink()) continue;
    const candidates = [
      ['caseInsensitive', alternateCase(entry.name), caseModes],
      ['unicodeInsensitive', alternateUnicode(entry.name), unicodeModes],
    ];
    for (const [, alternate, modes] of candidates) {
      if (alternate === null) continue;
      if (names.has(alternate)) {
        modes.push(false);
        continue;
      }
      let alternateInfo;
      try {
        alternateInfo = await lstat(join(absolute, alternate));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          modes.push(false);
          continue;
        }
        throw aliasProbeError('filesystem alias scan could not inspect an alternate source spelling', { cause: error?.code ?? 'unknown' });
      }
      if (alternateInfo.isSymbolicLink()) {
        modes.push(null);
      } else {
        modes.push(sameIdentity(exactInfo, alternateInfo));
      }
    }
    if (exactInfo.isDirectory()) await inspectDirectoryAliases(exact, relativePath, state, depth + 1);
  }
  state.directoryModes[relative] = Object.freeze({
    caseInsensitive: summarizeModes(caseModes),
    unicodeInsensitive: summarizeModes(unicodeModes),
  });
}

// Alias behavior is a property of the source directory tree, not its parent or
// the host platform. Inspect existing alternate spellings without writing a
// probe; unknown behavior remains explicit so boundary comparisons fail closed.
export async function detectFilesystemAliases(projectRoot) {
  const state = { entries: 0, directoryModes: Object.create(null) };
  await inspectDirectoryAliases(projectRoot, '', state, 0);
  const modes = Object.values(state.directoryModes);
  return {
    caseInsensitive: summarizeModes(modes.map(({ caseInsensitive }) => caseInsensitive)),
    unicodeInsensitive: summarizeModes(modes.map(({ unicodeInsensitive }) => unicodeInsensitive)),
    directoryModes: state.directoryModes,
  };
}

export async function detectCaseInsensitive(projectRoot) {
  return (await detectFilesystemAliases(projectRoot)).caseInsensitive;
}

export function preparationPaths(preparation = []) {
  return preparation.map((entry) => typeof entry === 'string' ? entry : entry.path);
}

export function sortedUniquePaths(paths) {
  return [...new Set(paths)].sort();
}

export function observedPathError(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\')) return 'noncanonical candidate path';
  const parts = path.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return 'noncanonical candidate path';
  return null;
}
