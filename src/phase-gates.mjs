import { randomUUID } from 'node:crypto';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compileContext, MAX_CONTEXT_SOURCE_BYTES, parseContextManifest } from './context-compiler.mjs';
import {
  assertExactKeys,
  assertInternalPath,
  assertPlainObject,
  atomicWriteFile,
  canonicalProjectRoot,
  digestJson,
  ensureDirectory,
  normalizeProjectRelative,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
  withExclusiveLock,
} from './fs-utils.mjs';

export const PHASES = Object.freeze([
  'specify',
  'research',
  'plan',
  'slice',
  'write-tests',
  'implement',
  'verify',
  'review',
  'archive',
]);
export const PHASE_GATE_MODES = Object.freeze(['human', 'frontier', 'deterministic', 'auto']);
export const PHASE_DECISIONS = Object.freeze(['approved', 'rejected']);
export const PHASE_LEDGER_SCHEMA_VERSION = 1;
export const PHASE_LEDGER_RELATIVE_PATH = '.tinysdd/runs/phases.jsonl';
export const PHASE_ARTIFACT_PREFIX = '.tinysdd/runs/phase-artifacts/';
export const PHASE_ARTIFACT_MAX_BYTES = 512 * 1024;
export const PHASE_RECORD_MAX_BYTES = 128 * 1024;
export const PHASE_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const PHASE_LEDGER_MAX_RECORDS = 4096;
export const PHASE_PROPOSAL_MAX_BYTES = 256 * 1024;
export const TEST_REVIEW_ROUTES = Object.freeze(['revision', 'escalation', 'unsupported', 'unavailable']);

const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const ID_PATTERN = /^phase-[a-z0-9][a-z0-9-]{0,127}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TEXT_LENGTH = 1024;
const RECORD_KEYS = [
  'schemaVersion',
  'type',
  'id',
  'timestamp',
  'feature',
  'phase',
  'from',
  'to',
  'decision',
  'mode',
  'by',
  'reason',
  'policyDigest',
  'inputs',
  'predecessor',
  'qualification',
  'artifact',
  'recordDigest',
];
const INPUT_KEYS = ['proposal', 'context', 'compiledContext'];
const COMPILED_KEYS = ['manifestSha256', 'compiledSha256', 'bytes', 'resources'];
const RESOURCE_KEYS = ['path', 'startLine', 'endLine', 'purpose', 'excerptSha256', 'excerptBytes'];
const PREDECESSOR_KEYS = ['id', 'phase', 'feature', 'recordDigest'];
const QUALIFICATION_KEYS = ['worker', 'role', 'recordDigest', 'recordPath', 'recordSha256', 'identityDigest'];
const ARTIFACT_KEYS = ['path', 'sha256', 'bytes'];
const TEST_REVIEW_PROVENANCE = Object.freeze(['synthetic', 'caller-declared']);
const TEST_REVIEW_ACTOR_KEYS = ['id', 'role'];

function invalid(message, details = undefined) {
  throw tinyError('PHASE_RECORD_INVALID', message, details);
}

function requireText(value, label, max = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${label} must be nonempty text`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} contains a control character`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function identifier(value, label, pattern = ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function phase(value, label = 'phase') {
  identifier(value, label, new RegExp(`^(?:${PHASES.join('|')})$`, 'u'));
  return value;
}

function mode(value, label = 'mode') {
  if (!PHASE_GATE_MODES.includes(value)) invalid(`${label} must be one of ${PHASE_GATE_MODES.join(', ')}`);
  return value;
}

function configMode(value, label) {
  if (!PHASE_GATE_MODES.includes(value)) throw tinyError('CONFIG_INVALID', `${label} must be one of ${PHASE_GATE_MODES.join(', ')}`);
  return value;
}

function configPhase(value, label) {
  if (typeof value !== 'string' || !PHASES.includes(value)) throw tinyError('CONFIG_INVALID', `${label} must be one of ${PHASES.join(', ')}`);
  return value;
}

function timestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) invalid(`${label} must be an ISO timestamp`);
  return value;
}

function phasePath(value, label, { prefix = undefined } = {}) {
  try {
    return normalizeProjectRelative(value, label, prefix === undefined ? {} : { tinysddArtifactPrefix: prefix });
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { field: label });
  }
}

function inputPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a project-relative path`);
  const prefixes = ['.tinysdd/tasks/', '.tinysdd/research/'];
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  return phasePath(value, label, { prefix });
}

function fileOptions(path) {
  const prefix = ['.tinysdd/tasks/', '.tinysdd/research/'].find((candidate) => path.startsWith(candidate));
  return prefix === undefined ? {} : { tinysddArtifactPrefix: prefix };
}

function pathDigest(value, label) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', label);
  assertExactKeys(value, ['path', 'sha256', 'bytes'], 'PHASE_RECORD_INVALID', label);
  return {
    path: inputPath(value.path, `${label}.path`),
    sha256: digest(value.sha256, `${label}.sha256`),
    bytes: safeBytes(value.bytes, `${label}.bytes`),
  };
}

function safeBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a nonnegative safe integer`);
  return value;
}

