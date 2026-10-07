import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ReleaseError,
  createArchiveAdapter,
  createGitAdapter,
  createGitHubAdapter,
  prepareReleaseCandidate,
  runRelease,
  validateReleaseCheckout,
} from '../scripts/release.mjs';
import { cleanNpmEnvironment } from '../scripts/verify-package.mjs';

const execFile = promisify(execFileCallback);
const gitAdapter = createGitAdapter();
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

async function git(root, ...args) {
  return execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

async function repo({ remoteAtFeature = true, withTag = true, message = 'feat: add release behavior', content = 'feature\n' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-lifecycle-'));
  const remote = await mkdtemp(join(tmpdir(), 'tinysdd-release-remote-'));
  await rm(remote, { recursive: true, force: true });
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'tests@example.test');
  await git(root, 'config', 'user.name', 'TinySDD tests');
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'tinysdd',
    version: '1.0.0',
    repository: { type: 'git', url: 'https://github.com/ivo-toby/tiny-sdd.git' },
  }, null, 2)}\n`);
  await writeFile(join(root, 'README.md'), 'initial\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'chore: initial repository');
  if (withTag) await git(root, 'tag', '-a', 'v1.0.0', '-m', 'initial release');
  await git(root, 'init', '--bare', '--quiet', '--initial-branch=main', remote);
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', '--set-upstream', 'origin', 'main', '--tags');
  await writeFile(join(root, 'README.md'), content);
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '--quiet', '-m', message);
  if (remoteAtFeature) await git(root, 'push', '--quiet', 'origin', 'main');
  return { root, remote };
}

async function clone(remote) {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-retry-'));
  await rm(root, { recursive: true, force: true });
  await execFile('git', ['clone', '--quiet', remote, root]);
  await git(root, 'config', 'user.email', 'tests@example.test');
  await git(root, 'config', 'user.name', 'TinySDD tests');
  return root;
}

function adapters({ published = false, failArchive = false, failFinalize = false } = {}) {
  const state = { published, publishCount: 0, archiveCount: 0, verifyTaggedCount: 0, downloadRoots: [], releases: new Map(), failFinalize };
  return {
    state,
    registry: {
      async get() {
        return state.published ? { exists: true, integrity: state.integrity } : { exists: false, integrity: null };
      },
      async publish(artifact) {
        state.publishCount += 1;
        state.integrity = `sha512-${createHash('sha512').update(await readFile(artifact)).digest('base64')}`;
        state.published = true;
      },
    },
    github: {
      async getRelease(tag) { return state.releases.get(tag) ?? null; },
      async createDraft({ tag, commit }) {
        const release = { tag_name: tag, target_commitish: commit, draft: true, assets: [] };
        state.releases.set(tag, release);
        return release;
      },
      async uploadAsset({ tag, artifact, name }) {
        const release = state.releases.get(tag);
        release.assets.push({ name: name ?? 'tinysdd.tgz', bytes: await readFile(artifact) });
      },
      async downloadAsset({ tag, name, destination }) {
        const release = state.releases.get(tag);
        const asset = release.assets.find((entry) => entry.name === name);
        const path = join(destination, name);
        state.downloadRoots.push(destination);
        await mkdir(destination, { recursive: true });
        await writeFile(path, asset.bytes);
        return path;
      },
      async publishRelease(tag) {
        if (state.failFinalize) {
          state.failFinalize = false;
          throw new ReleaseError('RELEASE_GITHUB_FAILED', 'finalize failed');
        }
        state.releases.get(tag).draft = false;
      },
    },
    archive: {
      async verify() {
        state.archiveCount += 1;
        if (failArchive) throw new ReleaseError('RELEASE_ARCHIVE_UNAVAILABLE', 'archive is not ready');
      },
    },
  };
}

async function releaseOptions(root, bundle, overrides = {}) {
  return {
    root,
    enabled: true,
    validateCheckout: false,
    git: gitAdapter,
    registry: bundle.registry,
    github: bundle.github,
    archive: bundle.archive,
    runTests: async () => {},
    verify: async () => {},
    verifyTagged: async () => {},
    ...overrides,
  };
}

test('publishes one exact artifact and a later retry does not duplicate npm publication', async () => {
  const fixture = await repo();
  const bundle = adapters();
  try {
    const first = await runRelease(await releaseOptions(fixture.root, bundle));
    assert.equal(first.status, 'published');
    assert.equal(bundle.state.publishCount, 1);
    assert.equal(bundle.state.archiveCount, 1);
    const retryRoot = await clone(fixture.remote);
    try {
      const retry = await runRelease(await releaseOptions(retryRoot, bundle));
      assert.equal(retry.status, 'no-release');
      assert.equal(bundle.state.publishCount, 1);
    } finally {
      await rm(retryRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('a failure after the atomic tag push resumes from the same tag bytes', async () => {
  const fixture = await repo();
  const failed = adapters({ failArchive: true });
  try {
    await assert.rejects(runRelease(await releaseOptions(fixture.root, failed)), { code: 'RELEASE_ARCHIVE_UNAVAILABLE' });
    assert.equal((await git(fixture.root, 'ls-remote', 'origin', 'refs/tags/v1.1.0')).stdout.includes('refs/tags/v1.1.0'), true);
    assert.equal(failed.state.publishCount, 0);
    const retryRoot = await clone(fixture.remote);
    try {
      failed.archive = { async verify() { failed.state.archiveCount += 1; } };
      const retry = await runRelease(await releaseOptions(retryRoot, failed));
      assert.equal(retry.status, 'published');
      assert.equal(retry.version, '1.1.0');
      assert.equal(failed.state.publishCount, 1);
    } finally {
      await rm(retryRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('a draft asset is reused when finalization failed after npm publication', async () => {
  const fixture = await repo();
  const bundle = adapters({ failFinalize: true });
  try {
    await assert.rejects(runRelease(await releaseOptions(fixture.root, bundle)), { code: 'RELEASE_GITHUB_FAILED' });
    assert.equal(bundle.state.publishCount, 1);
    const retryRoot = await clone(fixture.remote);
    try {
      const retry = await runRelease(await releaseOptions(retryRoot, bundle, {
        prepareTagged: async () => { throw new Error('retry must reuse the retained asset'); },
        verifyTagged: async () => { bundle.state.verifyTaggedCount += 1; },
      }));
      assert.equal(retry.status, 'published');
      assert.equal(bundle.state.publishCount, 1);
      assert.equal(bundle.state.verifyTaggedCount, 1);
      await assert.rejects(access(bundle.state.downloadRoots[0]));
    } finally {
      await rm(retryRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('conflicting npm versions and failed verification happen before remote writes', async () => {
  const fixture = await repo();
  const conflict = adapters({ published: true });
  try {
    await assert.rejects(runRelease(await releaseOptions(fixture.root, conflict)), { code: 'RELEASE_VERSION_CONFLICT' });
    assert.equal((await git(fixture.root, 'ls-remote', 'origin', 'refs/tags/v1.1.0')).stdout, '');
    const failed = adapters();
    await assert.rejects(runRelease(await releaseOptions(fixture.root, failed, {
      verify: async () => { throw new ReleaseError('RELEASE_VERIFY_FAILED', 'verification failed'); },
    })), { code: 'RELEASE_VERIFY_FAILED' });
    assert.equal((await git(fixture.root, 'ls-remote', 'origin', 'refs/tags/v1.1.0')).stdout, '');
    assert.equal(failed.state.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('a concurrent main movement rejects the release before the atomic push', async () => {
  const fixture = await repo({ remoteAtFeature: false });
  const bundle = adapters();
  const competitor = await clone(fixture.remote);
  try {
    const prepare = async (options) => {
      const candidate = await prepareReleaseCandidate({ ...options, runTests: async () => {}, verify: async () => {} });
      await writeFile(join(competitor, 'README.md'), 'raced\n');
      await git(competitor, 'add', 'README.md');
      await git(competitor, 'commit', '--quiet', '-m', 'fix: concurrent main movement');
      await git(competitor, 'push', '--quiet', 'origin', 'main');
      return candidate;
    };
    await assert.rejects(runRelease(await releaseOptions(fixture.root, bundle, { prepareCandidate: prepare })), { code: 'RELEASE_RACE' });
    assert.equal((await git(fixture.root, 'ls-remote', 'origin', 'refs/tags/v1.1.0')).stdout, '');
    assert.equal(bundle.state.publishCount, 0);
  } finally {
    await rm(competitor, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('documentation-only main changes leave the lifecycle without a release', async () => {
  const fixture = await repo({ message: 'docs: clarify release instructions', content: 'release docs\n' });
  const bundle = adapters();
  try {
    const result = await runRelease(await releaseOptions(fixture.root, bundle));
    assert.equal(result.status, 'no-release');
    assert.equal(result.plan.kind, 'none');
    assert.equal(bundle.state.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('a checkout with no tags reports bootstrap and does not publish', async () => {
  const fixture = await repo({ withTag: false });
  const bundle = adapters();
  try {
    const result = await runRelease(await releaseOptions(fixture.root, bundle));
    assert.equal(result.status, 'bootstrap');
    assert.equal(result.plan.kind, 'bootstrap');
    assert.equal(bundle.state.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('GitHub adapter reuses a draft found by release listing and patches its numeric id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-gh-'));
  const fakeGh = join(root, 'gh');
  const log = join(root, 'calls.log');
  await writeFile(fakeGh, `#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *"/releases/tags/"*) echo 'not found' >&2; exit 1 ;;
  *"releases?per_page=100&page=1"*) echo '[{"id":42,"tag_name":"v1.1.0","draft":true,"assets":[]}]' ;;
  *"/releases/42"*) echo '{"id":42,"tag_name":"v1.1.0","draft":false,"assets":[]}' ;;
  *) echo '{}' ;;
