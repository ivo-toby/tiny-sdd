import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  assertNoSymlinkPath,
  digestJson,
  ensureDirectory,
  normalizeProjectRelative,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import { checkRunnerAvailable, CHECK_LIMIT_DEFAULTS, runCheck } from './check-runner.mjs';
import {
  BENCHMARK_ROLES,
  BENCHMARK_UNKNOWN,
  assertRunnableBenchmarkRole,
  buildBenchmarkConfigIdentity as buildConfigIdentity,
  parseBenchmarkChallenge,
  parseBenchmarkSuite,
} from './benchmark-schema.mjs';
import { BENCHMARK_VERIFIER_STATUSES, parseBenchmarkCaseResult } from './benchmark-results.mjs';
import { writeBenchmarkResults } from './benchmark-results-writer.mjs';
import { runWorker, workerLimits } from './worker.mjs';
import { validatePiWorker } from './pi-environment.mjs';

const execFileAsync = promisify(execFile);
const RESERVED_VERIFIER_ROOT = '__tinysdd_benchmark_verifier';
const DEFAULT_CHECK_BUDGET = 12;
const MAX_CHECK_BUDGET = 20;
const CHECK_RUNNER_VERSION = 'runCheck-v1';
const PATH_FLAGS = new Set(['--require', '-r', '--import', '--loader']);
const VALUE_FLAGS = new Set(['-e', '--eval', '--input-type', '--test-name-pattern']);

function invalid(message, details = undefined) {
  throw tinyError('BENCHMARK_RUNNER_INVALID', message, details);
}

function isInside(root, candidate) {
  const escaped = relative(root, candidate);
  return escaped === '' || (escaped !== '..' && !escaped.startsWith('../') && !escaped.startsWith('/'));
}

function normalizedPath(value, label) {
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error), { field: label });
  }
}

async function realDirectory(target, label) {
  if (typeof target !== 'string' || target.length === 0 || !target.startsWith('/')) invalid(`${label} must be an absolute path`);
  const absolute = resolve(target);
  await assertNoSymlinkPath(absolute, { allowMissing: false, requireDirectory: true }).catch((error) => invalid(error.message, { field: label }));
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    invalid(`${label} is not a readable directory`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) invalid(`${label} must be a real directory`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) invalid(`${label} resolves through a symlink`);
  return absolute;
}

async function existingPath(root, value, label, { directory = false, file = false } = {}) {
  const relativePath = normalizedPath(value, label);
  const target = resolve(root, ...relativePath.split('/'));
  if (!isInside(root, target)) invalid(`${label} escapes its root`);
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: directory }).catch((error) => invalid(error.message, { field: label, causeCode: error?.code }));
  const info = await lstat(target);
  if (info.isSymbolicLink()) invalid(`${label} may not be a symlink`);
  if (directory && !info.isDirectory()) invalid(`${label} must be a directory`);
  if (file && !info.isFile()) invalid(`${label} must be a regular file`);
  return { path: relativePath, absolute: target, info };
}

async function readSuiteFile(root, ref, label) {
  const resource = await existingPath(root, ref.path, label, { file: true });
  const text = await readFile(resource.absolute, 'utf8');
  const actual = sha256(text);
  if (actual !== ref.sha256) invalid(`${label} digest does not match its declared reference`, { path: ref.path });
  return { ...resource, text, sha256: actual };
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function copyRegularTree(source, destination, label = 'tree') {
  const sourceRoot = await realDirectory(source, `${label} source`);
  await assertNoSymlinkPath(destination, { allowMissing: true, requireDirectory: false });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(destination, { allowMissing: false, requireDirectory: true });
  async function visit(from, to, prefix) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name);
      const destinationPath = join(to, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) invalid(`${label} contains a symlink`, { path: relativePath });
      if (info.isDirectory()) {
        await mkdir(destinationPath, { recursive: true, mode: 0o700 });
        await visit(sourcePath, destinationPath, relativePath);
      } else if (info.isFile()) {
        await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
        await copyFile(sourcePath, destinationPath);
      } else {
        invalid(`${label} contains an unsupported filesystem entry`, { path: relativePath });
      }
    }
  }
  await visit(sourceRoot, destination, '');
  return destination;
}

async function assertRegularTree(root, label) {
  await realDirectory(root, label);
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) invalid(`${label} contains a symlink`, { path: relativePath });
      if (info.isDirectory()) await visit(path, relativePath);
      else if (!info.isFile()) invalid(`${label} contains an unsupported filesystem entry`, { path: relativePath });
    }
  }
  await visit(root, '');
}

async function treeDigest(root) {
  const entries = [];
  async function visit(current, prefix) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) invalid('fixture contains a symlink', { path: relativePath });
      if (info.isDirectory()) {
        await visit(path, relativePath);
      } else if (info.isFile()) {
        entries.push({ path: relativePath, bytes: info.size, sha256: sha256(await readFile(path)) });
      } else {
        invalid('fixture contains an unsupported filesystem entry', { path: relativePath });
      }
    }
  }
  await visit(await realDirectory(root, 'fixture'), '');
  return { entries, sha256: digestJson(entries) };
}

