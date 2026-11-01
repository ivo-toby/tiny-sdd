import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath } from 'node:fs/promises';

import {
  FEATURE_INTEGRATION_MAX_TREE_BYTES,
  FEATURE_INTEGRATION_TEST_ENV,
  copyIntegrationTree,
  featureIntegrationConfigFor,
  featureIntegrationFreshness,
  runFeatureIntegration,
  validateFeatureIntegrationConfig,
} from '../src/feature-integration.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, ...gitArgs) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  await execFileAsync('git', gitArgs, { cwd, env });
}

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

function freshnessArgs(reference, config) {
  return {
    feature: 'broker',
    eventIntegration: reference,
    membership: [{ id: 'one', retired: false }],
    activeAcceptanceDigests: { one: 'a'.repeat(64) },
    config,
    protectedPaths: ['tests/integration.mjs'],
  };
}

// The postgram shape from #206: a tracked AGENTS.md -> CLAUDE.md and ignored
// git worktrees that contain their own symlinks.
async function gitProject() {
  const root = await project();
  await writeFile(join(root, 'CLAUDE.md'), 'shared instructions\n');
  await symlink('CLAUDE.md', join(root, 'AGENTS.md'));
  await writeFile(join(root, '.gitignore'), '.env\n.claude/worktrees/\n');
  const worktree = join(root, '.claude', 'worktrees', 'gracious');
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, 'CLAUDE.md'), 'other worktree\n');
  await symlink('CLAUDE.md', join(worktree, 'AGENTS.md'));
  await symlink('/etc/passwd', join(worktree, 'outside'));
  await git(root, 'init', '-q');
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  await writeFile(join(root, 'src', 'untracked.mjs'), 'export const untracked = true;\n');
  return root;
}

test('projects git-listed files, skips ignored worktrees and keeps an in-project symlink', async () => {
  const root = await gitProject();
  try {
    const result = await runFeatureIntegration(root, args(root, async ({ candidateDir }) => {
      assert.ok((await lstat(join(candidateDir, 'AGENTS.md'))).isSymbolicLink());
      assert.equal(await readlink(join(candidateDir, 'AGENTS.md')), 'CLAUDE.md');
      assert.equal(await readFile(join(candidateDir, 'AGENTS.md'), 'utf8'), 'shared instructions\n');
      assert.equal(await readFile(join(candidateDir, 'src', 'untracked.mjs'), 'utf8'), 'export const untracked = true;\n');
      await assert.rejects(lstat(join(candidateDir, '.claude')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(candidateDir, '.env')), { code: 'ENOENT' });
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    }));
    assert.equal(result.proof.candidate.selection, 'git-ls-files');
    assert.ok(result.proof.candidate.identity.entries.some((entry) => entry.path === 'AGENTS.md' && entry.kind === 'symlink' && entry.target === 'CLAUDE.md'));
    const config = args(root).config;
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, config))).fresh, true);
    // Ignored state may change freely; a retargeted tracked link is a source change.
    await writeFile(join(root, '.claude', 'worktrees', 'gracious', 'CLAUDE.md'), 'changed elsewhere\n');
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, config))).fresh, true);
    await rm(join(root, 'AGENTS.md'));
    await symlink('src/entry.mjs', join(root, 'AGENTS.md'));
    const stale = await featureIntegrationFreshness(root, freshnessArgs(result.reference, config));
    assert.equal(stale.fresh, false);
    assert.ok(stale.reasons.includes('project or tested bytes changed'));
  } finally {
    await cleanup(root);
  }
});

test('refuses a symlink that leaves the project or climbs after a name', async () => {
  for (const target of ['/etc/passwd', '../outside', 'src/../../outside', 'src/../CLAUDE.md']) {
    const root = await project();
    try {
      await writeFile(join(root, 'CLAUDE.md'), 'shared\n');
      await symlink(target, join(root, 'link'));
      const error = await runFeatureIntegration(root, args(root, passingRunner())).catch((caught) => caught);
      assert.equal(error.code, 'FEATURE_INTEGRATION_UNSAFE_INPUT', target);
    } finally {
      await cleanup(root);
    }
  }
});

