import {
  assertExactKeys,
  assertPlainObject,
  normalizeProjectRelative,
  tinyError,
} from './fs-utils.mjs';
import {
  BENCHMARK_DIGEST_PATTERN,
  BENCHMARK_ROLES,
  benchmarkConfigDigest,
  validateBenchmarkConfigIdentity,
} from './benchmark-schema.mjs';
import { validateBenchmarkCaseResult } from './benchmark-results.mjs';

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const QUALIFICATION_METHOD = 'wilson';
export const QUALIFICATION_SIDES = 'two-sided';
export const QUALIFICATION_CONFIDENCE = 0.95;
export const QUALIFICATION_Z = 1.959963984540054;
export const DEFAULT_QUALIFICATION_TARGET = 0.8;
export const QUALIFICATION_STATUSES = Object.freeze([
  'qualified',
  'not_qualified',
  'insufficient_evidence',
]);

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const REASON_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function invalid(message, details = undefined) {
  throw tinyError('QUALIFICATION_INVALID', message, details);
}

function object(value, label) {
  try {
    const result = assertPlainObject(value, 'QUALIFICATION_INVALID', label);
    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
    return result;
  } catch (error) {
    if (error?.code === 'QUALIFICATION_INVALID') throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function keys(value, allowed, label) {
  try {
    assertExactKeys(value, allowed, 'QUALIFICATION_INVALID', label);
  } catch (error) {
    if (error?.code === 'QUALIFICATION_INVALID') throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function string(value, label, { pattern = undefined } = {}) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    invalid(`${label} must be a nonempty string`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !BENCHMARK_DIGEST_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a safe nonnegative integer`);
  return value;
}

function probability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${label} must be a finite number from 0 to 1`);
  }
  return value;
}

function target(value, label = 'target') {
  return probability(value, label);
}

function closeEnough(left, right) {
  return Object.is(left, right) || Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function pathReference(value, label) {
  let normalized;
  try {
    normalized = normalizeProjectRelative(value, label, { tinysddArtifactPrefix: '.tinysdd/' });
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  return normalized;
}

function contentReference(value, label) {
  const ref = object(value, label);
  keys(ref, ['path', 'sha256'], label);
  return { path: pathReference(ref.path, `${label}.path`), sha256: digest(ref.sha256, `${label}.sha256`) };
}

function validateSuite(value, label = 'qualification suite') {
  const suite = object(value, label);
  keys(suite, ['id', 'version', 'sha256'], label);
  return {
    id: string(suite.id, `${label}.id`, { pattern: ID_PATTERN }),
    version: string(suite.version, `${label}.version`),
    sha256: digest(suite.sha256, `${label}.sha256`),
  };
}

function validateSource(value) {
  const source = object(value, 'qualification source');
  keys(source, ['invocations', 'cases'], 'qualification source');
  const references = (entries, label) => {
    if (!Array.isArray(entries)) invalid(`${label} must be an array`);
    const seen = new Set();
    return entries.map((entry, index) => {
      const ref = contentReference(entry, `${label}[${index}]`);
      if (seen.has(ref.path)) invalid(`${label} contains duplicate path: ${ref.path}`);
      seen.add(ref.path);
      return ref;
    });
  };
  return {
    invocations: references(source.invocations, 'qualification source.invocations'),
    cases: references(source.cases, 'qualification source.cases'),
  };
}

function defaultSource() {
  return { invocations: [], cases: [] };
}

function validateTargets(value, label = 'qualification targets') {
  if (value === undefined) return {};
  const values = object(value, label);
  const result = {};
  for (const [role, valueForRole] of Object.entries(values)) {
    if (!BENCHMARK_ROLES.includes(role)) invalid(`${label} contains unsupported role: ${role}`);
    result[role] = target(valueForRole, `${label}.${role}`);
  }
  return result;
}

function targetForRole(role, overrides) {
  return overrides[role] ?? DEFAULT_QUALIFICATION_TARGET;
}

function validateCounts(n, passes, label = 'qualification counts') {
  count(n, `${label}.n`);
  count(passes, `${label}.passes`);
  if (passes > n) invalid(`${label}.passes must not exceed n`);
  return { n, passes };
}

/**
 * Calculate a two-sided Wilson interval. With no observations the interval is
 * deliberately [0, 1], so an empty sample can never qualify or rule out a
 * role. Counts are limited to safe integers because they are persisted.
 */
export function wilsonInterval(n, passes, { confidence = QUALIFICATION_CONFIDENCE, z = QUALIFICATION_Z } = {}) {
  validateCounts(n, passes);
  if (confidence !== QUALIFICATION_CONFIDENCE) invalid(`confidence must be ${QUALIFICATION_CONFIDENCE}`);
  if (z !== QUALIFICATION_Z) invalid(`z must be ${QUALIFICATION_Z}`);
  if (n === 0) return { lowerBound: 0, upperBound: 1 };
  const zSquared = z * z;
  const phat = passes / n;
  const denominator = 1 + zSquared / n;
  const center = (phat + zSquared / (2 * n)) / denominator;
  const halfWidth = z * Math.sqrt((phat * (1 - phat) / n) + (zSquared / (4 * n * n))) / denominator;
  const lowerBound = Math.max(0, center - halfWidth);
  const upperBound = Math.min(1, center + halfWidth);
  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) invalid('Wilson interval is not finite');
  return { lowerBound, upperBound };
}

function statusFor(n, lowerBound, upperBound, targetValue) {
  if (n === 0) return 'insufficient_evidence';
  if (lowerBound >= targetValue) return 'qualified';
  if (upperBound < targetValue) return 'not_qualified';
  return 'insufficient_evidence';
}

function addCounts(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left > MAX_SAFE_COUNT - right) return null;
  return left + right;
}

function unavailable(reason) {
  return { count: null, reason };
}

function minimumExtraPasses(n, passes, targetValue, lowerBound) {
  if (lowerBound >= targetValue && n > 0) return { count: 0, reason: 'already_qualified' };
  // A finite Wilson lower bound cannot reach one, even with every future
  // observation passing. Avoid depending on floating-point rounding at the
  // largest representable count for this endpoint.
  if (targetValue === 1) return unavailable('no_finite_solution');

  const reaches = (extra) => {
    const prospectiveN = addCounts(n, extra);
    const prospectivePasses = addCounts(passes, extra);
    if (prospectiveN === null || prospectivePasses === null) return false;
    return wilsonInterval(prospectiveN, prospectivePasses).lowerBound >= targetValue;
  };

  let high = 1;
  while (!reaches(high)) {
    if (high >= MAX_SAFE_COUNT - n) return unavailable('no_finite_solution');
    const doubled = high > Math.floor((MAX_SAFE_COUNT - n) / 2)
      ? MAX_SAFE_COUNT - n
      : high * 2;
    if (doubled <= high) return unavailable('no_finite_solution');
    high = doubled;
  }
  let low = 0;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (reaches(middle)) high = middle;
    else low = middle;
  }
  return { count: high, reason: null };
}

function minimumExtraFailures(n, passes, targetValue, upperBound) {
  if (upperBound < targetValue) return { count: 0, reason: 'already_not_qualified' };
  // An upper Wilson bound is never below zero. This endpoint is therefore
  // unreachable for a finite number of failures.
  if (targetValue === 0) return unavailable('no_finite_solution');

  const reaches = (extra) => {
    const prospectiveN = addCounts(n, extra);
    if (prospectiveN === null) return false;
    return wilsonInterval(prospectiveN, passes).upperBound < targetValue;
  };

  let high = 1;
  while (!reaches(high)) {
    if (high >= MAX_SAFE_COUNT - n) return unavailable('no_finite_solution');
    const doubled = high > Math.floor((MAX_SAFE_COUNT - n) / 2)
      ? MAX_SAFE_COUNT - n
      : high * 2;
    if (doubled <= high) return unavailable('no_finite_solution');
    high = doubled;
  }
  let low = 0;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (reaches(middle)) high = middle;
    else low = middle;
  }
  return { count: high, reason: null };
}

