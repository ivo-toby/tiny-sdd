import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  atomicWriteJson,
  assertNoSymlinkPath,
  ensureDirectory,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import {
  BENCHMARK_RESULTS_SCHEMA_VERSION,
  parseBenchmarkInvocation,
  parseBenchmarkSummary,
  validateBenchmarkCaseResult,
  validateBenchmarkInvocation,
  validateBenchmarkSummary,
} from './benchmark-results.mjs';

function invalid(message, details = undefined) {
  throw tinyError('BENCHMARK_RESULTS_WRITE_INVALID', message, details);
}

function relativeRef(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    invalid(`${label} must be a relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) invalid(`${label} is not normalized`);
  if (parts[0] === '.git' || parts[0] === '.tinysdd') invalid(`${label} may not enter controller state`);
  return value;
}

async function assertOutputRoot(root) {
  if (typeof root !== 'string' || root.length === 0) invalid('benchmark output root is required');
  const absolute = resolve(root);
  await ensureDirectory(absolute);
  await assertNoSymlinkPath(absolute, { allowMissing: false, requireDirectory: true });
  return absolute;
}

async function writeJson(root, path, value) {
  const relative = relativeRef(path, 'benchmark artifact path');
  const target = join(root, ...relative.split('/'));
  await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(dirname(target), { allowMissing: false, requireDirectory: true });
  try {
    await lstat(target);
    invalid(`benchmark artifact already exists: ${relative}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await atomicWriteJson(target, value);
  const text = await readFile(target);
  return { path: relative, sha256: sha256(text) };
}

function outcomeCategory(outcome) {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'unavailable') return 'unavailable';
  if (outcome === 'not_run') return 'notRun';
  if (['stopped', 'timeout', 'tool_limit', 'raw_output_limit', 'response_token_limit', 'no_progress', 'incomplete'].includes(outcome)) return 'incomplete';
  return 'failed';
}

function summaryGroup(cases, role, configDigest) {
  const counts = { scheduled: cases.length, completed: 0, incomplete: 0, failed: 0, unavailable: 0, notRun: 0 };
  for (const result of cases) counts[outcomeCategory(result.outcome)] += 1;
  return {
    role,
    configDigest,
    ...counts,
  };
}

/**
 * Persist one immutable benchmark invocation and its retained case results.
 * Case objects must already point at artifacts below `outputRoot`.
 */
export async function writeBenchmarkResults({
  outputRoot,
  invocationId,
  suite,
  configDigest,
  configIdentity,
  worker,
  repeat,
  startedAt,
  completedAt,
  cases,
}) {
  const root = await assertOutputRoot(outputRoot);
  if (!Array.isArray(cases) || cases.length === 0) invalid('benchmark invocation must retain at least one case result');
  const caseRefs = [];
  const normalizedCases = [];
  const attemptIds = new Set();
  for (const result of cases) {
    const normalized = validateBenchmarkCaseResult(result);
    if (normalized.configDigest !== configDigest) invalid('case result configDigest does not match invocation configDigest');
    if (attemptIds.has(normalized.attemptId)) invalid(`duplicate benchmark attemptId: ${normalized.attemptId}`);
    attemptIds.add(normalized.attemptId);
    if (normalized.suite.id !== suite.id || normalized.suite.version !== suite.version || normalized.suite.sha256 !== suite.sha256) {
      invalid(`case result suite does not match invocation suite: ${normalized.attemptId}`);
    }
    normalizedCases.push(normalized);
    const path = `cases/${normalized.attemptId}/case-result.json`;
    caseRefs.push({ path, sha256: null });
  }

  // Case references are written first because their digests are part of both
  // the summary and invocation manifests.
  for (let index = 0; index < normalizedCases.length; index += 1) {
    const ref = await writeJson(root, caseRefs[index].path, normalizedCases[index]);
    caseRefs[index] = ref;
  }

  const groupsByKey = new Map();
  for (let index = 0; index < normalizedCases.length; index += 1) {
    const result = normalizedCases[index];
    const key = `${result.role}\0${result.configDigest}`;
    const group = groupsByKey.get(key) ?? { role: result.role, configDigest: result.configDigest, cases: [] };
    group.cases.push({ result, ref: caseRefs[index] });
    groupsByKey.set(key, group);
  }
  const groups = [...groupsByKey.values()].map((group) => ({
    ...summaryGroup(group.cases.map(({ result }) => result), group.role, group.configDigest),
    caseResults: group.cases.map(({ ref }) => ref),
  }));
  const summary = validateBenchmarkSummary({
    schemaVersion: BENCHMARK_RESULTS_SCHEMA_VERSION,
    suite,
    configDigest,
    groups,
    artifacts: [],
  });
  const summaryRef = await writeJson(root, 'summary.json', summary);
  const invocation = validateBenchmarkInvocation({
    schemaVersion: BENCHMARK_RESULTS_SCHEMA_VERSION,
    invocationId,
    suite,
    configDigest,
    configIdentity,
    worker,
    repeat,
    startedAt,
    completedAt,
    caseResults: caseRefs,
    summary: summaryRef,
  });
  const invocationRef = await writeJson(root, 'invocation.json', invocation);
  // Read back the immutable bytes through the public parsers. This catches a
  // path or encoding mistake in the writer before it returns to its caller.
  parseBenchmarkSummary(await readFile(join(root, 'summary.json'), 'utf8'));
  parseBenchmarkInvocation(await readFile(join(root, 'invocation.json'), 'utf8'));
  return {
    directory: root,
    invocation,
    summary,
    invocationRef,
    summaryRef,
    caseRefs,
  };
}

export const writeBenchmarkInvocation = writeBenchmarkResults;
export const writeBenchmarkSummary = writeBenchmarkResults;
