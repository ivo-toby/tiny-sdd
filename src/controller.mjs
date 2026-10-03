import { join } from 'node:path';
import { lstat, readFile, rm } from 'node:fs/promises';
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

export { resolveConfig } from './config.mjs';

export const CONTROLLER_SCHEMA_VERSION = 1;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TASKS_PREFIX = '.tinysdd/tasks/';
const REVIEWS_PREFIX = '.tinysdd/reviews/';
const RUN_ID_PATTERN = /^worker-[0-9A-Za-z-]+$/;
const MAX_APPLY_LINEAGE = 32;
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

function normalizeTaskShape(options) {
  const brief = normalizeTaskBrief(requireText(options.brief, 'brief'), 'brief');
  if (!brief.toLowerCase().endsWith('.md')) throw tinyError('INVALID_BRIEF', 'brief must be a Markdown file');
  const context = options.context === undefined ? undefined : normalizeTaskContext(requireText(options.context, 'context'), 'context');
  const checks = options.checks === undefined ? undefined : normalizeTaskChecks(requireText(options.checks, 'checks'), 'checks');
  const dependsOn = parseIds(options.dependsOn);
  const allow = normalizeTaskPaths(options.allow, 'allow', { required: true });
  const protect = normalizeTaskPaths(options.protect, 'protect');
  assertProtectAllowDisjoint(allow, protect);
  return {
    brief,
    ...(context === undefined ? {} : { context }),
    ...(checks === undefined ? {} : { checks }),
    dependsOn,
    allow,
    ...(protect.length > 0 ? { protect } : {}),
  };
}

const TASK_SHAPE_FIELDS = ['brief', 'context', 'checks', 'allow', 'protect', 'dependsOn'];

function taskShape(task) {
  return structuredClone(Object.fromEntries(TASK_SHAPE_FIELDS.filter((field) => task[field] !== undefined).map((field) => [field, task[field]])));
}

function assertProtectAllowDisjoint(allow, protect) {
  const paths = protect.filter((path) => allow.includes(path));
  if (paths.length > 0) throw tinyError('PROTECT_ALLOW_OVERLAP', `protected paths overlap allowed paths: ${paths.join(', ')}`, { paths });
}

