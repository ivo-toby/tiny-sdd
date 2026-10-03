import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertInternalPath,
  assertPlainObject,
  canonicalProjectRoot,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import {
  USAGE_PHASES,
  validateUsageRecord,
} from './usage.mjs';

export const USAGE_REPORT_SCHEMA_VERSION = 1;
export const USAGE_REPORT_TYPE = 'usage-report';
export const USAGE_UNKNOWN = 'UNKNOWN';
export const MAX_WORKER_RESULT_BYTES = 512 * 1024;
export const MAX_WORKER_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_WORKER_RUNS = 1024;
export const MAX_WORKER_MESSAGES = 4096;
export const MAX_REPORT_TASKS = 256;

const ATTRIBUTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const USAGE_COMPONENTS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'totalTokens'];
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const DISCOVERY_EXCLUDED_NAMES = new Set(['.bench', 'bench', 'controller.json', 'controller.lock', 'usage.jsonl']);

function reportError(message, details = undefined) {
  throw tinyError('USAGE_REPORT_INVALID', message, details);
}

function assertObject(value, label) {
  try {
    const object = assertPlainObject(value, 'USAGE_REPORT_INVALID', label);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) reportError(`${label} must be a plain object`);
    return object;
  } catch (error) {
    if (error?.code === 'USAGE_REPORT_INVALID') throw error;
    reportError(error instanceof Error ? error.message : `${label} must be an object`);
  }
}

function requiredText(value, label, { pattern = undefined, max = 512 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) reportError(`${label} must be a bounded nonempty string`);
  if (pattern && !pattern.test(value)) reportError(`${label} has an invalid format`);
  return value;
}

function normalizeTaskId(value, label = 'taskId') {
  return requiredText(value, label, { pattern: ATTRIBUTION_PATTERN, max: 64 });
}

function normalizeRunId(value, label = 'runId') {
  return requiredText(value, label, { pattern: RUN_ID_PATTERN, max: 128 });
}

function normalizeFeature(value) {
  return requiredText(value, 'feature', { pattern: ATTRIBUTION_PATTERN, max: 64 });
}

function safeToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeAdd(left, right) {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function safeSum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return null;
    total = safeAdd(total, value);
    if (total === null) return null;
  }
  return total;
}

function isoNow() {
  return new Date().toISOString();
}

function emptyMetric() {
  return { value: USAGE_UNKNOWN, knownSubtotal: null, coverage: { observed: 0, expected: null, complete: false }, missing: ['no observed usage coverage'] };
}

function metricFromObservations(observations, expected, component, fallback, extraMissing = []) {
  let observed = 0;
  let subtotal = 0;
  let subtotalOverflow = false;
  for (const observation of observations) {
    const value = safeToken(observation?.[component]);
    if (value === null) continue;
    observed += 1;
    if (!subtotalOverflow) {
      subtotal = safeAdd(subtotal, value);
      if (subtotal === null) subtotalOverflow = true;
    }
  }
  const fallbackSubtotal = safeToken(fallback);
  const knownSubtotal = fallbackSubtotal !== null ? fallbackSubtotal : observed > 0 && !subtotalOverflow ? subtotal : null;
  const mismatch = fallbackSubtotal !== null && observed === expected && observed > 0 && subtotal !== fallbackSubtotal;
  const complete = expected !== null && expected > 0 && observed === expected && extraMissing.length === 0 && !mismatch && !subtotalOverflow;
  const overflowMissing = subtotalOverflow ? [`${component} subtotal exceeds safe integer`] : [];
  return {
    value: complete ? subtotal : USAGE_UNKNOWN,
    knownSubtotal,
    coverage: { observed, expected, complete },
    missing: complete ? [] : [...new Set([...extraMissing, ...overflowMissing, ...(mismatch ? [`${component} cumulative usage mismatch`] : []), ...(extraMissing.length === 0 && !mismatch && !subtotalOverflow ? [`missing ${component} usage coverage`] : [])])],
  };
}

