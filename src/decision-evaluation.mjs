import { digestJson, tinyError } from './fs-utils.mjs';
import {
  DECISION_POINTS,
  DECISION_UNKNOWN,
  decisionCaseInputDigest,
  decisionDatasetDigest,
  validateDecisionDataset,
  validateDecisionPredictions,
} from './decision-dataset.mjs';
import { triageFailure, triageReview } from './decision-baselines.mjs';

export const DECISION_METRICS_SCHEMA_VERSION = 1;
export const DECISION_EVALUATION_SCHEMA_VERSION = 1;
export const REQUIRED_REAL_FAILURE_TRIAGE_LABELS = 50;

const MAX_METRIC_CONFIG_BYTES = 128 * 1024;
const MAX_CALIBRATION_BINS = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MULTI_LABEL_PROBABILITY_REASON = 'accept-label probabilities do not provide a genuine combined-event probability';
const BOOLEAN_PROBABILITY_REASON = 'boolean accept-label probability keys are ambiguous in a JSON object';

function invalid(message, details = undefined) {
  throw tinyError('DECISION_EVALUATION_INVALID', message, details);
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

function string(value, label, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${label} must be a bounded nonempty string`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function metricLabel(value, label) {
  if (typeof value !== 'string' && typeof value !== 'boolean') invalid(`${label} must be a string or boolean`);
  if (typeof value === 'string' && (value.length === 0 || value.length > 128 || value === DECISION_UNKNOWN || ['__proto__', 'constructor', 'prototype'].includes(value))) invalid(`${label} must be a reviewed label`);
  return value;
}

function uniqueLabels(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid(`${label} must contain between 1 and 64 labels`);
  const result = value.map((entry, index) => metricLabel(entry, `${label}[${index}]`));
  for (let index = 0; index < result.length; index += 1) {
    for (let other = index + 1; other < result.length; other += 1) {
      if (Object.is(result[index], result[other])) invalid(`${label} contains duplicate labels`);
    }
  }
  return result;
}

function threshold(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${label} must be a threshold from 0 to 1`);
  return value;
}

function bins(value, label) {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_CALIBRATION_BINS) invalid(`${label} must be an integer from 2 to ${MAX_CALIBRATION_BINS}`);
  return value;
}

function validateMetricPoint(value, decisionPoint) {
  const label = `metrics.decisionPoints.${decisionPoint}`;
  const point = plainObject(value, label);
  exactKeys(point, ['positiveLabels', 'acceptLabels', 'threshold', 'calibrationBins'], label);
  return {
    positiveLabels: uniqueLabels(point.positiveLabels, `${label}.positiveLabels`),
    acceptLabels: uniqueLabels(point.acceptLabels, `${label}.acceptLabels`),
    threshold: threshold(point.threshold, `${label}.threshold`),
    calibrationBins: bins(point.calibrationBins, `${label}.calibrationBins`),
  };
}

export function validateDecisionMetricsConfig(value) {
  const config = plainObject(value, 'decision metrics config');
  exactKeys(config, ['schemaVersion', 'decisionPoints'], 'decision metrics config');
  if (config.schemaVersion !== DECISION_METRICS_SCHEMA_VERSION) invalid(`decision metrics config.schemaVersion must be ${DECISION_METRICS_SCHEMA_VERSION}`);
  const decisionPoints = plainObject(config.decisionPoints, 'metrics.decisionPoints');
  const normalized = {};
  for (const [decisionPoint, point] of Object.entries(decisionPoints)) {
    if (!DECISION_POINTS.includes(decisionPoint)) invalid(`metrics.decisionPoints contains unsupported decision point: ${decisionPoint}`);
    normalized[decisionPoint] = validateMetricPoint(point, decisionPoint);
  }
  return { schemaVersion: DECISION_METRICS_SCHEMA_VERSION, decisionPoints: normalized };
}

