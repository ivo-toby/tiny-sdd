import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const rawCandidateDir = process.env.TINYSDD_CANDIDATE_DIR;
if (typeof rawCandidateDir !== 'string' || !isAbsolute(rawCandidateDir)) {
  throw new Error('TINYSDD_CANDIDATE_DIR must be an absolute path');
}

const candidateDir = resolve(rawCandidateDir);
const candidateInfo = await lstat(candidateDir);
if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
  throw new Error('TINYSDD_CANDIDATE_DIR must name a real directory');
}

const jobsDir = resolve(candidateDir, 'jobs');
if (relative(candidateDir, jobsDir) !== 'jobs') {
  throw new Error('candidate jobs directory escaped candidate directory');
}
const jobsInfo = await lstat(jobsDir);
if (jobsInfo.isSymbolicLink() || !jobsInfo.isDirectory()) {
  throw new Error('candidate jobs directory must be a regular directory');
}

const jobManagerPath = resolve(jobsDir, 'job-manager.js');
if (relative(candidateDir, jobManagerPath) !== 'jobs/job-manager.js') {
  throw new Error('candidate job-manager module escaped candidate directory');
}
const jobManagerInfo = await lstat(jobManagerPath);
if (jobManagerInfo.isSymbolicLink() || !jobManagerInfo.isFile()) {
  throw new Error('candidate jobs/job-manager.js must be a regular file');
}

const { createJobManager } = await import(pathToFileURL(jobManagerPath).href);
if (typeof createJobManager !== 'function') {
  throw new Error('candidate must export createJobManager');
}

const OPERATION = 'generate_podcast';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = (value) => {
  assert.equal(typeof value, 'string');
  assert.equal(new Date(value).toISOString(), value);
};

function deferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = (value) => {
      settled = true;
      resolve(value);
    };
    rejectPromise = (error) => {
      settled = true;
      reject(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() {
      return settled;
    },
  };
}

function nextTurn() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await nextTurn();
  }
  if (await predicate()) return;
  throw new Error(`Timed out waiting for ${label}`);
}

function mutate(value, property, replacement) {
  try {
    value[property] = replacement;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}

function assertAccepted(accepted) {
  assert.deepEqual(Object.keys(accepted).sort(), [
    'jobId',
    'message',
    'operation',
    'pollIntervalSeconds',
    'stage',
    'status',
  ]);
  assert.equal(typeof accepted.then, 'undefined');
  assert.equal(typeof accepted.jobId, 'string');
  assert.match(accepted.jobId, UUID_V4);
  assert.equal(accepted.operation, OPERATION);
  assert.equal(accepted.status, 'queued');
  assert.equal(accepted.stage, 'queued');
  assert.equal(accepted.pollIntervalSeconds, 5);
  assert.equal(typeof accepted.message, 'string');
  assert.ok(accepted.message.trim().length > 0);
}

function assertFailure(status) {
  assert.equal(status.status, 'failed');
  assert.equal(status.stage, 'failed');
  assert.deepEqual(status.error, {
    code: 'job_execution_failed',
    message: 'Job execution failed',
  });
}

function assertRequiredStatusFields(status) {
  for (const key of ['jobId', 'operation', 'status', 'stage', 'createdAt', 'updatedAt']) {
    assert.ok(Object.hasOwn(status, key), `status is missing ${key}`);
  }
  assert.equal(status.operation, OPERATION);
  assert.match(status.jobId, UUID_V4);
  ISO(status.createdAt);
  ISO(status.updatedAt);
  if (Object.hasOwn(status, 'startedAt')) ISO(status.startedAt);
  if (Object.hasOwn(status, 'completedAt')) ISO(status.completedAt);
}

test('returns an exact queued acceptance before a deferred executor completes', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const gate = deferred();

  try {
    const accepted = manager.submit(OPERATION, async () => {
      return gate.promise;
    });

    assertAccepted(accepted);
    assert.equal(gate.settled, false);

    await nextTurn();
    assert.equal(gate.settled, false);
    const observed = manager.get(accepted.jobId);
    assert.ok(observed);
    assert.notEqual(observed.status, 'succeeded');
    assert.notEqual(observed.status, 'failed');
  } finally {
    gate.resolve({ ok: true });
    await nextTurn();
  }
});