esac
`);
  await chmod(fakeGh, 0o755);
  try {
    const adapter = createGitHubAdapter({ gh: fakeGh, sourceEnv: { ...process.env, GH_LOG: log } });
    const found = await adapter.getRelease('v1.1.0');
    assert.equal(found.id, 42);
    assert.equal(found.draft, true);
    await adapter.publishRelease('v1.1.0');
    const calls = await readFile(log, 'utf8');
    assert.match(calls, /releases\?per_page=100&page=1/u);
    assert.match(calls, /--method PATCH repos\/ivo-toby\/tiny-sdd\/releases\/42/u);
    assert.doesNotMatch(calls, /--method PATCH repos\/ivo-toby\/tiny-sdd\/releases\/tags\/v1\.1\.0/u);
    assert.doesNotMatch(calls, /--method POST repos\/ivo-toby\/tiny-sdd\/releases/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshed main checkout accepts an older triggering event SHA', async () => {
  const fixture = await repo();
  const actualGit = createGitAdapter();
  const releaseGit = {
    async run(args, cwd, options) {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'git@github.com:ivo-toby/tiny-sdd.git';
      return actualGit.run(args, cwd, options);
    },
  };
  try {
    const oldEventSha = (await git(fixture.root, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim();
    const checkout = await validateReleaseCheckout({
      root: fixture.root,
      git: releaseGit,
      env: {
        GITHUB_REPOSITORY: 'ivo-toby/tiny-sdd',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: oldEventSha,
      },
    });
    assert.equal(checkout.head, (await git(fixture.root, 'rev-parse', 'HEAD^{commit}')).stdout.trim());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.remote, { recursive: true, force: true });
  }
});

test('isolated verification git environment ignores inherited commit and tag signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-git-config-'));
  const isolated = join(root, 'isolated');
  const hostileHome = join(root, 'hostile-home');
  try {
    await mkdir(isolated, { recursive: true });
    await mkdir(hostileHome, { recursive: true });
    await writeFile(join(hostileHome, '.gitconfig'), '[commit]\n\tgpgsign = true\n[tag]\n\tgpgSign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = /definitely/missing/key\n');
    const env = cleanNpmEnvironment({ ...process.env, HOME: hostileHome }, isolated);
    await writeFile(join(isolated, 'gitconfig'), '');
    await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env });
    await execFile('git', ['config', 'user.name', 'TinySDD tests'], { cwd: root, env });
    await execFile('git', ['config', 'user.email', 'tests@example.test'], { cwd: root, env });
    await writeFile(join(root, 'README.md'), 'isolated\n');
    await execFile('git', ['add', 'README.md'], { cwd: root, env });
    await execFile('git', ['commit', '--quiet', '-m', 'chore: isolated fixture'], { cwd: root, env });
    await execFile('git', ['tag', '-a', 'v1.0.0', '-m', 'isolated tag'], { cwd: root, env });
    const commit = await execFile('git', ['cat-file', 'commit', 'HEAD'], { cwd: root, env });
    const tag = await execFile('git', ['cat-file', 'tag', 'v1.0.0'], { cwd: root, env });
    assert.doesNotMatch(commit.stdout, /^gpgsig /mu);
    assert.doesNotMatch(tag.stdout, /^gpgsig /mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('versioned archive verification binds every skills/docs byte to the remote tag commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-release-archive-source-'));
  const remote = await mkdtemp(join(tmpdir(), 'tinysdd-release-archive-remote-'));
  await rm(remote, { recursive: true, force: true });
  try {
    await cp(join(sourceRoot, 'skills'), join(root, 'skills'), { recursive: true });
    await cp(join(sourceRoot, 'docs'), join(root, 'docs'), { recursive: true });
    const packageDocument = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    await writeFile(join(root, 'package.json'), `${JSON.stringify(packageDocument, null, 2)}\n`);
    await git(root, 'init', '--quiet', '--initial-branch=main');
    await git(root, 'config', 'user.email', 'tests@example.test');
    await git(root, 'config', 'user.name', 'TinySDD tests');
    await git(root, 'add', '.');
    await git(root, 'commit', '--quiet', '-m', 'chore: archive fixture');
    const version = packageDocument.version;
    const tag = `v${version}`;
    await git(root, 'tag', '-a', tag, '-m', 'bootstrap');
    await git(root, 'init', '--bare', '--quiet', '--initial-branch=main', remote);
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '--quiet', '--set-upstream', 'origin', 'main', '--tags');
    const commit = (await git(root, 'rev-parse', 'HEAD^{commit}')).stdout.trim();
    const archive = await execFile('git', ['archive', '--format=tar.gz', `--prefix=tiny-sdd-${tag}/`, commit], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const adapter = createArchiveAdapter({ attempts: 1, delayMs: 0, fetchImpl: async () => new Response(archive.stdout) });
    const result = await adapter.verify({ root, git: gitAdapter, version, tag, commit });
    assert.equal(result.version, version);

    const template = join(root, 'skills/tinysdd/assets/harness/claude/tinysdd-frontier/templates/design.md');
    await writeFile(template, `${await readFile(template, 'utf8')}\narchive mutation\n`);
    await git(root, 'add', template);
    await git(root, 'commit', '--quiet', '-m', 'docs: mutate archive fixture template');
    const mutatedArchive = await execFile('git', ['archive', '--format=tar.gz', `--prefix=tiny-sdd-${tag}/`, 'HEAD'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const mismatchAdapter = createArchiveAdapter({ attempts: 1, delayMs: 0, fetchImpl: async () => new Response(mutatedArchive.stdout) });
    await assert.rejects(
      mismatchAdapter.verify({ root, git: gitAdapter, version, tag, commit }),
      (error) => error instanceof ReleaseError && error.code === 'RELEASE_ARCHIVE_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});
