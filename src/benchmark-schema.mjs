import {
  assertExactKeys,
  assertPlainObject,
  digestJson,
  normalizeProjectRelative,
  tinyError,
} from './fs-utils.mjs';

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_SUITE_SCHEMA_VERSION = 1;
export const BENCHMARK_CHALLENGE_SCHEMA_VERSION = 1;
export const BENCHMARK_CONFIG_SCHEMA_VERSION = 1;

export const BENCHMARK_UNKNOWN = 'UNKNOWN';
export const BENCHMARK_ROLES = Object.freeze([
  'implement-slice',
  'research',
  'write-tests',
  'stop-and-ask',
  'judge',
]);
export const BENCHMARK_RUNNABLE_ROLES = Object.freeze(['implement-slice']);
export const BENCHMARK_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ROOTS = Object.freeze({
  challenge: 'challenges',
  fixture: 'fixtures',
  packet: 'packets',
  verifier: 'verifier',
});

function invalid(code, message, details = undefined) {
  throw tinyError(code, message, details);
}

function schemaInvalid(label, message, details = undefined) {
  invalid('BENCHMARK_SCHEMA_INVALID', `${label} ${message}`, details);
}

function assertObject(value, label) {
  try {
    return assertPlainObject(value, 'BENCHMARK_SCHEMA_INVALID', label);
  } catch (error) {
    if (error?.code === 'BENCHMARK_SCHEMA_INVALID') throw error;
    schemaInvalid(label, error instanceof Error ? error.message : String(error));
  }
}

function assertKeys(value, keys, label) {
  try {
    assertExactKeys(value, keys, 'BENCHMARK_SCHEMA_INVALID', label);
  } catch (error) {
    if (error?.code === 'BENCHMARK_SCHEMA_INVALID') throw error;
    schemaInvalid(label, error instanceof Error ? error.message : String(error));
  }
}

function requiredString(value, label, { pattern = undefined } = {}) {
  if (typeof value !== 'string' || value.length === 0) schemaInvalid(label, 'must be a nonempty string');
  if (pattern && !pattern.test(value)) schemaInvalid(label, 'has an invalid format');
  return value;
}

function requiredId(value, label) {
  return requiredString(value, label, { pattern: ID_PATTERN });
}

function requiredDigest(value, label) {
  if (typeof value !== 'string' || !BENCHMARK_DIGEST_PATTERN.test(value)) {
    schemaInvalid(label, 'must be a lowercase SHA-256 digest');
  }
  return value;
}

function requiredInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    schemaInvalid(label, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizedPath(value, label, { hidden = false, root = undefined } = {}) {
  let normalized;
  try {
    normalized = normalizeProjectRelative(value, label);
  } catch (error) {
    schemaInvalid(label, error instanceof Error ? error.message : String(error));
  }
  if (root !== undefined && normalized !== root && !normalized.startsWith(`${root}/`)) {
    schemaInvalid(label, `must be confined to ${root}/`);
  }
  if (hidden && normalized.split('/').some((part) => part.startsWith('.'))) {
    schemaInvalid(label, 'must not contain hidden path components');
  }
  return normalized;
}

function uniqueStrings(value, label, { pattern = undefined, paths = false } = {}) {
  if (!Array.isArray(value)) schemaInvalid(label, 'must be an array');
  const seen = new Set();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = paths ? normalizedPath(entry, itemLabel) : requiredString(entry, itemLabel, { pattern });
    if (seen.has(item)) schemaInvalid(label, `contains duplicate value: ${item}`);
    seen.add(item);
    return item;
  });
}

function contentRef(value, label, { root, hidden = true } = {}) {
  const ref = assertObject(value, label);
  assertKeys(ref, ['path', 'sha256'], label);
  return {
    path: normalizedPath(ref.path, `${label}.path`, { root, hidden }),
    sha256: requiredDigest(ref.sha256, `${label}.sha256`),
  };
}

function validateSchemaVersion(value, expected, label) {
  if (value !== expected) schemaInvalid(`${label}.schemaVersion`, `must be ${expected}`);
  return expected;
}

function validateSuiteDefaults(value, label) {
  if (value === undefined) return { repeat: 1 };
  const defaults = assertObject(value, label);
  assertKeys(defaults, ['repeat'], label);
  return { repeat: requiredInteger(defaults.repeat, `${label}.repeat`, { min: 1, max: 1000 }) };
}

