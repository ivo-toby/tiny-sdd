import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendUsageRecord,
  importUsageRecords,
  normalizeUsageImport,
  readUsageRecords,
  validateUsageRecord,
  usageRecord,
} from '../src/usage.mjs';

const canonicalTmpdir = await realpath(tmpdir());

async function withProject(callback) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-usage-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function localRecord(overrides = {}) {
  return usageRecord({
    phase: 'review',
    model: 'frontier-model',
    taskId: 'task-one',
    input: 12,
    output: 8,
    ...overrides,
  });
}

function importEnvelope(records) {
  return {
    schemaVersion: 1,
    type: 'usage-import',
    source: 'pi-session',
    exportId: 'session-one',
    records,
  };
}

test('usageRecord validates phase, attribution, and nonnegative safe integer tokens', () => {
  const record = localRecord({ input: 0, output: 0, feature: 'talon-broker', taskId: undefined });
  assert.equal(record.input, 0);
  assert.equal(record.output, 0);
  assert.equal(record.feature, 'talon-broker');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.type, 'usage');
  assert.equal(record.provenance.source, 'tinysdd');

  for (const mutate of [
    { phase: 'unknown' },
    { model: '' },
    { input: -1 },
    { output: 1.5 },
    { input: Number.MAX_SAFE_INTEGER + 1 },
    { output: Infinity },
    { taskId: undefined, feature: undefined },
    { taskId: 'Bad Id' },
  ]) {
    assert.throws(() => localRecord(mutate), { code: 'USAGE_INVALID' });
  }
  assert.throws(() => usageRecord({ phase: 'review', model: 'm', taskId: 'task-one', input: 1, output: 1, extra: true }), { code: 'USAGE_INVALID' });
});

test('persisted validation requires canonical metadata and paired external provenance', () => {
  const record = localRecord();
  for (const field of ['schemaVersion', 'type', 'id', 'timestamp', 'model', 'input', 'output', 'provenance']) {
    const missing = { ...record };
    delete missing[field];
    assert.throws(() => validateUsageRecord(missing), { code: 'USAGE_LEDGER_INVALID' });
  }
  const missingSource = structuredClone(record);
  delete missingSource.provenance.source;
  assert.throws(() => validateUsageRecord(missingSource), { code: 'USAGE_LEDGER_INVALID' });
  const unpaired = structuredClone(record);
  unpaired.provenance.externalRecordId = 'entry-1';
  assert.throws(() => validateUsageRecord(unpaired), { code: 'USAGE_LEDGER_INVALID' });
  const incomplete = structuredClone(record);
  incomplete.id = undefined;
  incomplete.timestamp = undefined;
  assert.throws(() => validateUsageRecord(incomplete), { code: 'USAGE_LEDGER_INVALID' });
});

test('every attribution and token alias is validated and aliases must agree', () => {
  assert.throws(() => usageRecord({ ...localRecord(), feature: 'feature-one', featureId: 'Bad Id' }), { code: 'USAGE_INVALID' });
  assert.throws(() => usageRecord({ ...localRecord(), feature: 'feature-one', featureId: 'feature-two' }), { code: 'USAGE_INVALID' });
  assert.throws(() => usageRecord({ ...localRecord(), cacheRead: 1, cacheReadTokens: -1 }), { code: 'USAGE_INVALID' });
  assert.throws(() => usageRecord({ ...localRecord(), cacheWrite: 1, cacheWriteTokens: 2 }), { code: 'USAGE_INVALID' });
  const matching = usageRecord({ ...localRecord(), feature: 'feature-one', featureId: 'feature-one', cacheRead: 2, cacheReadTokens: 2, cacheWrite: 3, cacheWriteTokens: 3 });
  assert.equal(matching.feature, 'feature-one');
  assert.equal(matching.cacheRead, 2);
  assert.equal(matching.cacheWrite, 3);
});

test('append and read preserve known zero and provenance under a bounded ledger', async () => {
  await withProject(async (root) => {
    const first = await appendUsageRecord(root, localRecord({ input: 0, output: 4 }));
    const second = await appendUsageRecord(root, localRecord({ taskId: undefined, feature: 'talon-broker', input: 3, output: 0 }));
    const records = await readUsageRecords(root);
    assert.deepEqual(records.map((record) => record.id), [first.id, second.id]);
    assert.equal(records[0].input, 0);
    assert.equal(records[1].output, 0);
    assert.equal(records.length, 2);
    assert.match(await readFile(join(root, '.tinysdd', 'runs', 'usage.jsonl'), 'utf8'), /\n$/u);
  });
});

