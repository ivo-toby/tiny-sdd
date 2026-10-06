import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, appendFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parseApprovedBriefSections, validateChange } from './change-format.mjs';
import {
  JEV_DECISION_MAX_ARTIFACT_BYTES,
  JEV_DECISION_MAX_ARTIFACTS,
  JEV_DECISION_MAX_TOTAL_ARTIFACT_BYTES,
  buildJevQuestion,
  validateSliceTestArtifacts,
  validateSliceTestCriteria,
} from './jev-decision-provider.mjs';
import {
  assertInternalPath,
  digestJson,
  ensureDirectory,
  sha256,
  stableStringify,
  tinyError,
  withExclusiveLock,
} from './fs-utils.mjs';
import {
  classifyFileScopeChange,
  detectFilesystemAliases,
  preparationPaths,
  observedPathError,
} from './file-scope.mjs';

export const SLICE_TEST_REVIEW_SCHEMA_VERSION = 1;
export const SLICE_TEST_REVIEW_EVENT_SCHEMA_VERSION = 1;
export const SLICE_TEST_REVIEW_TYPE = 'slice-test-assessment-envelope';
export const SLICE_TEST_REVIEW_EVENT_TYPE = 'slice-test-review-event';
export const SLICE_TEST_REVIEW_UNKNOWN = 'UNKNOWN';
export const SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
export const SLICE_TEST_REVIEW_MAX_EVENT_BYTES = 256 * 1024;
export const SLICE_TEST_REVIEW_MAX_EVENTS = 16_384;
export const SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_ENTRIES = 20_000;
export const SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_BYTES = 512 * 1024 * 1024;
export const SLICE_TEST_REVIEW_LEDGER_RELATIVE_PATH = '.tinysdd/runs/slice-test-review/events.jsonl';
export const SLICE_TEST_REVIEW_LOCK_RELATIVE_PATH = '.tinysdd/runs/slice-test-review/events.lock';
export const SLICE_TEST_REVIEW_EVENT_TYPES = Object.freeze([
  'initial-assessment',
  'revision-assessment',
  'assessment-rejected',
  'assessment-uncertain',
  'assessment-unavailable',
  'assessment-missing',
  'provider-failure',
  'strong-review',
  'escalation',
  'operator-acceptance',
]);

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const SLUG = /^[a-z][a-z0-9._:-]{0,63}$/u;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const EVENT_STATUSES = new Set(['observed', 'failed', 'uncertain', 'unavailable', 'missing', 'malformed']);
const EVENT_VERDICTS = new Set(['UNKNOWN', 'positive', 'negative', 'accepted', 'rejected']);
const PROVIDER_AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);

function reviewError(code, message, details = undefined) {
  return tinyError(code, message, details);
}

function plainObject(value, label, code = 'SLICE_TEST_REVIEW_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw reviewError(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw reviewError(code, `${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label, code = 'SLICE_TEST_REVIEW_INVALID') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw reviewError(code, `${label} contains unknown key: ${key}`);
  }
}

function text(value, label, max = 4096, code = 'SLICE_TEST_REVIEW_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw reviewError(code, `${label} must be bounded text`);
  return value;
}

function identifier(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be a bounded identifier`);
  return value;
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (value === SLICE_TEST_REVIEW_UNKNOWN) return value;
  if (typeof value !== 'string' || !DIGEST.test(value)) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be a lowercase SHA-256 digest or UNKNOWN`);
  return value;
}

function concreteDigest(value, label) {
  const normalized = digest(value, label);
  if (normalized === SLICE_TEST_REVIEW_UNKNOWN) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be an observed digest`);
  return normalized;
}

function projectPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be a project-relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains traversal or empty components`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be an ISO-8601 UTC timestamp`);
  return value;
}

function boundedJson(value, label, depth = 0, seen = new Set()) {
  if (depth > 8) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') text(value, label, 128 * 1024);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains an unsupported value`);
  if (seen.has(value)) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains too many entries`);
    const result = value.map((item, index) => boundedJson(item, `${label}[${index}]`, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const entries = Object.entries(value);
  if (entries.length > 256) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains too many keys`);
  const result = {};
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} contains a reserved key`);
    Object.defineProperty(result, key, { value: boundedJson(item, `${label}.${key}`, depth + 1, seen), enumerable: true, configurable: true, writable: true });
  }
  seen.delete(value);
  return result;
}

function normalizeIdentity(value, label = 'identity') {
  const item = plainObject(value, label);
  exactKeys(item, ['featureId', 'taskId', 'sliceId', 'runId', 'rootRunId', 'lineageId', 'revision'], label);
  const revision = item.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.revision must be a nonnegative safe integer`);
  return {
    featureId: identifier(item.featureId, `${label}.featureId`),
    taskId: identifier(item.taskId, `${label}.taskId`),
    sliceId: identifier(item.sliceId, `${label}.sliceId`),
    runId: identifier(item.runId, `${label}.runId`, RUN_ID),
    rootRunId: identifier(item.rootRunId, `${label}.rootRunId`, RUN_ID),
    lineageId: identifier(item.lineageId, `${label}.lineageId`),
    revision,
  };
}

function normalizeApproval(value) {
  const item = plainObject(value, 'approval');
  exactKeys(item, ['approvalDigest', 'briefDigest', 'contextDigest', 'checksDigest', 'preparationDigest', 'descriptorSetSha256', 'testReviewContractSha256'], 'approval');
  const result = {
    approvalDigest: concreteDigest(item.approvalDigest, 'approval.approvalDigest'),
    briefDigest: concreteDigest(item.briefDigest, 'approval.briefDigest'),
    contextDigest: item.contextDigest === undefined ? null : digest(item.contextDigest, 'approval.contextDigest', { nullable: true }),
    checksDigest: item.checksDigest === undefined ? null : digest(item.checksDigest, 'approval.checksDigest', { nullable: true }),
    preparationDigest: item.preparationDigest === undefined ? SLICE_TEST_REVIEW_UNKNOWN : digest(item.preparationDigest, 'approval.preparationDigest'),
  };
  for (const key of ['descriptorSetSha256', 'testReviewContractSha256']) {
    if (item[key] !== undefined) result[key] = concreteDigest(item[key], `approval.${key}`);
  }
  return result;
}

