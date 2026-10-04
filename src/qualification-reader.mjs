import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import {
  assertNoSymlinkPath,
  canonicalProjectRoot,
  normalizeProjectRelative,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import {
  parseBenchmarkCaseResult,
  parseBenchmarkInvocation,
  parseBenchmarkSummary,
} from './benchmark-results.mjs';
import {
  parseBenchmarkChallenge,
  benchmarkConfigDigest,
  parseBenchmarkSuite,
} from './benchmark-schema.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import {
  aggregateBenchmarkObservations,
  buildQualificationRecord,
} from './qualification.mjs';
import { readQualificationEvidenceIndex } from './qualification-store.mjs';

export const QUALIFICATION_READ_MAX_BYTES = 4 * 1024 * 1024;

function invalid(message, details = undefined) {
  throw tinyError('QUALIFICATION_READ_INVALID', message, details);
}

function projectPath(value, label) {
  try {
    return normalizeProjectRelative(value, label, { tinysddArtifactPrefix: '.tinysdd/' });
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { field: label });
  }
}

function inside(root, target, label) {
  const escaped = relative(root, target);
  if (escaped === '..' || escaped.startsWith('../') || escaped.startsWith('/')) invalid(`${label} escapes the project root`);
  return target;
}

async function regularFile(target, label, maxBytes) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    invalid(`${label} is not readable`, { causeCode: error?.code });
  }
  if (info.isSymbolicLink()) invalid(`${label} may not be a symlink`);
  if (!info.isFile()) invalid(`${label} must be a regular file`);
  if (info.size > maxBytes) invalid(`${label} exceeds the ${maxBytes}-byte read limit`);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    invalid(`${label} could not be read`, { causeCode: error?.code });
  }
  if (bytes.byteLength > maxBytes) invalid(`${label} exceeds the ${maxBytes}-byte read limit`);
  return { bytes, text: bytes.toString('utf8'), sha256: sha256(bytes) };
}

async function projectFile(root, path, label, maxBytes) {
  const normalized = projectPath(path, label);
  const target = resolve(root, ...normalized.split('/'));
  inside(root, target, label);
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: label }));
  return { ...await regularFile(target, label, maxBytes), path: normalized, absolute: target };
}

async function suiteFile(suiteRoot, path, label, maxBytes) {
  const normalized = projectPath(path, label);
  const target = resolve(suiteRoot, ...normalized.split('/'));
  inside(suiteRoot, target, label);
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: label }));
  return { ...await regularFile(target, label, maxBytes), path: normalized, absolute: target };
}

function equalRef(left, right) {
  return left.path === right.path && left.sha256 === right.sha256;
}