test('normalized imports retain unknown usage and stable external provenance', async () => {
  const input = importEnvelope([{
    externalRecordId: 'entry-1',
    timestamp: '2026-10-03T00:00:00Z',
    phase: 'review',
    model: null,
    feature: 'talon-broker',
    input: 0,
    output: 0,
  }]);
  const normalized = normalizeUsageImport(input);
  assert.equal(normalized.records[0].model, null);
  assert.equal(normalized.records[0].input, 0);
  assert.equal(normalized.records[0].output, 0);
  assert.equal(normalized.records[0].provenance.externalRecordId, 'entry-1');
  assert.equal(normalized.records[0].id, normalizeUsageImport(input).records[0].id);

  await withProject(async (root) => {
    const imported = await importUsageRecords(root, input);
    assert.equal(imported.length, 1);
    assert.deepEqual(await readUsageRecords(root), imported);
  });
});

test('imports validate supplied provenance before applying envelope provenance', () => {
  const base = { externalRecordId: 'entry-1', phase: 'review', model: 'm', feature: 'f', input: 1, output: 2 };
  const invalidSource = { ...base, provenance: { source: { invalid: true }, exportId: 'session-one', externalRecordId: 'entry-1' } };
  assert.throws(() => normalizeUsageImport(importEnvelope([invalidSource])), { code: 'USAGE_IMPORT_INVALID' });
  const invalidExport = { ...base, provenance: { source: 'pi-session', exportId: 'bad id', externalRecordId: 'entry-1' } };
  assert.throws(() => normalizeUsageImport(importEnvelope([invalidExport])), { code: 'USAGE_IMPORT_INVALID' });
  const conflictingExternal = { ...base, provenance: { source: 'pi-session', exportId: 'session-one', externalRecordId: 'entry-2' } };
  assert.throws(() => normalizeUsageImport(importEnvelope([conflictingExternal])), { code: 'USAGE_IMPORT_INVALID' });
  const conflictingSource = { ...base, provenance: { source: 'other-source', exportId: 'session-one', externalRecordId: 'entry-1' } };
  assert.throws(() => normalizeUsageImport(importEnvelope([conflictingSource])), { code: 'USAGE_IMPORT_INVALID' });
  const conflictingDigest = { ...base, provenance: { source: 'pi-session', exportId: 'session-one', externalRecordId: 'entry-1', sourceDigest: 'a'.repeat(64) } };
  assert.throws(() => normalizeUsageImport({ ...importEnvelope([conflictingDigest]), sourceDigest: 'b'.repeat(64) }), { code: 'USAGE_IMPORT_INVALID' });
});

test('imports validate the complete envelope before appending and reject duplicate external ids', async () => {
  await withProject(async (root) => {
    const valid = importEnvelope([{ externalRecordId: 'entry-1', phase: 'review', model: 'm', feature: 'f', input: 1, output: 2 }]);
    await assert.rejects(
      importUsageRecords(root, importEnvelope([
        valid.records[0],
        { externalRecordId: 'entry-2', phase: 'not-a-phase', model: 'm', feature: 'f', input: 3, output: 4 },
      ])),
      { code: 'USAGE_IMPORT_INVALID' },
    );
    assert.deepEqual(await readUsageRecords(root), []);

    await importUsageRecords(root, valid);
    await assert.rejects(importUsageRecords(root, valid), { code: 'USAGE_DUPLICATE' });
    assert.equal((await readUsageRecords(root)).length, 1);
  });
});

test('refuses malformed and partial ledger records without silently skipping them', async () => {
  await withProject(async (root) => {
    const ledgerDirectory = join(root, '.tinysdd', 'runs');
    await mkdir(ledgerDirectory, { recursive: true });
    const ledger = join(ledgerDirectory, 'usage.jsonl');
    await writeFile(ledger, `${JSON.stringify(localRecord())}\n{"schemaVersion":1`, 'utf8');
    await assert.rejects(readUsageRecords(root), { code: 'USAGE_LEDGER_PARTIAL' });
    await assert.rejects(appendUsageRecord(root, localRecord()), { code: 'USAGE_LEDGER_PARTIAL' });
  });
});

test('refuses symlinked internal parents and ledger files', async () => {
  await withProject(async (root) => {
    const outside = await mkdtemp(join(canonicalTmpdir, 'tinysdd-usage-outside-'));
    try {
      await symlink(outside, join(root, '.tinysdd'));
      await assert.rejects(appendUsageRecord(root, localRecord()), { code: 'SYMLINK_PATH' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await withProject(async (root) => {
    const ledgerDirectory = join(root, '.tinysdd', 'runs');
    await mkdir(ledgerDirectory, { recursive: true });
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, '', 'utf8');
    await symlink(outside, join(ledgerDirectory, 'usage.jsonl'));
    await assert.rejects(readUsageRecords(root), { code: 'SYMLINK_PATH' });
  });
});
