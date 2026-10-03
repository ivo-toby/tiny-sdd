import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_WORKER_RESULT_BYTES,
  USAGE_UNKNOWN,
  buildUsageReport,
  freezeUsageReport,
} from '../src/usage-report.mjs';
import { usageRecord } from '../src/usage.mjs';

const canonicalTmpdir = await realpath(tmpdir());

async function withProject(callback) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-usage-report-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function eventMessage(id, usage) {
  return `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', id, usage } })}\n`;
}

function turnMessage(id, usage) {
  return `${JSON.stringify({ type: 'turn_end', message: { role: 'assistant', id, usage } })}\n`;
}

function workerResult(runId, taskId, overrides = {}) {
  return {
    schemaVersion: 1,
    runId,
    taskId,
    outcome: 'completed',
    observed: {
      processTermination: { elapsedMs: 25 },
      cumulativeUsage: { assistantMessages: 1, input: 10, output: 5, reasoning: 1, totalTokens: 15 },
    },
    ...overrides,
  };
}

async function writeRun(root, runId, result, stdout = undefined) {
  const directory = join(root, '.tinysdd', 'runs', runId);
  await mkdir(directory, { recursive: true });
  if (result !== undefined) await writeFile(join(directory, 'result.json'), JSON.stringify(result), 'utf8');
  if (stdout !== undefined) await writeFile(join(directory, 'stdout.jsonl'), stdout, 'utf8');
}

function frontierRecord(overrides = {}) {
  return usageRecord({
    phase: 'review',
    model: 'frontier-model',
    feature: 'talon-broker',
    input: 100,
    output: 20,
    ...overrides,
  });
}

test('reports frontier phases and complete worker usage with zero distinct from unknown', async () => {
  await withProject(async (root) => {
    await writeRun(
      root,
      'worker-a',
      workerResult('worker-a', 'task-a'),
      eventMessage('message-a', { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 15 }),
    );
    await writeRun(
      root,
      'worker-b',
      workerResult('worker-b', 'task-b', { observed: { processTermination: { elapsedMs: 8 }, cumulativeUsage: { assistantMessages: 1, input: 0, output: 0, reasoning: 0, totalTokens: 0 } } }),
      eventMessage('message-b', { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    );
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [
        { id: 'task-a', feature: 'talon-broker', runIds: ['worker-a'] },
        { id: 'task-b', feature: 'talon-broker', runIds: ['worker-b'] },
      ],
      usageRecords: [frontierRecord({ input: 0, output: 0 })],
      generatedAt: '2026-10-03T00:00:00.000Z',
    });
    assert.equal(report.frontier.byPhase.review.input, 0);
    assert.equal(report.frontier.byPhase.review.output, 0);
    assert.equal(report.frontier.totals.input, USAGE_UNKNOWN);
    assert.equal(report.frontier.totals.knownSubtotals.input, 0);
    assert.ok(report.frontier.totals.missing.some((reason) => /plan:/u.test(reason)));
    assert.equal(report.local.byTask['task-a'].input, 10);
    assert.equal(report.local.byTask['task-a'].reasoning, 1);
    assert.equal(report.local.byTask['task-a'].cacheRead, 2);
    assert.equal(report.local.byTask['task-a'].cacheWrite, 0);
    assert.equal(report.local.byTask['task-b'].input, 0);
    assert.equal(report.local.byTask['task-b'].output, 0);
    assert.equal(report.local.byTask['task-a'].elapsedMs, 25);
    assert.equal(report.local.byTask['task-b'].elapsedMs, 8);
    assert.equal(report.local.byTask['task-a'].missing.length, 0);
    assert.equal(report.local.byTask['task-b'].missing.length, 0);
    assert.equal(report.feature, 'talon-broker');
    assert.equal(report.generatedAt, '2026-10-03T00:00:00.000Z');
  });
});

