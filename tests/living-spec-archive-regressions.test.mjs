import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  withFeatureReport,
} from '../src/controller.mjs';
import { FEATURE_INTEGRATION_TEST_ENV } from '../src/feature-integration.mjs';
import {
  LIVING_SPEC_SCHEMA_VERSION,
  archiveChange,
  parseArchiveManifest,
} from '../src/living-spec.mjs';
import { sha256 } from '../src/fs-utils.mjs';
import { validateChange } from '../src/change-format.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const examplesRoot = fileURLToPath(new URL('../examples/artifact-format', import.meta.url));
const previousLivingSpecTestEnv = process.env.TINYSDD_LIVING_SPEC_TEST;
process.env.TINYSDD_LIVING_SPEC_TEST = '1';
const previousIntegrationTestEnv = process.env[FEATURE_INTEGRATION_TEST_ENV];
process.env[FEATURE_INTEGRATION_TEST_ENV] = '1';

test.after(() => {
  if (previousLivingSpecTestEnv === undefined) delete process.env.TINYSDD_LIVING_SPEC_TEST;
  else process.env.TINYSDD_LIVING_SPEC_TEST = previousLivingSpecTestEnv;
  if (previousIntegrationTestEnv === undefined) delete process.env[FEATURE_INTEGRATION_TEST_ENV];
  else process.env[FEATURE_INTEGRATION_TEST_ENV] = previousIntegrationTestEnv;
});

const requirementIds = {
  S1: 'broker-s1-errors',
  S2: 'broker-s2-paths',
  S3: 'broker-s3-backend',
  S4: 'broker-s4-allowlist',
  S5a: 'broker-s5a-core',
  S5b: 'broker-s5b-async',
};

async function archiveFixture({ extraSpec = false, rootDescriptor = false } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-living-spec-archive-'));
  await cp(examplesRoot, join(root, 'examples/artifact-format'), { recursive: true });
  const sourceChangePath = 'examples/artifact-format/changes/broker-recut/change.json';
  const changePath = rootDescriptor ? 'change.json' : sourceChangePath;
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
  const changeDocument = JSON.parse(await readFile(join(root, sourceChangePath), 'utf8'));
  const draft = {
    schemaVersion: LIVING_SPEC_SCHEMA_VERSION,
    changeId: changeDocument.id,
    specs: [{ spec: specPath, baseSha256: sha256(base), outputSha256: sha256(output), changes }],
  };
  if (extraSpec) {
    const extraPath = 'examples/artifact-format/specs/extra.md';
    const extraDeltaPath = 'examples/artifact-format/changes/broker-recut/deltas/extra.json';
    const extraText = 'Extra archived rule.\n';
    const extraDelta = {
      schemaVersion: 1,
      spec: extraPath,
      baseSha256: null,
      changes: [{ operation: 'add', id: 'broker-extra', text: extraText }],
    };
    await writeFile(join(root, extraDeltaPath), `${JSON.stringify(extraDelta, null, 2)}\n`);
    changeDocument.specDeltas.push(extraDeltaPath);
    await writeFile(join(root, changePath), `${JSON.stringify(changeDocument, null, 2)}\n`);
    draft.specs.push({
      spec: extraPath,
      baseSha256: null,
      outputSha256: sha256(extraText),
      changes: [{ id: 'broker-extra', operation: 'add', baseStart: 0, baseEnd: 0, baseText: '', outputText: extraText }],
    });
  }
  if (rootDescriptor || extraSpec) {
    await writeFile(join(root, changePath), `${JSON.stringify(changeDocument, null, 2)}\n`);
  }
  const draftPath = rootDescriptor ? 'merge-draft.json' : 'examples/artifact-format/changes/broker-recut/merge-draft.json';
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
  await acceptFeature(root, {
    feature: changeDocument.id,
    by: 'operator',
    reason: 'feature complete',
    integrationRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1 }),
  });
  return { root, changePath, specPath, base, output, changeDocument };
}