test('runs A and B FIFO with at most one active executor and polling has no side effects', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const aGate = deferred();
  const bGate = deferred();
  let active = 0;
  let maximumActive = 0;
  let aCalls = 0;
  let bCalls = 0;
  let aSettled = false;
  const order = [];

  const runA = async () => {
    aCalls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('A');
    try {
      return await aGate.promise;
    } finally {
      active -= 1;
      aSettled = true;
    }
  };
  const runB = async () => {
    bCalls += 1;
    assert.equal(aSettled, true, 'B started before A settled');
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('B');
    try {
      return await bGate.promise;
    } finally {
      active -= 1;
    }
  };

  try {
    const acceptedA = manager.submit(OPERATION, runA);
    const acceptedB = manager.submit(OPERATION, runB);
    assertAccepted(acceptedA);
    assertAccepted(acceptedB);
    assert.notEqual(acceptedA.jobId, acceptedB.jobId);

    await waitFor(() => aCalls === 1, 'A to start');
    assert.deepEqual(order, ['A']);
    assert.equal(maximumActive, 1);
    assert.equal(bCalls, 0);
    const beforeB = manager.get(acceptedB.jobId);
    assert.ok(beforeB);
    assert.equal(beforeB.status, 'queued');

    const beforePoll = manager.get(acceptedA.jobId);
    assert.ok(beforePoll);
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(manager.get(acceptedA.jobId), beforePoll);
      assert.deepEqual(manager.get(acceptedB.jobId), beforeB);
    }
    assert.equal(aCalls, 1);
    assert.equal(bCalls, 0);

    aGate.resolve({ job: 'A' });
    await waitFor(() => bCalls === 1, 'B to start after A settles');
    assert.deepEqual(order, ['A', 'B']);
    assert.equal(maximumActive, 1);
    assert.equal(active, 1);

    bGate.resolve({ job: 'B' });
    await waitFor(() => manager.get(acceptedB.jobId)?.status === 'succeeded', 'B to succeed');
    assert.equal(aCalls, 1);
    assert.equal(bCalls, 1);
    assert.equal(maximumActive, 1);
    assert.deepEqual(manager.get(acceptedA.jobId)?.result, { job: 'A' });
    assert.deepEqual(manager.get(acceptedB.jobId)?.result, { job: 'B' });
    const terminalB = manager.get(acceptedB.jobId);
    assert.ok(terminalB);
    assert.deepEqual(manager.get(acceptedB.jobId), terminalB);
  } finally {
    aGate.resolve({ job: 'A-cleanup' });
    bGate.resolve({ job: 'B-cleanup' });
    await nextTurn();
  }
});

test('turns a synchronous executor throw into a safe failure and continues the queue', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const nextGate = deferred();
  let throwingCalls = 0;
  let nextCalls = 0;

  try {
    const failed = manager.submit(OPERATION, () => {
      throwingCalls += 1;
      throw new Error('secret sync failure');
    });
    const next = manager.submit(OPERATION, async () => {
      nextCalls += 1;
      return nextGate.promise;
    });

    await waitFor(() => manager.get(failed.jobId)?.status === 'failed', 'synchronous failure');
    const failedStatus = manager.get(failed.jobId);
    assert.ok(failedStatus);
    assertFailure(failedStatus);
    assert.equal(JSON.stringify(failedStatus).includes('secret sync failure'), false);
    assert.equal(throwingCalls, 1);

    await waitFor(() => nextCalls === 1, 'queue continuation after synchronous throw');
    assert.equal(manager.get(next.jobId)?.status, 'running');
    nextGate.resolve({ after: 'throw' });
    await waitFor(() => manager.get(next.jobId)?.status === 'succeeded', 'next job after synchronous throw');
    assert.equal(nextCalls, 1);
  } finally {
    nextGate.resolve({ after: 'throw-cleanup' });
    await nextTurn();
  }
});

