import { appendFile, lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertExactKeys,
  assertInternalPath,
  assertPlainObject,
  canonicalProjectRoot,
  ensureDirectory,
  stableStringify,
  tinyError,
  withExclusiveLock,
} from './fs-utils.mjs';
import { USAGE_PHASES } from './usage.mjs';
import {
  USAGE_REPORT_SCHEMA_VERSION,
  USAGE_REPORT_TYPE,
  USAGE_UNKNOWN,
  freezeUsageReport,
} from './usage-report.mjs';

export const FEATURE_EVENT_SCHEMA_VERSION = 1;
export const FEATURE_ACCEPTANCE_EVENT_TYPE = 'feature-acceptance';
export const FEATURE_EVENTS_RELATIVE_PATH = '.tinysdd/runs/feature-events.jsonl';
export const FEATURE_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
export const FEATURE_EVENT_MAX_BYTES = 512 * 1024;
export const FEATURE_EVENTS_MAX_RECORDS = 4096;
export const FEATURE_EVENT_MAX_TASKS = 256;

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const USAGE_COMPONENTS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'totalTokens'];
const EVENT_KEYS = ['schemaVersion', 'type', 'id', 'timestamp', 'feature', 'by', 'reason', 'membership', 'activeAcceptanceDigests', 'report'];
const MEMBERSHIP_KEYS = ['id', 'retired'];
const REPORT_KEYS = ['schemaVersion', 'type', 'feature', 'generatedAt', 'tasks', 'frontier', 'local', 'provenance', 'snapshot'];
const METRIC_KEYS = [...USAGE_COMPONENTS, 'knownSubtotals', 'coverage', 'missing'];
const FRONTIER_KEYS = ['byPhase', 'totals', 'ledgerRecordIds'];
const LOCAL_KEYS = ['byTask', 'totals', 'runIds', 'revisionRunIds'];
const TASK_REPORT_KEYS = ['taskId', 'feature', 'retired', 'runIds'];
const TASK_SUMMARY_KEYS = ['taskId', 'retired', ...USAGE_COMPONENTS, 'knownSubtotals', 'coverage', 'missing', 'runIds', 'revisionRunIds', 'elapsedMs', 'knownElapsedMs'];
const PROVENANCE_KEYS = ['ledgerRecordIds', 'runReferences', 'missing'];
const SNAPSHOT_KEYS = ['ledgerRecordIds', 'runReferences', 'missing'];
const RUN_REFERENCE_KEYS = ['runId', 'taskId', 'result', 'stdout', 'outcome', 'baseRunId', 'baselineRunId'];
const FILE_REFERENCE_KEYS = ['runId', 'path', 'sha256'];

function eventError(message, details = undefined) {
  throw tinyError('FEATURE_EVENT_INVALID', message, details);
}

function plainObject(value, label) {
  try {
    const object = assertPlainObject(value, 'FEATURE_EVENT_INVALID', label);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) eventError(`${label} must be a plain object`);
    return object;
  } catch (error) {
    if (error?.code === 'FEATURE_EVENT_INVALID') throw error;
    eventError(error instanceof Error ? error.message : `${label} must be an object`);
  }
}

function text(value, label, max = 512) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    eventError(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function identifier(value, label, pattern = ID_PATTERN, max = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) eventError(`${label} has an invalid format`);
  return value;
}

function timestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) eventError(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function boundedArray(value, label, max = FEATURE_EVENT_MAX_TASKS) {
  if (!Array.isArray(value) || value.length > max) eventError(`${label} must be a bounded array`);
  return value;
}

function exactObject(value, keys, label) {
  const object = plainObject(value, label);
  assertExactKeys(object, keys, 'FEATURE_EVENT_INVALID', label);
  return object;
}

function boundedIdentifierList(value, label) {
  return boundedArray(value, label, FEATURE_EVENTS_MAX_RECORDS).map((item, index) => identifier(item, `${label}[${index}]`));
}

function validateMetric(value, label, allowedKeys = METRIC_KEYS) {
  const metric = exactObject(value, allowedKeys, label);
  for (const component of USAGE_COMPONENTS) {
    if (!(metric[component] === USAGE_UNKNOWN || (Number.isSafeInteger(metric[component]) && metric[component] >= 0))) eventError(`${label}.${component} must be a nonnegative safe integer or UNKNOWN`);
  }
  const subtotals = exactObject(metric.knownSubtotals, USAGE_COMPONENTS, `${label}.knownSubtotals`);
  for (const component of USAGE_COMPONENTS) {
    if (subtotals[component] !== null && (!Number.isSafeInteger(subtotals[component]) || subtotals[component] < 0)) eventError(`${label}.knownSubtotals.${component} must be a nonnegative safe integer or null`);
  }
  const coverage = exactObject(metric.coverage, USAGE_COMPONENTS, `${label}.coverage`);
  for (const component of USAGE_COMPONENTS) {
    const item = exactObject(coverage[component], ['observed', 'expected', 'complete'], `${label}.coverage.${component}`);
    if (!Number.isSafeInteger(item.observed) || item.observed < 0) eventError(`${label}.coverage.${component}.observed must be a nonnegative safe integer`);
    if (item.expected !== null && (!Number.isSafeInteger(item.expected) || item.expected < 0)) eventError(`${label}.coverage.${component}.expected must be a nonnegative safe integer or null`);
    if (typeof item.complete !== 'boolean') eventError(`${label}.coverage.${component}.complete must be boolean`);
    if (item.complete && (metric[component] === USAGE_UNKNOWN || item.expected === null || item.observed !== item.expected)) eventError(`${label}.coverage.${component} cannot be complete without full numeric coverage`);
    if (Number.isSafeInteger(metric[component]) && (!item.complete || item.expected === null || item.expected === 0 || item.observed !== item.expected)) {
      eventError(`${label}.${component} cannot be numeric without complete coverage`);
    }
    if (Number.isSafeInteger(metric[component]) && subtotals[component] !== metric[component]) {
      eventError(`${label}.knownSubtotals.${component} must match its complete value`);
    }
  }
  boundedArray(metric.missing, `${label}.missing`, FEATURE_EVENTS_MAX_RECORDS).forEach((reason, index) => text(reason, `${label}.missing[${index}]`));
}

function validateFileReference(value, label, runId, kind) {
  const reference = exactObject(value, FILE_REFERENCE_KEYS, label);
  identifier(reference.runId, `${label}.runId`);
  if (reference.runId !== runId) eventError(`${label}.runId must match its enclosing run reference`);
  text(reference.path, `${label}.path`, 512);
  if (reference.sha256 !== null && (typeof reference.sha256 !== 'string' || !DIGEST_PATTERN.test(reference.sha256))) eventError(`${label}.sha256 must be a digest or null`);
  const expectedPath = kind === 'result'
    ? `.tinysdd/runs/${runId}/result.json`
    : `.tinysdd/runs/${runId}/stdout.jsonl`;
  if (reference.path !== expectedPath) eventError(`${label}.path must remain inside its run directory`);
}

function validateRunReferences(value, label) {
  boundedArray(value, label, FEATURE_EVENTS_MAX_RECORDS).forEach((raw, index) => {
    const itemLabel = `${label}[${index}]`;
    const reference = exactObject(raw, RUN_REFERENCE_KEYS, itemLabel);
    identifier(reference.runId, `${itemLabel}.runId`);
    identifier(reference.taskId, `${itemLabel}.taskId`);
    validateFileReference(reference.result, `${itemLabel}.result`, reference.runId, 'result');
    validateFileReference(reference.stdout, `${itemLabel}.stdout`, reference.runId, 'stdout');
    text(reference.outcome, `${itemLabel}.outcome`);
    for (const field of ['baseRunId', 'baselineRunId']) {
      if (reference[field] !== null) identifier(reference[field], `${itemLabel}.${field}`);
    }
  });
}

function validateMissing(value, label) {
  boundedArray(value, label, FEATURE_EVENTS_MAX_RECORDS).forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) eventError(`${label}[${index}] must be an object`);
  });
}

function validateElapsedConsistency(value, known, label) {
  if (Number.isSafeInteger(value) && known !== value) eventError(`${label}.knownElapsedMs must match its complete value`);
}