function resultEntry(value, label) {
  const result = object(value, label);
  keys(result, ['attemptId', 'repetition', 'passed'], label);
  return {
    attemptId: string(result.attemptId, `${label}.attemptId`, { pattern: ID_PATTERN }),
    repetition: (() => {
      const repetition = count(result.repetition, `${label}.repetition`);
      if (repetition < 1) invalid(`${label}.repetition must be at least 1`);
      return repetition;
    })(),
    passed: result.passed === true || result.passed === false
      ? result.passed
      : invalid(`${label}.passed must be a boolean`),
  };
}

function normalizePerChallenge(value, label = 'qualification perChallenge') {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seenChallenges = new Set();
  const seenAttempts = new Set();
  const normalized = value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const challenge = object(entry, itemLabel);
    keys(challenge, ['id', 'version', 'sha256', 'n', 'passes', 'results'], itemLabel);
    const id = string(challenge.id, `${itemLabel}.id`, { pattern: ID_PATTERN });
    const version = string(challenge.version, `${itemLabel}.version`);
    const sha256 = digest(challenge.sha256, `${itemLabel}.sha256`);
    const key = `${id}\0${version}\0${sha256}`;
    if (seenChallenges.has(key)) invalid(`${label} contains duplicate challenge: ${id}`);
    seenChallenges.add(key);
    const n = count(challenge.n, `${itemLabel}.n`);
    const passes = count(challenge.passes, `${itemLabel}.passes`);
    validateCounts(n, passes, itemLabel);
    if (!Array.isArray(challenge.results)) invalid(`${itemLabel}.results must be an array`);
    if (challenge.results.length !== n) invalid(`${itemLabel}.results length must equal n`);
    const results = challenge.results.map((entryForResult, resultIndex) => {
      const result = resultEntry(entryForResult, `${itemLabel}.results[${resultIndex}]`);
      if (seenAttempts.has(result.attemptId)) invalid(`qualification results contain duplicate attemptId: ${result.attemptId}`);
      seenAttempts.add(result.attemptId);
      return result;
    });
    const derivedPasses = results.reduce((sum, result) => sum + (result.passed ? 1 : 0), 0);
    if (derivedPasses !== passes) invalid(`${itemLabel}.passes does not match results`);
    return { id, version, sha256, n, passes, results };
  });
  return normalized;
}

