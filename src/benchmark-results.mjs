import {
  assertExactKeys,
  assertPlainObject,
  normalizeProjectRelative,
  tinyError,
} from './fs-utils.mjs';
import {
  BENCHMARK_DIGEST_PATTERN,
  BENCHMARK_ROLES,
  BENCHMARK_UNKNOWN,
  benchmarkConfigDigest,
  validateBenchmarkConfigIdentity,
} from './benchmark-schema.mjs';
import { WORKER_OUTCOMES } from './outcomes.mjs';

export const BENCHMARK_RESULTS_SCHEMA_VERSION = 1;
export const BENCHMARK_VERIFIER_STATUSES = Object.freeze(['passed', 'failed', 'unavailable', 'not_run']);
export const BENCHMARK_RESULT_OUTCOMES = Object.freeze([
  ...WORKER_OUTCOMES,
  'setup_error',
  'incomplete',
  'unavailable',
  'not_run',
]);
export const BENCHMARK_PROVENANCE_TYPES = Object.freeze(['benchmark-invocation', 'approved-replay']);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const CHANGE_TYPES = new Set(['created', 'modified', 'deleted', 'type_changed']);
const FORBIDDEN_RESULT_KEYS = new Set(['accepted', 'acceptance', 'qualified', 'qualification', 'isAccepted', 'isQualified']);

function invalid(message, details = undefined) {
  throw tinyError('BENCHMARK_RESULTS_INVALID', message, details);
}