test('uses message_end over turn_end, keeps partial totals unknown, and preserves known subtotals', async () => {
  await withProject(async (root) => {
    const result = workerResult('worker-revision', 'task-a', {
      outcome: 'timeout',
      observed: {
        processTermination: { elapsedMs: 40 },
        cumulativeUsage: { assistantMessages: 2, input: 30, output: 12, reasoning: null, totalTokens: 42 },
      },
    });
    await writeRun(root, 'worker-revision', result, `${eventMessage('message-end', { input: 3, output: 2, totalTokens: 5 })}${turnMessage('turn-end', { input: 100, output: 100, totalTokens: 200 })}`);
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-revision'] }],
    });
    const task = report.local.byTask['task-a'];
    assert.equal(task.input, USAGE_UNKNOWN);
    assert.equal(task.output, USAGE_UNKNOWN);
    assert.equal(task.knownSubtotals.input, 30);
    assert.equal(task.knownSubtotals.output, 12);
    assert.ok(task.missing.some((reason) => /response coverage/u.test(reason)));
    assert.equal(report.local.runIds.length, 1);
  });
});

test('uses a complete message_end response when turn_end disagrees', async () => {
  await withProject(async (root) => {
    await writeRun(
      root,
      'worker-authoritative',
      workerResult('worker-authoritative', 'task-a', {
        observed: {
          processTermination: { elapsedMs: 40 },
          cumulativeUsage: { assistantMessages: 1, input: 3, output: 1, reasoning: 0, totalTokens: 4 },
        },
      }),
      `${eventMessage('message-end', { input: 3, output: 1, reasoning: 0, totalTokens: 4 })}${turnMessage('turn-end', { input: 99, output: 99, reasoning: 0, totalTokens: 198 })}`,
    );
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-authoritative'] }],
    });
    assert.equal(report.local.byTask['task-a'].input, 3);
    assert.equal(report.local.byTask['task-a'].output, 1);
  });
});

test('deduplicates a revision base chain and does not count baseline provenance', async () => {
  await withProject(async (root) => {
    await writeRun(root, 'worker-root', workerResult('worker-root', 'task-a', {
      observed: { processTermination: { elapsedMs: 25 }, cumulativeUsage: { assistantMessages: 1, input: 1, output: 1, reasoning: 0, totalTokens: 2 } },
    }), eventMessage('root-message', { input: 1, output: 1, reasoning: 0, totalTokens: 2 }));
    await writeRun(root, 'worker-revision', workerResult('worker-revision', 'task-a', {
      baseRun: { id: 'worker-root' },
      baselineRun: { id: 'worker-baseline' },
      observed: { processTermination: { elapsedMs: 30 }, cumulativeUsage: { assistantMessages: 1, input: 2, output: 2, reasoning: 0, totalTokens: 4 } },
    }), eventMessage('revision-message', { input: 2, output: 2, reasoning: 0, totalTokens: 4 }));
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-root', 'worker-revision'] }],
    });
    assert.deepEqual(report.local.runIds, ['worker-revision', 'worker-root']);
    assert.deepEqual(report.local.revisionRunIds, ['worker-revision']);
    assert.equal(report.local.totals.input, 3);
    assert.equal(report.provenance.runReferences.length, 2);
    assert.equal(report.provenance.runReferences.some((ref) => ref.runId === 'worker-baseline'), false);
    assert.equal(report.provenance.runReferences.find((ref) => ref.runId === 'worker-revision').baselineRunId, 'worker-baseline');
  });
});

test('retains missing results and missing telemetry as explicit provenance', async () => {
  await withProject(async (root) => {
    const partial = workerResult('worker-partial', 'task-a', { observed: { processTermination: { elapsedMs: 12 }, cumulativeUsage: { assistantMessages: 1, input: 9, output: 4, reasoning: null, totalTokens: 13 } } });
    await writeRun(root, 'worker-partial', partial);
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [
        { id: 'task-a', feature: 'talon-broker', runIds: ['worker-partial'] },
        { id: 'task-b', feature: 'talon-broker', runIds: ['worker-missing'] },
      ],
    });
    assert.equal(report.local.byTask['task-a'].input, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-a'].knownSubtotals.input, 9);
    assert.equal(report.local.byTask['task-b'].input, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-b'].knownSubtotals.input, null);
    assert.ok(report.provenance.missing.some((entry) => entry.runId === 'worker-partial' && /stdout/u.test(entry.reason)));
    assert.ok(report.provenance.missing.some((entry) => entry.runId === 'worker-missing' && /result/u.test(entry.reason)));
    assert.deepEqual(report.local.runIds, ['worker-missing', 'worker-partial']);
    assert.equal(report.local.totals.input, USAGE_UNKNOWN);
    assert.equal(report.local.totals.knownSubtotals.input, 9);
  });
});