function validateReport(value, feature) {
  const report = exactObject(value, REPORT_KEYS, 'report');
  if (report.schemaVersion !== USAGE_REPORT_SCHEMA_VERSION || report.type !== USAGE_REPORT_TYPE) eventError('report has an unsupported schema');
  if (report.feature !== feature) eventError('report feature does not match event feature');
  timestamp(report.generatedAt, 'report.generatedAt');
  const reportTasks = boundedArray(report.tasks, 'report.tasks').map((raw, index) => {
    const label = `report.tasks[${index}]`;
    const task = exactObject(raw, TASK_REPORT_KEYS, label);
    identifier(task.taskId, `${label}.taskId`);
    if (task.feature !== feature) eventError(`${label}.feature does not match report feature`);
    identifier(task.feature, `${label}.feature`, FEATURE_PATTERN, 64);
    if (typeof task.retired !== 'boolean') eventError(`${label}.retired must be boolean`);
    const runIds = boundedIdentifierList(task.runIds, `${label}.runIds`);
    for (let runIndex = 1; runIndex < runIds.length; runIndex += 1) {
      if (runIds[runIndex - 1].localeCompare(runIds[runIndex]) >= 0) eventError(`${label}.runIds must be sorted and unique`);
    }
    return { taskId: task.taskId, retired: task.retired, runIds };
  });
  for (let index = 1; index < reportTasks.length; index += 1) {
    if (reportTasks[index - 1].taskId.localeCompare(reportTasks[index].taskId) >= 0) eventError('report.tasks must be sorted by task id');
  }

  const frontier = exactObject(report.frontier, FRONTIER_KEYS, 'report.frontier');
  const byPhase = plainObject(frontier.byPhase, 'report.frontier.byPhase');
  const phaseKeys = Object.keys(byPhase);
  if (phaseKeys.length !== USAGE_PHASES.length || phaseKeys.some((phase, index) => phase !== USAGE_PHASES[index])) eventError('report.frontier.byPhase must contain the canonical usage phases');
  for (const [phase, raw] of Object.entries(byPhase)) {
    const label = `report.frontier.byPhase.${phase}`;
    const phaseReport = exactObject(raw, [...METRIC_KEYS, 'ledgerRecordIds'], label);
    validateMetric(phaseReport, label, [...METRIC_KEYS, 'ledgerRecordIds']);
    boundedIdentifierList(phaseReport.ledgerRecordIds, `${label}.ledgerRecordIds`);
  }
  validateMetric(frontier.totals, 'report.frontier.totals');
  boundedIdentifierList(frontier.ledgerRecordIds, 'report.frontier.ledgerRecordIds');

  const local = exactObject(report.local, LOCAL_KEYS, 'report.local');
  const byTask = plainObject(local.byTask, 'report.local.byTask');
  for (const [taskId, raw] of Object.entries(byTask)) {
    const label = `report.local.byTask.${taskId}`;
    const task = exactObject(raw, TASK_SUMMARY_KEYS, label);
    identifier(taskId, label);
    if (task.taskId !== taskId) eventError(`${label}.taskId must match its key`);
    if (typeof task.retired !== 'boolean') eventError(`${label}.retired must be boolean`);
    validateMetric(task, label, TASK_SUMMARY_KEYS);
    boundedIdentifierList(task.runIds, `${label}.runIds`);
    boundedIdentifierList(task.revisionRunIds, `${label}.revisionRunIds`);
    if (task.elapsedMs !== USAGE_UNKNOWN && (!Number.isSafeInteger(task.elapsedMs) || task.elapsedMs < 0)) eventError(`${label}.elapsedMs must be a nonnegative safe integer or UNKNOWN`);
    if (task.knownElapsedMs !== null && (!Number.isSafeInteger(task.knownElapsedMs) || task.knownElapsedMs < 0)) eventError(`${label}.knownElapsedMs must be a nonnegative safe integer or null`);
    validateElapsedConsistency(task.elapsedMs, task.knownElapsedMs, label);
  }
  validateMetric(local.totals, 'report.local.totals', [...METRIC_KEYS, 'elapsedMs', 'knownElapsedMs']);
  if (local.totals.elapsedMs !== USAGE_UNKNOWN && (!Number.isSafeInteger(local.totals.elapsedMs) || local.totals.elapsedMs < 0)) eventError('report.local.totals.elapsedMs must be a nonnegative safe integer or UNKNOWN');
  if (local.totals.knownElapsedMs !== null && (!Number.isSafeInteger(local.totals.knownElapsedMs) || local.totals.knownElapsedMs < 0)) eventError('report.local.totals.knownElapsedMs must be a nonnegative safe integer or null');
  validateElapsedConsistency(local.totals.elapsedMs, local.totals.knownElapsedMs, 'report.local.totals');
  const reportTaskIds = new Set(reportTasks.map((task) => task.taskId));
  const localTaskIds = Object.keys(byTask);
  if (localTaskIds.length !== reportTaskIds.size || localTaskIds.some((taskId) => !reportTaskIds.has(taskId))) eventError('report.local.byTask must match report.tasks');
  boundedIdentifierList(local.runIds, 'report.local.runIds');
  boundedIdentifierList(local.revisionRunIds, 'report.local.revisionRunIds');

  for (const [name, keys, value] of [
    ['provenance', PROVENANCE_KEYS, report.provenance],
    ['snapshot', SNAPSHOT_KEYS, report.snapshot],
  ]) {
    const section = exactObject(value, keys, `report.${name}`);
    boundedIdentifierList(section.ledgerRecordIds, `report.${name}.ledgerRecordIds`);
    validateRunReferences(section.runReferences, `report.${name}.runReferences`);
    validateMissing(section.missing, `report.${name}.missing`);
  }
  const reportTaskById = new Map(reportTasks.map((task) => [task.taskId, task]));
  for (const [taskId, task] of Object.entries(byTask)) {
    if (task.retired !== reportTaskById.get(taskId).retired) eventError(`${taskId} retirement status must match report.tasks`);
  }
  const provenanceReferences = report.provenance.runReferences;
  for (let index = 1; index < provenanceReferences.length; index += 1) {
    if (provenanceReferences[index - 1].runId.localeCompare(provenanceReferences[index].runId) >= 0) eventError('report.provenance.runReferences must be sorted by run id');
  }
  for (const reference of provenanceReferences) {
    if (!reportTaskById.has(reference.taskId)) eventError(`run reference task ${reference.taskId} is outside report membership`);
  }
  const sortedUnique = (values) => [...new Set(values)].sort();
  const provenanceRunIds = sortedUnique(provenanceReferences.map((reference) => reference.runId));
  if (stableStringify(local.runIds) !== stableStringify(provenanceRunIds)) eventError('report.local.runIds must match report provenance references');
  const provenanceRevisionRunIds = sortedUnique(provenanceReferences.filter((reference) => reference.baseRunId !== null).map((reference) => reference.runId));
  if (stableStringify(local.revisionRunIds) !== stableStringify(provenanceRevisionRunIds)) eventError('report.local.revisionRunIds must match report provenance references');
  for (const [taskId, task] of Object.entries(byTask)) {
    const taskRunIds = sortedUnique(provenanceReferences.filter((reference) => reference.taskId === taskId).map((reference) => reference.runId));
    const taskRevisionRunIds = sortedUnique(provenanceReferences.filter((reference) => reference.taskId === taskId && reference.baseRunId !== null).map((reference) => reference.runId));
    if (stableStringify(task.runIds) !== stableStringify(taskRunIds)) eventError(`${taskId}.runIds must match report provenance references`);
    if (stableStringify(task.revisionRunIds) !== stableStringify(taskRevisionRunIds)) eventError(`${taskId}.revisionRunIds must match report provenance references`);
  }
  for (const task of reportTasks) {
    const provenanceTaskRunIds = new Set(provenanceReferences.filter((reference) => reference.taskId === task.taskId).map((reference) => reference.runId));
    if (task.runIds.some((runId) => !provenanceTaskRunIds.has(runId))) eventError(`${task.taskId}.runIds must be present in report provenance references`);
  }
  const phaseLedgerRecordIds = sortedUnique(USAGE_PHASES.flatMap((phase) => report.frontier.byPhase[phase].ledgerRecordIds));
  if (stableStringify(frontier.ledgerRecordIds) !== stableStringify(phaseLedgerRecordIds)) eventError('report.frontier.ledgerRecordIds must match phase records');
  if (stableStringify(frontier.ledgerRecordIds) !== stableStringify(report.provenance.ledgerRecordIds)) eventError('report.frontier.ledgerRecordIds must match report provenance');
  if (stableStringify(report.snapshot.ledgerRecordIds) !== stableStringify(report.provenance.ledgerRecordIds)
    || stableStringify(report.snapshot.runReferences) !== stableStringify(report.provenance.runReferences)
    || stableStringify(report.snapshot.missing) !== stableStringify(report.provenance.missing)) {
    eventError('report.snapshot must match report.provenance');
  }
  return reportTasks;
}