function normalizeArtifactRoles(artifacts) {
  const result = validateSliceTestArtifacts(artifacts);
  if (result.length > JEV_DECISION_MAX_ARTIFACTS) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'too many retained artifacts');
  if (result.some((item) => item.bytes > JEV_DECISION_MAX_ARTIFACT_BYTES)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'retained artifact exceeds the byte limit');
  let total = 0;
  for (const item of result) {
    total += item.bytes;
    if (total > JEV_DECISION_MAX_TOTAL_ARTIFACT_BYTES) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'retained artifacts exceed the total byte limit');
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeQuestions(value, criteria) {
  const item = plainObject(value, 'questions');
  const expected = Object.fromEntries(criteria.map((criterionValue) => [criterionValue.id, buildJevQuestion(criterionValue)]));
  const keys = Object.keys(item);
  if (keys.length !== criteria.length || keys.some((key) => !Object.hasOwn(expected, key))) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'questions do not match the approval-bound criteria');
  for (const criterionValue of criteria) {
    const question = plainObject(item[criterionValue.id], `questions.${criterionValue.id}`);
    exactKeys(question, ['type', 'instruction', 'criteria'], `questions.${criterionValue.id}`);
    if (stableStringify(question) !== stableStringify(expected[criterionValue.id])) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `questions.${criterionValue.id} does not match the canonical Jev wire question`);
  }
  return Object.fromEntries(criteria.map((criterionValue) => [criterionValue.id, expected[criterionValue.id]]));
}

function normalizeProvenance(value, label = 'provenance') {
  const item = plainObject(value, label);
  exactKeys(item, ['source', 'replayed', 'capture'], label);
  if (!['validated-final-run', 'replay', 'synthetic'].includes(item.source)) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.source is unsupported`);
  if (typeof item.replayed !== 'boolean') throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.replayed must be boolean`);
  if (item.source === 'replay' && item.replayed !== true) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.replayed must be true for replay`);
  if (item.source !== 'replay' && item.replayed === true) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.replayed must be false for direct capture`);
  return {
    source: item.source,
    replayed: item.replayed,
    capture: text(item.capture, `${label}.capture`, 256),
  };
}

function normalizeEnvelopePayload(value) {
  const item = plainObject(value, 'slice-test review envelope');
  exactKeys(item, ['schemaVersion', 'type', 'identity', 'approval', 'criteria', 'questions', 'requirements', 'interfaces', 'integration', 'artifacts', 'inputDigest', 'capturedAt', 'provenance', 'envelopeDigest'], 'slice-test review envelope');
  if (item.schemaVersion !== SLICE_TEST_REVIEW_SCHEMA_VERSION) throw reviewError('SLICE_TEST_REVIEW_INVALID', `envelope.schemaVersion must be ${SLICE_TEST_REVIEW_SCHEMA_VERSION}`);
  if (item.type !== SLICE_TEST_REVIEW_TYPE) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'envelope.type is unsupported');
  const identity = normalizeIdentity(item.identity);
  const approval = normalizeApproval(item.approval);
  const criteria = validateSliceTestCriteria(item.criteria);
  const questions = item.questions === undefined
    ? Object.fromEntries(criteria.map((criterionValue) => [criterionValue.id, buildJevQuestion(criterionValue)]))
    : normalizeQuestions(item.questions, criteria);
  const requirements = boundedJson(item.requirements, 'requirements');
  const interfaces = boundedJson(item.interfaces, 'interfaces');
  const integration = boundedJson(item.integration, 'integration');
  const artifacts = normalizeArtifactRoles(item.artifacts);
  const inputDigest = concreteDigest(item.inputDigest, 'inputDigest');
  const capturedAt = timestamp(item.capturedAt, 'capturedAt');
  const provenance = normalizeProvenance(item.provenance);
  return { schemaVersion: 1, type: SLICE_TEST_REVIEW_TYPE, identity, approval, criteria, questions, requirements, interfaces, integration, artifacts, inputDigest, capturedAt, provenance, ...(item.envelopeDigest === undefined ? {} : { envelopeDigest: concreteDigest(item.envelopeDigest, 'envelopeDigest') }) };
}

function payloadForInput(value) {
  const { inputDigest: _inputDigest, capturedAt: _capturedAt, provenance: _provenance, envelopeDigest: _envelopeDigest, ...payload } = value;
  return payload;
}

function payloadForEnvelope(value) {
  const { envelopeDigest: _envelopeDigest, ...payload } = value;
  return payload;
}

export function validateSliceTestReviewEnvelope(value) {
  const normalized = normalizeEnvelopePayload(value);
  const expectedInput = digestJson(payloadForInput(normalized));
  if (normalized.inputDigest !== expectedInput) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'envelope inputDigest does not match retained criteria and bytes', { expected: expectedInput, actual: normalized.inputDigest });
  const expectedEnvelope = digestJson(payloadForEnvelope(normalized));
  if (normalized.envelopeDigest !== undefined && normalized.envelopeDigest !== expectedEnvelope) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'envelopeDigest does not match the immutable envelope');
  return {
    ...normalized,
    ...(normalized.envelopeDigest === undefined ? {} : { envelopeDigest: normalized.envelopeDigest }),
  };
}

export function createSliceTestReviewEnvelope(value) {
  const raw = plainObject(value, 'slice-test review envelope');
  const capturedAt = raw.capturedAt ?? new Date().toISOString();
  const provenance = raw.provenance ?? { source: 'validated-final-run', replayed: false, capture: 'controller-run-artifacts' };
  const normalizedWithoutDigests = normalizeEnvelopePayload({
    schemaVersion: raw.schemaVersion ?? SLICE_TEST_REVIEW_SCHEMA_VERSION,
    type: raw.type ?? SLICE_TEST_REVIEW_TYPE,
    ...raw,
    inputDigest: raw.inputDigest ?? digestJson(payloadForInput({
      schemaVersion: raw.schemaVersion ?? SLICE_TEST_REVIEW_SCHEMA_VERSION,
      type: raw.type ?? SLICE_TEST_REVIEW_TYPE,
      identity: raw.identity,
      approval: raw.approval,
      criteria: raw.criteria,
      requirements: raw.requirements,
      interfaces: raw.interfaces,
      integration: raw.integration,
      artifacts: raw.artifacts,
      inputDigest: sha256('slice-test-review-input-seed'),
      capturedAt,
      provenance,
    })),
    capturedAt,
    provenance,
  });
  const inputDigest = digestJson(payloadForInput(normalizedWithoutDigests));
  const withInput = { ...normalizedWithoutDigests, inputDigest };
  const envelopeDigest = digestJson(payloadForEnvelope(withInput));
  return validateSliceTestReviewEnvelope({ ...withInput, envelopeDigest });
}