test('discovers attributable runs, retains in-flight attempts, and excludes unrelated directories', async () => {
  await withProject(async (root) => {
    await writeRun(root, 'worker-discovered', workerResult('worker-discovered', 'task-a', { baselineRun: { id: 'worker-baseline' } }), eventMessage('discovered-message', { input: 4, output: 2, reasoning: 1, totalTokens: 6 }));
    await writeFile(
      join(root, '.tinysdd', 'runs', 'worker-discovered', 'packet.json'),
      JSON.stringify({ taskId: 'task-a' }),
      'utf8',
    );
    await writeRun(root, 'worker-inflight');
    await writeFile(join(root, '.tinysdd', 'runs', 'worker-inflight', 'packet.json'), JSON.stringify({ taskId: 'task-a' }), 'utf8');
    await writeRun(root, 'worker-outside', workerResult('worker-outside', 'task-b'), eventMessage('outside-message', { input: 8, output: 4, totalTokens: 12 }));
    await writeFile(join(root, '.tinysdd', 'runs', 'worker-outside', 'packet.json'), JSON.stringify({ taskId: 'task-b' }), 'utf8');
    await writeRun(root, 'worker-unattributed');
    await writeRun(root, '.bench', workerResult('.bench', 'task-a'), eventMessage('bench-message', { input: 99, output: 99, totalTokens: 198 }));
    await writeFile(join(root, '.tinysdd', 'runs', 'controller.json'), '{}', 'utf8');
    await writeFile(join(root, '.tinysdd', 'runs', 'usage.jsonl'), '', 'utf8');

    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker' }],
    });
    assert.deepEqual(report.local.runIds, ['worker-discovered', 'worker-inflight']);
    assert.equal(report.local.byTask['task-a'].input, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-a'].knownSubtotals.input, 10);
    assert.ok(report.provenance.missing.some((entry) => entry.runId === 'worker-inflight' && /result/u.test(entry.reason)));
    assert.ok(report.provenance.missing.some((entry) => entry.runId === 'worker-unattributed'));
    assert.equal(report.provenance.runReferences.some((ref) => ref.runId === 'worker-outside'), false);
    assert.equal(report.provenance.runReferences.some((ref) => ref.runId === '.bench'), false);
    assert.equal(report.provenance.runReferences.find((ref) => ref.runId === 'worker-discovered').baselineRunId, 'worker-baseline');
  });
});

test('does not infer observed zero from an all-zero cumulative object without coverage', async () => {
  await withProject(async (root) => {
    await writeRun(root, 'worker-zero-unknown', workerResult('worker-zero-unknown', 'task-a', {
      observed: { processTermination: { elapsedMs: 2 }, cumulativeUsage: { assistantMessages: 1, input: 0, output: 0, reasoning: null, totalTokens: 0 } },
    }));
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-zero-unknown'] }],
    });
    assert.equal(report.local.byTask['task-a'].input, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-a'].output, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-a'].knownSubtotals.input, null);
  });

  await withProject(async (root) => {
    await writeRun(root, 'worker-empty', workerResult('worker-empty', 'task-a', {
      observed: { processTermination: { elapsedMs: 2 }, cumulativeUsage: { assistantMessages: 0, input: 9, output: 0, reasoning: 0, totalTokens: 9 } },
    }), '');
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-empty'] }],
    });
    assert.equal(report.local.byTask['task-a'].input, USAGE_UNKNOWN);
    assert.equal(report.local.byTask['task-a'].knownSubtotals.input, 9);
    assert.ok(report.local.byTask['task-a'].missing.some((reason) => /response coverage/u.test(reason)));
  });
});