async function resolveCodeRevision(root, supplied) {
  if (supplied !== undefined) return supplied;
  if (typeof root !== 'string') return BENCHMARK_UNKNOWN;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000, maxBuffer: 1024 });
    const revision = stdout.trim();
    return /^[0-9a-f]{40}$/u.test(revision) ? revision : BENCHMARK_UNKNOWN;
  } catch {
    return BENCHMARK_UNKNOWN;
  }
}

async function packageVersion() {
  try {
    const value = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof value.version === 'string' && value.version.length > 0 ? value.version : BENCHMARK_UNKNOWN;
  } catch {
    return BENCHMARK_UNKNOWN;
  }
}

function workerEffectiveLimits(worker) {
  const limits = worker?.limits && typeof worker.limits === 'object' && !Array.isArray(worker.limits) ? worker.limits : {};
  return {
    timeoutMs: Number.isInteger(limits.timeoutMs) && limits.timeoutMs > 0 ? limits.timeoutMs : workerLimits.DEFAULT_TIMEOUT_MS,
    maxToolCalls: Number.isInteger(limits.maxToolCalls) && limits.maxToolCalls > 0 ? limits.maxToolCalls : workerLimits.DEFAULT_TOOL_LIMIT,
    firstWriteMs: Object.hasOwn(limits, 'firstWriteMs') ? limits.firstWriteMs : null,
  };
}

function workerEffectiveCheckBudget(worker) {
  const value = worker?.limits?.maxCheckRuns;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CHECK_BUDGET;
}

function checkRunnerOptions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('checkRunnerOptions must be an object');
  const allowed = new Set(['bwrapPath', 'prlimitPath', 'setprivPath', 'nodeRoot', 'tempRoot', 'limits', 'runAs']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`checkRunnerOptions contains unknown key: ${key}`);
  return structuredClone(value);
}

function normalizeCheckLimits(value) {
  if (value === undefined) return { ...CHECK_LIMIT_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('checkLimits must be an object');
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(CHECK_LIMIT_DEFAULTS, key)) invalid(`checkLimits contains unknown key: ${key}`);
    if (!Number.isSafeInteger(entry) || entry < 1) invalid(`checkLimits.${key} must be a positive integer`);
  }
  return { ...CHECK_LIMIT_DEFAULTS, ...structuredClone(value) };
}

async function buildIdentity({ suite, suiteSha256, challenges, worker, profile, runtime, model, workerSettings, piVersion, tinySddVersion, codeRevision, checkBudget, checkLimits, verifierMode, suiteRoot, projectRoot, checkRunnerOptions: runnerOptions }) {
  const options = checkRunnerOptions(runnerOptions);
  const verifierAvailability = checkRunnerAvailable(options);
  const workerAvailability = runtime?.test === true && typeof runtime.checkRunner === 'function'
    ? { available: true, reason: null, testInjected: true }
    : checkRunnerAvailable();
  const effectiveLimits = workerEffectiveLimits(worker);
  const effectiveCheckBudget = workerEffectiveCheckBudget(worker);
  const effectiveCheckLimits = normalizeCheckLimits(checkLimits);
  const profileDigest = profile === undefined || profile === null ? BENCHMARK_UNKNOWN : digestJson(profile);
  const runtimeVersion = process.version;
  const code = await resolveCodeRevision(projectRoot ?? suiteRoot, codeRevision);
  const version = tinySddVersion ?? await packageVersion();
  const resolvedModel = {
    provider: worker?.provider,
    id: worker?.model,
    ...(model && typeof model === 'object' && !Array.isArray(model) ? model : {}),
  };
  const verifierConfigSha256 = digestJson({
    mode: verifierMode,
    checkLimits: effectiveCheckLimits,
    checkBudget,
    challenges: challenges.map(({ ref, resource, challenge }) => ({
      path: ref.path,
      sha256: resource.sha256,
      id: challenge.id,
      version: challenge.version,
      fixture: challenge.fixture,
      packet: challenge.packet,
      verifier: challenge.verifier,
    })),
  });
  const checkRunnerConfigSha256 = digestJson({
    version: CHECK_RUNNER_VERSION,
    limits: effectiveCheckLimits,
    availability: verifierAvailability,
    options: {
      nodeRoot: options.nodeRoot ?? null,
      runAs: options.runAs ?? null,
    },
  });
  const settings = workerSettings === undefined
    ? (runtime?.test ? { sandbox: 'test-runtime' } : BENCHMARK_UNKNOWN)
    : workerSettings;
  const identityInput = {
    model: resolvedModel,
    worker: { profileDigest, limits: effectiveLimits, settings },
    pi: { version: piVersion ?? (runtime?.test ? 'test-harness' : BENCHMARK_UNKNOWN) },
    tinySdd: { version, codeRevision: code },
    suite: { id: suite.id, version: suite.version, contentSha256: suiteSha256 },
    verifier: {
      configSha256: verifierConfigSha256,
      checkRunner: { version: CHECK_RUNNER_VERSION, configSha256: checkRunnerConfigSha256 },
    },
    runChecks: {
      declared: true,
      available: workerAvailability.available,
      budget: effectiveCheckBudget,
      unavailableReason: workerAvailability.available ? BENCHMARK_UNKNOWN : workerAvailability.reason,
      provenance: {
        source: 'worker.runtime.json',
        unavailableReason: workerAvailability.available ? BENCHMARK_UNKNOWN : workerAvailability.reason,
      },
    },
    environment: {
      runtime: process.release?.name ?? 'node',
      runtimeVersion,
      platform: process.platform,
      arch: process.arch,
    },
  };
  return { ...buildConfigIdentity(identityInput), availability: verifierAvailability, effectiveCheckLimits, checkRunnerOptions: options, workerAvailability };
}

