import { lstat, readFile } from 'node:fs/promises';

import {
  canonicalProjectRoot,
  digestJson,
  normalizeProjectRelative,
  readProjectFile,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import { parseBenchmarkCaseResult, parseBenchmarkInvocation } from './benchmark-results.mjs';

export const DECISION_DATASET_SCHEMA_VERSION = 1;
export const DECISION_PREDICTIONS_SCHEMA_VERSION = 1;
export const DECISION_UNKNOWN = 'UNKNOWN';
export const DECISION_DATASET_MAX_BYTES = 512 * 1024;
export const DECISION_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const DECISION_MAX_CASES = 4096;
export const DECISION_MAX_PREDICTIONS = 16384;

export const DECISION_POINTS = Object.freeze([
  'failure-triage',
  'research-relevance',
  'review-triage',
  'spec-coverage',
  'slice-routing',
  'slice-test-review',
]);

export const FAILURE_TRIAGE_LABELS = Object.freeze([
  'environment',
  'missing-context',
  'fixable-from-log',
  'unknown',
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const PARTITIONS = new Set(['train', 'validation', 'test']);
const BENCHMARK_SOURCE_KINDS = new Set(['benchmark-case-result', 'benchmark-invocation']);
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 4096;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_LENGTH = 128 * 1024;
function evidencePathOptions(path) {
  const reviewPrefix = ['records', 'inputs'].map((name) => `.tinysdd/runs/slice-test-review/${name}/`).find((prefix) => typeof path === 'string' && path.startsWith(prefix));
  return { tinysddArtifactPrefix: reviewPrefix ?? '.tinysdd/bench/' };
}

function invalid(message, details = undefined) {
  throw tinyError('DECISION_DATASET_INVALID', message, details);
}

function predictionsInvalid(message, details = undefined) {
  throw tinyError('DECISION_PREDICTIONS_INVALID', message, details);
}

function evidenceInvalid(message, details = undefined) {
  throw tinyError('DECISION_EVIDENCE_INVALID', message, details);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label, fail = invalid) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown key: ${key}`);
  }
}

function nonemptyString(value, label, { pattern = undefined, max = 256 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${label} must be a bounded nonempty string`);
  if (pattern && !pattern.test(value)) invalid(`${label} has an invalid format`);
  return value;
}

function identifier(value, label) {
  return nonemptyString(value, label, { pattern: ID_PATTERN, max: 128 });
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function predictionDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) predictionsInvalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
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

function evidenceRef(value, label, fail = invalid) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  exactKeys(value, ['path', 'sha256'], label, fail);
  let normalizedPath;
  try {
    normalizedPath = normalizeProjectRelative(value.path, `${label}.path`, evidencePathOptions(value.path));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const hash = typeof value.sha256 === 'string' && SHA256_PATTERN.test(value.sha256)
    ? value.sha256
    : fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  return { path: normalizedPath, sha256: hash };
}

function evidenceRefs(value, label, { optional = false, fail = invalid } = {}) {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > 64) fail(`${label} contains too many references`);
  const seen = new Set();
  return value.map((entry, index) => {
    const ref = evidenceRef(entry, `${label}[${index}]`, fail);
    if (seen.has(ref.path)) fail(`${label} contains duplicate path: ${ref.path}`);
    seen.add(ref.path);
    return ref;
  });
}