export function parseDecisionMetricsConfig(text) {
  if (typeof text !== 'string') invalid('decision metrics config must be JSON text');
  if (Buffer.byteLength(text) > MAX_METRIC_CONFIG_BYTES) invalid(`decision metrics config exceeds ${MAX_METRIC_CONFIG_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`decision metrics config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDecisionMetricsConfig(value);
}

function sameLabel(left, right) {
  return Object.is(left, right);
}

function includesLabel(labels, value) {
  return labels.some((label) => sameLabel(label, value));
}

function labelKey(value) {
  if (value === DECISION_UNKNOWN) return DECISION_UNKNOWN;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return `string:${JSON.stringify(value)}`;
}

function knownProbability(prediction, labels) {
  if (labels.length !== 1 || typeof labels[0] === 'boolean') return DECISION_UNKNOWN;
  if (prediction.probabilities === DECISION_UNKNOWN) return DECISION_UNKNOWN;
  const key = String(labels[0]);
  if (!Object.hasOwn(prediction.probabilities, key)) return DECISION_UNKNOWN;
  const value = prediction.probabilities[key];
  return typeof value === 'number' ? value : DECISION_UNKNOWN;
}

function probabilityReason(metricPoint) {
  if (!metricPoint) return undefined;
  if (metricPoint.acceptLabels.length > 1) return MULTI_LABEL_PROBABILITY_REASON;
  if (typeof metricPoint.acceptLabels[0] === 'boolean') return BOOLEAN_PROBABILITY_REASON;
  return undefined;
}

function serializeConfusionMatrix(matrix) {
  const result = {};
  for (const actual of Object.keys(matrix).sort()) {
    const row = {};
    for (const predicted of Object.keys(matrix[actual]).sort()) row[predicted] = matrix[actual][predicted];
    result[actual] = row;
  }
  return result;
}

function ratio(count, denominator) {
  return denominator === 0 ? DECISION_UNKNOWN : count / denominator;
}

function metricRate(count, denominator, denominatorDefinition) {
  return { count, denominator, rate: ratio(count, denominator), denominatorDefinition };
}

function summarizeMeasurements(predictions) {
  const fields = ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'frontierTokensAvoided'];
  const result = {};
  for (const field of fields) {
    const values = predictions
      .map((prediction) => prediction.measurements[field])
      .filter((value) => value !== DECISION_UNKNOWN);
    if (values.length === 0) {
      result[field] = DECISION_UNKNOWN;
      continue;
    }
    result[field] = {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
  }
  return result;
}

function emptyBinaryCounts() {
  return { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0, unknown: 0 };
}

function reliability(predictions, metricPoint, caseById) {
  if (!metricPoint) return DECISION_UNKNOWN;
  const observations = [];
  for (const prediction of predictions) {
    const item = caseById.get(prediction.caseId);
    const probability = knownProbability(prediction, metricPoint.acceptLabels);
    if (probability === DECISION_UNKNOWN) continue;
    const actual = includesLabel(metricPoint.positiveLabels, item.expected.label) ? 1 : 0;
    observations.push({ probability, actual });
  }
  if (observations.length === 0) return DECISION_UNKNOWN;
  const binsCount = metricPoint.calibrationBins;
  const curve = Array.from({ length: binsCount }, (_, index) => ({
    lower: index / binsCount,
    upper: (index + 1) / binsCount,
    count: 0,
    meanProbability: DECISION_UNKNOWN,
    meanOutcome: DECISION_UNKNOWN,
    absoluteGap: DECISION_UNKNOWN,
  }));
  let brierSum = 0;
  for (const observation of observations) {
    brierSum += (observation.probability - observation.actual) ** 2;
    const index = Math.min(binsCount - 1, Math.floor(observation.probability * binsCount));
    const bin = curve[index];
    bin.count += 1;
    bin.meanProbability = bin.meanProbability === DECISION_UNKNOWN
      ? observation.probability
      : bin.meanProbability + observation.probability;
    bin.meanOutcome = bin.meanOutcome === DECISION_UNKNOWN
      ? observation.actual
      : bin.meanOutcome + observation.actual;
  }
  let ece = 0;
  for (const bin of curve) {
    if (bin.count === 0) continue;
    bin.meanProbability /= bin.count;
    bin.meanOutcome /= bin.count;
    bin.absoluteGap = Math.abs(bin.meanProbability - bin.meanOutcome);
    ece += (bin.count / observations.length) * bin.absoluteGap;
  }
  return {
    sampleCount: observations.length,
    brier: brierSum / observations.length,
    ece,
    bins: curve,
  };
}

function evaluatePoint({ decisionPoint, cases, predictions, metricPoint }) {
  const matrix = Object.create(null);
  let knownPredictedLabels = 0;
  let knownProbabilities = 0;
  let thresholdKnown = 0;
  let thresholdAccept = 0;
  let thresholdNegative = 0;
  let thresholdAbstain = 0;
  const binary = emptyBinaryCounts();
  const thresholdBinary = emptyBinaryCounts();
  const predictionByCase = new Map(predictions.map((prediction) => [prediction.caseId, prediction]));
  for (const item of cases) {
    const prediction = predictionByCase.get(item.id);
    if (!prediction) continue;
    const actualKey = labelKey(item.expected.label);
    const predictedKey = labelKey(prediction.predictedLabel);
    const row = matrix[actualKey] ?? (matrix[actualKey] = Object.create(null));
    row[predictedKey] = (row[predictedKey] ?? 0) + 1;
    if (prediction.predictedLabel !== DECISION_UNKNOWN) knownPredictedLabels += 1;
    const probability = metricPoint ? knownProbability(prediction, metricPoint.acceptLabels) : DECISION_UNKNOWN;
    if (probability !== DECISION_UNKNOWN) knownProbabilities += 1;
    if (metricPoint && prediction.predictedLabel !== DECISION_UNKNOWN) {
      const actualPositive = includesLabel(metricPoint.positiveLabels, item.expected.label);
      const predictedPositive = includesLabel(metricPoint.acceptLabels, prediction.predictedLabel);
      if (actualPositive && predictedPositive) binary.truePositive += 1;
      else if (!actualPositive && !predictedPositive) binary.trueNegative += 1;
      else if (!actualPositive && predictedPositive) binary.falsePositive += 1;
      else binary.falseNegative += 1;
    } else if (metricPoint) {
      binary.unknown += 1;
    }
    if (metricPoint) {
      let thresholdClass = 'abstain';
      if (probability !== DECISION_UNKNOWN) thresholdClass = probability >= metricPoint.threshold ? 'accept' : 'negative';
      if (thresholdClass === 'accept') {
        thresholdAccept += 1;
        thresholdKnown += 1;
      } else if (thresholdClass === 'negative') {
        thresholdNegative += 1;
        thresholdKnown += 1;
      } else {
        thresholdAbstain += 1;
      }
      const actualPositive = includesLabel(metricPoint.positiveLabels, item.expected.label);
      if (thresholdClass === 'accept' || thresholdClass === 'negative') {
        const predictedPositive = thresholdClass === 'accept';
        if (actualPositive && predictedPositive) thresholdBinary.truePositive += 1;
        else if (!actualPositive && !predictedPositive) thresholdBinary.trueNegative += 1;
        else if (!actualPositive && predictedPositive) thresholdBinary.falsePositive += 1;
        else thresholdBinary.falseNegative += 1;
      } else {
        thresholdBinary.unknown += 1;
      }
    }
  }
  const actualNegatives = thresholdBinary.trueNegative + thresholdBinary.falsePositive;
  const predictedPositives = thresholdBinary.truePositive + thresholdBinary.falsePositive;
  const probabilityReasonText = probabilityReason(metricPoint);
  const thresholdMetrics = metricPoint === undefined || probabilityReasonText !== undefined ? DECISION_UNKNOWN : {
    threshold: metricPoint.threshold,
    acceptLabels: metricPoint.acceptLabels,
    positiveLabels: metricPoint.positiveLabels,
    classes: { accept: thresholdAccept, negative: thresholdNegative, abstain: thresholdAbstain },
    confusion: thresholdBinary,
    falseAcceptRate: metricRate(thresholdBinary.falsePositive, actualNegatives, 'actual negatives'),
    falsePositiveRate: metricRate(thresholdBinary.falsePositive, actualNegatives, 'actual negatives'),
    falseDiscoveryRate: metricRate(thresholdBinary.falsePositive, predictedPositives, 'predicted positives'),
  };
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const calibration = reliability(predictions, metricPoint, caseById);
  const coverage = {
    predictions: cases.length === 0 ? DECISION_UNKNOWN : predictions.length / cases.length,
    predictedLabels: cases.length === 0 ? DECISION_UNKNOWN : knownPredictedLabels / cases.length,
    probabilities: cases.length === 0 ? DECISION_UNKNOWN : knownProbabilities / cases.length,
    threshold: cases.length === 0 || metricPoint === undefined ? DECISION_UNKNOWN : thresholdKnown / cases.length,
  };
  return {
    decisionPoint,
    datasetCases: cases.length,
    predictionCount: predictions.length,
    knownPredictedLabels,
    knownProbabilities,
    thresholdKnown,
    coverage,
    labelCoverage: cases.length === 0 ? DECISION_UNKNOWN : knownPredictedLabels / cases.length,
    probabilityCoverage: cases.length === 0 ? DECISION_UNKNOWN : knownProbabilities / cases.length,
    confusionMatrix: serializeConfusionMatrix(matrix),
    binaryConfusion: metricPoint === undefined ? DECISION_UNKNOWN : binary,
    threshold: thresholdMetrics,
    ...(probabilityReasonText === undefined ? {} : { thresholdReason: probabilityReasonText }),
    calibration,
    ...(probabilityReasonText === undefined ? {} : { calibrationReason: probabilityReasonText }),
    measurements: summarizeMeasurements(predictions),
  };
}

function datasetCounts(dataset) {
  const realCases = dataset.cases.filter((item) => !item.synthetic);
  const syntheticCases = dataset.cases.filter((item) => item.synthetic);
  const realFailureTriageLabels = realCases.filter((item) => item.decisionPoint === 'failure-triage').length;
  return {
    totalCases: dataset.cases.length,
    realCases: realCases.length,
    syntheticCases: syntheticCases.length,
    realFailureTriageLabels,
    requiredRealFailureTriageLabels: REQUIRED_REAL_FAILURE_TRIAGE_LABELS,
    missingRealFailureTriageLabels: Math.max(0, REQUIRED_REAL_FAILURE_TRIAGE_LABELS - realFailureTriageLabels),
    realFailureTriageMinimumMet: realFailureTriageLabels >= REQUIRED_REAL_FAILURE_TRIAGE_LABELS,
  };
}

function providerGroups(predictions) {
  const result = [];
  const groups = new Map();
  for (const prediction of predictions) {
    let group = groups.get(prediction.provider.id);
    if (!group) {
      group = { provider: prediction.provider, predictions: [] };
      groups.set(prediction.provider.id, group);
      result.push(group);
    } else if (group.provider.configSha256 !== prediction.provider.configSha256) {
      invalid(`provider ${prediction.provider.id} has conflicting config digests`);
    }
    group.predictions.push(prediction);
  }
  return result;
}

function verifyPredictionBindings(dataset, predictions) {
  const datasetSha256 = decisionDatasetDigest(dataset);
  if (predictions.datasetSha256 !== datasetSha256) invalid('decision predictions.datasetSha256 does not match the dataset');
  const cases = new Map(dataset.cases.map((item) => [item.id, item]));
  for (const prediction of predictions.predictions) {
    const item = cases.get(prediction.caseId);
    if (!item) invalid(`prediction references unknown case: ${prediction.caseId}`);
    const inputSha256 = decisionCaseInputDigest(item);
    if (prediction.inputSha256 !== inputSha256) invalid(`prediction inputSha256 does not match case: ${prediction.caseId}`);
  }
}

export function evaluateDecisions({ dataset, predictions, metrics = undefined } = {}) {
  const normalizedDataset = validateDecisionDataset(dataset);
  const normalizedPredictions = validateDecisionPredictions(predictions);
  const normalizedMetrics = metrics === undefined || metrics === null ? undefined : validateDecisionMetricsConfig(metrics);
  verifyPredictionBindings(normalizedDataset, normalizedPredictions);
  const casesByPoint = new Map(DECISION_POINTS.map((point) => [point, []]));
  for (const item of normalizedDataset.cases) casesByPoint.get(item.decisionPoint).push(item);
  const reportProviders = providerGroups(normalizedPredictions.predictions).map((group) => {
    const byPoint = {};
    for (const decisionPoint of DECISION_POINTS) {
      const pointCases = casesByPoint.get(decisionPoint);
      const pointPredictions = group.predictions.filter((prediction) => pointCases.some((item) => item.id === prediction.caseId));
      const metricPoint = normalizedMetrics?.decisionPoints[decisionPoint];
      byPoint[decisionPoint] = evaluatePoint({ decisionPoint, cases: pointCases, predictions: pointPredictions, metricPoint });
    }
    return {
      provider: group.provider,
      predictions: group.predictions.length,
      decisionPoints: byPoint,
    };
  });
  return {
    schemaVersion: DECISION_EVALUATION_SCHEMA_VERSION,
    dataset: {
      id: normalizedDataset.id,
      version: normalizedDataset.version,
      sha256: decisionDatasetDigest(normalizedDataset),
      counts: datasetCounts(normalizedDataset),
    },
    metrics: normalizedMetrics === undefined ? DECISION_UNKNOWN : {
      sha256: digestJson(normalizedMetrics),
      decisionPoints: normalizedMetrics.decisionPoints,
    },
    providers: reportProviders,
    warnings: [
      ...(datasetCounts(normalizedDataset).realFailureTriageMinimumMet
        ? []
        : [`real failure-triage labels are incomplete: ${datasetCounts(normalizedDataset).missingRealFailureTriageLabels} more human-reviewed real cases are required`]),
      ...(reportProviders.length === 0 ? ['no saved provider predictions were supplied'] : []),
    ],
  };
}

function providerForBaseline(provider) {
  const item = plainObject(provider, 'baseline provider');
  exactKeys(item, ['id', 'configSha256'], 'baseline provider');
  if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 256) invalid('baseline provider.id must be a bounded nonempty string');
  return { id: item.id, configSha256: digest(item.configSha256, 'baseline provider.configSha256') };
}