function normalizedPolicyGate(value, label) {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  assertExactKeys(value, ['mode', 'producer', 'qualification', 'predecessor'], 'CONFIG_INVALID', label);
  if (value.mode === undefined) throw tinyError('CONFIG_INVALID', `${label}.mode is required`);
  const result = { mode: configMode(value.mode, `${label}.mode`) };
  if (value.producer !== undefined) {
    if (typeof value.producer === 'string') {
      result.producer = { worker: value.producer, role: label.endsWith('.research') ? 'research' : label.split('.').at(-1) };
    } else {
      assertPlainObject(value.producer, 'CONFIG_INVALID', `${label}.producer`);
      assertExactKeys(value.producer, ['worker', 'role'], 'CONFIG_INVALID', `${label}.producer`);
      result.producer = {
        worker: workerName(value.producer.worker, `${label}.producer.worker`),
        role: requireConfigName(value.producer.role ?? (label.endsWith('.research') ? 'research' : label.split('.').at(-1)), `${label}.producer.role`),
      };
    }
    result.producer.worker = workerName(result.producer.worker, `${label}.producer.worker`);
    result.producer.role = requireConfigName(result.producer.role, `${label}.producer.role`);
  }
  if (value.qualification !== undefined) {
    assertPlainObject(value.qualification, 'CONFIG_INVALID', `${label}.qualification`);
    assertExactKeys(value.qualification, ['worker', 'role', 'required'], 'CONFIG_INVALID', `${label}.qualification`);
    const required = value.qualification.required === undefined ? true : value.qualification.required;
    if (typeof required !== 'boolean') throw tinyError('CONFIG_INVALID', `${label}.qualification.required must be boolean`);
    const worker = value.qualification.worker ?? result.producer?.worker;
    const role = value.qualification.role ?? result.producer?.role ?? (label.endsWith('.research') ? 'research' : label.split('.').at(-1));
    if (required && worker === undefined) throw tinyError('CONFIG_INVALID', `${label}.qualification.worker is required`);
    result.qualification = {
      required,
      ...(worker === undefined ? {} : { worker: workerName(worker, `${label}.qualification.worker`) }),
      role: requireConfigName(role, `${label}.qualification.role`),
    };
    if (result.producer !== undefined
      && (result.producer.worker !== result.qualification.worker || result.producer.role !== result.qualification.role)) {
      throw tinyError('CONFIG_INVALID', `${label}.producer must match ${label}.qualification`);
    }
    if (result.producer === undefined && worker !== undefined) result.producer = { worker: result.qualification.worker, role: result.qualification.role };
  }
  if (result.producer !== undefined && result.qualification === undefined) {
    result.qualification = { required: true, worker: result.producer.worker, role: result.producer.role };
  }
  if (value.predecessor !== undefined) {
    if (typeof value.predecessor === 'string') {
      result.predecessor = { phase: configPhase(value.predecessor, `${label}.predecessor`), required: true };
    } else {
      assertPlainObject(value.predecessor, 'CONFIG_INVALID', `${label}.predecessor`);
      assertExactKeys(value.predecessor, ['phase', 'required'], 'CONFIG_INVALID', `${label}.predecessor`);
      const required = value.predecessor.required === undefined ? true : value.predecessor.required;
      if (typeof required !== 'boolean') throw tinyError('CONFIG_INVALID', `${label}.predecessor.required must be boolean`);
      result.predecessor = { phase: configPhase(value.predecessor.phase, `${label}.predecessor.phase`), required };
    }
  }
  if (label.endsWith('.research') && result.producer !== undefined && result.producer.role !== 'research') {
    throw tinyError('CONFIG_INVALID', `${label}.producer.role must be research`);
  }
  if (label.endsWith('.research') && result.qualification !== undefined && result.qualification.role !== 'research') {
    throw tinyError('CONFIG_INVALID', `${label}.qualification.role must be research`);
  }
  if (label.endsWith('.implement')) {
    if (result.mode !== 'human') throw tinyError('CONFIG_INVALID', `${label}.mode must be human because implement uses the existing task approval gate`);
    if (result.producer !== undefined || result.qualification !== undefined || result.predecessor !== undefined) {
      throw tinyError('CONFIG_INVALID', `${label} cannot add producer, qualification, or predecessor requirements to the existing task approval gate`);
    }
  }
  return result;
}

function workerName(value, label) {
  return requireConfigName(value, label);
}

function requireConfigName(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)) {
    throw tinyError('CONFIG_INVALID', `${label} must contain only lowercase letters, digits, hyphens, or underscores`);
  }
  return value;
}

/**
 * Validate the #81 transition contract. It deliberately has no defaults:
 * thresholds, revision limits, and uncertain/unavailable routes are operator
 * policy and cannot be inferred from the existing semantic gate.
 */
export function validateTestReviewPolicy(value, label = 'config.testReview') {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  assertExactKeys(value, ['positiveThreshold', 'revisionLimit', 'uncertainRoute', 'unavailableRoute'], 'CONFIG_INVALID', label);
  if (typeof value.positiveThreshold !== 'number' || !Number.isFinite(value.positiveThreshold) || value.positiveThreshold <= 0 || value.positiveThreshold >= 1) {
    throw tinyError('CONFIG_INVALID', `${label}.positiveThreshold must be a number in (0,1)`);
  }
  if (!Number.isSafeInteger(value.revisionLimit) || value.revisionLimit < 1) throw tinyError('CONFIG_INVALID', `${label}.revisionLimit must be a positive safe integer`);
  for (const key of ['uncertainRoute', 'unavailableRoute']) {
    if (!TEST_REVIEW_ROUTES.includes(value[key])) throw tinyError('CONFIG_INVALID', `${label}.${key} must be one of ${TEST_REVIEW_ROUTES.join(', ')}`);
  }
  return {
    positiveThreshold: value.positiveThreshold,
    revisionLimit: value.revisionLimit,
    uncertainRoute: value.uncertainRoute,
    unavailableRoute: value.unavailableRoute,
  };
}

/** Validate the optional config.phaseGates document without supplying defaults. */
export function validatePhasePolicy(value, label = 'config.phaseGates') {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  const result = {};
  for (const [name, gate] of Object.entries(value)) {
    if (!PHASES.includes(name)) throw tinyError('CONFIG_INVALID', `${label} contains unknown phase: ${name}`);
    result[name] = normalizedPolicyGate(gate, `${label}.${name}`);
  }
  if (Object.keys(result).length === 0) throw tinyError('CONFIG_INVALID', `${label} must configure at least one phase`);
  return result;
}

function inputDigest(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw tinyError('TEST_REVIEW_INVALID', `${label} must be an object`);
  const digestValue = value.inputDigest ?? value.identityDigest;
  if (typeof digestValue !== 'string' || !DIGEST_PATTERN.test(digestValue)) throw tinyError('TEST_REVIEW_INVALID', `${label} must bind an input digest`);
  return digestValue;
}

function reviewActor(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  assertExactKeys(value, TEST_REVIEW_ACTOR_KEYS, 'TEST_REVIEW_INVALID', label);
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.id)) return null;
  if (typeof value.role !== 'string' || value.role.length === 0 || value.role.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.role)) return null;
  return { id: value.id, role: value.role };
}

function reviewProvenance(value) {
  return TEST_REVIEW_PROVENANCE.includes(value) ? value : null;
}

function assessmentIdentity(value) {
  const producer = reviewActor(value.producer, 'assessment.producer');
  if (producer === null) throw tinyError('TEST_REVIEW_IDENTITY_REQUIRED', 'assessment.producer must name the assessment producer');
  const provenance = reviewProvenance(value.provenance);
  if (provenance === null) throw tinyError('TEST_REVIEW_PROVENANCE_REQUIRED', 'assessment.provenance must be synthetic or caller-declared');
  return { producer, provenance };
}

function reviewRequired(assessed, details = {}) {
  return {
    approved: false,
    route: 'review-required',
    inputDigest: assessed.inputDigest,
    producer: assessed.producer,
    provenance: assessed.provenance,
    ...details,
  };
}

/**
 * Route a synthetic #81 assessment without invoking Jev or granting
 * acceptance. Positive assessments always wait for an independent review of
 * the identical bytes; negative assessments get only the configured bounded
 * revision loop, then escalation.
 */
