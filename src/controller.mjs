import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import {
  assertInternalPath,
  assertPlainObject,
  atomicWriteFile,
  atomicWriteJson,
  canonicalProjectRoot,
  digestJson,
  digestProjectFile,
  ensureDirectory,
  normalizeProjectRelative,
  publicError,
  readJsonFile,
  readProjectFile,
  resolveProjectPath,
  sha256,
  snapshotProjectFiles,
  stableStringify,
  TinySDDError,
  tinyError,
  withExclusiveLock,
} from './fs-utils.mjs';
import {
  defaultConfig,
  resolveConfig,
  validateConfigDocument,
} from './config.mjs';
import { compileContext, contextSizeMetrics } from './context-compiler.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import {
  extractAcceptanceCriteria,
  extractEvidenceChecks,
  judgeEvidenceSufficiency,
} from './jev.mjs';
import {
  aggregateGateOutcome,
  appendDecisionRecords,
  buildDecisionRecord,
  computeBand,
  JUDGE_UNAVAILABLE_ACTION,
  SHADOW_POLICY_ACTION,
} from './semantic-policy.mjs';
import {
  appendFeatureEvent,
  createFeatureAcceptanceEvent,
  readFeatureEvents,
} from './feature-events.mjs';
import {
  FEATURE_INTEGRATION_TEST_ENV,
  featureIntegrationFreshness,
  runFeatureIntegration,
} from './feature-integration.mjs';
import { withUsageLedgerLock } from './usage.mjs';
import { buildUsageReport } from './usage-report.mjs';
import { assessQualification } from './qualification-dispatch.mjs';
import { readQualificationRecord } from './qualification-store.mjs';
import {
  advancePhase as advancePhaseGate,
  phaseStatus as phaseStatusGate,
  recordResearchDecision,
} from './phase-gates.mjs';
import { DEFAULT_RUNTIME_SCOPE, classifyFileScopeChange, detectFilesystemAliases, pathsOverlap, preparationPaths, observedPathError } from './file-scope.mjs';

export { resolveConfig } from './config.mjs';

export const CONTROLLER_SCHEMA_VERSION = 1;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TASKS_PREFIX = '.tinysdd/tasks/';
const REVIEWS_PREFIX = '.tinysdd/reviews/';
const RUN_ID_PATTERN = /^worker-[0-9A-Za-z-]+$/;
const MAX_APPLY_LINEAGE = 32;
const MAX_RUN_SNAPSHOT_ENTRIES = 20_000;
const MAX_RUN_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const APPLY_CHANGES = ['created', 'modified', 'deleted'];
const APPLY_STATUSES = ['written', 'already-applied'];

function normalizeTaskBrief(value, field) {
  return normalizeProjectRelative(value, field, { tinysddArtifactPrefix: TASKS_PREFIX });
}

function normalizeReviewEvidence(value, field) {
  return normalizeProjectRelative(value, field, { tinysddArtifactPrefix: REVIEWS_PREFIX });
}

function normalizeTaskContext(value, field) {
  const path = normalizeProjectRelative(value, field, { tinysddArtifactPrefix: TASKS_PREFIX });
  if (!path.toLowerCase().endsWith('.json')) throw tinyError('INVALID_CONTEXT', 'context manifest must be a JSON file');
  return path;
}

function normalizeTaskChecks(value, field) {
  const path = normalizeProjectRelative(value, field, { tinysddArtifactPrefix: TASKS_PREFIX });
  if (!path.toLowerCase().endsWith('.json')) throw tinyError('INVALID_CHECKS', 'checks manifest must be a JSON file');
  return path;
}

function normalizeTaskPaths(value, label, { required = false } = {}) {
  if (value !== undefined && !Array.isArray(value) && typeof value !== 'string') {
    throw tinyError('INVALID_ARGUMENT', `${label} must be a string or array of strings`);
  }
  const values = Array.isArray(value) ? value : String(value ?? '').split(',').filter(Boolean);
  if (required && values.length === 0) throw tinyError('INVALID_ARGUMENT', `at least one --${label} path is required`);
  return [...new Set(values.map((path) => {
    if (typeof path !== 'string') throw tinyError('INVALID_ARGUMENT', `${label} paths must contain only strings`);
    return normalizeProjectRelative(path.trim(), `${label} path`);
  }))].sort();
}

function normalizePreparation(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) && typeof value !== 'string') throw tinyError('INVALID_ARGUMENT', 'preparation must be a string or array of paths');
  const values = Array.isArray(value) ? value : String(value).split(',').filter(Boolean);
  const seen = new Set();
  const result = values.map((entry) => {
    if (typeof entry === 'string') entry = { path: entry };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string') throw tinyError('INVALID_ARGUMENT', 'preparation entries must contain a path');
    const path = normalizeProjectRelative(entry.path.trim(), 'preparation path');
    if (seen.has(path)) throw tinyError('INVALID_ARGUMENT', `preparation contains duplicate path: ${path}`);
    seen.add(path);
    if (entry.exists !== undefined && typeof entry.exists !== 'boolean') throw tinyError('INVALID_ARGUMENT', 'preparation.exists must be boolean');
    if (entry.bytes !== undefined && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw tinyError('INVALID_ARGUMENT', 'preparation.bytes must be a nonnegative safe integer');
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256))) throw tinyError('INVALID_ARGUMENT', 'preparation.sha256 must be a digest');
    return { path, ...(entry.exists === undefined ? {} : { exists: entry.exists }), ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }), ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }) };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeTaskShape(options) {
  const brief = normalizeTaskBrief(requireText(options.brief, 'brief'), 'brief');
  if (!brief.toLowerCase().endsWith('.md')) throw tinyError('INVALID_BRIEF', 'brief must be a Markdown file');
  const context = options.context === undefined ? undefined : normalizeTaskContext(requireText(options.context, 'context'), 'context');
  const checks = options.checks === undefined ? undefined : normalizeTaskChecks(requireText(options.checks, 'checks'), 'checks');
  const dependsOn = parseIds(options.dependsOn);
  const allow = normalizeTaskPaths(options.allow, 'allow', { required: true });
  const protect = normalizeTaskPaths(options.protect, 'protect');
  const preparation = normalizePreparation(options.preparation);
  assertProtectAllowDisjoint(allow, protect);
  return {
    brief,
    ...(context === undefined ? {} : { context }),
    ...(checks === undefined ? {} : { checks }),
    dependsOn,
    allow,
    ...(protect.length > 0 ? { protect } : {}),
    ...(preparation === undefined || preparation.length === 0 ? {} : { preparation }),
  };
}

const TASK_SHAPE_FIELDS = ['brief', 'context', 'checks', 'allow', 'protect', 'preparation', 'dependsOn'];

function taskShape(task) {
  return structuredClone(Object.fromEntries(TASK_SHAPE_FIELDS.filter((field) => task[field] !== undefined).map((field) => [field, task[field]])));
}

function candidatePathsForTask(task) {
  return [...new Set([
    ...task.allow,
    ...(task.applied?.actualPaths ?? []),
    ...(task.review?.candidatePaths ?? []),
  ])].sort();
}

function assertProtectAllowDisjoint(allow, protect) {
  const paths = protect.filter((path) => allow.includes(path));
  if (paths.length > 0) throw tinyError('PROTECT_ALLOW_OVERLAP', `protected paths overlap allowed paths: ${paths.join(', ')}`, { paths });
}