function object(value, label) {
  try {
    const result = assertPlainObject(value, 'BENCHMARK_RESULTS_INVALID', label);
    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must contain plain objects`);
    return result;
  } catch (error) {
    if (error?.code === 'BENCHMARK_RESULTS_INVALID') throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function keys(value, allowed, label) {
  try {
    assertExactKeys(value, allowed, 'BENCHMARK_RESULTS_INVALID', label);
  } catch (error) {
    if (error?.code === 'BENCHMARK_RESULTS_INVALID') throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function string(value, label, { pattern = undefined, allowUnknown = false } = {}) {
  if (allowUnknown && value === BENCHMARK_UNKNOWN) return value;
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) invalid(`${label} must be a nonempty string`);
  return value;
}

function digest(value, label, { allowUnknown = false } = {}) {
  if (allowUnknown && value === BENCHMARK_UNKNOWN) return value;
  if (typeof value !== 'string' || !BENCHMARK_DIGEST_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function integer(value, label, { min = 0, allowUnknown = false } = {}) {
  if (allowUnknown && value === BENCHMARK_UNKNOWN) return value;
  if (!Number.isInteger(value) || value < min) invalid(`${label} must be an integer >= ${min}`);
  return value;
}

function boolean(value, label, { allowUnknown = false } = {}) {
  if (allowUnknown && value === BENCHMARK_UNKNOWN) return value;
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

function nullableInteger(value, label) {
  if (value === BENCHMARK_UNKNOWN || value === null) return value;
  return integer(value, label);
}

function nullableString(value, label) {
  if (value === BENCHMARK_UNKNOWN || value === null) return value;
  return string(value, label);
}

function path(value, label, { root = undefined } = {}) {
  let normalized;
  try {
    normalized = normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (root !== undefined && normalized !== root && !normalized.startsWith(`${root}/`)) invalid(`${label} must be confined to ${root}/`);
  return normalized;
}

function contentRef(value, label) {
  const ref = object(value, label);
  keys(ref, ['path', 'sha256'], label);
  return { path: path(ref.path, `${label}.path`), sha256: digest(ref.sha256, `${label}.sha256`) };
}

function id(value, label) {
  return string(value, label, { pattern: ID_PATTERN });
}

function schemaVersion(value, expected, label) {
  if (value !== expected) invalid(`${label}.schemaVersion must be ${expected}`);
  return expected;
}

function safeMetadata(value, label, seen = new Set()) {
  if (value === BENCHMARK_UNKNOWN || value === null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid(`${label} must not contain cycles`);
    seen.add(value);
    const result = value.map((entry, index) => safeMetadata(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must contain plain objects`);
    if (seen.has(value)) invalid(`${label} must not contain cycles`);
    seen.add(value);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid(`${label}.${key} is not allowed`);
      Object.defineProperty(result, key, {
        value: safeMetadata(entry, `${label}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(value);
    return result;
  }
  invalid(`${label} contains an unsupported value`);
}

function rejectClaims(value, label, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) invalid(`${label} must not contain cycles`);
  seen.add(value);
  if (!Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_RESULT_KEYS.has(key)) invalid(`${label}.${key} is not part of benchmark results`);
      rejectClaims(entry, `${label}.${key}`, seen);
    }
  } else {
    value.forEach((entry, index) => rejectClaims(entry, `${label}[${index}]`, seen));
  }
  seen.delete(value);
}

function suiteReference(value, label) {
  const ref = object(value, label);
  keys(ref, ['id', 'version', 'sha256'], label);
  return {
    id: id(ref.id, `${label}.id`),
    version: string(ref.version, `${label}.version`),
    sha256: digest(ref.sha256, `${label}.sha256`),
  };
}

function challengeReference(value, label) {
  return suiteReference(value, label);
}

function validatePacketDigests(value, label) {
  const packet = object(value, label);
  keys(packet, ['briefSha256', 'contextSha256', 'checksSha256', 'profileSha256', 'fixtureSha256'], label);
  return {
    briefSha256: digest(packet.briefSha256, `${label}.briefSha256`, { allowUnknown: true }),
    contextSha256: digest(packet.contextSha256, `${label}.contextSha256`, { allowUnknown: true }),
    checksSha256: digest(packet.checksSha256, `${label}.checksSha256`, { allowUnknown: true }),
    profileSha256: digest(packet.profileSha256, `${label}.profileSha256`, { allowUnknown: true }),
    fixtureSha256: digest(packet.fixtureSha256, `${label}.fixtureSha256`, { allowUnknown: true }),
  };
}

function validateProvenance(value, label) {
  const provenance = object(value, label);
  keys(provenance, ['type', 'source', 'suiteSha256', 'packetSha256', 'profileSha256', 'workerResultSha256'], label);
  if (!BENCHMARK_PROVENANCE_TYPES.includes(provenance.type)) invalid(`${label}.type must be benchmark-invocation or approved-replay`);
  return {
    type: provenance.type,
    source: string(provenance.source, `${label}.source`),
    suiteSha256: digest(provenance.suiteSha256, `${label}.suiteSha256`),
    packetSha256: digest(provenance.packetSha256, `${label}.packetSha256`, { allowUnknown: true }),
    profileSha256: digest(provenance.profileSha256, `${label}.profileSha256`, { allowUnknown: true }),
    workerResultSha256: digest(provenance.workerResultSha256, `${label}.workerResultSha256`, { allowUnknown: true }),
  };
}

function bindKnown(label, left, right) {
  if (left === BENCHMARK_UNKNOWN || right === BENCHMARK_UNKNOWN) {
    if (left !== right) invalid(`${label} must use UNKNOWN consistently`);
    return;
  }
  if (left !== right) invalid(`${label} does not match`);
}

function validateCaseBindings(result) {
  const identity = result.configIdentity;
  if (identity === undefined) invalid('benchmark case result.configIdentity is required to bind configDigest');
  bindKnown('benchmark case result suite id', result.suite.id, identity.suite.id);
  bindKnown('benchmark case result suite version', result.suite.version, identity.suite.version);
  bindKnown('benchmark case result suite digest', result.suite.sha256, identity.suite.contentSha256);
  bindKnown('benchmark case result provenance suite digest', result.provenance.suiteSha256, result.suite.sha256);
  bindKnown('benchmark case result profile digest', result.provenance.profileSha256, result.packet.profileSha256);
  bindKnown('benchmark case result profile identity', result.packet.profileSha256, identity.worker.profileDigest);
  const resultArtifact = result.artifacts.result;
  if (resultArtifact !== undefined && resultArtifact !== BENCHMARK_UNKNOWN) {
    bindKnown('benchmark case result artifact digest', result.provenance.workerResultSha256, resultArtifact.sha256);
  }
  const packetArtifact = result.artifacts.packet;
  if (packetArtifact !== undefined && packetArtifact !== BENCHMARK_UNKNOWN) {
    bindKnown('benchmark case result packet artifact digest', result.provenance.packetSha256, packetArtifact.sha256);
  }
}

function validatePathChanges(value, label, { violations = false } = {}) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const change = object(entry, itemLabel);
    const allowed = violations ? ['path', 'change', 'reason'] : ['path', 'change', 'before', 'after'];
    keys(change, allowed, itemLabel);
    if (!CHANGE_TYPES.has(change.change)) invalid(`${itemLabel}.change is invalid`);
    const normalized = {
      path: path(change.path, `${itemLabel}.path`),
      change: string(change.change, `${itemLabel}.change`),
    };
    if (violations) normalized.reason = string(change.reason, `${itemLabel}.reason`);
    if (!violations && change.before !== undefined) normalized.before = safeMetadata(change.before, `${itemLabel}.before`);
    if (!violations && change.after !== undefined) normalized.after = safeMetadata(change.after, `${itemLabel}.after`);
    return normalized;
  });
}

function validateArtifactMap(value, label) {
  const artifacts = object(value, label);
  const result = {};
  for (const [name, entry] of Object.entries(artifacts)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) invalid(`${label} contains an invalid artifact name: ${name}`);
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') invalid(`${label}.${name} is not allowed`);
    if (entry === BENCHMARK_UNKNOWN) {
      Object.defineProperty(result, name, { value: BENCHMARK_UNKNOWN, enumerable: true, configurable: true, writable: true });
      continue;
    }
    Object.defineProperty(result, name, {
      value: contentRef(entry, `${label}.${name}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateSandbox(value, label) {
  if (value === BENCHMARK_UNKNOWN) return value;
  const sandbox = object(value, label);
  if (Object.keys(sandbox).length === 0) invalid(`${label} must contain meaningful sandbox metadata`);
  return safeMetadata(sandbox, label);
}

function validateVerifierRecord(value, label) {
  const record = object(value, label);
  keys(record, ['checkId', 'definitionSha256', 'status', 'exitCode', 'signal', 'timedOut', 'durationMs', 'output', 'sandbox'], label);
  const checkId = id(record.checkId, `${label}.checkId`);
  const definitionSha256 = digest(record.definitionSha256, `${label}.definitionSha256`);
  if (!BENCHMARK_VERIFIER_STATUSES.includes(record.status)) invalid(`${label}.status is invalid`);
  const output = object(record.output, `${label}.output`);
  keys(output, ['ref', 'sha256', 'truncated'], `${label}.output`);
  const normalized = {
    checkId,
    definitionSha256,
    status: record.status,
    exitCode: nullableInteger(record.exitCode, `${label}.exitCode`),
    signal: nullableString(record.signal, `${label}.signal`),
    timedOut: boolean(record.timedOut, `${label}.timedOut`, { allowUnknown: true }),
    durationMs: integer(record.durationMs, `${label}.durationMs`, { allowUnknown: true }),
    output: {
      ref: record.output.ref === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : path(record.output.ref, `${label}.output.ref`),
      sha256: digest(output.sha256, `${label}.output.sha256`, { allowUnknown: true }),
      truncated: boolean(output.truncated, `${label}.output.truncated`, { allowUnknown: true }),
    },
    sandbox: validateSandbox(record.sandbox, `${label}.sandbox`),
  };
  const unknownExecution = normalized.exitCode === BENCHMARK_UNKNOWN
    && (normalized.signal === BENCHMARK_UNKNOWN || normalized.signal === null)
    && normalized.timedOut === BENCHMARK_UNKNOWN
    && normalized.durationMs === BENCHMARK_UNKNOWN;
  const greenExecution = normalized.exitCode === 0
    && normalized.signal === null
    && normalized.timedOut === false;
  if (normalized.status === 'passed') {
    if (!greenExecution || normalized.durationMs === BENCHMARK_UNKNOWN || normalized.sandbox === BENCHMARK_UNKNOWN
      || normalized.output.ref === BENCHMARK_UNKNOWN || normalized.output.sha256 === BENCHMARK_UNKNOWN) {
      invalid(`${label}.passed requires successful execution evidence`);
    }
  } else if (normalized.status === 'failed') {
    const failedExecution = (Number.isInteger(normalized.exitCode) && normalized.exitCode !== 0)
      || (typeof normalized.signal === 'string' && normalized.signal !== BENCHMARK_UNKNOWN)
      || normalized.timedOut === true;
    if (!failedExecution || unknownExecution) invalid(`${label}.failed requires failure execution evidence`);
  } else if (normalized.status === 'unavailable') {
    if (greenExecution && normalized.sandbox !== BENCHMARK_UNKNOWN) invalid(`${label}.unavailable must not contain green execution evidence`);
  } else if (normalized.status === 'not_run') {
    if (!unknownExecution || normalized.sandbox !== BENCHMARK_UNKNOWN || normalized.output.ref !== BENCHMARK_UNKNOWN || normalized.output.sha256 !== BENCHMARK_UNKNOWN) {
      invalid(`${label}.not_run must not contain execution evidence`);
    }
  }
  return normalized;
}

function validateVerifierRecords(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seen = new Set();
  return value.map((entry, index) => {
    const record = validateVerifierRecord(entry, `${label}[${index}]`);
    if (seen.has(record.checkId)) invalid(`${label} contains duplicate check id: ${record.checkId}`);
    seen.add(record.checkId);
    return record;
  });
}

function validateHardGates(value, label) {
  const gates = object(value, label);
  keys(gates, ['outOfScopeEdit', 'protectedFileEdit', 'protectedTestEdit', 'requiredPatchAbsent'], label);
  return {
    outOfScopeEdit: boolean(gates.outOfScopeEdit, `${label}.outOfScopeEdit`),
    protectedFileEdit: boolean(gates.protectedFileEdit, `${label}.protectedFileEdit`),
    protectedTestEdit: boolean(gates.protectedTestEdit, `${label}.protectedTestEdit`),
    requiredPatchAbsent: boolean(gates.requiredPatchAbsent, `${label}.requiredPatchAbsent`, { allowUnknown: true }),
  };
}

function validateMissingReasons(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seen = new Set();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = object(entry, itemLabel);
    keys(item, ['field', 'reason'], itemLabel);
    const field = string(item.field, `${itemLabel}.field`);
    if (seen.has(field)) invalid(`${label} contains duplicate field: ${field}`);
    seen.add(field);
    return { field, reason: string(item.reason, `${itemLabel}.reason`) };
  });
}

function validateFailure(value, label) {
  const failure = object(value, label);
  keys(failure, ['category', 'missing'], label);
  return {
    category: string(failure.category, `${label}.category`, { allowUnknown: true }),
    missing: validateMissingReasons(failure.missing, `${label}.missing`),
  };
}

export function validateBenchmarkCaseResult(value) {
  const result = object(value, 'benchmark case result');
  rejectClaims(result, 'benchmark case result');
  keys(result, [
    'schemaVersion', 'suite', 'challenge', 'role', 'difficultyTags', 'repetition', 'attemptId', 'workerRunId',
    'configDigest', 'configIdentity', 'provenance', 'packet', 'taskShape', 'outcome', 'observed', 'limitDetails',
    'changedPaths', 'scopeViolations', 'artifacts', 'verifier', 'hardGates', 'failure',
  ], 'benchmark case result');
  schemaVersion(result.schemaVersion, BENCHMARK_RESULTS_SCHEMA_VERSION, 'benchmark case result');
  const role = string(result.role, 'benchmark case result.role');
  if (!BENCHMARK_ROLES.includes(role)) invalid('benchmark case result.role is invalid');
  const difficultyTags = Array.isArray(result.difficultyTags)
    ? result.difficultyTags.map((tag, index) => string(tag, `benchmark case result.difficultyTags[${index}]`))
    : invalid('benchmark case result.difficultyTags must be an array');
  const tagSet = new Set(difficultyTags);
  if (tagSet.size !== difficultyTags.length) invalid('benchmark case result.difficultyTags contains duplicates');
  const normalized = {
    schemaVersion: BENCHMARK_RESULTS_SCHEMA_VERSION,
    suite: suiteReference(result.suite, 'benchmark case result.suite'),
    challenge: challengeReference(result.challenge, 'benchmark case result.challenge'),
    role,
    difficultyTags,
    repetition: integer(result.repetition, 'benchmark case result.repetition', { min: 1 }),
    attemptId: id(result.attemptId, 'benchmark case result.attemptId'),
    workerRunId: string(result.workerRunId, 'benchmark case result.workerRunId', { allowUnknown: true }),
    configDigest: digest(result.configDigest, 'benchmark case result.configDigest'),
    ...(result.configIdentity === undefined ? {} : { configIdentity: validateBenchmarkConfigIdentity(result.configIdentity) }),
    provenance: validateProvenance(result.provenance, 'benchmark case result.provenance'),
    packet: validatePacketDigests(result.packet, 'benchmark case result.packet'),
    taskShape: result.taskShape === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : safeMetadata(result.taskShape, 'benchmark case result.taskShape'),
    outcome: string(result.outcome, 'benchmark case result.outcome'),
    observed: result.observed === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : safeMetadata(result.observed, 'benchmark case result.observed'),
    limitDetails: result.limitDetails === BENCHMARK_UNKNOWN ? BENCHMARK_UNKNOWN : safeMetadata(result.limitDetails, 'benchmark case result.limitDetails'),
    changedPaths: validatePathChanges(result.changedPaths, 'benchmark case result.changedPaths'),
    scopeViolations: validatePathChanges(result.scopeViolations, 'benchmark case result.scopeViolations', { violations: true }),
    artifacts: validateArtifactMap(result.artifacts, 'benchmark case result.artifacts'),
    verifier: (() => {
      const verifier = object(result.verifier, 'benchmark case result.verifier');
      keys(verifier, ['visible', 'heldOut'], 'benchmark case result.verifier');
      const visible = validateVerifierRecords(verifier.visible, 'benchmark case result.verifier.visible');
      const heldOut = validateVerifierRecords(verifier.heldOut, 'benchmark case result.verifier.heldOut');
      const ids = new Set(visible.map((entry) => entry.checkId));
      for (const entry of heldOut) {
        if (ids.has(entry.checkId)) invalid(`benchmark case result.verifier contains duplicate check id: ${entry.checkId}`);
        ids.add(entry.checkId);
      }
      return { visible, heldOut };
    })(),
    hardGates: validateHardGates(result.hardGates, 'benchmark case result.hardGates'),
    failure: validateFailure(result.failure, 'benchmark case result.failure'),
  };
  if (normalized.configIdentity !== undefined && benchmarkConfigDigest(normalized.configIdentity) !== normalized.configDigest) {
    invalid('benchmark case result.configDigest does not match configIdentity');
  }
  validateCaseBindings(normalized);
  if (!BENCHMARK_RESULT_OUTCOMES.includes(normalized.outcome)) invalid(`benchmark case result.outcome is unsupported: ${normalized.outcome}`);
  return normalized;
}

export function parseBenchmarkCaseResult(text) {
  if (typeof text !== 'string') invalid('benchmark case result must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`benchmark case result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkCaseResult(value);
}

function validateSummaryCounts(value, label) {
  const counts = object(value, label);
  const normalized = {
    scheduled: integer(counts.scheduled, `${label}.scheduled`),
    completed: integer(counts.completed, `${label}.completed`),
    incomplete: integer(counts.incomplete, `${label}.incomplete`),
    failed: integer(counts.failed, `${label}.failed`),
    unavailable: integer(counts.unavailable, `${label}.unavailable`),
    notRun: integer(counts.notRun, `${label}.notRun`),
  };
  const total = normalized.completed + normalized.incomplete + normalized.failed + normalized.unavailable + normalized.notRun;
  if (total !== normalized.scheduled) invalid(`${label} categories must sum to scheduled`);
  return normalized;
}

function validateArtifactRefs(value, label, { uniqueByPath = false } = {}) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seen = new Set();
  return value.map((entry, index) => {
    const ref = contentRef(entry, `${label}[${index}]`);
    if (uniqueByPath) {
      if (seen.has(ref.path)) invalid(`${label} contains duplicate path: ${ref.path}`);
      seen.add(ref.path);
    }
    return ref;
  });
}

export function validateBenchmarkSummary(value) {
  const summary = object(value, 'benchmark summary');
  rejectClaims(summary, 'benchmark summary');
  keys(summary, ['schemaVersion', 'suite', 'configDigest', 'groups', 'artifacts'], 'benchmark summary');
  schemaVersion(summary.schemaVersion, BENCHMARK_RESULTS_SCHEMA_VERSION, 'benchmark summary');
  const groups = Array.isArray(summary.groups) ? summary.groups : invalid('benchmark summary.groups must be an array');
  const seen = new Set();
  const casePaths = new Set();
  const normalizedGroups = groups.map((entry, index) => {
    const label = `benchmark summary.groups[${index}]`;
    const group = object(entry, label);
    keys(group, ['role', 'configDigest', 'scheduled', 'completed', 'incomplete', 'failed', 'unavailable', 'notRun', 'caseResults'], label);
    const role = string(group.role, `${label}.role`);
    if (!BENCHMARK_ROLES.includes(role)) invalid(`${label}.role is invalid`);
    const configDigest = digest(group.configDigest, `${label}.configDigest`);
    const key = `${role}\0${configDigest}`;
    if (seen.has(key)) invalid(`benchmark summary.groups contains duplicate group: ${role}/${configDigest}`);
    seen.add(key);
    const counts = validateSummaryCounts(group, label);
    const caseResults = validateArtifactRefs(group.caseResults, `${label}.caseResults`, { uniqueByPath: true });
    if (caseResults.length !== counts.scheduled) invalid(`${label}.caseResults must contain one reference per scheduled attempt`);
    for (const result of caseResults) {
      if (casePaths.has(result.path)) invalid(`benchmark summary.caseResults contains duplicate path: ${result.path}`);
      casePaths.add(result.path);
    }
    return { role, configDigest, ...counts, caseResults };
  });
  const normalized = {
    schemaVersion: BENCHMARK_RESULTS_SCHEMA_VERSION,
    suite: suiteReference(summary.suite, 'benchmark summary.suite'),
    configDigest: digest(summary.configDigest, 'benchmark summary.configDigest'),
    groups: normalizedGroups,
    artifacts: validateArtifactRefs(summary.artifacts, 'benchmark summary.artifacts', { uniqueByPath: true }),
  };
  if (normalizedGroups.some((group) => group.configDigest !== normalized.configDigest)) {
    invalid('benchmark summary group configDigest must match the summary configDigest');
  }
  return normalized;
}

export function parseBenchmarkSummary(text) {
  if (typeof text !== 'string') invalid('benchmark summary must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`benchmark summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkSummary(value);
}

function validateInvocationWorker(value, label) {
  const worker = object(value, label);
  keys(worker, ['name', 'profileSha256'], label);
  return {
    name: id(worker.name, `${label}.name`),
    profileSha256: digest(worker.profileSha256, `${label}.profileSha256`, { allowUnknown: true }),
  };
}

function validateInvocationBindings(invocation) {
  bindKnown('benchmark invocation suite id', invocation.suite.id, invocation.configIdentity.suite.id);
  bindKnown('benchmark invocation suite version', invocation.suite.version, invocation.configIdentity.suite.version);
  bindKnown('benchmark invocation suite digest', invocation.suite.sha256, invocation.configIdentity.suite.contentSha256);
  bindKnown('benchmark invocation worker profile', invocation.worker.profileSha256, invocation.configIdentity.worker.profileDigest);
}

export function validateBenchmarkInvocation(value) {
  const invocation = object(value, 'benchmark invocation');
  rejectClaims(invocation, 'benchmark invocation');
  keys(invocation, [
    'schemaVersion', 'invocationId', 'suite', 'configDigest', 'configIdentity', 'worker', 'repeat',
    'startedAt', 'completedAt', 'caseResults', 'summary',
  ], 'benchmark invocation');
  schemaVersion(invocation.schemaVersion, BENCHMARK_RESULTS_SCHEMA_VERSION, 'benchmark invocation');
  const startedAt = string(invocation.startedAt, 'benchmark invocation.startedAt', { allowUnknown: true });
  const completedAt = string(invocation.completedAt, 'benchmark invocation.completedAt', { allowUnknown: true });
  const normalized = {
    schemaVersion: BENCHMARK_RESULTS_SCHEMA_VERSION,
    invocationId: id(invocation.invocationId, 'benchmark invocation.invocationId'),
    suite: suiteReference(invocation.suite, 'benchmark invocation.suite'),
    configDigest: digest(invocation.configDigest, 'benchmark invocation.configDigest'),
    configIdentity: validateBenchmarkConfigIdentity(invocation.configIdentity),
    worker: validateInvocationWorker(invocation.worker, 'benchmark invocation.worker'),
    repeat: integer(invocation.repeat, 'benchmark invocation.repeat', { min: 1 }),
    startedAt,
    completedAt,
    caseResults: validateArtifactRefs(invocation.caseResults, 'benchmark invocation.caseResults', { uniqueByPath: true }),
    summary: contentRef(invocation.summary, 'benchmark invocation.summary'),
  };
  if (benchmarkConfigDigest(normalized.configIdentity) !== normalized.configDigest) {
    invalid('benchmark invocation.configDigest does not match configIdentity');
  }
  validateInvocationBindings(normalized);
  return normalized;
}

export function parseBenchmarkInvocation(text) {
  if (typeof text !== 'string') invalid('benchmark invocation must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`benchmark invocation is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkInvocation(value);
}

export const validateBenchmarkResults = validateBenchmarkCaseResult;
export const parseBenchmarkResults = parseBenchmarkCaseResult;
export const validateCaseResult = validateBenchmarkCaseResult;
export const parseCaseResult = parseBenchmarkCaseResult;
export const validateSuiteSummary = validateBenchmarkSummary;
export const parseSuiteSummary = parseBenchmarkSummary;
export const validateInvocationManifest = validateBenchmarkInvocation;
export const parseInvocationManifest = parseBenchmarkInvocation;