test('walks a project without git and keeps nested in-project symlinks', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink('../src/entry.mjs', join(root, 'docs', 'entry.mjs'));
    const result = await runFeatureIntegration(root, args(root, async ({ candidateDir }) => {
      assert.equal(await readFile(join(candidateDir, 'docs', 'entry.mjs'), 'utf8'), 'export const entry = true;\n');
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    }));
    assert.equal(result.proof.candidate.selection, 'walk');
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, args(root).config))).fresh, true);
  } finally {
    await cleanup(root);
  }
});

test('retains node_modules workspace and .bin links that stay inside the project', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'packages', 'core'), { recursive: true });
    await writeFile(join(root, 'packages', 'core', 'index.mjs'), 'export const core = true;\n');
    await mkdir(join(root, 'node_modules', '@scope'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'tool'), { recursive: true });
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'tool', 'cli.mjs'), 'export {};\n');
    await symlink('../../packages/core', join(root, 'node_modules', '@scope', 'core'));
    await symlink('../tool/cli.mjs', join(root, 'node_modules', '.bin', 'tool'));
    const config = { ...args(root).config, dependencyMounts: ['node_modules'] };
    const result = await runFeatureIntegration(root, {
      ...args(root, async ({ dependencyMounts }) => {
        assert.equal(await readlink(join(dependencyMounts[0].source, '@scope', 'core')), '../../packages/core');
        assert.equal(await readlink(join(dependencyMounts[0].source, '.bin', 'tool')), '../tool/cli.mjs');
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      }),
      config,
    });
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, config))).fresh, true);
    await symlink('../../../outside', join(root, 'node_modules', '@scope', 'escape'));
    const error = await runFeatureIntegration(root, { ...args(root, passingRunner()), config }).catch((caught) => caught);
    assert.equal(error.code, 'FEATURE_INTEGRATION_UNSAFE_INPUT');
  } finally {
    await cleanup(root);
  }
});

test('a proof written before the git selection keeps its walk projection and stays fresh', async () => {
  const root = await project();
  try {
    const result = await runFeatureIntegration(root, args(root, passingRunner()));
    const proofPath = join(root, ...result.reference.proofPath.split('/'));
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    delete proof.candidate.selection;
    const text = `${JSON.stringify(proof, null, 2)}\n`;
    await writeFile(proofPath, text);
    const legacyReference = { ...result.reference, proofSha256: sha256(text) };
    // A later git init that ignores tested source (outside the projected
    // tree) must not change how the old proof is compared.
    await git(root, 'init', '-q');
    await writeFile(join(root, '.git', 'info', 'exclude'), 'src/\n');
    assert.deepEqual(await featureIntegrationFreshness(root, freshnessArgs(legacyReference, args(root).config)), { required: true, fresh: true, reasons: [], status: 'fresh' });
  } finally {
    await cleanup(root);
  }
});

test('per-feature integration configuration selects each feature its own command', () => {
  const config = validateFeatureIntegrationConfig({
    argv: ['node', 'tests/default.mjs'],
    testPaths: ['tests/default.mjs'],
    features: {
      'report-core': { argv: ['node', 'tests/report.mjs'], testPaths: ['tests/report.mjs'], entrypoints: ['src/report.mjs'] },
    },
  });
  assert.deepEqual(featureIntegrationConfigFor(config, 'report-core').argv, ['node', 'tests/report.mjs']);
  assert.deepEqual(featureIntegrationConfigFor(config, 'other').argv, ['node', 'tests/default.mjs']);
  assert.equal(featureIntegrationConfigFor(config, 'other').features, undefined);
  const featuresOnly = validateFeatureIntegrationConfig({ features: { 'report-core': { argv: ['node', 'tests/report.mjs'] } } });
  assert.equal(featureIntegrationConfigFor(featuresOnly, 'other'), undefined);
  assert.equal(featureIntegrationConfigFor(undefined, 'other'), undefined);
  assert.throws(() => validateFeatureIntegrationConfig({ features: {} }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateFeatureIntegrationConfig({ features: { Bad: { argv: ['node', 'x.mjs'] } } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateFeatureIntegrationConfig({ features: { a: { argv: ['node', 'x.mjs'], features: {} } } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateFeatureIntegrationConfig({ testPaths: ['tests/x.mjs'], features: { a: { argv: ['node', 'x.mjs'] } } }), { code: 'CONFIG_INVALID' });
});

test('dependency mounts keep package files with secret-like names; project source does not', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'node_modules', 'dockerode', 'lib'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dockerode', 'lib', 'secret.js'), 'module.exports = {};\n');
    await writeFile(join(root, 'src', 'secret.mjs'), 'export const key = 1;\n');
    const config = { ...args(root).config, dependencyMounts: ['node_modules'] };
    const result = await runFeatureIntegration(root, {
      ...args(root, async ({ candidateDir, dependencyMounts }) => {
        assert.equal(await readFile(join(dependencyMounts[0].source, 'dockerode', 'lib', 'secret.js'), 'utf8'), 'module.exports = {};\n');
        await assert.rejects(lstat(join(candidateDir, 'src', 'secret.mjs')), { code: 'ENOENT' });
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      }),
      config,
    });
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, config))).fresh, true);
  } finally {
    await cleanup(root);
  }
});