async function loadSuite(suiteRoot, suitePath = 'suite.json') {
  const root = await realDirectory(suiteRoot, 'suite root');
  const suiteFile = await existingPath(root, suitePath, 'suite path', { file: true });
  const suiteText = await readFile(suiteFile.absolute, 'utf8');
  const suite = parseBenchmarkSuite(suiteText);
  const suiteSha256 = sha256(suiteText);
  const challenges = [];
  const ids = new Set();
  for (const ref of suite.challenges) {
    const resource = await readSuiteFile(root, ref, `challenge ${ref.path}`);
    const challenge = parseBenchmarkChallenge(resource.text);
    if (ids.has(challenge.id)) invalid(`suite contains duplicate challenge id: ${challenge.id}`);
    ids.add(challenge.id);
    challenges.push({ ref, challenge, resource });
  }
  return { root, suite, suiteSha256, suiteFile, suiteText, challenges };
}

async function loadFixture(root, challenge) {
  const resource = await existingPath(root, challenge.fixture.path, `challenge ${challenge.id} fixture`, { directory: true });
  await assertRegularTree(resource.absolute, `challenge ${challenge.id} fixture`);
  const digest = await treeDigest(resource.absolute);
  if (digest.sha256 !== challenge.fixture.sha256) invalid(`challenge ${challenge.id} fixture digest does not match its declared reference`);
  return { ...resource, treeDigest: digest };
}

async function loadPacket(root, challenge) {
  const [brief, context, checks] = await Promise.all([
    readSuiteFile(root, challenge.packet.brief, `challenge ${challenge.id} brief`),
    readSuiteFile(root, challenge.packet.context, `challenge ${challenge.id} context`),
    readSuiteFile(root, challenge.packet.checks, `challenge ${challenge.id} checks`),
  ]);
  const checksManifest = parseChecksManifest(checks.text);
  return {
    brief,
    context,
    checks,
    checksManifest,
    packet: {
      taskId: challenge.id,
      briefText: brief.text,
      briefSha256: brief.sha256,
      context: { path: `.tinysdd/tasks/${challenge.id}-context.json`, text: context.text, sha256: context.sha256 },
      checks: { path: `.tinysdd/tasks/${challenge.id}-checks.json`, text: checks.text, sha256: checks.sha256 },
      allowedPaths: challenge.packet.allowedPaths,
      protectedPaths: challenge.packet.protectedPaths,
    },
  };
}

async function loadVerifier(root, ref, challengeId, visibility) {
  const resource = await readSuiteFile(root, ref, `challenge ${challengeId} ${visibility} verifier`);
  return { resource, manifest: parseChecksManifest(resource.text) };
}

function underOrEqual(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function verifierSuffix(path) {
  return path.startsWith('verifier/') ? path.slice('verifier/'.length) : path;
}

async function resolveVerifierResource(root, manifestPath, token, label, { directory = false } = {}) {
  const candidates = [];
  const normalized = normalizedPath(token, label);
  if (normalized.startsWith('verifier/')) candidates.push(normalized);
  candidates.push(`${dirname(manifestPath).replaceAll('\\', '/')}/${normalized}`);
  candidates.push(normalized);
  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    try {
      return await existingPath(root, candidate, label, { directory, file: !directory });
    } catch (error) {
      if (error?.code === 'BENCHMARK_RUNNER_INVALID' && error.details?.causeCode === 'PATH_NOT_FOUND') continue;
      throw error;
    }
  }
  invalid(`${label} is not present in the suite`, { path: token });
}

function mountDestination(prefix, sourcePath) {
  return `${prefix}/${verifierSuffix(sourcePath)}`;
}

function rewritePathToken(token, pathMap) {
  for (const entry of pathMap) {
    if (token === entry.original || token.startsWith(`${entry.original}/`)) {
      return `${entry.destination}${token.slice(entry.original.length)}`;
    }
  }
  return token;
}

