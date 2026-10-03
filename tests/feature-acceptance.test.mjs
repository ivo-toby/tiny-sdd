import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acceptFeature,
  addTask,
  approveTask,
  closeTask,
  reportFeature,
  reviewTask,
} from '../src/controller.mjs';
import { appendUsageRecord } from '../src/usage.mjs';
import { readFeatureEvents } from '../src/feature-events.mjs';

const canonicalTmpdir = await realpath(tmpdir());

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-feature-acceptance-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
  await mkdir(join(root, '.tinysdd', 'reviews'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), 'accepted evidence\n');
  const { initProject } = await import('../src/controller.mjs');
  await initProject(root);
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function acceptedTask(root, id, options = {}) {
  const { evidence = '.tinysdd/reviews/evidence.md', ...taskOptions } = options;
  await addTask(root, { id, brief: 'docs/brief.md', allow: [`src/${id}.ts`], ...taskOptions });
  await approveTask(root, { id, by: 'operator', reason: 'approved scope' });
  await reviewTask(root, { id, verdict: 'accepted', evidence, by: 'reviewer' });
}

test('feature acceptance enforces labelled active tasks and permits an all-retired feature', async () => {
  const root = await project();
  try {
    await assert.rejects(acceptFeature(root, { feature: 'missing', by: 'operator', reason: 'close window' }), { code: 'FEATURE_NOT_FOUND' });
    await addTask(root, { id: 'open', feature: 'broker', brief: 'docs/brief.md', allow: ['src/open.ts'] });
    await assert.rejects(acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'close window' }), { code: 'FEATURE_NOT_ACCEPTED' });
    await closeTask(root, { id: 'open', by: 'operator', reason: 'retired before acceptance' });
    const accepted = await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'retired feature window' });
    assert.equal(accepted.acceptance.activeAcceptanceDigests && Object.keys(accepted.acceptance.activeAcceptanceDigests).length, 0);
    assert.deepEqual(accepted.acceptance.membership, [{ id: 'open', retired: true }]);
  } finally {
    await cleanup(root);
  }
});

test('acceptance appends a frozen snapshot without changing controller state', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    const statePath = join(root, '.tinysdd', 'runs', 'controller.json');
    const before = await readFile(statePath, 'utf8');
    const accepted = await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    assert.equal(await readFile(statePath, 'utf8'), before);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.stale, false);
    assert.equal(accepted.acceptance.feature, 'broker');
    assert.equal(accepted.acceptance.membership[0].id, 'one');
    assert.equal(Object.isFrozen(accepted.report), true);
    assert.equal((await readFeatureEvents(root)).length, 1);
    const reported = await reportFeature(root, { feature: 'broker' });
    assert.equal(reported.accepted, true);
    assert.equal(reported.stale, false);
    assert.deepEqual(reported.report, accepted.report);
  } finally {
    await cleanup(root);
  }
});

test('report preserves the accepted numbers when membership or freshness becomes stale', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    const snapshot = await reportFeature(root, { feature: 'broker' });
    await writeFile(join(root, 'docs', 'brief.md'), '# Brief changed\n');
    await addTask(root, { id: 'two', feature: 'broker', brief: 'docs/brief.md', allow: ['src/two.ts'] });
    const stale = await reportFeature(root, { feature: 'broker' });
    assert.equal(stale.stale, true);
    assert.ok(stale.staleReasons.some((reason) => /membership/u.test(reason)));
    assert.ok(stale.staleReasons.some((reason) => /task one/u.test(reason)));
    assert.deepEqual(stale.report, snapshot.report);
  } finally {
    await cleanup(root);
  }
});

test('late usage stays outside an accepted snapshot until explicit re-acceptance', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    const first = await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'first window' });
    const late = await appendUsageRecord(root, { phase: 'review', model: 'frontier', feature: 'broker', input: 4, output: 2 });
    const unchanged = await reportFeature(root, { feature: 'broker' });
    assert.deepEqual(unchanged.report, first.report);
    assert.equal(first.report.frontier.ledgerRecordIds.includes(late.id), false);
    const second = await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'second window' });
    assert.notEqual(second.acceptance.id, first.acceptance.id);
    assert.deepEqual(second.report.frontier.ledgerRecordIds, [late.id]);
    assert.equal(second.report.frontier.byPhase.review.input, 4);
    assert.equal((await readFeatureEvents(root)).length, 2);
  } finally {
    await cleanup(root);
  }
});

test('marks membership-only retirements stale without changing active acceptance digests', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    await addTask(root, { id: 'retired', feature: 'broker', brief: 'docs/brief.md', allow: ['src/retired.ts'] });
    await closeTask(root, { id: 'retired', by: 'operator', reason: 'removed from feature' });
    const stale = await reportFeature(root, { feature: 'broker' });
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.staleReasons, ['labelled task membership changed']);
  } finally {
    await cleanup(root);
  }
});

