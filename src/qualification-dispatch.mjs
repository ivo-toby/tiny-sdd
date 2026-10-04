import { lstat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  assertInternalPath,
  canonicalProjectRoot,
  normalizeProjectRelative,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import { inspectBenchmarkIdentity } from './benchmark-runner.mjs';
import { buildQualificationRecord } from './qualification.mjs';
import { readQualificationEvidencePool } from './qualification-reader.mjs';
import {
  accumulateQualificationRecord,
  qualificationRecordPath,
  readQualificationProfileReferences,
  readQualificationRecord,
} from './qualification-store.mjs';

const DEFAULT_SUITE = 'bench';
const QUALIFICATION_MODES = new Set(['off', 'warn', 'enforce']);

function unavailable(message, details = undefined) {
  return tinyError('QUALIFICATION_UNAVAILABLE', message, details);
}

function pathError(error) {
  return error?.code === 'PATH_NOT_FOUND'
    || error?.details?.causeCode === 'ENOENT'
    || error?.details?.causeCode === 'PATH_NOT_FOUND'
    || error?.code === 'ENOENT';
}

/** Resolve the current project benchmark context without consulting records. */
export async function resolveBenchmarkSuite(projectRoot, requested = DEFAULT_SUITE) {
  const root = await canonicalProjectRoot(projectRoot);
  let relative;
  try {
    relative = normalizeProjectRelative(requested ?? DEFAULT_SUITE, 'qualification suite');
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : String(error), { field: 'qualification suite' });
  }
  let target;
  try {
    target = await assertInternalPath(root, relative.split('/'), { allowMissing: false });
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw unavailable('qualification suite may not be a symlink', { path: relative });
    if (info.isDirectory()) return { relative, root: target, path: 'suite.json', suitePath: `${relative}/suite.json` };
    if (info.isFile() && basename(target) === 'suite.json') {
      const suiteRoot = dirname(target);
      const suitePath = relative;
      return { relative, root: suiteRoot, path: 'suite.json', suitePath };
    }
  } catch (error) {
    if (error?.code === 'QUALIFICATION_UNAVAILABLE') throw error;
    throw unavailable('qualification suite is missing or unreadable', { path: relative, causeCode: error?.code });
  }
  throw unavailable('qualification suite must name a suite directory or suite.json', { path: relative });
}

function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
  output.set(prefix, stableStringify(value));
  return output;
}

export function changedIdentityFields(previous, current) {
  if (!previous || !current) return [];
  const left = flatten(previous);
  const right = flatten(current);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((field) => left.get(field) !== right.get(field))
    .sort();
}

function modeOf(resolved) {
  const mode = resolved?.config?.qualification?.mode ?? 'warn';
  return QUALIFICATION_MODES.has(mode) ? mode : 'warn';
}

function warningFor(decision) {
  const reason = decision.reason ?? 'unqualified';
  const humanReasons = {
    qualification_invalidated_by_config: 'qualification invalidated by config change',
    insufficient_evidence: 'insufficient evidence',
    qualified_for_other_role_only: 'qualified for another role only',
    role_not_qualified: 'requested role is not qualified',
    qualification_record_missing: 'no matching qualification record',
    current_evidence_unavailable: 'current qualification evidence unavailable',
    qualification_record_unavailable: 'qualification record is unavailable',
    current_identity_unavailable: 'current worker identity is unavailable',
    current_suite_unavailable: 'current qualification suite is unavailable',
    worker_unavailable: 'worker is unavailable',
  };
  const message = humanReasons[reason] ?? reason;
  const fields = decision.changedFields?.length ? ` (changed: ${decision.changedFields.join(', ')})` : '';
  const code = message === reason ? '' : ` [${reason}]`;
  return `qualification ${decision.status}: ${message}${code}${fields}`;
}

function currentRecordPath(root, digest) {
  return qualificationRecordPath(root, digest).path;
}

async function readCurrentRecord(root, digest) {
  const path = currentRecordPath(root, digest);
  try {
    return await readQualificationRecord(root, path);
  } catch (error) {
    if (pathError(error)) return null;
    throw error;
  }
}