export function transitionTestReview({ policy, assessment, independentReview, revision = 0 } = {}) {
  let configured;
  try {
    configured = validateTestReviewPolicy(policy, 'testReview policy');
  } catch (error) {
    if (error?.code === 'CONFIG_INVALID') throw tinyError('TEST_REVIEW_POLICY_MISSING', error.message);
    throw error;
  }
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) throw tinyError('TEST_REVIEW_INVALID', 'assessment is required');
  const verdict = assessment.verdict;
  if (!['positive', 'negative', 'uncertain', 'unavailable'].includes(verdict)) throw tinyError('TEST_REVIEW_INVALID', 'assessment.verdict is invalid');
  if (!Number.isSafeInteger(revision) || revision < 0) throw tinyError('TEST_REVIEW_INVALID', 'revision must be a nonnegative safe integer');
  const assessedDigest = inputDigest(assessment, 'assessment');
  const assessed = { inputDigest: assessedDigest, ...assessmentIdentity(assessment) };
  if (verdict === 'negative') {
    if (revision < configured.revisionLimit) return { approved: false, route: 'revision', revision, revisionLimit: configured.revisionLimit, inputDigest: assessedDigest, producer: assessed.producer, provenance: assessed.provenance };
    return { approved: false, route: 'escalation', revision, revisionLimit: configured.revisionLimit, inputDigest: assessedDigest, producer: assessed.producer, provenance: assessed.provenance };
  }
  if (verdict === 'positive') {
    if (independentReview === undefined) return { approved: false, route: 'independent-review', inputDigest: assessedDigest, producer: assessed.producer, provenance: assessed.provenance };
    if (!independentReview || typeof independentReview !== 'object' || Array.isArray(independentReview)) throw tinyError('TEST_REVIEW_INVALID', 'independentReview must be an object');
    const reviewedDigest = inputDigest(independentReview, 'independentReview');
    if (reviewedDigest !== assessedDigest) throw tinyError('TEST_REVIEW_INPUT_MISMATCH', 'independent review must use the identical assessed inputs', { assessmentDigest: assessedDigest, reviewDigest: reviewedDigest });
    const reviewer = reviewActor(independentReview.reviewer, 'independentReview.reviewer');
    const provenance = reviewProvenance(independentReview.provenance);
    const strong = independentReview.strength === 'strong' && independentReview.attested === true;
    if (reviewer === null || provenance === null || independentReview.verdict !== 'accepted' || !strong) {
      return reviewRequired(assessed, { reviewer, provenance, requiresIndependentReview: true });
    }
    if (reviewer.id === assessed.producer.id) {
      throw tinyError('TEST_REVIEW_NOT_INDEPENDENT', 'independent reviewer must differ from the assessment producer', { producer: assessed.producer, reviewer });
    }
    return { approved: false, route: 'operator-acceptance', requiresOperator: true, inputDigest: assessedDigest, producer: assessed.producer, reviewer, provenance };
  }
  const route = verdict === 'uncertain' ? configured.uncertainRoute : configured.unavailableRoute;
  return { approved: false, route, inputDigest: assessedDigest, producer: assessed.producer, provenance: assessed.provenance };
}

export const routeTestReview = transitionTestReview;

export function phasePolicyDigest(policy) {
  return policy === undefined ? null : digestJson(validatePhasePolicy(policy));
}

function recordPayload(value) {
  const copy = { ...value };
  delete copy.recordDigest;
  return copy;
}

function predecessorValue(value, label) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', label);
  assertExactKeys(value, PREDECESSOR_KEYS, 'PHASE_RECORD_INVALID', label);
  return {
    id: identifier(value.id, `${label}.id`),
    phase: phase(value.phase, `${label}.phase`),
    feature: identifier(value.feature, `${label}.feature`, FEATURE_PATTERN),
    recordDigest: digest(value.recordDigest, `${label}.recordDigest`),
  };
}

function qualificationValue(value, label) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', label);
  assertExactKeys(value, QUALIFICATION_KEYS, 'PHASE_RECORD_INVALID', label);
  const recordPath = phasePath(value.recordPath, `${label}.recordPath`, { prefix: '.tinysdd/qualifications/' });
  if (!recordPath.endsWith('.json')) invalid(`${label}.recordPath must be a JSON file`);
  return {
    worker: requireConfigName(value.worker, `${label}.worker`),
    role: requireConfigName(value.role, `${label}.role`),
    recordDigest: digest(value.recordDigest, `${label}.recordDigest`),
    recordPath,
    recordSha256: digest(value.recordSha256, `${label}.recordSha256`),
    identityDigest: digest(value.identityDigest, `${label}.identityDigest`),
  };
}

function artifactValue(value, label) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', label);
  assertExactKeys(value, ARTIFACT_KEYS, 'PHASE_RECORD_INVALID', label);
  const path = phasePath(value.path, `${label}.path`, { prefix: PHASE_ARTIFACT_PREFIX });
  return { path, sha256: digest(value.sha256, `${label}.sha256`), bytes: safeBytes(value.bytes, `${label}.bytes`) };
}