function buildRoleScore({ n, passes, target: targetValue = DEFAULT_QUALIFICATION_TARGET, perChallenge = [] }) {
  validateCounts(n, passes);
  const targetNumber = target(targetValue);
  const interval = wilsonInterval(n, passes);
  const status = statusFor(n, interval.lowerBound, interval.upperBound, targetNumber);
  const passesResult = minimumExtraPasses(n, passes, targetNumber, interval.lowerBound);
  const failuresResult = minimumExtraFailures(n, passes, targetNumber, interval.upperBound);
  return {
    n,
    passes,
    lowerBound: interval.lowerBound,
    upperBound: interval.upperBound,
    confidence: QUALIFICATION_CONFIDENCE,
    target: targetNumber,
    status,
    passesToQualify: passesResult.count,
    passesToQualifyReason: passesResult.reason,
    failuresToRuleOut: failuresResult.count,
    failuresToRuleOutReason: failuresResult.reason,
    perChallenge: normalizePerChallenge(perChallenge),
  };
}

export function scoreRoleCounts({ n, passes, target: targetValue = DEFAULT_QUALIFICATION_TARGET, perChallenge = [] }) {
  return buildRoleScore({ n, passes, target: targetValue, perChallenge });
}

export const scoreRole = scoreRoleCounts;

function casePasses(caseResult) {
  if (caseResult.outcome !== 'completed') return false;
  if (!Array.isArray(caseResult.verifier.visible) || caseResult.verifier.visible.length === 0) return false;
  if (!Array.isArray(caseResult.verifier.heldOut) || caseResult.verifier.heldOut.length === 0) return false;
  const checks = [...caseResult.verifier.visible, ...caseResult.verifier.heldOut];
  if (checks.some((check) => check.status !== 'passed')) return false;
  const gates = caseResult.hardGates;
  return gates.outOfScopeEdit === false
    && gates.protectedFileEdit === false
    && gates.protectedTestEdit === false
    && gates.requiredPatchAbsent === false;
}

export function isSuccessfulBenchmarkCase(value) {
  const normalized = validateBenchmarkCaseResult(value);
  return casePasses(normalized);
}

