#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFile = promisify(execFileCallback);

export const PACKAGE_NAME = 'tinysdd';
export const INITIAL_VERSION = '0.1.0';
export const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const BUMP_RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const RELEASE_SUBJECT_PATTERN = /^chore\(release\):\s*v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\s*$/iu;

export class ReleasePlanError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReleasePlanError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function planError(code, message, details = undefined) {
  return new ReleasePlanError(code, message, details);
}

export function parseVersion(version) {
  if (typeof version !== 'string') throw planError('RELEASE_VERSION_INVALID', `version must be a stable semantic version: ${version ?? 'missing'}`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw planError('RELEASE_VERSION_INVALID', `version must be a stable semantic version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function parseReleaseTag(name) {
  if (typeof name !== 'string') return null;
  const match = RELEASE_TAG_PATTERN.exec(name);
  if (!match) return null;
  return { name, version: `${match[1]}.${match[2]}.${match[3]}` };
}

export function bumpVersion(version, bump) {
  const parts = parseVersion(version);
  if (!Object.hasOwn(BUMP_RANK, bump) || bump === 'none') return version;
  if (bump === 'major') return `${parts[0] + 1}.0.0`;
  if (bump === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function isGeneratedReleaseCommit(subject) {
  return RELEASE_SUBJECT_PATTERN.test(subject);
}

function hasBreakingFooter(message) {
  return /(?:^|\r?\n)BREAKING(?: CHANGE|[-]CHANGE)(?::|\s*$)/u.test(message);
}

export function classifyCommit(message) {
  if (typeof message !== 'string') return { type: null, scope: null, breaking: false, bump: 'none', release: false, generatedRelease: false };
  const subject = message.split(/\r?\n/u, 1)[0].trim();
  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\(([^)\r\n]+)\))?(!)?\s*:\s*.*$/u.exec(subject);
  if (!match) return { type: null, scope: null, breaking: false, bump: 'none', release: false, generatedRelease: false };
  const type = match[1].toLowerCase();
  const scope = match[2]?.toLowerCase() ?? null;
  const generatedRelease = isGeneratedReleaseCommit(subject);
  const breaking = !generatedRelease && (Boolean(match[3]) || hasBreakingFooter(message));
  const bump = generatedRelease
    ? 'none'
    : breaking
      ? 'major'
      : type === 'feat'
        ? 'minor'
        : type === 'fix' || type === 'chore'
          ? 'patch'
          : 'none';
  return { type, scope, breaking, bump, release: bump !== 'none', generatedRelease };
}

export function highestBump(commits = []) {
  let selected = 'none';
  for (const commit of commits) {
    const classification = typeof commit === 'string'
      ? classifyCommit(commit)
      : commit.classification ?? classifyCommit(commit.message);
    if (BUMP_RANK[classification.bump] > BUMP_RANK[selected]) selected = classification.bump;
  }
  return selected;
}

function normalizeCommit(commit) {
  const classification = classifyCommit(commit.message ?? '');
  return {
    ...(typeof commit.hash === 'string' ? { hash: commit.hash } : {}),
    subject: String(commit.message ?? '').split(/\r?\n/u, 1)[0].trim(),
    classification,
  };
}

function normalizeTags(tags) {
  const normalized = [];
  const versions = new Map();
  for (const tag of tags ?? []) {
    const parsed = parseReleaseTag(tag.name);
    if (!parsed) throw planError('RELEASE_TAG_INVALID', `reachable release-looking tag is not stable vX.Y.Z: ${tag.name}`);
    if (versions.has(parsed.version)) throw planError('RELEASE_TAG_CONFLICT', `multiple reachable tags identify version ${parsed.version}: ${versions.get(parsed.version)} and ${parsed.name}`);
    versions.set(parsed.version, parsed.name);
    parseVersion(parsed.version);
    if (tag.packageVersion !== undefined && tag.packageVersion !== null) parseVersion(tag.packageVersion);
    if (tag.packageVersion !== undefined && tag.packageVersion !== null && tag.packageVersion !== parsed.version) {
      throw planError('RELEASE_TAG_PACKAGE_MISMATCH', `tag ${parsed.name} contains package version ${tag.packageVersion}, expected ${parsed.version}`);
    }
    normalized.push({ ...parsed, commit: tag.commit ?? null, packageVersion: tag.packageVersion ?? null });
  }
  return normalized.sort((left, right) => compareVersions(right.version, left.version) || left.name.localeCompare(right.name));
}

export function buildReleasePlan({
  packageName = PACKAGE_NAME,
  packageVersion,
  head,
  tags = [],
  commits = [],
  initialVersion = INITIAL_VERSION,
} = {}) {
  if (packageName !== PACKAGE_NAME) throw planError('RELEASE_PACKAGE_INVALID', `release workflow is configured for ${PACKAGE_NAME}, found ${packageName}`);
  parseVersion(packageVersion);
  parseVersion(initialVersion);
  if (typeof head !== 'string' || head.length === 0) throw planError('RELEASE_HEAD_MISSING', 'release plan needs the current commit');
  const reachableTags = normalizeTags(tags);
  const normalizedCommits = commits.map(normalizeCommit);
  const latest = reachableTags[0] ?? null;
  if (!latest) {
    return {
      schemaVersion: 1,
      kind: 'bootstrap',
      release: true,
      packageName,
      currentVersion: packageVersion,
      version: packageVersion,
      tag: `v${packageVersion}`,
      head,
      baseTag: null,
      bump: 'none',
      commits: normalizedCommits,
    };
  }
  if (latest.packageVersion !== null && latest.packageVersion !== latest.version) {
    throw planError('RELEASE_TAG_PACKAGE_MISMATCH', `tag ${latest.name} contains package version ${latest.packageVersion}, expected ${latest.version}`);
  }
  if (packageVersion !== latest.version) {
    throw planError('RELEASE_PACKAGE_TAG_MISMATCH', `package.json is ${packageVersion}, but the latest reachable release tag is ${latest.name}`);
  }
  const bump = highestBump(normalizedCommits);
  if (bump === 'none') {
    return {
      schemaVersion: 1,
      kind: 'none',
      release: false,
      packageName,
      currentVersion: packageVersion,
      version: packageVersion,
      tag: latest.name,
      head,
      baseTag: latest.name,
      bump,
      commits: normalizedCommits,
    };
  }
  const version = bumpVersion(latest.version, bump);
  const tag = `v${version}`;
  if (reachableTags.some((entry) => entry.name === tag)) {
    throw planError('RELEASE_TAG_CONFLICT', `release tag ${tag} already exists`);
  }
  return {
    schemaVersion: 1,
    kind: 'release',
    release: true,
    packageName,
    currentVersion: packageVersion,
    version,
    tag,
    head,
    baseTag: latest.name,
    bump,
    commits: normalizedCommits,
  };
}

function parseCommitLog(output) {
  const commits = [];
  const pattern = /([0-9a-f]{7,64})\0([\s\S]*?)\0/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    commits.push({ hash: match[1], message: match[2].replace(/\s+$/u, '') });
  }
  return commits;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw planError('RELEASE_PACKAGE_INVALID', `${label} is not valid JSON`, { cause: cause instanceof Error ? cause.message : String(cause) });
  }
}

async function defaultGit(root, args) {
  try {
    const result = await execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (cause) {
    throw planError('RELEASE_GIT_FAILED', `git ${args.join(' ')} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function gitValue(git, root, args) {
  return String(await git(root, args)).trim();
}

export async function readReleasePlan(root = process.cwd(), { git = defaultGit, initialVersion = INITIAL_VERSION } = {}) {
  const projectRoot = resolve(root);
  const packagePath = join(projectRoot, 'package.json');
  const packageDocument = parseJson(await readFile(packagePath, 'utf8'), packagePath);
  if (!packageDocument || typeof packageDocument !== 'object' || Array.isArray(packageDocument)) throw planError('RELEASE_PACKAGE_INVALID', 'package.json must contain an object');
  if (typeof packageDocument.name !== 'string' || typeof packageDocument.version !== 'string') throw planError('RELEASE_PACKAGE_INVALID', 'package.json needs string name and version fields');
  const head = await gitValue(git, projectRoot, ['rev-parse', 'HEAD^{commit}']);
  const tagOutput = String(await git(projectRoot, ['tag', '--merged', 'HEAD', '--list', 'v*']));
  const names = tagOutput.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const tags = [];
  for (const name of names) {
    const parsed = parseReleaseTag(name);
    if (!parsed) throw planError('RELEASE_TAG_INVALID', `reachable release-looking tag is not stable vX.Y.Z: ${name}`);
    const commit = await gitValue(git, projectRoot, ['rev-parse', `${name}^{commit}`]);
    let taggedPackage;
    try {
      taggedPackage = parseJson(await git(projectRoot, ['show', `${name}:package.json`]), `${name}:package.json`);
    } catch (cause) {
      if (cause instanceof ReleasePlanError) throw cause;
      throw planError('RELEASE_TAG_PACKAGE_MISSING', `tag ${name} does not contain a readable package.json`);
    }
    tags.push({ name, version: parsed.version, commit, packageVersion: taggedPackage?.version });
  }
  const latest = normalizeTags(tags)[0];
  const range = latest ? `${latest.name}..HEAD` : 'HEAD';
  const log = await git(projectRoot, ['log', '--format=%H%x00%B%x00', range]);
  return buildReleasePlan({
    packageName: packageDocument.name,
    packageVersion: packageDocument.version,
    head,
    tags,
    commits: parseCommitLog(String(log)),
    initialVersion,
  });
}

function parseArguments(argv) {
  const result = { root: process.cwd(), json: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      result.root = argv[++index];
      if (!result.root) throw planError('RELEASE_ARGUMENT_INVALID', '--root requires a path');
    } else if (argument.startsWith('--root=')) {
      result.root = argument.slice('--root='.length);
      if (!result.root) throw planError('RELEASE_ARGUMENT_INVALID', '--root requires a path');
    } else if (argument === '--json') result.json = true;
    else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw planError('RELEASE_ARGUMENT_INVALID', `unknown argument: ${argument}`);
  }
  return result;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('usage: release-plan.mjs [--root PATH] [--dry-run] [--json]\n');
    return;
  }
  const plan = await readReleasePlan(options.root);
  process.stdout.write(`${options.json ? JSON.stringify(plan) : `TinySDD ${plan.release ? `${plan.kind} ${plan.tag}` : `no release after ${plan.baseTag}`} (bump ${plan.bump})`}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: cause?.code ?? 'RELEASE_PLAN_FAILED', message: cause instanceof Error ? cause.message : String(cause) } })}\n`);
    process.exitCode = 1;
  }
}