async function validateTaskInputs(root, task, { refreshPreparation = false } = {}) {
  await readProjectFile(root, task.brief, taskBriefOptions());
  // Validate the manifest schema, source ranges and budget before recording it.
  const compiled = task.context === undefined ? null : await compileTaskContext(root, task.context);
  if (task.checks !== undefined) {
    parseChecksManifest(await readProjectFile(root, task.checks, taskBriefOptions()));
  }
  assertProtectAllowDisjoint(task.allow, task.protect ?? []);
  for (const [label, paths] of [['allowed', task.allow], ['protected', task.protect ?? []]]) {
    for (const path of paths) {
      const absolute = await assertInternalPath(root, path.split('/'), { allowMissing: true });
      try {
        const info = await lstat(absolute);
        if (!info.isFile()) throw tinyError('INVALID_FILE', `${label} path must be a regular file: ${path}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (label === 'protected') throw tinyError('PROTECT_MISSING', `protected file is missing: ${path}`);
      }
    }
  }
  const preparation = [];
  for (const entry of task.preparation ?? []) {
    const absolute = (await resolveProjectPath(root, entry.path, { allowMissing: true })).absolutePath;
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!info) {
      if (entry.exists === true) throw tinyError('PREPARATION_MISSING', `preparation file is missing: ${entry.path}`);
      preparation.push({ path: entry.path, exists: false });
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw tinyError('INVALID_FILE', `preparation path must be a regular file: ${entry.path}`);
    const content = await readFile(absolute);
    const actual = { path: entry.path, exists: true, bytes: content.byteLength, sha256: sha256(content) };
    if (!refreshPreparation && (entry.exists === false || entry.sha256 !== undefined && entry.sha256 !== actual.sha256 || entry.bytes !== undefined && entry.bytes !== actual.bytes)) {
      throw tinyError('PREPARATION_STALE', `preparation identity changed: ${entry.path}`, { path: entry.path, expected: entry, actual });
    }
    preparation.push(actual);
  }
  return { compiled, preparation };
}

async function preparationFilesDigest(root, preparation) {
  if (!preparation || preparation.length === 0) return null;
  const records = [];
  for (const entry of preparation) {
    const absolute = (await resolveProjectPath(root, entry.path, { allowMissing: true })).absolutePath;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw tinyError('INVALID_FILE', `preparation path must be a regular file: ${entry.path}`);
      const content = await readFile(absolute);
      records.push({ path: entry.path, exists: true, bytes: content.byteLength, sha256: sha256(content) });
    } catch (caught) {
      if (caught?.code === 'ENOENT') records.push({ path: entry.path, exists: false });
      else throw caught;
    }
  }
  return digestJson(records);
}

async function protectedFilesDigest(root, protect) {
  if (!protect) return null;
  const snapshot = await snapshotProjectFiles(root, protect);
  const paths = snapshot.filter((item) => !item.exists).map((item) => item.path);
  if (paths.length > 0) throw tinyError('PROTECT_MISSING', `protected files are missing: ${paths.join(', ')}`, { paths });
  return digestJson(snapshot);
}

function taskBriefOptions() {
  return { tinysddArtifactPrefix: TASKS_PREFIX };
}

function reviewEvidenceOptions() {
  return { tinysddArtifactPrefix: REVIEWS_PREFIX };
}

async function compileTaskContext(projectRoot, path, options) {
  const text = await readProjectFile(projectRoot, path, taskBriefOptions());
  return compileContext(projectRoot, { path, text, sha256: sha256(text) }, options);
}

// The approval bound the context the worker started from, but an apply moves the
// files it writes to the candidate. Only those paths are displaced: while the
// apply is recorded they are read from the lineage root's workspace-before, which
// is what the project held there (the drift check requires it). Every other cited
// file, including allowed files the lineage never changed and already-applied
// paths, is read from the project, so the approval keeps binding its current text.
// A missing run artifact fails closed (stale).
function pinnedPaths(entries) {
  return new Set(entries.filter((entry) => entry.status === 'written').map((entry) => entry.path));
}

function compilePinnedContext(root, task, rootRunId, pinned) {
  if (pinned.size === 0) return compileTaskContext(root, task.context);
  const readSource = async (path) => {
    if (!pinned.has(path)) return readProjectFile(root, path);
    const start = await readRunFile(root, rootRunId, 'workspace-before', path);
    if (start === null) throw tinyError('RUN_NOT_FOUND', `run ${rootRunId} no longer holds ${path}`, { runId: rootRunId });
    return start.bytes.toString('utf8');
  };
  return compileTaskContext(root, task.context, { readSource });
}

function compileApprovedContext(root, task) {
  if (!task.applied) return compileTaskContext(root, task.context);
  return compilePinnedContext(root, task, task.applied.rootRunId, pinnedPaths(task.applied.files));
}

// Provisional advisory thresholds from one observed failure (talon
// broker-contract: 8 files, 43 KB context, 64 tests, zero worker writes).
// They warn; they never block registration or approval.
export const TASK_SIZE_THRESHOLDS = Object.freeze({ allowedFiles: 3, compiledContextBytes: 40 * 1024, citedTestLines: 300 });
// Provisional and uncalibrated; tune on the talon reruns.
export const BEHAVIOR_SPLIT_THRESHOLDS = Object.freeze({ citedOrderingAssertions: 8 });
function taskSizing(allow, compiled) {
  const metrics = { allowedFiles: allow.length, ...contextSizeMetrics(compiled) };
  const warnings = Object.entries(TASK_SIZE_THRESHOLDS)
    .filter(([key, limit]) => metrics[key] > limit)
    .map(([key, limit]) => `${key} ${metrics[key]} exceeds the advisory limit ${limit}; consider splitting the task`);
  const reasons = [];
  if (metrics.citedFakeTimers > 0 && (metrics.citedDeferredPromises > 0 || metrics.citedConcurrencyMarkers > 0)) {
    reasons.push('fake timers with deferred promises or concurrency markers');
  }
  if (metrics.citedOrderingAssertions >= BEHAVIOR_SPLIT_THRESHOLDS.citedOrderingAssertions) {
    reasons.push(`citedOrderingAssertions ${metrics.citedOrderingAssertions} meets the advisory limit ${BEHAVIOR_SPLIT_THRESHOLDS.citedOrderingAssertions}`);
  }
  const recommended = reasons.length > 0;
  if (recommended) warnings.push(`behavior split recommended (${reasons.join('; ')}): separate the sequential core from the async edge, each with its own test file; fewer files alone will not help`);
  return { ...metrics, behaviorSplit: { recommended, reasons }, thresholds: { ...TASK_SIZE_THRESHOLDS, ...BEHAVIOR_SPLIT_THRESHOLDS }, warnings };
}

function nowIso() {
  return new Date().toISOString();
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw tinyError('INVALID_ARGUMENT', `${label} must be nonempty`);
  return value;
}

function validateTaskId(value) {
  requireText(value, 'task id');
  if (!TASK_ID_PATTERN.test(value)) throw tinyError('INVALID_TASK_ID', 'task id must use lowercase letters, digits, hyphens, or underscores');
  return value;
}

function validateFeature(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || !TASK_ID_PATTERN.test(value)) {
    throw tinyError('INVALID_FEATURE', 'feature must use lowercase letters, digits, hyphens, or underscores');
  }
  return value;
}

function parseIds(value, label = 'depends-on') {
  if (value === undefined || value === '') return [];
  if (!Array.isArray(value) && typeof value !== 'string') throw tinyError('INVALID_ARGUMENT', `${label} must be a string or array of strings`);
  const values = Array.isArray(value) ? value : String(value).split(',');
  const result = [];
  for (const item of values) {
    if (typeof item !== 'string') throw tinyError('INVALID_ARGUMENT', `${label} must contain only strings`);
    const id = validateTaskId(item.trim());
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

async function layout(projectRoot, { create = false } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const tinysdd = await assertInternalPath(root, ['.tinysdd'], { allowMissing: true });
  const runs = join(tinysdd, 'runs');
  if (create) {
    await ensureDirectory(tinysdd);
    await ensureDirectory(runs);
  } else {
    let tinysddExists = false;
    try {
      const info = await lstat(tinysdd);
      tinysddExists = true;
      if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', 'refusing symlinked .tinysdd directory');
      if (!info.isDirectory()) throw tinyError('INVALID_INTERNAL_PATH', '.tinysdd must be a directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (tinysddExists) await assertInternalPath(root, ['.tinysdd', 'runs'], { allowMissing: true });
  }
  return {
    projectRoot: root,
    tinysdd,
    runs,
    state: join(runs, 'controller.json'),
    lock: join(runs, 'controller.lock'),
    config: join(tinysdd, 'config.json'),
    localConfig: join(tinysdd, 'config.local.json'),
    gitignore: join(tinysdd, '.gitignore'),
  };
}

function emptyState() {
  return { schemaVersion: CONTROLLER_SCHEMA_VERSION, tasks: {}, updatedAt: nowIso() };
}

const CLOSURE_KINDS = ['closed', 'superseded'];
// Statuses with nothing left to do, so `next` skips them.
const SETTLED_STATUSES = ['accepted', ...CLOSURE_KINDS];

function validateClosure(id, closure) {
  const label = `task ${id} closure`;
  assertPlainObject(closure, 'STATE_MALFORMED', label);
  if (!CLOSURE_KINDS.includes(closure.kind)) throw tinyError('STATE_MALFORMED', `${label} kind must be closed or superseded`);
  for (const field of ['by', 'reason', 'closedAt']) {
    if (typeof closure[field] !== 'string' || closure[field].trim().length === 0) throw tinyError('STATE_MALFORMED', `${label} ${field} must be a nonempty string`);
  }
  if (closure.kind === 'closed') {
    if (closure.supersededBy !== undefined) throw tinyError('STATE_MALFORMED', `${label} supersededBy is only valid for a superseded task`);
    return;
  }
  if (!Array.isArray(closure.supersededBy) || closure.supersededBy.length === 0) throw tinyError('STATE_MALFORMED', `${label} supersededBy must be a nonempty array`);
  try {
    for (const successor of closure.supersededBy) validateTaskId(successor);
  } catch {
    throw tinyError('STATE_MALFORMED', `${label} supersededBy contains an invalid task id`);
  }
}

function validateApplied(id, applied) {
  const label = `task ${id} applied`;
  assertPlainObject(applied, 'STATE_MALFORMED', label);
  for (const field of ['runId', 'rootRunId']) {
    if (typeof applied[field] !== 'string' || !RUN_ID_PATTERN.test(applied[field])) throw tinyError('STATE_MALFORMED', `${label} ${field} must be a worker run id`);
  }
  for (const field of ['by', 'appliedAt']) {
    if (typeof applied[field] !== 'string' || applied[field].trim().length === 0) throw tinyError('STATE_MALFORMED', `${label} ${field} must be a nonempty string`);
  }
  if (applied.allowedDigest !== undefined && (typeof applied.allowedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(applied.allowedDigest))) {
    throw tinyError('STATE_MALFORMED', `${label} allowedDigest must be a digest`);
  }
  if (applied.actualDigest !== undefined && (typeof applied.actualDigest !== 'string' || !/^[0-9a-f]{64}$/.test(applied.actualDigest))) {
    throw tinyError('STATE_MALFORMED', `${label} actualDigest must be a digest`);
  }
  if (applied.actualPaths !== undefined && (!Array.isArray(applied.actualPaths) || applied.actualPaths.some((path) => typeof path !== 'string'))) {
    throw tinyError('STATE_MALFORMED', `${label} actualPaths must be an array of paths`);
  }
  if (applied.actualPaths !== undefined) {
    const normalized = applied.actualPaths.map((path) => normalizeProjectRelative(path, `${label} actual path`));
    if (normalized.some((path, index) => path !== applied.actualPaths[index]) || new Set(normalized).size !== normalized.length) throw tinyError('STATE_MALFORMED', `${label} actualPaths must be canonical and unique`);
  }
  if (!Array.isArray(applied.files)) throw tinyError('STATE_MALFORMED', `${label} files must be an array`);
  for (const file of applied.files) {
    assertPlainObject(file, 'STATE_MALFORMED', `${label} file`);
    try {
      normalizeProjectRelative(file.path, `${label} file path`);
    } catch {
      throw tinyError('STATE_MALFORMED', `${label} file path is invalid`);
    }
    if (!APPLY_CHANGES.includes(file.change)) throw tinyError('STATE_MALFORMED', `${label} file change must be created, modified or deleted`);
    if (!APPLY_STATUSES.includes(file.status)) throw tinyError('STATE_MALFORMED', `${label} file status must be written or already-applied`);
    const digestOk = file.change === 'deleted' ? file.sha256 === null : typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256);
    if (!digestOk) throw tinyError('STATE_MALFORMED', `${label} file sha256 must be a digest, or null for a deletion`);
  }
}

function closureLabel(task) {
  return task.closure.kind === 'superseded' ? `superseded by ${task.closure.supersededBy.join(', ')}` : 'closed';
}

function publicClosure(closure) {
  const { kind, by, reason, closedAt, supersededBy } = closure;
  return { kind, by, reason, closedAt, ...(supersededBy ? { supersededBy: [...supersededBy] } : {}) };
}

// A retired task takes no further approval, review or dispatch.
function assertOpen(task) {
  if (task.closure) throw tinyError('TASK_CLOSED', `task ${task.id} is ${closureLabel(task)}`, publicClosure(task.closure));
}

function validateTaskShape(id, task) {
  assertPlainObject(task, 'STATE_MALFORMED', `task ${id} shape`);
  if (typeof task.brief !== 'string' || !Array.isArray(task.dependsOn) || !Array.isArray(task.allow) || (task.context !== undefined && typeof task.context !== 'string') || (task.checks !== undefined && typeof task.checks !== 'string')) {
    throw tinyError('STATE_MALFORMED', `task ${id} has invalid shape fields`);
  }
  if (task.feature !== undefined) {
    try {
      validateFeature(task.feature);
    } catch {
      throw tinyError('STATE_MALFORMED', `task ${id} has an invalid feature`);
    }
  }
  try {
    if (task.protect !== undefined && (!Array.isArray(task.protect) || task.protect.length === 0)) throw new Error('protect must be nonempty');
    normalizeTaskShape(task);
    for (const dependency of task.dependsOn) validateTaskId(dependency);
    for (const path of [...task.allow, ...(task.protect ?? [])]) normalizeProjectRelative(path, `task ${id} path`);
    if (task.preparation !== undefined) {
      if (!Array.isArray(task.preparation)) throw new Error('preparation must be an array');
      for (const entry of task.preparation) {
        if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw new Error('preparation entry must contain a path');
        normalizeProjectRelative(entry.path, `task ${id} preparation path`);
        if (entry.exists !== undefined && typeof entry.exists !== 'boolean') throw new Error('preparation exists must be boolean');
        if (entry.bytes !== undefined && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw new Error('preparation bytes must be nonnegative');
        if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256))) throw new Error('preparation sha256 must be a digest');
      }
    }
    if (task.review?.candidatePaths !== undefined) {
      if (!Array.isArray(task.review.candidatePaths) || task.review.candidatePaths.some((path) => typeof path !== 'string')) throw new Error('review candidatePaths must be an array');
      const normalized = task.review.candidatePaths.map((path) => {
        const clean = normalizeProjectRelative(path, `task ${id} candidate path`);
        if (clean !== path) throw new Error('review candidate path is not canonical');
        return clean;
      });
      if (new Set(normalized).size !== normalized.length) throw new Error('review candidatePaths must be unique');
    }
    for (const field of ['candidateDigest', 'allowedDigest']) {
      if (task.review?.[field] !== undefined && (typeof task.review[field] !== 'string' || !/^[0-9a-f]{64}$/.test(task.review[field]))) throw new Error(`review ${field} must be a digest`);
    }
  } catch {
    throw tinyError('STATE_MALFORMED', `task ${id} contains an invalid path or dependency`);
  }
}

function validateRevisions(id, revisions) {
  if (!Array.isArray(revisions)) throw tinyError('STATE_MALFORMED', `task ${id} revisions must be an array`);
  for (const revision of revisions) {
    assertPlainObject(revision, 'STATE_MALFORMED', `task ${id} revision`);
    for (const field of ['revisedAt', 'by', 'reason']) {
      if (typeof revision[field] !== 'string' || revision[field].trim().length === 0) throw tinyError('STATE_MALFORMED', `task ${id} revision ${field} must be a nonempty string`);
    }
    validateTaskShape(id, revision.previous);
    if (revision.previous.applied !== undefined) validateApplied(id, revision.previous.applied);
  }
}

function validateState(value) {
  assertPlainObject(value, 'STATE_MALFORMED', 'controller state');
  if (value.schemaVersion !== CONTROLLER_SCHEMA_VERSION) throw tinyError('STATE_MALFORMED', `controller state schemaVersion must be ${CONTROLLER_SCHEMA_VERSION}`);
  if (value.tasks === null || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) {
    throw tinyError('STATE_MALFORMED', 'controller state tasks must be an object');
  }
  for (const [id, task] of Object.entries(value.tasks)) {
    try {
      validateTaskId(id);
    } catch {
      throw tinyError('STATE_MALFORMED', `task id is invalid: ${id}`);
    }
    assertPlainObject(task, 'STATE_MALFORMED', `task ${id}`);
    if (task.id !== id) throw tinyError('STATE_MALFORMED', `task ${id} has an invalid id`);
    validateTaskShape(id, task);
    if (task.revisions !== undefined) validateRevisions(id, task.revisions);
    if (task.closure !== undefined) validateClosure(id, task.closure);
    if (task.applied !== undefined) validateApplied(id, task.applied);
    if (task.review?.candidatePaths !== undefined && task.applied?.actualPaths !== undefined) {
      const missing = task.applied.actualPaths.filter((path) => !task.review.candidatePaths.includes(path));
      if (missing.length > 0) throw tinyError('STATE_MALFORMED', `task ${id} review candidatePaths omit applied paths: ${missing.join(', ')}`);
    }
  }
  return value;
}

export function topologicalOrder(tasks) {
  const ids = Object.keys(tasks);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const [id, task] of Object.entries(tasks)) {
    for (const dependency of task.dependsOn) {
      if (!indegree.has(dependency)) throw tinyError('STATE_MALFORMED', `missing dependency task: ${dependency}`);
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dependency).push(id);
    }
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== ids.length) throw tinyError('STATE_MALFORMED', 'controller task graph contains a dependency cycle');
  return order;
}

async function readState(layoutInfo) {
  const file = await readJsonFile(layoutInfo.state, { code: 'STATE_MALFORMED' });
  if (!file) return emptyState();
  return validateState(file.value);
}

async function mutateState(projectRoot, callback) {
  const info = await layout(projectRoot, { create: true });
  return withExclusiveLock(info.lock, async () => {
    const state = await readState(info);
    const result = await callback(state, info);
    validateState(state);
    state.updatedAt = nowIso();
    await atomicWriteJson(info.state, state);
    return result;
  });
}

// Approvals recorded before the compiled text dropped its whole-file source
// digests hold the legacy digest; they stay fresh and keep binding the whole file.
function contextDigestMatches(approved, current, legacy) {
  return approved === current || (legacy !== undefined && approved === legacy);
}

function approvalBindsTaskShape(approval, task) {
  return Boolean(
    approval
      && stableStringify(approval.dependsOn) === stableStringify(task.dependsOn)
      && stableStringify(approval.allow) === stableStringify(task.allow)
      && (approval.context ?? null) === (task.context ?? null)
      && (approval.checks ?? null) === (task.checks ?? null)
      && stableStringify(approval.protect ?? null) === stableStringify(task.protect ?? null)
      && stableStringify(approval.preparation ?? null) === stableStringify(task.preparation ?? null),
  );
}

async function inspectTask(projectRoot, state, task, seen = new Set()) {
  if (seen.has(task.id)) throw tinyError('STATE_MALFORMED', `dependency cycle reaches ${task.id}`);
  const nextSeen = new Set(seen).add(task.id);
  // Keep recursive inspection explicit rather than relying on mutable status.
  const originalTasks = state.tasks;
  const dependencyStates = [];
  for (const dependency of task.dependsOn) {
    const dependencyTask = originalTasks[dependency];
    if (!Object.hasOwn(originalTasks, dependency)) throw tinyError('STATE_MALFORMED', `missing dependency task: ${dependency}`);
    dependencyStates.push(await inspectTask(projectRoot, state, dependencyTask, nextSeen));
  }
  const briefDigest = await digestProjectFile(projectRoot, task.brief, taskBriefOptions()).catch(() => undefined);
  const compiledContext = task.context
    ? await compileApprovedContext(projectRoot, task).catch(() => undefined)
    : null;
  const contextDigest = compiledContext === null ? null : compiledContext?.sha256;
  const checksDigest = task.checks
    ? await readProjectFile(projectRoot, task.checks, taskBriefOptions()).then((text) => sha256(text)).catch(() => undefined)
    : null;
  const preparationDigest = await preparationFilesDigest(projectRoot, task.preparation).catch(() => undefined);
  const protectDigest = await protectedFilesDigest(projectRoot, task.protect).catch(() => undefined);
  const dependencyAcceptances = Object.fromEntries(dependencyStates.filter((item) => item.acceptanceDigest).map((item) => [item.id, item.acceptanceDigest]));
  const approval = task.approval;
  const blockedAfterApproval = task.review?.verdict === 'blocked'
    && task.review.approvalDigest === approval?.approvalDigest;
  const shapeBindsApproval = approvalBindsTaskShape(approval, task);
  const approvalFresh = Boolean(
    approval
      && briefDigest
      && approval.briefDigest === briefDigest
      && contextDigestMatches(approval.contextDigest ?? null, contextDigest, compiledContext?.legacySha256)
      && (approval.checksDigest ?? null) === checksDigest
      && (approval.protectDigest ?? null) === protectDigest
      && (approval.preparationDigest ?? null) === preparationDigest
      && shapeBindsApproval
      && task.dependsOn.every((dependency) => (
        Object.hasOwn(approval.dependencyAcceptances ?? {}, dependency)
        && approval.dependencyAcceptances[dependency] === dependencyAcceptances[dependency]
      ))
      && !blockedAfterApproval,
  );
  let allowedDigest;
  let allowedSnapshot;
  if (task.review?.verdict === 'accepted' && approvalFresh) {
    const candidatePaths = candidatePathsForTask(task);
    allowedSnapshot = await snapshotProjectFiles(projectRoot, candidatePaths).catch(() => undefined);
    if (allowedSnapshot) allowedDigest = digestJson(allowedSnapshot);
  }
  const evidenceDigest = task.review?.evidence
    ? await digestProjectFile(projectRoot, task.review.evidence, reviewEvidenceOptions()).catch(() => undefined)
    : undefined;
  const acceptedCurrent = Boolean(
    task.review?.verdict === 'accepted'
      && approvalFresh
      && task.review.approvalDigest === approval.approvalDigest
      && task.review.briefDigest === briefDigest
      && task.review.evidenceDigest === evidenceDigest
      && (task.review.candidateDigest ?? task.review.allowedDigest) === allowedDigest,
  );
  const acceptanceDigest = acceptedCurrent ? task.review.acceptanceDigest : undefined;
  const blockedBy = dependencyStates.filter((item) => !item.acceptanceDigest).map((item) => item.id);
  let status;
  if (blockedBy.length > 0) status = 'blocked';
  else if (task.review?.verdict === 'accepted' && acceptedCurrent) status = 'accepted';
  else if (task.review?.verdict === 'accepted') status = 'stale';
  else if (task.review?.verdict === 'blocked' && !approvalFresh) status = 'blocked';
  else if (!approval) status = 'pending_approval';
  else if (!approvalFresh) status = 'stale_approval';
  else status = 'ready';
  // A retired task never satisfies a dependency, whatever its review says.
  if (task.closure) status = task.closure.kind;
  return {
    id: task.id,
    status,
    briefDigest,
    contextDigest,
    checksDigest,
    approvalFresh,
    blockedBy,
    dependencyAcceptances,
    acceptanceDigest: task.closure ? undefined : acceptanceDigest,
    allowedSnapshot,
    allowedDigest,
    preparationDigest,
    evidenceDigest,
  };
}

function assertDependenciesExist(state, id, dependencies) {
  for (const dependency of dependencies) {
    if (dependency === id) throw tinyError('DEPENDENCY_CYCLE', `task ${id} cannot depend on itself`);
    if (!Object.hasOwn(state.tasks, dependency)) throw tinyError('DEPENDENCY_NOT_FOUND', `dependency task does not exist: ${dependency}`);
    // A retired dependency never becomes accepted, so the new task would stay blocked.
    const retired = state.tasks[dependency];
    if (retired.closure) throw tinyError('DEPENDENCY_CLOSED', `dependency task ${dependency} is ${closureLabel(retired)}`, publicClosure(retired.closure));
  }
  const graph = Object.create(null);
  for (const [taskId, task] of Object.entries(state.tasks)) graph[taskId] = task.dependsOn;
  graph[id] = dependencies;
  const visit = (node, stack = new Set()) => {
    if (stack.has(node)) throw tinyError('DEPENDENCY_CYCLE', `dependency cycle includes ${node}`);
    const next = new Set(stack).add(node);
    for (const dependency of graph[node] ?? []) visit(dependency, next);
  };
  visit(id);
}

function publicTask(task, stateInfo) {
  return {
    id: task.id,
    ...(task.feature ? { feature: task.feature } : {}),
    brief: task.brief,
    ...(task.context ? { context: task.context } : {}),
    ...(task.checks ? { checks: task.checks } : {}),
    dependsOn: [...task.dependsOn],
    allow: [...task.allow],
    ...(task.protect ? { protect: [...task.protect] } : {}),
    ...(task.preparation ? { preparation: structuredClone(task.preparation) } : {}),
    ...(task.revisions?.length > 0 ? { revisions: structuredClone(task.revisions) } : {}),
    status: stateInfo.status,
    blockedBy: [...stateInfo.blockedBy],
    approval: task.approval ? {
      by: task.approval.by,
      reason: task.approval.reason,
      approvedAt: task.approval.approvedAt,
      current: stateInfo.approvalFresh,
    } : undefined,
    review: task.review ? {
      verdict: task.review.verdict,
      by: task.review.by,
      reviewedAt: task.review.reviewedAt,
      current: task.review.verdict === 'accepted' ? Boolean(stateInfo.acceptanceDigest) : undefined,
      ...(task.review.appliedFromRun ? { appliedFromRun: { ...task.review.appliedFromRun } } : {}),
    } : undefined,
    ...(task.applied ? { applied: { runId: task.applied.runId, appliedAt: task.applied.appliedAt, files: task.applied.files.length } } : {}),
    ...(task.closure ? { closure: publicClosure(task.closure) } : {}),
  };
}

export async function initProject(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: true });
  return withExclusiveLock(info.lock, async () => {
    const configExists = await readJsonFile(info.config, { code: 'CONFIG_MALFORMED' });
    let configCreated = false;
    if (!configExists) {
      const hasWorkerArgs = [options.worker, options.provider, options.model].some((value) => value !== undefined);
      if (hasWorkerArgs && [options.worker, options.provider, options.model].some((value) => value === undefined)) {
        throw tinyError('INVALID_ARGUMENT', 'init worker, provider, and model must be supplied together');
      }
      const config = defaultConfig();
      if (hasWorkerArgs) {
        validateTaskId(options.worker);
        config.defaultWorker = options.worker;
        config.workers[options.worker] = { type: 'pi', provider: requireText(options.provider, 'provider'), model: requireText(options.model, 'model') };
      }
      validateConfigDocument(config);
      await atomicWriteJson(info.config, config);
      configCreated = true;
    } else {
      const configStat = await lstat(info.config);
      if (configStat.isSymbolicLink()) throw tinyError('SYMLINK_PATH', 'refusing symlinked .tinysdd/config.json');
    }
    let gitignoreCreated = false;
    try {
      const gitignoreStat = await lstat(info.gitignore);
      if (gitignoreStat.isSymbolicLink()) throw tinyError('SYMLINK_PATH', 'refusing symlinked .tinysdd/.gitignore');
      if (!gitignoreStat.isFile()) throw tinyError('INVALID_FILE', '.tinysdd/.gitignore must be a regular file');
      const existing = await readFile(info.gitignore, 'utf8');
      const existingRules = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
      const missingRules = ['runs/', 'launches/', 'config.local.json'].filter((rule) => !existingRules.has(rule));
      if (missingRules.length > 0) {
        const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        await atomicWriteFile(info.gitignore, `${existing}${separator}${missingRules.join('\n')}\n`, { mode: gitignoreStat.mode & 0o777 });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await atomicWriteFile(info.gitignore, 'runs/\nlaunches/\nconfig.local.json\n');
      gitignoreCreated = true;
    }
    return { projectRoot: root, configPath: info.config, gitignorePath: info.gitignore, configCreated, gitignoreCreated };
  });
}

export async function addTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const feature = options.feature === undefined ? undefined : validateFeature(options.feature);
  const { brief, context, checks, dependsOn, allow, protect, preparation: requestedPreparation } = normalizeTaskShape(options);
  const root = await canonicalProjectRoot(projectRoot);
  const validated = await validateTaskInputs(root, { brief, context, checks, allow, protect, preparation: requestedPreparation });
  const { compiled, preparation } = validated;
  return mutateState(root, async (state) => {
    if (Object.hasOwn(state.tasks, id)) throw tinyError('TASK_EXISTS', `task already exists: ${id}`);
    assertDependenciesExist(state, id, dependsOn);
    const timestamp = nowIso();
    state.tasks[id] = {
      id,
      ...(feature === undefined ? {} : { feature }),
      brief,
      ...(context === undefined ? {} : { context }),
      ...(checks === undefined ? {} : { checks }),
      dependsOn,
      allow,
      ...(protect ? { protect } : {}),
      ...(preparation.length > 0 ? { preparation } : {}),
      createdAt: timestamp,
      approval: undefined,
      review: undefined,
    };
    return { task: { id, ...(feature === undefined ? {} : { feature }), brief, ...(context === undefined ? {} : { context }), ...(checks === undefined ? {} : { checks }), dependsOn, allow, ...(protect ? { protect } : {}), ...(preparation.length > 0 ? { preparation } : {}) }, sizing: taskSizing(allow, compiled) };
  });
}

export async function updateTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const by = requireText(options.by, 'update by');
  const reason = requireText(options.reason, 'update reason');
  const root = await canonicalProjectRoot(projectRoot);
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    assertOpen(task);
    if (task.review?.verdict === 'accepted') throw tinyError('TASK_ACCEPTED', `task ${id} has been accepted; use task supersede`);
    const fields = TASK_SHAPE_FIELDS.filter((field) => options[field] !== undefined);
    if (fields.length === 0) throw tinyError('INVALID_ARGUMENT', 'task update requires at least one shape field');
    const previous = taskShape(task);
    const updated = { ...previous, ...Object.fromEntries(fields.map((field) => [field, options[field]])) };
    for (const field of ['context', 'checks']) {
      if (updated[field] === '') delete updated[field];
    }
    const shape = normalizeTaskShape(updated);
    assertDependenciesExist(state, id, shape.dependsOn);
    const validated = await validateTaskInputs(root, shape, { refreshPreparation: true });
    const compiled = validated.compiled;
    if (validated.preparation.length > 0) shape.preparation = validated.preparation;
    else delete shape.preparation;
    if (stableStringify(previous) === stableStringify(shape)) throw tinyError('TASK_UNCHANGED', `task ${id} shape is unchanged`);
    const revision = { revisedAt: nowIso(), by, reason, previous };
    if (task.applied) {
      revision.previous.applied = structuredClone(task.applied);
      delete task.applied;
    }
    for (const field of TASK_SHAPE_FIELDS) {
      if (shape[field] === undefined) delete task[field];
      else task[field] = shape[field];
    }
    task.revisions = [...(task.revisions ?? []), revision];
    return { task: publicTask(task, await inspectTask(root, state, task)), revision: structuredClone(revision), sizing: taskSizing(task.allow, compiled) };
  });
}

export async function approveTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const by = requireText(options.by, 'approval by');
  const reason = requireText(options.reason, 'approval reason');
  const root = await canonicalProjectRoot(projectRoot);
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    assertOpen(task);
    const status = await inspectTask(root, state, task);
    if (status.blockedBy.length > 0) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `task ${id} is blocked by: ${status.blockedBy.join(', ')}`);
    const briefDigest = await digestProjectFile(root, task.brief, taskBriefOptions()).catch(() => { throw tinyError('BRIEF_MISSING', `brief is missing: ${task.brief}`); });
    const compiled = task.context
      ? await compileApprovedContext(root, task).catch((error) => {
        if (error?.code === 'ENOENT' || error?.code === 'PATH_NOT_FOUND') throw tinyError('CONTEXT_MISSING', `context manifest is missing: ${task.context}`);
        throw error;
      })
      : null;
    const contextDigest = compiled ? compiled.sha256 : null;
    let checksDigest = null;
    if (task.checks) {
      let checksText;
      try {
        checksText = await readProjectFile(root, task.checks, taskBriefOptions());
      } catch {
        throw tinyError('CHECKS_MISSING', `checks manifest is missing: ${task.checks}`);
      }
      parseChecksManifest(checksText);
      checksDigest = sha256(checksText);
    }
    const dependencyAcceptances = {};
    for (const dependency of task.dependsOn) {
      const dependencyState = await inspectTask(root, state, state.tasks[dependency]);
      if (!dependencyState.acceptanceDigest) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `dependency is not accepted: ${dependency}`);
      dependencyAcceptances[dependency] = dependencyState.acceptanceDigest;
    }
    if (task.preparation) {
      const refreshed = await validateTaskInputs(root, {
        brief: task.brief,
        context: task.context,
        checks: task.checks,
        allow: task.allow,
        protect: task.protect,
        preparation: task.preparation,
      }, { refreshPreparation: true });
      task.preparation = refreshed.preparation;
    }
    const protectDigest = await protectedFilesDigest(root, task.protect);
    const approvedAt = nowIso();
    const preparationDigest = await preparationFilesDigest(root, task.preparation);
    const approvalBase = { taskId: id, briefDigest, context: task.context ?? null, contextDigest, checks: task.checks ?? null, checksDigest, protect: task.protect ?? null, protectDigest, preparation: task.preparation ?? null, preparationDigest, dependsOn: [...task.dependsOn], allow: [...task.allow], dependencyAcceptances, by, reason, approvedAt };
    task.approval = { ...approvalBase, approvalDigest: digestJson(approvalBase) };
    return { task: publicTask(task, await inspectTask(root, state, task)), sizing: taskSizing(task.allow, compiled) };
  });
}

// close and supersede share one transition: a terminal status that needs no
// approval, is refused while open tasks depend on it, and discards no acceptance.
async function retireTask(projectRoot, options, kind) {
  const id = validateTaskId(options.id);
  const by = requireText(options.by, 'closure by');
  const reason = requireText(options.reason, 'closure reason');
  const successors = kind === 'superseded' ? parseIds(options.with, 'with') : [];
  if (kind === 'superseded' && successors.length === 0) throw tinyError('INVALID_ARGUMENT', 'supersede requires at least one successor task (--with)');
  const root = await canonicalProjectRoot(projectRoot);
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    assertOpen(task);
    for (const successor of successors) {
      if (successor === id) throw tinyError('INVALID_ARGUMENT', `task ${id} cannot supersede itself`);
      if (!Object.hasOwn(state.tasks, successor)) throw tinyError('TASK_NOT_FOUND', `unknown successor task: ${successor}`);
      assertOpen(state.tasks[successor]);
    }
    if ((await inspectTask(root, state, task)).status === 'accepted') {
      throw tinyError('TASK_ACCEPTED', `task ${id} is accepted; closing it would discard a current acceptance`);
    }
    const dependents = Object.values(state.tasks).filter((other) => !other.closure && other.dependsOn.includes(id)).map((other) => other.id).sort();
    if (dependents.length > 0) throw tinyError('TASK_HAS_DEPENDENTS', `task ${id} is still required by open tasks: ${dependents.join(', ')}`, { dependents });
    task.closure = { kind, by, reason, closedAt: nowIso(), ...(kind === 'superseded' ? { supersededBy: successors } : {}) };
    return { task: publicTask(task, await inspectTask(root, state, task)) };
  });
}

export function closeTask(projectRoot, options = {}) {
  return retireTask(projectRoot, options, 'closed');
}

export function supersedeTask(projectRoot, options = {}) {
  return retireTask(projectRoot, options, 'superseded');
}

// A run's artifacts are controller evidence; anything unsafe or unreadable in
// them reads as a missing or malformed run, never as something to follow.
async function runArtifactPath(root, runId, segments, { allowMissing = false, requireDirectory = false, code = 'RUN_NOT_FOUND' } = {}) {
  try {
    return await assertInternalPath(root, ['.tinysdd', 'runs', runId, ...segments], { allowMissing, requireDirectory });
  } catch (error) {
    if (['PATH_NOT_FOUND', 'SYMLINK_PATH', 'INVALID_PATH'].includes(error?.code)) {
      throw tinyError(code, `run ${runId} is missing or not a plain directory tree: ${segments.join('/') || runId}`, { runId });
    }
    throw error;
  }
}

async function loadRunResult(root, runId) {
  const file = await runArtifactPath(root, runId, ['result.json']);
  const read = await readJsonFile(file, { code: 'RUN_MALFORMED' });
  if (!read) throw tinyError('RUN_NOT_FOUND', `run ${runId} has no result.json`, { runId });
  return assertPlainObject(read.value, 'RUN_MALFORMED', `run ${runId} result`);
}

async function assertFinalRunApproval(root, task, finalRun) {
  const file = await runArtifactPath(root, finalRun.id, ['packet.json'], { code: 'RUN_MALFORMED' });
  const read = await readJsonFile(file, { code: 'RUN_MALFORMED' });
  if (!read) throw tinyError('RUN_MALFORMED', `run ${finalRun.id} has no packet.json`, { runId: finalRun.id });
  const packet = assertPlainObject(read.value, 'RUN_MALFORMED', `run ${finalRun.id} packet`);
  const runApproval = packet.approval;
  const runApprovalDigest = runApproval && typeof runApproval === 'object' && !Array.isArray(runApproval)
    ? runApproval.approvalDigest
    : undefined;
  const currentApprovalDigest = task.approval?.approvalDigest;
  const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!isDigest(runApprovalDigest) || !isDigest(currentApprovalDigest) || runApprovalDigest !== currentApprovalDigest) {
    throw tinyError(
      'RUN_APPROVAL_MISMATCH',
      `run ${finalRun.id} approval digest ${runApprovalDigest ?? '(missing)'} does not match current task ${task.id} approval digest ${currentApprovalDigest ?? '(missing)'}; dispatch a fresh run before applying`,
      {
        runId: finalRun.id,
        runApprovalDigest: runApprovalDigest ?? null,
        currentApprovalDigest: currentApprovalDigest ?? null,
      },
    );
  }
  if (task.checks) {
    const checksText = await readProjectFile(root, task.checks, taskBriefOptions());
    const packetDigest = packet.checks?.sha256;
    if (packetDigest !== sha256(checksText) || packetDigest !== task.approval.checksDigest) {
      throw tinyError('RUN_APPROVAL_MISMATCH', `run ${finalRun.id} checks content does not match the approved task checks`, { runId: finalRun.id });
    }
  }
}

// Follows result.baseRun.id parents the way the worker does when it builds a
// revision. Returns the runs earliest first: the root's workspace-before is the
// project state the lineage started from, the last run's workspace-after is the
// candidate.
async function loadApplyLineage(root, task, runId) {
  const newestFirst = [];
  const seen = new Set();
  const dependencyMounts = await taskDependencyMounts(root, task);
  const filesystemAliases = await detectFilesystemAliases(root);
  const { caseInsensitive, unicodeInsensitive } = filesystemAliases;
  let currentId = runId;
  while (currentId !== undefined) {
    if (seen.has(currentId)) throw tinyError('RUN_MALFORMED', 'base run lineage contains a cycle', { runId: currentId });
    seen.add(currentId);
    if (seen.size > MAX_APPLY_LINEAGE) throw tinyError('RUN_MALFORMED', 'base run lineage exceeds the supported depth', { runId });
    const result = await loadRunResult(root, currentId);
    if (result.taskId !== task.id) throw tinyError('RUN_TASK_MISMATCH', `run ${currentId} belongs to task ${result.taskId ?? '(none)'}, not ${task.id}`, { runId: currentId, taskId: result.taskId });
    if (result.baselineRun !== undefined) throw tinyError('RUN_IS_REPLAY', `run ${currentId} is a benchmark replay and is never applied`, { runId: currentId });
    if (newestFirst.length === 0 && result.outcome !== 'completed') {
      throw tinyError('RUN_INCOMPLETE', `run ${currentId} ended with outcome ${result.outcome}; only a completed run is applied`, { runId: currentId, outcome: result.outcome });
    }
    if (!Array.isArray(result.scopeViolations) || !Array.isArray(result.changedPaths)) throw tinyError('RUN_MALFORMED', `run ${currentId} result lacks changedPaths or scopeViolations`, { runId: currentId });
    if (result.scopeViolations.length > 0) {
      throw tinyError('RUN_SCOPE_VIOLATION', `run ${currentId} contains a retained boundary violation`, { runId: currentId, paths: result.scopeViolations.map((violation) => violation?.path) });
    }
    const before = await snapshotRunWorkspace(root, currentId, 'workspace-before');
    const after = await snapshotRunWorkspace(root, currentId, 'workspace-after');
    const recordedBefore = await readRunSnapshot(root, currentId, 'before-snapshot.json');
    const recordedAfter = await readRunSnapshot(root, currentId, 'after-snapshot.json');
    if (stableStringify(recordedBefore) !== stableStringify(before) || stableStringify(recordedAfter) !== stableStringify(after)) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} retained snapshots do not match workspace evidence`, { runId: currentId });
    }
    const actual = runSnapshotChanges(before, after);
    const claimedEntries = result.changedPaths.map((change) => {
      if (!change || typeof change.path !== 'string' || typeof change.change !== 'string') throw tinyError('RUN_MALFORMED', `run ${currentId} has an invalid changed path`, { runId: currentId });
      return change;
    });
    const actualShape = actual.map(({ path, change }) => ({ path, change }));
    const claimed = claimedEntries.map(({ path, change }) => ({ path, change }));
    claimed.sort((left, right) => left.path.localeCompare(right.path));
    actualShape.sort((left, right) => left.path.localeCompare(right.path));
    const claimedIdentity = [...claimedEntries].sort((left, right) => left.path.localeCompare(right.path));
    const actualIdentity = [...actual].sort((left, right) => left.path.localeCompare(right.path));
    if (stableStringify(claimedIdentity) !== stableStringify(actualIdentity)) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} changedPaths identities do not match retained workspace evidence`, { runId: currentId, claimed: claimedIdentity, actual: actualIdentity });
    }
    if (stableStringify(claimed) !== stableStringify(actualShape)) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} changedPaths does not match retained workspace evidence`, { runId: currentId, claimed, actual: actualShape });
    }
    if (!result.fileScope || result.fileScope.mode !== 'ordinary-create-modify' || result.fileScope.ordinaryCreateModify !== true || result.fileScope.deletions !== false || !Array.isArray(result.fileScope.actualPaths)) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} lacks complete file-scope evidence`, { runId: currentId });
    }
    if (result.fileScope.actualPaths.some((path) => typeof path !== 'string' || observedPathError(path)) || new Set(result.fileScope.actualPaths).size !== result.fileScope.actualPaths.length) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} fileScope actualPaths are not a unique canonical inventory`, { runId: currentId });
    }
    if (stableStringify([...new Set(result.fileScope.actualPaths)].sort()) !== stableStringify(actualShape.map(({ path }) => path).sort())) {
      throw tinyError('RUN_MALFORMED', `run ${currentId} fileScope actualPaths does not match retained workspace evidence`, { runId: currentId });
    }
    const preparation = task.preparation ?? [];
    const violations = actual.map((change) => classifyFileScopeChange(change, {
      protectedPaths: task.protect ?? [],
      preparationPaths: preparationPaths(preparation),
      dependencyMounts,
      caseInsensitive,
      unicodeInsensitive,
      filesystemAliases,
    })).filter(Boolean);
    if (violations.length > 0) {
      throw tinyError('RUN_SCOPE_VIOLATION', `run ${currentId} contains ineligible candidate changes`, { runId: currentId, paths: violations.map((violation) => violation.path), violations });
    }
    newestFirst.push({ id: currentId, result });
    const parentId = result.baseRun?.id;
    if (parentId === undefined || parentId === null) break;
    if (typeof parentId !== 'string' || !RUN_ID_PATTERN.test(parentId)) throw tinyError('RUN_MALFORMED', `run ${currentId} has an invalid base run id`, { runId: currentId });
    currentId = parentId;
  }
  return newestFirst.reverse();
}