test('propagates component coverage gaps into local and ledger provenance', async () => {
  await withProject(async (root) => {
    await writeRun(
      root,
      'worker-component-gap',
      workerResult('worker-component-gap', 'task-a', {
        observed: {
          processTermination: { elapsedMs: 4 },
          cumulativeUsage: { assistantMessages: 1, input: 3, output: 2, reasoning: 0, totalTokens: 5 },
        },
      }),
      eventMessage('component-gap', { input: 3, reasoning: 0, totalTokens: 3 }),
    );
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-component-gap'] }],
    });
    assert.equal(report.local.byTask['task-a'].input, 3);
    assert.equal(report.local.byTask['task-a'].output, USAGE_UNKNOWN);
    assert.ok(report.local.byTask['task-a'].missing.some((reason) => /missing output usage coverage/u.test(reason)));
    assert.ok(report.local.totals.missing.some((reason) => /missing output usage coverage/u.test(reason)));
    assert.ok(report.provenance.missing.some((entry) => /missing output usage coverage/u.test(entry.reason)));
  });
});

test('keeps elapsed totals unknown when safe integer durations overflow', async () => {
  const elapsed = Number.MAX_SAFE_INTEGER;
  const report = await buildUsageReport({
    feature: 'talon-broker',
    tasks: [{
      id: 'task-a',
      feature: 'talon-broker',
      runIds: [
        { runId: 'worker-duration-a', result: workerResult('worker-duration-a', 'task-a', { observed: { processTermination: { elapsedMs: elapsed }, cumulativeUsage: { assistantMessages: 1, input: 1, output: 1, reasoning: 0, totalTokens: 2 } } }), stdout: eventMessage('duration-a', { input: 1, output: 1, reasoning: 0, totalTokens: 2 }) },
        { runId: 'worker-duration-b', result: workerResult('worker-duration-b', 'task-a', { observed: { processTermination: { elapsedMs: elapsed }, cumulativeUsage: { assistantMessages: 1, input: 1, output: 1, reasoning: 0, totalTokens: 2 } } }), stdout: eventMessage('duration-b', { input: 1, output: 1, reasoning: 0, totalTokens: 2 }) },
      ],
    }],
  });
  assert.equal(report.local.totals.elapsedMs, USAGE_UNKNOWN);
  assert.equal(report.local.totals.knownElapsedMs, null);
  assert.ok(report.local.totals.missing.includes('elapsed subtotal exceeds safe integer'));
});

test('refuses symlinked run paths and records bounded oversized result provenance', async () => {
  await withProject(async (root) => {
    const outside = await mkdtemp(join(canonicalTmpdir, 'tinysdd-usage-report-outside-'));
    try {
      await mkdir(join(root, '.tinysdd'), { recursive: true });
      await symlink(outside, join(root, '.tinysdd', 'runs'));
      await assert.rejects(
        buildUsageReport({ projectRoot: root, feature: 'talon-broker', tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-a'] }] }),
        { code: 'SYMLINK_PATH' },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await withProject(async (root) => {
    const oversized = `${JSON.stringify(workerResult('worker-large', 'task-a'))}${'x'.repeat(MAX_WORKER_RESULT_BYTES)}`;
    await writeRun(root, 'worker-large', undefined);
    await writeFile(join(root, '.tinysdd', 'runs', 'worker-large', 'result.json'), oversized, 'utf8');
    const report = await buildUsageReport({
      projectRoot: root,
      feature: 'talon-broker',
      tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: ['worker-large'] }],
    });
    assert.equal(report.local.byTask['task-a'].input, USAGE_UNKNOWN);
    assert.ok(report.provenance.missing.some((entry) => /exceeds/u.test(entry.reason)));
    assert.equal(report.provenance.runReferences[0].result.sha256, null);
  });
});

test('freezes report numbers and provenance as a copy', async () => {
  const report = await buildUsageReport({
    feature: 'talon-broker',
    tasks: [{ id: 'task-a', feature: 'talon-broker', runIds: [{ runId: 'worker-a', result: workerResult('worker-a', 'task-a'), stdout: eventMessage('message-a', { input: 1, output: 2, totalTokens: 3 }) }] }],
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.snapshot), true);
  assert.equal(report.snapshot.runReferences[0].result.sha256.length, 64);
  assert.throws(() => { report.local.byTask['task-a'].input = 99; }, TypeError);
  const copy = freezeUsageReport(report);
  assert.notEqual(copy, report);
  assert.deepEqual(copy.snapshot, report.snapshot);
});