function aggregateMetrics(metrics, missing = []) {
  const result = {};
  for (const component of USAGE_COMPONENTS) {
    const values = metrics.map((metric) => metric[component]);
    const subtotals = values.map((metric) => metric.knownSubtotal).filter((value) => Number.isSafeInteger(value));
    const total = safeSum(values.map((metric) => metric.value));
    const knownSubtotal = safeSum(subtotals);
    const complete = values.length > 0 && values.every((metric) => Number.isSafeInteger(metric.value)) && total !== null;
    const overflowMissing = total === null || (subtotals.length > 0 && knownSubtotal === null)
      ? ['token subtotal exceeds safe integer']
      : [];
    result[component] = {
      value: complete ? total : USAGE_UNKNOWN,
      knownSubtotal: subtotals.length === 0 ? null : knownSubtotal,
      coverage: {
        observed: values.filter((metric) => metric.coverage.observed > 0).length,
        expected: values.length,
        complete,
      },
      missing: [...new Set([...values.flatMap((metric) => metric.missing ?? []), ...overflowMissing])],
    };
  }
  if (metrics.length === 0) {
    for (const component of USAGE_COMPONENTS) result[component] = emptyMetric();
  }
  result.missing = [...new Set([...missing, ...metrics.flatMap((metric) => metric.missing ?? [])])];
  return result;
}

function metricValueShape(metrics) {
  const output = {};
  for (const component of USAGE_COMPONENTS) {
    output[component] = metrics[component].value;
  }
  output.knownSubtotals = Object.fromEntries(USAGE_COMPONENTS.map((component) => [component, metrics[component].knownSubtotal]));
  output.coverage = Object.fromEntries(USAGE_COMPONENTS.map((component) => [component, metrics[component].coverage]));
  output.missing = [...new Set([
    ...(metrics.missing ?? []),
    ...USAGE_COMPONENTS.flatMap((component) => metrics[component].missing ?? []),
  ])];
  return output;
}

function aggregateSimpleMetrics(metrics, missing = []) {
  const known = metrics.map((metric) => metric.knownSubtotal).filter((value) => Number.isSafeInteger(value));
  const values = metrics.map((metric) => metric.value);
  const allValuesKnown = values.every((value) => Number.isSafeInteger(value));
  const total = allValuesKnown ? safeSum(values) : null;
  const knownTotal = safeSum(known);
  const complete = metrics.length > 0 && metrics.every((metric) => Number.isSafeInteger(metric.value)) && total !== null;
  const overflowMissing = (allValuesKnown && total === null) || (known.length > 0 && knownTotal === null)
    ? ['elapsed subtotal exceeds safe integer']
    : [];
  return {
    value: complete ? total : USAGE_UNKNOWN,
    knownSubtotal: known.length === 0 ? null : knownTotal,
    coverage: { observed: known.length, expected: metrics.length, complete },
    missing: [...new Set([...missing, ...metrics.flatMap((metric) => metric.missing), ...overflowMissing])],
  };
}

function usageField(message, primary, aliases = []) {
  const usage = message?.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const values = [primary, ...aliases].filter((key) => Object.hasOwn(usage, key)).map((key) => safeToken(usage[key]));
  if (values.length === 0 || values.some((value) => value === null)) return null;
  if (values.some((value) => value !== values[0])) return null;
  return values[0];
}

function usageObservation(message) {
  return {
    input: usageField(message, 'input', ['inputTokens']),
    output: usageField(message, 'output', ['outputTokens']),
    reasoning: usageField(message, 'reasoning', ['reasoningTokens']),
    cacheRead: usageField(message, 'cacheRead', ['cache_read', 'cacheReadTokens']),
    cacheWrite: usageField(message, 'cacheWrite', ['cache_write', 'cacheWriteTokens']),
    totalTokens: usageField(message, 'totalTokens', ['total']),
  };
}

function parseWorkerStdout(text) {
  const messageEnds = [];
  const turnEnds = [];
  let malformedLines = 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') messageEnds.push(event.message);
    if (event?.type === 'turn_end' && event.message?.role === 'assistant') turnEnds.push(event.message);
  }
  const messageLimitExceeded = messageEnds.length + turnEnds.length > MAX_WORKER_MESSAGES;
  const source = messageEnds.length > 0 ? messageEnds : turnEnds;
  const seen = new Set();
  const messages = [];
  for (const message of source.slice(0, MAX_WORKER_MESSAGES)) {
    const id = message?.id ?? message?.messageId ?? message?.entryId;
    if (typeof id === 'string' && seen.has(id)) continue;
    if (typeof id === 'string') seen.add(id);
    messages.push(message);
  }
  return {
    messages,
    mode: messageEnds.length > 0 ? 'message_end' : 'turn_end',
    malformedLines,
    lines,
    partial: malformedLines > 0 || messageLimitExceeded,
    messageLimitExceeded,
  };
}