export function validateBenchmarkSuite(value) {
  const suite = assertObject(value, 'benchmark suite');
  assertKeys(suite, ['schemaVersion', 'id', 'version', 'challenges', 'defaults'], 'benchmark suite');
  validateSchemaVersion(suite.schemaVersion, BENCHMARK_SUITE_SCHEMA_VERSION, 'benchmark suite');
  const id = requiredId(suite.id, 'benchmark suite.id');
  const version = requiredString(suite.version, 'benchmark suite.version');
  if (!Array.isArray(suite.challenges) || suite.challenges.length === 0 || suite.challenges.length > 256) {
    schemaInvalid('benchmark suite.challenges', 'must contain between 1 and 256 challenge references');
  }
  const seen = new Set();
  const challenges = suite.challenges.map((challenge, index) => {
    const ref = contentRef(challenge, `benchmark suite.challenges[${index}]`, { root: ROOTS.challenge });
    if (seen.has(ref.path)) schemaInvalid('benchmark suite.challenges', `contains duplicate path: ${ref.path}`);
    seen.add(ref.path);
    return ref;
  });
  return {
    schemaVersion: BENCHMARK_SUITE_SCHEMA_VERSION,
    id,
    version,
    challenges,
    defaults: validateSuiteDefaults(suite.defaults, 'benchmark suite.defaults'),
  };
}