function reviewedAt(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function labelValue(value, label, fail = invalid) {
  if (value === DECISION_UNKNOWN) fail(`${label} must be a reviewed label, not UNKNOWN`);
  if (typeof value !== 'string' && typeof value !== 'boolean') fail(`${label} must be a string or boolean`);
  if (typeof value === 'string' && (value.length === 0 || value.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(value))) {
    fail(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function validateExpected(value, label, decisionPoint) {
  const expected = plainObject(value, label);
  exactKeys(expected, ['label', 'reviewedBy', 'reviewedAt', 'evidence', 'note'], label);
  const labelValueResult = labelValue(expected.label, `${label}.label`);
  if (decisionPoint === 'failure-triage' && (typeof labelValueResult !== 'string' || !FAILURE_TRIAGE_LABELS.includes(labelValueResult))) {
    invalid(`${label}.label is not a failure-triage taxonomy value`);
  }
  return {
    label: labelValueResult,
    reviewedBy: nonemptyString(expected.reviewedBy, `${label}.reviewedBy`, { max: 256 }),
    reviewedAt: reviewedAt(expected.reviewedAt, `${label}.reviewedAt`),
    evidence: evidenceRefs(expected.evidence, `${label}.evidence`, { optional: true }),
    ...(expected.note === undefined ? {} : { note: nonemptyString(expected.note, `${label}.note`, { max: 4096 }) }),
  };
}

function validateSource(value, label) {
  const source = plainObject(value, label);
  exactKeys(source, ['kind', 'refs'], label);
  const kind = nonemptyString(source.kind, `${label}.kind`, { pattern: SLUG_PATTERN, max: 64 });
  const refs = evidenceRefs(source.refs, `${label}.refs`);
  if (refs.length === 0) invalid(`${label}.refs must contain at least one source file`);
  return { kind, refs };
}

function validateSplit(value, label) {
  const split = plainObject(value, label);
  exactKeys(split, ['partition', 'sourceGroup', 'featureGroup', 'runLineageGroup'], label);
  const partition = nonemptyString(split.partition, `${label}.partition`, { max: 16 });
  if (!PARTITIONS.has(partition)) invalid(`${label}.partition must be train, validation, or test`);
  return {
    partition,
    sourceGroup: identifier(split.sourceGroup, `${label}.sourceGroup`),
    featureGroup: identifier(split.featureGroup, `${label}.featureGroup`),
    runLineageGroup: identifier(split.runLineageGroup, `${label}.runLineageGroup`),
  };
}

function validateCase(value, index) {
  const label = `decision dataset.cases[${index}]`;
  const item = plainObject(value, label);
  exactKeys(item, ['id', 'decisionPoint', 'synthetic', 'source', 'observation', 'expected', 'split'], label);
  const id = identifier(item.id, `${label}.id`);
  const decisionPoint = nonemptyString(item.decisionPoint, `${label}.decisionPoint`, { max: 64 });
  if (!DECISION_POINTS.includes(decisionPoint)) invalid(`${label}.decisionPoint is unsupported`);
  if (typeof item.synthetic !== 'boolean') invalid(`${label}.synthetic must be a boolean`);
  if (item.source?.kind === 'synthetic' && item.synthetic !== true) invalid(`${label}.synthetic must be true for synthetic sources`);
  return {
    id,
    decisionPoint,
    synthetic: item.synthetic,
    source: validateSource(item.source, `${label}.source`),
    observation: boundedValue(item.observation, `${label}.observation`),
    expected: validateExpected(item.expected, `${label}.expected`, decisionPoint),
    split: validateSplit(item.split, `${label}.split`),
  };
}

function checkSplitLeakage(cases) {
  const dimensions = ['sourceGroup', 'featureGroup', 'runLineageGroup'];
  for (const dimension of dimensions) {
    const partitions = new Map();
    for (const item of cases) {
      const group = item.split[dimension];
      const previous = partitions.get(group);
      if (previous !== undefined && previous !== item.split.partition) {
        invalid(`split group ${dimension}=${group} crosses ${previous} and ${item.split.partition}`);
      }
      partitions.set(group, item.split.partition);
    }
  }
}

export function validateDecisionDataset(value) {
  const dataset = plainObject(value, 'decision dataset');
  exactKeys(dataset, ['schemaVersion', 'id', 'version', 'cases'], 'decision dataset');
  if (dataset.schemaVersion !== DECISION_DATASET_SCHEMA_VERSION) invalid(`decision dataset.schemaVersion must be ${DECISION_DATASET_SCHEMA_VERSION}`);
  const id = identifier(dataset.id, 'decision dataset.id');
  const version = nonemptyString(dataset.version, 'decision dataset.version', { max: 64 });
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0 || dataset.cases.length > DECISION_MAX_CASES) {
    invalid(`decision dataset.cases must contain between 1 and ${DECISION_MAX_CASES} cases`);
  }
  const ids = new Set();
  const cases = dataset.cases.map((item, index) => {
    const normalized = validateCase(item, index);
    if (ids.has(normalized.id)) invalid(`decision dataset contains duplicate case id: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  checkSplitLeakage(cases);
  return { schemaVersion: DECISION_DATASET_SCHEMA_VERSION, id, version, cases };
}

export function parseDecisionDataset(text) {
  if (typeof text !== 'string') invalid('decision dataset must be JSON text');
  if (Buffer.byteLength(text) > DECISION_DATASET_MAX_BYTES) invalid(`decision dataset exceeds ${DECISION_DATASET_MAX_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`decision dataset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDecisionDataset(value);
}

export function decisionDatasetDigest(value) {
  return digestJson(validateDecisionDataset(value));
}

export function decisionCaseInput(caseValue) {
  const normalized = validateCase(caseValue, 0);
  return {
    decisionPoint: normalized.decisionPoint,
    synthetic: normalized.synthetic,
    source: normalized.source,
    observation: normalized.observation,
  };
}

export function decisionCaseInputDigest(caseValue) {
  return digestJson(decisionCaseInput(caseValue));
}

export const caseInputDigest = decisionCaseInputDigest;

async function verifyReference(projectRoot, ref, label, verified) {
  let resolved;
  try {
    resolved = await resolveProjectPath(projectRoot, ref.path, {
      field: `${label}.path`,
      allowMissing: false,
      ...evidencePathOptions(ref.path),
    });
    const info = await lstat(resolved.absolutePath);
    if (!info.isFile()) evidenceInvalid(`${label} is not a regular file`);
    if (info.size > DECISION_EVIDENCE_MAX_BYTES) evidenceInvalid(`${label} exceeds ${DECISION_EVIDENCE_MAX_BYTES} bytes`);
    const content = await readFile(resolved.absolutePath);
    const actual = sha256(content);
    if (actual !== ref.sha256) evidenceInvalid(`${label} sha256 does not match`, { path: ref.path, expected: ref.sha256, actual });
    verified.push({ path: ref.path, sha256: actual, bytes: content.byteLength });
    return content;
  } catch (error) {
    if (error?.code === 'DECISION_EVIDENCE_INVALID') throw error;
    throw error;
  }
}

export async function validateDecisionDatasetEvidence(projectRoot, value) {
  const root = await canonicalProjectRoot(projectRoot);
  const dataset = validateDecisionDataset(value);
  const verified = [];
  for (const item of dataset.cases) {
    for (const [index, ref] of item.source.refs.entries()) {
      const content = await verifyReference(root, ref, `case ${item.id} source ${ref.path}`, verified);
      if (index === 0 && BENCHMARK_SOURCE_KINDS.has(item.source.kind)) {
        try {
          if (item.source.kind === 'benchmark-case-result') parseBenchmarkCaseResult(content.toString('utf8'));
          else parseBenchmarkInvocation(content.toString('utf8'));
        } catch (error) {
          evidenceInvalid(`case ${item.id} source ${ref.path} is not a valid ${item.source.kind}`, {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    for (const ref of item.expected.evidence) await verifyReference(root, ref, `case ${item.id} label evidence ${ref.path}`, verified);
  }
  return { dataset, verified };
}

export async function loadDecisionDataset(projectRoot, projectRelativePath) {
  const root = await canonicalProjectRoot(projectRoot);
  const text = await readProjectFile(root, projectRelativePath, { field: 'dataset path' });
  return parseDecisionDataset(text);
}

function predictionPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) predictionsInvalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) predictionsInvalid(`${label} must be a plain object`);
  return value;
}

function predictionExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) predictionsInvalid(`${label} contains unknown key: ${key}`);
  }
}

function predictionString(value, label, { max = 256 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) predictionsInvalid(`${label} must be a bounded nonempty string`);
  return value;
}

function predictionLabel(value, label) {
  if (value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'string' && typeof value !== 'boolean') predictionsInvalid(`${label} must be a string, boolean, or UNKNOWN`);
  if (typeof value === 'string' && (value.length === 0 || value.length > 128)) predictionsInvalid(`${label} must be a bounded nonempty string`);
  return value;
}

function probabilityMap(value, label) {
  if (value === DECISION_UNKNOWN) return value;
  const probabilities = predictionPlainObject(value, label);
  const entries = Object.entries(probabilities);
  if (entries.length === 0 || entries.length > 64) predictionsInvalid(`${label} must contain between 1 and 64 labels`);
  const result = {};
  for (const [key, probability] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length === 0 || key.length > 128) predictionsInvalid(`${label} contains an invalid label`);
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) predictionsInvalid(`${label}.${key} must be a probability from 0 to 1`);
    Object.defineProperty(result, key, { value: probability, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function measurement(value, label, { integer = false } = {}) {
  if (value === DECISION_UNKNOWN) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    predictionsInvalid(`${label} must be a nonnegative ${integer ? 'safe integer' : 'finite number'} or UNKNOWN`);
  }
  return value;
}

function validateMeasurements(value, label) {
  const measurements = predictionPlainObject(value, label);
  predictionExactKeys(measurements, ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'frontierTokensAvoided'], label);
  for (const key of ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'frontierTokensAvoided']) {
    if (!(key in measurements)) predictionsInvalid(`${label}.${key} is required; use UNKNOWN when it was not measured`);
  }
  return {
    latencyMs: measurement(measurements.latencyMs, `${label}.latencyMs`),
    inputTokens: measurement(measurements.inputTokens, `${label}.inputTokens`, { integer: true }),
    outputTokens: measurement(measurements.outputTokens, `${label}.outputTokens`, { integer: true }),
    totalTokens: measurement(measurements.totalTokens, `${label}.totalTokens`, { integer: true }),
    frontierTokensAvoided: measurement(measurements.frontierTokensAvoided, `${label}.frontierTokensAvoided`, { integer: true }),
  };
}

function validateProvider(value, label) {
  const provider = predictionPlainObject(value, label);
  predictionExactKeys(provider, ['id', 'configSha256'], label);
  return {
    id: predictionString(provider.id, `${label}.id`),
    configSha256: predictionDigest(provider.configSha256, `${label}.configSha256`),
  };
}

function validatePrediction(value, index) {
  const label = `decision predictions.predictions[${index}]`;
  const prediction = predictionPlainObject(value, label);
  predictionExactKeys(prediction, ['provider', 'caseId', 'inputSha256', 'caseInputSha256', 'predictedLabel', 'probabilities', 'measurements'], label);
  const hasInput = prediction.inputSha256 !== undefined;
  const hasCaseInput = prediction.caseInputSha256 !== undefined;
  if (hasInput === hasCaseInput) predictionsInvalid(`${label} must contain exactly one of inputSha256 or caseInputSha256`);
  const inputSha256 = predictionDigest(hasInput ? prediction.inputSha256 : prediction.caseInputSha256, `${label}.inputSha256`);
  return {
    provider: validateProvider(prediction.provider, `${label}.provider`),
    caseId: predictionString(prediction.caseId, `${label}.caseId`, { max: 128 }),
    inputSha256,
    predictedLabel: predictionLabel(prediction.predictedLabel, `${label}.predictedLabel`),
    probabilities: probabilityMap(prediction.probabilities, `${label}.probabilities`),
    measurements: validateMeasurements(prediction.measurements, `${label}.measurements`),
  };
}

export function validateDecisionPredictions(value) {
  const predictions = predictionPlainObject(value, 'decision predictions');
  predictionExactKeys(predictions, ['schemaVersion', 'datasetSha256', 'predictions'], 'decision predictions');
  if (predictions.schemaVersion !== DECISION_PREDICTIONS_SCHEMA_VERSION) predictionsInvalid(`decision predictions.schemaVersion must be ${DECISION_PREDICTIONS_SCHEMA_VERSION}`);
  const datasetSha256 = predictionDigest(predictions.datasetSha256, 'decision predictions.datasetSha256');
  if (!Array.isArray(predictions.predictions) || predictions.predictions.length > DECISION_MAX_PREDICTIONS) predictionsInvalid(`decision predictions.predictions must contain at most ${DECISION_MAX_PREDICTIONS} entries`);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < predictions.predictions.length; index += 1) {
    const prediction = validatePrediction(predictions.predictions[index], index);
    const key = `${prediction.provider.id}\0${prediction.caseId}`;
    if (seen.has(key)) predictionsInvalid(`decision predictions contains duplicate provider/case pair: ${prediction.provider.id}/${prediction.caseId}`);
    seen.add(key);
    result.push(prediction);
  }
  return { schemaVersion: DECISION_PREDICTIONS_SCHEMA_VERSION, datasetSha256, predictions: result };
}

export function parseDecisionPredictions(text) {
  if (typeof text !== 'string') predictionsInvalid('decision predictions must be JSON text');
  if (Buffer.byteLength(text) > DECISION_DATASET_MAX_BYTES) predictionsInvalid(`decision predictions exceeds ${DECISION_DATASET_MAX_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    predictionsInvalid(`decision predictions is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDecisionPredictions(value);
}

export function predictionsDigest(value) {
  return digestJson(validateDecisionPredictions(value));
}

export async function loadDecisionPredictions(projectRoot, projectRelativePath) {
  const root = await canonicalProjectRoot(projectRoot);
  const text = await readProjectFile(root, projectRelativePath, { field: 'predictions path' });
  return parseDecisionPredictions(text);
}

export function cloneDecisionDataset(value) {
  return JSON.parse(stableStringify(validateDecisionDataset(value)));
}
