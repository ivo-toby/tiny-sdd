import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath } from 'node:fs/promises';

import {
  FEATURE_INTEGRATION_MAX_TREE_BYTES,
  FEATURE_INTEGRATION_TEST_ENV,
  copyIntegrationTree,
  featureIntegrationFreshness,
  runFeatureIntegration,
} from '../src/feature-integration.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const previousTestEnv = process.env[FEATURE_INTEGRATION_TEST_ENV];

test.beforeEach(() => {
  process.env[FEATURE_INTEGRATION_TEST_ENV] = '1';
});

test.after(() => {
  if (previousTestEnv === undefined) delete process.env[FEATURE_INTEGRATION_TEST_ENV];
  else process.env[FEATURE_INTEGRATION_TEST_ENV] = previousTestEnv;
});

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-feature-integration-'));
  await mkdir(join(root, '.tinysdd'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({ schemaVersion: 1, workers: {} }));
  await writeFile(join(root, 'tests', 'integration.mjs'), 'export const integration = true;\n');
  await writeFile(join(root, 'src', 'entry.mjs'), 'export const entry = true;\n');
  await writeFile(join(root, '.env'), 'should never be copied\n');
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

function args(root, runner) {
  return {
    feature: 'broker',
    membership: [{ id: 'one', retired: false }],
    activeAcceptanceDigests: { one: 'a'.repeat(64) },
    config: {
      argv: ['node', 'tests/integration.mjs'],
      testPaths: ['tests/integration.mjs'],
      entrypoints: ['src/entry.mjs'],
    },
    protectedPaths: ['tests/integration.mjs'],
    runner,
  };
}

function passingRunner() {
  return async ({ candidateDir }) => {
    assert.equal(await readFile(join(candidateDir, 'tests', 'integration.mjs'), 'utf8'), 'export const integration = true;\n');
    await assert.rejects(readFile(join(candidateDir, '.env'), 'utf8'), { code: 'ENOENT' });
    return { exitCode: 0, signal: null, timedOut: false, durationMs: 3 };
  };
}

test('executes a typed integration command on retained bytes and verifies its proof', async () => {
  const root = await project();
  try {
    const result = await runFeatureIntegration(root, args(root, passingRunner()));
    assert.equal(result.reference.status, 'passed');
    const freshness = await featureIntegrationFreshness(root, {
      feature: 'broker',
      eventIntegration: result.reference,
      membership: [{ id: 'one', retired: false }],
      activeAcceptanceDigests: { one: 'a'.repeat(64) },
      config: args(root, passingRunner()).config,
      protectedPaths: ['tests/integration.mjs'],
    });
    assert.deepEqual(freshness, { required: true, fresh: true, reasons: [], status: 'fresh' });
  } finally {
    await cleanup(root);
  }
});

test('fails closed for an unprotected test declaration and failed or timed out checks', async () => {
  const root = await project();
  try {
    await assert.rejects(runFeatureIntegration(root, { ...args(root, passingRunner()), protectedPaths: [] }), { code: 'FEATURE_INTEGRATION_PROOF_REQUIRED' });
    const failed = await runFeatureIntegration(root, {
      ...args(root, async () => ({ exitCode: 1, signal: null, timedOut: false, durationMs: 1 })),
      protectedPaths: ['tests/integration.mjs'],
    }).catch((error) => error);
    assert.equal(failed.code, 'FEATURE_INTEGRATION_FAILED');
    const timedOut = await runFeatureIntegration(root, {
      ...args(root, async () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true, durationMs: 1000 })),
      protectedPaths: ['tests/integration.mjs'],
    }).catch((error) => error);
    assert.equal(timedOut.code, 'FEATURE_INTEGRATION_TIMEOUT');
  } finally {
    await cleanup(root);
  }
});

test('refuses source or retained candidate drift before publishing proof', async () => {
  const root = await project();
  try {
    const sourceDrift = await runFeatureIntegration(root, args(root, async () => {
      await writeFile(join(root, 'src', 'entry.mjs'), 'changed while running\n');
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    })).catch((error) => error);
    assert.equal(sourceDrift.code, 'FEATURE_INTEGRATION_STALE');

    await writeFile(join(root, 'src', 'entry.mjs'), 'export const entry = true;\n');
    const candidateDrift = await runFeatureIntegration(root, args(root, async ({ candidateDir }) => {
      await writeFile(join(candidateDir, 'src', 'entry.mjs'), 'changed retained candidate\n');
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    })).catch((error) => error);
    assert.equal(candidateDrift.code, 'FEATURE_INTEGRATION_STALE');
  } finally {
    await cleanup(root);
  }
});