function resultCumulative(result) {
  const usage = result?.observed?.cumulativeUsage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return {
    assistantMessages: safeToken(usage.assistantMessages),
    input: safeToken(usage.input),
    output: safeToken(usage.output),
    reasoning: safeToken(usage.reasoning),
    cacheRead: safeToken(usage.cacheRead ?? usage.cache_read ?? usage.cacheReadTokens),
    cacheWrite: safeToken(usage.cacheWrite ?? usage.cache_write ?? usage.cacheWriteTokens),
    totalTokens: safeToken(usage.totalTokens),
  };
}

function summarizeRunUsage(result, stdoutState) {
  const cumulative = resultCumulative(result);
  const messages = stdoutState?.messages ?? [];
  const expected = cumulative?.assistantMessages ?? (stdoutState ? messages.length : null);
  const missing = [];
  if (!stdoutState) missing.push('missing retained worker stdout');
  if (stdoutState?.partial) missing.push(`malformed stdout lines: ${stdoutState.malformedLines}`);
  if (stdoutState?.messageLimitExceeded) missing.push(`stdout messages exceed ${MAX_WORKER_MESSAGES}`);
  if (expected !== null && messages.length !== expected) missing.push(`response coverage ${messages.length}/${expected}`);
  if (stdoutState && expected === 0 && messages.length === 0) missing.push('no assistant response coverage');
  const observations = messages.map(usageObservation);
  const metrics = {};
  for (const component of USAGE_COMPONENTS) {
    const cumulativeSubtotal = cumulative?.[component] !== null && cumulative?.[component] > 0 ? cumulative[component] : null;
    metrics[component] = metricFromObservations(observations, expected, component, cumulativeSubtotal, missing);
  }
  const componentMissing = USAGE_COMPONENTS.flatMap((component) => metrics[component].missing);
  return { metrics, missing: [...new Set([...missing, ...componentMissing])], responseMode: stdoutState?.mode ?? null };
}

function resultRef(runId, digest) {
  return { runId, path: `.tinysdd/runs/${runId}/result.json`, sha256: digest };
}

function stdoutRef(runId, digest) {
  return { runId, path: `.tinysdd/runs/${runId}/stdout.jsonl`, sha256: digest };
}

async function readBoundedFile(path, maxBytes) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, bytes: null, sha256: null, text: null };
    throw error;
  }
  if (info.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `symlinked paths are not allowed: ${path}`);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `expected a regular file: ${path}`);
  if (info.size > maxBytes) return { missing: false, tooLarge: true, bytes: null, sha256: null, text: null };
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) return { missing: false, tooLarge: true, bytes: null, sha256: null, text: null };
  return { missing: false, bytes, sha256: sha256(bytes), text: bytes.toString('utf8') };
}

async function readDiscoveryJson(path, label) {
  const read = await readBoundedFile(path, MAX_WORKER_RESULT_BYTES);
  if (read.missing) return { missing: true };
  if (read.tooLarge) return { tooLarge: true };
  try {
    return { value: assertObject(JSON.parse(read.text), label) };
  } catch {
    return { malformed: true };
  }
}

function discoveryTaskId(read, label) {
  if (!read?.value || !Object.hasOwn(read.value, 'taskId')) return undefined;
  try {
    return normalizeTaskId(read.value.taskId, label);
  } catch {
    return null;
  }
}