function equalSuite(left, right) {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

function checkRoster(manifest, definitionSha256) {
  return manifest.checks.map((check) => ({ id: check.id, definitionSha256 }));
}

async function readRoster(projectRoot, suitePath, maxBytes) {
  const suiteResource = await projectFile(projectRoot, suitePath, 'suite path', maxBytes);
  const suite = parseBenchmarkSuite(suiteResource.text);
  const suiteRoot = dirname(suiteResource.absolute);
  const suiteReference = { id: suite.id, version: suite.version, sha256: suiteResource.sha256 };
  const challenges = [];
  const challengeById = new Map();
  for (const ref of suite.challenges) {
    const challengeResource = await suiteFile(suiteRoot, ref.path, `challenge ${ref.path}`, maxBytes);
    if (challengeResource.sha256 !== ref.sha256) invalid(`challenge ${ref.path} digest does not match its suite reference`);
    const challenge = parseBenchmarkChallenge(challengeResource.text);
    if (challengeById.has(challenge.id)) invalid(`suite contains duplicate challenge id: ${challenge.id}`);
    const readDefinition = async (definition, visibility) => {
      const resource = await suiteFile(suiteRoot, definition.path, `challenge ${challenge.id} ${visibility} verifier`, maxBytes);
      if (resource.sha256 !== definition.sha256) invalid(`challenge ${challenge.id} ${visibility} verifier digest does not match its reference`);
      const manifest = parseChecksManifest(resource.text);
      return checkRoster(manifest, resource.sha256);
    };
    const entry = {
      id: challenge.id,
      version: challenge.version,
      sha256: challengeResource.sha256,
      role: challenge.role,
      visible: await readDefinition(challenge.verifier.visible, 'visible'),
      heldOut: await readDefinition(challenge.verifier.heldOut, 'held-out'),
    };
    challengeById.set(entry.id, entry);
    challenges.push(entry);
  }
  return { suite: suiteReference, challenges, suitePath: suiteResource.path, suiteRoot };
}

function invocationPath(root, input, label) {
  const normalized = projectPath(input, label);
  const target = resolve(root, ...normalized.split('/'));
  inside(root, target, label);
  return { path: normalized, absolute: target };
}

async function readInvocation(projectRoot, inputPath, roster, maxBytes) {
  const requested = invocationPath(projectRoot, inputPath, 'benchmark results path');
  let target = requested.absolute;
  let normalizedPath = requested.path;
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: 'benchmark results path' }));
  const info = await lstat(target).catch((error) => invalid('benchmark results path is not readable', { causeCode: error?.code }));
  if (info.isDirectory()) {
    normalizedPath = `${normalizedPath}/invocation.json`;
    target = join(target, 'invocation.json');
    inside(projectRoot, target, 'benchmark results path');
    await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: 'benchmark results path' }));
  } else if (!info.isFile()) {
    invalid('benchmark results path must be an invocation directory or invocation.json');
  }
  const invocationResource = await regularFile(target, `benchmark invocation ${normalizedPath}`, maxBytes);
  const invocation = parseBenchmarkInvocation(invocationResource.text);
  const invocationRoot = dirname(target);
  const invocationRecord = {
    invocation,
    path: normalizedPath,
    absolute: target,
    sha256: invocationResource.sha256,
  };
  if (!equalSuite(invocation.suite, roster.suite)) invalid(`benchmark invocation ${invocation.invocationId} does not match the selected suite`);
  const expectedByChallenge = new Map(roster.challenges.map((challenge) => [challenge.id, challenge]));
  const seen = new Set();
  const observations = [];
  const caseRefs = new Set();
  for (const ref of invocation.caseResults) {
    const casePath = resolve(invocationRoot, ...ref.path.split('/'));
    inside(projectRoot, casePath, `benchmark case ${ref.path}`);
    await assertNoSymlinkPath(casePath, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: `benchmark case ${ref.path}` }));
    const caseResource = await regularFile(casePath, `benchmark case ${ref.path}`, maxBytes);
    if (caseResource.sha256 !== ref.sha256) invalid(`benchmark case ${ref.path} digest does not match its invocation reference`);
    const caseResult = parseBenchmarkCaseResult(caseResource.text);
    if (!equalSuite(caseResult.suite, roster.suite)) invalid(`benchmark case ${caseResult.attemptId} does not match the selected suite`);
    if (caseResult.configDigest !== invocation.configDigest) invalid(`benchmark case ${caseResult.attemptId} does not match its invocation config`);
    if (benchmarkConfigDigest(caseResult.configIdentity) !== benchmarkConfigDigest(invocation.configIdentity)) invalid(`benchmark case ${caseResult.attemptId} config identity does not match its invocation`);
    const challenge = expectedByChallenge.get(caseResult.challenge.id);
    if (challenge === undefined
      || caseResult.challenge.version !== challenge.version
      || caseResult.challenge.sha256 !== challenge.sha256
      || caseResult.role !== challenge.role) {
      invalid(`benchmark case ${caseResult.attemptId} is not declared by the selected suite`);
    }
    if (caseResult.repetition < 1 || caseResult.repetition > invocation.repeat) invalid(`benchmark case ${caseResult.attemptId} repetition is outside the invocation repeat count`);
    const coverageKey = `${caseResult.challenge.id}\0${caseResult.repetition}`;
    if (seen.has(coverageKey)) invalid(`benchmark invocation contains duplicate challenge/repetition: ${coverageKey.replaceAll('\0', '/')}`);
    seen.add(coverageKey);
    const assertChecks = (actual, expected, visibility) => {
      if (actual.length !== expected.length) invalid(`benchmark case ${caseResult.attemptId} ${visibility} checks do not match the suite roster`);
      const expectedById = new Map(expected.map((check) => [check.id, check.definitionSha256]));
      const actualIds = new Set();
      for (const check of actual) {
        if (actualIds.has(check.checkId) || !expectedById.has(check.checkId)) invalid(`benchmark case ${caseResult.attemptId} ${visibility} checks do not match the suite roster`);
        actualIds.add(check.checkId);
        if (check.definitionSha256 !== expectedById.get(check.checkId)) invalid(`benchmark case ${caseResult.attemptId} ${visibility} check definition changed`);
      }
    };
    assertChecks(caseResult.verifier.visible, challenge.visible, 'visible');
    assertChecks(caseResult.verifier.heldOut, challenge.heldOut, 'held-out');
    const caseRelative = relative(projectRoot, casePath).replaceAll('\\', '/');
    observations.push({
      caseResult,
      invocationId: invocation.invocationId,
      source: { path: caseRelative, sha256: caseResource.sha256 },
    });
    caseRefs.add(`${caseRelative}\0${caseResource.sha256}`);
  }
  const expectedCount = roster.challenges.length * invocation.repeat;
  if (seen.size !== expectedCount) invalid(`benchmark invocation ${invocation.invocationId} does not contain every challenge repetition`);
  const summaryPath = resolve(invocationRoot, ...invocation.summary.path.split('/'));
  inside(projectRoot, summaryPath, `benchmark summary ${invocation.summary.path}`);
  await assertNoSymlinkPath(summaryPath, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: `benchmark summary ${invocation.summary.path}` }));
  const summaryResource = await regularFile(summaryPath, `benchmark summary ${invocation.summary.path}`, maxBytes);
  if (summaryResource.sha256 !== invocation.summary.sha256) invalid(`benchmark summary ${invocation.invocationId} digest does not match its invocation reference`);
  const summary = parseBenchmarkSummary(summaryResource.text);
  if (!equalSuite(summary.suite, roster.suite) || summary.configDigest !== invocation.configDigest) invalid(`benchmark summary ${invocation.invocationId} does not match its invocation`);
  const summaryRefs = summary.groups.flatMap((group) => group.caseResults).map((ref) => `${ref.path}\0${ref.sha256}`);
  const invocationRefs = invocation.caseResults.map((ref) => `${ref.path}\0${ref.sha256}`);
  if (summaryRefs.length !== invocationRefs.length || new Set(summaryRefs).size !== summaryRefs.length
    || summaryRefs.some((ref) => !invocationRefs.includes(ref))) invalid(`benchmark summary ${invocation.invocationId} case references do not match its invocation`);
  return { ...invocationRecord, observations, caseRefs: [...caseRefs], summary };
}

