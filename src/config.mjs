import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  assertExactKeys,
  assertInternalPath,
  assertPlainObject,
  canonicalProjectRoot,
  normalizeProjectRelative,
  readJsonFile,
  readProjectFile,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import { validatePhasePolicy, validateTestReviewPolicy } from './phase-gates.mjs';
import { validateFeatureIntegrationConfig } from './feature-integration.mjs';
import { WORKER_TYPES } from './runners/types.mjs';
import { REGISTRY_PROFILE_KEYS, applyProfileLimits, findProfileById, isProfileId, validateRegistryFields } from './model-registry.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_TOOL_CALLS = 100;
export const MAX_TOOL_CALLS = 100;

const WORKER_KEYS = ['type', 'provider', 'model', 'profile', 'skills', 'instructions', 'limits', 'modelMetadata'];
const MODEL_METADATA_KEYS = ['quantization', 'server'];
const MODEL_SERVER_KEYS = ['id', 'version'];
const QUALIFICATION_KEYS = ['mode', 'suite'];
const QUALIFICATION_MODES = ['off', 'warn', 'enforce'];
const LIMIT_KEYS = ['timeoutMs', 'maxToolCalls', 'firstWriteMs', 'maxCheckRuns'];
const PROFILE_KEYS = ['schemaVersion', 'id', 'instructions', 'runtime', 'evidence', 'limitations', ...REGISTRY_PROFILE_KEYS];
const RUNTIME_KEYS = ['thinking', 'reasoning', 'compat', 'thinkingBudgets', 'compaction'];
const COMPAT_KEYS = ['thinkingFormat', 'supportsDeveloperRole', 'thinkingTokenBudgetField'];
const THINKING_BUDGET_KEYS = ['minimal', 'low', 'medium', 'high'];
const COMPACTION_KEYS = ['enabled', 'reserveTokens', 'keepRecentTokens'];
const SEMANTIC_GATE_KEYS = ['mode', 'endpoint', 'model', 'thresholds'];
const SEMANTIC_GATE_MODES = ['off', 'shadow', 'enforce'];
const SEMANTIC_GATE_THRESHOLD_KEYS = ['accept', 'reject'];

// The thresholds ship in config and are provisional placeholders until the
// benchmark shadow data calibrates them; they are not hardcoded truths.
export const DEFAULT_SEMANTIC_GATE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_SEMANTIC_GATE_MODEL = 'jev-latest';
export const DEFAULT_SEMANTIC_GATE_THRESHOLDS = { accept: 0.75, reject: 0.40 };

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw tinyError('CONFIG_INVALID', `${label} must be a nonempty string`);
  return value;
}

function assertStringAllowEmpty(value, label) {
  if (typeof value !== 'string') return assertString(value, label);
  return value;
}

function assertSafeName(value, label) {
  assertString(value, label);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw tinyError('CONFIG_INVALID', `${label} must contain only lowercase letters, digits, hyphens, or underscores`);
  }
  return value;
}

function validatePathValue(value, label) {
  return normalizeProjectRelative(assertString(value, label), label);
}

function validateStringArray(value, label, suffix = undefined) {
  if (!Array.isArray(value)) throw tinyError('CONFIG_INVALID', `${label} must be an array`);
  const seen = new Set();
  return value.map((item, index) => {
    const path = validatePathValue(item, `${label}[${index}]`);
    if (suffix && path !== suffix && !path.endsWith(`/${suffix}`)) {
      throw tinyError('CONFIG_INVALID', `${label}[${index}] must name ${suffix}`);
    }
    if (seen.has(path)) throw tinyError('CONFIG_INVALID', `${label} contains a duplicate path: ${path}`);
    seen.add(path);
    return path;
  });
}