test('turns an async rejection into a safe failure, continues the queue, and emits no unhandled rejection', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const nextGate = deferred();
  let rejectingCalls = 0;
  let nextCalls = 0;

  try {
    const failed = manager.submit(OPERATION, () => {
      rejectingCalls += 1;
      return Promise.reject(new Error('secret async failure'));
    });
    const next = manager.submit(OPERATION, async () => {
      nextCalls += 1;
      return nextGate.promise;
    });

    await waitFor(() => manager.get(failed.jobId)?.status === 'failed', 'async rejection');
    const failedStatus = manager.get(failed.jobId);
    assert.ok(failedStatus);
    assertFailure(failedStatus);
    assert.equal(JSON.stringify(failedStatus).includes('secret async failure'), false);
    assert.equal(rejectingCalls, 1);

    await waitFor(() => nextCalls === 1, 'queue continuation after async rejection');
    assert.equal(manager.get(next.jobId)?.status, 'running');
    nextGate.resolve({ after: 'reject' });
    await waitFor(() => manager.get(next.jobId)?.status === 'succeeded', 'next job after async rejection');
    assert.equal(nextCalls, 1);
  } finally {
    nextGate.resolve({ after: 'reject-cleanup' });
    await nextTurn();
  }
});

test('records ISO lifecycle timestamps and leaves repeated running and terminal polls unchanged', { timeout: 3000 }, async () => {
  let now = 1_000;
  const manager = createJobManager({ now: () => now });
  const gate = deferred();
  const result = {
    success: true,
    filename: 'episode.mp3',
    nested: { chapters: [{ title: 'intro', seconds: 4 }] },
  };

  try {
    const accepted = manager.submit(OPERATION, async () => gate.promise);
    now = 2_000;
    await waitFor(() => manager.get(accepted.jobId)?.status === 'running', 'running lifecycle state');
    const running = manager.get(accepted.jobId);
    assert.ok(running);
    assertRequiredStatusFields(running);
    assert.equal(running.status, 'running');
    assert.equal(running.stage, 'generating');
    assert.ok(Object.hasOwn(running, 'startedAt'));
    assert.equal(Object.hasOwn(running, 'completedAt'), false);
    assert.equal(Object.hasOwn(running, 'result'), false);
    now = 2_500;
    assert.deepEqual(manager.get(accepted.jobId), running);

    now = 3_000;
    gate.resolve(result);
    await waitFor(() => manager.get(accepted.jobId)?.status === 'succeeded', 'terminal lifecycle state');
    const terminal = manager.get(accepted.jobId);
    assert.ok(terminal);
    assertRequiredStatusFields(terminal);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.stage, 'completed');
    assert.ok(Object.hasOwn(terminal, 'startedAt'));
    assert.ok(Object.hasOwn(terminal, 'completedAt'));
    assert.ok(Object.hasOwn(terminal, 'result'));
    ISO(terminal.startedAt);
    ISO(terminal.completedAt);
    assert.equal(terminal.updatedAt, terminal.completedAt);
    assert.deepEqual(terminal.result, result);
    now = 3_500;
    assert.deepEqual(manager.get(accepted.jobId), terminal);
  } finally {
    gate.resolve(result);
    await nextTurn();
  }
});

