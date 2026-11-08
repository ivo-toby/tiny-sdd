import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acceptFeature,
  addTask,
  approveTask,
  initProject,
  reportFeature,
  reviewTask,
} from '../src/controller.mjs';
import { FEATURE_INTEGRATION_TEST_ENV } from '../src/feature-integration.mjs';
import {
  LIVING_SPEC_SCHEMA_VERSION,
  archiveChange,
  mergeSpecText,
  parseArchiveManifest,
  parseMergeDraft,
} from '../src/living-spec.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const examplesRoot = fileURLToPath(new URL('../examples/artifact-format', import.meta.url));
const previousIntegrationTestEnv = process.env[FEATURE_INTEGRATION_TEST_ENV];
const previousLivingSpecTestEnv = process.env.TINYSDD_LIVING_SPEC_TEST;
process.env[FEATURE_INTEGRATION_TEST_ENV] = '1';
process.env.TINYSDD_LIVING_SPEC_TEST = '1';

test.after(() => {
  if (previousIntegrationTestEnv === undefined) delete process.env[FEATURE_INTEGRATION_TEST_ENV];
  else process.env[FEATURE_INTEGRATION_TEST_ENV] = previousIntegrationTestEnv;
  if (previousLivingSpecTestEnv === undefined) delete process.env.TINYSDD_LIVING_SPEC_TEST;
  else process.env.TINYSDD_LIVING_SPEC_TEST = previousLivingSpecTestEnv;
});

function draftFor(base, output, change) {
  return {
    schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
    changeId: 'demo',
    specs: [{
      spec: 'specs/demo.md',
      baseSha256: sha256(base),
      outputSha256: sha256(output),
      changes: [change],
    }],
  };
}

const requirementIds = {
  S1: 'broker-s1-errors',
  S2: 'broker-s2-paths',
  S3: 'broker-s3-backend',
  S4: 'broker-s4-allowlist',
  S5a: 'broker-s5a-core',
  S5b: 'broker-s5b-async',
};

async function archiveFixture({ extraSpec = false, accept = true } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-living-spec-'));
  await cp(examplesRoot, join(root, 'examples/artifact-format'), { recursive: true });
  const changePath = 'examples/artifact-format/changes/broker-recut/change.json';
  const specPath = 'examples/artifact-format/specs/broker.md';
  const base = await readFile(join(root, specPath), 'utf8');
  const changes = [];
  const outputLines = [];
  let offset = 0;
  for (const line of base.split(/(?<=\n)/u)) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    const key = text.slice(0, text.indexOf(' '));
    if (requirementIds[key]) {
      const outputText = `${text} revised`;
      changes.push({
        id: requirementIds[key],
        operation: 'modify',
        baseStart: offset,
        baseEnd: offset + Buffer.byteLength(text),
        baseText: text,
        outputText,
      });
      outputLines.push(outputText);
    } else {
      outputLines.push(text);
    }
    offset += Buffer.byteLength(line);
  }
  const output = outputLines.map((line) => `${line}\n`).join('');
  const changeDocument = JSON.parse(await readFile(join(root, changePath), 'utf8'));
  const draft = {
    schemaVersion: 1,
    changeId: changeDocument.id,
    specs: [{ spec: specPath, baseSha256: sha256(base), outputSha256: sha256(output), changes }],
  };
  if (extraSpec) {
    const extraPath = 'examples/artifact-format/specs/extra.md';
    const extraDeltaPath = 'examples/artifact-format/changes/broker-recut/deltas/extra.json';
    const extraDelta = {
      schemaVersion: 1,
      spec: extraPath,
      baseSha256: null,
      changes: [{ operation: 'add', id: 'broker-extra', text: 'Extra archived rule.\n' }],
    };
    await writeFile(join(root, extraDeltaPath), `${JSON.stringify(extraDelta, null, 2)}\n`);
    changeDocument.specDeltas.push(extraDeltaPath);
    await writeFile(join(root, changePath), `${JSON.stringify(changeDocument, null, 2)}\n`);
    draft.specs.push({ spec: extraPath, baseSha256: null, outputSha256: sha256('Extra archived rule.\n'), changes: [{ id: 'broker-extra', operation: 'add', baseStart: 0, baseEnd: 0, baseText: '', outputText: 'Extra archived rule.\n' }] });
  }
  const draftPath = 'examples/artifact-format/changes/broker-recut/merge-draft.json';
  await writeFile(join(root, draftPath), `${JSON.stringify(draft, null, 2)}\n`);
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/brief.md'), '# Test brief\n');
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'tests/feature-integration.mjs'), 'export const integration = true;\n');
  await mkdir(join(root, '.tinysdd/reviews'), { recursive: true });
  await writeFile(join(root, '.tinysdd/reviews/evidence.md'), 'operator evidence\n');
  await initProject(root);
  await writeFile(join(root, '.tinysdd/config.json'), JSON.stringify({
    schemaVersion: 1,
    workers: {},
    featureIntegration: {
      argv: ['node', 'tests/feature-integration.mjs'],
      testPaths: ['tests/feature-integration.mjs'],
      entrypoints: ['examples/artifact-format/src/entrypoint.mjs'],
    },
  }));
  const { validateChange } = await import('../src/change-format.mjs');
  const validation = await validateChange(root, changePath);
  for (const registration of validation.registrationPlan) {
    await addTask(root, {
      id: registration.id,
      feature: changeDocument.id,
      brief: 'docs/brief.md',
      allow: [`examples/artifact-format/src/${registration.id}.mjs`],
      preparation: registration.preparation,
    });
    await approveTask(root, { id: registration.id, by: 'operator', reason: 'approved scope' });
    await reviewTask(root, { id: registration.id, verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
  }
  if (accept) {
    await acceptFeature(root, {
      feature: changeDocument.id,
      by: 'operator',
      reason: 'feature complete',
      integrationRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 }),
    });
  }
  return { root, changePath, draftPath, specPath, base, output, changeDocument };
}