function validateLimits(value, label) {
  if (value === undefined) return { timeoutMs: DEFAULT_TIMEOUT_MS, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, maxCheckRuns: 12 };
  assertPlainObject(value, 'CONFIG_INVALID', label);
  assertExactKeys(value, LIMIT_KEYS, 'CONFIG_INVALID', label);
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxToolCalls = value.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  if (value.timeoutMs === null || value.maxToolCalls === null) {
    throw tinyError('CONFIG_INVALID', `${label} values may not be null`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw tinyError('CONFIG_INVALID', `${label}.timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls <= 0 || maxToolCalls > MAX_TOOL_CALLS) {
    throw tinyError('CONFIG_INVALID', `${label}.maxToolCalls must be an integer from 1 to ${MAX_TOOL_CALLS}`);
  }
  const maxCheckRuns = value.maxCheckRuns === undefined ? 12 : value.maxCheckRuns;
  if (!Number.isInteger(maxCheckRuns) || maxCheckRuns < 1 || maxCheckRuns > 20) {
    throw tinyError('CONFIG_INVALID', `${label}.maxCheckRuns must be an integer from 1 to 20`);
  }
  if (value.firstWriteMs === undefined) return { timeoutMs, maxToolCalls, maxCheckRuns };
  // Optional no-progress watchdog: stop when no write/edit has started by then.
  if (!Number.isInteger(value.firstWriteMs) || value.firstWriteMs <= 0 || value.firstWriteMs >= timeoutMs) {
    throw tinyError('CONFIG_INVALID', `${label}.firstWriteMs must be a positive integer below timeoutMs`);
  }
  return { timeoutMs, maxToolCalls, maxCheckRuns, firstWriteMs: value.firstWriteMs };
}

function validateModelMetadata(value, label) {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  assertExactKeys(value, MODEL_METADATA_KEYS, 'CONFIG_INVALID', label);
  const metadata = {};
  if (value.quantization !== undefined) metadata.quantization = assertString(value.quantization, `${label}.quantization`);
  if (value.server !== undefined) {
    assertPlainObject(value.server, 'CONFIG_INVALID', `${label}.server`);
    assertExactKeys(value.server, MODEL_SERVER_KEYS, 'CONFIG_INVALID', `${label}.server`);
    const server = {};
    if (value.server.id !== undefined) server.id = assertString(value.server.id, `${label}.server.id`);
    if (value.server.version !== undefined) server.version = assertString(value.server.version, `${label}.server.version`);
    metadata.server = server;
  }
  return metadata;
}

function validateWorker(raw, name, label = `workers.${name}`) {
  assertPlainObject(raw, 'CONFIG_INVALID', label);
  assertExactKeys(raw, WORKER_KEYS, 'CONFIG_INVALID', label);
  if (!WORKER_TYPES.includes(raw.type)) throw tinyError('UNSUPPORTED_WORKER', `${label}.type must be ${WORKER_TYPES.map((type) => `"${type}"`).join(' or ')}`);
  const worker = {
    type: raw.type,
    provider: assertString(raw.provider, `${label}.provider`),
    model: assertString(raw.model, `${label}.model`),
    limits: validateLimits(raw.limits, `${label}.limits`),
  };
  if (raw.profile !== undefined) worker.profile = validateProfileReference(raw.profile, `${label}.profile`);
  if (raw.skills !== undefined) worker.skills = validateStringArray(raw.skills, `${label}.skills`, 'SKILL.md');
  if (raw.instructions !== undefined) worker.instructions = validateStringArray(raw.instructions, `${label}.instructions`);
  if (raw.modelMetadata !== undefined) worker.modelMetadata = validateModelMetadata(raw.modelMetadata, `${label}.modelMetadata`);
  return worker;
}

// A profile is either a project-relative JSON path or a registry profile id.
export function validateProfileReference(value, label) {
  assertString(value, label);
  if (isProfileId(value)) return value;
  const profile = validatePathValue(value, label);
  if (!profile.toLowerCase().endsWith('.json')) throw tinyError('CONFIG_INVALID', `${label} must be a JSON path or a profile id`);
  return profile;
}

function validateWorkers(value, label) {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  const workers = {};
  for (const [name, worker] of Object.entries(value)) {
    assertSafeName(name, `${label} worker name`);
    workers[name] = validateWorker(worker, name, `${label}.${name}`);
  }
  return workers;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateSemanticThresholds(value, label) {
  assertPlainObject(value, 'CONFIG_INVALID', label);
  assertExactKeys(value, SEMANTIC_GATE_THRESHOLD_KEYS, 'CONFIG_INVALID', label);
  for (const key of SEMANTIC_GATE_THRESHOLD_KEYS) {
    const threshold = value[key];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw tinyError('CONFIG_INVALID', `${label}.${key} must be a number in (0,1)`);
    }
  }
  if (value.reject >= value.accept) {
    throw tinyError('CONFIG_INVALID', `${label}.reject must be less than ${label}.accept`);
  }
  return { accept: value.accept, reject: value.reject };
}

function validateSemanticGate(raw) {
  assertPlainObject(raw, 'CONFIG_INVALID', 'config.semanticGate');
  assertExactKeys(raw, SEMANTIC_GATE_KEYS, 'CONFIG_INVALID', 'config.semanticGate');
  if (!SEMANTIC_GATE_MODES.includes(raw.mode)) {
    throw tinyError('CONFIG_INVALID', 'config.semanticGate.mode must be off, shadow, or enforce');
  }
  const endpoint = raw.endpoint === undefined ? DEFAULT_SEMANTIC_GATE_ENDPOINT : assertString(raw.endpoint, 'config.semanticGate.endpoint');
  if (!isHttpUrl(endpoint)) throw tinyError('CONFIG_INVALID', 'config.semanticGate.endpoint must be an http(s) URL');
  const model = raw.model === undefined ? DEFAULT_SEMANTIC_GATE_MODEL : assertString(raw.model, 'config.semanticGate.model');
  const thresholds = raw.thresholds === undefined ? { ...DEFAULT_SEMANTIC_GATE_THRESHOLDS } : validateSemanticThresholds(raw.thresholds, 'config.semanticGate.thresholds');
  return { mode: raw.mode, endpoint, model, thresholds };
}

function validateQualification(raw, label = 'config.qualification') {
  assertPlainObject(raw, 'CONFIG_INVALID', label);
  assertExactKeys(raw, QUALIFICATION_KEYS, 'CONFIG_INVALID', label);
  const mode = raw.mode === undefined ? 'warn' : raw.mode;
  if (!QUALIFICATION_MODES.includes(mode)) throw tinyError('CONFIG_INVALID', `${label}.mode must be off, warn, or enforce`);
  return {
    mode,
    ...(raw.suite === undefined ? {} : { suite: validatePathValue(raw.suite, `${label}.suite`) }),
  };
}

export function validateConfigDocument(raw) {
  assertPlainObject(raw, 'CONFIG_INVALID', 'config');
  assertExactKeys(raw, ['schemaVersion', 'defaultWorker', 'workers', 'semanticGate', 'qualification', 'phaseGates', 'testReview', 'featureIntegration', 'workerTiers'], 'CONFIG_INVALID', 'config');
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw tinyError('CONFIG_INVALID', `config.schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  const workers = validateWorkers(raw.workers, 'config.workers');
  const defaultWorker = raw.defaultWorker === undefined ? undefined : assertSafeName(raw.defaultWorker, 'config.defaultWorker');
  if (defaultWorker !== undefined && !Object.hasOwn(workers, defaultWorker)) {
    throw tinyError('CONFIG_INVALID', `config.defaultWorker is not defined: ${defaultWorker}`);
  }
  const semanticGate = raw.semanticGate === undefined ? undefined : validateSemanticGate(raw.semanticGate);
  const qualification = raw.qualification === undefined ? undefined : validateQualification(raw.qualification);
  const phaseGates = raw.phaseGates === undefined ? undefined : validatePhasePolicy(raw.phaseGates);
  const testReview = raw.testReview === undefined ? undefined : validateTestReviewPolicy(raw.testReview);
  const featureIntegration = raw.featureIntegration === undefined ? undefined : validateFeatureIntegrationConfig(raw.featureIntegration);
  const workerTiers = raw.workerTiers === undefined ? undefined : validateWorkerTiers(raw.workerTiers, 'config.workerTiers');
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...(defaultWorker === undefined ? {} : { defaultWorker }),
    workers,
    ...(semanticGate === undefined ? {} : { semanticGate }),
    ...(qualification === undefined ? {} : { qualification }),
    ...(phaseGates === undefined ? {} : { phaseGates }),
    ...(testReview === undefined ? {} : { testReview }),
    ...(featureIntegration === undefined ? {} : { featureIntegration }),
    ...(workerTiers === undefined ? {} : { workerTiers }),
  };
}

// Worker names from fastest to strongest; a failed run suggests the next one.
function validateWorkerTiers(value, label) {
  if (!Array.isArray(value) || value.length < 2) throw tinyError('CONFIG_INVALID', `${label} must list at least two worker names`);
  const names = value.map((name, index) => assertSafeName(name, `${label}[${index}]`));
  if (new Set(names).size !== names.length) throw tinyError('CONFIG_INVALID', `${label} must not repeat a worker`);
  return names;
}

export function validateLocalDocument(raw) {
  assertPlainObject(raw, 'CONFIG_INVALID', 'config.local');
  assertExactKeys(raw, ['defaultWorker', 'workers', 'qualification', 'phaseGates', 'testReview', 'featureIntegration', 'workerTiers'], 'CONFIG_INVALID', 'config.local');
  const workers = raw.workers === undefined ? undefined : validateWorkers(raw.workers, 'config.local.workers');
  const defaultWorker = raw.defaultWorker === undefined ? undefined : assertSafeName(raw.defaultWorker, 'config.local.defaultWorker');
  const qualification = raw.qualification === undefined ? undefined : validateQualification(raw.qualification, 'config.local.qualification');
  const phaseGates = raw.phaseGates === undefined ? undefined : validatePhasePolicy(raw.phaseGates, 'config.local.phaseGates');
  const testReview = raw.testReview === undefined ? undefined : validateTestReviewPolicy(raw.testReview, 'config.local.testReview');
  const featureIntegration = raw.featureIntegration === undefined ? undefined : validateFeatureIntegrationConfig(raw.featureIntegration, 'config.local.featureIntegration');
  const workerTiers = raw.workerTiers === undefined ? undefined : validateWorkerTiers(raw.workerTiers, 'config.local.workerTiers');
  return {
    ...(defaultWorker === undefined ? {} : { defaultWorker }),
    ...(workers === undefined ? {} : { workers }),
    ...(qualification === undefined ? {} : { qualification }),
    ...(phaseGates === undefined ? {} : { phaseGates }),
    ...(testReview === undefined ? {} : { testReview }),
    ...(featureIntegration === undefined ? {} : { featureIntegration }),
    ...(workerTiers === undefined ? {} : { workerTiers }),
  };
}

export function validateProfileDocument(raw, path) {
  assertPlainObject(raw, 'PROFILE_INVALID', `profile ${path}`);
  assertExactKeys(raw, PROFILE_KEYS, 'PROFILE_INVALID', `profile ${path}`);
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) throw tinyError('PROFILE_INVALID', `profile ${path} schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  const profile = { schemaVersion: CONFIG_SCHEMA_VERSION, id: assertString(raw.id, `profile ${path}.id`) };
  if (raw.instructions !== undefined) profile.instructions = assertStringAllowEmpty(raw.instructions, `profile ${path}.instructions`);
  if (raw.runtime !== undefined) {
    assertPlainObject(raw.runtime, 'PROFILE_INVALID', `profile ${path}.runtime`);
    assertExactKeys(raw.runtime, RUNTIME_KEYS, 'PROFILE_INVALID', `profile ${path}.runtime`);
    const runtime = {};
    if (raw.runtime.thinking !== undefined) {
      if (!['off', 'minimal', 'low', 'medium', 'high'].includes(raw.runtime.thinking)) {
        throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.thinking is invalid`);
      }
      runtime.thinking = raw.runtime.thinking;
    }
    if (raw.runtime.reasoning !== undefined) {
      if (typeof raw.runtime.reasoning !== 'boolean') throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.reasoning must be boolean`);
      runtime.reasoning = raw.runtime.reasoning;
    }
    if (raw.runtime.compat !== undefined) {
      assertPlainObject(raw.runtime.compat, 'PROFILE_INVALID', `profile ${path}.runtime.compat`);
      assertExactKeys(raw.runtime.compat, COMPAT_KEYS, 'PROFILE_INVALID', `profile ${path}.runtime.compat`);
      const compat = {};
      if (raw.runtime.compat.thinkingFormat !== undefined) compat.thinkingFormat = assertString(raw.runtime.compat.thinkingFormat, `profile ${path}.runtime.compat.thinkingFormat`);
      if (raw.runtime.compat.supportsDeveloperRole !== undefined) {
        if (typeof raw.runtime.compat.supportsDeveloperRole !== 'boolean') throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.compat.supportsDeveloperRole must be boolean`);
        compat.supportsDeveloperRole = raw.runtime.compat.supportsDeveloperRole;
      }
      if (raw.runtime.compat.thinkingTokenBudgetField !== undefined) {
        compat.thinkingTokenBudgetField = assertString(raw.runtime.compat.thinkingTokenBudgetField, `profile ${path}.runtime.compat.thinkingTokenBudgetField`);
      }
      runtime.compat = compat;
    }
    if (raw.runtime.thinkingBudgets !== undefined) {
      // Per-level reasoning caps, written into the worker's temporary Pi
      // settings; Pi sends them only with compat.thinkingTokenBudgetField.
      assertPlainObject(raw.runtime.thinkingBudgets, 'PROFILE_INVALID', `profile ${path}.runtime.thinkingBudgets`);
      assertExactKeys(raw.runtime.thinkingBudgets, THINKING_BUDGET_KEYS, 'PROFILE_INVALID', `profile ${path}.runtime.thinkingBudgets`);
      for (const [level, tokens] of Object.entries(raw.runtime.thinkingBudgets)) {
        if (!Number.isInteger(tokens) || tokens <= 0) throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.thinkingBudgets.${level} must be a positive integer`);
      }
      runtime.thinkingBudgets = { ...raw.runtime.thinkingBudgets };
    }
    if (raw.runtime.compaction !== undefined) {
      assertPlainObject(raw.runtime.compaction, 'PROFILE_INVALID', `profile ${path}.runtime.compaction`);
      assertExactKeys(raw.runtime.compaction, COMPACTION_KEYS, 'PROFILE_INVALID', `profile ${path}.runtime.compaction`);
      const enabled = raw.runtime.compaction.enabled === undefined ? false : raw.runtime.compaction.enabled;
      if (typeof enabled !== 'boolean') throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.compaction.enabled must be boolean`);
      const compaction = { enabled };
      for (const key of ['reserveTokens', 'keepRecentTokens']) {
        const value = raw.runtime.compaction[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) throw tinyError('PROFILE_INVALID', `profile ${path}.runtime.compaction.${key} must be a nonnegative safe integer`);
        compaction[key] = value;
      }
      runtime.compaction = compaction;
    }
    profile.runtime = runtime;
  }
  for (const key of ['evidence', 'limitations']) {
    if (raw[key] !== undefined) {
      if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== 'string')) {
        throw tinyError('PROFILE_INVALID', `profile ${path}.${key} must be an array of strings`);
      }
      profile[key] = [...raw[key]];
    }
  }
  return { ...profile, ...validateRegistryFields(raw, `profile ${path}`) };
}