function suiteEqual(left, right) {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

function roleMap(value, label = 'qualification roles') {
  const roles = object(value, label);
  const result = {};
  for (const [role, entry] of Object.entries(roles)) {
    if (!BENCHMARK_ROLES.includes(role)) invalid(`${label} contains unsupported role: ${role}`);
    result[role] = entry;
  }
  return result;
}

function deriveRoleScores(cases, targets) {
  const roleData = new Map();
  const attempts = new Set();
  const identities = new Map();
  const suites = new Map();
  for (const [index, value] of cases.entries()) {
    const result = validateBenchmarkCaseResult(value);
    if (attempts.has(result.attemptId)) invalid(`qualification cases contain duplicate attemptId: ${result.attemptId}`);
    attempts.add(result.attemptId);
    const configDigest = benchmarkConfigDigest(result.configIdentity);
    if (configDigest !== result.configDigest) invalid(`qualification case ${result.attemptId} has an invalid config digest`);
    if (identities.size > 0 && !identities.has(configDigest)) invalid('qualification cases contain mixed config identities');
    const previousIdentity = identities.get(configDigest);
    if (previousIdentity === undefined) identities.set(configDigest, result.configIdentity);
    else if (benchmarkConfigDigest(previousIdentity) !== configDigest) invalid('qualification cases contain mixed config identities');
    const suite = result.suite;
    const suiteKey = `${suite.id}\0${suite.version}\0${suite.sha256}`;
    suites.set(suiteKey, suite);
    if (suites.size > 1) invalid('qualification cases contain mixed suites');
    const role = roleData.get(result.role) ?? new Map();
    const challenge = result.challenge;
    const challengeKey = `${challenge.id}\0${challenge.version}\0${challenge.sha256}`;
    const challengeData = role.get(challengeKey) ?? {
      id: challenge.id,
      version: challenge.version,
      sha256: challenge.sha256,
      n: 0,
      passes: 0,
      results: [],
    };
    const passed = casePasses(result);
    challengeData.n += 1;
    challengeData.passes += passed ? 1 : 0;
    challengeData.results.push({ attemptId: result.attemptId, repetition: result.repetition, passed });
    role.set(challengeKey, challengeData);
    roleData.set(result.role, role);
    if (index === 0) identities.set('selected', result.configIdentity);
  }
  const roles = {};
  for (const [role, challenges] of roleData.entries()) {
    const perChallenge = [...challenges.values()];
    const n = perChallenge.reduce((sum, challenge) => sum + challenge.n, 0);
    const passes = perChallenge.reduce((sum, challenge) => sum + challenge.passes, 0);
    roles[role] = buildRoleScore({ n, passes, target: targetForRole(role, targets), perChallenge });
  }
  return {
    roles,
    configIdentity: identities.get('selected'),
    configDigest: identities.size === 0 ? undefined : [...identities.keys()].find((key) => key !== 'selected'),
    suite: suites.size === 0 ? undefined : [...suites.values()][0],
  };
}

function normalizeRecordInput(input) {
  const source = object(input, 'qualification record input');
  const targets = validateTargets(source.targets ?? source.target);
  if (source.cases !== undefined) {
    if (!Array.isArray(source.cases)) invalid('qualification record input.cases must be an array');
    const derived = deriveRoleScores(source.cases, targets);
    const configIdentity = source.configIdentity === undefined
      ? derived.configIdentity
      : validateBenchmarkConfigIdentity(source.configIdentity);
    const configDigest = source.configDigest === undefined
      ? derived.configDigest ?? (configIdentity === undefined ? undefined : benchmarkConfigDigest(configIdentity))
      : digest(source.configDigest, 'qualification input.configDigest');
    if (configIdentity === undefined || configDigest === undefined) invalid('qualification input requires configIdentity and configDigest when cases is empty');
    if (benchmarkConfigDigest(configIdentity) !== configDigest) invalid('qualification input.configIdentity does not match cases');
    const suite = source.suite === undefined ? derived.suite : validateSuite(source.suite);
    if (suite === undefined) invalid('qualification input requires suite when cases is empty');
    if (derived.suite !== undefined && !suiteEqual(suite, derived.suite)) invalid('qualification input.suite does not match cases');
    return {
      ...source,
      ...derived,
      configIdentity,
      configDigest,
      suite,
      source: source.source === undefined ? defaultSource() : validateSource(source.source),
    };
  }
  if (source.roles === undefined) invalid('qualification record input.cases or roles is required');
  const configIdentity = validateBenchmarkConfigIdentity(source.configIdentity);
  const configDigest = digest(source.configDigest, 'qualification record input.configDigest');
  if (benchmarkConfigDigest(configIdentity) !== configDigest) invalid('qualification record input.configDigest does not match configIdentity');
  const suite = validateSuite(source.suite);
  const roles = roleMap(source.roles);
  const normalizedRoles = {};
  for (const [role, value] of Object.entries(roles)) {
    const entry = object(value, `qualification roles.${role}`);
    const perChallenge = normalizePerChallenge(entry.perChallenge, `qualification roles.${role}.perChallenge`);
    const counts = validateCounts(entry.n, entry.passes, `qualification roles.${role}`);
    const derivedCounts = perChallenge.reduce((result, challenge) => ({
      n: result.n + challenge.n,
      passes: result.passes + challenge.passes,
    }), { n: 0, passes: 0 });
    if (derivedCounts.n !== counts.n || derivedCounts.passes !== counts.passes) invalid(`qualification roles.${role} counts do not match perChallenge`);
    normalizedRoles[role] = buildRoleScore({ ...counts, target: entry.target, perChallenge });
  }
  return {
    ...source,
    configIdentity,
    configDigest,
    suite,
    roles: normalizedRoles,
    source: source.source === undefined ? defaultSource() : validateSource(source.source),
  };
}

function makeRecord({ configIdentity, configDigest, suite, source, roles }) {
  if (configIdentity === undefined) invalid('qualification configIdentity is required');
  const normalizedIdentity = validateBenchmarkConfigIdentity(configIdentity);
  const normalizedDigest = configDigest === undefined ? benchmarkConfigDigest(normalizedIdentity) : digest(configDigest, 'qualification configDigest');
  if (benchmarkConfigDigest(normalizedIdentity) !== normalizedDigest) invalid('qualification configDigest does not match configIdentity');
  if (suite === undefined) invalid('qualification suite is required');
  const normalizedSuite = validateSuite(suite);
  const normalizedRoles = roleMap(roles);
  const result = {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    method: QUALIFICATION_METHOD,
    sides: QUALIFICATION_SIDES,
    confidence: QUALIFICATION_CONFIDENCE,
    z: QUALIFICATION_Z,
    configDigest: normalizedDigest,
    configIdentity: normalizedIdentity,
    suite: normalizedSuite,
    source: source === undefined ? defaultSource() : validateSource(source),
    roles: {},
  };
  for (const [role, entry] of Object.entries(normalizedRoles)) {
    result.roles[role] = buildRoleScore({
      n: entry.n,
      passes: entry.passes,
      target: entry.target,
      perChallenge: entry.perChallenge,
    });
  }
  return validateQualificationRecord(result);
}

export function buildQualificationRecord(input) {
  const normalized = normalizeRecordInput(input);
  return makeRecord(normalized);
}

export const createQualificationRecord = buildQualificationRecord;

function validateRoleScore(value, role) {
  const entry = object(value, `qualification roles.${role}`);
  keys(entry, [
    'n', 'passes', 'lowerBound', 'upperBound', 'confidence', 'target', 'status',
    'passesToQualify', 'passesToQualifyReason', 'failuresToRuleOut', 'failuresToRuleOutReason', 'perChallenge',
  ], `qualification roles.${role}`);
  const counts = validateCounts(entry.n, entry.passes, `qualification roles.${role}`);
  const targetValue = target(entry.target, `qualification roles.${role}.target`);
  const interval = wilsonInterval(counts.n, counts.passes);
  if (!closeEnough(entry.lowerBound, interval.lowerBound) || !closeEnough(entry.upperBound, interval.upperBound)) invalid(`qualification roles.${role} bounds do not match counts`);
  if (entry.confidence !== QUALIFICATION_CONFIDENCE) invalid(`qualification roles.${role}.confidence must be ${QUALIFICATION_CONFIDENCE}`);
  if (!QUALIFICATION_STATUSES.includes(entry.status)) invalid(`qualification roles.${role}.status is invalid`);
  const expectedStatus = statusFor(counts.n, interval.lowerBound, interval.upperBound, targetValue);
  if (entry.status !== expectedStatus) invalid(`qualification roles.${role}.status does not match bounds and target`);
  const normalizedPerChallenge = normalizePerChallenge(entry.perChallenge, `qualification roles.${role}.perChallenge`);
  const derivedCounts = normalizedPerChallenge.reduce((result, challenge) => ({
    n: result.n + challenge.n,
    passes: result.passes + challenge.passes,
  }), { n: 0, passes: 0 });
  if (derivedCounts.n !== counts.n || derivedCounts.passes !== counts.passes) invalid(`qualification roles.${role} counts do not match perChallenge`);
  const passesResult = minimumExtraPasses(counts.n, counts.passes, targetValue, interval.lowerBound);
  const failuresResult = minimumExtraFailures(counts.n, counts.passes, targetValue, interval.upperBound);
  if (entry.passesToQualify !== passesResult.count || entry.passesToQualifyReason !== passesResult.reason) invalid(`qualification roles.${role} passesToQualify does not match counts`);
  if (entry.failuresToRuleOut !== failuresResult.count || entry.failuresToRuleOutReason !== failuresResult.reason) invalid(`qualification roles.${role} failuresToRuleOut does not match counts`);
  if (entry.passesToQualifyReason !== null && !REASON_PATTERN.test(entry.passesToQualifyReason)) invalid(`qualification roles.${role}.passesToQualifyReason is invalid`);
  if (entry.failuresToRuleOutReason !== null && !REASON_PATTERN.test(entry.failuresToRuleOutReason)) invalid(`qualification roles.${role}.failuresToRuleOutReason is invalid`);
  if (entry.passesToQualify !== null) count(entry.passesToQualify, `qualification roles.${role}.passesToQualify`);
  if (entry.failuresToRuleOut !== null) count(entry.failuresToRuleOut, `qualification roles.${role}.failuresToRuleOut`);
  return buildRoleScore({ ...counts, target: targetValue, perChallenge: normalizedPerChallenge });
}

export function validateQualificationRecord(value) {
  const record = object(value, 'qualification record');
  keys(record, [
    'schemaVersion', 'method', 'sides', 'confidence', 'z', 'configDigest', 'configIdentity', 'suite', 'source', 'roles',
  ], 'qualification record');
  if (record.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) invalid(`qualification record.schemaVersion must be ${QUALIFICATION_SCHEMA_VERSION}`);
  if (record.method !== QUALIFICATION_METHOD) invalid(`qualification record.method must be ${QUALIFICATION_METHOD}`);
  if (record.sides !== QUALIFICATION_SIDES) invalid(`qualification record.sides must be ${QUALIFICATION_SIDES}`);
  if (record.confidence !== QUALIFICATION_CONFIDENCE) invalid(`qualification record.confidence must be ${QUALIFICATION_CONFIDENCE}`);
  if (record.z !== QUALIFICATION_Z) invalid(`qualification record.z must be ${QUALIFICATION_Z}`);
  const configIdentity = validateBenchmarkConfigIdentity(record.configIdentity);
  const configDigest = digest(record.configDigest, 'qualification record.configDigest');
  if (benchmarkConfigDigest(configIdentity) !== configDigest) invalid('qualification record.configDigest does not match configIdentity');
  const suite = validateSuite(record.suite);
  const source = validateSource(record.source);
  const roles = roleMap(record.roles);
  const normalizedRoles = {};
  for (const [role, entry] of Object.entries(roles)) normalizedRoles[role] = validateRoleScore(entry, role);
  const attempts = new Set();
  for (const [role, entry] of Object.entries(normalizedRoles)) {
    for (const challenge of entry.perChallenge) {
      for (const result of challenge.results) {
        if (attempts.has(result.attemptId)) invalid(`qualification results contain duplicate attemptId: ${result.attemptId}`);
        attempts.add(result.attemptId);
      }
    }
  }
  return {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    method: QUALIFICATION_METHOD,
    sides: QUALIFICATION_SIDES,
    confidence: QUALIFICATION_CONFIDENCE,
    z: QUALIFICATION_Z,
    configDigest,
    configIdentity,
    suite,
    source,
    roles: normalizedRoles,
  };
}

export function parseQualificationRecord(text) {
  if (typeof text !== 'string') invalid('qualification record must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`qualification record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateQualificationRecord(value);
}

export function rescoreQualificationRecord(record, targets = {}) {
  const normalized = validateQualificationRecord(record);
  const overrides = validateTargets(targets, 'qualification target overrides');
  const roles = {};
  for (const [role, entry] of Object.entries(normalized.roles)) {
    roles[role] = buildRoleScore({
      n: entry.n,
      passes: entry.passes,
      target: overrides[role] ?? entry.target,
      perChallenge: entry.perChallenge,
    });
  }
  return makeRecord({
    configIdentity: normalized.configIdentity,
    configDigest: normalized.configDigest,
    suite: normalized.suite,
    source: normalized.source,
    roles,
  });
}

export const rescoreQualification = rescoreQualificationRecord;

export function aggregateBenchmarkCases(cases, options = {}) {
  if (!Array.isArray(cases)) invalid('qualification cases must be an array');
  const targets = validateTargets(options.targets ?? options.target);
  const derived = deriveRoleScores(cases, targets);
  return {
    roles: derived.roles,
    configIdentity: derived.configIdentity,
    configDigest: derived.configDigest,
    suite: derived.suite,
  };
}

export const scoreBenchmarkCases = aggregateBenchmarkCases;