function normalizeMeasurement(value, label) {
  if (value === SLICE_TEST_REVIEW_UNKNOWN) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be a nonnegative measured value or UNKNOWN`);
  return value;
}

function normalizeIntegerMeasurement(value, label) {
  if (value === SLICE_TEST_REVIEW_UNKNOWN) return value;
  if (!Number.isSafeInteger(value) || value < 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label} must be a nonnegative measured integer or UNKNOWN`);
  return value;
}

function normalizeMeasurements(value, label = 'measurements') {
  const item = value === undefined ? {} : plainObject(value, label);
  exactKeys(item, ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens'], label);
  return {
    latencyMs: normalizeMeasurement(item.latencyMs ?? SLICE_TEST_REVIEW_UNKNOWN, `${label}.latencyMs`),
    inputTokens: normalizeIntegerMeasurement(item.inputTokens ?? SLICE_TEST_REVIEW_UNKNOWN, `${label}.inputTokens`),
    outputTokens: normalizeIntegerMeasurement(item.outputTokens ?? SLICE_TEST_REVIEW_UNKNOWN, `${label}.outputTokens`),
    totalTokens: normalizeIntegerMeasurement(item.totalTokens ?? SLICE_TEST_REVIEW_UNKNOWN, `${label}.totalTokens`),
  };
}

function normalizeProvider(value) {
  if (value === undefined || value === SLICE_TEST_REVIEW_UNKNOWN) return SLICE_TEST_REVIEW_UNKNOWN;
  const item = plainObject(value, 'event.provider');
  exactKeys(item, ['id', 'configSha256', 'model', 'availability'], 'event.provider');
  const model = plainObject(item.model, 'event.provider.model');
  exactKeys(model, ['id', 'version'], 'event.provider.model');
  const availability = plainObject(item.availability, 'event.provider.availability');
  exactKeys(availability, ['status', 'available'], 'event.provider.availability');
  if (!PROVIDER_AVAILABILITY.has(availability.status)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.provider.availability.status is invalid');
  if (availability.available !== true && availability.available !== false && availability.available !== SLICE_TEST_REVIEW_UNKNOWN) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.provider.availability.available is invalid');
  return {
    id: identifier(item.id, 'event.provider.id'),
    configSha256: concreteDigest(item.configSha256, 'event.provider.configSha256'),
    model: { id: item.model.id === SLICE_TEST_REVIEW_UNKNOWN ? item.model.id : text(item.model.id, 'event.provider.model.id', 256), version: item.model.version === SLICE_TEST_REVIEW_UNKNOWN ? item.model.version : text(item.model.version, 'event.provider.model.version', 256) },
    availability: { status: availability.status, available: availability.available },
  };
}

function normalizeObservation(value, index) {
  const label = `event.assessment.observations[${index}]`;
  const item = plainObject(value, label);
  exactKeys(item, ['criterionId', 'criterionType', 'question', 'probability', 'judgment'], label);
  if (typeof item.probability !== 'number' || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.probability must be a probability`);
  if (item.judgment !== SLICE_TEST_REVIEW_UNKNOWN) throw reviewError('SLICE_TEST_REVIEW_INVALID', `${label}.judgment must remain UNKNOWN until policy classification is selected`);
  return {
    criterionId: identifier(item.criterionId, `${label}.criterionId`),
    criterionType: identifier(item.criterionType, `${label}.criterionType`, SLUG),
    question: text(item.question, `${label}.question`),
    probability: item.probability,
    judgment: SLICE_TEST_REVIEW_UNKNOWN,
  };
}

function normalizeAssessment(value) {
  const item = plainObject(value, 'event.assessment');
  exactKeys(item, ['status', 'verdict', 'observations', 'provider', 'request', 'measurements', 'reason'], 'event.assessment');
  if (!EVENT_STATUSES.has(item.status)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.assessment.status is invalid');
  if (!EVENT_VERDICTS.has(item.verdict)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.assessment.verdict is invalid');
  if (!Array.isArray(item.observations)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.assessment.observations must be an array');
  const observations = item.observations.map(normalizeObservation);
  const provider = normalizeProvider(item.provider);
  let request;
  if (item.request === undefined || item.request === SLICE_TEST_REVIEW_UNKNOWN) request = SLICE_TEST_REVIEW_UNKNOWN;
  else {
    const requestValue = plainObject(item.request, 'event.assessment.request');
    exactKeys(requestValue, ['sha256', 'bytes', 'questionSha256'], 'event.assessment.request');
    if (!Number.isSafeInteger(requestValue.bytes) || requestValue.bytes < 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.assessment.request.bytes is invalid');
    request = {
      sha256: concreteDigest(requestValue.sha256, 'event.assessment.request.sha256'),
      bytes: requestValue.bytes,
      ...(requestValue.questionSha256 === undefined ? {} : { questionSha256: concreteDigest(requestValue.questionSha256, 'event.assessment.request.questionSha256') }),
    };
  }
  return {
    status: item.status,
    verdict: item.verdict,
    observations,
    provider,
    request,
    measurements: normalizeMeasurements(item.measurements, 'event.assessment.measurements'),
    ...(item.reason === undefined ? {} : { reason: text(item.reason, 'event.assessment.reason', 2048) }),
  };
}

function normalizeReview(value) {
  if (value === undefined || value === SLICE_TEST_REVIEW_UNKNOWN) return SLICE_TEST_REVIEW_UNKNOWN;
  const item = plainObject(value, 'event.review');
  exactKeys(item, ['reviewer', 'strength', 'attested', 'verdict', 'inputDigest', 'reason'], 'event.review');
  const reviewer = plainObject(item.reviewer, 'event.review.reviewer');
  exactKeys(reviewer, ['id', 'role'], 'event.review.reviewer');
  if (!['strong', 'unknown'].includes(item.strength)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.review.strength is invalid');
  if (typeof item.attested !== 'boolean') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.review.attested must be boolean');
  if (!['accepted', 'rejected', 'UNKNOWN'].includes(item.verdict)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'event.review.verdict is invalid');
  return {
    reviewer: { id: text(reviewer.id, 'event.review.reviewer.id', 256), role: text(reviewer.role, 'event.review.reviewer.role', 256) },
    strength: item.strength,
    attested: item.attested,
    verdict: item.verdict,
    inputDigest: concreteDigest(item.inputDigest, 'event.review.inputDigest'),
    ...(item.reason === undefined ? {} : { reason: text(item.reason, 'event.review.reason', 2048) }),
  };
}

function eventPayload(value) {
  const { eventDigest: _eventDigest, ...payload } = value;
  return payload;
}

function eventIdentityPayload(value) {
  const { eventDigest: _eventDigest, timestamp: _timestamp, sequence: _sequence, eventId: _eventId, ...payload } = value;
  return payload;
}

export function createSliceTestReviewEvent(value) {
  const item = plainObject(value, 'slice-test review event');
  exactKeys(item, ['schemaVersion', 'type', 'eventId', 'eventType', 'sequence', 'timestamp', 'identity', 'inputDigest', 'envelopeDigest', 'assessment', 'review', 'route', 'reason', 'provenance', 'eventDigest'], 'slice-test review event');
  const eventType = item.eventType;
  if (!SLICE_TEST_REVIEW_EVENT_TYPES.includes(eventType)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'eventType is unsupported');
  if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'sequence must be a positive safe integer');
  const normalized = {
    schemaVersion: SLICE_TEST_REVIEW_EVENT_SCHEMA_VERSION,
    type: SLICE_TEST_REVIEW_EVENT_TYPE,
    eventType,
    sequence: item.sequence,
    timestamp: timestamp(item.timestamp ?? new Date().toISOString(), 'event.timestamp'),
    identity: normalizeIdentity(item.identity, 'event.identity'),
    inputDigest: concreteDigest(item.inputDigest, 'event.inputDigest'),
    envelopeDigest: concreteDigest(item.envelopeDigest, 'event.envelopeDigest'),
    assessment: normalizeAssessment(item.assessment),
    review: normalizeReview(item.review),
    ...(item.route === undefined ? {} : { route: text(item.route, 'event.route', 128) }),
    ...(item.reason === undefined ? {} : { reason: text(item.reason, 'event.reason', 2048) }),
    provenance: normalizeProvenance(item.provenance, 'event.provenance'),
  };
  const expectedEventId = `event-${sha256(stableStringify(eventIdentityPayload(normalized)))}`;
  if (item.eventId !== undefined && item.eventId !== expectedEventId) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'eventId does not match immutable event identity');
  normalized.eventId = expectedEventId;
  const expectedDigest = digestJson(eventPayload(normalized));
  if (item.eventDigest !== undefined && item.eventDigest !== expectedDigest) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'eventDigest does not match the immutable event');
  normalized.eventDigest = expectedDigest;
  return normalized;
}

export function validateSliceTestReviewEvent(value) {
  return createSliceTestReviewEvent(value);
}

function internalLedgerPaths(root) {
  return Promise.all([
    assertInternalPath(root, ['.tinysdd', 'runs', 'slice-test-review'], { allowMissing: true, requireDirectory: true }),
    assertInternalPath(root, ['.tinysdd', 'runs', 'slice-test-review', 'events.jsonl'], { allowMissing: true }),
    assertInternalPath(root, ['.tinysdd', 'runs', 'slice-test-review', 'events.lock'], { allowMissing: true }),
  ]).then(([, ledger, lock]) => ({ ledger, lock }));
}

async function readLedgerText(ledger) {
  let info;
  try { info = await lstat(ledger); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (info.isSymbolicLink()) throw reviewError('SLICE_TEST_REVIEW_SYMLINK', 'slice-test review ledger must not be a symlink');
  if (!info.isFile()) throw reviewError('SLICE_TEST_REVIEW_INVALID_FILE', 'slice-test review ledger must be a regular file');
  if (info.size > SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review ledger exceeds its byte limit');
  const content = await readFile(ledger, 'utf8');
  if (Buffer.byteLength(content) > SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review ledger exceeds its byte limit');
  return content;
}

function parseLedgerText(textValue) {
  if (textValue.length === 0) return [];
  if (!textValue.endsWith('\n')) throw reviewError('SLICE_TEST_REVIEW_PARTIAL', 'slice-test review ledger has a partial trailing record');
  const lines = textValue.slice(0, -1).split('\n');
  if (lines.length > SLICE_TEST_REVIEW_MAX_EVENTS) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review ledger contains too many events');
  const records = lines.map((line, index) => {
    if (line.length === 0 || Buffer.byteLength(line) > SLICE_TEST_REVIEW_MAX_EVENT_BYTES) throw reviewError('SLICE_TEST_REVIEW_PARTIAL', `slice-test review ledger line ${index + 1} is invalid`);
    let value;
    try { value = JSON.parse(line); } catch { throw reviewError('SLICE_TEST_REVIEW_PARTIAL', `slice-test review ledger line ${index + 1} is malformed JSON`); }
    return validateSliceTestReviewEvent(value);
  });
  const ids = new Set();
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].sequence !== index + 1) throw reviewError('SLICE_TEST_REVIEW_OUT_OF_ORDER', 'slice-test review event sequence is not contiguous');
    if (ids.has(records[index].eventId)) throw reviewError('SLICE_TEST_REVIEW_DUPLICATE', `duplicate slice-test review event: ${records[index].eventId}`);
    ids.add(records[index].eventId);
  }
  return records;
}

export async function readSliceTestReviewEvents(projectRoot) {
  const root = projectRoot;
  const { ledger } = await internalLedgerPaths(root);
  return parseLedgerText(await readLedgerText(ledger));
}

export async function appendSliceTestReviewEvents(projectRoot, values) {
  if (!Array.isArray(values) || values.length === 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'slice-test review events must be a nonempty array');
  if (values.length > SLICE_TEST_REVIEW_MAX_EVENTS) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review append is too large');
  const normalized = values.map(validateSliceTestReviewEvent);
  const ids = new Set();
  for (const event of normalized) {
    if (ids.has(event.eventId)) throw reviewError('SLICE_TEST_REVIEW_DUPLICATE', `duplicate event in append: ${event.eventId}`);
    ids.add(event.eventId);
  }
  const root = projectRoot;
  const { ledger, lock } = await internalLedgerPaths(root);
  const directory = await assertInternalPath(root, ['.tinysdd', 'runs', 'slice-test-review'], { allowMissing: true, requireDirectory: true });
  await ensureDirectory(directory);
  return withExclusiveLock(lock, async () => {
    const existing = parseLedgerText(await readLedgerText(ledger));
    const firstSequence = existing.length + 1;
    for (let index = 0; index < normalized.length; index += 1) {
      const event = normalized[index];
      const prior = existing.find((entry) => entry.eventId === event.eventId);
      if (prior) {
        if (stableStringify(prior) === stableStringify(event)) throw reviewError('SLICE_TEST_REVIEW_DUPLICATE', `slice-test review event already exists: ${event.eventId}`);
        throw reviewError('SLICE_TEST_REVIEW_CONFLICT', `slice-test review event identity conflicts: ${event.eventId}`);
      }
      if (event.sequence !== firstSequence + index) throw reviewError('SLICE_TEST_REVIEW_OUT_OF_ORDER', `event sequence must be ${firstSequence + index}`);
    }
    const content = `${normalized.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const currentBytes = Buffer.byteLength(await readLedgerText(ledger));
    if (currentBytes + Buffer.byteLength(content) > SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review ledger exceeds its byte limit');
    if (existing.length + normalized.length > SLICE_TEST_REVIEW_MAX_EVENTS) throw reviewError('SLICE_TEST_REVIEW_LEDGER_TOO_LARGE', 'slice-test review ledger contains too many events');
    await appendFile(ledger, content, { encoding: 'utf8', mode: 0o600 });
    return normalized;
  });
}

export async function sliceTestReviewLedgerPaths(projectRoot) {
  const root = projectRoot;
  return internalLedgerPaths(root);
}

async function readRunJson(root, runId, name) {
  const path = await assertInternalPath(root, ['.tinysdd', 'runs', runId, name], { allowMissing: false });
  let info;
  try { info = await lstat(path); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${name} is unavailable`); }
  if (info.isSymbolicLink() || !info.isFile()) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${name} is not a regular file`);
  if (info.size > SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${name} exceeds its bounded size`);
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${name} is malformed`); }
  return parsed;
}

async function readRunBytes(root, runId, workspace, projectPathValue, maxBytes = JEV_DECISION_MAX_ARTIFACT_BYTES) {
  const cleanPath = projectPath(projectPathValue, `${workspace} path`);
  const path = await assertInternalPath(root, ['.tinysdd', 'runs', runId, workspace, ...cleanPath.split('/')], { allowMissing: false });
  let info;
  try { info = await lstat(path); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace}/${cleanPath} is unavailable`); }
  if (info.isSymbolicLink() || !info.isFile()) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace}/${cleanPath} is not a regular file`);
  if (info.size > maxBytes) throw reviewError('SLICE_TEST_REVIEW_ARTIFACT_TOO_LARGE', `${workspace}/${cleanPath} exceeds its byte limit`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `${workspace}/${cleanPath} changed while being read`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw reviewError('SLICE_TEST_REVIEW_ARTIFACT_TOO_LARGE', `${workspace}/${cleanPath} exceeds its byte limit`);
    return Buffer.from(bytes);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashWorkspaceFile(path, expectedInfo, maxBytes) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== expectedInfo.ino || opened.dev !== expectedInfo.dev) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'workspace file changed while being snapshotted');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'workspace snapshot exceeds its bounded byte limit');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return { sha256: hash.digest('hex'), size: bytes };
  } catch (error) {
    if (error?.code === 'ELOOP') throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'workspace snapshot contains a symlinked file');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function snapshotRunWorkspace(root, runId, workspace) {
  const directory = await assertInternalPath(root, ['.tinysdd', 'runs', runId, workspace], { allowMissing: false, requireDirectory: true });
  const snapshot = Object.create(null);
  let entriesSeen = 0;
  let bytesSeen = 0;
  async function visit(current, prefix = '') {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace} cannot be read`); }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_ENTRIES) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace} exceeds its entry limit`);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      let info;
      try { info = await lstat(absolute); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace} cannot retain ${relativePath}`); }
      if (info.isSymbolicLink()) {
        snapshot[relativePath] = { kind: 'symlink', sha256: null, size: null };
      } else if (info.isDirectory()) {
        snapshot[relativePath] = { kind: 'directory', sha256: null, size: null };
        await visit(absolute, relativePath);
      } else if (info.isFile()) {
        if (info.size > SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_BYTES || bytesSeen > SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_BYTES - info.size) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} ${workspace} exceeds its byte limit`);
        const hashed = await hashWorkspaceFile(absolute, info, SLICE_TEST_REVIEW_MAX_RUN_SNAPSHOT_BYTES - bytesSeen);
        bytesSeen += hashed.size;
        snapshot[relativePath] = { kind: 'file', ...hashed };
      } else {
        snapshot[relativePath] = { kind: 'other', sha256: null, size: null };
      }
    }
  }
  await visit(directory);
  return snapshot;
}

