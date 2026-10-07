import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildReleasePlan,
  bumpVersion,
  classifyCommit,
  highestBump,
  readReleasePlan,
} from '../scripts/release-plan.mjs';
import { cleanNpmEnvironment, verifyPackage } from '../scripts/verify-package.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function git(root, ...args) {
  return execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

async function repository({ version = '1.0.0', tag = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-plan-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'tinysdd', version }, null, 2)}\n`);
  await writeFile(join(root, 'src', 'marker.txt'), 'initial\n');
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'tests@example.test');
  await git(root, 'config', 'user.name', 'TinySDD tests');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'chore: initial repository');
  if (tag) {
    await git(root, 'tag', '-a', `v${version}`, '-m', `initial ${version}`);
  }
  return root;
}

async function commit(root, message, path = 'src/marker.txt', text = `${message}\n`) {
  await writeFile(join(root, path), text);
  await git(root, 'add', path);
  await git(root, 'commit', '--quiet', '-m', message);
}

test('Conventional Commit policy is case-insensitive for types and scopes and ranks breaking changes highest', () => {
  assert.equal(classifyCommit('FEAT(API)!: add a route').bump, 'major');
  assert.equal(classifyCommit('Fix(Storage): close a race').bump, 'patch');
  assert.equal(classifyCommit('ChOrE(release): v1.2.3').generatedRelease, true);
  assert.equal(classifyCommit('chore: routine maintenance').bump, 'patch');
  assert.equal(classifyCommit('docs: update the guide').bump, 'none');
  assert.equal(classifyCommit('fix: repair behavior\n\nBREAKING CHANGE: callers must adapt').bump, 'major');
  assert.equal(classifyCommit('fix: repair behavior\n\nBREAKING-CHANGE: callers must adapt').bump, 'major');
  assert.equal(highestBump([
    { message: 'fix: patch' },
    { message: 'feat: feature' },
    { message: 'test: coverage' },
  ]), 'minor');
  assert.equal(highestBump([{ message: 'chore(release): v1.2.3' }]), 'none');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
});

test('planner includes a feature commit from a nonconventional merge branch', async () => {
  const root = await repository({ tag: true });
  try {
    await git(root, 'switch', '--quiet', '-c', 'feature-branch');
    await commit(root, 'feat(branch): add merged behavior', 'src/branch.txt');
    const branchCommit = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
    await git(root, 'switch', '--quiet', 'main');
    await commit(root, 'fix(main): repair adjacent behavior');
    await git(root, 'merge', '--quiet', '--no-ff', 'feature-branch', '-m', 'Merge feature branch');
    const plan = await readReleasePlan(root);
    assert.equal(plan.release, true);
    assert.equal(plan.bump, 'minor');
    assert.equal(plan.version, '1.1.0');
    assert.equal(plan.baseTag, 'v1.0.0');
    assert.ok(plan.commits.some((entry) => entry.hash === branchCommit));
    assert.ok(plan.commits.some((entry) => entry.subject === 'Merge feature branch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planner reports no release for documentation-only commits after a tag', async () => {
  const root = await repository({ tag: true });
  try {
    await commit(root, 'docs: clarify release instructions', 'README.md', '# docs\n');
    const plan = await readReleasePlan(root);
    assert.equal(plan.release, false);
    assert.equal(plan.kind, 'none');
    assert.equal(plan.version, '1.0.0');
    assert.equal(plan.bump, 'none');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('first no-tag plan bootstraps the current reviewed package version', async () => {
  const root = await repository({ version: '0.1.0' });
  try {
    await commit(root, 'feat: historical feature');
    const plan = await readReleasePlan(root);
    assert.equal(plan.kind, 'bootstrap');
    assert.equal(plan.version, '0.1.0');
    assert.equal(plan.bump, 'none');
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'tinysdd', version: '0.2.0' }, null, 2)}\n`);
    const reviewedVersionPlan = await readReleasePlan(root);
    assert.equal(reviewedVersionPlan.kind, 'bootstrap');
    assert.equal(reviewedVersionPlan.version, '0.2.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planner rejects tag/package metadata conflicts and duplicate versions', () => {
  assert.throws(() => buildReleasePlan({
    packageName: 'tinysdd',
    packageVersion: '1.0.0',
    head: 'head',
    tags: [{ name: 'v1.0.0', packageVersion: '0.9.0' }],
  }), { code: 'RELEASE_TAG_PACKAGE_MISMATCH' });
  assert.throws(() => buildReleasePlan({
    packageName: 'tinysdd',
    packageVersion: '1.0.0',
    head: 'head',
    tags: [
      { name: 'v1.0.0', packageVersion: '1.0.0' },
      { name: 'v1.0.0', packageVersion: '1.0.0' },
    ],
  }), { code: 'RELEASE_TAG_CONFLICT' });
  assert.throws(() => buildReleasePlan({
    packageName: 'tinysdd',
    packageVersion: '1.0.0',
    head: 'head',
    tags: [{ name: 'v1.0', packageVersion: '1.0' }],
  }), { code: 'RELEASE_TAG_INVALID' });
});

test('dry-run JSON CLI emits the plan without changing the checkout', async () => {
  const root = await repository({ tag: true });
  try {
    await commit(root, 'feat: add a release candidate');
    const before = await readFile(join(root, 'package.json'), 'utf8');
    const script = join(repoRoot, 'scripts', 'release-plan.mjs');
    const result = await execFile(process.execPath, [script, '--root', root, '--dry-run', '--json']);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.release, true);
    assert.equal(plan.version, '1.1.0');
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
    assert.equal((await git(root, 'status', '--porcelain')).stdout, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package smoke strips inherited npm credentials and verifies an offline packed install', async () => {
  const clean = cleanNpmEnvironment({ NODE_AUTH_TOKEN: 'secret', NPM_TOKEN: 'secret', NPM_CONFIG_USERCONFIG: '/secret', SAFE_VALUE: 'kept' }, '/tmp/tinysdd-test-npm');
  assert.equal(clean.NODE_AUTH_TOKEN, undefined);
  assert.equal(clean.NPM_TOKEN, undefined);
  assert.equal(clean.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(clean.SAFE_VALUE, undefined);

  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const result = await verifyPackage({
    projectRoot: repoRoot,
    version: packageJson.version,
    sourceEnv: { ...process.env, NODE_AUTH_TOKEN: 'secret', NPM_TOKEN: 'secret' },
  });
  assert.equal(result.version, packageJson.version);
  assert.equal(result.resources, 14);
  assert.equal(result.initialized, true);
});
