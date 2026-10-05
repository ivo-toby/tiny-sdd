import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const SECRET_DIRECTORY = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;

export const DEFAULT_RUNTIME_SCOPE = Object.freeze({
  mode: 'ordinary-create-modify',
  ordinaryCreateModify: true,
  deletions: false,
});

export const PROJECT_SECRET_NAME = SECRET_NAME;
export const PROJECT_SECRET_DIR = SECRET_DIRECTORY;

export function isSecretPath(path) {
  const parts = path.split('/');
  return parts.some((part, index) => SECRET_NAME.test(part) || (index < parts.length - 1 && SECRET_DIRECTORY.test(part)));
}

export function isInternalPath(path) {
  return path.split('/').some((part) => ['.git', '.tinysdd', 'node_modules'].includes(part.toLowerCase()));
}

export function isDependencyPath(path, dependencyMounts = [], caseInsensitive = false, unicodeInsensitive = false) {
  return dependencyMounts.some((mount) => touchesPath(path, mount, caseInsensitive, unicodeInsensitive));
}

function touchesPath(path, boundary, caseInsensitive, unicodeInsensitive) {
  const normalize = (value) => {
    const normalized = unicodeInsensitive ? value.normalize('NFC') : value;
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const candidate = normalize(path);
  const reserved = normalize(boundary);
  return candidate === reserved || candidate.startsWith(`${reserved}/`) || reserved.startsWith(`${candidate}/`);
}

export function pathsOverlap(path, boundary, { caseInsensitive = false, unicodeInsensitive = false } = {}) {
  return touchesPath(path, boundary, caseInsensitive, unicodeInsensitive);
}

function kindOf(value) {
  return value?.kind ?? null;
}

export function classifyFileScopeChange(change, { protectedPaths = [], inputPaths = [], preparationPaths = [], dependencyMounts = [], caseInsensitive = false, unicodeInsensitive = false } = {}) {
  const path = change?.path;
  if (typeof path !== 'string' || path.length === 0) return { path: path ?? null, change: change?.change ?? null, reason: 'invalid candidate path' };
  const pathError = observedPathError(path);
  if (pathError) return { path, change: change?.change ?? null, reason: pathError };
  const beforeKind = kindOf(change.before);
  const afterKind = kindOf(change.after);
  if (isInternalPath(path)) return { path, change: change.change, reason: 'internal controller path' };
  if (isSecretPath(path)) return { path, change: change.change, reason: 'credential or secret path' };
  if (isDependencyPath(path, dependencyMounts, caseInsensitive, unicodeInsensitive)) return { path, change: change.change, reason: 'dependency mount path' };
  if (protectedPaths.some((boundary) => touchesPath(path, boundary, caseInsensitive, unicodeInsensitive))) return { path, change: change.change, reason: 'protected contract file' };
  if (inputPaths.some((boundary) => touchesPath(path, boundary, caseInsensitive, unicodeInsensitive))) return { path, change: change.change, reason: 'task packet input' };
  if (preparationPaths.some((boundary) => touchesPath(path, boundary, caseInsensitive, unicodeInsensitive))) return { path, change: change.change, reason: 'immutable preparation input' };
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

// Case aliases matter on the default macOS volume, while a case-sensitive
// volume must continue to permit distinct ordinary paths. Probe the project
// parent so the classifier follows the source filesystem rather than the host
// platform label. A failed probe fails closed on macOS.
export async function detectFilesystemAliases(projectRoot) {
  let probe;
  try {
    probe = await mkdtemp(join(dirname(projectRoot), '.tinysdd-case-probe-'));
    const marker = 'TinySDDCaseProbe';
    await writeFile(join(probe, marker), '');
    const unicodeMarker = 'TinySDD-Café';
    await writeFile(join(probe, unicodeMarker), '');
    try {
      await lstat(join(probe, marker.toLowerCase()));
      var caseInsensitive = true;
    } catch (error) {
      if (error?.code === 'ENOENT') caseInsensitive = false;
      else throw error;
    }
    try {
      await lstat(join(probe, unicodeMarker.normalize('NFD')));
      return { caseInsensitive, unicodeInsensitive: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { caseInsensitive, unicodeInsensitive: false };
      throw error;
    }
  } catch {
    return { caseInsensitive: process.platform === 'darwin', unicodeInsensitive: process.platform === 'darwin' };
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true }).catch(() => {});
  }
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