test('marks evidence, allowed-file, and dependency freshness changes stale', async () => {
  const evidenceRoot = await project();
  try {
    await acceptedTask(evidenceRoot, 'one', { feature: 'broker' });
    await acceptFeature(evidenceRoot, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    await writeFile(join(evidenceRoot, '.tinysdd', 'reviews', 'evidence.md'), 'changed evidence\n');
    const stale = await reportFeature(evidenceRoot, { feature: 'broker' });
    assert.equal(stale.stale, true);
    assert.ok(stale.staleReasons.some((reason) => /acceptance digests|task one/u.test(reason)));
  } finally {
    await cleanup(evidenceRoot);
  }

  const allowedRoot = await project();
  try {
    await acceptedTask(allowedRoot, 'one', { feature: 'broker' });
    await acceptFeature(allowedRoot, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    await mkdir(join(allowedRoot, 'src'), { recursive: true });
    await writeFile(join(allowedRoot, 'src', 'one.ts'), 'late file\n');
    const stale = await reportFeature(allowedRoot, { feature: 'broker' });
    assert.equal(stale.stale, true);
    assert.ok(stale.staleReasons.some((reason) => /acceptance digests|task one/u.test(reason)));
  } finally {
    await cleanup(allowedRoot);
  }

  const dependencyRoot = await project();
  try {
    await writeFile(join(dependencyRoot, '.tinysdd', 'reviews', 'dependency.md'), 'dependency evidence\n');
    await writeFile(join(dependencyRoot, '.tinysdd', 'reviews', 'main.md'), 'main evidence\n');
    await acceptedTask(dependencyRoot, 'dependency', { feature: 'broker', evidence: '.tinysdd/reviews/dependency.md' });
    await acceptedTask(dependencyRoot, 'main', { feature: 'broker', dependsOn: ['dependency'], evidence: '.tinysdd/reviews/main.md' });
    await acceptFeature(dependencyRoot, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    await writeFile(join(dependencyRoot, '.tinysdd', 'reviews', 'dependency.md'), 'dependency evidence changed\n');
    const stale = await reportFeature(dependencyRoot, { feature: 'broker' });
    assert.equal(stale.stale, true);
    assert.ok(stale.staleReasons.some((reason) => /task dependency/u.test(reason)));
  } finally {
    await cleanup(dependencyRoot);
  }
});

test('rejects persisted feature events with malformed frozen reports', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    const ledgerPath = join(root, '.tinysdd', 'runs', 'feature-events.jsonl');
    const event = JSON.parse((await readFile(ledgerPath, 'utf8')).trim());
    delete event.report.local;
    await writeFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8');
    await assert.rejects(readFeatureEvents(root), { code: 'FEATURE_EVENT_INVALID' });
  } finally {
    await cleanup(root);
  }
});

test('rejects a partial trailing feature event record', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    const ledgerPath = join(root, '.tinysdd', 'runs', 'feature-events.jsonl');
    const content = await readFile(ledgerPath, 'utf8');
    await writeFile(ledgerPath, content.trimEnd(), 'utf8');
    await assert.rejects(readFeatureEvents(root), { code: 'FEATURE_LEDGER_PARTIAL' });
  } finally {
    await cleanup(root);
  }
});

test('rejects malformed persisted report numbers, phases, membership, and references', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    const runDirectory = join(root, '.tinysdd', 'runs', 'worker-one');
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, 'packet.json'), JSON.stringify({ taskId: 'one' }), 'utf8');
    await writeFile(join(runDirectory, 'result.json'), JSON.stringify({ runId: 'worker-one', taskId: 'one', observed: { cumulativeUsage: { assistantMessages: 1, input: 1, output: 1, totalTokens: 2 }, processTermination: { elapsedMs: 1 } } }), 'utf8');
    await writeFile(join(runDirectory, 'stdout.jsonl'), `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2 } } })}\n`, 'utf8');
    await acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'feature complete' });
    const ledgerPath = join(root, '.tinysdd', 'runs', 'feature-events.jsonl');
    const pristine = await readFile(ledgerPath, 'utf8');
    const variants = [
      (event) => { event.report.local.totals.input = -1; },
      (event) => { event.report.frontier.byPhase = {}; },
      (event) => { event.report.tasks = []; },
      (event) => { event.report.snapshot.runReferences = []; },
      (event) => { event.report.provenance.runReferences[0].result.path = '../../outside'; },
      (event) => { event.report.local.totals.input = 'UNKNOWN'; event.report.local.totals.coverage.input = { observed: 4, expected: 1, complete: true }; },
      (event) => {
        for (const section of ['provenance', 'snapshot']) {
          const reference = event.report[section].runReferences[0];
          reference.result.runId = 'other';
          reference.result.path = '.tinysdd/runs/other/result.json';
        }
      },
      (event) => {
        for (const section of ['provenance', 'snapshot']) {
          const references = event.report[section].runReferences[0];
          [references.result, references.stdout] = [references.stdout, references.result];
        }
      },
      (event) => {
        for (const section of ['provenance', 'snapshot']) event.report[section].runReferences[0].taskId = 'outside';
      },
      (event) => { event.report.local.totals.input = 3; event.report.local.totals.coverage.input = { observed: 0, expected: 1, complete: false }; },
      (event) => { event.report.local.byTask.one.retired = true; },
      (event) => { event.report.local.runIds = []; },
      (event) => { event.report.frontier.ledgerRecordIds = ['invented']; },
    ];
    for (const mutate of variants) {
      const event = JSON.parse(pristine.trim());
      mutate(event);
      await writeFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8');
      await assert.rejects(reportFeature(root, { feature: 'broker' }), { code: 'FEATURE_EVENT_INVALID' });
    }
  } finally {
    await cleanup(root);
  }
});

test('feature acceptance and report refuse symlinked event ledger paths', async () => {
  const root = await project();
  try {
    await acceptedTask(root, 'one', { feature: 'broker' });
    const outside = await mkdtemp(join(canonicalTmpdir, 'tinysdd-feature-events-outside-'));
    try {
      await symlink(outside, join(root, '.tinysdd', 'runs', 'feature-events.jsonl'));
      await assert.rejects(reportFeature(root, { feature: 'broker' }), { code: 'SYMLINK_PATH' });
      await assert.rejects(acceptFeature(root, { feature: 'broker', by: 'operator', reason: 'blocked path' }), { code: 'SYMLINK_PATH' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await cleanup(root);
  }
});