test('retains terminal jobs from completion, never prunes running or queued jobs, and isolates fresh managers', { timeout: 3000 }, async () => {
  let now = 0;
  const retentionMs = 86_400_000;
  const manager = createJobManager({ now: () => now });
  const completedGate = deferred();
  const runningGate = deferred();
  const queuedGate = deferred();
  let runningCalls = 0;
  let queuedCalls = 0;

  try {
    const completed = manager.submit(OPERATION, async () => completedGate.promise);
    await waitFor(() => manager.get(completed.jobId)?.status === 'running', 'delayed job to run');
    now = 20;
    completedGate.resolve({ kind: 'completed' });
    await waitFor(() => manager.get(completed.jobId)?.status === 'succeeded', 'job completion');

    now = retentionMs + 19;
    assert.equal(manager.get(completed.jobId)?.status, 'succeeded');
    now = retentionMs + 20;
    assert.equal(manager.get(completed.jobId), undefined, 'terminal job did not expire at the TTL boundary');

    now = retentionMs + 200;
    const running = manager.submit(OPERATION, async () => {
      runningCalls += 1;
      return runningGate.promise;
    });
    await waitFor(() => manager.get(running.jobId)?.status === 'running', 'long-running job');
    const queued = manager.submit(OPERATION, async () => {
      queuedCalls += 1;
      return queuedGate.promise;
    });
    assert.equal(manager.get(queued.jobId)?.status, 'queued');

    now = retentionMs * 3;
    assert.equal(manager.get(running.jobId)?.status, 'running', 'running job was age-pruned');
    assert.equal(manager.get(queued.jobId)?.status, 'queued', 'queued job was age-pruned');
    assert.equal(runningCalls, 1);
    assert.equal(queuedCalls, 0);

    const freshManager = createJobManager({ now: () => now });
    assert.equal(freshManager.get(completed.jobId), undefined);
    assert.equal(freshManager.get(running.jobId), undefined);
  } finally {
    completedGate.resolve({ kind: 'completed-cleanup' });
    runningGate.resolve({ kind: 'running-cleanup' });
    queuedGate.resolve({ kind: 'queued-cleanup' });
    await nextTurn();
  }
});

test('returns detached acceptance and nested status snapshots', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const gate = deferred();
  const result = { success: true, metadata: { tags: ['original'], source: { id: 7 } } };
  const expectedResult = structuredClone(result);

  try {
    const accepted = manager.submit(OPERATION, async () => gate.promise);
    const originalJobId = accepted.jobId;
    mutate(accepted, 'jobId', 'corrupted-job-id');
    mutate(accepted, 'status', 'succeeded');
    mutate(accepted, 'stage', 'completed');
    mutate(accepted, 'message', 'corrupted message');

    gate.resolve(result);
    await waitFor(() => manager.get(originalJobId)?.status === 'succeeded', 'detached snapshot job');
    const first = manager.get(originalJobId);
    assert.ok(first);
    assert.equal(first.jobId, originalJobId);
    assert.deepEqual(first.result, expectedResult);

    mutate(first, 'jobId', 'corrupted-status-job-id');
    mutate(first, 'status', 'failed');
    mutate(first, 'stage', 'failed');
    mutate(first.result.metadata, 'tags', ['corrupted']);
    mutate(first.result.metadata.source, 'id', 999);
    const second = manager.get(originalJobId);
    assert.ok(second);
    assert.equal(second.jobId, originalJobId);
    assert.deepEqual(second.result, expectedResult);
    assert.deepEqual(manager.get(originalJobId), second);
  } finally {
    gate.resolve(result);
    await nextTurn();
  }
});

test('returns undefined for unknown or malformed IDs without creating or executing work', { timeout: 3000 }, async () => {
  const manager = createJobManager();
  const gate = deferred();
  let calls = 0;

  assert.equal(manager.get('not-a-uuid'), undefined);
  assert.equal(manager.get('00000000-0000-4000-8000-000000000000'), undefined);
  assert.equal(manager.get(''), undefined);
  assert.equal(calls, 0);

  const accepted = manager.submit(OPERATION, async () => {
    calls += 1;
    return gate.promise;
  });
  assert.match(accepted.jobId, UUID_V4);
  const callsAfterSubmit = calls;
  assert.equal(manager.get('still-not-a-job'), undefined);
  assert.equal(calls, callsAfterSubmit);
  gate.resolve({ ok: true });
  await nextTurn();
});
