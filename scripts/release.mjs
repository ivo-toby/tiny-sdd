#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GIT_REPOSITORY,
  downloadReleaseArchive,
  extractReleaseArchive,
  validateBundle,
} from '../src/setup.mjs';
import {
  PACKAGE_NAME,
  parseReleaseTag,
  readReleasePlan,
} from './release-plan.mjs';
import { PACKAGED_RESOURCES, cleanNpmEnvironment, verifyPackage } from './verify-package.mjs';

const execFile = promisify(execFileCallback);

export const GITHUB_REPOSITORY = 'ivo-toby/tiny-sdd';
export const RELEASE_REMOTE = 'origin';
export const RELEASE_BRANCH = 'main';
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

export class ReleaseError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function releaseError(code, message, details = undefined) {
  return new ReleaseError(code, message, details);
}

function commandDescription(command, args) {
  return `${command} ${args.join(' ')}`;
}

async function execute(command, args, { cwd, env, allowFailure = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    const result = await execFile(command, args, { cwd, env, maxBuffer });
    return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (cause) {
    const result = {
      ok: false,
      stdout: String(cause?.stdout ?? ''),
      stderr: String(cause?.stderr ?? ''),
      error: cause,
    };
    if (allowFailure) return result;
    throw releaseError('RELEASE_COMMAND_FAILED', `${commandDescription(command, args)} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`, {
      command,
      args,
      status: cause?.status ?? null,
    });
  }
}

export function createGitAdapter() {
  return {
    async run(args, cwd, options = {}) {
      const result = await execute('git', args, { cwd, ...options });
      return result.ok ? result.stdout : null;
    },
  };
}

function text(result) {
  return typeof result === 'string' ? result : String(result?.stdout ?? '');
}

async function gitText(git, root, args, options = {}) {
  return text(await git.run(args, root, options));
}

async function gitValue(git, root, args, options = {}) {
  return (await gitText(git, root, args, options)).trim();
}

function repositoryPath(value) {
  if (typeof value !== 'string') return null;
  let normalized = value.trim().replace(/^git\+/u, '').replace(/\.git$/u, '');
  normalized = normalized.replace(/^https?:\/\/github\.com\//iu, '');
  normalized = normalized.replace(/^ssh:\/\/git@github\.com\//iu, '');
  normalized = normalized.replace(/^git@github\.com:/iu, '');
  return normalized;
}

function packageRepository(packageDocument) {
  const repository = packageDocument?.repository;
  return typeof repository === 'string' ? repository : repository?.url;
}

function assertPackageRepository(packageDocument) {
  if (repositoryPath(packageRepository(packageDocument)) !== GITHUB_REPOSITORY) {
    throw releaseError('RELEASE_REPOSITORY_MISMATCH', `package.json repository must identify ${GITHUB_REPOSITORY}`);
  }
}

function assertRuntimeContext(env) {
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== GITHUB_REPOSITORY) {
    throw releaseError('RELEASE_REPOSITORY_MISMATCH', `GitHub repository is ${env.GITHUB_REPOSITORY}, expected ${GITHUB_REPOSITORY}`);
  }
  if (env.GITHUB_REF && env.GITHUB_REF !== `refs/heads/${RELEASE_BRANCH}`) {
    throw releaseError('RELEASE_REF_INVALID', `release workflow must run from refs/heads/${RELEASE_BRANCH}`);
  }
  // The checkout is deliberately refreshed from main so queued/retried runs can resume a tagged release.
}

export async function validateReleaseCheckout({ root = process.cwd(), git = createGitAdapter(), env = process.env, requireRemote = true } = {}) {
  const projectRoot = resolve(root);
  const status = await gitText(git, projectRoot, ['status', '--porcelain=v1']);
  if (status.trim()) throw releaseError('RELEASE_CHECKOUT_DIRTY', 'release checkout has uncommitted changes', { status });
  const packagePath = join(projectRoot, 'package.json');
  let packageDocument;
  try {
    packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (cause) {
    throw releaseError('RELEASE_PACKAGE_INVALID', `could not read ${packagePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (packageDocument?.name !== PACKAGE_NAME || typeof packageDocument?.version !== 'string') {
    throw releaseError('RELEASE_PACKAGE_INVALID', `package.json must identify ${PACKAGE_NAME} with a version`);
  }
  assertPackageRepository(packageDocument);
  const head = await gitValue(git, projectRoot, ['rev-parse', 'HEAD^{commit}']);
  if (!head) throw releaseError('RELEASE_HEAD_MISSING', 'release checkout has no commit');
  assertRuntimeContext(env);
  if (!requireRemote) return { root: projectRoot, packageDocument, head };
  const remoteUrl = await gitValue(git, projectRoot, ['remote', 'get-url', RELEASE_REMOTE]);
  if (repositoryPath(remoteUrl) !== GITHUB_REPOSITORY) {
    throw releaseError('RELEASE_REMOTE_MISMATCH', `origin must identify ${GITHUB_REPOSITORY}`);
  }
  const localMain = await gitValue(git, projectRoot, ['rev-parse', `refs/remotes/${RELEASE_REMOTE}/${RELEASE_BRANCH}^{commit}`]);
  if (localMain !== head) throw releaseError('RELEASE_HEAD_MISMATCH', `checked out HEAD ${head} is not origin/${RELEASE_BRANCH} ${localMain}`);
  const remoteMain = await remoteCommit(git, projectRoot, RELEASE_BRANCH);
  if (remoteMain !== head) throw releaseError('RELEASE_HEAD_MISMATCH', `origin/${RELEASE_BRANCH} moved to ${remoteMain}; checked out HEAD is ${head}`);
  return { root: projectRoot, packageDocument, head };
}

function parseRemoteRefs(output) {
  const refs = new Map();
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const match = /^(\S+)\s+(\S+)$/u.exec(line.trim());
    if (match) refs.set(match[2], match[1]);
  }
  return refs;
}

export async function remoteCommit(git, root, branch = RELEASE_BRANCH) {
  const refs = parseRemoteRefs(await gitText(git, root, ['ls-remote', RELEASE_REMOTE, `refs/heads/${branch}`]));
  const commit = refs.get(`refs/heads/${branch}`);
  if (!commit) throw releaseError('RELEASE_REMOTE_MISSING', `origin has no ${branch} branch`);
  return commit;
}

export async function remoteTag(git, root, tag) {
  const refs = parseRemoteRefs(await gitText(git, root, ['ls-remote', RELEASE_REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

function parseTagMessage(message) {
  const metadata = {};
  const lines = String(message ?? '').split(/\r?\n/u);
  for (const line of lines) {
    const match = /^(package|commit|tarball-integrity):\s*(\S+)$/u.exec(line.trim());
    if (match) metadata[match[1]] = match[2];
  }
  const packageMatch = /^([^@\s]+)@([^\s]+)$/u.exec(metadata.package ?? '');
  return {
    packageName: packageMatch?.[1] ?? null,
    packageVersion: packageMatch?.[2] ?? null,
    commit: metadata.commit ?? null,
    integrity: metadata['tarball-integrity'] ?? null,
    subjects: lines.filter((line) => /^-\s+\S/u.test(line.trim())).map((line) => line.trim().slice(2)),
  };
}

export async function readTagMetadata(git, root, tag) {
  const output = await gitText(git, root, ['for-each-ref', `refs/tags/${tag}`, '--format=%(objecttype)%00%(contents)']);
  const separator = output.indexOf('\0');
  const objectType = separator < 0 ? output.trim() : output.slice(0, separator).trim();
  const message = separator < 0 ? '' : output.slice(separator + 1);
  if (objectType !== 'tag') return { packageName: null, packageVersion: null, commit: null, integrity: null, annotated: false };
  return { ...parseTagMessage(message), annotated: true };
}

function assertTagMetadata(metadata, { tag, version, commit, integrity = undefined } = {}) {
  const parsed = parseReleaseTag(tag);
  if (!parsed || parsed.version !== version) throw releaseError('RELEASE_TAG_INVALID', `tag ${tag} does not identify ${version}`);
  if (!metadata.annotated || metadata.packageName !== PACKAGE_NAME || metadata.packageVersion !== version) {
    throw releaseError('RELEASE_TAG_METADATA_INVALID', `tag ${tag} does not retain ${PACKAGE_NAME}@${version} metadata`);
  }
  if (metadata.commit !== commit) throw releaseError('RELEASE_TAG_COMMIT_MISMATCH', `tag ${tag} points to ${metadata.commit ?? 'no commit metadata'}, expected ${commit}`);
  if (!INTEGRITY_PATTERN.test(metadata.integrity ?? '')) throw releaseError('RELEASE_ARTIFACT_INTEGRITY_MISSING', `tag ${tag} has no valid tarball integrity metadata`);
  if (integrity !== undefined && metadata.integrity !== integrity) throw releaseError('RELEASE_ARTIFACT_MISMATCH', `tag ${tag} records ${metadata.integrity}, but the verified artifact is ${integrity}`);
  return metadata;
}

function tagMessage(version, commit, integrity, subjects = []) {
  const notes = subjects.filter(Boolean).map((subject) => `- ${subject}`).join('\n');
  return `TinySDD release v${version}\n\npackage: ${PACKAGE_NAME}@${version}\ncommit: ${commit}\ntarball-integrity: ${integrity}${notes ? `\nsubjects:\n${notes}` : ''}`;
}

function versionedArtifactName(version) {
  return `${PACKAGE_NAME}-${version}.tgz`;
}

function sha512Integrity(path) {
  return readFile(path).then((bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
}

function normalizeRegistryStatus(status) {
  if (status === null || status === undefined || status === false) return { exists: false, integrity: null };
  if (status.exists === false) return { exists: false, integrity: null };
  if (status.exists === true) return { exists: true, integrity: status.integrity ?? null };
  if (typeof status === 'string') return { exists: true, integrity: status };
  return { exists: Boolean(status), integrity: status.integrity ?? null };
}

function publicationEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of [
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'npm_config__auth',
    'npm_config_token',
    'npm_config_userconfig',
    'NPM_CONFIG_USERCONFIG',
    'npm_config_globalconfig',
    'NPM_CONFIG_GLOBALCONFIG',
    'NPM_CONFIG__AUTH',
    'NPM_CONFIG_TOKEN',
  ]) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^(?:NPM_CONFIG_|npm_config_).*(?:auth|token)/iu.test(key)) delete env[key];
  }
  return env;
}

export function createNpmAdapter({ npm = 'npm', sourceEnv = process.env } = {}) {
  return {
    async get(name, version) {
      const configRoot = await mkdtemp(join(tmpdir(), 'tinysdd-release-npm-'));
      const env = cleanNpmEnvironment(sourceEnv, configRoot);
      try {
        const result = await execute(npm, ['view', `${name}@${version}`, 'dist.integrity', '--json', '--no-update-notifier', '--registry=https://registry.npmjs.org/'], { env, allowFailure: true });
        if (!result.ok) {
          if (/\b(?:E404|404|not found)\b/iu.test(result.stderr)) return { exists: false, integrity: null };
          throw releaseError('RELEASE_REGISTRY_FAILED', `could not inspect npm ${name}@${version}: ${result.stderr.trim() || 'npm view failed'}`);
        }
        let value;
        try { value = JSON.parse(result.stdout); } catch { value = result.stdout.trim(); }
        return { exists: value !== null && value !== undefined && value !== '', integrity: typeof value === 'string' ? value : value?.['dist.integrity'] ?? value?.dist?.integrity ?? null };
      } finally {
        await rm(configRoot, { recursive: true, force: true });
      }
    },
    async publish(artifact) {
      const env = publicationEnvironment(sourceEnv);
      const result = await execute(npm, ['publish', artifact, '--access', 'public', '--ignore-scripts', '--provenance', '--registry=https://registry.npmjs.org/'], { env });
      return result.stdout.trim();
    },
  };
}

function parseGhJson(result, action) {
  if (!result.ok) throw releaseError('RELEASE_GITHUB_FAILED', `${action} failed: ${result.stderr.trim() || 'gh command failed'}`);
  try { return JSON.parse(result.stdout); } catch (cause) {
    throw releaseError('RELEASE_GITHUB_INVALID', `${action} returned invalid JSON`, { cause: cause instanceof Error ? cause.message : String(cause) });
  }
}

export function createGitHubAdapter({ gh = 'gh', repository = GITHUB_REPOSITORY, sourceEnv = process.env } = {}) {
  const endpoint = (tag) => `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const listEndpoint = (page) => `repos/${repository}/releases?per_page=100&page=${page}`;
  return {
    async getRelease(tag) {
      const result = await execute(gh, ['api', endpoint(tag)], { env: sourceEnv, allowFailure: true });
      if (result.ok) return parseGhJson(result, `reading GitHub release ${tag}`);
      if (!/\b(?:404|not found)\b/iu.test(result.stderr)) return parseGhJson(result, `reading GitHub release ${tag}`);
      for (let page = 1; page <= 10; page += 1) {
        const listing = await execute(gh, ['api', listEndpoint(page)], { env: sourceEnv });
        const releases = parseGhJson(listing, `listing GitHub releases page ${page}`);
        if (!Array.isArray(releases)) throw releaseError('RELEASE_GITHUB_INVALID', `GitHub release listing page ${page} was not an array`);
        const found = releases.find((release) => release?.tag_name === tag);
        if (found) return found;
        if (releases.length < 100) break;
      }
      return null;
    },
    async createDraft({ tag, commit, version, integrity, notes = '' }) {
      const result = await execute(gh, [
        'api', '--method', 'POST', `repos/${repository}/releases`,
        '-f', `tag_name=${tag}`,
        '-f', `target_commitish=${commit}`,
        '-f', `name=TinySDD ${tag}`,
        '-f', `body=Package ${PACKAGE_NAME}@${version}\n\nCommit: ${commit}\nTarball integrity: ${integrity}${notes ? `\n\n${notes}` : ''}`,
        '-F', 'draft=true',
      ], { env: sourceEnv });
      return parseGhJson(result, `creating GitHub draft release ${tag}`);
    },
    async uploadAsset({ tag, artifact }) {
      const result = await execute(gh, ['release', 'upload', tag, artifact, '--repo', repository], { env: sourceEnv });
      return result.stdout.trim();
    },
    async downloadAsset({ tag, name, destination }) {
      await mkdir(destination, { recursive: true });
      await execute(gh, ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', destination], { env: sourceEnv });
      return join(destination, name);
    },
    async publishRelease(tag) {
      const release = await this.getRelease(tag);
      if (!release || !Number.isSafeInteger(release.id)) throw releaseError('RELEASE_GITHUB_MISSING', `GitHub release ${tag} has no numeric release id`);
      const result = await execute(gh, ['api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`, '-F', 'draft=false'], { env: sourceEnv });
      return parseGhJson(result, `publishing GitHub release ${tag}`);
    },
  };
}

async function wait(delayMs) {
  if (delayMs <= 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function regularFiles(root, relativePath) {
  const directory = join(root, relativePath);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw releaseError('RELEASE_ARCHIVE_MISMATCH', `archive contains a symbolic link at ${child}`);
    if (entry.isDirectory()) result.push(...await regularFiles(root, child));
    else if (entry.isFile()) result.push(child);
    else throw releaseError('RELEASE_ARCHIVE_MISMATCH', `archive contains a non-file payload at ${child}`);
  }
  return result;
}

async function compareArchiveTree({ sourceRoot, root, git, commit }) {
  const archivePaths = (await Promise.all(['skills', 'docs'].map((directory) => regularFiles(sourceRoot, directory)))).flat();
  const taggedPaths = (await gitText(git, root, ['ls-tree', '-r', '--name-only', commit, '--', 'skills', 'docs']))
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
  const archiveSet = new Set(archivePaths);
  const taggedSet = new Set(taggedPaths);
  if (archiveSet.size !== taggedSet.size || archivePaths.some((path) => !taggedSet.has(path)) || taggedPaths.some((path) => !archiveSet.has(path))) {
    throw releaseError('RELEASE_ARCHIVE_MISMATCH', `versioned archive skills/docs tree differs from tagged commit ${commit}`);
  }
  for (const resource of ['package.json', ...archivePaths]) {
    const [archiveBytes, taggedBytes] = await Promise.all([
      readFile(join(sourceRoot, resource)),
      git.run(['show', `${commit}:${resource}`], root),
    ]);
    if (!archiveBytes.equals(Buffer.from(text(taggedBytes)))) throw releaseError('RELEASE_ARCHIVE_MISMATCH', `versioned archive differs from ${commit}:${resource}`);
  }
}

export function createArchiveAdapter({ repository = GIT_REPOSITORY, attempts = 5, delayMs = 5_000, fetchImpl = globalThis.fetch } = {}) {
  return {
    async verify({ root, git, version, tag, commit }) {
      if (!root || !git || !tag || !commit) throw releaseError('RELEASE_ARCHIVE_IDENTITY', 'archive verification needs the source root, tag and commit identity');
      const tempRoot = await realpath(tmpdir());
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const destination = await mkdtemp(join(tempRoot, 'tinysdd-release-archive-'));
        try {
          const localTagCommit = await gitValue(git, root, ['rev-parse', `${tag}^{commit}`]);
          const publicTagCommit = await remoteTag(git, root, tag);
          if (localTagCommit !== commit || publicTagCommit !== commit) {
            throw releaseError('RELEASE_TAG_MISMATCH', `archive tag ${tag} does not resolve to intended commit ${commit}`);
          }
          const archive = await downloadReleaseArchive({ version, repository, fetchImpl });
          const sourceRoot = await extractReleaseArchive(archive.bytes, destination);
          const bundle = await validateBundle(sourceRoot, { expectedVersion: version });
          await compareArchiveTree({ sourceRoot, root, git, commit });
          return { ...bundle, sha256: archive.sha256, url: archive.url };
        } catch (cause) {
          if (cause instanceof ReleaseError && ['RELEASE_TAG_MISMATCH', 'RELEASE_ARCHIVE_MISMATCH'].includes(cause.code)) throw cause;
          lastError = cause;
        } finally {
          await rm(destination, { recursive: true, force: true });
        }
        if (attempt < attempts) await wait(delayMs);
      }
      throw releaseError('RELEASE_ARCHIVE_UNAVAILABLE', `versioned archive v${version} was not available or valid after ${attempts} attempts`, {
        cause: lastError instanceof Error ? lastError.message : String(lastError),
      });
    },
  };
}

async function packProject({ cwd, env, destination }) {
  await mkdir(destination, { recursive: true });
  const result = await execute('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', destination], { cwd, env });
  let records;
  try { records = JSON.parse(result.stdout); } catch {
    throw releaseError('RELEASE_PACK_INVALID', 'npm pack did not return JSON metadata');
  }
  if (!Array.isArray(records) || records.length !== 1 || typeof records[0]?.filename !== 'string') {
    throw releaseError('RELEASE_PACK_INVALID', 'npm pack did not produce exactly one package artifact');
  }
  const artifact = resolve(destination, records[0].filename);
  const version = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).version;
  return { artifact, version };
}

async function defaultRunTests({ cwd, env }) {
  await execute('npm', ['test'], { cwd, env });
}

async function prepareWorktree({ root, git, commit, version, changePackage, runTests = defaultRunTests, verify = verifyPackage } = {}) {
  const worktree = await mkdtemp(join(tmpdir(), 'tinysdd-release-worktree-'));
  const artifactRoot = await mkdtemp(join(tmpdir(), 'tinysdd-release-artifact-'));
  const npmEnvRoot = await mkdtemp(join(tmpdir(), 'tinysdd-release-test-npm-'));
  const env = cleanNpmEnvironment(process.env, npmEnvRoot);
  env.TYPESAFE_API_KEY = 'stub';
  try {
    await git.run(['worktree', 'add', '--detach', worktree, commit], root);
    const packagePath = join(worktree, 'package.json');
    const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
    if (changePackage) {
      packageDocument.version = version;
      await writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`);
      await git.run(['add', 'package.json'], worktree);
      await git.run([
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `chore(release): v${version}`,
      ], worktree);
    }
    const candidateCommit = await gitValue(git, worktree, ['rev-parse', 'HEAD^{commit}']);
    const candidatePackage = JSON.parse(await readFile(packagePath, 'utf8'));
    if (candidatePackage.name !== PACKAGE_NAME || candidatePackage.version !== version) {
      throw releaseError('RELEASE_PACKAGE_TAG_MISMATCH', `candidate package is ${candidatePackage.name}@${candidatePackage.version}, expected ${PACKAGE_NAME}@${version}`);
    }
    await runTests({ cwd: worktree, env, version, commit: candidateCommit });
    const candidateStatus = await gitText(git, worktree, ['status', '--porcelain=v1']);
    if (candidateStatus.trim()) throw releaseError('RELEASE_CANDIDATE_DIRTY', 'release verification changed the candidate worktree', { status: candidateStatus });
    const packed = await packProject({ cwd: worktree, env, destination: artifactRoot });
    if (packed.version !== version) throw releaseError('RELEASE_PACKAGE_TAG_MISMATCH', `packed package is ${packed.version}, expected ${version}`);
    await verify({ artifact: packed.artifact, projectRoot: worktree, version, sourceEnv: env });
    const integrity = await sha512Integrity(packed.artifact);
    return { worktree, artifactRoot, artifact: packed.artifact, version, commit: candidateCommit, integrity };
  } catch (cause) {
    await rm(artifactRoot, { recursive: true, force: true });
    throw cause;
  } finally {
    await git.run(['worktree', 'remove', '--force', worktree], root, { allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(npmEnvRoot, { recursive: true, force: true });
  }
}

export async function prepareReleaseCandidate(options = {}) {
  return prepareWorktree({ ...options, changePackage: true });
}

export async function prepareTaggedRelease(options = {}) {
  return prepareWorktree({ ...options, changePackage: false });
}

export async function verifyTaggedArtifact({ root, git, commit, artifact, version, verify = verifyPackage }) {
  const worktree = await mkdtemp(join(tmpdir(), 'tinysdd-release-tag-source-'));
  const unpack = await mkdtemp(join(tmpdir(), 'tinysdd-release-tag-package-'));
  const npmEnvRoot = await mkdtemp(join(tmpdir(), 'tinysdd-release-tag-npm-'));
  const env = cleanNpmEnvironment(process.env, npmEnvRoot);
  try {
    await git.run(['worktree', 'add', '--detach', worktree, commit], root);
    const sourcePackage = JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'));
    if (sourcePackage.name !== PACKAGE_NAME || sourcePackage.version !== version) {
      throw releaseError('RELEASE_PACKAGE_TAG_MISMATCH', `tagged source is ${sourcePackage.name}@${sourcePackage.version}, expected ${PACKAGE_NAME}@${version}`);
    }
    await execute('tar', ['-xzf', artifact, '-C', unpack], { env });
    const packageRoot = join(unpack, 'package');
    const resources = ['package.json', ...PACKAGED_RESOURCES];
    for (const resource of resources) {
      const [sourceBytes, packedBytes] = await Promise.all([
        readFile(join(worktree, resource)),
        readFile(join(packageRoot, resource)),
      ]);
      if (!sourceBytes.equals(packedBytes)) throw releaseError('RELEASE_ARTIFACT_MISMATCH', `tagged source and package differ at ${resource}`);
    }
    await verify({ artifact, projectRoot: worktree, version, sourceEnv: env });
  } finally {
    await git.run(['worktree', 'remove', '--force', worktree], root, { allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(unpack, { recursive: true, force: true });
    await rm(npmEnvRoot, { recursive: true, force: true });
  }
}

async function ensureDraftAsset({ github, tag, commit, version, integrity, notes = '', artifact = null, release: providedRelease = undefined }) {
  let release = providedRelease ?? await github.getRelease(tag);
  if (!release) release = await github.createDraft({ tag, commit, version, integrity, notes });
  if (release.tag_name && release.tag_name !== tag) throw releaseError('RELEASE_GITHUB_MISMATCH', `GitHub release is for ${release.tag_name}, expected ${tag}`);
  const name = versionedArtifactName(version);
  if (artifact && basename(artifact) !== name) throw releaseError('RELEASE_ARTIFACT_MISMATCH', `artifact is ${basename(artifact)}, expected ${name}`);
  const existing = Array.isArray(release.assets) ? release.assets.find((asset) => asset?.name === name) : null;
  if (!existing) {
    if (!artifact) throw releaseError('RELEASE_GITHUB_ASSET_MISSING', `GitHub release ${tag} has no ${name} asset and no verified artifact is available`);
    if (release.draft === false) throw releaseError('RELEASE_GITHUB_MISMATCH', `published GitHub release ${tag} has no verified ${name} asset`);
    await github.uploadAsset({ tag, artifact, name });
    return { release, artifact, cleanup: async () => {} };
  }
  const downloadRoot = await mkdtemp(join(tmpdir(), 'tinysdd-release-asset-'));
  try {
    const downloaded = await github.downloadAsset({ tag, name, destination: downloadRoot });
    const downloadedIntegrity = await sha512Integrity(downloaded);
    if (downloadedIntegrity !== integrity) throw releaseError('RELEASE_ARTIFACT_MISMATCH', `GitHub asset ${name} has ${downloadedIntegrity}, expected ${integrity}`);
    return { release, artifact: downloaded, cleanup: async () => rm(downloadRoot, { recursive: true, force: true }) };
  } catch (cause) {
    await rm(downloadRoot, { recursive: true, force: true });
    throw cause;
  }
}

async function inspectPending({ root, git, plan, registry, github }) {
  const tag = plan.baseTag ?? (plan.kind === 'none' ? plan.tag : null);
  if (!tag) return null;
  const parsed = parseReleaseTag(tag);
  if (!parsed) return null;
  const tagCommit = await gitValue(git, root, ['rev-parse', `${tag}^{commit}`]);
  const publishedTagCommit = await remoteTag(git, root, tag);
  if (publishedTagCommit !== tagCommit) {
    throw releaseError('RELEASE_TAG_MISMATCH', `origin tag ${tag} points to ${publishedTagCommit ?? 'nothing'}, expected ${tagCommit}`);
  }
  const metadata = await readTagMetadata(git, root, tag);
  if (!metadata.integrity) return null;
  assertTagMetadata(metadata, { tag, version: parsed.version, commit: tagCommit });
  const status = normalizeRegistryStatus(await registry.get(PACKAGE_NAME, parsed.version));
  if (status.exists && status.integrity !== metadata.integrity) {
    throw releaseError('RELEASE_ARTIFACT_MISMATCH', `npm has ${PACKAGE_NAME}@${parsed.version} with ${status.integrity ?? 'unknown integrity'}, expected ${metadata.integrity}`);
  }
  const release = await github.getRelease(tag);
  const needsRelease = !release || release.draft === true;
  if (!status.exists || needsRelease) return { tag, version: parsed.version, commit: tagCommit, metadata, status, release };
  return null;
}

async function finishPending({ root, git, pending, registry, github, archive, prepareTagged = prepareTaggedRelease, verifyTagged = verifyTaggedArtifact, runTests, verify }) {
  let candidate = null;
  let asset = null;
  try {
    await archive.verify({ root, git, version: pending.version, tag: pending.tag, commit: pending.commit });
    const name = versionedArtifactName(pending.version);
    const hasAsset = Array.isArray(pending.release?.assets) && pending.release.assets.some((entry) => entry?.name === name);
    if (hasAsset) {
      asset = await ensureDraftAsset({
        github,
        tag: pending.tag,
        commit: pending.commit,
        version: pending.version,
        integrity: pending.metadata.integrity,
        notes: pending.metadata.subjects?.map((subject) => `- ${subject}`).join('\n') ?? '',
        release: pending.release,
      });
      await verifyTagged({ root, git, commit: pending.commit, artifact: asset.artifact, version: pending.version, verify });
    } else {
      candidate = await prepareTagged({ root, git, commit: pending.commit, version: pending.version, runTests, verify });
      assertTagMetadata(pending.metadata, { tag: pending.tag, version: pending.version, commit: pending.commit, integrity: candidate.integrity });
      asset = await ensureDraftAsset({
        github,
        tag: pending.tag,
        commit: pending.commit,
        version: pending.version,
        integrity: candidate.integrity,
        notes: pending.metadata.subjects?.map((subject) => `- ${subject}`).join('\n') ?? '',
        artifact: candidate.artifact,
        release: pending.release,
      });
    }
    const status = normalizeRegistryStatus(await registry.get(PACKAGE_NAME, pending.version));
    const integrity = pending.metadata.integrity;
    if (status.exists && status.integrity !== integrity) {
      throw releaseError('RELEASE_ARTIFACT_MISMATCH', `npm has ${PACKAGE_NAME}@${pending.version} with ${status.integrity ?? 'unknown integrity'}, expected ${integrity}`);
    }
    if (!status.exists) await registry.publish(asset.artifact);
    await github.publishRelease(pending.tag);
    return { status: 'published', version: pending.version, tag: pending.tag, commit: pending.commit, integrity };
  } finally {
    if (asset?.cleanup) await asset.cleanup();
    if (candidate?.artifactRoot) await rm(candidate.artifactRoot, { recursive: true, force: true });
  }
}

async function createRelease({ root, git, plan, registry, github, archive, prepareCandidate = prepareReleaseCandidate, runTests, verify }) {
  const beforeRegistry = normalizeRegistryStatus(await registry.get(PACKAGE_NAME, plan.version));
  if (beforeRegistry.exists) throw releaseError('RELEASE_VERSION_CONFLICT', `npm already contains ${PACKAGE_NAME}@${plan.version}; refusing to replace it`);
  if (await remoteTag(git, root, plan.tag)) throw releaseError('RELEASE_TAG_CONFLICT', `origin already contains ${plan.tag}; refusing to replace it`);
  const localTag = await git.run(['show-ref', '--verify', `refs/tags/${plan.tag}`], root, { allowFailure: true });
  if (localTag) throw releaseError('RELEASE_TAG_CONFLICT', `local checkout already contains ${plan.tag}`);
  const sourceHead = plan.head;
  const candidate = await prepareCandidate({ root, git, commit: sourceHead, version: plan.version, runTests, verify });
  let asset = null;
  const subjects = plan.commits.map((entry) => entry.subject).filter(Boolean);
  const notes = subjects.map((subject) => `- ${subject}`).join('\n');
  try {
    await git.run([
      '-c', 'user.name=github-actions[bot]',
      '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag', '-a', plan.tag, candidate.commit, '-m', tagMessage(plan.version, candidate.commit, candidate.integrity, subjects),
    ], root);
    const remoteBeforePush = await remoteCommit(git, root, RELEASE_BRANCH);
    if (remoteBeforePush !== sourceHead) throw releaseError('RELEASE_RACE', `origin/${RELEASE_BRANCH} moved from ${sourceHead} to ${remoteBeforePush}`);
    await git.run(['push', '--atomic', RELEASE_REMOTE, `${candidate.commit}:refs/heads/${RELEASE_BRANCH}`, `${plan.tag}:refs/tags/${plan.tag}`], root);
    await archive.verify({ root, git, version: plan.version, tag: plan.tag, commit: candidate.commit });
    asset = await ensureDraftAsset({
      github,
      tag: plan.tag,
      commit: candidate.commit,
      version: plan.version,
      integrity: candidate.integrity,
      notes,
      artifact: candidate.artifact,
    });
    await registry.publish(asset.artifact);
    await github.publishRelease(plan.tag);
    return { status: 'published', version: plan.version, tag: plan.tag, commit: candidate.commit, integrity: candidate.integrity };
  } finally {
    if (asset?.cleanup) await asset.cleanup();
    await rm(candidate.artifactRoot, { recursive: true, force: true });
  }
}

export async function runRelease({
  root = process.cwd(),
  env = process.env,
  enabled = env.NPM_RELEASES_ENABLED === 'true',
  dryRun = false,
  validateCheckout: shouldValidate = true,
  requireRemote = true,
  git = createGitAdapter(),
  registry = createNpmAdapter({ sourceEnv: env }),
  github = createGitHubAdapter({ sourceEnv: env }),
  archive = createArchiveAdapter(),
  prepareCandidate = prepareReleaseCandidate,
  prepareTagged = prepareTaggedRelease,
  runTests = undefined,
  verify = verifyPackage,
  verifyTagged = verifyTaggedArtifact,
} = {}) {
  const projectRoot = resolve(root);
  if (shouldValidate) await validateReleaseCheckout({ root: projectRoot, git, env, requireRemote });
  const plan = await readReleasePlan(projectRoot, { git: (cwd, args) => git.run(args, cwd) });
  if (dryRun) return { status: 'dry-run', plan };
  if (plan.kind === 'bootstrap') return { status: 'bootstrap', plan, message: `create and publish the reviewed ${plan.tag} bootstrap tag before enabling npm releases` };
  if (!enabled) return { status: 'disabled', plan, message: 'NPM_RELEASES_ENABLED is not true; release publication is not configured' };
  let completedPending = false;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const currentPlan = cycle === 0 ? plan : await readReleasePlan(projectRoot, { git: (cwd, args) => git.run(args, cwd) });
    const pending = await inspectPending({ root: projectRoot, git, plan: currentPlan, registry, github });
    if (pending) {
      const result = await finishPending({ root: projectRoot, git, pending, registry, github, archive, prepareTagged, verifyTagged, runTests, verify });
      completedPending = true;
      if (currentPlan.kind === 'release') continue;
      return { ...result, resumed: true };
    }
    if (!currentPlan.release || currentPlan.kind === 'none') return { status: completedPending ? 'pending-complete' : 'no-release', plan: currentPlan };
    const result = await createRelease({ root: projectRoot, git, plan: currentPlan, registry, github, archive, prepareCandidate, runTests, verify });
    return result;
  }
  throw releaseError('RELEASE_PENDING_LOOP', 'pending release completion did not converge before planning another release');
}

function parseArguments(argv) {
  const result = { root: process.cwd(), json: false, dryRun: false, enabled: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') result.root = argv[++index];
    else if (argument.startsWith('--root=')) result.root = argument.slice('--root='.length);
    else if (argument === '--json') result.json = true;
    else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--enabled') result.enabled = argv[++index] === 'true';
    else if (argument.startsWith('--enabled=')) result.enabled = argument.slice('--enabled='.length) === 'true';
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw releaseError('RELEASE_ARGUMENT_INVALID', `unknown argument: ${argument}`);
  }
  if (!result.root) throw releaseError('RELEASE_ARGUMENT_INVALID', '--root requires a path');
  return result;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('usage: release.mjs [--root PATH] [--enabled true|false] [--dry-run] [--json]\n');
    return;
  }
  const result = await runRelease({ root: options.root, enabled: options.enabled, dryRun: options.dryRun });
  process.stdout.write(`${options.json ? JSON.stringify(result) : `${result.status}: ${result.message ?? result.tag ?? result.plan?.version ?? 'no release'}\n`}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: cause?.code ?? 'RELEASE_FAILED', message: cause instanceof Error ? cause.message : String(cause) } })}\n`);
    process.exitCode = 1;
  }
}