function normalizeMembership(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > FEATURE_EVENT_MAX_TASKS) eventError(`membership must contain 1-${FEATURE_EVENT_MAX_TASKS} tasks`);
  const membership = value.map((item, index) => {
    const object = plainObject(item, `membership[${index}]`);
    try {
      assertExactKeys(object, MEMBERSHIP_KEYS, 'FEATURE_EVENT_INVALID', `membership[${index}]`);
    } catch (error) {
      if (error?.code === 'FEATURE_EVENT_INVALID') throw error;
      eventError(error instanceof Error ? error.message : `membership[${index}] has unknown fields`);
    }
    if (typeof object.retired !== 'boolean') eventError(`membership[${index}].retired must be boolean`);
    return {
      id: identifier(object.id, `membership[${index}].id`),
      retired: object.retired === true,
    };
  });
  const ids = new Set();
  for (let index = 0; index < membership.length; index += 1) {
    const item = membership[index];
    if (ids.has(item.id)) eventError(`membership contains duplicate task: ${item.id}`);
    if (index > 0 && membership[index - 1].id.localeCompare(item.id) >= 0) eventError('membership must be sorted by task id');
    ids.add(item.id);
  }
  return membership;
}

function normalizeActiveAcceptanceDigests(value, membership) {
  const object = plainObject(value, 'activeAcceptanceDigests');
  const keys = Object.keys(object);
  if (keys.some((key, index) => index > 0 && keys[index - 1].localeCompare(key) >= 0)) eventError('activeAcceptanceDigests must be sorted by task id');
  const active = new Set(membership.filter((item) => !item.retired).map((item) => item.id));
  if (keys.some((key) => !active.has(key)) || keys.length !== active.size) eventError('activeAcceptanceDigests must contain exactly every non-retired task');
  return Object.fromEntries(keys.map((key) => [identifier(key, `activeAcceptanceDigests.${key}`), identifier(object[key], `activeAcceptanceDigests.${key}`, DIGEST_PATTERN, 64)]));
}