async function verifierPlan(root, manifestPath, manifest, visibility, candidateDir, packet) {
  const prefix = `${RESERVED_VERIFIER_ROOT}/${visibility}`;
  const pathMap = [];
  const files = new Map();
  const mounts = [];
  for (const mount of manifest.dependencyMounts) {
    const source = await resolveVerifierResource(root, manifestPath, mount, `${visibility} dependency mount`, { directory: true });
    await assertRegularTree(source.absolute, `${visibility} dependency mount`);
    const target = mountDestination(prefix, source.path);
    mounts.push({ source: source.absolute, target });
    pathMap.push({ original: source.path, destination: target });
  }
  for (const [index, mount] of mounts.entries()) {
    for (const other of mounts.slice(index + 1)) {
      if (underOrEqual(mount.target, other.target) || underOrEqual(other.target, mount.target)) {
        invalid(`dependency mounts overlap: ${mount.target}, ${other.target}`);
      }
    }
  }
  for (const check of manifest.checks) {
    for (let index = 1; index < check.argv.length; index += 1) {
      const argument = check.argv[index];
      const previous = check.argv[index - 1];
      const isValue = VALUE_FLAGS.has(previous) || [...PATH_FLAGS].some((flag) => previous === flag);
      if (argument.startsWith('-') && !isValue) continue;
      if (VALUE_FLAGS.has(previous)) continue;
      if (argument.startsWith('-') && !isValue) continue;
      let source;
      try {
        source = await resolveVerifierResource(root, manifestPath, argument, `${visibility} verifier file`);
      } catch (error) {
        if (argument.startsWith('-') || !/[./]/u.test(argument)) continue;
        throw error;
      }
      const destination = mountDestination(prefix, source.path);
      pathMap.push({ original: argument, destination });
      files.set(source.path, { source: source.absolute, destination });
    }
  }
  const destinations = new Map();
  for (const file of files.values()) {
    const previous = destinations.get(file.destination);
    if (previous !== undefined && previous !== file.source) {
      invalid(`verifier overlay contains duplicate destination: ${file.destination}`);
    }
    destinations.set(file.destination, file.source);
  }
  const candidatePrefix = resolve(candidateDir, ...prefix.split('/'));
  if (await pathExists(candidatePrefix)) invalid(`candidate contains reserved verifier path: ${prefix}`);
  const candidateEntries = await candidatePaths(candidateDir);
  for (const mount of mounts) {
    for (const entry of candidateEntries) {
      if (underOrEqual(mount.target, entry) || underOrEqual(entry, mount.target)) invalid(`dependency mount overlaps candidate path: ${mount.target}`);
    }
    for (const path of [...packet.allowedPaths, ...packet.protectedPaths]) {
      if (underOrEqual(mount.target, path) || underOrEqual(path, mount.target)) invalid(`dependency mount overlaps packet path: ${mount.target}`);
    }
  }
  for (const file of files.values()) {
    for (const entry of candidateEntries) {
      if (underOrEqual(file.destination, entry) || underOrEqual(entry, file.destination)) invalid(`verifier overlay collides with candidate path: ${file.destination}`);
    }
    for (const mount of mounts) {
      if (underOrEqual(mount.target, file.destination) || underOrEqual(file.destination, mount.target)) invalid(`verifier overlay overlaps dependency mount: ${file.destination}`);
    }
    const destination = resolve(candidateDir, ...file.destination.split('/'));
    await assertNoSymlinkPath(destination, { allowMissing: true, requireDirectory: false }).catch((error) => invalid(error.message));
  }
  const rewrittenChecks = manifest.checks.map((check) => ({
    id: check.id,
    timeoutMs: check.timeoutMs,
    argv: check.argv.map((argument) => rewritePathToken(argument, pathMap)),
  }));
  for (const mount of mounts) {
    const mountTarget = resolve(candidateDir, ...mount.target.split('/'));
    await assertNoSymlinkPath(mountTarget, { allowMissing: true, requireDirectory: false }).catch((error) => invalid(error.message));
  }
  return { prefix, files: [...files.values()], mounts, checks: rewrittenChecks };
}

async function candidatePaths(root) {
  const result = [];
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) invalid('candidate contains a symlink', { path: relativePath });
      result.push(relativePath);
      if (info.isDirectory()) await visit(path, relativePath);
      else if (!info.isFile()) invalid('candidate contains an unsupported filesystem entry', { path: relativePath });
    }
  }
  await visit(root, '');
  return result;
}

async function applyVerifierPlan(candidateDir, plan) {
  for (const file of plan.files) {
    const destination = resolve(candidateDir, ...file.destination.split('/'));
    if (await pathExists(destination)) invalid(`verifier overlay collides with candidate path: ${file.destination}`);
    await assertNoSymlinkPath(dirname(destination), { allowMissing: true, requireDirectory: false });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(dirname(destination), { allowMissing: false, requireDirectory: true });
    await copyFile(file.source, destination);
  }
}

function unknownVerifierRecord(checkId, definitionSha256) {
  return {
    checkId,
    definitionSha256,
    status: 'not_run',
    exitCode: BENCHMARK_UNKNOWN,
    signal: BENCHMARK_UNKNOWN,
    timedOut: BENCHMARK_UNKNOWN,
    durationMs: BENCHMARK_UNKNOWN,
    output: { ref: BENCHMARK_UNKNOWN, sha256: BENCHMARK_UNKNOWN, truncated: BENCHMARK_UNKNOWN },
    sandbox: BENCHMARK_UNKNOWN,
  };
}

function unavailableVerifierRecord(checkId, definitionSha256) {
  return {
    checkId,
    definitionSha256,
    status: 'unavailable',
    exitCode: BENCHMARK_UNKNOWN,
    signal: BENCHMARK_UNKNOWN,
    timedOut: BENCHMARK_UNKNOWN,
    durationMs: BENCHMARK_UNKNOWN,
    output: { ref: BENCHMARK_UNKNOWN, sha256: BENCHMARK_UNKNOWN, truncated: BENCHMARK_UNKNOWN },
    sandbox: BENCHMARK_UNKNOWN,
  };
}

function statusFromCheck(result) {
  return result.exitCode === 0 && result.signal === null && result.timedOut === false ? 'passed' : 'failed';
}