export function parseBenchmarkSuite(text) {
  if (typeof text !== 'string') schemaInvalid('benchmark suite', 'must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    schemaInvalid('benchmark suite', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkSuite(value);
}

function validatePacket(value, label) {
  const packet = assertObject(value, label);
  assertKeys(packet, ['brief', 'context', 'checks', 'allowedPaths', 'protectedPaths'], label);
  const allowedPaths = uniqueStrings(packet.allowedPaths, `${label}.allowedPaths`, { paths: true });
  const protectedPaths = uniqueStrings(packet.protectedPaths, `${label}.protectedPaths`, { paths: true });
  if (allowedPaths.some((path) => path.startsWith('.git/') || path.startsWith('.tinysdd/'))) {
    schemaInvalid(`${label}.allowedPaths`, 'must not include controller paths');
  }
  if (protectedPaths.some((path) => path.startsWith('.git/') || path.startsWith('.tinysdd/'))) {
    schemaInvalid(`${label}.protectedPaths`, 'must not include controller paths');
  }
  return {
    brief: contentRef(packet.brief, `${label}.brief`, { root: ROOTS.packet }),
    context: contentRef(packet.context, `${label}.context`, { root: ROOTS.packet }),
    checks: contentRef(packet.checks, `${label}.checks`, { root: ROOTS.packet }),
    allowedPaths,
    protectedPaths,
  };
}

function validateVerifierDefinition(value, label) {
  const verifier = assertObject(value, label);
  assertKeys(verifier, ['visible', 'heldOut'], label);
  return {
    visible: contentRef(verifier.visible, `${label}.visible`, { root: ROOTS.verifier }),
    heldOut: contentRef(verifier.heldOut, `${label}.heldOut`, { root: ROOTS.verifier }),
  };
}

export function validateBenchmarkChallenge(value) {
  const challenge = assertObject(value, 'benchmark challenge');
  assertKeys(challenge, ['schemaVersion', 'id', 'version', 'role', 'difficultyTags', 'fixture', 'packet', 'verifier'], 'benchmark challenge');
  validateSchemaVersion(challenge.schemaVersion, BENCHMARK_CHALLENGE_SCHEMA_VERSION, 'benchmark challenge');
  const id = requiredId(challenge.id, 'benchmark challenge.id');
  const version = requiredString(challenge.version, 'benchmark challenge.version');
  if (!BENCHMARK_ROLES.includes(challenge.role)) {
    schemaInvalid('benchmark challenge.role', `must be one of ${BENCHMARK_ROLES.join(', ')}`);
  }
  const difficultyTags = uniqueStrings(challenge.difficultyTags, 'benchmark challenge.difficultyTags', { pattern: TAG_PATTERN });
  return {
    schemaVersion: BENCHMARK_CHALLENGE_SCHEMA_VERSION,
    id,
    version,
    role: challenge.role,
    difficultyTags,
    fixture: contentRef(challenge.fixture, 'benchmark challenge.fixture', { root: ROOTS.fixture, hidden: true }),
    packet: validatePacket(challenge.packet, 'benchmark challenge.packet'),
    verifier: validateVerifierDefinition(challenge.verifier, 'benchmark challenge.verifier'),
  };
}

export function parseBenchmarkChallenge(text) {
  if (typeof text !== 'string') schemaInvalid('benchmark challenge', 'must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    schemaInvalid('benchmark challenge', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkChallenge(value);
}

export function isRunnableBenchmarkRole(role) {
  return BENCHMARK_RUNNABLE_ROLES.includes(role);
}

export function assertRunnableBenchmarkRole(role) {
  if (!isRunnableBenchmarkRole(role)) {
    throw tinyError('BENCHMARK_ROLE_UNSUPPORTED', `benchmark role is not supported by the v1 runner: ${role}`, { role, supported: [...BENCHMARK_RUNNABLE_ROLES] });
  }
  return role;
}

function metadataInvalid(label, message) {
  invalid('BENCHMARK_CONFIG_INVALID', `${label} ${message}`);
}

function configObject(value, label) {
  try {
    return assertPlainObject(value, 'BENCHMARK_CONFIG_INVALID', label);
  } catch (error) {
    if (error?.code === 'BENCHMARK_CONFIG_INVALID') throw error;
    metadataInvalid(label, error instanceof Error ? error.message : String(error));
  }
}

function configKeys(value, allowed, label) {
  try {
    assertExactKeys(value, allowed, 'BENCHMARK_CONFIG_INVALID', label);
  } catch (error) {
    if (error?.code === 'BENCHMARK_CONFIG_INVALID') throw error;
    metadataInvalid(label, error instanceof Error ? error.message : String(error));
  }
}

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|credential|api[_-]?key|authorization|bearer)/iu;
const SENSITIVE_VALUE_PATTERN = /(?:^|[?&\s])(?:token|secret|password|credential|api[_-]?key|authorization|bearer)\s*=/iu;

function assertSafeMetadata(value, label, seen = new Set()) {
  if (value === BENCHMARK_UNKNOWN) return value;
  if (value === null) metadataInvalid(label, 'must not be null');
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value)) metadataInvalid(label, 'must not contain credential material');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) metadataInvalid(label, 'must be finite');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) metadataInvalid(label, 'must not contain cycles');
    seen.add(value);
    const result = value.map((entry, index) => assertSafeMetadata(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) metadataInvalid(label, 'must not contain cycles');
    seen.add(value);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') metadataInvalid(`${label}.${key}`, 'is not allowed');
      if (SENSITIVE_KEY_PATTERN.test(key)) metadataInvalid(`${label}.${key}`, 'must not contain credential material');
      result[key] = assertSafeMetadata(entry, `${label}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  metadataInvalid(label, 'contains an unsupported value');
}

function missingValue(value, field, missing, { validate = undefined } = {}) {
  if (value === undefined) {
    missing.push({ field, reason: 'not supplied' });
    return BENCHMARK_UNKNOWN;
  }
  if (value === BENCHMARK_UNKNOWN) {
    missing.push({ field, reason: 'explicit UNKNOWN' });
    return BENCHMARK_UNKNOWN;
  }
  if (validate) return validate(value, field);
  return value;
}

function maybeString(value, field, missing) {
  return missingValue(value, field, missing, {
    validate: (entry, label) => {
      if (typeof entry !== 'string' || entry.length === 0) metadataInvalid(label, 'must be a nonempty string or UNKNOWN');
      return assertSafeMetadata(entry, label);
    },
  });
}

function maybeDigest(value, field, missing) {
  return missingValue(value, field, missing, {
    validate: (entry, label) => {
      if (typeof entry !== 'string' || !BENCHMARK_DIGEST_PATTERN.test(entry)) metadataInvalid(label, 'must be a lowercase SHA-256 digest or UNKNOWN');
      return entry;
    },
  });
}

function maybeBoolean(value, field, missing) {
  return missingValue(value, field, missing, {
    validate: (entry, label) => {
      if (typeof entry !== 'boolean') metadataInvalid(label, 'must be a boolean or UNKNOWN');
      return entry;
    },
  });
}

function maybeInteger(value, field, missing, { min = 0 } = {}) {
  return missingValue(value, field, missing, {
    validate: (entry, label) => {
      if (!Number.isInteger(entry) || entry < min) metadataInvalid(label, `must be an integer >= ${min} or UNKNOWN`);
      return entry;
    },
  });
}

function sourceObject(input, key) {
  if (input[key] === undefined) return {};
  if (input[key] === null || typeof input[key] !== 'object' || Array.isArray(input[key])) {
    metadataInvalid(key, 'must be an object when supplied');
  }
  return input[key];
}

function choose(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeConfigIdentityInput(input) {
  const source = assertObject(input, 'benchmark config identity input');
  const missing = [];
  const modelSource = typeof source.model === 'string' ? { id: source.model } : sourceObject(source, 'model');
  const serverSource = modelSource.server === undefined ? sourceObject(source, 'server') : sourceObject(modelSource, 'server');
  const workerSource = sourceObject(source, 'worker');
  const limitsSource = sourceObject(workerSource, 'limits');
  const settingsSource = choose(workerSource.settings, source.workerSettings);
  const piSource = sourceObject(source, 'pi');
  const tinySddSource = sourceObject(source, 'tinySdd');
  const suiteSource = sourceObject(source, 'suite');
  const verifierSource = sourceObject(source, 'verifier');
  const checkerSource = sourceObject(verifierSource, 'checkRunner');
  const environmentSource = choose(verifierSource.environment, source.environment) ?? {};
  if (environmentSource === null || typeof environmentSource !== 'object' || Array.isArray(environmentSource)) {
    metadataInvalid('environment', 'must be an object when supplied');
  }
  const runChecksSource = choose(source.runChecks, workerSource.runChecks) ?? {};
  if (runChecksSource === null || typeof runChecksSource !== 'object' || Array.isArray(runChecksSource)) {
    metadataInvalid('runChecks', 'must be an object when supplied');
  }
  const runChecksProvenance = sourceObject(runChecksSource, 'provenance');

  const workerSettings = settingsSource === undefined || settingsSource === BENCHMARK_UNKNOWN
    ? missingValue(settingsSource, 'worker.settings', missing)
    : assertSafeMetadata(settingsSource, 'worker.settings');

  const identity = {
    schemaVersion: BENCHMARK_CONFIG_SCHEMA_VERSION,
    model: {
      provider: maybeString(choose(modelSource.provider, workerSource.provider, source.provider), 'model.provider', missing),
      id: maybeString(choose(modelSource.id, modelSource.model, workerSource.model, source.modelId), 'model.id', missing),
      quantization: maybeString(choose(modelSource.quantization, source.quantization), 'model.quantization', missing),
      server: {
        id: maybeString(choose(serverSource.id, source.serverId), 'model.server.id', missing),
        version: maybeString(choose(serverSource.version, source.serverVersion), 'model.server.version', missing),
      },
    },
    worker: {
      profileDigest: maybeDigest(choose(workerSource.profileDigest, source.profileDigest), 'worker.profileDigest', missing),
      limits: {
        timeoutMs: maybeInteger(choose(limitsSource.timeoutMs, source.timeoutMs), 'worker.limits.timeoutMs', missing, { min: 1 }),
        maxToolCalls: maybeInteger(choose(limitsSource.maxToolCalls, source.maxToolCalls), 'worker.limits.maxToolCalls', missing, { min: 1 }),
        firstWriteMs: maybeInteger(choose(limitsSource.firstWriteMs, source.firstWriteMs), 'worker.limits.firstWriteMs', missing, { min: 1 }),
      },
      settings: workerSettings,
    },
    pi: {
      version: maybeString(choose(piSource.version, source.piVersion), 'pi.version', missing),
    },
    tinySdd: {
      version: maybeString(choose(tinySddSource.version, source.tinySddVersion), 'tinySdd.version', missing),
      codeRevision: maybeString(choose(tinySddSource.codeRevision, source.codeRevision), 'tinySdd.codeRevision', missing),
    },
    suite: {
      id: maybeString(choose(suiteSource.id, source.suiteId), 'suite.id', missing),
      version: maybeString(choose(suiteSource.version, source.suiteVersion), 'suite.version', missing),
      contentSha256: maybeDigest(choose(suiteSource.contentSha256, suiteSource.sha256, source.suiteContentSha256), 'suite.contentSha256', missing),
    },
    verifier: {
      configSha256: maybeDigest(choose(verifierSource.configSha256, verifierSource.sha256, source.verifierConfigSha256), 'verifier.configSha256', missing),
      checkRunner: {
        version: maybeString(choose(checkerSource.version, source.checkRunnerVersion), 'verifier.checkRunner.version', missing),
        configSha256: maybeDigest(choose(checkerSource.configSha256, checkerSource.sha256, source.checkRunnerConfigSha256), 'verifier.checkRunner.configSha256', missing),
      },
    },
    runChecks: {
      declared: maybeBoolean(choose(runChecksSource.declared, source.runChecksDeclared), 'runChecks.declared', missing),
      available: maybeBoolean(choose(runChecksSource.available, source.runChecksAvailable), 'runChecks.available', missing),
      budget: maybeInteger(choose(runChecksSource.budget, runChecksSource.maxCheckRuns, source.maxCheckRuns), 'runChecks.budget', missing, { min: 1 }),
      unavailableReason: maybeString(choose(runChecksSource.unavailableReason, runChecksProvenance.unavailableReason), 'runChecks.unavailableReason', missing),
      provenance: {
        source: maybeString(runChecksProvenance.source, 'runChecks.provenance.source', missing),
        unavailableReason: maybeString(runChecksProvenance.unavailableReason, 'runChecks.provenance.unavailableReason', missing),
      },
    },
    environment: {
      runtime: maybeString(environmentSource.runtime, 'environment.runtime', missing),
      runtimeVersion: maybeString(environmentSource.runtimeVersion, 'environment.runtimeVersion', missing),
      platform: maybeString(environmentSource.platform, 'environment.platform', missing),
      arch: maybeString(environmentSource.arch, 'environment.arch', missing),
    },
    missing,
  };
  return identity;
}

function validateMissing(value, label) {
  if (!Array.isArray(value)) metadataInvalid(label, 'must be an array');
  const seen = new Set();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = configObject(entry, itemLabel);
    configKeys(item, ['field', 'reason'], itemLabel);
    const field = requiredString(item.field, `${itemLabel}.field`);
    const reason = requiredString(item.reason, `${itemLabel}.reason`);
    if (seen.has(field)) metadataInvalid(label, `contains duplicate field: ${field}`);
    seen.add(field);
    return { field, reason };
  });
}

function validateMaybe(value, label, kind) {
  if (value === BENCHMARK_UNKNOWN) return value;
  if (kind === 'string') {
    if (typeof value !== 'string' || value.length === 0) metadataInvalid(label, 'must be a nonempty string or UNKNOWN');
    return assertSafeMetadata(value, label);
  }
  if (kind === 'digest') {
    if (typeof value !== 'string' || !BENCHMARK_DIGEST_PATTERN.test(value)) metadataInvalid(label, 'must be a lowercase SHA-256 digest or UNKNOWN');
    return value;
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') metadataInvalid(label, 'must be a boolean or UNKNOWN');
    return value;
  }
  if (kind === 'integer') {
    if (!Number.isInteger(value) || value < 1) metadataInvalid(label, 'must be a positive integer or UNKNOWN');
    return value;
  }
  return assertSafeMetadata(value, label);
}

function validateConfigObject(value, label) {
  const object = configObject(value, label);
  configKeys(object, ['provider', 'id', 'quantization', 'server'], label);
  const server = configObject(object.server, `${label}.server`);
  configKeys(server, ['id', 'version'], `${label}.server`);
  return {
    provider: validateMaybe(object.provider, `${label}.provider`, 'string'),
    id: validateMaybe(object.id, `${label}.id`, 'string'),
    quantization: validateMaybe(object.quantization, `${label}.quantization`, 'string'),
    server: {
      id: validateMaybe(server.id, `${label}.server.id`, 'string'),
      version: validateMaybe(server.version, `${label}.server.version`, 'string'),
    },
  };
}

function validateWorkerObject(value, label) {
  const worker = configObject(value, label);
  configKeys(worker, ['profileDigest', 'limits', 'settings'], label);
  const limits = configObject(worker.limits, `${label}.limits`);
  configKeys(limits, ['timeoutMs', 'maxToolCalls', 'firstWriteMs'], `${label}.limits`);
  return {
    profileDigest: validateMaybe(worker.profileDigest, `${label}.profileDigest`, 'digest'),
    limits: {
      timeoutMs: validateMaybe(limits.timeoutMs, `${label}.limits.timeoutMs`, 'integer'),
      maxToolCalls: validateMaybe(limits.maxToolCalls, `${label}.limits.maxToolCalls`, 'integer'),
      firstWriteMs: validateMaybe(limits.firstWriteMs, `${label}.limits.firstWriteMs`, 'integer'),
    },
    settings: worker.settings === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : assertSafeMetadata(worker.settings, `${label}.settings`),
  };
}

function validateConfigIdentityValue(value) {
  const identity = configObject(value, 'benchmark config identity');
  configKeys(identity, ['schemaVersion', 'model', 'worker', 'pi', 'tinySdd', 'suite', 'verifier', 'runChecks', 'environment', 'missing'], 'benchmark config identity');
  validateSchemaVersion(identity.schemaVersion, BENCHMARK_CONFIG_SCHEMA_VERSION, 'benchmark config identity');
  const pi = configObject(identity.pi, 'benchmark config identity.pi');
  configKeys(pi, ['version'], 'benchmark config identity.pi');
  const tinySdd = configObject(identity.tinySdd, 'benchmark config identity.tinySdd');
  configKeys(tinySdd, ['version', 'codeRevision'], 'benchmark config identity.tinySdd');
  const suite = configObject(identity.suite, 'benchmark config identity.suite');
  configKeys(suite, ['id', 'version', 'contentSha256'], 'benchmark config identity.suite');
  const verifier = configObject(identity.verifier, 'benchmark config identity.verifier');
  configKeys(verifier, ['configSha256', 'checkRunner'], 'benchmark config identity.verifier');
  const checkRunner = configObject(verifier.checkRunner, 'benchmark config identity.verifier.checkRunner');
  configKeys(checkRunner, ['version', 'configSha256'], 'benchmark config identity.verifier.checkRunner');
  const runChecks = configObject(identity.runChecks, 'benchmark config identity.runChecks');
  configKeys(runChecks, ['declared', 'available', 'budget', 'unavailableReason', 'provenance'], 'benchmark config identity.runChecks');
  const runChecksProvenance = configObject(runChecks.provenance, 'benchmark config identity.runChecks.provenance');
  configKeys(runChecksProvenance, ['source', 'unavailableReason'], 'benchmark config identity.runChecks.provenance');
  const environment = configObject(identity.environment, 'benchmark config identity.environment');
  configKeys(environment, ['runtime', 'runtimeVersion', 'platform', 'arch'], 'benchmark config identity.environment');
  const normalized = {
    schemaVersion: BENCHMARK_CONFIG_SCHEMA_VERSION,
    model: validateConfigObject(identity.model, 'benchmark config identity.model'),
    worker: validateWorkerObject(identity.worker, 'benchmark config identity.worker'),
    pi: { version: validateMaybe(pi.version, 'benchmark config identity.pi.version', 'string') },
    tinySdd: {
      version: validateMaybe(tinySdd.version, 'benchmark config identity.tinySdd.version', 'string'),
      codeRevision: validateMaybe(tinySdd.codeRevision, 'benchmark config identity.tinySdd.codeRevision', 'string'),
    },
    suite: {
      id: validateMaybe(suite.id, 'benchmark config identity.suite.id', 'string'),
      version: validateMaybe(suite.version, 'benchmark config identity.suite.version', 'string'),
      contentSha256: validateMaybe(suite.contentSha256, 'benchmark config identity.suite.contentSha256', 'digest'),
    },
    verifier: {
      configSha256: validateMaybe(verifier.configSha256, 'benchmark config identity.verifier.configSha256', 'digest'),
      checkRunner: {
        version: validateMaybe(checkRunner.version, 'benchmark config identity.verifier.checkRunner.version', 'string'),
        configSha256: validateMaybe(checkRunner.configSha256, 'benchmark config identity.verifier.checkRunner.configSha256', 'digest'),
      },
    },
    runChecks: {
      declared: validateMaybe(runChecks.declared, 'benchmark config identity.runChecks.declared', 'boolean'),
      available: validateMaybe(runChecks.available, 'benchmark config identity.runChecks.available', 'boolean'),
      budget: runChecks.budget === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : validateMaybe(runChecks.budget, 'benchmark config identity.runChecks.budget', 'integer'),
      unavailableReason: validateMaybe(runChecks.unavailableReason, 'benchmark config identity.runChecks.unavailableReason', 'string'),
      provenance: {
        source: validateMaybe(runChecksProvenance.source, 'benchmark config identity.runChecks.provenance.source', 'string'),
        unavailableReason: validateMaybe(runChecksProvenance.unavailableReason, 'benchmark config identity.runChecks.provenance.unavailableReason', 'string'),
      },
    },
    environment: {
      runtime: validateMaybe(environment.runtime, 'benchmark config identity.environment.runtime', 'string'),
      runtimeVersion: validateMaybe(environment.runtimeVersion, 'benchmark config identity.environment.runtimeVersion', 'string'),
      platform: validateMaybe(environment.platform, 'benchmark config identity.environment.platform', 'string'),
      arch: validateMaybe(environment.arch, 'benchmark config identity.environment.arch', 'string'),
    },
    missing: validateMissing(identity.missing, 'benchmark config identity.missing'),
  };
  const unknownFields = new Set(normalized.missing.map(({ field }) => field));
  const expectedUnknowns = [
    ['model.provider', normalized.model.provider],
    ['model.id', normalized.model.id],
    ['model.quantization', normalized.model.quantization],
    ['model.server.id', normalized.model.server.id],
    ['model.server.version', normalized.model.server.version],
    ['worker.profileDigest', normalized.worker.profileDigest],
    ['worker.limits.timeoutMs', normalized.worker.limits.timeoutMs],
    ['worker.limits.maxToolCalls', normalized.worker.limits.maxToolCalls],
    ['worker.limits.firstWriteMs', normalized.worker.limits.firstWriteMs],
    ['worker.settings', normalized.worker.settings],
    ['pi.version', normalized.pi.version],
    ['tinySdd.version', normalized.tinySdd.version],
    ['tinySdd.codeRevision', normalized.tinySdd.codeRevision],
    ['suite.id', normalized.suite.id],
    ['suite.version', normalized.suite.version],
    ['suite.contentSha256', normalized.suite.contentSha256],
    ['verifier.configSha256', normalized.verifier.configSha256],
    ['verifier.checkRunner.version', normalized.verifier.checkRunner.version],
    ['verifier.checkRunner.configSha256', normalized.verifier.checkRunner.configSha256],
    ['runChecks.declared', normalized.runChecks.declared],
    ['runChecks.available', normalized.runChecks.available],
    ['runChecks.budget', normalized.runChecks.budget],
    ['runChecks.unavailableReason', normalized.runChecks.unavailableReason],
    ['runChecks.provenance.source', normalized.runChecks.provenance.source],
    ['runChecks.provenance.unavailableReason', normalized.runChecks.provenance.unavailableReason],
    ['environment.runtime', normalized.environment.runtime],
    ['environment.runtimeVersion', normalized.environment.runtimeVersion],
    ['environment.platform', normalized.environment.platform],
    ['environment.arch', normalized.environment.arch],
  ];
  for (const [field, fieldValue] of expectedUnknowns) {
    if (fieldValue === BENCHMARK_UNKNOWN && !unknownFields.has(field)) {
      metadataInvalid('benchmark config identity.missing', `must list ${field} when its value is UNKNOWN`);
    }
    if (fieldValue !== BENCHMARK_UNKNOWN && unknownFields.has(field)) {
      metadataInvalid('benchmark config identity.missing', `must not list ${field} when its value is known`);
    }
  }
  return normalized;
}

export function validateBenchmarkConfigIdentity(value) {
  return validateConfigIdentityValue(value);
}

export function buildBenchmarkConfigIdentity(input) {
  const identity = normalizeConfigIdentityInput(input);
  const normalized = validateConfigIdentityValue(identity);
  return { identity: normalized, configDigest: digestJson(normalized) };
}

export const buildConfigIdentity = buildBenchmarkConfigIdentity;

export function benchmarkConfigDigest(value) {
  const normalized = validateConfigIdentityValue(value);
  return digestJson(normalized);
}

export const configDigest = benchmarkConfigDigest;
export const validateSuite = validateBenchmarkSuite;
export const parseSuite = parseBenchmarkSuite;
export const validateChallenge = validateBenchmarkChallenge;
export const parseChallenge = parseBenchmarkChallenge;
export const validateConfigIdentity = validateBenchmarkConfigIdentity;
export const buildConfigDigest = buildBenchmarkConfigIdentity;

export function isBenchmarkDigest(value) {
  return typeof value === 'string' && BENCHMARK_DIGEST_PATTERN.test(value);
}

export const benchmarkSchemaRoots = Object.freeze({ ...ROOTS });