test('dependency mounts are retained under their own name so real-path module resolution finds siblings', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.mjs'), 'export {};\n');
    const config = { ...args(root).config, dependencyMounts: ['node_modules'] };
    let source;
    const result = await runFeatureIntegration(root, {
      ...args(root, async ({ dependencyMounts }) => {
        source = dependencyMounts[0].source;
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      }),
      config,
    });
    assert.match(source, /\/dependencies\/mount-00\/node_modules$/u);
    assert.equal(await readFile(join(source, 'pkg', 'index.mjs'), 'utf8'), 'export {};\n');
    assert.match(result.proof.dependencies[0].path, /\/dependencies\/mount-00$/u);
    assert.equal(result.proof.dependencies[0].layout, 'target');
    assert.equal((await featureIntegrationFreshness(root, freshnessArgs(result.reference, config))).fresh, true);
  } finally {
    await cleanup(root);
  }
});

test('a proof retained with the earlier mount-NN layout stays fresh', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'deps'), { recursive: true });
    await writeFile(join(root, 'deps', 'runtime.mjs'), 'export const runtime = true;\n');
    const config = { ...args(root).config, dependencyMounts: ['deps'] };
    const result = await runFeatureIntegration(root, { ...args(root, passingRunner()), config });
    // Rebuild the artifact as an earlier version wrote it: the tree directly
    // at mount-00 and no layout in the proof.
    const artifact = join(root, ...result.reference.proofPath.split('/').slice(0, -1));
    const mount = join(artifact, 'dependencies', 'mount-00');
    await fs.promises.rename(join(mount, 'deps'), join(artifact, 'legacy-mount'));
    await rm(mount, { recursive: true });
    await fs.promises.rename(join(artifact, 'legacy-mount'), mount);
    const proofPath = join(artifact, 'proof.json');
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    delete proof.dependencies[0].layout;
    const text = `${JSON.stringify(proof, null, 2)}\n`;
    await writeFile(proofPath, text);
    const legacy = { ...result.reference, proofSha256: sha256(text) };
    assert.deepEqual(await featureIntegrationFreshness(root, freshnessArgs(legacy, config)), { required: true, fresh: true, reasons: [], status: 'fresh' });
  } finally {
    await cleanup(root);
  }
});

test('an argv path into node_modules without a dependency mount says what to declare', async () => {
  const root = await project();
  try {
    let ran = false;
    const error = await runFeatureIntegration(root, {
      ...args(root, async () => { ran = true; return { exitCode: 0, signal: null, timedOut: false, durationMs: 1 }; }),
      config: { ...args(root).config, argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/integration.mjs'] },
    }).catch((caught) => caught);
    assert.equal(error.code, 'FEATURE_INTEGRATION_CONFIG');
    assert.match(error.message, /argv\[1\] names node_modules\/vitest\/vitest\.mjs.*"dependencyMounts": \["node_modules"\]/u);
    assert.equal(ran, false);
  } finally {
    await cleanup(root);
  }
});