test('retains dependency mounts and marks dependency drift stale', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'deps'), { recursive: true });
    await writeFile(join(root, 'deps', 'runtime.mjs'), 'export const runtime = true;\n');
    const config = {
      argv: ['node', 'tests/integration.mjs'],
      dependencyMounts: ['deps'],
      testPaths: ['tests/integration.mjs'],
      entrypoints: ['src/entry.mjs'],
    };
    const result = await runFeatureIntegration(root, {
      ...args(root, async ({ dependencyMounts }) => {
        assert.equal(dependencyMounts.length, 1);
        assert.equal(await readFile(join(dependencyMounts[0].source, 'runtime.mjs'), 'utf8'), 'export const runtime = true;\n');
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      }),
      config,
    });
    const fresh = await featureIntegrationFreshness(root, {
      feature: 'broker', eventIntegration: result.reference,
      membership: [{ id: 'one', retired: false }], activeAcceptanceDigests: { one: 'a'.repeat(64) },
      config, protectedPaths: ['tests/integration.mjs'],
    });
    assert.equal(fresh.fresh, true);
    await writeFile(join(root, 'deps', 'runtime.mjs'), 'changed dependency\n');
    const stale = await featureIntegrationFreshness(root, {
      feature: 'broker', eventIntegration: result.reference,
      membership: [{ id: 'one', retired: false }], activeAcceptanceDigests: { one: 'a'.repeat(64) },
      config, protectedPaths: ['tests/integration.mjs'],
    });
    assert.equal(stale.fresh, false);
    assert.ok(stale.reasons.some((reason) => /dependency/u.test(reason)));
  } finally {
    await cleanup(root);
  }
});

test('rejects a growing input before retained writes exceed the tree budget', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-feature-integration-limit-'));
  const destination = join(root, 'retained');
  const source = join(root, 'source');
  const sourceFile = join(source, 'growing.mjs');
  const destinationFile = join(destination, 'growing.mjs');
  const originalOpen = fs.promises.open;
  let reads = 0;
  let consumed = 0;
  let written = 0;
  const chunkBytes = 64 * 1024;
  const chunks = FEATURE_INTEGRATION_MAX_TREE_BYTES / chunkBytes + 1;
  try {
    await mkdir(source, { recursive: true });
    await writeFile(sourceFile, 'x');
    await truncate(sourceFile, FEATURE_INTEGRATION_MAX_TREE_BYTES);
    fs.promises.open = async function patchedOpen(path, ...args) {
      const handle = await originalOpen(path, ...args);
      if (String(path) === sourceFile) {
        handle.read = async (buffer) => {
          if (reads++ >= chunks) return { bytesRead: 0, buffer };
          buffer.fill(120);
          consumed += buffer.length;
          return { bytesRead: buffer.length, buffer };
        };
      } else if (String(path) === destinationFile) {
        handle.write = async (buffer) => {
          written += buffer.length;
          return { bytesWritten: buffer.length, buffer };
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const error = await copyIntegrationTree(source, destination).catch((caught) => caught);
    assert.equal(error.code, 'FEATURE_INTEGRATION_INPUT_CHANGED');
    assert.equal(consumed, FEATURE_INTEGRATION_MAX_TREE_BYTES + chunkBytes);
    assert.equal(written, FEATURE_INTEGRATION_MAX_TREE_BYTES);
    assert.equal(reads, chunks);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await cleanup(root);
  }
});

test('normal callers cannot inject a passing runner', async () => {
  const root = await project();
  const old = process.env[FEATURE_INTEGRATION_TEST_ENV];
  delete process.env[FEATURE_INTEGRATION_TEST_ENV];
  try {
    await assert.rejects(runFeatureIntegration(root, args(root, passingRunner())), { code: 'FEATURE_INTEGRATION_RUNNER_INVALID' });
  } finally {
    if (old === undefined) process.env[FEATURE_INTEGRATION_TEST_ENV] = '1';
    else process.env[FEATURE_INTEGRATION_TEST_ENV] = old;
    await cleanup(root);
  }
});