export async function discoverWorkerRuns(projectRoot, { taskIds = undefined } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const runsPath = await assertInternalPath(root, ['.tinysdd', 'runs'], { allowMissing: true, requireDirectory: true });
  let entries;
  try {
    entries = await readdir(runsPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { root, runs: [], missing: [] };
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw tinyError('SYMLINK_PATH', `symlinked worker run path is not allowed: ${join(runsPath, entry.name)}`);
    if (DISCOVERY_EXCLUDED_NAMES.has(entry.name)) continue;
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    candidates.push(entry.name);
  }
  if (candidates.length > MAX_WORKER_RUNS) reportError(`worker run directories exceed ${MAX_WORKER_RUNS}`);
  const allowedTaskIds = taskIds === undefined ? null : new Set([...taskIds].map((taskId) => normalizeTaskId(taskId)));
  const runs = [];
  const missing = [];
  for (const runId of candidates.sort()) {
    const runDir = await assertInternalPath(root, ['.tinysdd', 'runs', runId], { allowMissing: false, requireDirectory: true });
    const packetPath = await assertInternalPath(runDir, ['packet.json'], { allowMissing: true });
    const resultPath = await assertInternalPath(runDir, ['result.json'], { allowMissing: true });
    const packet = await readDiscoveryJson(packetPath, `run ${runId} packet`);
    const result = await readDiscoveryJson(resultPath, `run ${runId} result`);
    const packetTaskId = discoveryTaskId(packet, `run ${runId} packet taskId`);
    const resultTaskId = discoveryTaskId(result, `run ${runId} result taskId`);
    if (packetTaskId !== undefined && resultTaskId !== undefined && packetTaskId !== resultTaskId) {
      reportError(`run ${runId} packet and result task attribution disagree`);
    }
    const taskId = packetTaskId === null ? (resultTaskId === null ? undefined : resultTaskId) : (resultTaskId === null ? packetTaskId : packetTaskId ?? resultTaskId);
    if (taskId === undefined || taskId === null) {
      const reason = packet.missing && result.missing
        ? 'run has no packet.json or result.json task attribution'
        : 'run task attribution is unavailable or malformed';
      missing.push({ kind: 'run', runId, reason });
      continue;
    }
    if (allowedTaskIds !== null && !allowedTaskIds.has(taskId)) continue;
    const discoveryMissing = [];
    if (packet.missing) discoveryMissing.push('missing packet.json');
    if (packet.tooLarge) discoveryMissing.push(`packet.json exceeds ${MAX_WORKER_RESULT_BYTES} bytes`);
    if (packet.malformed) discoveryMissing.push('malformed packet.json');
    if (packetTaskId === null) discoveryMissing.push('invalid packet taskId');
    if (resultTaskId === null) discoveryMissing.push('invalid result taskId');
    runs.push({ runId, taskId, ...(discoveryMissing.length > 0 ? { discoveryMissing } : {}) });
  }
  return { root, runs, missing };
}

function inlineResultRef(runId, result) {
  return result === undefined ? null : resultRef(runId, sha256(stableStringify(result)));
}

function inlineStdoutRef(runId, stdout) {
  return stdout === undefined || stdout === null ? null : stdoutRef(runId, sha256(stdout));
}

async function loadRun(root, runId, taskId, inline = undefined) {
  const resultPath = root === null ? null : await assertInternalPath(root, ['.tinysdd', 'runs', runId, 'result.json'], { allowMissing: true });
  const stdoutPath = root === null ? null : await assertInternalPath(root, ['.tinysdd', 'runs', runId, 'stdout.jsonl'], { allowMissing: true });
  let result;
  let resultReference = resultRef(runId, null);
  let missing = [...(inline?.discoveryMissing ?? [])];
  if (inline?.result !== undefined) {
    result = assertObject(inline.result, `run ${runId} result`);
    resultReference = inlineResultRef(runId, result);
  } else if (resultPath !== null) {
    const read = await readBoundedFile(resultPath, MAX_WORKER_RESULT_BYTES);
    if (read.missing) {
      missing.push('missing result.json');
      resultReference = resultRef(runId, null);
    } else if (read.tooLarge) {
      missing.push(`result.json exceeds ${MAX_WORKER_RESULT_BYTES} bytes`);
      resultReference = resultRef(runId, null);
    } else {
      resultReference = resultRef(runId, read.sha256);
      try {
        result = assertObject(JSON.parse(read.text), `run ${runId} result`);
      } catch {
        missing.push('malformed result.json');
      }
    }
  }
  if (result !== undefined && result.taskId !== undefined && result.taskId !== taskId) {
    throw tinyError('USAGE_REPORT_INVALID', `run ${runId} belongs to task ${result.taskId}, not ${taskId}`);
  }
  if (result !== undefined && result.runId !== undefined && result.runId !== runId) {
    throw tinyError('USAGE_REPORT_INVALID', `run result ${result.runId} does not match requested run ${runId}`);
  }
  let stdoutReference = stdoutRef(runId, null);
  let stdoutState;
  if (inline?.stdout !== undefined) {
    if (typeof inline.stdout !== 'string' || Buffer.byteLength(inline.stdout) > MAX_WORKER_STDOUT_BYTES) {
      missing.push(`stdout exceeds ${MAX_WORKER_STDOUT_BYTES} bytes`);
      stdoutReference = stdoutRef(runId, null);
    } else {
      stdoutReference = inlineStdoutRef(runId, inline.stdout);
      stdoutState = parseWorkerStdout(inline.stdout);
    }
  } else if (stdoutPath !== null) {
    const read = await readBoundedFile(stdoutPath, MAX_WORKER_STDOUT_BYTES);
    if (read.missing) {
      missing.push('missing retained stdout.jsonl');
      stdoutReference = stdoutRef(runId, null);
    } else if (read.tooLarge) {
      missing.push(`stdout.jsonl exceeds ${MAX_WORKER_STDOUT_BYTES} bytes`);
      stdoutReference = stdoutRef(runId, null);
    } else {
      stdoutReference = stdoutRef(runId, read.sha256);
      stdoutState = parseWorkerStdout(read.text);
    }
  }
  const usage = result === undefined
    ? {
      metrics: Object.fromEntries(USAGE_COMPONENTS.map((component) => [component, { ...emptyMetric(), missing: ['missing result.json'] }])),
      missing: ['missing result.json'],
      responseMode: stdoutState?.mode ?? null,
    }
    : summarizeRunUsage(result, stdoutState);
  missing = [...new Set([...missing, ...usage.missing])];
  const elapsedMs = safeDuration(result?.observed?.processTermination?.elapsedMs);
  if (elapsedMs === null) missing.push('missing execution duration');
  const outcome = typeof result?.outcome === 'string' && result.outcome.length > 0 ? result.outcome : USAGE_UNKNOWN;
  const baseRunId = typeof result?.baseRun?.id === 'string' ? result.baseRun.id : null;
  const baselineRunId = typeof result?.baselineRun?.id === 'string' ? result.baselineRun.id : null;
  return {
    runId,
    taskId,
    result,
    usage,
    elapsedMs,
    outcome,
    baseRunId,
    baselineRunId,
    resultRef: resultReference,
    stdoutRef: stdoutReference,
    missing: [...new Set(missing)],
  };
}

function runMetricSummary(run) {
  const metrics = { ...run.usage.metrics };
  const elapsed = run.elapsedMs === null
    ? { value: USAGE_UNKNOWN, knownSubtotal: null, coverage: { observed: 0, expected: 1, complete: false }, missing: ['missing execution duration'] }
    : { value: run.elapsedMs, knownSubtotal: run.elapsedMs, coverage: { observed: 1, expected: 1, complete: true }, missing: [] };
  return { metrics, elapsed };
}

function normalizeRunRefs(tasks, runs) {
  const refs = [];
  for (const task of tasks) {
    for (const run of task.runRefs) {
      if (run.taskId !== undefined && run.taskId !== task.taskId) reportError(`run ${run.runId} is outside task ${task.taskId} membership`);
      refs.push({ ...run, taskId: task.taskId });
    }
  }
  for (const run of runs) {
    const ref = assertObject(run, 'worker run reference');
    if (ref.runId !== undefined && ref.id !== undefined && ref.runId !== ref.id) reportError('worker run reference runId aliases must agree');
    const runId = normalizeRunId(ref.runId ?? ref.id, 'worker run reference runId');
    const taskId = normalizeTaskId(ref.taskId, 'worker run reference taskId');
    refs.push({ ...ref, runId, taskId });
  }
  if (refs.length > MAX_WORKER_RUNS) reportError(`worker run references exceed ${MAX_WORKER_RUNS}`);
  return refs;
}

function normalizeTasks(input, feature = undefined) {
  const source = Array.isArray(input) ? input : Object.entries(input ?? {}).map(([id, task]) => ({ ...task, id }));
  if (source.length > MAX_REPORT_TASKS) reportError(`feature tasks exceed ${MAX_REPORT_TASKS}`);
  const tasks = [];
  for (const value of source) {
    const task = assertObject(value, 'feature task');
    if (task.taskId !== undefined && task.id !== undefined && task.taskId !== task.id) reportError('feature task id aliases must agree');
    const taskId = normalizeTaskId(task.taskId ?? task.id);
    if (task.feature !== undefined && task.featureId !== undefined && task.feature !== task.featureId) reportError(`task ${taskId} feature aliases must agree`);
    const taskFeature = task.feature ?? task.featureId;
    const normalizedTaskFeature = taskFeature === undefined ? undefined : normalizeFeature(taskFeature);
    if (feature !== undefined && normalizedTaskFeature !== feature) continue;
    if (task.runIds !== undefined && task.runs !== undefined && stableStringify(task.runIds) !== stableStringify(task.runs)) reportError(`task ${taskId} run aliases must agree`);
    const suppliedRuns = task.runIds ?? task.runs ?? [];
    if (!Array.isArray(suppliedRuns)) reportError(`task ${taskId} runIds must be an array`);
    const runRefs = suppliedRuns.map((run) => {
      if (typeof run === 'string') return { runId: normalizeRunId(run), taskId };
      const ref = assertObject(run, `task ${taskId} run reference`);
      if (ref.runId !== undefined && ref.id !== undefined && ref.runId !== ref.id) reportError(`task ${taskId} run id aliases must agree`);
      if (ref.taskId !== undefined && ref.taskId !== taskId) reportError(`task ${taskId} run reference has conflicting taskId`);
      return { ...ref, runId: normalizeRunId(ref.runId ?? ref.id), taskId };
    });
    tasks.push({
      taskId,
      feature: normalizedTaskFeature ?? feature,
      retired: task.retired === true || task.closure !== undefined,
      runRefs,
    });
  }
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.taskId)) reportError(`duplicate feature task: ${task.taskId}`);
    seen.add(task.taskId);
  }
  tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return tasks;
}