async function readInvocationHeader(projectRoot, inputPath, maxBytes) {
  const requested = invocationPath(projectRoot, inputPath, 'benchmark results path');
  let target = requested.absolute;
  let normalizedPath = requested.path;
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: 'benchmark results path' }));
  const info = await lstat(target).catch((error) => invalid('benchmark results path is not readable', { causeCode: error?.code }));
  if (info.isDirectory()) {
    normalizedPath = `${normalizedPath}/invocation.json`;
    target = join(target, 'invocation.json');
    inside(projectRoot, target, 'benchmark results path');
    await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false }).catch((error) => invalid(error.message, { field: 'benchmark results path' }));
  } else if (!info.isFile()) {
    invalid('benchmark results path must be an invocation directory or invocation.json');
  }
  const resource = await regularFile(target, `benchmark invocation ${normalizedPath}`, maxBytes);
  return { invocation: parseBenchmarkInvocation(resource.text), path: normalizedPath, sha256: resource.sha256 };
}

function sameInvocation(left, right) {
  return left.sha256 === right.sha256
    && left.invocation.configDigest === right.invocation.configDigest
    && benchmarkConfigDigest(left.invocation.configIdentity) === benchmarkConfigDigest(right.invocation.configIdentity);
}

/** Read and validate immutable benchmark evidence without executing a worker or check runner. */
export async function readQualificationEvidence({ projectRoot, results, resultPaths, suite, suitePath, configDigest, maxBytes = QUALIFICATION_READ_MAX_BYTES } = {}) {
  const root = await canonicalProjectRoot(projectRoot ?? process.cwd());
  const inputs = results ?? resultPaths;
  if (!Array.isArray(inputs) || inputs.length === 0) invalid('qualification results must contain at least one invocation path');
  if (typeof suitePath !== 'string' || suitePath.length === 0) invalid('qualification suite path is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid('qualification maxBytes must be a positive safe integer');
  const roster = await readRoster(root, suitePath, maxBytes);
  const invocations = [];
  const byId = new Map();
  const duplicates = [];
  for (const input of inputs) {
    if (typeof input !== 'string' || input.length === 0) invalid('qualification results paths must be nonempty strings');
    const current = await readInvocation(root, input, roster, maxBytes);
    if (configDigest !== undefined && current.invocation.configDigest !== configDigest) continue;
    const previous = byId.get(current.invocation.invocationId);
    if (previous !== undefined) {
      if (!sameInvocation(previous, current)) invalid(`invocationId ${current.invocation.invocationId} is bound to different evidence`);
      duplicates.push(current.path);
      continue;
    }
    byId.set(current.invocation.invocationId, current);
    invocations.push(current);
  }
  const observations = invocations.flatMap(({ observations: entries }) => entries);
  const source = {
    invocations: invocations.map(({ path, sha256: contentSha256 }) => ({ path, sha256: contentSha256 })),
    cases: observations.map(({ source: ref }) => ref),
  };
  const aggregate = aggregateBenchmarkObservations(observations);
  return {
    projectRoot: root,
    suite: aggregate.suite ?? roster.suite,
    configIdentity: aggregate.configIdentity,
    configDigest: aggregate.configDigest,
    roster: {
      suite: roster.suite,
      challenges: roster.challenges,
      invocations: invocations.map(({ invocation, path, sha256: contentSha256 }) => ({
        invocationId: invocation.invocationId,
        path,
        sha256: contentSha256,
        repeat: invocation.repeat,
        expected: roster.challenges.map((challenge) => ({
          challengeId: challenge.id,
          repetitions: Array.from({ length: invocation.repeat }, (_, index) => index + 1),
        })),
      })),
    },
    source,
    observations,
    invocations: invocations.map(({ invocation, path, sha256: contentSha256 }) => ({ invocationId: invocation.invocationId, path, sha256: contentSha256 })),
    duplicateInputs: duplicates,
  };
}

async function discoverRetainedInvocationPaths(root, suiteId) {
  const relativeRoot = `.tinysdd/bench/${suiteId}`;
  const absoluteRoot = resolve(root, ...relativeRoot.split('/'));
  try {
    await assertNoSymlinkPath(absoluteRoot, { allowMissing: false, requireDirectory: true });
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') return [];
    invalid(error instanceof Error ? error.message : String(error), { field: relativeRoot });
  }
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    invalid(`qualification benchmark results directory is not readable`, { causeCode: error?.code });
  }
  const paths = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) invalid(`qualification benchmark results entry may not be a symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const invocationPath = `${relativeRoot}/${entry.name}/invocation.json`;
    const target = resolve(root, ...invocationPath.split('/'));
    try {
      await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false });
    } catch (error) {
      if (error?.code === 'PATH_NOT_FOUND') continue;
      invalid(error instanceof Error ? error.message : String(error), { field: invocationPath });
    }
    const info = await lstat(target).catch((error) => invalid('qualification benchmark invocation is not readable', { causeCode: error?.code }));
    if (!info.isFile() || info.isSymbolicLink()) invalid(`qualification benchmark invocation must be a regular file: ${invocationPath}`);
    paths.push(invocationPath);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

/** Read every retained invocation for one exact current config digest and suite. */
export async function readQualificationEvidencePool({ projectRoot, suitePath, configDigest, results = [], maxBytes = QUALIFICATION_READ_MAX_BYTES } = {}) {
  if (typeof configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(configDigest)) invalid('qualification configDigest must be a lowercase SHA-256 digest');
  const root = await canonicalProjectRoot(projectRoot ?? process.cwd());
  if (typeof suitePath !== 'string' || suitePath.length === 0) invalid('qualification suite path is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid('qualification maxBytes must be a positive safe integer');
  const roster = await readRoster(root, suitePath, maxBytes);
  const index = await readQualificationEvidenceIndex(root);
  const registered = index.entries.filter((entry) => entry.configDigest === configDigest && equalSuite(entry.suite, roster.suite));
  const candidatePaths = new Set(await discoverRetainedInvocationPaths(root, roster.suite.id));
  for (const entry of registered) candidatePaths.add(entry.invocation.path);
  for (const input of results) {
    if (typeof input !== 'string' || input.length === 0) invalid('qualification results paths must be nonempty strings');
    candidatePaths.add(projectPath(input, 'benchmark results path'));
  }
  if (candidatePaths.size === 0) invalid(`no retained benchmark invocations exist for configDigest ${configDigest}`);

  // Validate registered paths before filtering by digest so a changed or
  // missing artifact cannot silently disappear from cumulative evidence.
  for (const entry of registered) {
    const observed = await readQualificationEvidence({
      projectRoot: root,
      results: [entry.invocation.path],
      suitePath,
      maxBytes,
    });
    const invocation = observed.invocations[0];
    if (invocation === undefined
      || invocation.invocationId !== entry.invocationId
      || invocation.path !== entry.invocation.path
      || invocation.sha256 !== entry.invocation.sha256
      || observed.configDigest !== entry.configDigest
      || !equalSuite(observed.suite, entry.suite)) {
      invalid(`registered qualification invocation changed: ${entry.invocationId}`);
    }
  }
  const registeredPaths = new Set(registered.map((entry) => entry.invocation.path));
  const paths = new Set();
  for (const path of candidatePaths) {
    if (registeredPaths.has(path)) {
      paths.add(path);
      continue;
    }
    const header = await readInvocationHeader(root, path, maxBytes);
    if (header.invocation.configDigest === configDigest && equalSuite(header.invocation.suite, roster.suite)) paths.add(path);
  }
  if (paths.size === 0) invalid(`no retained benchmark invocations exist for configDigest ${configDigest}`);
  const evidence = await readQualificationEvidence({
    projectRoot: root,
    results: [...paths].sort((left, right) => left.localeCompare(right)),
    suitePath,
    configDigest,
    maxBytes,
  });
  if (evidence.invocations.length === 0) invalid(`no retained benchmark invocations exist for configDigest ${configDigest}`);
  return {
    ...evidence,
    pool: true,
    registeredInputs: registered.map((entry) => entry.invocation.path),
  };
}

export async function buildQualificationRecordFromResults(options = {}) {
  const evidence = await readQualificationEvidence(options);
  return buildQualificationRecord({
    observations: evidence.observations,
    source: evidence.source,
    roster: evidence.roster,
    configIdentity: evidence.configIdentity,
    configDigest: evidence.configDigest,
    suite: evidence.suite,
    targets: options.targets ?? options.target,
  });
}