async function cleanupFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test('merge applies explicit byte ranges and preserves untouched prose', () => {
  const base = '# Demo\n\nS1 old behavior.\nUnrelated wording stays byte-for-byte.\n';
  const output = '# Demo\n\nS1 new behavior.\nUnrelated wording stays byte-for-byte.\n';
  const oldText = 'S1 old behavior.';
  const newText = 'S1 new behavior.';
  const change = {
    id: 'demo-s1',
    operation: 'modify',
    baseStart: Buffer.byteLength('# Demo\n\n'),
    baseEnd: Buffer.byteLength('# Demo\n\nS1 old behavior.'),
    baseText: oldText,
    outputText: newText,
  };
  const draft = draftFor(base, output, change);
  assert.deepEqual(parseMergeDraft(JSON.stringify(draft)).specs[0].changes[0], change);
  assert.deepEqual(mergeSpecText(base, [{ ...change, text: newText }], draft.specs[0]), {
    text: output,
    bytes: Buffer.byteLength(output),
    sha256: sha256(output),
    baseSha256: sha256(base),
  });
});

test('merge rejects stale text, overlapping ranges, and output digest drift', () => {
  const base = 'one\ntwo\n';
  const change = { id: 'demo-one', operation: 'modify', baseStart: 0, baseEnd: 3, baseText: 'one', outputText: 'ONE' };
  const draft = draftFor(base, 'ONE\ntwo\n', change);
  assert.throws(() => mergeSpecText('changed\ntwo\n', [{ ...change, text: 'ONE' }], draft.specs[0]), { code: 'SPEC_MERGE_CONFLICT' });
  assert.throws(() => mergeSpecText(base, [{ ...change, text: 'ONE' }, { id: 'demo-two', operation: 'modify', text: 'TWO' }], {
    ...draft.specs[0],
    changes: [change, { id: 'demo-two', operation: 'modify', baseStart: 2, baseEnd: 7, baseText: 'e\ntwo', outputText: 'TWO' }],
  }), { code: 'SPEC_MERGE_CONFLICT' });
  assert.throws(() => mergeSpecText(base, [{ ...change, text: 'ONE' }], { ...draft.specs[0], outputSha256: sha256('wrong') }), { code: 'SPEC_MERGE_CONFLICT' });
});

test('add and remove mappings are explicit and deterministic', () => {
  const base = 'first\nlast\n';
  const output = 'first\ninserted\n';
  const draft = {
    schemaVersion: 1,
    changeId: 'demo',
    specs: [{
      spec: 'specs/demo.md',
      baseSha256: sha256(base),
      outputSha256: sha256(output),
      changes: [
        { id: 'demo-add', operation: 'add', baseStart: 6, baseEnd: 6, baseText: '', outputText: 'inserted\n' },
        { id: 'demo-remove', operation: 'remove', baseStart: 6, baseEnd: 11, baseText: 'last\n', outputText: '' },
      ],
    }],
  };
  const parsed = parseMergeDraft(JSON.stringify(draft));
  assert.equal(mergeSpecText(base, [
    { operation: 'add', id: 'demo-add', text: 'inserted\n' },
    { operation: 'remove', id: 'demo-remove' },
  ], parsed.specs[0]).text, output);
});

test('draft parser refuses unknown fields and duplicate requirement ids', () => {
  const base = 'one\n';
  const change = { id: 'demo-one', operation: 'modify', baseStart: 0, baseEnd: 3, baseText: 'one', outputText: 'ONE' };
  const draft = draftFor(base, 'ONE\n', change);
  assert.throws(() => parseMergeDraft(JSON.stringify({ ...draft, extra: true })), { code: 'SPEC_MERGE_INVALID' });
  assert.throws(() => parseMergeDraft(JSON.stringify({ ...draft, specs: [{ ...draft.specs[0], changes: [change, change] }] })), { code: 'SPEC_MERGE_INVALID' });
});