async function collectRuns(projectRoot, tasks, runs) {
  const root = await canonicalProjectRoot(projectRoot);
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const discovered = await discoverWorkerRuns(root, { taskIds });
  const suppliedRefs = normalizeRunRefs(tasks, runs);
  const suppliedIds = new Set(suppliedRefs.map((ref) => ref.runId));
  const refs = [...suppliedRefs, ...discovered.runs.filter((ref) => !suppliedIds.has(ref.runId))];
  for (const ref of refs) if (!taskIds.has(ref.taskId)) reportError(`run ${ref.runId} is outside feature task membership`);
  const queue = [...refs];
  const byRun = new Map();
  const missing = [...discovered.missing];
  while (queue.length > 0) {
    if (byRun.size >= MAX_WORKER_RUNS) reportError(`worker run references exceed ${MAX_WORKER_RUNS}`);
    const ref = queue.shift();
    const runId = normalizeRunId(ref.runId);
    const existing = byRun.get(runId);
    if (existing) {
      if (existing.taskId !== ref.taskId) reportError(`run ${runId} is attributed to multiple tasks`);
      continue;
    }
    const run = await loadRun(root, runId, ref.taskId, ref);
    byRun.set(runId, run);
    if (run.missing.length > 0) missing.push(...run.missing.map((reason) => ({ kind: 'run', runId, taskId: ref.taskId, reason })));
    if (run.baseRunId !== null) {
      if (!RUN_ID_PATTERN.test(run.baseRunId)) reportError(`run ${runId} has an invalid base run id`);
      queue.push({ runId: run.baseRunId, taskId: ref.taskId });
    }
    // baselineRun is replay provenance. It is retained on the current run but
    // never traversed or counted as another task invocation.
  }
  return { root, runs: [...byRun.values()].sort((left, right) => left.runId.localeCompare(right.runId)), missing };
}