async function sourceInfo(absolutePath, relativePath, exists) {
  if (!exists) return { path: relativePath, exists: false };
  const content = await readFile(absolutePath);
  return { path: relativePath, exists: true, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

export async function loadProfile(projectRoot, reference) {
  if (isProfileId(reference)) {
    const found = await findProfileById(projectRoot, reference);
    return { data: validateProfileDocument(found.value, found.path), source: { id: reference, location: found.location, path: found.path } };
  }
  const raw = await readProjectFile(projectRoot, reference);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw tinyError('PROFILE_INVALID', `malformed profile JSON: ${reference}`);
    throw error;
  }
  return { data: validateProfileDocument(parsed, reference), source: { location: 'project', path: reference } };
}

async function validateReferencedPaths(projectRoot, workers, explicitLimits = {}) {
  for (const [name, worker] of Object.entries(workers)) {
    if (worker.profile !== undefined) {
      const loaded = await loadProfile(projectRoot, worker.profile);
      worker.profileData = loaded.data;
      worker.profileSource = loaded.source;
      if (loaded.data.limits) {
        worker.limits = applyProfileLimits(worker.limits, loaded.data.limits, explicitLimits[name] ?? [], { worker: name, profile: loaded.data.id });
      }
    }
    for (const skill of worker.skills ?? []) {
      await readProjectFile(projectRoot, skill);
    }
    for (const instruction of worker.instructions ?? []) {
      await readProjectFile(projectRoot, instruction);
    }
  }
  return workers;
}

function explicitLimitKeys(document) {
  const workers = document?.workers;
  if (!workers || typeof workers !== 'object') return {};
  return Object.fromEntries(Object.entries(workers).map(([name, worker]) => [
    name,
    worker?.limits && typeof worker.limits === 'object' ? Object.keys(worker.limits) : [],
  ]));
}

export function defaultConfig() {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, workers: {} };
}