function runSnapshotChanges(before, after) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const beforeDescendants = new Set();
  const afterDescendants = new Set();
  for (const value of Object.keys(before)) {
    const parts = value.split('/');
    for (let index = 1; index < parts.length; index += 1) beforeDescendants.add(parts.slice(0, index).join('/'));
  }
  for (const value of Object.keys(after)) {
    const parts = value.split('/');
    for (let index = 1; index < parts.length; index += 1) afterDescendants.add(parts.slice(0, index).join('/'));
  }
  return paths.flatMap((pathValue) => {
    const oldValue = before[pathValue];
    const newValue = after[pathValue];
    if (stableStringify(oldValue) === stableStringify(newValue)) return [];
    if (!oldValue && newValue?.kind === 'directory' && afterDescendants.has(pathValue)) return [];
    if (!newValue && oldValue?.kind === 'directory' && beforeDescendants.has(pathValue)) return [];
    const change = !oldValue ? 'created' : !newValue ? 'deleted' : oldValue.kind !== newValue.kind ? 'type_changed' : 'modified';
    return [{ path: pathValue, change, before: oldValue ?? null, after: newValue ?? null }];
  });
}

function compareSnapshotRecords(left, right, label) {
  if (stableStringify(left) !== stableStringify(right)) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `${label} does not match retained workspace evidence`, { left, right });
}