async function cleanupFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test('archive accepts a new spec whose absent preparation has synthetic archive records', async () => {
  const fixture = await archiveFixture({ extraSpec: true });
  const extraPath = 'examples/artifact-format/specs/extra.md';
  try {
    const result = await archiveChange(fixture.root, { changePath: fixture.changePath });
    assert.equal(result.alreadyArchived, false);
    assert.equal(await readFile(join(fixture.root, extraPath), 'utf8'), 'Extra archived rule.\n');
    const recovered = await archiveChange(fixture.root, { changePath: fixture.changePath });
    assert.equal(recovered.alreadyArchived, true);
    const manifest = parseArchiveManifest(JSON.parse(await readFile(join(fixture.root, 'changes/archive/broker-recut/manifest.json'), 'utf8')));
    assert.deepEqual(manifest.validation.preparationFiles.find((item) => item.path === extraPath), {
      path: extraPath,
      exists: false,
      bytes: null,
      sha256: null,
    });
    assert.ok(manifest.specs.some((item) => item.spec === extraPath));
  } finally {
    await cleanupFixture(fixture);
  }
});

test('archive still rejects an original retained record for an absent preparation', async () => {
  const fixture = await archiveFixture({ extraSpec: true });
  const extraPath = 'examples/artifact-format/specs/extra.md';
  const manifestPath = join(fixture.root, 'changes/archive/broker-recut/manifest.json');
  try {
    await archiveChange(fixture.root, { changePath: fixture.changePath });
    const retainedPath = 'inputs/should-not-be-retained.md';
    const retainedText = 'unexpected retained input\n';
    await mkdir(join(fixture.root, 'changes/archive/broker-recut', 'inputs'), { recursive: true });
    await writeFile(join(fixture.root, 'changes/archive/broker-recut', retainedPath), retainedText);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files.push({
      sourcePath: extraPath,
      archivePath: retainedPath,
      bytes: Buffer.byteLength(retainedText),
      sha256: sha256(retainedText),
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(archiveChange(fixture.root, { changePath: fixture.changePath }), (error) => {
      assert.equal(error.code, 'ARCHIVE_INVALID');
      assert.match(error.message, /archive retained a file marked absent/);
      return true;
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test('archive rejects a root-level change descriptor before staging the project root', async () => {
  const fixture = await archiveFixture({ rootDescriptor: true });
  try {
    const runsPath = join(fixture.root, '.tinysdd/runs');
    const beforeRuns = (await readdir(runsPath)).sort();
    await assert.rejects(archiveChange(fixture.root, { changePath: 'change.json' }), (error) => {
      assert.equal(error.code, 'ARCHIVE_INVALID');
      assert.match(error.message, /change descriptor must be inside a source change directory/);
      return true;
    });
    assert.deepEqual((await readdir(runsPath)).sort(), beforeRuns);
  } finally {
    await cleanupFixture(fixture);
  }
});


test('final feature report excludes controller revisions until its consumer completes', async () => {
  const fixture = await archiveFixture();
  try {
    const before = await readFile(join(fixture.root, '.tinysdd/runs/controller.json'), 'utf8');
    await withFeatureReport(fixture.root, { feature: fixture.changeDocument.id }, async (report) => {
      assert.equal(report.stale, false);
      await assert.rejects(reviewTask(fixture.root, {
        id: 'broker-s5b', verdict: 'revision', by: 'reviewer',
        evidence: '.tinysdd/reviews/evidence.md', reason: 'revision during archive commit',
      }), { code: 'LOCKED' });
      assert.equal(await readFile(join(fixture.root, '.tinysdd/runs/controller.json'), 'utf8'), before);
    });
    await reviewTask(fixture.root, {
      id: 'broker-s5b', verdict: 'revision', by: 'reviewer',
      evidence: '.tinysdd/reviews/evidence.md', reason: 'revision after consumer',
    });
    assert.equal((await reportFeature(fixture.root, { feature: fixture.changeDocument.id })).stale, true);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('archive rechecks real acceptance after a revision invalidates its initial snapshot', async () => {
  const fixture = await archiveFixture();
  try {
    await assert.rejects(archiveChange(fixture.root, {
      changePath: fixture.changePath,
      featureReport: async (root, options) => {
        const report = await reportFeature(root, options);
        await reviewTask(root, {
          id: 'broker-s5b', verdict: 'revision', by: 'reviewer',
          evidence: '.tinysdd/reviews/evidence.md', reason: 'revision after initial snapshot',
        });
        return report;
      },
    }), { code: 'FEATURE_ACCEPTANCE_STALE' });
    assert.equal(await readFile(join(fixture.root, fixture.specPath), 'utf8'), fixture.base);
    await assert.rejects(readFile(join(fixture.root, 'changes/archive/broker-recut/manifest.json')), { code: 'ENOENT' });
    assert.equal((await readdir(join(fixture.root, '.tinysdd/runs'))).some((name) => name.startsWith('archive-pending-')), false);
  } finally {
    await cleanupFixture(fixture);
  }
});