async function refreshRecord(root, record, current, suite, workerName) {
  let evidence;
  try {
    evidence = await readQualificationEvidencePool({
      projectRoot: root,
      suitePath: suite.suitePath,
      configDigest: current.configDigest,
    });
  } catch (error) {
    const legacyAggregate = record.roster === undefined
      && (record.source?.invocations?.length ?? 0) === 0
      && (record.source?.cases?.length ?? 0) === 0;
    if (error?.code === 'QUALIFICATION_READ_INVALID'
      && legacyAggregate
      && /no retained benchmark invocations exist/u.test(error.message ?? '')) {
      return { record, refreshed: false, error: null };
    }
    if (pathError(error) || error?.code === 'QUALIFICATION_READ_INVALID') return { record, refreshed: false, error };
    throw error;
  }
  const targets = Object.fromEntries(Object.entries(record.roles ?? {}).map(([role, score]) => [role, score.target]));
  const retained = buildQualificationRecord({
    observations: evidence.observations,
    source: evidence.source,
    roster: evidence.roster,
    configIdentity: current.identity,
    configDigest: current.configDigest,
    suite: evidence.suite,
    targets,
  });
  const stored = await accumulateQualificationRecord(root, retained, { targets });
  return { record: stored.record, refreshed: true, error: null };
}

async function oldQualifiedAssociations(root, workerName, role, current) {
  if (!workerName) return [];
  let references;
  try {
    references = await readQualificationProfileReferences(root);
  } catch {
    return [];
  }
  const results = [];
  for (const association of references.associations.filter((entry) => entry.workerName === workerName && entry.configDigest !== current.configDigest)) {
    try {
      const loaded = await readQualificationRecord(root, association.record.path);
      results.push({
        configDigest: association.configDigest,
        path: association.record.path,
        status: loaded.roles?.[role]?.status ?? 'role_not_recorded',
        changedFields: changedIdentityFields(loaded.configIdentity, current.identity),
      });
    } catch {
      // A stale sidecar must not manufacture a qualification decision.
    }
  }
  return results;
}

function roleDecision(record, role) {
  if (!record) return { status: 'unqualified', reason: 'qualification_record_missing', changedFields: [] };
  const score = record.roles?.[role];
  if (score?.status === 'qualified') return { status: 'qualified', reason: null, changedFields: [] };
  if (score === undefined) {
    const anotherRole = Object.entries(record.roles ?? {}).find(([name, entry]) => name !== role && entry.status === 'qualified');
    return { status: 'unqualified', reason: anotherRole ? 'qualified_for_other_role_only' : 'role_not_qualified', changedFields: [] };
  }
  return { status: 'unqualified', reason: score.status === 'insufficient_evidence' ? 'insufficient_evidence' : 'role_not_qualified', changedFields: [] };
}

function unavailableDecision(mode, reason, details = {}) {
  const decision = {
    mode,
    status: 'unqualified',
    reason,
    recordDigest: null,
    path: null,
    changedFields: details.changedFields ?? [],
    warnings: [],
    ...details,
  };
  decision.warnings = [warningFor(decision)];
  return decision;
}

/**
 * Assess the exact current worker/suite identity and enforce or warn on the
 * matching qualification record. Raw benchmark evidence never bootstraps a
 * record here; only an existing record may be refreshed from retained runs.
 */
