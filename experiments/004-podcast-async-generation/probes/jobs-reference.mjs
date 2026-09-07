import { randomUUID } from 'node:crypto';

const DEFAULT_RETENTION_MS = 86_400_000;
const ACCEPTED_MESSAGE = 'Retain this job ID, poll get_job_status for updates, and do not resubmit.';
const MUTANT = process.env.TINYSDD_PROBE_MUTANT ?? 'positive';
const MUTANTS = new Set([
  '',
  'positive',
  'stall-on-reject',
  'return-reference',
  'ttl-from-creation',
  // HTTP checks use the same probe environment; these are neutral here.
  'await-generation',
  'per-request-manager',
  'poll-resubmit',
]);

if (!MUTANTS.has(MUTANT)) {
  throw new Error(`Unknown TINYSDD_PROBE_MUTANT: ${MUTANT}`);
}

function copyJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function createRecord(operation, executor, createdAtMs) {
  const jobId = randomUUID();
  const accepted = {
    jobId,
    operation,
    status: 'queued',
    stage: 'queued',
    pollIntervalSeconds: 5,
    message: ACCEPTED_MESSAGE,
  };
  return {
    jobId,
    operation,
    executor,
    status: 'queued',
    stage: 'queued',
    createdAtMs,
    updatedAtMs: createdAtMs,
    startedAtMs: undefined,
    completedAtMs: undefined,
    result: undefined,
    error: undefined,
    accepted,
    liveSnapshot: accepted,
  };
}

function statusSnapshot(record) {
  const status = {
    jobId: record.jobId,
    operation: record.operation,
    status: record.status,
    stage: record.stage,
    createdAt: iso(record.createdAtMs),
    updatedAt: iso(record.updatedAtMs),
  };
  if (record.startedAtMs !== undefined) status.startedAt = iso(record.startedAtMs);
  if (record.completedAtMs !== undefined) status.completedAt = iso(record.completedAtMs);
  if (record.result !== undefined) status.result = copyJson(record.result);
  if (record.error !== undefined) status.error = { ...record.error };
  return status;
}

function refreshLiveSnapshot(record) {
  const live = record.liveSnapshot;
  // Deliberately leave jobId/operation untouched: the return-reference probe
  // must expose mutations to the object returned by submit/get.
  live.status = record.status;
  live.stage = record.stage;
  live.createdAt = iso(record.createdAtMs);
  live.updatedAt = iso(record.updatedAtMs);
  if (record.startedAtMs !== undefined) live.startedAt = iso(record.startedAtMs);
  else delete live.startedAt;
  if (record.completedAtMs !== undefined) live.completedAt = iso(record.completedAtMs);
  else delete live.completedAt;
  if (record.result !== undefined) live.result = record.result;
  else delete live.result;
  if (record.error !== undefined) live.error = record.error;
  else delete live.error;
  return live;
}

export function createJobManager(options = {}) {
  const now = options.now ?? (() => Date.now());
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const jobs = new Map();
  const queue = [];
  let active = false;

  function prune() {
    const current = now();
    for (const [jobId, record] of jobs) {
      if (record.completedAtMs === undefined) continue;
      const referenceTime = MUTANT === 'ttl-from-creation'
        ? record.createdAtMs
        : record.completedAtMs;
      if (current - referenceTime >= retentionMs) jobs.delete(jobId);
    }
  }

  function markRunning(record) {
    record.status = 'running';
    record.stage = 'generating';
    record.startedAtMs = now();
    record.updatedAtMs = record.startedAtMs;
  }

  function markSucceeded(record, result) {
    record.status = 'succeeded';
    record.stage = 'completed';
    record.result = copyJson(result);
    record.completedAtMs = now();
    record.updatedAtMs = record.completedAtMs;
  }

  function markFailed(record) {
    record.status = 'failed';
    record.stage = 'failed';
    record.error = { code: 'job_execution_failed', message: 'Job execution failed' };
    record.completedAtMs = now();
    record.updatedAtMs = record.completedAtMs;
  }

  function drain() {
    if (active) return;
    const record = queue.shift();
    if (!record) return;

    active = true;
    markRunning(record);

    let execution;
    try {
      execution = record.executor();
    } catch {
      markFailed(record);
      active = false;
      drain();
      return;
    }

    Promise.resolve(execution).then(
      (result) => {
        markSucceeded(record, result);
        active = false;
        drain();
      },
      () => {
        markFailed(record);
        if (MUTANT === 'stall-on-reject') return;
        active = false;
        drain();
      },
    );
  }

  return {
    submit(operation, executor) {
      prune();
      const record = createRecord(operation, executor, now());
      jobs.set(record.jobId, record);
      queue.push(record);
      queueMicrotask(drain);
      if (MUTANT === 'return-reference') return record.liveSnapshot;
      return copyJson(record.accepted);
    },

    get(jobId) {
      prune();
      const record = jobs.get(jobId);
      if (!record) return undefined;
      if (MUTANT === 'return-reference') return refreshLiveSnapshot(record);
      return statusSnapshot(record);
    },
  };
}