function normalizeInjectedVerifier(value, check, definitionSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`test verifier result for ${check.id} must be an object`);
  const status = value.status ?? statusFromCheck(value);
  if (!BENCHMARK_VERIFIER_STATUSES.includes(status)) invalid(`test verifier status is invalid: ${status}`);
  if (status === 'unavailable' || status === 'not_run') return status === 'unavailable' ? unavailableVerifierRecord(check.id, definitionSha256) : unknownVerifierRecord(check.id, definitionSha256);
  const output = value.output && typeof value.output === 'object' && !Array.isArray(value.output) ? value.output : {};
  return {
    checkId: check.id,
    definitionSha256,
    status,
    exitCode: value.exitCode ?? (status === 'passed' ? 0 : 1),
    signal: value.signal ?? null,
    timedOut: value.timedOut ?? false,
    durationMs: value.durationMs ?? 0,
    output: {
      text: typeof output.text === 'string' ? output.text : typeof value.outputText === 'string' ? value.outputText : '',
      truncated: output.truncated ?? false,
    },
    sandbox: value.sandbox ?? { runner: 'test-verifier', network: 'none' },
  };
}

async function persistVerifierOutput(root, caseRelativeDirectory, record, visibility, index) {
  if (!record.output || typeof record.output.text !== 'string') return record;
  const path = `${caseRelativeDirectory}/verifier-output-${visibility}-${index}.txt`;
  const target = join(root, ...path.split('/'));
  await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(dirname(target), { allowMissing: false, requireDirectory: true });
  const text = record.output.text;
  await writeFile(target, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    ...record,
    output: { ref: path, sha256: sha256(text), truncated: Boolean(record.output.truncated) },
  };
}

async function runVerifierGroup({ suiteRoot, manifestPath, definition, visibility, candidateSource, packet, root, caseRelativeDirectory, verifier, runtime, checkRunnerOptions, budgetState }) {
  const records = [];
  const plan = await verifierPlan(suiteRoot, manifestPath, definition.manifest, visibility, candidateSource, packet);
  await applyVerifierPlan(candidateSource, plan);
  for (let index = 0; index < plan.checks.length; index += 1) {
    const check = plan.checks[index];
    let record;
    if (budgetState.used >= budgetState.limit) {
      record = unknownVerifierRecord(check.id, definition.resource.sha256);
    } else if (verifier) {
      budgetState.used += 1;
      const injected = await verifier({
        visibility,
        check: structuredClone(check),
        originalCheck: structuredClone(definition.manifest.checks[index]),
        definition: definition.manifest,
        definitionSha256: definition.resource.sha256,
        candidateDir: candidateSource,
        dependencyMounts: structuredClone(plan.mounts),
      });
      record = normalizeInjectedVerifier(injected, check, definition.resource.sha256);
    } else {
      budgetState.used += 1;
      try {
        const result = await runCheck({
          candidateDir: candidateSource,
          check,
          dependencyMounts: plan.mounts,
          ...checkRunnerOptions,
        });
        record = {
          checkId: check.id,
          definitionSha256: definition.resource.sha256,
          status: statusFromCheck(result),
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          output: {
            text: result.output?.text ?? result.output?.tail ?? '',
            truncated: Boolean(result.output?.truncated),
          },
          sandbox: result.sandbox,
        };
      } catch (error) {
        if (error?.code === 'CHECK_RUNNER_UNAVAILABLE') record = unavailableVerifierRecord(check.id, definition.resource.sha256);
        else throw error;
      }
    }
    records.push(await persistVerifierOutput(root, caseRelativeDirectory, record, visibility, index));
  }
  return records;
}

function missingReasons(identity, extras = []) {
  const seen = new Set();
  return [...identity.missing, ...extras].filter((entry) => {
    if (!entry || typeof entry.field !== 'string' || typeof entry.reason !== 'string' || seen.has(entry.field)) return false;
    seen.add(entry.field);
    return true;
  });
}

function hardGates(challenge, workerResult) {
  if (!workerResult) return { outOfScopeEdit: false, protectedFileEdit: false, protectedTestEdit: false, requiredPatchAbsent: BENCHMARK_UNKNOWN };
  const protectedPaths = challenge.packet.protectedPaths;
  const changes = Array.isArray(workerResult.changedPaths) ? workerResult.changedPaths : [];
  const protectedEdit = changes.some((change) => protectedPaths.some((path) => underOrEqual(path, change.path) || underOrEqual(change.path, path)));
  const protectedTestEdit = changes.some((change) => protectedPaths.some((path) => (path.startsWith('test') || path.includes('/test') || /\.(?:test|spec)\./u.test(path)) && (underOrEqual(path, change.path) || underOrEqual(change.path, path))));
  const requiredPatchAbsent = workerResult.outcome === 'completed'
    ? !changes.some((change) => challenge.packet.allowedPaths.some((path) => underOrEqual(path, change.path) || underOrEqual(change.path, path)))
    : BENCHMARK_UNKNOWN;
  return {
    outOfScopeEdit: Array.isArray(workerResult.scopeViolations) && workerResult.scopeViolations.length > 0,
    protectedFileEdit: protectedEdit,
    protectedTestEdit,
    requiredPatchAbsent,
  };
}