function inputsValue(value, label) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', label);
  assertExactKeys(value, INPUT_KEYS, 'PHASE_RECORD_INVALID', label);
  const proposal = pathDigest(value.proposal, `${label}.proposal`);
  const context = pathDigest(value.context, `${label}.context`);
  const compiledContext = (() => {
    assertPlainObject(value.compiledContext, 'PHASE_RECORD_INVALID', `${label}.compiledContext`);
    assertExactKeys(value.compiledContext, COMPILED_KEYS, 'PHASE_RECORD_INVALID', `${label}.compiledContext`);
    const resources = value.compiledContext.resources;
    if (!Array.isArray(resources) || resources.length > 32) invalid(`${label}.compiledContext.resources must contain at most 32 items`);
    const normalized = resources.map((resource, index) => {
      assertPlainObject(resource, 'PHASE_RECORD_INVALID', `${label}.compiledContext.resources[${index}]`);
      assertExactKeys(resource, RESOURCE_KEYS, 'PHASE_RECORD_INVALID', `${label}.compiledContext.resources[${index}]`);
      return {
        path: inputPath(resource.path, `${label}.compiledContext.resources[${index}].path`),
        startLine: positiveInteger(resource.startLine, `${label}.compiledContext.resources[${index}].startLine`),
        endLine: positiveInteger(resource.endLine, `${label}.compiledContext.resources[${index}].endLine`),
        purpose: requireText(resource.purpose, `${label}.compiledContext.resources[${index}].purpose`, 512),
        excerptSha256: digest(resource.excerptSha256, `${label}.compiledContext.resources[${index}].excerptSha256`),
        excerptBytes: safeBytes(resource.excerptBytes, `${label}.compiledContext.resources[${index}].excerptBytes`),
      };
    });
    for (const resource of normalized) if (resource.endLine < resource.startLine) invalid(`${label}.compiledContext resource range is invalid`);
    return {
      manifestSha256: digest(value.compiledContext.manifestSha256, `${label}.compiledContext.manifestSha256`),
      compiledSha256: digest(value.compiledContext.compiledSha256, `${label}.compiledContext.compiledSha256`),
      bytes: safeBytes(value.compiledContext.bytes, `${label}.compiledContext.bytes`),
      resources: normalized,
    };
  })();
  return { proposal, context, compiledContext };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer`);
  return value;
}

/** Normalize and verify an immutable phase ledger record. */
export function normalizePhaseRecord(value) {
  assertPlainObject(value, 'PHASE_RECORD_INVALID', 'phase record');
  assertExactKeys(value, RECORD_KEYS, 'PHASE_RECORD_INVALID', 'phase record');
  if (value.schemaVersion !== PHASE_LEDGER_SCHEMA_VERSION) invalid(`phase record schemaVersion must be ${PHASE_LEDGER_SCHEMA_VERSION}`);
  if (value.type !== 'phase-decision' && value.type !== 'phase-transition') invalid('phase record type is invalid');
  const normalized = {
    schemaVersion: PHASE_LEDGER_SCHEMA_VERSION,
    type: value.type,
    id: identifier(value.id, 'phase record id'),
    timestamp: timestamp(value.timestamp),
    feature: identifier(value.feature, 'phase record feature', FEATURE_PATTERN),
    phase: phase(value.phase, 'phase record phase'),
    decision: value.decision,
    mode: mode(value.mode, 'phase record mode'),
    by: requireText(value.by, 'phase record by'),
    reason: requireText(value.reason, 'phase record reason'),
    policyDigest: value.policyDigest === null ? null : digest(value.policyDigest, 'phase record policyDigest'),
    recordDigest: value.recordDigest,
  };
  if (!PHASE_DECISIONS.includes(value.decision)) invalid(`phase record decision must be ${PHASE_DECISIONS.join(' or ')}`);
  if (value.type === 'phase-transition') {
    normalized.from = phase(value.from, 'phase transition from');
    normalized.to = phase(value.to, 'phase transition to');
    if (normalized.from === normalized.to) invalid('phase transition must change phase');
  } else if (value.from !== undefined || value.to !== undefined) {
    invalid('phase decision cannot contain from or to');
  }
  if (value.inputs !== undefined) normalized.inputs = inputsValue(value.inputs, 'phase record inputs');
  if (value.predecessor !== undefined) normalized.predecessor = predecessorValue(value.predecessor, 'phase record predecessor');
  if (value.qualification !== undefined) normalized.qualification = qualificationValue(value.qualification, 'phase record qualification');
  if (value.artifact !== undefined) normalized.artifact = artifactValue(value.artifact, 'phase record artifact');
  if (value.type === 'phase-decision' && normalized.phase === 'research' && normalized.decision === 'approved') {
    if (normalized.inputs === undefined || normalized.artifact === undefined) invalid('approved research phase record requires inputs and artifact');
  }
  if (typeof value.recordDigest !== 'string' || !DIGEST_PATTERN.test(value.recordDigest)) invalid('phase record recordDigest must be a lowercase SHA-256 digest');
  if (digestJson(recordPayload(normalized)) !== value.recordDigest) invalid('phase record recordDigest does not match its contents');
  const bytes = Buffer.byteLength(JSON.stringify(normalized));
  if (bytes > PHASE_RECORD_MAX_BYTES) invalid(`phase record exceeds ${PHASE_RECORD_MAX_BYTES} bytes`);
  return normalized;
}

function ledgerPaths(root) {
  const ledger = join(root, ...PHASE_LEDGER_RELATIVE_PATH.split('/'));
  const lock = join(root, '.tinysdd', 'runs', 'phases.lock');
  return { ledger, lock };
}

async function checkedLedgerPaths(root) {
  // Check every ancestor before withExclusiveLock can create a directory. This
  // keeps a symlinked .tinysdd or runs directory from becoming a write target.
  await assertInternalPath(root, ['.tinysdd'], { allowMissing: true, requireDirectory: true });
  await assertInternalPath(root, ['.tinysdd', 'runs'], { allowMissing: true, requireDirectory: true });
  await assertInternalPath(root, ['.tinysdd', 'runs', 'phases.jsonl'], { allowMissing: true });
  await assertInternalPath(root, ['.tinysdd', 'runs', 'phases.lock'], { allowMissing: true });
  return ledgerPaths(root);
}

async function readLedgerText(ledger) {
  let info;
  try {
    info = await lstat(ledger);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (info.isSymbolicLink()) throw tinyError('PHASE_LEDGER_INVALID', 'phase ledger may not be a symlink');
  if (!info.isFile()) throw tinyError('PHASE_LEDGER_INVALID', 'phase ledger must be a regular file');
  if (info.size > PHASE_LEDGER_MAX_BYTES) throw tinyError('PHASE_LEDGER_TOO_LARGE', `phase ledger exceeds ${PHASE_LEDGER_MAX_BYTES} bytes`);
  const text = await readFile(ledger, 'utf8');
  if (Buffer.byteLength(text) > PHASE_LEDGER_MAX_BYTES) throw tinyError('PHASE_LEDGER_TOO_LARGE', `phase ledger exceeds ${PHASE_LEDGER_MAX_BYTES} bytes`);
  return text;
}

function parseLedgerText(text) {
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) throw tinyError('PHASE_LEDGER_PARTIAL', 'phase ledger has a partial trailing record');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > PHASE_LEDGER_MAX_RECORDS) throw tinyError('PHASE_LEDGER_TOO_LARGE', `phase ledger contains more than ${PHASE_LEDGER_MAX_RECORDS} records`);
  const records = lines.map((line, index) => {
    if (Buffer.byteLength(line) > PHASE_RECORD_MAX_BYTES) throw tinyError('PHASE_RECORD_TOO_LARGE', `phase ledger line ${index + 1} exceeds ${PHASE_RECORD_MAX_BYTES} bytes`);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw tinyError('PHASE_LEDGER_INVALID', `phase ledger line ${index + 1} is malformed JSON`);
    }
    return normalizePhaseRecord(value);
  });
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw tinyError('PHASE_RECORD_DUPLICATE', `phase record already exists: ${record.id}`);
    ids.add(record.id);
  }
  return records;
}

async function readRecordsUnlocked(root) {
  const { ledger } = ledgerPaths(root);
  return parseLedgerText(await readLedgerText(ledger));
}

async function verifyArtifact(root, record) {
  if (record.artifact === undefined) return null;
  let target;
  let info;
  try {
    target = await assertInternalPath(root, record.artifact.path.split('/'), { allowMissing: false });
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND' || error?.code === 'ENOENT') {
      throw tinyError('PHASE_ARTIFACT_MISSING', `phase record artifact is missing: ${record.artifact.path}`, { recordId: record.id, causeCode: error.code });
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw tinyError('PHASE_ARTIFACT_INVALID', `phase record artifact is not a regular file: ${record.artifact.path}`, { recordId: record.id });
  if (info.size > PHASE_ARTIFACT_MAX_BYTES) throw tinyError('PHASE_ARTIFACT_TOO_LARGE', `phase record artifact exceeds ${PHASE_ARTIFACT_MAX_BYTES} bytes`, { recordId: record.id });
  const bytes = await readFile(target);
  if (bytes.byteLength > PHASE_ARTIFACT_MAX_BYTES) throw tinyError('PHASE_ARTIFACT_TOO_LARGE', `phase record artifact exceeds ${PHASE_ARTIFACT_MAX_BYTES} bytes`, { recordId: record.id });
  if (sha256(bytes) !== record.artifact.sha256 || bytes.byteLength !== record.artifact.bytes) {
    throw tinyError('PHASE_ARTIFACT_TAMPERED', `phase record artifact digest changed: ${record.artifact.path}`, { recordId: record.id });
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw tinyError('PHASE_ARTIFACT_INVALID', `phase record artifact is malformed JSON: ${record.artifact.path}`, { recordId: record.id });
  }
  if (!value || value.schemaVersion !== PHASE_LEDGER_SCHEMA_VERSION || value.type !== 'phase-research-artifact' || value.id !== record.id || value.feature !== record.feature) {
    throw tinyError('PHASE_ARTIFACT_INVALID', `phase record artifact does not match ${record.id}`, { recordId: record.id });
  }
  return value;
}

async function readVerifiedRecordsUnlocked(root) {
  const records = await readRecordsUnlocked(root);
  for (const record of records) await verifyArtifact(root, record);
  return records;
}

export async function readPhaseRecords(projectRoot, { verify = true } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const { lock } = await checkedLedgerPaths(root);
  return withExclusiveLock(lock, async () => (verify ? readVerifiedRecordsUnlocked(root) : readRecordsUnlocked(root)));
}

async function appendRecordUnlocked(root, record) {
  const normalized = normalizePhaseRecord(record);
  if (normalized.artifact !== undefined) await verifyArtifact(root, normalized);
  const { ledger } = ledgerPaths(root);
  await ensureDirectory(dirname(ledger));
  const existing = await readRecordsUnlocked(root);
  if (existing.some((item) => item.id === normalized.id)) throw tinyError('PHASE_RECORD_DUPLICATE', `phase record already exists: ${normalized.id}`);
  if (existing.length >= PHASE_LEDGER_MAX_RECORDS) throw tinyError('PHASE_LEDGER_TOO_LARGE', `phase ledger contains more than ${PHASE_LEDGER_MAX_RECORDS} records`);
  const line = `${JSON.stringify(normalized)}\n`;
  const current = await readLedgerText(ledger);
  if (Buffer.byteLength(current) + Buffer.byteLength(line) > PHASE_LEDGER_MAX_BYTES) throw tinyError('PHASE_LEDGER_TOO_LARGE', `phase ledger exceeds ${PHASE_LEDGER_MAX_BYTES} bytes`);
  await appendFile(ledger, line, { encoding: 'utf8', mode: 0o600 });
  return normalized;
}

export async function appendPhaseRecord(projectRoot, value) {
  const root = await canonicalProjectRoot(projectRoot);
  const { lock } = await checkedLedgerPaths(root);
  return withExclusiveLock(lock, async () => appendRecordUnlocked(root, value));
}

async function writeArtifactUnlocked(root, artifact) {
  const path = `${PHASE_ARTIFACT_PREFIX}${artifact.id}.json`;
  const target = await assertInternalPath(root, path.split('/'), { allowMissing: true });
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw tinyError('PHASE_ARTIFACT_COLLISION', `phase artifact path is already occupied: ${path}`);
    throw tinyError('PHASE_RECORD_DUPLICATE', `phase artifact already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const text = `${JSON.stringify(artifact.value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > PHASE_ARTIFACT_MAX_BYTES) throw tinyError('PHASE_ARTIFACT_TOO_LARGE', `phase artifact exceeds ${PHASE_ARTIFACT_MAX_BYTES} bytes`);
  await atomicWriteFile(target, text);
  return { path, sha256: sha256(Buffer.from(text)), bytes };
}

function researchPolicy(policy) {
  if (!policy || policy.research === undefined) throw tinyError('PHASE_POLICY_MISSING', 'research phase policy is not configured');
  return policy.research;
}

function researchProducer(policyGate) {
  const configured = policyGate.qualification;
  if (!configured || configured.required === false) return null;
  if (typeof configured.worker !== 'string' || typeof configured.role !== 'string') {
    throw tinyError('PHASE_POLICY_INVALID', 'research qualification must name a producer worker and role');
  }
  if (configured.role !== 'research') throw tinyError('PHASE_POLICY_INVALID', 'research qualification role must be research');
  return { worker: configured.worker, role: configured.role };
}

function predecessorPolicy(policyGate) {
  if (policyGate.predecessor === undefined || policyGate.predecessor.required === false) return null;
  return policyGate.predecessor;
}

async function readInput(root, requested, label, maxBytes = PHASE_PROPOSAL_MAX_BYTES) {
  const path = inputPath(requested, label);
  let resolved;
  try {
    resolved = await resolveProjectPath(root, path, { ...fileOptions(path), allowMissing: false });
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') throw tinyError('PHASE_INPUT_MISSING', `${label} is not readable: ${path}`, { causeCode: error.code });
    throw error;
  }
  let info;
  try {
    info = await lstat(resolved.absolutePath);
  } catch (error) {
    throw tinyError('PHASE_INPUT_MISSING', `${label} is not readable: ${path}`, { causeCode: error?.code });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw tinyError('PHASE_INPUT_INVALID', `${label} must be a regular file: ${path}`);
  if (info.size > maxBytes) throw tinyError('PHASE_INPUT_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  const bytesValue = await readFile(resolved.absolutePath);
  if (bytesValue.byteLength > maxBytes) throw tinyError('PHASE_INPUT_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  const text = bytesValue.toString('utf8');
  const bytes = bytesValue.byteLength;
  if (bytes > maxBytes) throw tinyError('PHASE_INPUT_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  return { path, text, sha256: sha256(text), bytes };
}

async function readBoundedContextSource(root, requested) {
  const resolved = await resolveProjectPath(root, requested, { allowMissing: false });
  let info;
  try {
    info = await lstat(resolved.absolutePath);
  } catch (error) {
    throw tinyError('PHASE_INPUT_MISSING', `research context source is not readable: ${requested}`, { causeCode: error?.code });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw tinyError('PHASE_INPUT_INVALID', `research context source must be a regular file: ${requested}`);
  if (info.size > MAX_CONTEXT_SOURCE_BYTES) throw tinyError('PHASE_INPUT_TOO_LARGE', `research context source exceeds ${MAX_CONTEXT_SOURCE_BYTES} bytes: ${requested}`);
  const bytes = await readFile(resolved.absolutePath);
  if (bytes.byteLength > MAX_CONTEXT_SOURCE_BYTES) throw tinyError('PHASE_INPUT_TOO_LARGE', `research context source exceeds ${MAX_CONTEXT_SOURCE_BYTES} bytes: ${requested}`);
  return bytes.toString('utf8');
}

async function researchInputs(root, options) {
  const proposalRequested = options.proposalPath ?? options.proposal;
  const contextRequested = options.contextPath ?? options.context ?? options.manifest;
  if (typeof proposalRequested === 'object' && proposalRequested !== null) {
    if (typeof proposalRequested.path !== 'string') throw tinyError('PHASE_INPUT_INVALID', 'proposal.path is required');
    return researchInputs(root, { ...options, proposalPath: proposalRequested.path });
  }
  if (typeof contextRequested === 'object' && contextRequested !== null) {
    if (typeof contextRequested.path !== 'string') throw tinyError('PHASE_INPUT_INVALID', 'context.path is required');
    return researchInputs(root, { ...options, contextPath: contextRequested.path });
  }
  if (typeof proposalRequested !== 'string' || proposalRequested.length === 0) throw tinyError('PHASE_INPUT_INVALID', 'research proposal path is required');
  if (typeof contextRequested !== 'string' || contextRequested.length === 0) throw tinyError('PHASE_INPUT_INVALID', 'research context manifest path is required');
  const proposal = await readInput(root, proposalRequested, 'research proposal');
  const context = await readInput(root, contextRequested, 'research context manifest', PHASE_PROPOSAL_MAX_BYTES);
  const manifest = parseContextManifest(context.text);
  const compiled = await compileContext(root, { path: context.path, text: context.text, sha256: context.sha256 }, {
    readSource: (path) => readBoundedContextSource(root, path),
  });
  if (compiled === null) throw tinyError('PHASE_INPUT_INVALID', 'research context manifest is required');
  const compiledContext = {
    manifestSha256: compiled.manifest.sha256,
    compiledSha256: compiled.sha256,
    bytes: compiled.bytes,
    resources: compiled.resources.map((resource) => ({
      path: resource.path,
      startLine: resource.startLine,
      endLine: resource.endLine,
      purpose: resource.purpose,
      excerptSha256: resource.excerptSha256,
      excerptBytes: resource.excerptBytes,
    })),
  };
  return { proposal, context, manifest, compiled, compiledContext };
}

function predecessorInput(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return { id: value };
  assertPlainObject(value, 'PHASE_INPUT_INVALID', 'research predecessor');
  return { ...value };
}

function latestPhaseDecision(records, feature, phaseName) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.feature === feature && record.phase === phaseName) return record;
  }
  return undefined;
}

function latestRecord(records, feature, phaseName) {
  const current = latestPhaseDecision(records, feature, phaseName);
  return current?.decision === 'approved' ? current : undefined;
}

function recordReference(record) {
  return { id: record.id, phase: record.phase, feature: record.feature, recordDigest: record.recordDigest };
}

async function resolvePredecessor(records, feature, policyGate, requested) {
  const requirement = predecessorPolicy(policyGate);
  const supplied = predecessorInput(requested);
  if (requirement === null && supplied === undefined) return undefined;
  const predecessor = supplied?.id === undefined
    ? latestRecord(records, feature, requirement?.phase)
    : records.find((item) => item.id === supplied.id);
  if (!predecessor) {
    if (requirement === null) throw tinyError('PHASE_PREDECESSOR_NOT_FOUND', 'requested research predecessor was not found');
    throw tinyError('PHASE_PREDECESSOR_REQUIRED', `research requires an approved ${requirement.phase} predecessor`, { feature, phase: requirement.phase });
  }
  const latest = latestPhaseDecision(records, feature, predecessor.phase);
  if (predecessor.feature !== feature || predecessor.phase !== (requirement?.phase ?? supplied.phase ?? predecessor.phase)
    || predecessor.decision !== 'approved' || latest?.id !== predecessor.id || latest.recordDigest !== predecessor.recordDigest) {
    throw tinyError('PHASE_PREDECESSOR_INVALID', 'research predecessor does not match the configured feature and phase', { feature, predecessor: recordReference(predecessor) });
  }
  return recordReference(predecessor);
}

function qualificationRecord(value) {
  if (value === undefined || value === null) return undefined;
  assertPlainObject(value, 'PHASE_RECORD_INVALID', 'qualification');
  return qualificationValue(value, 'qualification');
}

function recordForStorage(value) {
  const normalized = normalizePhaseRecord({ ...value, recordDigest: digestJson(recordPayload(value)) });
  return normalized;
}

/**
 * Record a human research decision. The caller supplies a qualification
 * resolver for configured research producers; this module never invokes a
 * model or invents authority for another gate mode.
 */
export async function recordResearchDecision(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const feature = identifier(options.feature, 'feature', FEATURE_PATTERN);
  const by = requireText(options.by, 'research decision by');
  const reason = requireText(options.reason, 'research decision reason');
  const policy = options.policy === undefined ? undefined : validatePhasePolicy(options.policy);
  const gate = researchPolicy(policy);
  if (gate.mode !== 'human') {
    throw tinyError('PHASE_GATE_UNAVAILABLE', `research gate mode ${gate.mode} has no configured handler`, { phase: 'research', mode: gate.mode, status: 'unsupported' });
  }
  const { lock } = await checkedLedgerPaths(root);
  return withExclusiveLock(lock, async () => {
    const records = await readVerifiedRecordsUnlocked(root);
    const inputs = await researchInputs(root, options);
    const predecessor = await resolvePredecessor(records, feature, gate, options.predecessor ?? options.predecessorId);
    if (predecessor !== undefined) {
      const predecessorRecord = records.find((record) => record.id === predecessor.id);
      const predecessorState = await predecessorFreshness(root, predecessorRecord, records, policy, options.qualificationResolver);
      if (!predecessorState.fresh) {
        throw tinyError('PHASE_PREDECESSOR_STALE', 'research predecessor is stale', { feature, predecessor, reasons: predecessorState.reasons });
      }
    }
    let qualification;
    const producer = researchProducer(gate);
    if (producer) {
      if (typeof options.qualificationResolver !== 'function') throw tinyError('PHASE_QUALIFICATION_UNAVAILABLE', 'research producer qualification resolver is unavailable', { producer });
      qualification = qualificationRecord(await options.qualificationResolver(producer));
      if (qualification === undefined || qualification.worker !== producer.worker || qualification.role !== producer.role) {
        throw tinyError('PHASE_QUALIFICATION_REQUIRED', `research producer ${producer.worker} is not currently qualified for ${producer.role}`, { producer });
      }
    } else if (options.qualification !== undefined) {
      throw tinyError('PHASE_QUALIFICATION_UNSUPPORTED', 'research qualification requires an explicitly configured producer');
    }
    const id = options.id === undefined ? `phase-${randomUUID()}` : identifier(options.id, 'phase record id');
    if (records.some((record) => record.id === id)) throw tinyError('PHASE_RECORD_DUPLICATE', `phase record already exists: ${id}`);
    const artifactValue = {
      schemaVersion: PHASE_LEDGER_SCHEMA_VERSION,
      type: 'phase-research-artifact',
      id,
      timestamp: new Date().toISOString(),
      feature,
      proposal: inputs.proposal,
      context: {
        path: inputs.context.path,
        sha256: inputs.context.sha256,
        bytes: inputs.context.bytes,
        text: inputs.context.text,
        manifest: inputs.manifest,
        compiled: {
          rendered: inputs.compiled.rendered,
          sha256: inputs.compiled.sha256,
          bytes: inputs.compiled.bytes,
          resources: inputs.compiled.resources,
        },
      },
    };
    const artifact = await writeArtifactUnlocked(root, { id, value: artifactValue });
    const record = recordForStorage({
      schemaVersion: PHASE_LEDGER_SCHEMA_VERSION,
      type: 'phase-decision',
      id,
      timestamp: artifactValue.timestamp,
      feature,
      phase: 'research',
      decision: 'approved',
      mode: gate.mode,
      by,
      reason,
      policyDigest: phasePolicyDigest(policy),
      inputs: {
        proposal: { path: inputs.proposal.path, sha256: inputs.proposal.sha256, bytes: inputs.proposal.bytes },
        context: { path: inputs.context.path, sha256: inputs.context.sha256, bytes: inputs.context.bytes },
        compiledContext: inputs.compiledContext,
      },
      ...(predecessor === undefined ? {} : { predecessor }),
      ...(qualification === undefined ? {} : { qualification }),
      artifact,
    });
    const appended = await appendRecordUnlocked(root, record);
    return {
      phase: 'research',
      feature,
      accepted: true,
      fresh: true,
      record: appended,
    };
  });
}

async function readCurrentResearchInputs(root, record) {
  if (record.inputs === undefined) throw tinyError('PHASE_RECORD_INVALID', `research record ${record.id} has no inputs`);
  const proposal = await readInput(root, record.inputs.proposal.path, 'research proposal');
  const context = await readInput(root, record.inputs.context.path, 'research context manifest', PHASE_PROPOSAL_MAX_BYTES);
  if (proposal.sha256 !== record.inputs.proposal.sha256 || proposal.bytes !== record.inputs.proposal.bytes) {
    throw tinyError('PHASE_RECORD_STALE', `research proposal changed: ${proposal.path}`, { recordId: record.id, field: 'proposal' });
  }
  if (context.sha256 !== record.inputs.context.sha256 || context.bytes !== record.inputs.context.bytes) {
    throw tinyError('PHASE_RECORD_STALE', `research context manifest changed: ${context.path}`, { recordId: record.id, field: 'context' });
  }
  parseContextManifest(context.text);
  const compiled = await compileContext(root, { path: context.path, text: context.text, sha256: context.sha256 }, {
    readSource: (path) => readBoundedContextSource(root, path),
  });
  const identity = {
    manifestSha256: compiled.manifest.sha256,
    compiledSha256: compiled.sha256,
    bytes: compiled.bytes,
    resources: compiled.resources.map((resource) => ({
      path: resource.path,
      startLine: resource.startLine,
      endLine: resource.endLine,
      purpose: resource.purpose,
      excerptSha256: resource.excerptSha256,
      excerptBytes: resource.excerptBytes,
    })),
  };
  if (stableStringify(identity) !== stableStringify(record.inputs.compiledContext)) {
    throw tinyError('PHASE_RECORD_STALE', `research cited context changed: ${context.path}`, { recordId: record.id, field: 'compiledContext' });
  }
  return { proposal, context, compiled };
}

async function predecessorFreshness(root, record, records, policy, qualificationResolver, seen = new Set()) {
  if (seen.has(record.id) || seen.size >= 32) return { fresh: false, reasons: ['phase predecessor chain is cyclic or too deep'] };
  const nextSeen = new Set(seen).add(record.id);
  const latest = latestPhaseDecision(records, record.feature, record.phase);
  if (!latest || latest.id !== record.id || latest.recordDigest !== record.recordDigest || latest.decision !== 'approved') {
    return { fresh: false, reasons: ['phase predecessor was superseded or rejected'] };
  }
  if (record.policyDigest !== phasePolicyDigest(policy)) return { fresh: false, reasons: ['phase predecessor policy changed'] };
  if (record.type === 'phase-decision' && record.phase === 'research') {
    return researchFreshness(root, record, policy, qualificationResolver, records, nextSeen);
  }
  if (record.type === 'phase-transition') {
    if (record.predecessor === undefined) return { fresh: false, reasons: ['phase transition has no predecessor'] };
    const predecessor = records.find((item) => item.id === record.predecessor.id);
    if (!predecessor || predecessor.recordDigest !== record.predecessor.recordDigest) {
      return { fresh: false, reasons: ['phase transition predecessor is unavailable'] };
    }
    return predecessorFreshness(root, predecessor, records, policy, qualificationResolver, nextSeen);
  }
  return { fresh: true, reasons: [] };
}

async function researchFreshness(root, record, policy, qualificationResolver, recordsArgument = undefined, seen = new Set()) {
  if (record.decision !== 'approved') return { fresh: false, reasons: ['research decision was not approved'] };
  if (record.policyDigest !== phasePolicyDigest(policy)) return { fresh: false, reasons: ['research policy changed'] };
  const liveRecords = recordsArgument ?? await readRecordsUnlocked(root);
  const latest = latestPhaseDecision(liveRecords, record.feature, record.phase);
  if (!latest || latest.id !== record.id || latest.recordDigest !== record.recordDigest) return { fresh: false, reasons: ['research decision was superseded or rejected'] };
  await verifyArtifact(root, record);
  try {
    await readCurrentResearchInputs(root, record);
  } catch (error) {
    if (error?.code === 'PHASE_RECORD_STALE') return { fresh: false, reasons: [error.message] };
    throw error;
  }
  if (record.predecessor !== undefined) {
    const predecessor = liveRecords.find((item) => item.id === record.predecessor.id);
    if (!predecessor || predecessor.recordDigest !== record.predecessor.recordDigest || predecessor.feature !== record.feature || predecessor.phase !== record.predecessor.phase) {
      return { fresh: false, reasons: ['research predecessor changed or is unavailable'] };
    }
    const predecessorState = await predecessorFreshness(root, predecessor, liveRecords, policy, qualificationResolver, seen);
    if (!predecessorState.fresh) return predecessorState;
  }
  if (record.qualification !== undefined) {
    if (typeof qualificationResolver !== 'function') return { fresh: false, reasons: ['research qualification cannot be revalidated'] };
    let current;
    try {
      current = qualificationRecord(await qualificationResolver({ worker: record.qualification.worker, role: record.qualification.role }));
    } catch (error) {
      return { fresh: false, reasons: [error.message] };
    }
    if (current === undefined || stableStringify(current) !== stableStringify(record.qualification)) {
      return { fresh: false, reasons: ['research producer qualification changed'] };
    }
  }
  return { fresh: true, reasons: [] };
}

/** Advance a current research record to plan under the same phase policy. */
export async function advancePhase(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const feature = identifier(options.feature, 'feature', FEATURE_PATTERN);
  const from = phase(options.from ?? 'research', 'transition from');
  const to = phase(options.to ?? 'plan', 'transition to');
  if (from !== 'research' || to !== 'plan') throw tinyError('PHASE_TRANSITION_UNSUPPORTED', 'only research to plan is implemented', { from, to });
  const by = requireText(options.by, 'phase transition by');
  const reason = requireText(options.reason, 'phase transition reason');
  const policy = options.policy === undefined ? undefined : validatePhasePolicy(options.policy);
  const gate = researchPolicy(policy);
  if (gate.mode !== 'human') throw tinyError('PHASE_GATE_UNAVAILABLE', `research gate mode ${gate.mode} has no configured handler`, { phase: 'research', mode: gate.mode, status: 'unsupported' });
  if (policy.plan !== undefined && policy.plan.mode !== 'human') throw tinyError('PHASE_GATE_UNAVAILABLE', `plan gate mode ${policy.plan.mode} has no configured handler`, { phase: 'plan', mode: policy.plan.mode, status: 'unsupported' });
  if (policy.plan?.qualification !== undefined || policy.plan?.predecessor !== undefined) {
    throw tinyError('PHASE_TRANSITION_UNSUPPORTED', 'plan gate qualification or predecessor requirements are not implemented', { phase: 'plan' });
  }
  const { lock } = await checkedLedgerPaths(root);
  return withExclusiveLock(lock, async () => {
    const records = await readVerifiedRecordsUnlocked(root);
    const selected = options.recordId === undefined
      ? latestRecord(records, feature, 'research')
      : records.find((record) => record.id === options.recordId);
    if (!selected || selected.feature !== feature || selected.phase !== 'research') throw tinyError('PHASE_RESEARCH_MISSING', `no approved research record is available for feature ${feature}`, { feature, recordId: options.recordId ?? null });
    const freshness = await researchFreshness(root, selected, policy, options.qualificationResolver);
    if (!freshness.fresh) throw tinyError('PHASE_RECORD_STALE', `research record ${selected.id} is stale`, { recordId: selected.id, reasons: freshness.reasons });
    const id = options.id === undefined ? `phase-${randomUUID()}` : identifier(options.id, 'phase record id');
    const record = recordForStorage({
      schemaVersion: PHASE_LEDGER_SCHEMA_VERSION,
      type: 'phase-transition',
      id,
      timestamp: new Date().toISOString(),
      feature,
      phase: to,
      from,
      to,
      decision: 'approved',
      mode: policy.plan?.mode ?? gate.mode,
      by,
      reason,
      policyDigest: phasePolicyDigest(policy),
      predecessor: recordReference(selected),
    });
    const appended = await appendRecordUnlocked(root, record);
    return { feature, from, to, advanced: true, fresh: true, researchRecord: selected, record: appended };
  });
}

/** Read phase state without writing a decision or inferring one. */
export async function phaseStatus(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const feature = options.feature === undefined ? undefined : identifier(options.feature, 'feature', FEATURE_PATTERN);
  const policy = options.policy === undefined ? undefined : validatePhasePolicy(options.policy);
  const { lock } = await checkedLedgerPaths(root);
  return withExclusiveLock(lock, async () => {
    const records = await readVerifiedRecordsUnlocked(root);
    const selected = feature === undefined ? records : records.filter((record) => record.feature === feature);
    const byPhase = Object.fromEntries(PHASES.map((name) => [name, { configured: policy?.[name] !== undefined, status: 'pending', record: null }]));
    for (const record of selected) {
      const current = byPhase[record.phase];
      if (current === undefined) continue;
      current.status = record.type === 'phase-transition' ? 'entered' : record.decision;
      current.record = record;
    }
    const research = byPhase.research.record;
    if (research?.decision === 'approved') {
      const freshness = policy?.research === undefined
        ? { fresh: false, reasons: ['research policy is not configured'] }
        : await researchFreshness(root, research, policy, options.qualificationResolver);
      byPhase.research.status = freshness.fresh ? 'approved' : 'stale';
      byPhase.research.staleReasons = freshness.reasons;
    }
    const plan = byPhase.plan.record;
    if (plan?.type === 'phase-transition') {
      const reasons = [];
      if (policy === undefined || plan.policyDigest !== phasePolicyDigest(policy)) reasons.push('plan transition policy changed');
      if (policy?.plan?.qualification !== undefined || policy?.plan?.predecessor !== undefined) reasons.push('plan gate requirements are unsupported');
      const predecessor = selected.find((record) => record.id === plan.predecessor?.id);
      if (!predecessor || predecessor.recordDigest !== plan.predecessor?.recordDigest || predecessor.feature !== plan.feature || predecessor.phase !== 'research') {
        reasons.push('plan transition research predecessor is unavailable');
      } else if (policy?.research !== undefined) {
        const freshness = await researchFreshness(root, predecessor, policy, options.qualificationResolver);
        if (!freshness.fresh) reasons.push(...freshness.reasons);
      } else {
        reasons.push('research policy is not configured');
      }
      if (reasons.length > 0) {
        byPhase.plan.status = 'stale';
        byPhase.plan.staleReasons = [...new Set(reasons)];
      }
    }
    const result = {
      phaseSchemaVersion: PHASE_LEDGER_SCHEMA_VERSION,
      ...(feature === undefined ? {} : { feature }),
      policy: policy === undefined ? null : structuredClone(policy),
      phases: byPhase,
      records: selected,
    };
    return result;
  });
}

export const recordResearch = recordResearchDecision;
export const inspectPhaseStatus = phaseStatus;
