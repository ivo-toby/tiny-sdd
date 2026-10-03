import { assertExactKeys, assertPlainObject, normalizeProjectRelative, tinyError } from './fs-utils.mjs';

export const CHECKS_MANIFEST_SCHEMA_VERSION = 1;
const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CRITERION_PATTERN = /^C\d+$/u;
const MAX_DEPENDENCY_MOUNTS = 8;
const MAX_CHECKS = 16;
const MAX_ARGV = 64;
const MAX_ARG_BYTES = 4096;

function invalid(message, details) {
  throw tinyError('CHECKS_MANIFEST_INVALID', message, details);
}

function normalizedPath(value, label) {
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function parseCriteria(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seen = new Set();
  return value.map((criterion) => {
    if (typeof criterion !== 'string' || !CRITERION_PATTERN.test(criterion)) {
      invalid(`${label} must contain unique C<n> ids`);
    }
    if (seen.has(criterion)) invalid(`${label} contains duplicate id: ${criterion}`);
    seen.add(criterion);
    return criterion;
  });
}

export function parseChecksManifest(text) {
  if (typeof text !== 'string') invalid('checks manifest must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`checks manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, 'CHECKS_MANIFEST_INVALID', 'checks manifest');
  assertExactKeys(value, ['schemaVersion', 'dependencyMounts', 'checks'], 'CHECKS_MANIFEST_INVALID', 'checks manifest');
  if (value.schemaVersion !== CHECKS_MANIFEST_SCHEMA_VERSION) invalid(`checks manifest schemaVersion must be ${CHECKS_MANIFEST_SCHEMA_VERSION}`);

  if (!Array.isArray(value.dependencyMounts) || value.dependencyMounts.length > MAX_DEPENDENCY_MOUNTS) {
    invalid(`checks manifest dependencyMounts must contain at most ${MAX_DEPENDENCY_MOUNTS} items`);
  }
  const dependencyMounts = [];
  const mountsSeen = new Set();
  for (const [index, mount] of value.dependencyMounts.entries()) {
    const normalized = normalizedPath(mount, `dependencyMounts[${index}]`);
    if (mountsSeen.has(normalized)) invalid(`dependencyMounts contains duplicate path: ${normalized}`);
    mountsSeen.add(normalized);
    dependencyMounts.push(normalized);
  }

  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > MAX_CHECKS) {
    invalid(`checks must contain between 1 and ${MAX_CHECKS} items`);
  }
  const checks = [];
  const idsSeen = new Set();
  for (const [index, check] of value.checks.entries()) {
    const label = `check ${index + 1}`;
    assertPlainObject(check, 'CHECKS_MANIFEST_INVALID', label);
    assertExactKeys(check, ['id', 'argv', 'timeoutMs', 'criteria'], 'CHECKS_MANIFEST_INVALID', label);
    if (typeof check.id !== 'string' || !CHECK_ID_PATTERN.test(check.id)) invalid(`${label}.id must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
    if (idsSeen.has(check.id)) invalid(`checks contains duplicate id: ${check.id}`);
    idsSeen.add(check.id);

    if (typeof check.argv === 'string') invalid(`${label}.argv must be an array, not a shell string`);
    if (!Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > MAX_ARGV) {
      invalid(`${label}.argv must contain between 1 and ${MAX_ARGV} items`);
    }
    const argv = check.argv.map((argument, argumentIndex) => {
      if (typeof argument !== 'string' || argument.length === 0) invalid(`${label}.argv[${argumentIndex}] must be a non-empty string`);
      if (argument.includes('\0')) invalid(`${label}.argv[${argumentIndex}] must not contain a NUL byte`);
      if (Buffer.byteLength(argument) > MAX_ARG_BYTES) invalid(`${label}.argv[${argumentIndex}] exceeds ${MAX_ARG_BYTES} bytes`);
      return argument;
    });
    if (argv[0] !== 'node') {
      const executable = normalizedPath(argv[0], `${label}.argv[0]`);
      if (!dependencyMounts.some((mount) => executable.startsWith(`${mount}/`))) {
        invalid(`${label}.argv[0] must be node or a project-relative executable inside a declared dependency mount`);
      }
      argv[0] = executable;
    }

    let timeoutMs = 120000;
    if (check.timeoutMs !== undefined) {
      if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 600000) {
        invalid(`${label}.timeoutMs must be an integer from 1000 to 600000`);
      }
      timeoutMs = check.timeoutMs;
    }
    const normalized = { id: check.id, argv, timeoutMs };
    if (check.criteria !== undefined) normalized.criteria = parseCriteria(check.criteria, `${label}.criteria`);
    checks.push(normalized);
  }

  return { schemaVersion: CHECKS_MANIFEST_SCHEMA_VERSION, dependencyMounts, checks };
}