export async function assessQualification({
  projectRoot,
  resolved,
  workerName,
  role = 'implement-slice',
  checksDeclared = true,
  suitePath,
  runtime,
  model,
  workerSettings,
  piVersion,
  tinySddVersion,
  codeRevision,
  maxCheckRuns,
  checkLimits,
  checkRunnerOptions,
  verifierMode,
} = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const selected = resolved ?? {};
  const mode = modeOf(selected);
  if (mode === 'off') {
    return {
      mode,
      status: 'skipped',
      reason: 'qualification_disabled',
      recordDigest: null,
      path: null,
      changedFields: [],
      warnings: [],
    };
  }
  const worker = selected.worker;
  const selectedWorkerName = workerName ?? selected.workerName;
  if (!worker || !selectedWorkerName) {
    const decision = unavailableDecision(mode, 'worker_unavailable');
    if (mode === 'enforce') throw tinyError('MODEL_NOT_QUALIFIED', 'worker cannot be qualified without a selected worker', { qualification: decision });
    return decision;
  }
  const requestedSuite = suitePath ?? selected.config?.qualification?.suite ?? DEFAULT_SUITE;
  let suite;
  try {
    suite = await resolveBenchmarkSuite(root, requestedSuite);
  } catch (error) {
    const decision = unavailableDecision(mode, 'current_suite_unavailable', { details: { message: error.message, path: requestedSuite } });
    if (mode === 'enforce') throw tinyError('MODEL_NOT_QUALIFIED', 'current qualification suite is unavailable', { qualification: decision });
    return decision;
  }
  let current;
  try {
    current = await inspectBenchmarkIdentity({
      projectRoot: root,
      suiteRoot: suite.root,
      suitePath: suite.path,
      worker,
      workerName: selectedWorkerName,
      profile: selected.profile,
      runtime,
      model: model ?? worker.modelMetadata,
      workerSettings,
      piVersion,
      tinySddVersion,
      codeRevision,
      maxCheckRuns: maxCheckRuns ?? worker.limits?.maxCheckRuns,
      checkLimits,
      checkRunnerOptions,
      verifierMode,
      runChecksDeclared: checksDeclared,
    });
  } catch (error) {
    const decision = unavailableDecision(mode, 'current_identity_unavailable', { details: { message: error.message } });
    if (mode === 'enforce') throw tinyError('MODEL_NOT_QUALIFIED', 'current worker identity is unavailable', { qualification: decision });
    return decision;
  }
  const digest = current.configDigest;
  let loaded;
  try {
    loaded = await readCurrentRecord(root, digest);
  } catch (error) {
    const decision = unavailableDecision(mode, 'qualification_record_unavailable', {
      recordDigest: digest,
      path: currentRecordPath(root, digest),
      details: { message: error.message },
      identity: current.identity,
      suite: current.suite,
    });
    if (mode === 'enforce') throw tinyError('MODEL_NOT_QUALIFIED', 'current qualification record is unavailable', { qualification: decision });
    return decision;
  }
  let refreshError = null;
  let refreshed = false;
  if (loaded) {
    try {
      const result = await refreshRecord(root, loaded.record, current, suite, selectedWorkerName);
      loaded = { ...loaded, record: result.record };
      refreshError = result.error;
      refreshed = result.refreshed;
    } catch (error) {
      refreshError = error;
    }
  }
  const outcome = roleDecision(loaded?.record, role);
  const stale = await oldQualifiedAssociations(root, selectedWorkerName, role, current);
  if (refreshError) {
    outcome.status = 'unqualified';
    outcome.reason = 'current_evidence_unavailable';
    outcome.changedFields = stale.flatMap((entry) => entry.changedFields).filter((field, index, fields) => fields.indexOf(field) === index).sort();
  } else if (stale.length > 0 && outcome.reason === 'qualification_record_missing') {
    outcome.reason = 'qualification_invalidated_by_config';
    outcome.changedFields = stale.flatMap((entry) => entry.changedFields).filter((field, index, fields) => fields.indexOf(field) === index).sort();
  }
  const decision = {
    mode,
    status: outcome.status,
    reason: outcome.reason,
    recordDigest: digest,
    path: loaded?.path ?? null,
    changedFields: outcome.changedFields,
    warnings: [],
    suite: current.suite,
    identity: current.identity,
    ...(refreshError ? { refreshError: refreshError.message } : {}),
    ...(refreshed ? { refreshed: true } : {}),
    ...(stale.length > 0 ? { invalidated: stale } : {}),
  };
  if (decision.status !== 'qualified') decision.warnings = [warningFor(decision)];
  if (mode === 'enforce' && decision.status !== 'qualified') {
    throw tinyError('MODEL_NOT_QUALIFIED', `worker ${selectedWorkerName} is not qualified for ${role}`, { qualification: decision });
  }
  return decision;
}
