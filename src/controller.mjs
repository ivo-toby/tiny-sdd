import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
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
import { compileContext } from './context-compiler.mjs';

export { resolveConfig } from './config.mjs';

export const CONTROLLER_SCHEMA_VERSION = 1;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TASKS_PREFIX = '.tinysdd/tasks/';
const REVIEWS_PREFIX = '.tinysdd/reviews/';

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

function taskBriefOptions() {
  return { tinysddArtifactPrefix: TASKS_PREFIX };
}

function reviewEvidenceOptions() {
  return { tinysddArtifactPrefix: REVIEWS_PREFIX };
}

async function compileTaskContext(projectRoot, path) {
  const text = await readProjectFile(projectRoot, path, taskBriefOptions());
  return compileContext(projectRoot, { path, text, sha256: sha256(text) });
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

function parseIds(value) {
  if (value === undefined || value === '') return [];
  if (!Array.isArray(value) && typeof value !== 'string') throw tinyError('INVALID_ARGUMENT', 'depends-on must be a string or array of strings');
  const values = Array.isArray(value) ? value : String(value).split(',');
  const result = [];
  for (const item of values) {
    if (typeof item !== 'string') throw tinyError('INVALID_ARGUMENT', 'depends-on must contain only strings');
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
    if (task.id !== id || typeof task.brief !== 'string' || !Array.isArray(task.dependsOn) || !Array.isArray(task.allow) || (task.context !== undefined && typeof task.context !== 'string')) {
      throw tinyError('STATE_MALFORMED', `task ${id} has invalid fields`);
    }
    try {
      const brief = normalizeTaskBrief(task.brief, `task ${id}.brief`);
      if (!brief.toLowerCase().endsWith('.md')) throw new Error('brief is not Markdown');
      if (task.context !== undefined) normalizeTaskContext(task.context, `task ${id}.context`);
      for (const dep of task.dependsOn) validateTaskId(dep);
      for (const path of task.allow) normalizeProjectRelative(path, `task ${id}.allow`);
    } catch {
      throw tinyError('STATE_MALFORMED', `task ${id} contains an invalid path or dependency`);
    }
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
  const contextDigest = task.context
    ? await compileTaskContext(projectRoot, task.context).then((compiled) => compiled.sha256).catch(() => undefined)
    : null;
  const dependencyAcceptances = Object.fromEntries(dependencyStates.filter((item) => item.acceptanceDigest).map((item) => [item.id, item.acceptanceDigest]));
  const approval = task.approval;
  const blockedAfterApproval = task.review?.verdict === 'blocked'
    && task.review.approvalDigest === approval?.approvalDigest;
  const approvalBindsTaskShape = Boolean(
    approval
      && stableStringify(approval.dependsOn) === stableStringify(task.dependsOn)
      && stableStringify(approval.allow) === stableStringify(task.allow)
      && (approval.context ?? null) === (task.context ?? null),
  );
  const approvalFresh = Boolean(
    approval
      && briefDigest
      && approval.briefDigest === briefDigest
      && (approval.contextDigest ?? null) === contextDigest
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
  return {
    id: task.id,
    status,
    briefDigest,
    contextDigest,
    approvalFresh,
    blockedBy,
    dependencyAcceptances,
    acceptanceDigest,
    allowedSnapshot,
    allowedDigest,
    evidenceDigest,
  };
}

function assertDependenciesExist(state, id, dependencies) {
  for (const dependency of dependencies) {
    if (dependency === id) throw tinyError('DEPENDENCY_CYCLE', `task ${id} cannot depend on itself`);
    if (!Object.hasOwn(state.tasks, dependency)) throw tinyError('DEPENDENCY_NOT_FOUND', `dependency task does not exist: ${dependency}`);
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
    dependsOn: [...task.dependsOn],
    allow: [...task.allow],
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
    } : undefined,
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
  const brief = normalizeTaskBrief(requireText(options.brief, 'brief'), 'brief');
  if (!brief.toLowerCase().endsWith('.md')) throw tinyError('INVALID_BRIEF', 'brief must be a Markdown file');
  const context = options.context === undefined ? undefined : normalizeTaskContext(requireText(options.context, 'context'), 'context');
  const dependsOn = parseIds(options.dependsOn);
  if (options.allow !== undefined && !Array.isArray(options.allow) && typeof options.allow !== 'string') {
    throw tinyError('INVALID_ARGUMENT', 'allow must be a string or array of strings');
  }
  const allowValues = Array.isArray(options.allow) ? options.allow : String(options.allow ?? '').split(',').filter(Boolean);
  if (allowValues.length === 0) throw tinyError('INVALID_ARGUMENT', 'at least one --allow path is required');
  const allow = [...new Set(allowValues.map((value) => {
    if (typeof value !== 'string') throw tinyError('INVALID_ARGUMENT', 'allow paths must contain only strings');
    return normalizeProjectRelative(value.trim(), 'allow path');
  }))].sort();
  const root = await canonicalProjectRoot(projectRoot);
  await readProjectFile(root, brief, taskBriefOptions());
  if (context !== undefined) await readProjectFile(root, context, taskBriefOptions());
  for (const path of allow) {
    const absolute = await assertInternalPath(root, path.split('/'), { allowMissing: true });
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) throw tinyError('INVALID_FILE', `allowed path must be a regular file: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return mutateState(root, async (state) => {
    if (Object.hasOwn(state.tasks, id)) throw tinyError('TASK_EXISTS', `task already exists: ${id}`);
    assertDependenciesExist(state, id, dependsOn);
    const timestamp = nowIso();
    state.tasks[id] = {
      id,
      brief,
      ...(context === undefined ? {} : { context }),
      dependsOn,
      allow,
      createdAt: timestamp,
      approval: undefined,
      review: undefined,
    };
    return { task: { id, brief, ...(context === undefined ? {} : { context }), dependsOn, allow } };
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
    const status = await inspectTask(root, state, task);
    if (status.blockedBy.length > 0) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `task ${id} is blocked by: ${status.blockedBy.join(', ')}`);
    const briefDigest = await digestProjectFile(root, task.brief, taskBriefOptions()).catch(() => { throw tinyError('BRIEF_MISSING', `brief is missing: ${task.brief}`); });
    const contextDigest = task.context
      ? await compileTaskContext(root, task.context).then((compiled) => compiled.sha256).catch((error) => {
        if (error?.code === 'ENOENT' || error?.code === 'PATH_NOT_FOUND') throw tinyError('CONTEXT_MISSING', `context manifest is missing: ${task.context}`);
        throw error;
      })
      : null;
    const dependencyAcceptances = {};
    for (const dependency of task.dependsOn) {
      const dependencyState = await inspectTask(root, state, state.tasks[dependency]);
      if (!dependencyState.acceptanceDigest) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `dependency is not accepted: ${dependency}`);
      dependencyAcceptances[dependency] = dependencyState.acceptanceDigest;
    }
    const approvedAt = nowIso();
    const approvalBase = { taskId: id, briefDigest, context: task.context ?? null, contextDigest, dependsOn: [...task.dependsOn], allow: [...task.allow], dependencyAcceptances, by, reason, approvedAt };
    task.approval = { ...approvalBase, approvalDigest: digestJson(approvalBase) };
    return { task: publicTask(task, await inspectTask(root, state, task)) };
  });
}

export async function resolveTaskPacket(projectRoot, taskId) {
  const id = validateTaskId(taskId);
  const root = await canonicalProjectRoot(projectRoot);
  const info = await layout(root, { create: false });
  const state = await readState(info);
  if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
  const task = state.tasks[id];
  const status = await inspectTask(root, state, task);
  if (status.status === 'accepted') throw tinyError('TASK_ALREADY_ACCEPTED', `task ${id} is already accepted`);
  if (status.status !== 'ready') {
    throw tinyError('TASK_NOT_READY', `task ${id} is ${status.status}`, { status: status.status, blockedBy: status.blockedBy });
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
    dependencies: task.dependsOn.map((dependency) => ({ id: dependency, acceptanceDigest: status.dependencyAcceptances[dependency] })),
    approval: { ...task.approval },
    ...(context === undefined ? {} : { context }),
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
  return {
    schemaVersion: 1,
    taskId: id,
    brief: { path: task.brief, text, sha256: sha256(text) },
    allowedPaths: [...task.allow],
    dependencies: task.dependsOn.map((dependency) => ({ id: dependency, acceptanceDigest: task.approval.dependencyAcceptances?.[dependency] })),
    approval: { ...task.approval },
    ...(context === undefined ? {} : { context }),
  };
}

export const resolvePacket = resolveTaskPacket;

export async function reviewTask(projectRoot, options = {}) {
  const id = validateTaskId(options.id);
  const verdict = options.verdict;
  if (!['accepted', 'revision', 'blocked'].includes(verdict)) throw tinyError('INVALID_VERDICT', 'verdict must be accepted, revision, or blocked');
  const by = requireText(options.by, 'review by');
  const evidence = normalizeReviewEvidence(requireText(options.evidence, 'evidence'), 'evidence');
  const root = await canonicalProjectRoot(projectRoot);
  await readProjectFile(root, evidence, reviewEvidenceOptions());
  return mutateState(root, async (state) => {
    if (!Object.hasOwn(state.tasks, id)) throw tinyError('TASK_NOT_FOUND', `unknown task: ${id}`);
    const task = state.tasks[id];
    const status = await inspectTask(root, state, task);
    if (status.blockedBy.length > 0) throw tinyError('PREREQUISITES_NOT_ACCEPTED', `task ${id} is blocked by: ${status.blockedBy.join(', ')}`);
    if (!task.approval || !status.approvalFresh) throw tinyError('APPROVAL_STALE', `task ${id} does not have a current approval`);
    const evidenceContent = await readProjectFile(root, evidence, reviewEvidenceOptions());
    if (evidenceContent.trim().length === 0) throw tinyError('INVALID_EVIDENCE', 'evidence must be nonempty');
    const allowedSnapshot = await snapshotProjectFiles(root, task.allow);
    const reviewedAt = nowIso();
    const review = {
      verdict,
      by,
      reviewedAt,
      evidence,
      evidenceDigest: sha256(evidenceContent),
      briefDigest: status.briefDigest,
      approvalDigest: task.approval.approvalDigest,
      allowedDigest: digestJson(allowedSnapshot),
    };
    if (verdict === 'accepted') review.acceptanceDigest = digestJson({ ...review, taskId: id });
    task.review = review;
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
  const candidate = result.tasks.find((task) => task.status !== 'accepted');
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
  });
}

export function createController(projectRoot) {
  return {
    init: (options) => initProject(projectRoot, options),
    addTask: (options) => addTask(projectRoot, options),
    approveTask: (options) => approveTask(projectRoot, options),
    reviewTask: (options) => reviewTask(projectRoot, options),
    status: () => controllerStatus(projectRoot),
    next: () => controllerNext(projectRoot),
    packet: (taskId) => resolveTaskPacket(projectRoot, taskId),
    config: (options) => resolveConfig(projectRoot, options),
    worker: (options) => dispatchWorker(projectRoot, options),
  };
}

export { publicError, TinySDDError };
