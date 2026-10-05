import { readFile } from 'node:fs/promises';

import { parseChecksManifest } from './checks-manifest.mjs';
import { assertExactKeys, assertPlainObject, normalizeProjectRelative, tinyError } from './fs-utils.mjs';

export const FEATURE_INTEGRATION_SCHEMA_VERSION = 1;
export const FEATURE_INTEGRATION_DEFAULT_TIMEOUT_MS = 120_000;
export const FEATURE_INTEGRATION_MAX_TIMEOUT_MS = 600_000;

const CONFIG_KEYS = ['manifest', 'checkId', 'argv', 'command', 'timeoutMs', 'dependencyMounts', 'testPaths', 'entrypoints'];
const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function invalid(message, details = undefined) {
  throw tinyError('CONFIG_INVALID', message, details);
}

function path(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a project-relative path`);
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { field: label });
  }
}

function uniquePaths(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
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

/**
 * Validate the optional host-owned feature integration command. The command is
 * retained as argv and is later passed to runCheck; it is never shell text.
 */
export function validateFeatureIntegrationConfig(value, label = 'config.featureIntegration') {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  try {
    assertExactKeys(value, CONFIG_KEYS, 'CONFIG_INVALID', label);
  } catch (error) {
    if (error?.code === 'CONFIG_INVALID') throw error;
    invalid(error instanceof Error ? error.message : `${label} contains an unknown key`);
  }
  const manifest = value.manifest === undefined ? undefined : path(value.manifest, `${label}.manifest`);
  const suppliedArgv = value.argv === undefined ? undefined : command(value.argv, `${label}.argv`);
  const suppliedCommand = value.command === undefined ? undefined : command(value.command, `${label}.command`);
  if (suppliedArgv !== undefined && suppliedCommand !== undefined) invalid(`${label} must use argv or command, not both`);
  const argv = suppliedArgv ?? suppliedCommand;
  if (manifest === undefined && argv === undefined) invalid(`${label} requires manifest or argv`);
  if (manifest !== undefined && argv !== undefined) invalid(`${label} cannot combine manifest and argv`);
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
  const normalized = {
    schemaVersion: FEATURE_INTEGRATION_SCHEMA_VERSION,
    ...(manifest === undefined ? {} : { manifest }),
    checkId,
    ...(argv === undefined ? {} : { argv }),
    timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
    dependencyMounts,
    testPaths,
    entrypoints,
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

/** Build the checks-manifest shape used by runCheck for an inline argv. */
export function inlineFeatureIntegrationManifest(config) {
  const normalized = validateFeatureIntegrationConfig(config);
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
export async function resolveFeatureIntegrationCommand(projectRoot, config, { read = readFile } = {}) {
  const normalized = validateFeatureIntegrationConfig(config);
  if (normalized.argv) {
    const parsed = parseChecksManifest(JSON.stringify(inlineFeatureIntegrationManifest(normalized)));
    return {
      config: normalized,
      manifest: parsed,
      manifestPath: null,
      manifestText: JSON.stringify(inlineFeatureIntegrationManifest(normalized)),
      check: parsed.checks[0],
    };
  }
  const absolute = `${projectRoot}/${normalized.manifest}`;
  let text;
  try {
    text = await read(absolute, 'utf8');
  } catch (error) {
    throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration manifest cannot be read: ${normalized.manifest}`, { path: normalized.manifest, cause: error?.code });
  }
  const manifest = parseChecksManifest(text);
  const check = manifest.checks.find((item) => item.id === normalized.checkId);
  if (!check) throw tinyError('FEATURE_INTEGRATION_CONFIG', `feature integration check is not declared: ${normalized.checkId}`, { checkId: normalized.checkId, path: normalized.manifest });
  return { config: normalized, manifest, manifestPath: normalized.manifest, manifestText: text, check };
}