function normalizeReport(value, feature) {
  const report = plainObject(value, 'report');
  validateReport(report, feature);
  let cloned;
  try {
    cloned = freezeUsageReport(report);
  } catch {
    eventError('report cannot be cloned');
  }
  const bytes = Buffer.byteLength(JSON.stringify(cloned));
  if (bytes > FEATURE_EVENT_MAX_BYTES) eventError(`report exceeds ${FEATURE_EVENT_MAX_BYTES} bytes`);
  return cloned;
}

export function normalizeFeatureEvent(value) {
  const raw = plainObject(value, 'feature event');
  try {
    assertExactKeys(raw, EVENT_KEYS, 'FEATURE_EVENT_INVALID', 'feature event');
  } catch (error) {
    if (error?.code === 'FEATURE_EVENT_INVALID') throw error;
    eventError(error instanceof Error ? error.message : 'feature event has unknown fields');
  }
  if (raw.schemaVersion !== FEATURE_EVENT_SCHEMA_VERSION) eventError(`feature event schemaVersion must be ${FEATURE_EVENT_SCHEMA_VERSION}`);
  if (raw.type !== FEATURE_ACCEPTANCE_EVENT_TYPE) eventError(`feature event type must be ${FEATURE_ACCEPTANCE_EVENT_TYPE}`);
  const feature = identifier(raw.feature, 'feature', FEATURE_PATTERN, 64);
  const membership = normalizeMembership(raw.membership);
  const activeAcceptanceDigests = normalizeActiveAcceptanceDigests(raw.activeAcceptanceDigests, membership);
  const event = {
    schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
    type: FEATURE_ACCEPTANCE_EVENT_TYPE,
    id: identifier(raw.id, 'id'),
    timestamp: timestamp(raw.timestamp),
    feature,
    by: text(raw.by, 'by'),
    reason: text(raw.reason, 'reason'),
    membership,
    activeAcceptanceDigests,
    report: normalizeReport(raw.report, feature),
  };
  const reportMembership = event.report.tasks.map((task) => ({ id: task.taskId, retired: task.retired }));
  if (stableStringify(reportMembership) !== stableStringify(membership)) eventError('report.tasks must match event membership');
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (bytes > FEATURE_EVENT_MAX_BYTES) eventError(`feature event exceeds ${FEATURE_EVENT_MAX_BYTES} bytes`);
  return deepFreeze(event);
}

