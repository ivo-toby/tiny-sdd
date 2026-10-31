import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactKeys, assertPlainObject, digestJson, tinyError } from './fs-utils.mjs';

// Optional registry fields on a worker profile (#123). They describe the exact
// configuration a profile was measured on and the measured results. Worker runs
// apply `model.contextWindow`, `responseBudget.maxTokens` and `limits`.
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

// Fields that record evidence about a profile. They never change a run, so they
// stay out of the profile identity: adding a benchmark card keeps
// qualification records and approvals valid.
const EVIDENCE_ONLY_KEYS = ['status', 'benchmarks'];

export function profileIdentityDigest(profile) {
  const identity = { ...profile };
  for (const key of EVIDENCE_ONLY_KEYS) delete identity[key];
  return digestJson(identity);
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Written by setup and `profiles update` beside the installed registry.
export const REGISTRY_MANIFEST = '.registry.json';
const MAX_PROFILE_BYTES = 1024 * 1024;
const BUNDLED_DIR = fileURLToPath(new URL('../profiles/', import.meta.url));

export function isProfileId(value) {
  return typeof value === 'string' && PROFILE_ID.test(value) && !value.toLowerCase().endsWith('.json');
}

export function tinysddConfigDir(env = process.env) {
  if (env.TINYSDD_CONFIG_DIR) return env.TINYSDD_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tiny-sdd');
}

// Most specific first. The same id in two places with different content is an
// error, so a stale copy can never be picked silently.
export function profileLocations(projectRoot, env = process.env) {
  const config = tinysddConfigDir(env);
  return [
    { location: 'project', dir: join(projectRoot, '.tinysdd', 'profiles') },
    { location: 'user', dir: join(config, 'profiles') },
    { location: 'registry', dir: join(config, 'registry') },
    { location: 'bundled', dir: env.TINYSDD_BUNDLED_PROFILES_DIR || BUNDLED_DIR },
  ];
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size <= MAX_PROFILE_BYTES;
  } catch {
    return false;
  }
}

export async function profilesIn(dir) {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return [];
  } catch {
    return [];
  }
  const found = [];
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.json') && !entry.startsWith('.')).sort()) {
    const path = join(dir, name);
    if (!(await regularFile(path))) continue;
    try {
      found.push({ path, value: JSON.parse(await readFile(path, 'utf8')) });
    } catch {
      // Unparseable files elsewhere in a directory do not block a lookup; a file
      // that matches the requested id by name is checked below.
      found.push({ path, value: null });
    }
  }
  return found;
}

export async function findProfileById(projectRoot, id, { env = process.env } = {}) {
  const matches = [];
  const searched = [];
  for (const { location, dir } of profileLocations(projectRoot, env)) {
    searched.push(dir);
    for (const entry of await profilesIn(dir)) {
      if (entry.value === null) {
        if (entry.path.endsWith(`/${id}.json`)) invalid(`malformed profile JSON: ${entry.path}`);
        continue;
      }
      if (entry.value?.id === id) matches.push({ location, ...entry });
    }
  }
  if (matches.length === 0) throw tinyError('PROFILE_NOT_FOUND', `profile ${id} not found`, { searched });
  const digests = new Set(matches.map((match) => digestJson(match.value)));
  if (digests.size > 1) {
    const locations = new Set(matches.map((match) => match.location));
    const hint = locations.has('registry') && locations.has('bundled')
      ? 'the installed registry differs from the profiles shipped with this CLI; run tinysdd profiles update'
      : 'remove or rename one';
    throw tinyError('PROFILE_AMBIGUOUS', `profile ${id} exists with different content in ${matches.map((match) => match.path).join(', ')}; ${hint}`, { paths: matches.map((match) => match.path) });
  }
  return matches[0];
}

// A profile's limits are the measured configuration, not a binding one (#174):
// they become defaults, and a worker's explicit limits win. The
// firstWriteMs < timeoutMs invariant still holds for the merged result.
// `limits` are already validated, so defaulted keys can be present without
// being explicit; only `explicitKeys` count as worker choices.
export function applyProfileLimits(limits, profileLimits, explicitKeys, { worker, profile }) {
  const merged = { ...limits };
  const provenance = {};
  for (const [key, value] of Object.entries(profileLimits)) {
    const explicit = explicitKeys.includes(key);
    merged[key] = explicit ? limits[key] : value;
    provenance[key] = { measured: value, effective: merged[key], source: explicit ? 'worker' : 'profile' };
  }
  if (merged.firstWriteMs !== undefined && merged.timeoutMs !== undefined && merged.firstWriteMs >= merged.timeoutMs) {
    throw tinyError('PROFILE_LIMIT_CONFLICT', `worker ${worker}: firstWriteMs ${merged.firstWriteMs} must stay below timeoutMs ${merged.timeoutMs} (profile ${profile})`);
  }
  return { limits: merged, provenance };
}
