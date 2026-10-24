import { assertExactKeys, assertPlainObject, tinyError } from './fs-utils.mjs';

// Optional registry fields on a worker profile (#123). They describe the exact
// configuration a profile was measured on and the measured results. Applying
// them to worker runs is a separate step; here they are only validated.
export const REGISTRY_PROFILE_KEYS = ['status', 'model', 'limits', 'responseBudget', 'benchmarks'];
export const PROFILE_STATUSES = ['proposed', 'baseline', 'tested-improved', 'tested-inconclusive'];

const MODEL_KEYS = ['route', 'family', 'quantization', 'server', 'contextWindow', 'parallel', 'note'];
const SERVER_KEYS = ['id', 'version'];
const LIMIT_KEYS = ['timeoutMs', 'firstWriteMs', 'maxToolCalls', 'maxCheckRuns'];
const LIMIT_MAX = { timeoutMs: 3_600_000, firstWriteMs: 3_600_000, maxToolCalls: 100, maxCheckRuns: 20 };
const RESPONSE_BUDGET_KEYS = ['maxTokens'];
const CARD_KEYS = [
  'suite', 'harness', 'date', 'variant', 'split', 'run', 'settings', 'exercises', 'validExercises',
  'repeats', 'pass1', 'pass2', 'minutesPerTask', 'perLanguage', 'decision', 'note',
];
const CARD_SPLITS = ['all', 'discovery', 'holdout'];
const SETTINGS_KEYS = ['route', 'contextWindow', 'maxTokens', 'thinking', 'timeoutMs', 'parallel'];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const LANGUAGE_KEYS = ['n', 'pass1', 'pass2'];
const DECISION_KEYS = ['metric', 'keep', 'n', 'delta', 'reasons'];

function invalid(message) {
  throw tinyError('PROFILE_INVALID', message);
}

function object(value, label, keys) {
  assertPlainObject(value, 'PROFILE_INVALID', label);
  assertExactKeys(value, keys, 'PROFILE_INVALID', label);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a nonempty string`);
  return value;
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) invalid(`${label} must be an integer from 1 to ${max}`);
  return value;
}

function rate(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${label} must be a number from 0 to 1`);
  return value;
}

function copyKnown(raw, label, keys, check) {
  const out = {};
  for (const key of keys) if (raw[key] !== undefined) out[key] = check(key, raw[key], `${label}.${key}`);
  return out;
}

function validateModel(raw, label) {
  object(raw, label, MODEL_KEYS);
  return copyKnown(raw, label, MODEL_KEYS, (key, value, path) => {
    if (key === 'contextWindow' || key === 'parallel') return positiveInt(value, path);
    if (key === 'server') {
      object(value, path, SERVER_KEYS);
      return copyKnown(value, path, SERVER_KEYS, (_k, v, p) => text(v, p));
    }
    return text(value, path);
  });
}

function validateLimits(raw, label) {
  object(raw, label, LIMIT_KEYS);
  const limits = copyKnown(raw, label, LIMIT_KEYS, (key, value, path) => positiveInt(value, path, LIMIT_MAX[key]));
  if (limits.firstWriteMs !== undefined && limits.timeoutMs !== undefined && limits.firstWriteMs >= limits.timeoutMs) {
    invalid(`${label}.firstWriteMs must be below timeoutMs`);
  }
  return limits;
}

function validateSettings(raw, label) {
  object(raw, label, SETTINGS_KEYS);
  return copyKnown(raw, label, SETTINGS_KEYS, (key, value, path) => {
    if (key === 'route') return text(value, path);
    if (key === 'thinking') {
      if (!THINKING_LEVELS.includes(value)) invalid(`${path} is invalid`);
      return value;
    }
    return positiveInt(value, path);
  });
}

function validatePerLanguage(raw, label) {
  assertPlainObject(raw, 'PROFILE_INVALID', label);
  const out = {};
  for (const [language, entry] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9+#-]*$/.test(language)) invalid(`${label} has an invalid language name: ${language}`);
    const path = `${label}.${language}`;
    object(entry, path, LANGUAGE_KEYS);
    if (entry.n === undefined || entry.pass1 === undefined || entry.pass2 === undefined) invalid(`${path} needs n, pass1 and pass2`);
    out[language] = { n: positiveInt(entry.n, `${path}.n`), pass1: rate(entry.pass1, `${path}.pass1`), pass2: rate(entry.pass2, `${path}.pass2`) };
  }
  return out;
}