export function createFeatureAcceptanceEvent({ feature, by, reason, membership, activeAcceptanceDigests, report, timestamp: at = new Date().toISOString(), id = `feature-${randomUUID()}` } = {}) {
  return normalizeFeatureEvent({
    schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
    type: FEATURE_ACCEPTANCE_EVENT_TYPE,
    id,
    timestamp: at,
    feature,
    by,
    reason,
    membership,
    activeAcceptanceDigests,
    report,
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function eventLedgerInfo(projectRoot, { create = false } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const ledger = await assertInternalPath(root, ['.tinysdd', 'runs', 'feature-events.jsonl'], { allowMissing: true });
  const lock = await assertInternalPath(root, ['.tinysdd', 'runs', 'feature-events.lock'], { allowMissing: true });
  if (create) await ensureDirectory(dirname(ledger));
  return { root, ledger, lock };
}

async function readLedgerText(ledger) {
  let info;
  try {
    info = await lstat(ledger);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `refusing symlink feature event ledger: ${ledger}`);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `feature event ledger must be a regular file: ${ledger}`);
  if (info.size > FEATURE_EVENTS_MAX_BYTES) throw tinyError('FEATURE_LEDGER_TOO_LARGE', `feature event ledger exceeds ${FEATURE_EVENTS_MAX_BYTES} bytes`);
  let content;
  try {
    content = await readFile(ledger, 'utf8');
  } catch {
    throw tinyError('FEATURE_LEDGER_READ_FAILED', `could not read feature event ledger: ${ledger}`);
  }
  if (Buffer.byteLength(content) > FEATURE_EVENTS_MAX_BYTES) throw tinyError('FEATURE_LEDGER_TOO_LARGE', `feature event ledger exceeds ${FEATURE_EVENTS_MAX_BYTES} bytes`);
  return content;
}

function parseLedgerText(content) {
  if (content.length === 0) return [];
  if (!content.endsWith('\n')) throw tinyError('FEATURE_LEDGER_PARTIAL', 'feature event ledger has a partial trailing record');
  const lines = content.slice(0, -1).split('\n');
  if (lines.length > FEATURE_EVENTS_MAX_RECORDS) throw tinyError('FEATURE_LEDGER_TOO_LARGE', `feature event ledger contains more than ${FEATURE_EVENTS_MAX_RECORDS} records`);
  const events = lines.map((line, index) => {
    if (line.length === 0) eventError(`feature event ledger line ${index + 1} is empty`);
    if (Buffer.byteLength(line) > FEATURE_EVENT_MAX_BYTES) throw tinyError('FEATURE_EVENT_TOO_LARGE', `feature event ledger line ${index + 1} exceeds ${FEATURE_EVENT_MAX_BYTES} bytes`);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw tinyError('FEATURE_LEDGER_PARTIAL', `feature event ledger line ${index + 1} is malformed JSON`);
    }
    return normalizeFeatureEvent(parsed);
  });
  const ids = new Set();
  for (const event of events) {
    if (ids.has(event.id)) throw tinyError('FEATURE_EVENT_DUPLICATE', `feature event already exists: ${event.id}`);
    ids.add(event.id);
  }
  return events;
}

export async function readFeatureEvents(projectRoot) {
  const info = await eventLedgerInfo(projectRoot);
  return withExclusiveLock(info.lock, async () => parseLedgerText(await readLedgerText(info.ledger)));
}

export async function appendFeatureEvent(projectRoot, value) {
  const event = normalizeFeatureEvent(value);
  const info = await eventLedgerInfo(projectRoot, { create: true });
  return withExclusiveLock(info.lock, async () => {
    const existing = parseLedgerText(await readLedgerText(info.ledger));
    if (existing.some((item) => item.id === event.id)) throw tinyError('FEATURE_EVENT_DUPLICATE', `feature event already exists: ${event.id}`);
    if (existing.length >= FEATURE_EVENTS_MAX_RECORDS) throw tinyError('FEATURE_LEDGER_TOO_LARGE', `feature event ledger contains more than ${FEATURE_EVENTS_MAX_RECORDS} records`);
    const line = `${JSON.stringify(event)}\n`;
    const existingBytes = Buffer.byteLength(await readLedgerText(info.ledger));
    if (existingBytes + Buffer.byteLength(line) > FEATURE_EVENTS_MAX_BYTES) throw tinyError('FEATURE_LEDGER_TOO_LARGE', `feature event ledger exceeds ${FEATURE_EVENTS_MAX_BYTES} bytes`);
    try {
      await appendFile(info.ledger, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw tinyError('FEATURE_LEDGER_WRITE_FAILED', `could not append feature event ledger: ${info.ledger}`);
    }
    return event;
  });
}