export async function resolveConfig(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const tinysdd = await assertInternalPath(root, ['.tinysdd'], { allowMissing: false, requireDirectory: true });
  const configRelative = '.tinysdd/config.json';
  const localRelative = '.tinysdd/config.local.json';
  const configPath = join(tinysdd, 'config.json');
  const localPath = join(tinysdd, 'config.local.json');
  const configFile = await readJsonFile(configPath, { code: 'CONFIG_MALFORMED' });
  if (!configFile) throw tinyError('CONFIG_MISSING', 'missing .tinysdd/config.json');
  const base = validateConfigDocument(configFile.value);
  const localFile = await readJsonFile(localPath, { code: 'CONFIG_LOCAL_MALFORMED' });
  const local = localFile ? validateLocalDocument(localFile.value) : {};
  const workers = Object.assign(Object.create(null), base.workers);
  const workerSources = Object.fromEntries(Object.keys(base.workers).map((name) => [name, 'config.json']));
  for (const [name, worker] of Object.entries(local.workers ?? {})) {
    workers[name] = worker;
    workerSources[name] = 'config.local.json';
  }
  const defaultWorker = local.defaultWorker ?? base.defaultWorker;
  if (defaultWorker !== undefined && !Object.hasOwn(workers, defaultWorker)) {
    throw tinyError('CONFIG_INVALID', `default worker is not defined: ${defaultWorker}`);
  }
  const workerTiers = local.workerTiers ?? base.workerTiers;
  for (const name of workerTiers ?? []) {
    if (!Object.hasOwn(workers, name)) throw tinyError('CONFIG_INVALID', `workerTiers names an undefined worker: ${name}`);
  }
  const selectedName = options.workerName ?? options.worker;
  if (selectedName !== undefined) {
    assertSafeName(selectedName, 'worker');
    if (!Object.hasOwn(workers, selectedName)) throw tinyError('WORKER_NOT_FOUND', `unknown worker: ${selectedName}`);
  }
  const selectedWorkerName = selectedName ?? defaultWorker;
  if (options.profile !== undefined) {
    if (selectedWorkerName === undefined) throw tinyError('WORKER_NOT_SELECTED', '--profile needs a selected worker; configure defaultWorker or pass --worker');
    workers[selectedWorkerName] = { ...workers[selectedWorkerName], profile: validateProfileReference(options.profile, '--profile') };
  }
  const explicitLimits = { ...explicitLimitKeys(configFile.value), ...explicitLimitKeys(localFile?.value) };
  const effectiveWorkers = await validateReferencedPaths(root, workers, explicitLimits);
  const effective = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...(defaultWorker === undefined ? {} : { defaultWorker }),
    ...(base.semanticGate === undefined ? {} : { semanticGate: base.semanticGate }),
    ...(local.qualification === undefined && base.qualification === undefined ? {} : { qualification: local.qualification ?? base.qualification }),
    ...(local.phaseGates === undefined && base.phaseGates === undefined ? {} : { phaseGates: local.phaseGates ?? base.phaseGates }),
    ...(local.testReview === undefined && base.testReview === undefined ? {} : { testReview: local.testReview ?? base.testReview }),
    ...(local.featureIntegration === undefined && base.featureIntegration === undefined ? {} : { featureIntegration: local.featureIntegration ?? base.featureIntegration }),
    ...(workerTiers === undefined ? {} : { workerTiers: [...workerTiers] }),
    workers: effectiveWorkers,
  };
  const selectedWorker = selectedWorkerName === undefined ? undefined : effectiveWorkers[selectedWorkerName];
  const provenance = {
    config: await sourceInfo(configPath, configRelative, true),
    local: await sourceInfo(localPath, localRelative, Boolean(localFile)),
    defaultWorker: {
      value: defaultWorker,
      source: local.defaultWorker === undefined ? 'config.json' : 'config.local.json',
    },
    workers: Object.fromEntries(Object.keys(effectiveWorkers).map((name) => [name, {
      source: workerSources[name] ?? 'config.local.json',
      ...(effectiveWorkers[name].profileSource ? {
        profile: { ...effectiveWorkers[name].profileSource, selectedBy: name === selectedWorkerName && options.profile !== undefined ? 'argument' : 'config' },
      } : {}),
    }])),
  };
  const publicWorkers = Object.fromEntries(Object.entries(effectiveWorkers).map(([name, worker]) => {
    const copy = { ...worker };
    delete copy.profileData;
    delete copy.profileSource;
    return [name, copy];
  }));
  const selectedPublic = selectedWorker ? { ...selectedWorker } : undefined;
  if (selectedPublic) {
    delete selectedPublic.profileData;
    delete selectedPublic.profileSource;
  }
  return {
    projectRoot: root,
    configPath,
    localConfigPath: localPath,
    config: { ...effective, workers: publicWorkers },
    provenance,
    workerName: selectedWorkerName,
    worker: selectedPublic,
    profile: selectedWorker?.profileData,
  };
}

export async function validateEffectiveConfig(projectRoot, options = {}) {
  return resolveConfig(projectRoot, options);
}

export async function ensureConfigPaths(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const tinysdd = await assertInternalPath(root, ['.tinysdd'], { allowMissing: true });
  return {
    projectRoot: root,
    tinysddPath: tinysdd,
    configPath: join(tinysdd, 'config.json'),
    localConfigPath: join(tinysdd, 'config.local.json'),
  };
}