async function readBoundedRegularBytes(absolute, maxBytes, { expectedInfo = null } = {}) {
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || (expectedInfo && (opened.ino !== expectedInfo.ino || opened.dev !== expectedInfo.dev))) {
      throw tinyError('RUN_MALFORMED', `regular file changed while being read: ${absolute}`);
    }
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw tinyError('RUN_MALFORMED', `regular file exceeds the bounded read limit: ${absolute}`);
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
    return { bytes: Buffer.concat(chunks, bytes) };
  } catch (error) {
    if (error?.code === 'ELOOP') throw tinyError('SYMLINK_PATH', `symlinked paths are not allowed: ${absolute}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readRegularFile(absolute) {
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `symlinked paths are not allowed: ${absolute}`);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `not a regular file: ${absolute}`);
  const read = await readBoundedRegularBytes(absolute, MAX_RUN_SNAPSHOT_BYTES, { expectedInfo: info });
  return { bytes: read.bytes, mode: info.mode & 0o777 };
}

async function readRunFile(root, runId, workspace, path) {
  const absolute = await runArtifactPath(root, runId, [workspace, ...path.split('/')], { allowMissing: true, code: 'RUN_MALFORMED' });
  try {
    return await readRegularFile(absolute);
  } catch (error) {
    if (['SYMLINK_PATH', 'INVALID_FILE'].includes(error?.code)) throw tinyError('RUN_MALFORMED', `run ${runId} ${workspace}/${path} is not a regular file`, { runId, path });
    throw error;
  }
}

async function hashRunWorkspaceFile(absolute, runId, path, expectedInfo, maxBytes) {
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== expectedInfo.ino || opened.dev !== expectedInfo.dev) {
      throw tinyError('RUN_MALFORMED', `run ${runId} workspace/${path} changed while being read`, { runId, path });
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw tinyError('RUN_MALFORMED', `run ${runId} workspace snapshot exceeds the byte limit`, { runId });
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return { sha256: hash.digest('hex'), size: bytes };
  } catch (error) {
    if (error?.code === 'ELOOP') throw tinyError('RUN_MALFORMED', `run ${runId} workspace/${path} is not a regular file`, { runId, path });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function snapshotRunWorkspace(root, runId, workspace) {
  const directory = await runArtifactPath(root, runId, [workspace], { requireDirectory: true, code: 'RUN_MALFORMED' });
  const snapshot = Object.create(null);
  let entriesSeen = 0;
  let bytesSeen = 0;
  async function visit(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (++entriesSeen > MAX_RUN_SNAPSHOT_ENTRIES) throw tinyError('RUN_MALFORMED', `run ${runId} workspace snapshot exceeds the entry limit`, { runId });
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) snapshot[path] = { kind: 'symlink', sha256: null, size: null };
      else if (info.isDirectory()) {
        snapshot[path] = { kind: 'directory', sha256: null, size: null };
        await visit(absolute, path);
      } else if (info.isFile()) {
        if (info.size > MAX_RUN_SNAPSHOT_BYTES || bytesSeen > MAX_RUN_SNAPSHOT_BYTES - info.size) {
          throw tinyError('RUN_MALFORMED', `run ${runId} workspace snapshot exceeds the byte limit`, { runId });
        }
        const hashed = await hashRunWorkspaceFile(absolute, runId, path, info, MAX_RUN_SNAPSHOT_BYTES - bytesSeen);
        bytesSeen += hashed.size;
        if (bytesSeen > MAX_RUN_SNAPSHOT_BYTES) throw tinyError('RUN_MALFORMED', `run ${runId} workspace snapshot exceeds the byte limit`, { runId });
        snapshot[path] = { kind: 'file', sha256: hashed.sha256, size: hashed.size };
      } else snapshot[path] = { kind: 'other', sha256: null, size: null };
    }
  }
  await visit(directory);
  return snapshot;
}

async function readRunSnapshot(root, runId, name) {
  const path = await runArtifactPath(root, runId, [name], { code: 'RUN_MALFORMED' });
  const info = await lstat(path);
  if (info.size > MAX_RUN_SNAPSHOT_BYTES) throw tinyError('RUN_MALFORMED', `run ${runId} ${name} exceeds the retained snapshot limit`, { runId });
  let value;
  try {
    const read = await readBoundedRegularBytes(path, MAX_RUN_SNAPSHOT_BYTES, { expectedInfo: info });
    value = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    throw tinyError('RUN_MALFORMED', `run ${runId} ${name} is malformed`, { runId });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_RUN_SNAPSHOT_ENTRIES) {
    throw tinyError('RUN_MALFORMED', `run ${runId} ${name} is not a bounded snapshot object`, { runId });
  }
  return value;
}

function runSnapshotChanges(before, after) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const beforeDescendants = new Set();
  const afterDescendants = new Set();
  for (const path of Object.keys(before)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) beforeDescendants.add(parts.slice(0, index).join('/'));
  }
  for (const path of Object.keys(after)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) afterDescendants.add(parts.slice(0, index).join('/'));
  }
  return paths.flatMap((path) => {
    const oldValue = before[path];
    const newValue = after[path];
    if (stableStringify(oldValue) === stableStringify(newValue)) return [];
    if (!oldValue && newValue?.kind === 'directory' && afterDescendants.has(path)) return [];
    if (!newValue && oldValue?.kind === 'directory' && beforeDescendants.has(path)) return [];
    const change = !oldValue ? 'created' : !newValue ? 'deleted' : oldValue.kind !== newValue.kind ? 'type_changed' : 'modified';
    return [{ path, change, before: oldValue ?? null, after: newValue ?? null }];
  });
}

async function taskDependencyMounts(root, task) {
  if (!task.checks) return [];
  let text;
  try {
    text = await readProjectFile(root, task.checks, taskBriefOptions());
  } catch {
    throw tinyError('STALE_CHECKS', `checks manifest is no longer readable: ${task.checks}`);
  }
  try {
    return parseChecksManifest(text).dependencyMounts;
  } catch (error) {
    throw tinyError('RUN_MALFORMED', `approved checks manifest is invalid: ${task.checks}`, { cause: error?.message });
  }
}

function sameContent(left, right) {
  if (left === null || right === null) return left === right;
  return left.bytes.equals(right.bytes);
}

export async function applyTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const by = requireText(options.by, 'apply by');
  const runId = requireText(options.run, 'run id');
  const root = await canonicalProjectRoot(projectRoot);
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    assertOpen(task);
    const status = await inspectTask(root, state, task);
    if (status.status !== 'ready') throw tinyError('TASK_NOT_READY', `task ${id} is ${status.status}`, { status: status.status, blockedBy: status.blockedBy });
    if (!RUN_ID_PATTERN.test(runId)) throw tinyError('INVALID_RUN_ID', 'run id must be a TinySDD worker run id such as worker-2026-01-01T00-00-00-000Z-0a1b2c3d');
    const lineage = await loadApplyLineage(root, task, runId);
    const rootRun = lineage[0];
    const finalRun = lineage[lineage.length - 1];
    await assertFinalRunApproval(root, task, finalRun);
    await runArtifactPath(root, rootRun.id, ['workspace-before'], { requireDirectory: true });
    await runArtifactPath(root, finalRun.id, ['workspace-after'], { requireDirectory: true });

    // Plan every validated actual change, and refuse on drift, before the first
    // write. A revision's workspaces carry the project held at its dispatch;
    // only the retained lineage union is applicable.
    const recorded = new Set(lineage.flatMap((run) => run.result.changedPaths.map((change) => change.path)));
    const plan = [];
    const conflicts = [];
    for (const path of [...recorded].sort()) {
      if (!recorded.has(path)) continue;
      const before = await readRunFile(root, rootRun.id, 'workspace-before', path);
      const after = await readRunFile(root, finalRun.id, 'workspace-after', path);
      if (sameContent(before, after)) continue;
      const absolute = (await resolveProjectPath(root, path, { allowMissing: true })).absolutePath;
      const current = await readRegularFile(absolute);
      let applyStatus = 'written';
      if (!sameContent(current, before)) {
        if (sameContent(current, after)) applyStatus = 'already-applied';
        else conflicts.push(path);
      }
      plan.push({ path, absolute, change: after === null ? 'deleted' : before === null ? 'created' : 'modified', after, digest: after === null ? null : sha256(after.bytes), status: applyStatus });
    }
    if (conflicts.length > 0) {
      throw tinyError('APPLY_CONFLICT', `project files no longer match the state run ${rootRun.id} started from: ${conflicts.join(', ')}`, { paths: conflicts, runId: finalRun.id, rootRunId: rootRun.id });
    }

    // A run that rewrites its own brief, context manifest or checks would leave the approval it was dispatched under stale.
    const inputs = [task.brief, task.context, task.checks, ...preparationPaths(task.preparation ?? [])].filter(Boolean);
    const filesystemAliases = await detectFilesystemAliases(root);
    const { caseInsensitive, unicodeInsensitive } = filesystemAliases;
    const rewritten = plan.filter((item) => item.status === 'written' && inputs.some((input) => pathsOverlap(item.path, input, { caseInsensitive, unicodeInsensitive, filesystemAliases }))).map((item) => item.path);
    if (rewritten.length > 0) {
      throw tinyError('APPLY_CHANGES_TASK_INPUT', `run ${finalRun.id} would rewrite the approval inputs of task ${id}: ${rewritten.join(', ')}; nothing was written`, { paths: rewritten, runId: finalRun.id });
    }
    const deletions = plan.filter((item) => item.change === 'deleted').map((item) => item.path);
    if (deletions.length > 0) {
      throw tinyError('APPLY_DELETION_UNAUTHORIZED', `run ${finalRun.id} contains file deletions, which task apply does not authorize: ${deletions.join(', ')}`, { paths: deletions, runId: finalRun.id });
    }
    // Compile the context as inspectTask will read it once this apply is recorded,
    // and refuse now if that would leave the approval stale.
    if (task.context) {
      const after = await compilePinnedContext(root, task, rootRun.id, pinnedPaths(plan)).catch(() => undefined);
      if (!after || !contextDigestMatches(task.approval.contextDigest ?? null, after.sha256, after.legacySha256)) {
        throw tinyError('APPLY_WOULD_STALE', `applying run ${finalRun.id} would leave task ${id} with a stale approval; nothing was written`, { runId: finalRun.id, rootRunId: rootRun.id });
      }
    }
    // The digest below reads every allowed file; refuse an unreadable or
    // symlinked one now rather than after the writes.
    await snapshotProjectFiles(root, [...new Set([...task.allow, ...(task.protect ?? []), ...recorded])]);
    for (const item of plan) {
      if (item.status !== 'written') continue;
      await atomicWriteFile(item.absolute, item.after.bytes, { mode: item.after.mode });
    }
    task.applied = {
      runId: finalRun.id,
      rootRunId: rootRun.id,
      appliedAt: nowIso(),
      by,
      allowedDigest: await allowedFilesDigest(root, task.allow),
      actualPaths: [...new Set([...task.allow, ...plan.map((item) => item.path)])].sort(),
      actualDigest: await allowedFilesDigest(root, [...new Set([...task.allow, ...plan.map((item) => item.path)])].sort()),
      files: plan.map((item) => ({ path: item.path, change: item.change, sha256: item.digest, status: item.status })),
    };
    return { task: publicTask(task, await inspectTask(root, state, task)), applied: structuredClone(task.applied) };
  });
}

export async function resolveTaskPacket(projectRoot, taskId) {
  const id = validateTaskId(taskId);
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: false });
  const state = await readState(info);
  if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
  const task = state.tasks[id];
  assertOpen(task);
  const status = await inspectTask(root, state, task);
  if (status.status === 'accepted') throw tinyError('TASK_ALREADY_ACCEPTED', `task ${id} is already accepted`);
  if (status.status !== 'ready') {
    throw tinyError('TASK_NOT_READY', `task ${id} is ${status.status}`, { status: status.status, blockedBy: status.blockedBy });
  }
  // Context excerpts of an allowed file would no longer match the applied project the worker copies.
  if (task.applied) {
    throw tinyError('TASK_APPLIED', `task ${id} has an applied run (${task.applied.runId}); review it, accepted or revision, before dispatching again`, { runId: task.applied.runId });
  }
  const text = await readProjectFile(root, task.brief, taskBriefOptions());
  let context;
  if (task.context) {
    let compiled;
    try {
      compiled = await compileTaskContext(root, task.context);
    } catch {
      throw tinyError('STALE_CONTEXT', `context manifest or selected source is no longer readable: ${task.context}`);
    }
    if (compiled.sha256 !== status.contextDigest) throw tinyError('STALE_CONTEXT', `context manifest or selected source has changed: ${task.context}`);
    const contextText = await readProjectFile(root, task.context, taskBriefOptions());
    context = { path: task.context, text: contextText, sha256: sha256(contextText), compiledSha256: compiled.sha256 };
  }
  let checks;
  if (task.checks) {
    let checksText;
    try {
      checksText = await readProjectFile(root, task.checks, taskBriefOptions());
    } catch {
      throw tinyError('STALE_CHECKS', `checks manifest is no longer readable: ${task.checks}`);
    }
    const checksSha256 = sha256(checksText);
    if (checksSha256 !== status.checksDigest) throw tinyError('STALE_CHECKS', `checks manifest has changed: ${task.checks}`);
    checks = { path: task.checks, text: checksText, sha256: checksSha256 };
  }
  let revisionReview;
  if (task.review?.verdict === 'revision') {
    let evidenceText;
    try {
      evidenceText = await readProjectFile(root, task.review.evidence, reviewEvidenceOptions());
    } catch {
      throw tinyError('STALE_REVIEW_EVIDENCE', `revision evidence is no longer readable: ${task.review.evidence}`);
    }
    const evidenceDigest = sha256(evidenceText);
    if (evidenceDigest !== task.review.evidenceDigest) {
      throw tinyError('STALE_REVIEW_EVIDENCE', `revision evidence has changed: ${task.review.evidence}`);
    }
    revisionReview = {
      verdict: 'revision',
      by: task.review.by,
      evidence: { path: task.review.evidence, text: evidenceText, sha256: evidenceDigest },
    };
  }
  return {
    schemaVersion: 1,
    taskId: id,
    brief: { path: task.brief, text, sha256: sha256(text) },
    runtimeScope: { ...DEFAULT_RUNTIME_SCOPE },
    allowedPaths: [...task.allow],
    ...(task.protect ? { protectedPaths: [...task.protect] } : {}),
    ...(task.preparation ? { preparation: structuredClone(task.preparation) } : {}),
    dependencies: task.dependsOn.map((dependency) => ({ id: dependency, acceptanceDigest: status.dependencyAcceptances[dependency] })),
    approval: { ...task.approval },
    ...(context === undefined ? {} : { context }),
    ...(checks === undefined ? {} : { checks }),
    ...(revisionReview === undefined ? {} : { review: revisionReview }),
  };
}

/**
 * Reconstruct the approved packet for an isolated historical replay. A replay
 * is not a task-state transition: later work may make the live task or its
 * dependencies stale, but the original approval remains the benchmark packet.
 * The worker verifies its context digest against --baseline-run's snapshot.
 */
export async function resolveBenchmarkPacket(projectRoot, taskId) {
  const id = validateTaskId(taskId);
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: false });
  const state = await readState(info);
  if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
  const task = state.tasks[id];
  if (!task.approval) throw tinyError('BENCHMARK_NOT_APPROVED', `task ${id} has no recorded approval to replay`);
  if (!approvalBindsTaskShape(task.approval, task)) {
    throw tinyError('STALE_BENCHMARK_SHAPE', `task ${id} shape has changed since the recorded approval`, { taskId: id });
  }
  const text = await readProjectFile(root, task.brief, taskBriefOptions());
  if (sha256(text) !== task.approval.briefDigest) {
    throw tinyError('STALE_BENCHMARK_BRIEF', `brief has changed since the recorded approval: ${task.brief}`);
  }
  let context;
  if (task.context) {
    const contextText = await readProjectFile(root, task.context, taskBriefOptions());
    context = {
      path: task.context,
      text: contextText,
      sha256: sha256(contextText),
      compiledSha256: task.approval.contextDigest,
    };
  }
  let checks;
  if (task.checks) {
    const checksText = await readProjectFile(root, task.checks, taskBriefOptions());
    const checksSha256 = sha256(checksText);
    if (checksSha256 !== task.approval.checksDigest) {
      throw tinyError('STALE_BENCHMARK_CHECKS', `checks manifest has changed since the recorded approval: ${task.checks}`);
    }
    checks = { path: task.checks, text: checksText, sha256: checksSha256 };
  }
  return {
    schemaVersion: 1,
    taskId: id,
    brief: { path: task.brief, text, sha256: sha256(text) },
    runtimeScope: { ...DEFAULT_RUNTIME_SCOPE },
    allowedPaths: [...task.allow],
    ...(task.protect ? { protectedPaths: [...task.protect] } : {}),
    ...(task.preparation ? { preparation: structuredClone(task.preparation) } : {}),
    dependencies: task.dependsOn.map((dependency) => ({ id: dependency, acceptanceDigest: task.approval.dependencyAcceptances?.[dependency] })),
    approval: { ...task.approval },
    ...(context === undefined ? {} : { context }),
    ...(checks === undefined ? {} : { checks }),
  };
}

export const resolvePacket = resolveTaskPacket;

// The semantic gate judges, the controller decides. It runs outside
// mutateState so the Jev HTTP call never holds the controller lock, and it
// only constrains an accepted verdict: enforce can block it, shadow never
// does, and a judge failure falls back to exactly the mode-off behavior.
async function semanticGateDecision(root, { taskId, verdict, evidenceContent, judge }) {
  if (verdict !== 'accepted') return null;
  let resolved;
  try {
    resolved = await resolveConfig(root);
  } catch {
    return null;
  }
  const gate = resolved.config.semanticGate;
  if (!gate || gate.mode === 'off') return null;
  let task;
  try {
    const info = await layout(root, { create: false });
    const state = await readState(info);
    task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
  } catch {
    return null;
  }
  // A retired task is refused by reviewTask; don't spend a judge call on it.
  if (!task || !task.approval || task.closure) return null;
  let briefText;
  try {
    briefText = await readProjectFile(root, task.brief, taskBriefOptions());
  } catch {
    return null;
  }
  const artifactDigests = { briefDigest: sha256(briefText), evidenceDigest: sha256(evidenceContent) };
  const criteria = extractAcceptanceCriteria(briefText);
  const checks = extractEvidenceChecks(evidenceContent);
  const timestamp = nowIso();
  const baseRecord = { taskId, mode: gate.mode, model: gate.model, artifactDigests };
  const shortCircuit = criteria.length === 0 ? 'brief has no C-prefixed acceptance criteria' : !checks.present ? 'evidence has no ## Checks section' : null;
  if (shortCircuit !== null) {
    // Warn-only boundary: confirm, never block, no judge call.
    await appendDecisionRecords(root, taskId, [buildDecisionRecord({
      timestamp,
      ...baseRecord,
      band: 'confirm',
      policyAction: gate.mode === 'shadow' ? 'ignored-shadow' : 'confirm',
      reason: shortCircuit,
    })]);
    if (gate.mode !== 'enforce') return { mode: gate.mode, action: 'confirm' };
    return { mode: gate.mode, action: 'confirm', reviewField: { mode: gate.mode, action: 'confirm', evaluatedAt: timestamp, warnings: [shortCircuit] } };
  }
  let judged;
  try {
    judged = await judgeEvidenceSufficiency({ taskId, criteria, checks: checks.checks, endpoint: gate.endpoint, model: gate.model, judge });
  } catch (error) {
    if (!(error instanceof TinySDDError) || error.code !== 'JEV_UNAVAILABLE') throw error;
    // Judge down: behave exactly as mode off plus an unavailable record.
    await appendDecisionRecords(root, taskId, [buildDecisionRecord({
      timestamp,
      ...baseRecord,
      policyAction: JUDGE_UNAVAILABLE_ACTION,
      reason: error.details?.reason ?? error.code,
    })]);
    return null;
  }
  const evaluated = criteria.map((criterion) => {
    const noul = judged.answers[criterion.id];
    return { id: criterion.id, text: criterion.text, noul, band: computeBand(noul, gate.thresholds) };
  });
  const { action } = aggregateGateOutcome({ evaluated, mode: gate.mode });
  await appendDecisionRecords(root, taskId, evaluated.map((item) => buildDecisionRecord({
    timestamp,
    ...baseRecord,
    modelVersion: judged.modelVersion,
    questionId: item.id,
    criterionDigest: sha256(item.text),
    noul: item.noul,
    band: item.band,
    // Per-criterion action in enforce; shadow collapses every line to ignored-shadow.
    policyAction: gate.mode === 'shadow' ? SHADOW_POLICY_ACTION : item.band,
  })));
  if (action === 'block') return { mode: gate.mode, action, evaluated, thresholds: gate.thresholds };
  if (gate.mode === 'enforce' && action === 'confirm') {
    return {
      mode: gate.mode,
      action,
      reviewField: {
        mode: gate.mode,
        action,
        evaluatedAt: timestamp,
        warnings: evaluated.filter((item) => item.band !== 'allow').map((item) => `criterion ${item.id} noul ${item.noul} is below the accept threshold ${gate.thresholds.accept}`),
      },
    };
  }
  return { mode: gate.mode, action };
}

// The digest an acceptance binds: the allowed files' content right now.
async function allowedFilesDigest(root, allow) {
  return digestJson(await snapshotProjectFiles(root, allow));
}

// identical is false when an allowed file was edited after `task apply`, which
// review allows but records. A record from before applied.allowedDigest existed
// can only be checked against the files it wrote.
async function appliedIdentical(root, applied, allowedDigest) {
  if (applied.actualDigest !== undefined) return applied.actualDigest === allowedDigest;
  if (applied.allowedDigest !== undefined) return applied.allowedDigest === allowedDigest;
  const snapshot = await snapshotProjectFiles(root, applied.files.map((file) => file.path));
  return applied.files.every((file, index) => (file.change === 'deleted' ? !snapshot[index].exists : snapshot[index].sha256 === file.sha256));
}

export async function reviewTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const verdict = options.verdict;
  if (!['accepted', 'revision', 'blocked'].includes(verdict)) throw tinyError('INVALID_VERDICT', 'verdict must be accepted, revision, or blocked');
  const by = requireText(options.by, 'review by');
  const evidence = normalizeReviewEvidence(requireText(options.evidence, 'evidence'), 'evidence');
  const root = await canonicalProjectRoot(projectRoot);
  const gateEvidence = await readProjectFile(root, evidence, reviewEvidenceOptions());
  const gate = await semanticGateDecision(root, { taskId: id, verdict, evidenceContent: gateEvidence, judge: options.judge });
  if (gate !== null && gate.mode === 'enforce' && gate.action === 'block') {
    const blocked = gate.evaluated.filter((item) => item.band === 'block');
    throw tinyError('SEMANTIC_GATE_REJECTED', `semantic gate rejected the accepted verdict: ${blocked.map((item) => `${item.id} noul ${item.noul} < reject threshold ${gate.thresholds.reject}`).join(', ')}`, {
      mode: gate.mode,
      thresholds: gate.thresholds,
      criteria: blocked.map((item) => ({ id: item.id, noul: item.noul, band: item.band })),
    });
  }
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    assertOpen(task);
    const status = await inspectTask(root, state, task);
    if (status.blockedBy.length > 0) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `task ${id} is blocked by: ${status.blockedBy.join(', ')}`);
    if (!task.approval || !status.approvalFresh) throw tinyError('APPROVAL_STALE', `task ${id} does not have a current approval`);
    const evidenceContent = await readProjectFile(root, evidence, reviewEvidenceOptions());
    if (evidenceContent.trim().length === 0) throw tinyError('INVALID_EVIDENCE', 'evidence must be nonempty');
    const requestedCandidatePaths = options.candidatePaths === undefined
      ? []
      : normalizeTaskPaths(options.candidatePaths, 'candidate');
    const candidatePaths = [...new Set([
      ...task.allow,
      ...(task.applied?.actualPaths ?? []),
      ...(task.review?.candidatePaths ?? []),
      ...requestedCandidatePaths,
    ])].sort();
    const allowedDigest = await allowedFilesDigest(root, candidatePaths);
    const reviewedAt = nowIso();
    const review = {
      verdict,
      by,
      reviewedAt,
      evidence,
      evidenceDigest: sha256(evidenceContent),
      briefDigest: status.briefDigest,
      approvalDigest: task.approval.approvalDigest,
      allowedDigest,
      candidatePaths,
      candidateDigest: allowedDigest,
    };
    if (gate !== null && gate.reviewField !== undefined) review.semanticGate = gate.reviewField;
    if ((verdict === 'accepted' || verdict === 'revision') && task.applied) review.appliedFromRun = { runId: task.applied.runId, identical: await appliedIdentical(root, task.applied, allowedDigest) };
    if (verdict === 'accepted') review.acceptanceDigest = digestJson({ ...review, taskId: id });
    task.review = review;
    // The next attempt builds on the applied project, so the record is spent;
    // an accepted or blocked review leaves it, since the files are still applied.
    if (verdict === 'revision') delete task.applied;
    return { task: publicTask(task, await inspectTask(root, state, task)) };
  });
}

async function inspectFeature(root, state, feature) {
  const tasks = Object.values(state.tasks)
    .filter((task) => task.feature === feature)
    .sort((left, right) => left.id.localeCompare(right.id));
  const membership = [];
  const activeAcceptanceDigests = {};
  const statuses = {};
  const reportTasks = [];
  const protectedPaths = new Set();
  for (const task of tasks) {
    const retired = Boolean(task.closure);
    const stateInfo = await inspectTask(root, state, task);
    membership.push({ id: task.id, retired });
    statuses[task.id] = stateInfo.status;
    reportTasks.push({ id: task.id, feature, retired });
    for (const path of task.protect ?? []) protectedPaths.add(path);
    for (const path of preparationPaths(task.preparation ?? [])) protectedPaths.add(path);
    if (!retired && stateInfo.status === 'accepted' && stateInfo.acceptanceDigest) {
      activeAcceptanceDigests[task.id] = stateInfo.acceptanceDigest;
    }
  }
  return { tasks, membership, activeAcceptanceDigests, statuses, reportTasks, protectedPaths: [...protectedPaths].sort() };
}

function assertFeatureAcceptanceReady(feature, snapshot) {
  if (snapshot.membership.length === 0) throw tinyError('FEATURE_NOT_FOUND', `feature has no labelled tasks: ${feature}`);
  const rejected = snapshot.membership
    .filter((item) => !item.retired && (snapshot.statuses[item.id] !== 'accepted' || !snapshot.activeAcceptanceDigests[item.id]))
    .map((item) => ({ id: item.id, status: snapshot.statuses[item.id] }));
  if (rejected.length > 0) {
    throw tinyError('FEATURE_NOT_ACCEPTED', `feature has non-retired tasks that are not accepted: ${rejected.map((item) => `${item.id} (${item.status})`).join(', ')}`, { tasks: rejected });
  }
}

function currentFeatureMetadata(snapshot) {
  return {
    membership: structuredClone(snapshot.membership),
    activeAcceptanceDigests: structuredClone(snapshot.activeAcceptanceDigests),
    statuses: structuredClone(snapshot.statuses),
  };
}

function featureStaleness(event, current) {
  const reasons = [];
  if (stableStringify(event.membership) !== stableStringify(current.membership)) reasons.push('labelled task membership changed');
  if (stableStringify(event.activeAcceptanceDigests) !== stableStringify(current.activeAcceptanceDigests)) reasons.push('active task acceptance digests changed');
  for (const item of current.membership) {
    if (!item.retired && current.statuses[item.id] !== 'accepted') reasons.push(`task ${item.id} is currently ${current.statuses[item.id]}`);
  }
  return { stale: reasons.length > 0, reasons };
}

async function liveFeatureReport(root, feature, snapshot, usageRecords) {
  return buildUsageReport({ projectRoot: root, feature, tasks: snapshot.reportTasks, usageRecords });
}

function latestFeatureEvent(events, feature) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].feature === feature) return events[index];
  }
  return undefined;
}

async function featureIntegrationState(root, feature, current, event, resolved) {
  const config = resolved?.config?.featureIntegration;
  const protectedPaths = process.env[FEATURE_INTEGRATION_TEST_ENV] === '1'
    ? [...new Set([...current.protectedPaths, ...(config?.testPaths ?? [])])].sort()
    : current.protectedPaths;
  return featureIntegrationFreshness(root, {
    feature,
    eventIntegration: event?.integration,
    membership: current.membership,
    activeAcceptanceDigests: current.activeAcceptanceDigests,
    config,
    protectedPaths,
  });
}

export async function reportFeature(projectRoot, options = {}) {
  const feature = validateFeature(options.feature);
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: true });
  return withExclusiveLock(info.lock, async () => {
    const state = await readState(info);
    const current = await inspectFeature(root, state, feature);
    const event = latestFeatureEvent(await readFeatureEvents(root), feature);
    const resolved = await resolveConfig(root);
    const integration = await featureIntegrationState(root, feature, current, event, resolved);
    if (!event) {
      return {
        feature,
        accepted: false,
        stale: integration.fresh === false,
        ...(integration.fresh === false ? { staleReasons: integration.reasons } : {}),
        eligible: integration.fresh && current.membership.some((item) => !item.retired && current.statuses[item.id] === 'accepted'),
        integration,
        current: currentFeatureMetadata(current),
        report: await withUsageLedgerLock(root, (usageRecords) => liveFeatureReport(root, feature, current, usageRecords)),
      };
    }
    const stale = featureStaleness(event, current);
    const staleReasons = [...stale.reasons, ...integration.reasons];
    return {
      feature,
      accepted: true,
      stale: staleReasons.length > 0,
      staleReasons,
      eligible: !stale.stale && integration.fresh,
      integration,
      current: currentFeatureMetadata(current),
      acceptance: event,
      report: event.report,
    };
  });
}

export async function acceptFeature(projectRoot, options = {}) {
  const feature = validateFeature(options.feature);
  const by = requireText(options.by, 'feature acceptance by');
  const reason = requireText(options.reason, 'feature acceptance reason');
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: true });
  return withExclusiveLock(info.lock, async () => {
    const state = await readState(info);
    let current = await inspectFeature(root, state, feature);
    assertFeatureAcceptanceReady(feature, current);
    const resolved = await resolveConfig(root);
    if (resolved.config.featureIntegration === undefined) {
      throw tinyError('FEATURE_INTEGRATION_CONFIG', 'feature acceptance requires a configured integration command');
    }
    let integration;
    if (resolved.config.featureIntegration !== undefined) {
      const testProtectedPaths = process.env[FEATURE_INTEGRATION_TEST_ENV] === '1'
        ? [...new Set([...current.protectedPaths, ...(options.integrationProtectedPaths ?? resolved.config.featureIntegration.testPaths ?? [])])].sort()
        : current.protectedPaths;
      integration = await runFeatureIntegration(root, {
        feature,
        membership: current.membership,
        activeAcceptanceDigests: current.activeAcceptanceDigests,
        config: resolved.config.featureIntegration,
        protectedPaths: testProtectedPaths,
        ...(options.integrationRunner === undefined ? {} : { runner: options.integrationRunner }),
      });
      const afterState = await readState(info);
      const after = await inspectFeature(root, afterState, feature);
      if (stableStringify(after.membership) !== stableStringify(current.membership)
        || stableStringify(after.activeAcceptanceDigests) !== stableStringify(current.activeAcceptanceDigests)) {
        throw tinyError('FEATURE_INTEGRATION_STALE', 'feature membership or task acceptance changed while the integration check was running');
      }
      const afterConfig = await resolveConfig(root);
      if (afterConfig.config.featureIntegration === undefined) throw tinyError('FEATURE_INTEGRATION_STALE', 'feature integration configuration was removed while the check was running');
      current = after;
    }
    return withUsageLedgerLock(root, async (usageRecords) => {
      const report = await liveFeatureReport(root, feature, current, usageRecords);
      const event = createFeatureAcceptanceEvent({
        feature,
        by,
        reason,
        membership: current.membership,
        activeAcceptanceDigests: current.activeAcceptanceDigests,
        ...(integration === undefined ? {} : { integration: integration.reference }),
        report,
      });
      const appended = await appendFeatureEvent(root, event);
      return {
        feature,
        accepted: true,
        stale: false,
        current: currentFeatureMetadata(current),
        ...(integration === undefined ? {} : { integration: integration.reference }),
        acceptance: appended,
        report: appended.report,
      };
    });
  });
}

async function phaseQualification(root, gate) {
  const qualification = gate?.qualification;
  if (!qualification || qualification.required === false) return undefined;
  const resolved = await resolveConfig(root, { worker: qualification.worker });
  const configured = resolved.config.qualification ?? {};
  const enforced = {
    ...resolved,
    config: {
      ...resolved.config,
      qualification: { ...configured, mode: 'enforce' },
    },
  };
  const assessment = await assessQualification({
    projectRoot: root,
    resolved: enforced,
    workerName: qualification.worker,
    role: qualification.role,
  });
  if (assessment.status !== 'qualified' || typeof assessment.path !== 'string' || typeof assessment.recordDigest !== 'string') {
    throw tinyError('PHASE_QUALIFICATION_REQUIRED', `worker ${qualification.worker} is not currently qualified for ${qualification.role}`, { qualification: assessment });
  }
  const retained = await readQualificationRecord(root, assessment.path);
  return {
    worker: qualification.worker,
    role: qualification.role,
    recordDigest: assessment.recordDigest,
    recordPath: retained.path,
    recordSha256: retained.sha256,
    identityDigest: digestJson(assessment.identity),
  };
}

function phaseCallbacks(root, policy) {
  const resolver = async (producer) => phaseQualification(root, {
    qualification: { worker: producer.worker, role: producer.role, required: true },
  });
  return {
    policy,
    qualificationResolver: resolver,
  };
}

async function resolvedPhasePolicy(root, options = {}) {
  const resolved = await resolveConfig(root, { worker: options.worker });
  return { resolved, policy: resolved.config.phaseGates };
}

export async function recordResearch(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const { policy } = await resolvedPhasePolicy(root, options);
  return recordResearchDecision(root, { ...options, ...phaseCallbacks(root, policy) });
}

export async function recordPhase(projectRoot, options = {}) {
  if (options.phase !== undefined && options.phase !== 'research') {
    throw tinyError('PHASE_UNSUPPORTED', `phase ${options.phase} cannot be recorded yet`, { phase: options.phase });
  }
  return recordResearch(projectRoot, options);
}

export async function phaseStatus(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const { policy } = await resolvedPhasePolicy(root, options);
  return phaseStatusGate(root, { ...options, ...phaseCallbacks(root, policy) });
}

export async function advancePhase(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const { policy } = await resolvedPhasePolicy(root, options);
  return advancePhaseGate(root, { ...options, ...phaseCallbacks(root, policy) });
}

export async function controllerStatus(projectRoot, { feature } = {}) {
  const selectedFeature = feature === undefined ? undefined : validateFeature(feature);
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: false });
  const state = await readState(info);
  const tasks = [];
  for (const task of Object.values(state.tasks)) tasks.push(publicTask(task, await inspectTask(root, state, task)));
  const order = topologicalOrder(state.tasks);
  const orderById = new Map(order.map((id, index) => [id, index + 1]));
  const dependentsById = new Map(order.map((id) => [id, []]));
  for (const task of Object.values(state.tasks)) {
    if (task.closure) continue;
    for (const dependency of task.dependsOn) {
      if (dependentsById.has(dependency)) dependentsById.get(dependency).push(task.id);
    }
  }
  const enriched = tasks.map((task) => ({
    ...task,
    order: orderById.get(task.id),
    dependents: [...dependentsById.get(task.id)].sort(),
  }));
  return {
    schemaVersion: 1,
    ...(selectedFeature === undefined ? {} : { feature: selectedFeature }),
    tasks: selectedFeature === undefined ? enriched : enriched.filter((task) => task.feature === selectedFeature),
  };
}

export async function controllerNext(projectRoot) {
  const result = await controllerStatus(projectRoot);
  const candidate = result.tasks.find((task) => !SETTLED_STATUSES.includes(task.status));
  if (!candidate) return { ...result, next: null };
  const action = candidate.status === 'ready' ? 'ready' : candidate.status;
  return { ...result, next: { action, taskId: candidate.id } };
}

export async function configShow(projectRoot, options = {}) {
  return resolveConfig(projectRoot, options);
}

export async function configValidate(projectRoot, options = {}) {
  const resolved = await resolveConfig(projectRoot, options);
  return { valid: true, ...resolved };
}

export async function dispatchWorker(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const resolved = await resolveConfig(root, { workerName: options.worker });
  if (!resolved.worker || !resolved.workerName) throw tinyError('WORKER_NOT_SELECTED', 'no worker selected; configure defaultWorker or pass --worker');
  const packet = options.baselineRunId
    ? await resolveBenchmarkPacket(root, options.taskId)
    : await resolveTaskPacket(root, options.taskId);
  const qualification = await assessQualification({
    projectRoot: root,
    resolved,
    workerName: resolved.workerName,
    role: 'implement-slice',
    checksDeclared: packet.checks !== undefined && packet.checks !== null,
    runtime: options.runtime,
  });
  let adapter;
  try {
    adapter = await import(new URL('./worker.mjs', import.meta.url));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw tinyError('WORKER_UNAVAILABLE', 'worker adapter is not available yet (src/worker.mjs)');
    throw error;
  }
  if (typeof adapter.runWorker !== 'function') throw tinyError('WORKER_UNAVAILABLE', 'src/worker.mjs does not export runWorker');
  return adapter.runWorker({
    projectRoot: root,
    packet,
    worker: resolved.worker,
    profile: resolved.profile,
    runtime: options.runtime,
    qualification,
    baseRunId: options.baseRunId,
    baselineRunId: options.baselineRunId,
    signal: options.signal,
  });
}

export function createController(projectRoot) {
  return {
    init: (options) => initProject(projectRoot, options),
    addTask: (options) => addTask(projectRoot, options),
    updateTask: (options) => updateTask(projectRoot, options),
    approveTask: (options) => approveTask(projectRoot, options),
    applyTask: (options) => applyTask(projectRoot, options),
    closeTask: (options) => closeTask(projectRoot, options),
    supersedeTask: (options) => supersedeTask(projectRoot, options),
    reviewTask: (options) => reviewTask(projectRoot, options),
    acceptFeature: (options) => acceptFeature(projectRoot, options),
    reportFeature: (options) => reportFeature(projectRoot, options),
    recordResearch: (options) => recordResearch(projectRoot, options),
    recordPhase: (options) => recordPhase(projectRoot, options),
    phaseStatus: (options) => phaseStatus(projectRoot, options),
    advancePhase: (options) => advancePhase(projectRoot, options),
    status: (options) => controllerStatus(projectRoot, options),
    next: () => controllerNext(projectRoot),
    packet: (taskId) => resolveTaskPacket(projectRoot, taskId),
    config: (options) => resolveConfig(projectRoot, options),
    worker: (options) => dispatchWorker(projectRoot, options),
  };
}

export { publicError, TinySDDError };