async function loadTrustedLineage(root, packet, runId) {
  const newestFirst = [];
  const seen = new Set();
  let currentId = runId;
  let aliases;
  try { aliases = await detectFilesystemAliases(root); } catch { throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'filesystem alias behavior could not be validated'); }
  const inputPaths = [packet.brief?.path, packet.context?.path, packet.checks?.path].filter((value) => typeof value === 'string');
  const preparation = packet.preparation ?? [];
  const immutablePreparationPaths = preparationPaths(preparation);
  const protectedPaths = packet.protectedPaths ?? [];
  const dependencyMounts = packet.dependencies?.filter((item) => typeof item === 'string') ?? [];
  while (currentId !== undefined && currentId !== null) {
    if (seen.has(currentId)) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'run lineage contains a cycle');
    if (seen.size >= 32) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'run lineage exceeds its bounded depth');
    seen.add(currentId);
    const result = await readRunJson(root, currentId, 'result.json');
    if (result.runId !== currentId || result.taskId !== packet.taskId) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} has an inconsistent task or run identity`);
    if (result.baselineRun !== undefined) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} is a replay and cannot be assessed as a live candidate`);
    if (result.outcome !== 'completed' || !Array.isArray(result.scopeViolations) || result.scopeViolations.length > 0) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} is not a completed scope-clean run`);
    const before = await snapshotRunWorkspace(root, currentId, 'workspace-before');
    const after = await snapshotRunWorkspace(root, currentId, 'workspace-after');
    compareSnapshotRecords(await readRunJson(root, currentId, 'before-snapshot.json'), before, `run ${currentId} before snapshot`);
    compareSnapshotRecords(await readRunJson(root, currentId, 'after-snapshot.json'), after, `run ${currentId} after snapshot`);
    const actual = runSnapshotChanges(before, after);
    const claimed = Array.isArray(result.changedPaths) ? result.changedPaths : null;
    if (!claimed) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} has no changed path inventory`);
    compareSnapshotRecords([...claimed].sort((left, right) => String(left?.path).localeCompare(String(right?.path))), [...actual].sort((left, right) => left.path.localeCompare(right.path)), `run ${currentId} changed paths`);
    if (!result.fileScope || result.fileScope.mode !== 'ordinary-create-modify' || result.fileScope.ordinaryCreateModify !== true || result.fileScope.deletions !== false || !Array.isArray(result.fileScope.actualPaths)) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} lacks complete file-scope evidence`);
    if (result.fileScope.actualPaths.some((value) => observedPathError(value)) || new Set(result.fileScope.actualPaths).size !== result.fileScope.actualPaths.length) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} file-scope paths are not canonical`);
    compareSnapshotRecords([...result.fileScope.actualPaths].sort(), actual.map((item) => item.path).sort(), `run ${currentId} file-scope paths`);
    for (const change of actual) {
      const violation = classifyFileScopeChange(change, {
        protectedPaths,
        inputPaths,
        preparationPaths: immutablePreparationPaths,
        dependencyMounts,
        caseInsensitive: aliases.caseInsensitive,
        unicodeInsensitive: aliases.unicodeInsensitive,
        filesystemAliases: aliases,
      });
      if (violation) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} contains an ineligible change`);
      if (!['created', 'modified'].includes(change.change) || change.after?.kind !== 'file') throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} contains a non-file or deletion change`);
    }
    newestFirst.push({ id: currentId, result, before, after, changes: actual });
    const parent = result.baseRun?.id;
    if (parent !== undefined && parent !== null && (typeof parent !== 'string' || !RUN_ID.test(parent))) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${currentId} has an invalid base run id`);
    currentId = parent;
  }
  if (newestFirst.length === 0) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', 'run lineage is empty');
  return newestFirst.reverse();
}

function snapshotFile(snapshot, projectPath, label) {
  const item = snapshot?.[projectPath];
  if (!item || item.kind !== 'file' || typeof item.sha256 !== 'string' || !DIGEST.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `${label} does not retain a regular-file snapshot for ${projectPath}`);
  return item;
}

async function captureLineageArtifacts(root, lineage, roles, protectedPaths, additionalPaths = []) {
  const rootRun = lineage[0];
  const finalRun = lineage[lineage.length - 1];
  const actualPaths = [...new Set([
    ...lineage.flatMap((run) => run.changes.map((change) => change.path)),
    ...additionalPaths,
  ])].sort();
  const artifacts = [];
  for (const projectPath of actualPaths) {
    const finalSnapshot = snapshotFile(finalRun.after, projectPath, `run ${finalRun.id} after-snapshot`);
    const changedInLineage = lineage.some((run) => run.changes.some((change) => change.path === projectPath));
    if (!changedInLineage && finalSnapshot.kind !== 'file') throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `declared retained path is not a regular file: ${projectPath}`);
    const bytes = await readRunBytes(root, finalRun.id, 'workspace-after', projectPath);
    if (sha256(bytes) !== finalSnapshot.sha256 || bytes.byteLength !== finalSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `retained bytes do not match final snapshot: ${projectPath}`);
    artifacts.push({ role: roles.get(projectPath) ?? 'candidate-extra', path: projectPath, bytes: bytes.byteLength, sha256: finalSnapshot.sha256, contentBase64: bytes.toString('base64') });
  }
  for (const projectPath of protectedPaths) {
    if (actualPaths.includes(projectPath)) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `protected path overlaps a candidate path: ${projectPath}`);
    const beforeSnapshot = snapshotFile(rootRun.before, projectPath, `run ${rootRun.id} before-snapshot`);
    const afterSnapshot = snapshotFile(finalRun.after, projectPath, `run ${finalRun.id} after-snapshot`);
    if (beforeSnapshot.sha256 !== afterSnapshot.sha256 || beforeSnapshot.size !== afterSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `protected path changed across run lineage: ${projectPath}`);
    const bytes = await readRunBytes(root, rootRun.id, 'workspace-before', projectPath);
    if (sha256(bytes) !== beforeSnapshot.sha256 || bytes.byteLength !== beforeSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `protected bytes do not match retained snapshot: ${projectPath}`);
    artifacts.push({ role: 'protected-feature-test', path: projectPath, bytes: bytes.byteLength, sha256: beforeSnapshot.sha256, contentBase64: bytes.toString('base64') });
  }
  return { artifacts, rootBefore: rootRun.before, finalAfter: finalRun.after, rootRunId: rootRun.id };
}

function typedCriteriaFromBrief(briefText) {
  const parsed = parseApprovedBriefSections(briefText);
  return parsed.testReview.criteria.map((item) => ({ ...item, type: 'slice-test-adequacy' }));
}

function compareCriteria(left, right) {
  const withoutType = (item) => ({ id: item.id, question: item.question, requirementIds: item.requirementIds, interfaces: item.interfaces, testPaths: item.testPaths });
  return stableStringify(left.map(withoutType)) === stableStringify(right.map(withoutType));
}

/**
 * Capture the exact approved packet and a controller-validated final-run
 * candidate. The helper derives candidate paths from retained changed-path
 * identities and never follows assistant-supplied artifactPaths.
 */
export async function captureSliceTestReviewEnvelope({
  projectRoot,
  packet,
  runId,
  changePath,
  featureId,
  sliceId,
  criteria = undefined,
  requirements = undefined,
  interfaces = undefined,
  integration = undefined,
  implementationFiles = undefined,
  sliceTests = undefined,
  protectedPaths = undefined,
  preparationArtifacts = [],
  lineageId = undefined,
  revision = 0,
  capturedAt = undefined,
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'projectRoot is required');
  const root = projectRoot;
  const currentPacket = plainObject(packet, 'packet');
  if (typeof currentPacket.taskId !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.taskId is required');
  if (!currentPacket.brief || typeof currentPacket.brief.text !== 'string' || typeof currentPacket.brief.sha256 !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.brief must retain exact text and digest');
  if (!currentPacket.approval || typeof currentPacket.approval.approvalDigest !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.approval must retain the current approval');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'runId is required');
  if (sha256(currentPacket.brief.text) !== currentPacket.brief.sha256) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet brief digest does not match its retained text');
  if (currentPacket.context?.text !== undefined && sha256(currentPacket.context.text) !== currentPacket.context.sha256) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet context digest does not match its retained text');
  if (currentPacket.checks?.text !== undefined && sha256(currentPacket.checks.text) !== currentPacket.checks.sha256) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet checks digest does not match its retained text');
  const packetOnDisk = await readRunJson(root, runId, 'packet.json');
  if (!packetOnDisk.approval || packetOnDisk.approval.approvalDigest !== currentPacket.approval.approvalDigest) throw reviewError('SLICE_TEST_REVIEW_RUN_APPROVAL_MISMATCH', `run ${runId} approval does not match the current packet`);
  if (packetOnDisk.taskId !== currentPacket.taskId) throw reviewError('SLICE_TEST_REVIEW_RUN_INVALID', `run ${runId} belongs to another task`);
  if (packetOnDisk.brief?.sha256 !== currentPacket.brief.sha256 || packetOnDisk.context?.sha256 !== currentPacket.context?.sha256 || packetOnDisk.checks?.sha256 !== currentPacket.checks?.sha256) throw reviewError('SLICE_TEST_REVIEW_RUN_APPROVAL_MISMATCH', `run ${runId} packet inputs do not match the current packet`);
  const lineage = await loadTrustedLineage(root, currentPacket, runId);
  if (typeof changePath !== 'string' || changePath.length === 0) throw reviewError('SLICE_TEST_REVIEW_INVALID', 'changePath is required to validate the approved descriptor graph');
  let validated;
  try { validated = await validateChange({ projectRoot: root, changePath, requireReady: true }); } catch (error) {
    throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'approved descriptor graph is not currently valid', { cause: error?.code ?? 'invalid' });
  }
  const descriptorSlice = validated.slices.find((item) => item.value.id === sliceId);
  if (!descriptorSlice) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `approved descriptor graph has no slice ${sliceId}`);
  if (currentPacket.taskId !== sliceId || featureId !== validated.change.id) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet task and feature identities do not match the validated descriptor graph');
  if (descriptorSlice.brief.text !== currentPacket.brief.text || descriptorSlice.brief.sha256 !== currentPacket.brief.sha256) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet brief is not the approved descriptor brief');
  if (currentPacket.context?.text !== undefined && (descriptorSlice.context?.text !== currentPacket.context.text || descriptorSlice.context?.sha256 !== currentPacket.context.sha256)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet context is not the approved descriptor context');
  if (currentPacket.checks?.text !== undefined && (descriptorSlice.checks?.text !== currentPacket.checks.text || descriptorSlice.checks?.sha256 !== currentPacket.checks.sha256)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet checks are not the approved descriptor checks');
  const plan = validated.registrationPlan.find((item) => item.id === sliceId);
  if (!plan || stableStringify(currentPacket.preparation ?? []) !== stableStringify(plan.preparation)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'packet preparation does not match the validated descriptor graph');
  const briefCriteria = typedCriteriaFromBrief(currentPacket.brief.text);
  const selectedCriteria = criteria === undefined
    ? briefCriteria
    : validateSliceTestCriteria(criteria.map((item) => ({ ...item, type: item.type ?? 'slice-test-adequacy' })));
  if (!compareCriteria(selectedCriteria, briefCriteria)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'criteria do not match the approval-bound brief');
  const approvedRequirements = parseApprovedBriefSections(currentPacket.brief.text).requirements;
  if (requirements !== undefined && stableStringify(requirements) !== stableStringify(approvedRequirements)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'requirements do not match the approval-bound brief');
  const approvedInterfaces = descriptorSlice.value.interfaces;
  const approvedIntegration = validated.change.integration.filter((item) => item.wiringSlice === sliceId || item.testPaths.some((testPath) => validated.change.featureTests.includes(testPath)));
  if (interfaces !== undefined && stableStringify(interfaces) !== stableStringify(approvedInterfaces)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'interfaces do not match the validated descriptor graph');
  if (integration !== undefined && stableStringify(integration) !== stableStringify(approvedIntegration)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'integration does not match the validated descriptor graph');
  const approvedImplementationFiles = descriptorSlice.value.implementationFiles;
  const approvedSliceTests = descriptorSlice.value.sliceTests;
  if (implementationFiles !== undefined && stableStringify(implementationFiles) !== stableStringify(approvedImplementationFiles)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'implementation files do not match the validated descriptor graph');
  if (sliceTests !== undefined && stableStringify(sliceTests) !== stableStringify(approvedSliceTests)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'slice tests do not match the validated descriptor graph');
  const approvedProtectedPaths = [...new Set([...validated.change.featureTests, ...descriptorSlice.value.protect])].sort();
  if (protectedPaths !== undefined && stableStringify([...protectedPaths].sort()) !== stableStringify(approvedProtectedPaths)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'protected paths do not match the validated descriptor graph');
  const roles = new Map();
  for (const [index, candidatePath] of approvedImplementationFiles.entries()) roles.set(projectPath(candidatePath, `implementationFiles[${index}]`), 'candidate');
  for (const [index, testPath] of approvedSliceTests.entries()) roles.set(projectPath(testPath, `sliceTests[${index}]`), 'slice-test');
  const preparationList = currentPacket.preparation ?? [];
  const inputPaths = new Set([currentPacket.brief.path, currentPacket.context?.path, currentPacket.checks?.path, ...preparationPaths(preparationList)].filter((value) => typeof value === 'string'));
  const packetInputPaths = new Set([currentPacket.brief.path, currentPacket.context?.path, currentPacket.checks?.path].filter((value) => typeof value === 'string'));
  const protectedList = approvedProtectedPaths.map((pathValue, index) => projectPath(pathValue, `protectedPaths[${index}]`)).filter((value) => !packetInputPaths.has(value)).sort();
  for (const pathValue of roles.keys()) {
    if (protectedList.includes(pathValue) || inputPaths.has(pathValue)) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `candidate path overlaps an immutable input: ${pathValue}`);
  }
  const declaredCandidatePaths = [...roles.keys()];
  const captured = await captureLineageArtifacts(root, lineage, roles, protectedList, declaredCandidatePaths);
  const exactArtifacts = [...captured.artifacts, ...preparationArtifacts];
  for (const [index, entry] of preparationList.entries()) {
    const pathValue = projectPath(typeof entry === 'string' ? entry : entry.path, `preparation[${index}]`);
    if (entry?.exists === false) continue;
    const beforeSnapshot = snapshotFile(captured.rootBefore, pathValue, 'root workspace-before snapshot');
    const afterSnapshot = snapshotFile(captured.finalAfter, pathValue, 'final workspace-after snapshot');
    if (beforeSnapshot.sha256 !== afterSnapshot.sha256 || beforeSnapshot.size !== afterSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `preparation path changed across the retained run lineage: ${pathValue}`);
    const bytes = await readRunBytes(root, captured.rootRunId, 'workspace-before', pathValue);
    if (sha256(bytes) !== beforeSnapshot.sha256 || bytes.byteLength !== beforeSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `preparation bytes do not match the retained snapshot: ${pathValue}`);
    if (entry?.sha256 !== undefined && entry.sha256 !== beforeSnapshot.sha256) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `preparation digest does not match the approved descriptor: ${pathValue}`);
    if (entry?.bytes !== undefined && entry.bytes !== beforeSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `preparation size does not match the approved descriptor: ${pathValue}`);
    const existing = exactArtifacts.find((artifact) => artifact.path === pathValue);
    if (existing) {
      if (existing.sha256 !== beforeSnapshot.sha256 || existing.bytes !== beforeSnapshot.size) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `preparation artifact does not match the approved descriptor: ${pathValue}`);
    } else {
      exactArtifacts.push({ role: 'approved-preparation', path: pathValue, bytes: bytes.byteLength, sha256: beforeSnapshot.sha256, contentBase64: bytes.toString('base64') });
    }
  }
  if (typeof currentPacket.brief.path !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.brief.path is required for exact retention');
  exactArtifacts.push({ role: 'approved-brief', path: projectPath(currentPacket.brief.path, 'packet.brief.path'), bytes: Buffer.byteLength(currentPacket.brief.text), sha256: sha256(currentPacket.brief.text), contentBase64: Buffer.from(currentPacket.brief.text).toString('base64') });
  if (currentPacket.context?.text !== undefined) {
    if (typeof currentPacket.context.path !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.context.path is required for exact retention');
    exactArtifacts.push({ role: 'approved-context', path: projectPath(currentPacket.context.path, 'packet.context.path'), bytes: Buffer.byteLength(currentPacket.context.text), sha256: sha256(currentPacket.context.text), contentBase64: Buffer.from(currentPacket.context.text).toString('base64') });
  }
  if (currentPacket.checks?.text !== undefined) {
    if (typeof currentPacket.checks.path !== 'string') throw reviewError('SLICE_TEST_REVIEW_INVALID', 'packet.checks.path is required for exact retention');
    exactArtifacts.push({ role: 'approved-checks', path: projectPath(currentPacket.checks.path, 'packet.checks.path'), bytes: Buffer.byteLength(currentPacket.checks.text), sha256: sha256(currentPacket.checks.text), contentBase64: Buffer.from(currentPacket.checks.text).toString('base64') });
  }
  const artifactByPath = new Map();
  for (const artifact of exactArtifacts) {
    if (artifactByPath.has(artifact.path)) {
      const previous = artifactByPath.get(artifact.path);
      const sameBytes = previous.bytes === artifact.bytes && previous.sha256 === artifact.sha256 && previous.contentBase64 === artifact.contentBase64;
      if (!sameBytes) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', `retained artifact path has conflicting bytes: ${artifact.path}`);
      const priority = (role) => role === 'protected-feature-test' ? 2 : role.startsWith('approved-') ? 1 : 0;
      if (priority(artifact.role) > priority(previous.role)) artifactByPath.set(artifact.path, artifact);
    } else artifactByPath.set(artifact.path, artifact);
  }
  const runIds = lineage.map((run) => run.id);
  const resolvedRootRunId = runIds[0];
  const resolvedLineageId = `lineage-${sha256(stableStringify({ taskId: currentPacket.taskId, approvalDigest: currentPacket.approval.approvalDigest, rootRunId: resolvedRootRunId }))}`;
  if (lineageId !== undefined && lineageId !== resolvedLineageId) throw reviewError('SLICE_TEST_REVIEW_INPUT_MISMATCH', 'lineageId does not match the approval-bound run lineage');
  const approval = normalizeApproval({
    approvalDigest: currentPacket.approval.approvalDigest,
    briefDigest: currentPacket.approval.briefDigest ?? currentPacket.brief.sha256,
    contextDigest: currentPacket.approval.contextDigest ?? null,
    checksDigest: currentPacket.approval.checksDigest ?? currentPacket.checks?.sha256 ?? null,
    preparationDigest: currentPacket.approval.preparationDigest ?? SLICE_TEST_REVIEW_UNKNOWN,
    ...(currentPacket.approval.descriptorSetSha256 === undefined ? {} : { descriptorSetSha256: currentPacket.approval.descriptorSetSha256 }),
    ...(currentPacket.approval.testReviewContractSha256 === undefined ? {} : { testReviewContractSha256: currentPacket.approval.testReviewContractSha256 }),
  });
  return createSliceTestReviewEnvelope({
    schemaVersion: 1,
    type: SLICE_TEST_REVIEW_TYPE,
    identity: { featureId, taskId: currentPacket.taskId, sliceId, runId, rootRunId: resolvedRootRunId, lineageId: resolvedLineageId, revision },
    approval,
    criteria: selectedCriteria,
    requirements: approvedRequirements,
    interfaces: approvedInterfaces,
    integration: approvedIntegration,
    artifacts: [...artifactByPath.values()],
    capturedAt,
    provenance: { source: 'validated-final-run', replayed: false, capture: 'controller-run-artifacts' },
  });
}
