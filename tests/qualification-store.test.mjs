import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import { buildQualificationRecord, rescoreQualificationRecord, validateQualificationRecord } from '../src/qualification.mjs';
import {
  persistQualificationRecord,
  compareQualificationApplicability,
  qualificationRecordPath,
  readQualificationProfileReferences,
  readQualificationRecord,
  replaceQualificationRecord,
  writeQualificationRecord,
} from '../src/qualification-store.mjs';

const digest = (letter) => letter.repeat(64);

function record() {
  const identity = buildBenchmarkConfigIdentity({
    model: { provider: 'fake', id: 'model', quantization: 'Q4', server: { id: 'server', version: '1' } },
    worker: { profileDigest: digest('a'), limits: { timeoutMs: 1000, maxToolCalls: 10, firstWriteMs: null }, settings: { sandbox: 'test' } },
    pi: { version: 'test' },
    tinySdd: { version: '0.1.0', codeRevision: digest('b') },
    suite: { id: 'store-suite', version: '1', contentSha256: digest('c') },
    verifier: { configSha256: digest('d'), checkRunner: { version: 'runCheck-v1', configSha256: digest('e') } },
    runChecks: { declared: true, available: false, budget: 12, unavailableReason: 'test unavailable', provenance: { source: 'test', unavailableReason: 'test unavailable' } },
    environment: { runtime: 'node', runtimeVersion: 'test', platform: 'test', arch: 'test' },
  });
  return buildQualificationRecord({
    configIdentity: identity.identity,
    configDigest: identity.configDigest,
    suite: { id: 'store-suite', version: '1', sha256: digest('c') },
    roles: {
      'implement-slice': {
        n: 1,
        passes: 1,
        target: 0.8,
        perChallenge: [{ id: 'challenge-a', version: '1', sha256: digest('f'), n: 1, passes: 1, results: [{ attemptId: 'attempt-1', repetition: 1, passed: true }] }],
      },
    },
  });
}

function oversizedRecord() {
  const value = record();
  value.roles['implement-slice'].perChallenge[0].version = 'x'.repeat(4 * 1024 * 1024 + 1);
  validateQualificationRecord(value);
  return value;
}

test('stores records under a locked config path and preserves distinct profile associations on replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-qualification-store-'));
  try {
    await mkdir(join(root, '.tinysdd'), { recursive: true });
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'a.json'), JSON.stringify({ schemaVersion: 1, id: 'profile-a' }));
    const original = record();
    const first = await persistQualificationRecord(root, original, { profilePath: 'profiles/a.json', profile: { schemaVersion: 1, id: 'profile-a' }, workerName: 'worker-a' });
    const second = await persistQualificationRecord(root, original, { replace: true, profilePath: 'profiles/a.json', profile: { schemaVersion: 1, id: 'profile-a' }, workerName: 'worker-b' });
    const references = await readQualificationProfileReferences(root);
    assert.equal(references.associations.length, 2);
    assert.ok(references.associations.every((entry) => entry.record.path === first.path && entry.record.sha256 === second.sha256));

    await writeFile(join(root, 'profiles', 'a.json'), JSON.stringify({ schemaVersion: 1, id: 'profile-a-changed' }));
    const stale = await readQualificationProfileReferences(root);
    assert.ok(stale.profileStatuses.every((entry) => entry.status === 'stale' && entry.reason === 'profile_changed'));

    await assert.rejects(
      persistQualificationRecord(root, original, {
        replace: true,
        profilePath: '../outside.json',
        profile: { schemaVersion: 1, id: 'invalid' },
        workerName: 'worker-c',
      }),
      { code: 'QUALIFICATION_STORE_INVALID' },
    );
    assert.equal((await readQualificationRecord(root, first.path)).sha256, second.sha256);

    const rescored = rescoreQualificationRecord(original, { 'implement-slice': 0.9 });
    const replaced = await replaceQualificationRecord(root, rescored);
    const after = await readQualificationProfileReferences(root);
    assert.equal(after.associations.length, 2);
    assert.ok(after.associations.every((entry) => entry.record.sha256 === replaced.sha256));
    const loaded = await readQualificationRecord(root, replaced.path);
    assert.equal(loaded.record.roles['implement-slice'].target, 0.9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds serialized records before public, replacement, and profile-associated writes', async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'tinysdd-qualification-store-size-'));
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-qualification-store-size-existing-'));
  try {
    const oversized = oversizedRecord();
    await assert.rejects(writeQualificationRecord(emptyRoot, oversized), { code: 'QUALIFICATION_STORE_INVALID' });
    await assert.rejects(readFile(qualificationRecordPath(emptyRoot, oversized.configDigest).absolute));

    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'a.json'), JSON.stringify({ schemaVersion: 1, id: 'profile-a' }));
    const base = record();
    const saved = await persistQualificationRecord(root, base, {
      profilePath: 'profiles/a.json',
      profile: { schemaVersion: 1, id: 'profile-a' },
      workerName: 'worker-a',
    });
    const before = await readFile(join(root, saved.path));

    await assert.rejects(writeQualificationRecord(root, oversized, { replace: true }), { code: 'QUALIFICATION_STORE_INVALID' });
    assert.deepEqual(await readFile(join(root, saved.path)), before);
    assert.equal((await readQualificationProfileReferences(root)).associations.length, 1);

    await assert.rejects(persistQualificationRecord(root, oversized, {
      replace: true,
      profilePath: 'profiles/a.json',
      profile: { schemaVersion: 1, id: 'profile-a' },
      workerName: 'worker-a',
    }), { code: 'QUALIFICATION_STORE_INVALID' });
    assert.deepEqual(await readFile(join(root, saved.path)), before);
    assert.equal((await readQualificationProfileReferences(root)).associations.length, 1);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a pre-existing qualification lock instead of reclaiming it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-qualification-lock-'));
  try {
    await mkdir(join(root, '.tinysdd', 'qualifications'), { recursive: true });
    await writeFile(join(root, '.tinysdd', 'qualifications', '.lock'), JSON.stringify({ schemaVersion: 1, pid: 1, token: 'held' }));
    await assert.rejects(writeQualificationRecord(root, record()), { code: 'QUALIFICATION_STORE_BUSY' });
    assert.equal(JSON.parse(await readFile(join(root, '.tinysdd', 'qualifications', '.lock'), 'utf8')).token, 'held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports identity applicability separately from qualification status', () => {
  const saved = record();
  assert.deepEqual(compareQualificationApplicability(saved), { status: 'not_checked', reason: 'current_identity_unavailable' });
  assert.deepEqual(compareQualificationApplicability(saved, { identity: saved.configIdentity, configDigest: saved.configDigest }), { status: 'applicable', reason: null });
  const changed = structuredClone(saved.configIdentity);
  changed.model.id = 'other-model';
  assert.deepEqual(compareQualificationApplicability(saved, { identity: changed }), { status: 'stale', reason: 'config_identity_mismatch' });
});