function caseOutcome(workerResult, verifierRecords, setupError) {
  if (workerResult && workerResult.outcome !== 'completed') return workerResult.outcome;
  if (setupError || !workerResult) return 'setup_error';
  if (verifierRecords.some((record) => record.status === 'unavailable')) return 'unavailable';
  if (verifierRecords.some((record) => record.status === 'failed')) return 'failed';
  if (verifierRecords.some((record) => record.status === 'not_run')) return 'incomplete';
  return 'completed';
}

function failureFor(outcome, workerResult, verifierRecords, setupError, identity) {
  let category = BENCHMARK_UNKNOWN;
  if (workerResult && workerResult.outcome !== 'completed') category = workerResult.outcome;
  else if (setupError) category = 'setup_error';
  else if (verifierRecords.some((record) => record.status === 'failed')) category = 'verifier_failed';
  else if (verifierRecords.some((record) => record.status === 'unavailable')) category = 'verifier_unavailable';
  else if (outcome === 'incomplete') category = 'verifier_not_run';
  return { category, missing: missingReasons(identity, setupError ? [{ field: 'attempt', reason: setupError.message }] : []) };
}

async function copyEvidence(root, source, destinationRelative) {
  const target = join(root, ...destinationRelative.split('/'));
  await assertNoSymlinkPath(source, { allowMissing: false, requireDirectory: false });
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) invalid('worker evidence is not a regular file');
  await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(dirname(target), { allowMissing: false, requireDirectory: true });
  await copyFile(source, target);
  return { path: destinationRelative, sha256: sha256(await readFile(target)) };
}

async function writePacketEvidence(root, packet, destinationRelative) {
  const target = join(root, ...destinationRelative.split('/'));
  await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(dirname(target), { allowMissing: false, requireDirectory: true });
  const text = `${JSON.stringify(packet, null, 2)}\n`;
  await writeFile(target, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { path: destinationRelative, sha256: sha256(text) };
}

function verifierDefinitionNotRun(definition, checks = []) {
  return checks.map((check) => unknownVerifierRecord(check.id, definition?.resource?.sha256 ?? BENCHMARK_UNKNOWN));
}

function assertWorkerRunChecksIdentity(config, runtimeMetadata) {
  const actual = runtimeMetadata?.runChecks;
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    invalid('worker runtime metadata is missing runChecks identity');
  }
  const expected = config.identity.runChecks;
  if (actual.declared !== expected.declared || actual.available !== expected.available) {
    invalid('worker runChecks identity does not match benchmark config identity');
  }
  if (actual.available === true && actual.maxCheckRuns !== expected.budget) {
    invalid('worker runChecks budget does not match benchmark config identity');
  }
  if (actual.available === false && expected.unavailableReason !== BENCHMARK_UNKNOWN
    && actual.reason !== expected.unavailableReason) {
    invalid('worker runChecks unavailable reason does not match benchmark config identity');
  }
}