function baselineLabel(item) {
  if (item.decisionPoint === 'failure-triage') {
    const result = triageFailure({ checkLog: item.observation?.checkLog });
    return result.decision;
  }
  if (item.decisionPoint === 'review-triage') {
    const result = triageReview({
      result: item.observation?.result,
      controllerChecks: item.observation?.controllerChecks,
      patch: item.observation?.patch,
    });
    return result.needsFrontierReview;
  }
  return DECISION_UNKNOWN;
}

export function buildBaselinePredictions(dataset, provider) {
  const normalizedDataset = validateDecisionDataset(dataset);
  const baselineProvider = providerForBaseline(provider);
  const predictions = normalizedDataset.cases.map((item) => ({
    provider: baselineProvider,
    caseId: item.id,
    inputSha256: decisionCaseInputDigest(item),
    predictedLabel: baselineLabel(item),
    probabilities: DECISION_UNKNOWN,
    measurements: {
      latencyMs: DECISION_UNKNOWN,
      inputTokens: DECISION_UNKNOWN,
      outputTokens: DECISION_UNKNOWN,
      totalTokens: DECISION_UNKNOWN,
      frontierTokensAvoided: DECISION_UNKNOWN,
    },
  }));
  return validateDecisionPredictions({
    schemaVersion: 1,
    datasetSha256: decisionDatasetDigest(normalizedDataset),
    predictions,
  });
}

export function metricConfigDigest(metrics) {
  return digestJson(validateDecisionMetricsConfig(metrics));
}

export const evaluateDecisionDataset = evaluateDecisions;