async function validateTaskInputs(root, task) {
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
  return compiled;
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
  try {
    if (task.protect !== undefined && (!Array.isArray(task.protect) || task.protect.length === 0)) throw new Error('protect must be nonempty');
    normalizeTaskShape(task);
    for (const dependency of task.dependsOn) validateTaskId(dependency);
    for (const path of [...task.allow, ...(task.protect ?? [])]) normalizeProjectRelative(path, `task ${id} path`);
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
  }
  return value;
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
  const protectDigest = await protectedFilesDigest(projectRoot, task.protect).catch(() => undefined);
  const dependencyAcceptances = Object.fromEntries(dependencyStates.filter((item) => item.acceptanceDigest).map((item) => [item.id, item.acceptanceDigest]));
  const approval = task.approval;
  const blockedAfterApproval = task.review?.verdict === 'blocked'
    && task.review.approvalDigest === approval?.approvalDigest;
  const approvalBindsTaskShape = Boolean(
    approval
      && stableStringify(approval.dependsOn) === stableStringify(task.dependsOn)
      && stableStringify(approval.allow) === stableStringify(task.allow)
      && (approval.context ?? null) === (task.context ?? null)
      && (approval.checks ?? null) === (task.checks ?? null)
      && stableStringify(approval.protect ?? null) === stableStringify(task.protect ?? null),
  );
  const approvalFresh = Boolean(
    approval
      && briefDigest
      && approval.briefDigest === briefDigest
      && contextDigestMatches(approval.contextDigest ?? null, contextDigest, compiledContext?.legacySha256)
      && (approval.checksDigest ?? null) === checksDigest
      && (approval.protectDigest ?? null) === protectDigest
      && approvalBindsTaskShape
      && task.dependsOn.every((dependency) => (
        Object.hasOwn(approval.dependencyAcceptances ?? {}, dependency)
        && approval.dependencyAcceptances[dependency] === dependencyAcceptances[dependency]
      ))
      && !blockedAfterApproval,
  );
  let allowedDigest;
  let allowedSnapshot;
  if (task.review?.verdict === 'accepted' && approvalFresh) {
    allowedSnapshot = await snapshotProjectFiles(projectRoot, task.allow).catch(() => undefined);
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
      && task.review.allowedDigest === allowedDigest,
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
    brief: task.brief,
    ...(task.context ? { context: task.context } : {}),
    ...(task.checks ? { checks: task.checks } : {}),
    dependsOn: [...task.dependsOn],
    allow: [...task.allow],
    ...(task.protect ? { protect: [...task.protect] } : {}),
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
  const { brief, context, checks, dependsOn, allow, protect } = normalizeTaskShape(options);
  const root = await canonicalProjectRoot(projectRoot);
  const compiled = await validateTaskInputs(root, { brief, context, checks, allow, protect });
  return mutateState(root, async (state) => {
    if (Object.hasOwn(state.tasks, id)) throw tinyError('TASK_EXISTS', `task already exists: ${id}`);
    assertDependenciesExist(state, id, dependsOn);
    const timestamp = nowIso();
    state.tasks[id] = {
      id,
      brief,
      ...(context === undefined ? {} : { context }),
      ...(checks === undefined ? {} : { checks }),
      dependsOn,
      allow,
      ...(protect ? { protect } : {}),
      createdAt: timestamp,
      approval: undefined,
      review: undefined,
    };
    return { task: { id, brief, ...(context === undefined ? {} : { context }), ...(checks === undefined ? {} : { checks }), dependsOn, allow, ...(protect ? { protect } : {}) }, sizing: taskSizing(allow, compiled) };
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
    const compiled = await validateTaskInputs(root, shape);
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
    const protectDigest = await protectedFilesDigest(root, task.protect);
    const approvedAt = nowIso();
    const approvalBase = { taskId: id, briefDigest, context: task.context ?? null, contextDigest, checks: task.checks ?? null, checksDigest, protect: task.protect ?? null, protectDigest, dependsOn: [...task.dependsOn], allow: [...task.allow], dependencyAcceptances, by, reason, approvedAt };
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

// Follows result.baseRun.id parents the way the worker does when it builds a
// revision. Returns the runs earliest first: the root's workspace-before is the
// project state the lineage started from, the last run's workspace-after is the
// candidate.
async function loadApplyLineage(root, task, runId) {
  const allowed = new Set(task.allow);
  const newestFirst = [];
  const seen = new Set();
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
      throw tinyError('RUN_SCOPE_VIOLATION', `run ${currentId} changed paths outside the task allowlist`, { runId: currentId, paths: result.scopeViolations.map((violation) => violation?.path) });
    }
    // A revision's base can predate unrelated project changes, so the recorded
    // changes are checked here instead of diffing whole workspaces.
    const outside = result.changedPaths.map((change) => change?.path).filter((path) => typeof path !== 'string' || !allowed.has(path));
    if (outside.length > 0) throw tinyError('RUN_SCOPE_VIOLATION', `run ${currentId} changed paths outside the task allowlist`, { runId: currentId, paths: outside });
    newestFirst.push({ id: currentId, result });
    const parentId = result.baseRun?.id;
    if (parentId === undefined || parentId === null) break;
    if (typeof parentId !== 'string' || !RUN_ID_PATTERN.test(parentId)) throw tinyError('RUN_MALFORMED', `run ${currentId} has an invalid base run id`, { runId: currentId });
    currentId = parentId;
  }
  return newestFirst.reverse();
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
  return { bytes: await readFile(absolute), mode: info.mode & 0o777 };
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
    await runArtifactPath(root, rootRun.id, ['workspace-before'], { requireDirectory: true });
    await runArtifactPath(root, finalRun.id, ['workspace-after'], { requireDirectory: true });

    // Plan everything, and refuse on drift, before the first write. Only paths
    // the lineage recorded as changed are applied: a revision's workspaces also
    // carry whatever the project held at its dispatch, which is not the run's work.
    const recorded = new Set(lineage.flatMap((run) => run.result.changedPaths.map((change) => change.path)));
    const plan = [];
    const conflicts = [];
    for (const path of task.allow) {
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
    const inputs = new Set([task.brief, task.context, task.checks].filter(Boolean));
    const rewritten = plan.filter((item) => item.status === 'written' && inputs.has(item.path)).map((item) => item.path);
    if (rewritten.length > 0) {
      throw tinyError('APPLY_CHANGES_TASK_INPUT', `run ${finalRun.id} would rewrite the approval inputs of task ${id}: ${rewritten.join(', ')}; nothing was written`, { paths: rewritten, runId: finalRun.id });
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
    await snapshotProjectFiles(root, task.allow);
    for (const item of plan) {
      if (item.status !== 'written') continue;
      if (item.change === 'deleted') await rm(item.absolute, { force: true });
      else await atomicWriteFile(item.absolute, item.after.bytes, { mode: item.after.mode });
    }
    task.applied = {
      runId: finalRun.id,
      rootRunId: rootRun.id,
      appliedAt: nowIso(),
      by,
      allowedDigest: await allowedFilesDigest(root, task.allow),
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
    allowedPaths: [...task.allow],
    ...(task.protect ? { protectedPaths: [...task.protect] } : {}),
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
    allowedPaths: [...task.allow],
    ...(task.protect ? { protectedPaths: [...task.protect] } : {}),
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
    const allowedDigest = await allowedFilesDigest(root, task.allow);
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

export async function controllerStatus(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: false });
  const state = await readState(info);
  const tasks = [];
  for (const task of Object.values(state.tasks)) tasks.push(publicTask(task, await inspectTask(root, state, task)));
  return { schemaVersion: 1, tasks };
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
    status: () => controllerStatus(projectRoot),
    next: () => controllerNext(projectRoot),
    packet: (taskId) => resolveTaskPacket(projectRoot, taskId),
    config: (options) => resolveConfig(projectRoot, options),
    worker: (options) => dispatchWorker(projectRoot, options),
  };
}

export { publicError, TinySDDError };
