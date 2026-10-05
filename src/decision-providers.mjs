import {
  assertInternalPath,
  digestJson,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import {
  DECISION_POINTS,
  DECISION_UNKNOWN,
  decisionCaseInput,
  decisionCaseInputDigest,
  decisionDatasetDigest,
  predictionsDigest,
  validateDecisionDataset,
  validateDecisionPredictions,
} from './decision-dataset.mjs';
import { evaluateDecisions } from './decision-evaluation.mjs';

export const DECISION_PROVIDER_SCHEMA_VERSION = 1;
export const DECISION_OBSERVATION_SCHEMA_VERSION = 1;
export const DECISION_QUESTIONS_SCHEMA_VERSION = 1;
export const DECISION_PROVIDER_MODES = Object.freeze(['off', 'shadow', 'enforce']);
export const DECISION_QUESTION_TYPES = Object.freeze(['choice', 'score', 'noul']);
export const DECISION_OBSERVATION_ACTION = 'no-enforcement';
export const DECISION_PROVIDER_INPUT_MAX_BYTES = 512 * 1024;
export const DECISION_MAX_OBSERVATIONS = 16384;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_LENGTH = 4096;
const MAX_STRING_LENGTH = 128 * 1024;
const OFF_REASONS = new Set([
  'mode-off',
  'provider-missing',
  'provider-unavailable',
  'provider-availability-unknown',
  'provider-error',
  'invalid-response',
  'missing-saved-prediction',
  'unmapped-decision',
]);

function invalid(message, details = undefined) {
  throw tinyError('DECISION_PROVIDER_INVALID', message, details);
}

function unsupported(message) {
  throw tinyError('DECISION_PROVIDER_UNSUPPORTED', message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${label} contains unknown key: ${key}`);
  }
}

function boundedValue(value, label, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) invalid(`${label} exceeds maximum nesting depth`);
  if (value === DECISION_UNKNOWN || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) invalid(`${label} exceeds maximum string length`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value !== 'object') invalid(`${label} contains an unsupported value`);
  if (seen.has(value)) invalid(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) invalid(`${label} contains too many entries`);
    const result = value.map((entry, index) => boundedValue(entry, `${label}[${index}]`, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must contain plain objects`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) invalid(`${label} contains too many keys`);
  const result = {};
  for (const [key, entry] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid(`${label}.${key} is not allowed`);
    Object.defineProperty(result, key, {
      value: boundedValue(entry, `${label}.${key}`, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return result;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !ID_PATTERN.test(value)) {
    invalid(`${label} must be a bounded identifier`);
  }
  return value;
}

function text(value, label, { allowUnknown = false, max = 256 } = {}) {
  if (allowUnknown && value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${label} must be a bounded string`);
  return value;
}

function digest(value, label, { allowUnknown = false } = {}) {
  if (allowUnknown && value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function probability(value, label, { allowUnknown = false } = {}) {
  if (allowUnknown && value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${label} must be a finite probability from 0 to 1`);
  }
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a finite number`);
  return value;
}

function label(value, labelName) {
  if (value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'string' && typeof value !== 'boolean') invalid(`${labelName} must be a string, boolean, or UNKNOWN`);
  if (typeof value === 'string' && (value.length === 0 || value.length > 128)) invalid(`${labelName} must be a bounded nonempty string`);
  return value;
}

function isoTimestamp(value, labelName) {
  const timestamp = value ?? new Date().toISOString();
  if (typeof timestamp !== 'string' || !ISO_DATE_PATTERN.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    invalid(`${labelName} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function freeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function publicProvider(provider) {
  const result = {
    id: provider.id,
    configSha256: provider.configSha256,
    model: clone(provider.model),
    availability: clone(provider.availability),
  };
  if (provider.calibration !== DECISION_UNKNOWN) result.calibration = clone(provider.calibration);
  if (provider.thresholds !== DECISION_UNKNOWN) result.thresholds = clone(provider.thresholds);
  return result;
}

function normalizeEvidenceDigest(value, labelName) {
  if (value === undefined || value === null || value === DECISION_UNKNOWN) return DECISION_UNKNOWN;
  const evidence = plainObject(value, labelName);
  exactKeys(evidence, ['evidenceSha256'], labelName);
  return { evidenceSha256: digest(evidence.evidenceSha256, `${labelName}.evidenceSha256`) };
}

function normalizeAvailability(value, aliasValue, aliasReason, labelName = 'provider.availability') {
  let status;
  let reason;
  if (value === undefined && aliasValue === undefined) {
    status = 'unknown';
  } else if (value === undefined) {
    status = aliasValue === true ? 'available' : aliasValue === false ? 'unavailable' : aliasValue === DECISION_UNKNOWN ? 'unknown' : undefined;
    if (status === undefined) invalid(`${labelName}.available must be boolean or UNKNOWN`);
    reason = aliasReason;
  } else if (typeof value === 'boolean' || value === DECISION_UNKNOWN) {
    status = value === true ? 'available' : value === false ? 'unavailable' : 'unknown';
    reason = aliasReason;
  } else if (typeof value === 'string') {
    if (!['available', 'unavailable', 'unknown'].includes(value)) invalid(`${labelName} has an invalid status`);
    status = value;
    reason = aliasReason;
  } else {
    const object = plainObject(value, labelName);
    exactKeys(object, ['status', 'available', 'reason'], labelName);
    if (object.status !== undefined) {
      if (!['available', 'unavailable', 'unknown'].includes(object.status)) invalid(`${labelName}.status is invalid`);
      status = object.status;
    }
    if (object.available !== undefined) {
      const aliasStatus = object.available === true ? 'available' : object.available === false ? 'unavailable' : object.available === DECISION_UNKNOWN ? 'unknown' : undefined;
      if (aliasStatus === undefined) invalid(`${labelName}.available must be boolean or UNKNOWN`);
      if (status !== undefined && status !== aliasStatus) invalid(`${labelName} has conflicting status and available fields`);
      status = aliasStatus;
    }
    if (status === undefined) status = 'unknown';
    reason = object.reason;
  }
  if (status === 'available' && reason !== undefined) text(reason, `${labelName}.reason`, { max: 256 });
  if (status !== 'available') {
    reason = reason === undefined ? (status === 'unavailable' ? 'provider-unavailable' : 'provider-availability-unknown') : text(reason, `${labelName}.reason`, { max: 256 });
  }
  return {
    status,
    available: status === 'available' ? true : status === 'unavailable' ? false : DECISION_UNKNOWN,
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeModel(value, modelId, modelVersion, labelName = 'provider.model') {
  let id = modelId;
  let version = modelVersion;
  if (value !== undefined) {
    const model = plainObject(value, labelName);
    exactKeys(model, ['id', 'version'], labelName);
    if (id !== undefined && model.id !== undefined && id !== model.id) invalid(`${labelName}.id conflicts with modelId`);
    if (version !== undefined && model.version !== undefined && version !== model.version) invalid(`${labelName}.version conflicts with modelVersion`);
    id = model.id ?? id;
    version = model.version ?? version;
  }
  return {
    id: id === undefined || id === null ? DECISION_UNKNOWN : text(id, `${labelName}.id`, { allowUnknown: true }),
    version: version === undefined || version === null ? DECISION_UNKNOWN : text(version, `${labelName}.version`, { allowUnknown: true }),
  };
}

function providerAllowedKeys() {
  return [
    'id', 'configSha256', 'model', 'modelId', 'modelVersion', 'availability',
    'available', 'availabilityReason', 'calibration', 'thresholds', 'decide', 'run',
  ];
}

export function validateDecisionProvider(value, { requireImplementation = false, allowUnknownConfig = false } = {}) {
  const provider = plainObject(value, 'decision provider');
  exactKeys(provider, providerAllowedKeys(), 'decision provider');
  const normalized = {
    id: provider.id === DECISION_UNKNOWN ? DECISION_UNKNOWN : identifier(provider.id, 'decision provider.id'),
    configSha256: digest(provider.configSha256, 'decision provider.configSha256', { allowUnknown: allowUnknownConfig }),
    model: normalizeModel(provider.model, provider.modelId, provider.modelVersion),
    availability: normalizeAvailability(provider.availability, provider.available, provider.availabilityReason),
    calibration: normalizeEvidenceDigest(provider.calibration, 'decision provider.calibration'),
    thresholds: normalizeEvidenceDigest(provider.thresholds, 'decision provider.thresholds'),
  };
  const implementation = provider.decide ?? provider.run;
  if (implementation !== undefined && typeof implementation !== 'function') invalid('decision provider.decide must be a function');
  if (requireImplementation && typeof implementation !== 'function') invalid('decision provider.decide is required');
  if (implementation !== undefined) normalized.decide = implementation;
  return normalized;
}

export function validateDecisionQuestion(value) {
  const question = plainObject(value, 'decision question');
  exactKeys(question, ['schemaVersion', 'id', 'type', 'choices', 'minimum', 'maximum'], 'decision question');
  if ((question.schemaVersion ?? DECISION_PROVIDER_SCHEMA_VERSION) !== DECISION_PROVIDER_SCHEMA_VERSION) {
    invalid(`decision question.schemaVersion must be ${DECISION_PROVIDER_SCHEMA_VERSION}`);
  }
  const type = question.type;
  if (!DECISION_QUESTION_TYPES.includes(type)) invalid('decision question.type is unsupported');
  const result = { schemaVersion: DECISION_PROVIDER_SCHEMA_VERSION, id: identifier(question.id, 'decision question.id'), type };
  if (type === 'choice') {
    if (!Array.isArray(question.choices) || question.choices.length === 0 || question.choices.length > 64) {
      invalid('decision question.choices must contain between 1 and 64 values');
    }
    const choices = question.choices.map((choice, index) => label(choice, `decision question.choices[${index}]`));
    for (let index = 0; index < choices.length; index += 1) {
      for (let other = index + 1; other < choices.length; other += 1) {
        if (Object.is(choices[index], choices[other])) invalid('decision question.choices must be unique');
      }
    }
    return { ...result, choices };
  }
  if (type === 'score') {
    const minimum = finiteNumber(question.minimum, 'decision question.minimum');
    const maximum = finiteNumber(question.maximum, 'decision question.maximum');
    if (maximum < minimum) invalid('decision question.maximum must be at least minimum');
    return { ...result, minimum, maximum };
  }
  if (question.choices !== undefined || question.minimum !== undefined || question.maximum !== undefined) {
    invalid('noul questions do not accept choices or score bounds');
  }
  return result;
}

export function decisionQuestionDigest(question) {
  return digestJson(validateDecisionQuestion(question));
}

function normalizeInputProjection(value) {
  const input = plainObject(value, 'decision input');
  exactKeys(input, ['decisionPoint', 'synthetic', 'source', 'observation'], 'decision input');
  if (!DECISION_POINTS.includes(input.decisionPoint)) invalid('decision input.decisionPoint is unsupported');
  if (typeof input.synthetic !== 'boolean') invalid('decision input.synthetic must be boolean');
  if (input.source === undefined) invalid('decision input.source is required');
  if (input.observation === undefined) invalid('decision input.observation is required');
  return boundedValue(input, 'decision input');
}

function inputForObservation({ caseValue, input }) {
  if (caseValue !== undefined && input !== undefined) invalid('provide caseValue or input, not both');
  if (caseValue !== undefined) {
    const projection = decisionCaseInput(caseValue);
    return { input: projection, inputSha256: decisionCaseInputDigest(caseValue) };
  }
  if (input === undefined) invalid('decision input is required');
  const projection = normalizeInputProjection(input);
  return { input: projection, inputSha256: digestJson(projection) };
}

function probabilityMap(value, labelName) {
  if (value === undefined || value === DECISION_UNKNOWN) return DECISION_UNKNOWN;
  const map = plainObject(value, labelName);
  const entries = Object.entries(map);
  if (entries.length === 0 || entries.length > 64) invalid(`${labelName} must contain between 1 and 64 entries`);
  const result = {};
  for (const [key, valueEntry] of entries) {
    if (key.length === 0 || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(`${labelName} contains an invalid label`);
    Object.defineProperty(result, key, {
      value: probability(valueEntry, `${labelName}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function measurements(value, labelName = 'measurements') {
  if (value === undefined) return {
    latencyMs: DECISION_UNKNOWN,
    inputTokens: DECISION_UNKNOWN,
    outputTokens: DECISION_UNKNOWN,
    totalTokens: DECISION_UNKNOWN,
    frontierTokensAvoided: DECISION_UNKNOWN,
  };
  const item = plainObject(value, labelName);
  exactKeys(item, ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'frontierTokensAvoided'], labelName);
  const result = {};
  for (const key of ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'frontierTokensAvoided']) {
    if (!(key in item)) invalid(`${labelName}.${key} is required; use UNKNOWN when it was not measured`);
    const entry = item[key];
    if (entry === DECISION_UNKNOWN) result[key] = entry;
    else if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || (key !== 'latencyMs' && !Number.isSafeInteger(entry))) {
      invalid(`${labelName}.${key} must be a nonnegative measured value or UNKNOWN`);
    } else result[key] = entry;
  }
  return result;
}

function sameIdentity(expected, candidate, labelName) {
  if (candidate === undefined) return;
  const object = plainObject(candidate, labelName);
  exactKeys(object, ['id', 'configSha256'], labelName);
  if (object.id !== undefined && object.id !== expected.id) invalid(`${labelName}.id does not match the supplied provider`);
  if (object.configSha256 !== undefined && object.configSha256 !== expected.configSha256) invalid(`${labelName}.configSha256 does not match the supplied provider`);
}

export function validateDecisionProviderResponse(value, { question, inputSha256, provider } = {}) {
  const normalizedQuestion = validateDecisionQuestion(question);
  const expectedInput = digest(inputSha256, 'expected inputSha256');
  const expectedProvider = validateDecisionProvider(provider, { allowUnknownConfig: true });
  const response = plainObject(value, 'decision provider response');
  exactKeys(response, [
    'type', 'value', 'choice', 'score', 'noul', 'probability', 'probabilities',
    'inputSha256', 'questionSha256', 'provider', 'providerId', 'providerConfigSha256',
    'measurements',
  ], 'decision provider response');
  if (response.type !== undefined && response.type !== normalizedQuestion.type) invalid('response.type does not match question.type');
  if (response.inputSha256 !== undefined && response.inputSha256 !== expectedInput) invalid('response.inputSha256 does not match the supplied input');
  const expectedQuestion = decisionQuestionDigest(normalizedQuestion);
  if (response.questionSha256 !== undefined && response.questionSha256 !== expectedQuestion) invalid('response.questionSha256 does not match the supplied question');
  sameIdentity(expectedProvider, response.provider, 'response.provider');
  if (response.providerId !== undefined && response.providerId !== expectedProvider.id) invalid('response.providerId does not match the supplied provider');
  if (response.providerConfigSha256 !== undefined && response.providerConfigSha256 !== expectedProvider.configSha256) invalid('response.providerConfigSha256 does not match the supplied provider');

  const typedKeys = ['choice', 'score', 'noul'];
  const answerKey = normalizedQuestion.type;
  for (const key of typedKeys) {
    if (key !== answerKey && response[key] !== undefined) invalid(`response.${key} does not apply to a ${answerKey} question`);
  }
  const answerAliases = [answerKey, 'value'].filter((key) => response[key] !== undefined);
  if (answerAliases.length === 0) invalid(`${answerKey} response requires ${answerKey} or value`);
  if (answerAliases.length === 2 && !Object.is(response[answerAliases[0]], response[answerAliases[1]])) {
    invalid(`response.${answerAliases[0]} and response.value disagree`);
  }
  let valueResult;
  if (normalizedQuestion.type === 'choice') {
    const choice = response[answerAliases[0]];
    valueResult = label(choice, 'response.choice');
    if (!normalizedQuestion.choices.some((entry) => Object.is(entry, valueResult))) invalid('response.choice is not one of the question choices');
  } else if (normalizedQuestion.type === 'score') {
    const score = response[answerAliases[0]];
    valueResult = finiteNumber(score, 'response.score');
    if (valueResult < normalizedQuestion.minimum || valueResult > normalizedQuestion.maximum) invalid('response.score is outside the question bounds');
  } else {
    const noul = response[answerAliases[0]];
    valueResult = probability(noul, 'response.noul');
  }
  const scalarProbability = response.probability === undefined
    ? DECISION_UNKNOWN
    : probability(response.probability, 'response.probability');
  const probabilities = probabilityMap(response.probabilities, 'response.probabilities');
  let retainedProbabilities = probabilities;
  if (retainedProbabilities === DECISION_UNKNOWN && scalarProbability !== DECISION_UNKNOWN) {
    retainedProbabilities = {};
    Object.defineProperty(retainedProbabilities, normalizedQuestion.type === 'score' ? 'score' : String(valueResult), {
      value: scalarProbability,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    type: normalizedQuestion.type,
    value: valueResult,
    probability: scalarProbability,
    probabilities: normalizedQuestion.type === 'noul' && retainedProbabilities === DECISION_UNKNOWN
      ? { noul: valueResult }
      : retainedProbabilities,
    measurements: measurements(response.measurements),
    inputSha256: expectedInput,
    questionSha256: expectedQuestion,
  };
}

function baseObservation({
  timestamp,
  inputSha256,
  questionSha256,
  datasetSha256 = DECISION_UNKNOWN,
  predictionsSha256 = DECISION_UNKNOWN,
  provider,
  requestedMode,
  effectiveMode,
  value = DECISION_UNKNOWN,
  responseType = DECISION_UNKNOWN,
  probabilityValues = DECISION_UNKNOWN,
  measurementValues,
  caseId = DECISION_UNKNOWN,
  decisionPoint = DECISION_UNKNOWN,
  replayQuestionSha256 = DECISION_UNKNOWN,
  reason = undefined,
  replayed = false,
}) {
  return validateDecisionObservationRecord({
    schemaVersion: DECISION_OBSERVATION_SCHEMA_VERSION,
    recordType: 'decision-provider-observation',
    replayed,
    timestamp: isoTimestamp(timestamp, 'observation.timestamp'),
    caseId,
    decisionPoint,
    inputSha256: digest(inputSha256, 'observation.inputSha256'),
    questionSha256: digest(questionSha256, 'observation.questionSha256', { allowUnknown: replayed }),
    replayQuestionSha256,
    datasetSha256: digest(datasetSha256, 'observation.datasetSha256', { allowUnknown: true }),
    predictionsSha256: digest(predictionsSha256, 'observation.predictionsSha256', { allowUnknown: true }),
    provider: publicProvider(provider),
    model: provider.model,
    requestedMode,
    effectiveMode,
    availability: provider.availability,
    value,
    responseType,
    probabilities: probabilityValues,
    calibration: provider.calibration,
    thresholds: provider.thresholds,
    band: DECISION_UNKNOWN,
    action: DECISION_OBSERVATION_ACTION,
    measurements: measurementValues ?? measurements(),
    ...(reason === undefined ? {} : { reason }),
  });
}

function offObservation({ timestamp, inputSha256, questionSha256, datasetSha256, predictionsSha256, provider, requestedMode, reason, measurementValues, caseId, decisionPoint, replayQuestionSha256, replayed = false }) {
  return baseObservation({
    timestamp,
    inputSha256,
    questionSha256,
    datasetSha256,
    predictionsSha256,
    provider,
    requestedMode,
    effectiveMode: 'off',
    measurementValues,
    caseId,
    decisionPoint,
    replayQuestionSha256,
    reason,
    replayed,
  });
}

export function validateDecisionObservationRecord(value) {
  const record = plainObject(value, 'decision observation');
  exactKeys(record, [
    'schemaVersion', 'recordType', 'replayed', 'timestamp', 'inputSha256', 'questionSha256',
    'caseId', 'decisionPoint', 'replayQuestionSha256',
    'datasetSha256', 'predictionsSha256',
    'provider', 'model', 'requestedMode', 'effectiveMode', 'availability', 'value', 'responseType',
    'probabilities', 'calibration', 'thresholds', 'band', 'action', 'measurements', 'reason',
  ], 'decision observation');
  if (record.schemaVersion !== DECISION_OBSERVATION_SCHEMA_VERSION) invalid(`decision observation.schemaVersion must be ${DECISION_OBSERVATION_SCHEMA_VERSION}`);
  if (record.recordType !== 'decision-provider-observation') invalid('decision observation.recordType is unsupported');
  if (typeof record.replayed !== 'boolean') invalid('decision observation.replayed must be boolean');
  const timestamp = isoTimestamp(record.timestamp, 'decision observation.timestamp');
  const caseId = record.caseId === undefined || record.caseId === DECISION_UNKNOWN
    ? DECISION_UNKNOWN
    : identifier(record.caseId, 'decision observation.caseId');
  const decisionPoint = record.decisionPoint === undefined || record.decisionPoint === DECISION_UNKNOWN
    ? DECISION_UNKNOWN
    : DECISION_POINTS.includes(record.decisionPoint)
      ? record.decisionPoint
      : invalid('decision observation.decisionPoint is unsupported');
  const inputSha256 = digest(record.inputSha256, 'decision observation.inputSha256');
  const questionSha256 = digest(record.questionSha256, 'decision observation.questionSha256', { allowUnknown: record.replayed });
  const replayQuestionSha256 = digest(record.replayQuestionSha256 ?? DECISION_UNKNOWN, 'decision observation.replayQuestionSha256', { allowUnknown: true });
  if (record.replayed && (caseId === DECISION_UNKNOWN || decisionPoint === DECISION_UNKNOWN)) invalid('replayed observations require case identity');
  if (!record.replayed && (questionSha256 === DECISION_UNKNOWN || replayQuestionSha256 !== DECISION_UNKNOWN)) invalid('direct observations require original question identity only');
  if (record.replayed && questionSha256 !== DECISION_UNKNOWN) invalid('replayed observations cannot claim original question identity');
  const datasetSha256 = digest(record.datasetSha256, 'decision observation.datasetSha256', { allowUnknown: true });
  const predictionsSha256 = digest(record.predictionsSha256, 'decision observation.predictionsSha256', { allowUnknown: true });
  if (record.replayed && (datasetSha256 === DECISION_UNKNOWN || predictionsSha256 === DECISION_UNKNOWN)) invalid('replayed observations require dataset and predictions digests');
  const provider = validateDecisionProvider(record.provider, { allowUnknownConfig: true });
  const model = normalizeModel(record.model, undefined, undefined, 'decision observation.model');
  if (stableStringify(model) !== stableStringify(provider.model)) invalid('decision observation.model does not match provider.model');
  if (!DECISION_PROVIDER_MODES.includes(record.requestedMode) || !DECISION_PROVIDER_MODES.includes(record.effectiveMode)) invalid('decision observation mode is unsupported');
  const availability = normalizeAvailability(record.availability, undefined, undefined, 'decision observation.availability');
  if (stableStringify(availability) !== stableStringify(provider.availability)) invalid('decision observation.availability does not match provider.availability');
  const normalizedValue = boundedValue(record.value, 'decision observation.value');
  const responseType = record.responseType === DECISION_UNKNOWN ? record.responseType : text(record.responseType, 'decision observation.responseType', { max: 32 });
  const probabilities = probabilityMap(record.probabilities, 'decision observation.probabilities');
  const calibration = normalizeEvidenceDigest(record.calibration, 'decision observation.calibration');
  const thresholds = normalizeEvidenceDigest(record.thresholds, 'decision observation.thresholds');
  if (record.band !== DECISION_UNKNOWN) invalid('decision observation.band must remain UNKNOWN in this foundation');
  if (record.action !== DECISION_OBSERVATION_ACTION) invalid('decision observation.action must remain no-enforcement');
  const observedMeasurements = measurements(record.measurements, 'decision observation.measurements');
  if (record.reason !== undefined && !OFF_REASONS.has(record.reason)) invalid('decision observation.reason is unsupported');
  if (record.effectiveMode === 'off' && record.reason === undefined) invalid('off observations require a bounded reason');
  if (record.replayed !== true && record.recordType === 'decision-provider-observation' && record.requestedMode === 'shadow' && record.effectiveMode === 'shadow' && record.reason !== undefined) invalid('successful shadow observations must not carry an off reason');
  return {
    schemaVersion: DECISION_OBSERVATION_SCHEMA_VERSION,
    recordType: 'decision-provider-observation',
    replayed: record.replayed,
    timestamp,
    caseId,
    decisionPoint,
    inputSha256,
    questionSha256,
    replayQuestionSha256,
    datasetSha256,
    predictionsSha256,
    provider: publicProvider(provider),
    model,
    requestedMode: record.requestedMode,
    effectiveMode: record.effectiveMode,
    availability,
    value: normalizedValue,
    responseType,
    probabilities,
    calibration,
    thresholds,
    band: DECISION_UNKNOWN,
    action: DECISION_OBSERVATION_ACTION,
    measurements: observedMeasurements,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

export function validateDecisionObservationBatch(value) {
  if (!Array.isArray(value) || value.length === 0) invalid('decision observation batch must contain records');
  if (value.length > DECISION_MAX_OBSERVATIONS) invalid(`decision observation batch exceeds ${DECISION_MAX_OBSERVATIONS} records`);
  return value.map((record, index) => {
    try {
      return validateDecisionObservationRecord(record);
    } catch (error) {
      if (error?.code === 'DECISION_PROVIDER_INVALID') throw tinyError('DECISION_PROVIDER_INVALID', `invalid observation at index ${index}: ${error.message}`);
      throw error;
    }
  });
}

export async function observeDecision({
  caseValue,
  input,
  question,
  provider,
  mode = 'shadow',
  timestamp = undefined,
} = {}) {
  if (!DECISION_PROVIDER_MODES.includes(mode)) invalid('mode must be off, shadow, or enforce');
  if (mode === 'enforce') unsupported('enforce is not available in the offline shadow foundation');
  const normalizedQuestion = validateDecisionQuestion(question);
  const inputValues = inputForObservation({ caseValue, input });
  const questionSha256 = decisionQuestionDigest(normalizedQuestion);
  const normalizedProvider = provider === undefined
    ? {
      id: DECISION_UNKNOWN,
      configSha256: DECISION_UNKNOWN,
      model: { id: DECISION_UNKNOWN, version: DECISION_UNKNOWN },
      availability: { status: 'unknown', available: DECISION_UNKNOWN, reason: 'provider-missing' },
      calibration: DECISION_UNKNOWN,
      thresholds: DECISION_UNKNOWN,
    }
    : validateDecisionProvider(provider);
  if (mode === 'off') {
    return offObservation({ timestamp, inputSha256: inputValues.inputSha256, questionSha256, provider: normalizedProvider, requestedMode: mode, reason: 'mode-off' });
  }
  if (normalizedProvider.availability.status === 'unavailable') {
    return offObservation({ timestamp, inputSha256: inputValues.inputSha256, questionSha256, provider: normalizedProvider, requestedMode: mode, reason: 'provider-unavailable' });
  }
  if (normalizedProvider.availability.status === 'unknown') {
    return offObservation({
      timestamp,
      inputSha256: inputValues.inputSha256,
      questionSha256,
      provider: normalizedProvider,
      requestedMode: mode,
      reason: normalizedProvider.availability.reason === 'provider-missing' ? 'provider-missing' : 'provider-availability-unknown',
    });
  }
  if (typeof normalizedProvider.decide !== 'function') {
    return offObservation({ timestamp, inputSha256: inputValues.inputSha256, questionSha256, provider: normalizedProvider, requestedMode: mode, reason: 'provider-missing' });
  }
  const callbackProvider = freeze(clone(publicProvider(normalizedProvider)));
  let response;
  try {
    response = await normalizedProvider.decide({
      state: freeze(clone(inputValues.input)),
      question: freeze(clone(normalizedQuestion)),
      inputSha256: inputValues.inputSha256,
      provider: callbackProvider,
    });
  } catch {
    return offObservation({ timestamp, inputSha256: inputValues.inputSha256, questionSha256, provider: normalizedProvider, requestedMode: mode, reason: 'provider-error' });
  }
  let normalizedResponse;
  try {
    normalizedResponse = validateDecisionProviderResponse(response, {
      question: normalizedQuestion,
      inputSha256: inputValues.inputSha256,
      provider: normalizedProvider,
    });
  } catch {
    return offObservation({ timestamp, inputSha256: inputValues.inputSha256, questionSha256, provider: normalizedProvider, requestedMode: mode, reason: 'invalid-response' });
  }
  return baseObservation({
    timestamp,
    inputSha256: normalizedResponse.inputSha256,
    questionSha256: normalizedResponse.questionSha256,
    provider: normalizedProvider,
    requestedMode: mode,
    effectiveMode: 'shadow',
    value: normalizedResponse.value,
    responseType: normalizedResponse.type,
    probabilityValues: normalizedResponse.probabilities,
    measurementValues: normalizedResponse.measurements,
  });
}

export const observeDecisionCase = observeDecision;
export const runDecisionProvider = observeDecision;

export function validateDecisionQuestions(value) {
  const questions = plainObject(value, 'decision questions');
  exactKeys(questions, ['schemaVersion', 'questions'], 'decision questions');
  if ((questions.schemaVersion ?? DECISION_QUESTIONS_SCHEMA_VERSION) !== DECISION_QUESTIONS_SCHEMA_VERSION) invalid(`decision questions.schemaVersion must be ${DECISION_QUESTIONS_SCHEMA_VERSION}`);
  const entries = plainObject(questions.questions, 'decision questions.questions');
  const result = {};
  for (const [decisionPoint, question] of Object.entries(entries)) {
    if (!DECISION_POINTS.includes(decisionPoint)) invalid(`decision questions contains unsupported point: ${decisionPoint}`);
    result[decisionPoint] = validateDecisionQuestion(question);
  }
  return { schemaVersion: DECISION_QUESTIONS_SCHEMA_VERSION, questions: result };
}

export function parseDecisionQuestions(textValue) {
  if (typeof textValue !== 'string') invalid('decision questions must be JSON text');
  if (Buffer.byteLength(textValue) > DECISION_PROVIDER_INPUT_MAX_BYTES) invalid(`decision questions exceeds ${DECISION_PROVIDER_INPUT_MAX_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    invalid(`decision questions is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDecisionQuestions(value);
}

export function validateSavedProviderMetadata(value) {
  const metadata = plainObject(value, 'saved provider metadata');
  exactKeys(metadata, ['schemaVersion', 'providers'], 'saved provider metadata');
  if ((metadata.schemaVersion ?? DECISION_PROVIDER_SCHEMA_VERSION) !== DECISION_PROVIDER_SCHEMA_VERSION) invalid(`saved provider metadata.schemaVersion must be ${DECISION_PROVIDER_SCHEMA_VERSION}`);
  if (!Array.isArray(metadata.providers) || metadata.providers.length === 0 || metadata.providers.length > 256) invalid('saved provider metadata.providers must contain between 1 and 256 providers');
  const result = [];
  const seen = new Set();
  for (const item of metadata.providers) {
    const provider = validateDecisionProvider(item, { allowUnknownConfig: false });
    if (seen.has(provider.id)) invalid(`saved provider metadata contains duplicate provider: ${provider.id}`);
    seen.add(provider.id);
    result.push(provider);
  }
  return { schemaVersion: DECISION_PROVIDER_SCHEMA_VERSION, providers: result };
}

export function parseSavedProviderMetadata(textValue) {
  if (typeof textValue !== 'string') invalid('saved provider metadata must be JSON text');
  if (Buffer.byteLength(textValue) > DECISION_PROVIDER_INPUT_MAX_BYTES) invalid(`saved provider metadata exceeds ${DECISION_PROVIDER_INPUT_MAX_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    invalid(`saved provider metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateSavedProviderMetadata(value);
}

function replayQuestionDigest(question, prediction, decisionPoint) {
  if (question === undefined) return DECISION_UNKNOWN;
  if (prediction !== undefined && prediction.predictedLabel !== DECISION_UNKNOWN) {
    if (question.type !== 'choice') invalid(`replay question for ${decisionPoint} cannot describe a saved categorical label as ${question.type}`);
    if (!question.choices.some((choice) => Object.is(choice, prediction.predictedLabel))) {
      invalid(`replay question for ${decisionPoint} does not contain the saved predicted label`);
    }
  }
  return decisionQuestionDigest(question);
}

function providerFromPrediction(identity) {
  return validateDecisionProvider({
    ...identity,
    model: { id: DECISION_UNKNOWN, version: DECISION_UNKNOWN },
    available: true,
    availabilityReason: 'saved-prediction-present',
  });
}

function unknownMeasurementValues() {
  return measurements();
}

function replayRecord({ timestamp, caseValue, provider, prediction, mode, datasetSha256, predictionsSha256, replayQuestionSha256 }) {
  const inputSha256 = decisionCaseInputDigest(caseValue);
  const questionSha256 = DECISION_UNKNOWN;
  if (prediction === undefined) {
    return offObservation({
      timestamp,
      inputSha256,
      questionSha256,
      datasetSha256,
      predictionsSha256,
      caseId: caseValue.id,
      decisionPoint: caseValue.decisionPoint,
      replayQuestionSha256,
      provider,
      requestedMode: mode,
      reason: 'missing-saved-prediction',
      measurementValues: unknownMeasurementValues(),
      replayed: true,
    });
  }
  const measurementsValue = measurements(prediction.measurements);
  if (provider.availability.status !== 'available') {
    return offObservation({
      timestamp,
      inputSha256,
      questionSha256,
      datasetSha256,
      predictionsSha256,
      caseId: caseValue.id,
      decisionPoint: caseValue.decisionPoint,
      replayQuestionSha256,
      provider,
      requestedMode: mode,
      reason: provider.availability.status === 'unavailable' ? 'provider-unavailable' : 'provider-availability-unknown',
      measurementValues: measurementsValue,
      replayed: true,
    });
  }
  if (mode === 'off') {
    return offObservation({ timestamp, inputSha256, questionSha256, datasetSha256, predictionsSha256, caseId: caseValue.id, decisionPoint: caseValue.decisionPoint, replayQuestionSha256, provider, requestedMode: mode, reason: 'mode-off', measurementValues: measurementsValue, replayed: true });
  }
  const record = baseObservation({
    timestamp,
    inputSha256,
    questionSha256,
    datasetSha256,
    predictionsSha256,
    caseId: caseValue.id,
    decisionPoint: caseValue.decisionPoint,
    replayQuestionSha256,
    provider,
    requestedMode: mode,
    effectiveMode: 'shadow',
    value: prediction.predictedLabel,
    responseType: 'saved-prediction',
    probabilityValues: prediction.probabilities,
    measurementValues: measurementsValue,
    replayed: true,
  });
  return record;
}

export function replaySavedPredictions({
  dataset,
  predictions,
  providerMetadata = undefined,
  questions = undefined,
  replayQuestions = undefined,
  mode = 'shadow',
  timestamp = undefined,
  minimumProviders = 1,
} = {}) {
  if (!DECISION_PROVIDER_MODES.includes(mode)) invalid('mode must be off, shadow, or enforce');
  if (mode === 'enforce') unsupported('enforce is not available in the offline shadow foundation');
  const normalizedDataset = validateDecisionDataset(dataset);
  const normalizedPredictions = validateDecisionPredictions(predictions);
  evaluateDecisions({ dataset: normalizedDataset, predictions: normalizedPredictions });
  const normalizedMetadata = providerMetadata === undefined ? undefined : validateSavedProviderMetadata(providerMetadata);
  if (questions !== undefined && replayQuestions !== undefined) invalid('provide questions or replayQuestions, not both');
  const normalizedQuestions = (replayQuestions ?? questions) === undefined
    ? undefined
    : validateDecisionQuestions(replayQuestions ?? questions);
  if (!Number.isSafeInteger(minimumProviders) || minimumProviders < 1 || minimumProviders > 256) invalid('minimumProviders must be a positive safe integer');
  const providerIdentities = new Map();
  for (const prediction of normalizedPredictions.predictions) {
    if (!providerIdentities.has(prediction.provider.id)) providerIdentities.set(prediction.provider.id, providerFromPrediction(prediction.provider));
  }
  for (const provider of normalizedMetadata?.providers ?? []) {
    const existing = providerIdentities.get(provider.id);
    if (existing !== undefined && existing.configSha256 !== provider.configSha256) invalid(`provider ${provider.id} metadata config digest does not match predictions`);
    providerIdentities.set(provider.id, provider);
  }
  if (providerIdentities.size < minimumProviders) invalid(`at least ${minimumProviders} provider identities are required`);
  const providers = [...providerIdentities.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (providers.length * normalizedDataset.cases.length > DECISION_MAX_OBSERVATIONS) {
    invalid(`replay would create more than ${DECISION_MAX_OBSERVATIONS} observations`);
  }
  const predictionByKey = new Map(normalizedPredictions.predictions.map((prediction) => [`${prediction.provider.id}\0${prediction.caseId}`, prediction]));
  const datasetSha256 = decisionDatasetDigest(normalizedDataset);
  const predictionsSha256 = predictionsDigest(normalizedPredictions);
  const replayTimestamp = isoTimestamp(timestamp, 'replay timestamp');
  const records = [];
  for (const provider of providers) {
    for (const item of normalizedDataset.cases) {
      const prediction = predictionByKey.get(`${provider.id}\0${item.id}`);
      const replayQuestionSha256 = replayQuestionDigest(normalizedQuestions?.questions[item.decisionPoint], prediction, item.decisionPoint);
      records.push(replayRecord({
        timestamp: replayTimestamp,
        caseValue: item,
        provider,
        prediction,
        mode,
        datasetSha256,
        predictionsSha256,
        replayQuestionSha256,
      }));
    }
  }
  const validatedRecords = validateDecisionObservationBatch(records);
  const missingCount = validatedRecords.filter((record) => record.reason === 'missing-saved-prediction').length;
  return {
    schemaVersion: DECISION_OBSERVATION_SCHEMA_VERSION,
    type: 'decision-provider-replay',
    replayed: true,
    requestedMode: mode,
    dataset: {
      id: normalizedDataset.id,
      version: normalizedDataset.version,
      sha256: datasetSha256,
    },
    predictionsSha256,
    providers: providers.map(publicProvider),
    cases: normalizedDataset.cases.length,
    records: validatedRecords,
    warnings: [
      ...(missingCount === 0 ? [] : [`${missingCount} saved provider predictions were missing; those observations are effective off`]),
      ...providers.filter((provider) => provider.model.id === DECISION_UNKNOWN || provider.model.version === DECISION_UNKNOWN).map((provider) => `provider ${provider.id} model metadata is UNKNOWN`),
      ...providers.filter((provider) => provider.calibration === DECISION_UNKNOWN).map((provider) => `provider ${provider.id} calibration evidence is UNKNOWN`),
      ...providers.filter((provider) => provider.thresholds === DECISION_UNKNOWN).map((provider) => `provider ${provider.id} threshold evidence is UNKNOWN`),
    ],
  };
}

export function validateDecisionReplayReport(value) {
  const report = plainObject(value, 'decision provider replay report');
  exactKeys(report, [
    'schemaVersion', 'type', 'replayed', 'requestedMode', 'dataset', 'predictionsSha256',
    'providers', 'cases', 'records', 'warnings',
  ], 'decision provider replay report');
  if (report.schemaVersion !== DECISION_OBSERVATION_SCHEMA_VERSION || report.type !== 'decision-provider-replay' || report.replayed !== true) invalid('decision provider replay report identity is invalid');
  if (!DECISION_PROVIDER_MODES.includes(report.requestedMode)) invalid('decision provider replay report mode is invalid');
  const dataset = plainObject(report.dataset, 'decision provider replay report.dataset');
  exactKeys(dataset, ['id', 'version', 'sha256'], 'decision provider replay report.dataset');
  text(dataset.id, 'decision provider replay report.dataset.id', { max: 128 });
  text(dataset.version, 'decision provider replay report.dataset.version', { max: 64 });
  digest(dataset.sha256, 'decision provider replay report.dataset.sha256');
  digest(report.predictionsSha256, 'decision provider replay report.predictionsSha256');
  if (!Array.isArray(report.providers) || report.providers.length === 0) invalid('decision provider replay report.providers must not be empty');
  const providers = report.providers.map((provider) => validateDecisionProvider(provider, { allowUnknownConfig: true }));
  if (!Number.isSafeInteger(report.cases) || report.cases < 1) invalid('decision provider replay report.cases must be positive');
  const records = validateDecisionObservationBatch(report.records);
  if (!Array.isArray(report.warnings) || report.warnings.some((warning) => typeof warning !== 'string' || warning.length > 512)) invalid('decision provider replay report.warnings must be bounded strings');
  return {
    schemaVersion: DECISION_OBSERVATION_SCHEMA_VERSION,
    type: 'decision-provider-replay',
    replayed: true,
    requestedMode: report.requestedMode,
    dataset: { id: dataset.id, version: dataset.version, sha256: dataset.sha256 },
    predictionsSha256: report.predictionsSha256,
    providers: providers.map(publicProvider),
    cases: report.cases,
    records,
    warnings: [...report.warnings],
  };
}

export function observationRecordDigest(record) {
  return sha256(stableStringify(validateDecisionObservationRecord(record)));
}

export async function assertDecisionLogPath(projectRoot, taskId) {
  if (typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/u.test(taskId)) invalid('taskId must be a bounded lowercase identifier');
  const directory = await assertInternalPath(projectRoot, ['.tinysdd', 'runs', 'decisions'], { allowMissing: true, requireDirectory: false });
  const file = await assertInternalPath(projectRoot, ['.tinysdd', 'runs', 'decisions', `${taskId}.jsonl`], { allowMissing: true, requireDirectory: false });
  return { directory, file };
}