function validateDecision(raw, label) {
  object(raw, label, DECISION_KEYS);
  if (!['pass1', 'pass2'].includes(raw.metric)) invalid(`${label}.metric must be pass1 or pass2`);
  if (typeof raw.keep !== 'boolean') invalid(`${label}.keep must be boolean`);
  const decision = { metric: raw.metric, keep: raw.keep };
  if (raw.n !== undefined) decision.n = positiveInt(raw.n, `${label}.n`);
  if (raw.delta !== undefined) {
    if (typeof raw.delta !== 'number' || !Number.isFinite(raw.delta) || raw.delta < -1 || raw.delta > 1) invalid(`${label}.delta must be a number from -1 to 1`);
    decision.delta = raw.delta;
  }
  if (raw.reasons !== undefined) {
    if (!Array.isArray(raw.reasons) || raw.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)) invalid(`${label}.reasons must be an array of strings`);
    decision.reasons = [...raw.reasons];
  }
  return decision;
}

export function validateBenchmarkCard(raw, label = 'benchmark') {
  object(raw, label, CARD_KEYS);
  for (const key of ['suite', 'harness', 'date', 'variant', 'split', 'exercises', 'repeats', 'pass1', 'pass2']) {
    if (raw[key] === undefined) invalid(`${label}.${key} is required`);
  }
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) invalid(`${label}.date must be YYYY-MM-DD`);
  if (!CARD_SPLITS.includes(raw.split)) invalid(`${label}.split must be one of ${CARD_SPLITS.join(', ')}`);
  const card = {
    suite: text(raw.suite, `${label}.suite`),
    harness: text(raw.harness, `${label}.harness`),
    date: raw.date,
    variant: text(raw.variant, `${label}.variant`),
    split: raw.split,
  };
  if (raw.run !== undefined) card.run = text(raw.run, `${label}.run`);
  if (raw.settings !== undefined) card.settings = validateSettings(raw.settings, `${label}.settings`);
  card.exercises = positiveInt(raw.exercises, `${label}.exercises`);
  if (raw.validExercises !== undefined) {
    card.validExercises = positiveInt(raw.validExercises, `${label}.validExercises`);
    if (card.exercises > card.validExercises) invalid(`${label}.exercises cannot exceed validExercises`);
  }
  card.repeats = positiveInt(raw.repeats, `${label}.repeats`);
  card.pass1 = rate(raw.pass1, `${label}.pass1`);
  card.pass2 = rate(raw.pass2, `${label}.pass2`);
  if (raw.minutesPerTask !== undefined) {
    if (typeof raw.minutesPerTask !== 'number' || !Number.isFinite(raw.minutesPerTask) || raw.minutesPerTask < 0) invalid(`${label}.minutesPerTask must be a nonnegative number`);
    card.minutesPerTask = raw.minutesPerTask;
  }
  if (raw.perLanguage !== undefined) card.perLanguage = validatePerLanguage(raw.perLanguage, `${label}.perLanguage`);
  if (raw.decision !== undefined) card.decision = validateDecision(raw.decision, `${label}.decision`);
  if (raw.note !== undefined) card.note = text(raw.note, `${label}.note`);
  return card;
}

// Returns only the registry fields that are present, validated and copied.
export function validateRegistryFields(raw, label) {
  const out = {};
  if (raw.status !== undefined) {
    if (!PROFILE_STATUSES.includes(raw.status)) invalid(`${label}.status must be one of ${PROFILE_STATUSES.join(', ')}`);
    out.status = raw.status;
  }
  if (raw.model !== undefined) out.model = validateModel(raw.model, `${label}.model`);
  if (raw.limits !== undefined) out.limits = validateLimits(raw.limits, `${label}.limits`);
  if (raw.responseBudget !== undefined) {
    object(raw.responseBudget, `${label}.responseBudget`, RESPONSE_BUDGET_KEYS);
    out.responseBudget = copyKnown(raw.responseBudget, `${label}.responseBudget`, RESPONSE_BUDGET_KEYS, (_k, v, p) => positiveInt(v, p));
  }
  if (raw.benchmarks !== undefined) {
    if (!Array.isArray(raw.benchmarks)) invalid(`${label}.benchmarks must be an array`);
    out.benchmarks = raw.benchmarks.map((card, index) => validateBenchmarkCard(card, `${label}.benchmarks[${index}]`));
  }
  return out;
}