async function executeCase({ suiteInfo, challengeInfo, config, profile, worker, runtime, outputRoot, attemptId, repetition, verifier, checkRunnerOptions, checkBudget }) {
  const { root: suiteRoot, suiteSha256 } = suiteInfo;
  const { challenge, resource: challengeResource } = challengeInfo;
  const caseRelativeDirectory = `cases/${attemptId}`;
  const caseDirectory = join(outputRoot, ...caseRelativeDirectory.split('/'));
  await assertNoSymlinkPath(caseDirectory, { allowMissing: true, requireDirectory: false });
  await mkdir(caseDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(caseDirectory, { allowMissing: false, requireDirectory: true });

  let fixture;
  let fixtureWork;
  let packetInfo;
  let visibleDefinition;
  let heldOutDefinition;
  let workerResult;
  let setupError;
  let visibleRecords = [];
  let heldOutRecords = [];
  let fixtureDigest = challenge.fixture.sha256;
  const packetPayload = {
    taskId: challenge.id,
    allowedPaths: challenge.packet.allowedPaths,
    protectedPaths: challenge.packet.protectedPaths,
    brief: challenge.packet.brief,
    context: challenge.packet.context,
    checks: challenge.packet.checks,
  };
  try {
    fixture = await loadFixture(suiteRoot, challenge);
    fixtureDigest = fixture.treeDigest.sha256;
    fixtureWork = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-fixture-'));
    await copyRegularTree(fixture.absolute, fixtureWork, `challenge ${challenge.id} fixture`);
    packetInfo = await loadPacket(suiteRoot, challenge);
    packetPayload.brief = packetInfo.packet.briefText;
    packetPayload.context = packetInfo.packet.context;
    packetPayload.checks = packetInfo.packet.checks;
    visibleDefinition = await loadVerifier(suiteRoot, challenge.verifier.visible, challenge.id, 'visible');
    const caseRuntime = runtime && typeof runtime === 'object'
      ? { ...runtime, ...(runtime.test === true ? { testEnv: { ...(runtime.testEnv ?? {}), TINYSDD_TEST_CHALLENGE: challenge.id, TINYSDD_TEST_REPETITION: String(repetition) } } : {}) }
      : runtime;
    workerResult = await runWorker({
      projectRoot: fixtureWork,
      packet: packetInfo.packet,
      worker,
      profile,
      runtime: caseRuntime,
    });
  } catch (error) {
    setupError = error instanceof Error ? error : new Error(String(error));
  }

  // Held-out material is resolved only after the worker attempt has ended.
  try {
    heldOutDefinition = await loadVerifier(suiteRoot, challenge.verifier.heldOut, challenge.id, 'held-out');
  } catch (error) {
    if (!setupError) setupError = error instanceof Error ? error : new Error(String(error));
  }

  const artifacts = {};
  const packetRef = await writePacketEvidence(outputRoot, packetPayload, `${caseRelativeDirectory}/packet.json`);
  artifacts.packet = packetRef;
  if (workerResult && fixtureWork) {
    try {
      const afterSnapshot = JSON.parse(await readFile(workerResult.artifactPaths.afterSnapshot, 'utf8'));
      if (Object.values(afterSnapshot).some((entry) => entry?.kind === 'symlink')) invalid('worker candidate contains a symlink; refusing verifier overlay');
      await assertRegularTree(workerResult.artifactPaths.candidate, 'worker candidate');
      const runtimeMetadata = JSON.parse(await readFile(workerResult.artifactPaths.runtime, 'utf8'));
      assertWorkerRunChecksIdentity(config, runtimeMetadata);
      const workerResultRef = await copyEvidence(outputRoot, join(workerResult.artifactPaths.directory, 'result.json'), `${caseRelativeDirectory}/worker-result.json`);
      artifacts.result = workerResultRef;
      artifacts.candidate = await copyEvidence(outputRoot, workerResult.artifactPaths.afterSnapshot, `${caseRelativeDirectory}/candidate-snapshot.json`);
      if (workerResult.artifactPaths.runtime) artifacts.runtime = await copyEvidence(outputRoot, workerResult.artifactPaths.runtime, `${caseRelativeDirectory}/runtime.json`);
      if (workerResult.artifactPaths.patch) artifacts.patch = await copyEvidence(outputRoot, workerResult.artifactPaths.patch, `${caseRelativeDirectory}/patch.diff`);
      const budgetState = { used: 0, limit: checkBudget };
      if (visibleDefinition) {
        const evaluator = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-evaluator-'));
        try {
          const candidate = join(evaluator, 'candidate');
          await copyRegularTree(workerResult.artifactPaths.candidate, candidate, 'worker candidate');
          const records = await runVerifierGroup({ suiteRoot, manifestPath: visibleDefinition.resource.path, definition: visibleDefinition, visibility: 'visible', candidateSource: candidate, packet: challenge.packet, root: outputRoot, caseRelativeDirectory, verifier, runtime, checkRunnerOptions: config.checkRunnerOptions, budgetState });
          visibleRecords = records;
        } catch (error) {
          setupError ??= error instanceof Error ? error : new Error(String(error));
          visibleRecords = verifierDefinitionNotRun(visibleDefinition, visibleDefinition.manifest.checks);
        } finally {
          await rm(evaluator, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (heldOutDefinition) {
        const evaluator = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-evaluator-'));
        try {
          const candidate = join(evaluator, 'candidate');
          await copyRegularTree(workerResult.artifactPaths.candidate, candidate, 'worker candidate');
          const records = await runVerifierGroup({ suiteRoot, manifestPath: heldOutDefinition.resource.path, definition: heldOutDefinition, visibility: 'held-out', candidateSource: candidate, packet: challenge.packet, root: outputRoot, caseRelativeDirectory, verifier, runtime, checkRunnerOptions: config.checkRunnerOptions, budgetState });
          heldOutRecords = records;
        } catch (error) {
          setupError ??= error instanceof Error ? error : new Error(String(error));
          heldOutRecords = verifierDefinitionNotRun(heldOutDefinition, heldOutDefinition.manifest.checks);
        } finally {
          await rm(evaluator, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (error) {
      setupError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!visibleDefinition && packetInfo?.checksManifest) visibleRecords = verifierDefinitionNotRun(null, packetInfo.checksManifest.checks);

  const verifierRecords = [...visibleRecords, ...heldOutRecords];
  const outcome = caseOutcome(workerResult, verifierRecords, setupError);
  const resultArtifact = artifacts.result;
  const profileSha256 = profile === undefined || profile === null ? BENCHMARK_UNKNOWN : digestJson(profile);
  const packetSha256 = packetRef.sha256;
  const workerResultSha256 = resultArtifact?.sha256 ?? BENCHMARK_UNKNOWN;
  const caseResult = {
    schemaVersion: 1,
    suite: { id: suiteInfo.suite.id, version: suiteInfo.suite.version, sha256: suiteSha256 },
    challenge: { id: challenge.id, version: challenge.version, sha256: challengeResource.sha256 },
    role: challenge.role,
    difficultyTags: challenge.difficultyTags,
    repetition,
    attemptId,
    workerRunId: workerResult?.runId ?? BENCHMARK_UNKNOWN,
    configDigest: config.configDigest,
    configIdentity: config.identity,
    provenance: {
      type: 'benchmark-invocation',
      source: 'benchmark operator invocation',
      suiteSha256,
      packetSha256,
      profileSha256,
      workerResultSha256,
    },
    packet: {
      briefSha256: packetInfo?.brief.sha256 ?? challenge.packet.brief.sha256,
      contextSha256: packetInfo?.context.sha256 ?? challenge.packet.context.sha256,
      checksSha256: packetInfo?.checks.sha256 ?? challenge.packet.checks.sha256,
      profileSha256,
      fixtureSha256: fixtureDigest,
    },
    taskShape: workerResult?.taskShape ?? BENCHMARK_UNKNOWN,
    outcome,
    observed: workerResult?.observed === undefined || workerResult?.observed === BENCHMARK_UNKNOWN
      ? workerResult?.runChecks ?? BENCHMARK_UNKNOWN
      : { ...workerResult.observed, runChecks: workerResult.runChecks ?? BENCHMARK_UNKNOWN },
    limitDetails: workerResult?.limitDetails ?? BENCHMARK_UNKNOWN,
    changedPaths: workerResult?.changedPaths ?? [],
    scopeViolations: workerResult?.scopeViolations ?? [],
    artifacts,
    verifier: {
      visible: visibleRecords,
      heldOut: heldOutRecords,
    },
    hardGates: hardGates(challenge, workerResult),
    failure: failureFor(outcome, workerResult, verifierRecords, setupError, config.identity),
  };
  parseBenchmarkCaseResult(JSON.stringify(caseResult));
  if (fixtureWork) await rm(fixtureWork, { recursive: true, force: true }).catch(() => {});
  return caseResult;
}

/**
 * Execute an operator-selected benchmark suite without touching the source
 * project. The optional verifier callback is accepted only by the explicit
 * worker test runtime; production runs use runCheck.
 */
export async function runBenchmark({
  projectRoot,
  suiteRoot,
  suitePath = 'suite.json',
  repeat,
  worker,
  profile = null,
  runtime,
  verifier,
  outputRoot,
  invocationId = `invocation-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  model,
  workerSettings,
  piVersion,
  tinySddVersion,
  codeRevision,
  maxCheckRuns = DEFAULT_CHECK_BUDGET,
  checkLimits,
  checkRunnerOptions,
} = {}) {
  if (verifier !== undefined && (typeof verifier !== 'function' || runtime?.test !== true)) {
    invalid('test verifier injection requires runtime.test === true');
  }
  if (typeof suiteRoot !== 'string') invalid('suiteRoot is required');
  const suiteInfo = await loadSuite(suiteRoot, suitePath);
  const selectedRepeat = repeat ?? suiteInfo.suite.defaults.repeat;
  if (!Number.isInteger(selectedRepeat) || selectedRepeat < 1 || selectedRepeat > 1000) invalid('repeat must be an integer from 1 to 1000');
  if (!Number.isInteger(maxCheckRuns) || maxCheckRuns < 1 || maxCheckRuns > MAX_CHECK_BUDGET) invalid(`maxCheckRuns must be an integer from 1 to ${MAX_CHECK_BUDGET}`);
  for (const { challenge } of suiteInfo.challenges) {
    if (!BENCHMARK_ROLES.includes(challenge.role)) invalid(`unsupported benchmark role: ${challenge.role}`);
    assertRunnableBenchmarkRole(challenge.role);
  }
  if (!worker || worker.type !== 'pi') invalid('benchmark runner supports only the pi worker adapter');
  try {
    validatePiWorker(worker);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  const config = await buildIdentity({ suite: suiteInfo.suite, suiteSha256: suiteInfo.suiteSha256, challenges: suiteInfo.challenges, worker, profile, runtime, model, workerSettings, piVersion, tinySddVersion, codeRevision, checkBudget: maxCheckRuns, checkLimits, verifierMode: verifier ? 'test-injection' : 'runCheck', suiteRoot: suiteInfo.root, projectRoot, checkRunnerOptions });
  const root = resolve(outputRoot ?? join(projectRoot ?? suiteInfo.root, '.tinysdd', 'bench', suiteInfo.suite.id, invocationId));
  await assertNoSymlinkPath(root, { allowMissing: true, requireDirectory: false });
  if (await pathExists(root)) invalid(`benchmark invocation output already exists: ${root}`);
  await ensureDirectory(root);
  const startedAt = new Date().toISOString();
  const cases = [];
  for (const challengeInfo of suiteInfo.challenges) {
    for (let repetition = 1; repetition <= selectedRepeat; repetition += 1) {
      const attemptId = `${challengeInfo.challenge.id}-repeat-${repetition}`;
      cases.push(await executeCase({ suiteInfo, challengeInfo, config, profile, worker, runtime, outputRoot: root, attemptId, repetition, verifier, checkRunnerOptions: config.checkRunnerOptions, checkBudget: maxCheckRuns }));
    }
  }
  const completedAt = new Date().toISOString();
  const result = await writeBenchmarkResults({
    outputRoot: root,
    invocationId,
    suite: { id: suiteInfo.suite.id, version: suiteInfo.suite.version, sha256: suiteInfo.suiteSha256 },
    configDigest: config.configDigest,
    configIdentity: config.identity,
    worker: { name: worker.name ?? 'benchmark-worker', profileSha256: config.identity.worker.profileDigest },
    repeat: selectedRepeat,
    startedAt,
    completedAt,
    cases,
  });
  return {
    ...result,
    suite: suiteInfo.suite,
    config: { identity: config.identity, configDigest: config.configDigest, checkRunner: config.availability },
  };
}

export const runBenchmarkSuite = runBenchmark;
export const executeBenchmark = runBenchmark;
export { treeDigest as benchmarkFixtureDigest };
export { RESERVED_VERIFIER_ROOT };