test('archive requires explicit fresh feature acceptance before publishing', async () => {
  const fixture = await archiveFixture({ accept: false });
  try {
    await assert.rejects(archiveChange(fixture.root, { changePath: fixture.changePath }), { code: 'FEATURE_ACCEPTANCE_REQUIRED' });
    await assert.rejects(readFile(join(fixture.root, 'changes/archive/broker-recut/manifest.json'), 'utf8'));
    assert.equal(await readFile(join(fixture.root, fixture.specPath), 'utf8'), fixture.base);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('archive retains validated evidence and repeats idempotently', async () => {
  const fixture = await archiveFixture();
  try {
    const first = await archiveChange(fixture.root, { changePath: fixture.changePath });
    assert.equal(first.alreadyArchived, false);
    assert.equal(await readFile(join(fixture.root, fixture.specPath), 'utf8'), fixture.output);
    const manifestValue = JSON.parse(await readFile(join(fixture.root, 'changes/archive/broker-recut/manifest.json'), 'utf8'));
    const manifest = parseArchiveManifest(manifestValue);
    assert.equal(manifest.changeId, 'broker-recut');
    assert.equal(manifest.inputs.change.path, fixture.changePath);
    assert.equal(manifest.inputs.draft.path, fixture.draftPath);
    assert.equal(manifest.validation.sliceFiles.length, 6);
    assert.equal(manifest.acceptance.freshness.integrationFresh, true);
    assert.ok(manifest.files.some((record) => record.archivePath === 'evidence/feature-events.jsonl'));
    const second = await archiveChange(fixture.root, { changePath: fixture.changePath });
    assert.equal(second.alreadyArchived, true);
    assert.ok(second.specs.every((spec) => spec.status === 'already-applied'));
  } finally {
    await cleanupFixture(fixture);
  }
});

test('repeat refuses a different merge draft without changing the applied spec', async () => {
  const fixture = await archiveFixture();
  try {
    await archiveChange(fixture.root, { changePath: fixture.changePath });
    const applied = await readFile(join(fixture.root, fixture.specPath), 'utf8');
    await writeFile(join(fixture.root, fixture.draftPath), `${JSON.stringify({ changed: true })}\n`);
    await assert.rejects(archiveChange(fixture.root, { changePath: fixture.changePath }), { code: 'ARCHIVE_INVALID' });
    assert.equal(await readFile(join(fixture.root, fixture.specPath), 'utf8'), applied);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('conflict on a later spec performs no earlier writes and recovers once resolved', async () => {
  const fixture = await archiveFixture({ extraSpec: true });
  const extraPath = join(fixture.root, 'examples/artifact-format/specs/extra.md');
  const brokerPath = join(fixture.root, fixture.specPath);
  try {
    await archiveChange(fixture.root, { changePath: fixture.changePath });
    // Simulate an interrupted apply: the archive exists, no spec was written, and
    // the second spec was edited by someone else in the meantime.
    await writeFile(brokerPath, fixture.base);
    await writeFile(extraPath, 'concurrent change\n');
    await assert.rejects(archiveChange(fixture.root, { changePath: fixture.changePath }), { code: 'ARCHIVE_RESULT_CONFLICT' });
    assert.equal(await readFile(brokerPath, 'utf8'), fixture.base);
    assert.equal(await readFile(extraPath, 'utf8'), 'concurrent change\n');
    await rm(extraPath, { force: true });
    const recovered = await archiveChange(fixture.root, { changePath: fixture.changePath });
    assert.equal(recovered.alreadyArchived, true);
    assert.equal(await readFile(brokerPath, 'utf8'), fixture.output);
    assert.equal(await readFile(extraPath, 'utf8'), 'Extra archived rule.\n');
  } finally {
    await cleanupFixture(fixture);
  }
});

test('production archive path rejects injected feature reports', async () => {
  const fixture = await archiveFixture();
  const previous = process.env.TINYSDD_LIVING_SPEC_TEST;
  delete process.env.TINYSDD_LIVING_SPEC_TEST;
  try {
    await assert.rejects(archiveChange(fixture.root, {
      changePath: fixture.changePath,
      featureReport: async () => ({ accepted: true }),
    }), { code: 'FEATURE_ACCEPTANCE_REQUIRED' });
  } finally {
    if (previous === undefined) delete process.env.TINYSDD_LIVING_SPEC_TEST;
    else process.env.TINYSDD_LIVING_SPEC_TEST = previous;
    await cleanupFixture(fixture);
  }
});