function selectUsageRecords(records, feature, tasks, missing) {
  if (!Array.isArray(records)) reportError('usageRecords must be an array');
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const selected = [];
  const ids = new Set();
  for (const raw of records) {
    const record = validateUsageRecord(raw, { imported: true });
    if (ids.has(record.id)) reportError(`duplicate usage record id: ${record.id}`);
    ids.add(record.id);
    const taskMatch = record.taskId !== undefined && taskIds.has(record.taskId);
    const featureMatch = record.feature === feature;
    if ((featureMatch && (record.taskId === undefined || taskMatch)) || (record.feature === undefined && taskMatch)) {
      selected.push(record);
      continue;
    }
    if (record.feature === undefined && record.taskId === undefined) {
      missing.push({ kind: 'ledger', recordId: record.id, reason: 'usage record has no feature or task attribution' });
    } else if (featureMatch && record.taskId !== undefined && !taskMatch) {
      missing.push({ kind: 'ledger', recordId: record.id, reason: `usage record task ${record.taskId} is outside feature membership` });
    }
  }
  return selected;
}

function frontierSummary(records) {
  const byPhase = {};
  const phaseMetrics = {};
  for (const phase of USAGE_PHASES) {
    const phaseRecords = records.filter((record) => record.phase === phase);
    const metrics = aggregateMetrics(phaseRecords.map((record) => {
      const missing = [];
      const expected = 1;
      const result = {};
      for (const component of USAGE_COMPONENTS) {
        const value = safeToken(record[component]);
        result[component] = {
          value: value === null ? USAGE_UNKNOWN : value,
          knownSubtotal: value,
          coverage: { observed: value === null ? 0 : 1, expected, complete: value !== null },
          missing: value === null ? [`missing ${component} usage`] : [],
        };
        if (value === null) missing.push(`missing ${component} usage`);
      }
      result.missing = missing;
      return result;
    }));
    phaseMetrics[phase] = metrics;
    byPhase[phase] = { ...metricValueShape(metrics), ledgerRecordIds: phaseRecords.map((record) => record.id).sort() };
  }
  const totals = aggregateMetrics(USAGE_PHASES.map((phase) => {
    const metrics = {};
    for (const component of USAGE_COMPONENTS) {
      const metric = phaseMetrics[phase][component];
      metrics[component] = {
        ...metric,
        missing: metric.missing.map((reason) => `${phase}: ${reason}`),
      };
    }
    metrics.missing = USAGE_COMPONENTS.flatMap((component) => metrics[component].missing);
    return metrics;
  }));
  return {
    byPhase,
    totals: metricValueShape(totals),
    ledgerRecordIds: records.map((record) => record.id).sort(),
  };
}

function localSummary(tasks, runs) {
  const byTask = {};
  for (const task of tasks) {
    const taskRuns = runs.filter((run) => run.taskId === task.taskId);
    const summaries = taskRuns.map(runMetricSummary);
    const metrics = aggregateMetrics(summaries.map((summary) => summary.metrics), taskRuns.flatMap((run) => run.missing));
    const elapsedValues = summaries.map((summary) => summary.elapsed);
    const elapsed = aggregateSimpleMetrics(elapsedValues, taskRuns.flatMap((run) => run.missing));
    const runIds = taskRuns.map((run) => run.runId).sort();
    const revisionRunIds = taskRuns.filter((run) => run.baseRunId !== null).map((run) => run.runId).sort();
    const taskMissing = [...new Set([
      ...(taskRuns.length === 0 ? ['no worker runs supplied'] : []),
      ...metrics.missing,
      ...elapsed.missing,
      ...taskRuns.flatMap((run) => run.missing),
    ])];
    byTask[task.taskId] = {
      taskId: task.taskId,
      retired: task.retired,
      runIds,
      revisionRunIds,
      ...metricValueShape(metrics),
      elapsedMs: elapsed.value,
      knownElapsedMs: elapsed.knownSubtotal,
      missing: taskMissing,
    };
  }
  const taskMetrics = tasks.map((task) => {
    const summary = byTask[task.taskId];
    const metrics = {};
    for (const component of USAGE_COMPONENTS) {
      metrics[component] = {
        value: summary[component],
        knownSubtotal: summary.knownSubtotals[component],
        coverage: summary.coverage[component],
        missing: summary.missing,
      };
    }
    metrics.missing = summary.missing;
    return metrics;
  });
  const totals = aggregateMetrics(taskMetrics, tasks.flatMap((task) => byTask[task.taskId].missing));
  const elapsedMetrics = tasks.map((task) => {
    const summary = byTask[task.taskId];
    return {
      value: summary.elapsedMs,
      knownSubtotal: summary.knownElapsedMs,
      coverage: { observed: summary.knownElapsedMs === null ? 0 : 1, expected: 1, complete: summary.elapsedMs !== USAGE_UNKNOWN },
      missing: summary.missing,
    };
  });
  const elapsed = aggregateSimpleMetrics(elapsedMetrics, tasks.flatMap((task) => byTask[task.taskId].missing));
  const totalShape = metricValueShape(totals);
  return {
    byTask,
    totals: {
      ...totalShape,
      missing: [...new Set([...totalShape.missing, ...elapsed.missing])],
      elapsedMs: elapsed.value,
      knownElapsedMs: elapsed.knownSubtotal,
    },
    runIds: runs.map((run) => run.runId).sort(),
    revisionRunIds: runs.filter((run) => run.baseRunId !== null).map((run) => run.runId).sort(),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function freezeUsageReport(report) {
  return deepFreeze(structuredClone(report));
}

export async function collectWorkerUsage(projectRoot, { tasks = [], runs = [] } = {}) {
  const featureTasks = normalizeTasks(tasks);
  return collectRuns(projectRoot, featureTasks, runs);
}

export async function buildUsageReport({
  projectRoot,
  feature,
  tasks = [],
  usageRecords = [],
  runs = [],
  generatedAt = undefined,
} = {}) {
  const normalizedFeature = normalizeFeature(feature);
  const featureTasks = normalizeTasks(tasks, normalizedFeature);
  const missing = [];
  const selectedRecords = selectUsageRecords(usageRecords, normalizedFeature, featureTasks, missing);
  let collected;
  if (typeof projectRoot === 'string') {
    collected = await collectRuns(projectRoot, featureTasks, runs);
    missing.push(...collected.missing);
  } else {
    const inlineRuns = normalizeRunRefs(featureTasks, runs);
    const taskIds = new Set(featureTasks.map((task) => task.taskId));
    for (const ref of inlineRuns) if (!taskIds.has(ref.taskId)) reportError(`run ${ref.runId} is outside feature task membership`);
    const seen = new Set();
    const inline = [];
    for (const ref of inlineRuns) {
      if (seen.has(ref.runId)) {
        const prior = inline.find((run) => run.runId === ref.runId);
        if (prior && prior.taskId !== ref.taskId) reportError(`run ${ref.runId} is attributed to multiple tasks`);
        continue;
      }
      seen.add(ref.runId);
      inline.push(await loadRun(null, ref.runId, ref.taskId, ref));
    }
    collected = { runs: inline, missing: inline.flatMap((run) => run.missing.map((reason) => ({ kind: 'run', runId: run.runId, taskId: run.taskId, reason }))) };
    missing.push(...collected.missing);
  }
  const frontier = frontierSummary(selectedRecords);
  const local = localSummary(featureTasks, collected.runs);
  const runReferences = collected.runs.map((run) => ({
    runId: run.runId,
    taskId: run.taskId,
    result: run.resultRef,
    stdout: run.stdoutRef,
    outcome: run.outcome,
    baseRunId: run.baseRunId,
    baselineRunId: run.baselineRunId,
  }));
  const provenance = {
    ledgerRecordIds: frontier.ledgerRecordIds,
    runReferences,
    missing: [...missing],
  };
  const report = {
    schemaVersion: USAGE_REPORT_SCHEMA_VERSION,
    type: USAGE_REPORT_TYPE,
    feature: normalizedFeature,
    generatedAt: generatedAt ?? isoNow(),
    tasks: featureTasks.map((task) => ({ taskId: task.taskId, feature: task.feature, retired: task.retired, runIds: task.runRefs.map((run) => run.runId).sort() })),
    frontier,
    local,
    provenance,
    snapshot: {
      ledgerRecordIds: [...provenance.ledgerRecordIds],
      runReferences: structuredClone(runReferences),
      missing: structuredClone(provenance.missing),
    },
  };
  return freezeUsageReport(report);
}
