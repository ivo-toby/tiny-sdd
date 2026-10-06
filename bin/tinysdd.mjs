#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { lstat, readFile, unlink } from 'node:fs/promises';

import {
  addTask,
  applyTask,
  approveTask,
  acceptFeature,
  closeTask,
  configShow,
  configValidate,
  controllerNext,
  controllerStatus,
  dispatchWorker,
  initProject,
  publicError,
  resolveBenchmarkPacket,
  resolveTaskPacket,
  reviewTask,
  reportFeature,
  recordPhase,
  phaseStatus,
  advancePhase,
  supersedeTask,
  updateTask,
} from '../src/controller.mjs';
import { assertInternalPath, atomicWriteJson, canonicalProjectRoot, ensureDirectory, normalizeProjectRelative, readJsonFile, tinyError } from '../src/fs-utils.mjs';
import { appendUsageRecord, importUsageRecords, USAGE_LEDGER_MAX_BYTES } from '../src/usage.mjs';
import { isFailedWorkerOutcome } from '../src/outcomes.mjs';
import { checkRunnerAvailable } from '../src/check-runner.mjs';
import { preflightPiWorker } from '../src/pi-environment.mjs';
import { inspectBenchmarkIdentity, runBenchmark } from '../src/benchmark-runner.mjs';
import { assessQualification, resolveBenchmarkSuite as resolveCurrentBenchmarkSuite } from '../src/qualification-dispatch.mjs';
import { BENCHMARK_ROLES } from '../src/benchmark-schema.mjs';
import { reportSliceTestReviews } from '../src/slice-test-review-report.mjs';
import { readQualificationEvidence, readQualificationEvidencePool } from '../src/qualification-reader.mjs';
import {
  compareQualificationApplicability,
  accumulateQualificationRecord,
  readQualificationRecord,
  replaceQualificationRecord,
} from '../src/qualification-store.mjs';
import { buildQualificationRecord, rescoreQualificationRecord } from '../src/qualification.mjs';

const VERSION = '0.1.0';
const HELP = `TinySDD ${VERSION}

Usage:
  tinysdd [--json] [--project PATH] init [--worker NAME --provider ID --model ID]
  tinysdd [--json] [--project PATH] config show|validate [--worker NAME]
  tinysdd [--json] [--project PATH] status [--feature NAME]
  tinysdd [--json] [--project PATH] next
  tinysdd [--json] [--project PATH] task add --id ID --brief PATH --allow FILE[,FILE] [--context PATH] [--checks PATH] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]] [--feature NAME]
  tinysdd [--json] [--project PATH] task update --id ID --by LABEL --reason TEXT [--brief PATH] [--context PATH] [--checks PATH] [--allow FILE[,FILE]] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]]
  tinysdd [--json] [--project PATH] task approve --id ID --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] task packet --id ID
  tinysdd [--json] [--project PATH] task apply --id ID --run RUN_ID --by LABEL
  tinysdd [--json] [--project PATH] task review --id ID --verdict accepted|revision|blocked --evidence PATH --by LABEL [--candidate-paths FILE[,FILE]]
  tinysdd [--json] [--project PATH] task close --id ID --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] task supersede --id ID --with ID[,ID] --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] worker run --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker start --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker status --id LAUNCH_ID
  tinysdd [--json] [--project PATH] worker stop --id LAUNCH_ID [--wait-ms N]
  tinysdd [--json] [--project PATH] bench run --worker NAME [--suite PATH] [--repeat K]
  tinysdd [--json] [--project PATH] bench qualify --results PATH[,PATH] [--suite PATH] [--worker NAME] [--target ROLE=NUMBER,...]
  tinysdd [--json] [--project PATH] bench rescore --record PATH [--target ROLE=NUMBER,...]
  tinysdd [--json] [--project PATH] bench qualification show --record PATH [--suite PATH] [--worker NAME]
  tinysdd [--json] [--project PATH] usage record --phase PHASE --model MODEL --input N --output N [--reasoning N] [--cache-read N] [--cache-write N] [--total N] [--task ID] [--feature NAME]
  tinysdd [--json] [--project PATH] usage import --file PATH
  tinysdd [--json] [--project PATH] usage report --feature NAME
  tinysdd [--json] [--project PATH] feature accept --feature NAME --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] feature report --feature NAME
  tinysdd [--json] [--project PATH] slice-tests report [--feature NAME]
  tinysdd [--json] [--project PATH] phase record|research --phase research --feature NAME --proposal PATH --context PATH --by LABEL --reason TEXT [--predecessor ID]
  tinysdd [--json] [--project PATH] phase status --feature NAME
  tinysdd [--json] [--project PATH] phase advance --from research --to plan --feature NAME --by LABEL --reason TEXT [--record ID]

Usage phases: specify, research, plan, slice, write-tests, review, rescue.

Retired (closed or superseded) tasks leave \`next\`, cannot be approved, reviewed or
dispatched, and are refused while open tasks depend on them.
\`task update\` keeps shape history and requires explicit reapproval after bound
inputs change. Accepted tasks cannot be updated; \`task supersede\` still refuses
a current acceptance and open dependents.
Workers return isolated candidates and patches; they never apply or accept them.
\`task apply\` copies a reviewed run's retained eligible actual files into the project and records the
run; apply before \`task review\`, because acceptance binds the project's files.
Use \`worker start\` for real model calls from an agent: it detaches the controller
from short-lived interactive shells. Poll it with \`worker status\`.
Stopping a launch with \`worker stop\` finalizes the run with outcome \`stopped\`,
keeping its evidence and candidate.
Use --json for machine-readable results, including failed worker evidence.
Feature acceptance requires featureIntegration in .tinysdd/config.json; TinySDD
executes that typed command through the host check runner before recording an event.
`;

function cliError(message, code = 'INVALID_ARGUMENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function extractGlobals(argv) {
  const args = [];
  let json = false;
  let help = false;
  let version = false;
  let project = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--project') {
      if (argv[index + 1] === undefined) throw cliError('--project requires a path');
      project = argv[++index];
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      if (!project) throw cliError('--project requires a path');
    } else {
      args.push(arg);
    }
  }
  return { args, json, help, version, project };
}

function parseFlags(tokens, allowed) {
  const values = {};
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    if (!allowed.has(name)) throw cliError(`unknown option: --${name}`);
    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      if (tokens[index + 1] === undefined || tokens[index + 1].startsWith('--')) throw cliError(`--${name} requires a value`);
      value = tokens[++index];
    }
    if (allowed.get(name) === 'list') {
      values[name] = [...(values[name] ?? []), ...String(value).split(',').filter((item) => item.length > 0)];
    } else {
      values[name] = value;
    }
  }
  return { values, positional };
}

function parseCommand(args) {
  if (args.length === 0) throw cliError('a command is required');
  const [command, subcommand, ...rest] = args;
  if (command === 'init') {
    const { values, positional } = parseFlags([subcommand, ...rest].filter((value) => value !== undefined), new Map([
      ['worker', 'value'], ['provider', 'value'], ['model', 'value'],
    ]));
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, values };
  }
  if (command === 'config') {
    if (!['show', 'validate'].includes(subcommand)) throw cliError('config requires show or validate');
    const { values, positional } = parseFlags(rest, new Map([['worker', 'value']]));
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'task') {
    if (!['add', 'update', 'approve', 'packet', 'apply', 'review', 'close', 'supersede'].includes(subcommand)) throw cliError('task requires add, update, approve, packet, apply, review, close, or supersede');
    const allowedByCommand = {
      add: new Map([['id', 'value'], ['brief', 'value'], ['context', 'value'], ['checks', 'value'], ['depends-on', 'list'], ['allow', 'list'], ['protect', 'list'], ['preparation', 'list'], ['feature', 'value']]),
      update: new Map([['id', 'value'], ['by', 'value'], ['reason', 'value'], ['brief', 'value'], ['context', 'value'], ['checks', 'value'], ['allow', 'list'], ['protect', 'list'], ['preparation', 'list'], ['depends-on', 'list']]),
      approve: new Map([['id', 'value'], ['by', 'value'], ['reason', 'value']]),
      packet: new Map([['id', 'value']]),
      apply: new Map([['id', 'value'], ['run', 'value'], ['by', 'value']]),
      review: new Map([['id', 'value'], ['by', 'value'], ['verdict', 'value'], ['evidence', 'value'], ['candidate-paths', 'list']]),
      close: new Map([['id', 'value'], ['by', 'value'], ['reason', 'value']]),
      supersede: new Map([['id', 'value'], ['with', 'list'], ['by', 'value'], ['reason', 'value']]),
    };
    const allowed = allowedByCommand[subcommand];
    const { values, positional } = parseFlags(rest, allowed);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'worker') {
    if (!['run', 'start', 'status', 'stop'].includes(subcommand)) throw cliError('worker requires run, start, status, or stop');
    const allowedBySubcommand = {
      status: new Map([['id', 'value']]),
      stop: new Map([['id', 'value'], ['wait-ms', 'value']]),
    };
    const allowed = allowedBySubcommand[subcommand]
      ?? new Map([['task', 'value'], ['worker', 'value'], ['base-run', 'value'], ['baseline-run', 'value']]);
    const { values, positional } = parseFlags(rest, allowed);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    if (subcommand === 'stop') values['wait-ms'] = parseWaitMs(values['wait-ms']);
    return { command, subcommand, values };
  }
  if (command === 'bench') {
    if (subcommand === 'qualification') {
      const [action, ...actionRest] = rest;
      if (action !== 'show') throw cliError('bench qualification requires show');
      const { values, positional } = parseFlags(actionRest, new Map([
        ['record', 'value'], ['suite', 'value'], ['worker', 'value'],
      ]));
      if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
      return { command, subcommand, action, values };
    }
    if (!['run', 'qualify', 'rescore'].includes(subcommand)) throw cliError('bench requires run, qualify, or rescore');
    const allowedBySubcommand = {
      run: new Map([['worker', 'value'], ['suite', 'value'], ['repeat', 'value']]),
      qualify: new Map([['results', 'list'], ['suite', 'value'], ['worker', 'value'], ['target', 'list']]),
      rescore: new Map([['record', 'value'], ['target', 'list']]),
    };
    const { values, positional } = parseFlags(rest, allowedBySubcommand[subcommand]);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'usage') {
    if (!['record', 'import', 'report'].includes(subcommand)) throw cliError('usage requires record, import, or report');
    const allowedBySubcommand = {
      record: new Map([
        ['phase', 'value'], ['model', 'value'], ['input', 'value'], ['output', 'value'],
        ['reasoning', 'value'], ['cache-read', 'value'], ['cache-write', 'value'], ['total', 'value'],
        ['task', 'value'], ['feature', 'value'],
      ]),
      import: new Map([['file', 'value']]),
      report: new Map([['feature', 'value']]),
    };
    const { values, positional } = parseFlags(rest, allowedBySubcommand[subcommand]);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'feature') {
    if (!['accept', 'report'].includes(subcommand)) throw cliError('feature requires accept or report');
    const allowed = subcommand === 'accept'
      ? new Map([['feature', 'value'], ['by', 'value'], ['reason', 'value']])
      : new Map([['feature', 'value']]);
    const { values, positional } = parseFlags(rest, allowed);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'phase') {
    if (!['record', 'research', 'status', 'advance'].includes(subcommand)) throw cliError('phase requires record, research, status, or advance');
    const allowedBySubcommand = {
      record: new Map([['phase', 'value'], ['feature', 'value'], ['proposal', 'value'], ['context', 'value'], ['by', 'value'], ['reason', 'value'], ['predecessor', 'value'], ['worker', 'value']]),
      research: new Map([['phase', 'value'], ['feature', 'value'], ['proposal', 'value'], ['context', 'value'], ['by', 'value'], ['reason', 'value'], ['predecessor', 'value'], ['worker', 'value']]),
      status: new Map([['feature', 'value'], ['worker', 'value']]),
      advance: new Map([['from', 'value'], ['to', 'value'], ['feature', 'value'], ['record', 'value'], ['by', 'value'], ['reason', 'value'], ['worker', 'value']]),
    };
    const { values, positional } = parseFlags(rest, allowedBySubcommand[subcommand]);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'slice-tests') {
    if (subcommand !== 'report') throw cliError('slice-tests requires report');
    const { values, positional } = parseFlags(rest, new Map([['feature', 'value']]));
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'status') {
    const { values, positional } = parseFlags([subcommand, ...rest].filter((value) => value !== undefined), new Map([['feature', 'value']]));
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, values };
  }
  if (command === 'next') {
    if (subcommand !== undefined) throw cliError(`unexpected argument: ${subcommand}`);
    return { command, values: {} };
  }
  throw cliError(`unknown command: ${command}`);
}

const DEFAULT_STOP_WAIT_MS = 30_000;
const MAX_STOP_WAIT_MS = 600_000;

function parseWaitMs(value) {
  if (value === undefined) return DEFAULT_STOP_WAIT_MS;
  if (!/^\d+$/.test(value) || Number(value) > MAX_STOP_WAIT_MS) throw cliError(`--wait-ms must be an integer from 0 to ${MAX_STOP_WAIT_MS}`);
  return Number(value);
}

const LAUNCH_ID_PATTERN = /^launch-[a-f0-9-]{36}$/;

function launchId(value) {
  if (typeof value !== 'string' || !LAUNCH_ID_PATTERN.test(value)) {
    throw cliError('launch id must be a TinySDD launch identifier', 'INVALID_LAUNCH_ID');
  }
  return value;
}

async function launchDirectory(project, id, { allowMissing = true } = {}) {
  const root = await canonicalProjectRoot(project);
  const tinysdd = await assertInternalPath(root, ['.tinysdd'], { allowMissing: false, requireDirectory: true });
  const launches = await assertInternalPath(root, ['.tinysdd', 'launches'], { allowMissing: true });
  if (allowMissing) await ensureDirectory(launches);
  const directory = await assertInternalPath(root, ['.tinysdd', 'launches', id], { allowMissing });
  return { root, tinysdd, launches, directory };
}

async function startWorker(project, options) {
  if (!options.task) throw cliError('--task requires a value');
  const resolved = await configShow(project, { worker: options.worker });
  if (!resolved.workerName) throw tinyError('WORKER_NOT_SELECTED', 'no worker selected; configure defaultWorker or pass --worker');
  // Fail before detaching when Pi cannot honor the configured request, so an
  // agent does not poll a launch that was never going to run as configured.
  let preflight;
  try {
    preflight = await preflightPiWorker({ worker: resolved.worker, profile: resolved.profile });
  } catch (error) {
    throw tinyError('WORKER_PREFLIGHT_FAILED', error instanceof Error ? error.message : String(error));
  }
  if (preflight.errors.length > 0) {
    throw tinyError('WORKER_PREFLIGHT_FAILED', `worker preflight failed: ${preflight.errors.join('; ')}`, { errors: preflight.errors, warnings: preflight.warnings });
  }
  const packet = options['baseline-run']
    ? await resolveBenchmarkPacket(project, options.task)
    : await resolveTaskPacket(project, options.task);
  const warnings = declaredRunCheckWarningsForPacket(packet);
  const qualification = await assessQualification({
    projectRoot: resolved.projectRoot,
    resolved,
    workerName: resolved.workerName,
    checksDeclared: packet.checks !== undefined && packet.checks !== null,
  });
  const qualificationWarnings = qualification.warnings ?? [];
  const id = `launch-${randomUUID()}`;
  const location = await launchDirectory(project, id);
  await ensureDirectory(location.directory);
  const requestPath = join(location.directory, 'request.json');
  await atomicWriteJson(requestPath, {
    schemaVersion: 1,
    id,
    taskId: options.task,
    worker: resolved.workerName,
    requestedAt: new Date().toISOString(),
    status: 'starting',
  });
  const launcher = fileURLToPath(new URL('../src/worker-launcher.mjs', import.meta.url));
  const child = spawn(process.execPath, [launcher, location.root, options.task, resolved.workerName, location.directory, options['base-run'] ?? '', options['baseline-run'] ?? ''], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  await atomicWriteJson(requestPath, {
    schemaVersion: 1,
    id,
    taskId: options.task,
    worker: resolved.workerName,
    ...(options['base-run'] ? { baseRun: options['base-run'] } : {}),
    ...(options['baseline-run'] ? { baselineRun: options['baseline-run'] } : {}),
    requestedAt: new Date().toISOString(),
    status: 'running',
    pid: child.pid,
  });
  return {
    id,
    taskId: options.task,
    worker: resolved.workerName,
    status: 'running',
    pid: child.pid,
    statusCommand: `tinysdd worker status --id ${id}`,
    qualification,
    preflight: { thinking: preflight.thinking, maxTokens: preflight.maxTokens, warnings: [...preflight.warnings, ...qualificationWarnings] },
    ...((warnings.length > 0 || qualificationWarnings.length > 0) ? { warnings: [...warnings, ...qualificationWarnings] } : {}),
  };
}

async function declaredRunCheckWarnings(project, options) {
  const packet = options['baseline-run']
    ? await resolveBenchmarkPacket(project, options.task)
    : await resolveTaskPacket(project, options.task);
  return declaredRunCheckWarningsForPacket(packet);
}

function declaredRunCheckWarningsForPacket(packet) {
  if (packet.checks === undefined || packet.checks === null) return [];
  const runner = checkRunnerAvailable();
  return runner.available ? [] : [`run_checks unavailable: ${runner.reason}`];
}

async function runWorkerCommand(project, options) {
  const warnings = await declaredRunCheckWarnings(project, options);
  try {
    const data = await dispatchWorker(project, {
      taskId: options.task,
      worker: options.worker,
      baseRunId: options['base-run'],
      baselineRunId: options['baseline-run'],
    });
    return warnings.length === 0 ? data : { ...data, warnings: [...new Set([...warnings, ...(data.warnings ?? [])])] };
  } catch (error) {
    if (warnings.length > 0 && error && typeof error === 'object') error.cliWarnings = warnings;
    throw error;
  }
}

function parseBenchmarkRepeat(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw cliError('--repeat must be an integer from 1 to 1000');
  const repeat = Number(value);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 1000) {
    throw cliError('--repeat must be an integer from 1 to 1000');
  }
  return repeat;
}

function parseQualificationTargets(values) {
  if (values === undefined) return {};
  const targets = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) throw cliError('--target must use ROLE=NUMBER');
    const role = value.slice(0, separator);
    if (!BENCHMARK_ROLES.includes(role)) throw cliError(`--target role must be one of ${BENCHMARK_ROLES.join(', ')}`);
    const raw = value.slice(separator + 1);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw cliError('--target number must be finite and between 0 and 1');
    if (Object.hasOwn(targets, role)) throw cliError(`duplicate --target role: ${role}`);
    targets[role] = parsed;
  }
  return targets;
}

async function resolveBenchmarkSuite(project, requested) {
  try {
    return await resolveCurrentBenchmarkSuite(project, requested);
  } catch (error) {
    if (error?.code === 'QUALIFICATION_UNAVAILABLE') throw cliError(error.message, 'QUALIFICATION_SUITE_UNAVAILABLE');
    throw error;
  }
}

async function runBenchmarkCommand(project, options) {
  if (!options.worker) throw cliError('--worker requires a value');
  const repeat = parseBenchmarkRepeat(options.repeat);
  const resolved = await configShow(project, { worker: options.worker });
  if (!resolved.workerName || !resolved.worker) throw tinyError('WORKER_NOT_SELECTED', 'no worker selected; pass --worker');
  const suite = await resolveBenchmarkSuite(resolved.projectRoot, options.suite ?? resolved.config?.qualification?.suite ?? 'bench');
  process.stderr.write(`Benchmark ${suite.relative} started with worker ${resolved.workerName}.\n`);
  const result = await runBenchmark({
    projectRoot: resolved.projectRoot,
    suiteRoot: suite.root,
    suitePath: suite.path,
    repeat,
    worker: resolved.worker,
    workerName: resolved.workerName,
    profile: resolved.profile,
    model: resolved.worker.modelMetadata,
    maxCheckRuns: resolved.worker.limits.maxCheckRuns,
  });
  const warnings = result.config.checkRunner.available
    ? []
    : [`run_checks unavailable: ${result.config.checkRunner.reason}`];
  process.stderr.write(`Benchmark complete: ${result.invocation.caseResults.length} attempt(s); results ${result.directory}\n`);
  return warnings.length === 0 ? result : { ...result, warnings };
}

function suiteFilePath(suite) {
  return suite.relative.endsWith('/suite.json') ? suite.relative : `${suite.relative}/suite.json`;
}

function qualificationApplicabilityUnavailable() {
  return { status: 'not_checked', reason: 'current_identity_unavailable' };
}

async function currentQualificationIdentity(project, suite, workerName) {
  const resolved = await configShow(project, { worker: workerName });
  if (!resolved.workerName || !resolved.worker) return { resolved, applicability: qualificationApplicabilityUnavailable() };
  const current = await inspectBenchmarkIdentity({
    projectRoot: resolved.projectRoot,
    suiteRoot: suite.root,
    suitePath: suite.path,
    worker: resolved.worker,
    profile: resolved.profile,
    model: resolved.worker.modelMetadata,
    maxCheckRuns: resolved.worker.limits.maxCheckRuns,
  });
  return { resolved, current };
}

async function qualifyBenchmarkCommand(project, options) {
  const resultPaths = options.results;
  if (!Array.isArray(resultPaths) || resultPaths.length === 0) throw cliError('--results requires a value');
  let configured = { config: {} };
  try {
    configured = await configShow(project, { worker: options.worker });
  } catch (error) {
    if (options.worker !== undefined || error?.code !== 'CONFIG_MISSING') throw error;
  }
  const requestedSuite = options.suite ?? configured.config?.qualification?.suite ?? 'bench';
  const suite = await resolveBenchmarkSuite(project, requestedSuite);
  const targets = parseQualificationTargets(options.target);
  const anchor = await readQualificationEvidence({
    projectRoot: project,
    results: [resultPaths[0]],
    suitePath: suiteFilePath(suite),
  });
  const evidence = await readQualificationEvidencePool({
    projectRoot: project,
    results: resultPaths,
    suitePath: suiteFilePath(suite),
    configDigest: anchor.configDigest,
  });
  const built = buildQualificationRecord({
    observations: evidence.observations,
    source: evidence.source,
    roster: evidence.roster,
    configIdentity: evidence.configIdentity,
    configDigest: evidence.configDigest,
    suite: evidence.suite,
    targets,
  });
  const current = options.worker === undefined ? { resolved: undefined, current: undefined } : await currentQualificationIdentity(project, suite, options.worker);
  const applicability = current.current === undefined
    ? qualificationApplicabilityUnavailable()
    : compareQualificationApplicability(built, current.current);
  const stored = await accumulateQualificationRecord(project, built, {
    ...(current.resolved?.workerName ? {
      profilePath: current.resolved.worker.profile ?? null,
      profile: current.resolved.profile,
      workerName: current.resolved.workerName,
    } : {}),
    targets,
  });
  return {
    record: stored.record,
    path: stored.path,
    sha256: stored.sha256,
    applicability,
    duplicateInputs: evidence.duplicateInputs,
    registeredInputs: evidence.registeredInputs,
  };
}

async function rescoreBenchmarkCommand(project, options) {
  const recordPath = requiredOption(options, 'record');
  const loaded = await readQualificationRecord(project, recordPath);
  const rescored = rescoreQualificationRecord(loaded.record, parseQualificationTargets(options.target));
  const stored = await replaceQualificationRecord(project, rescored);
  return { record: stored.record, path: stored.path, sha256: stored.sha256, applicability: qualificationApplicabilityUnavailable() };
}

async function showQualificationCommand(project, options) {
  const loaded = await readQualificationRecord(project, requiredOption(options, 'record'));
  let applicability = qualificationApplicabilityUnavailable();
  if (options.worker !== undefined && options.suite !== undefined) {
    const suite = await resolveBenchmarkSuite(project, options.suite);
    const current = await currentQualificationIdentity(project, suite, options.worker);
    applicability = current.current === undefined ? applicability : compareQualificationApplicability(loaded.record, current.current);
  }
  return { record: loaded.record, path: loaded.path, sha256: loaded.sha256, applicability };
}

async function loadLaunch(project, rawId) {
  const id = launchId(rawId);
  let location;
  try {
    location = await launchDirectory(project, id, { allowMissing: false });
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') throw cliError(`launch not found: ${id}`, 'LAUNCH_NOT_FOUND');
    throw error;
  }
  let info;
  try {
    const stat = await lstat(location.directory);
    if (!stat.isDirectory()) throw cliError('launch path is not a directory', 'INVALID_LAUNCH');
    info = await readJsonFile(join(location.directory, 'request.json'), { code: 'LAUNCH_MALFORMED' });
  } catch (error) {
    if (error?.code === 'ENOENT') throw cliError(`launch not found: ${id}`, 'LAUNCH_NOT_FOUND');
    throw error;
  }
  if (!info?.value || info.value.id !== id) throw cliError(`launch not found: ${id}`, 'LAUNCH_NOT_FOUND');
  // request.json is a launch-time snapshot. Expose its stored status as
  // launchStatus so pollers cannot mistake it for the current data.status.
  const { status: launchStatus, ...requestFields } = info.value;
  return { id, location, pid: info.value.pid, request: { ...requestFields, launchStatus } };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function workerStatus(project, options) {
  const { id, location, pid, request } = await loadLaunch(project, options.id);
  const result = await readJsonFile(join(location.directory, 'result.json'), { code: 'LAUNCH_MALFORMED' });
  const stop = await readJsonFile(join(location.directory, 'stop.json'), { code: 'LAUNCH_MALFORMED' });
  const stopFields = stop ? { stopRequestedAt: stop.value?.requestedAt ?? null } : {};
  if (result) return { id, status: 'finished', ...stopFields, request, result: result.value };
  if (!pidAlive(pid)) return { id, status: 'interrupted', ...stopFields, request };
  return { id, status: stop ? 'stopping' : 'running', ...stopFields, request };
}

// request.json's pid can outlive its launcher and be reused, so only signal a
// process whose argv is this launch's own worker-launcher.mjs invocation.
async function isLaunchLauncher(pid, directory) {
  let cmdline;
  try {
    cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false;
  }
  const argv = cmdline.split('\0');
  return argv.some((arg) => basename(arg) === 'worker-launcher.mjs') && argv.includes(directory);
}

async function workerStop(project, options) {
  const { id, location, pid, request } = await loadLaunch(project, options.id);
  const resultPath = join(location.directory, 'result.json');
  const stopPath = join(location.directory, 'stop.json');
  const readResult = () => readJsonFile(resultPath, { code: 'LAUNCH_MALFORMED' });
  const finished = (result, stopRequested) => ({ id, status: 'finished', stopRequested, request, result: result.value });
  const early = await readResult();
  if (early) return finished(early, false);
  if (!pidAlive(pid)) return { id, status: 'interrupted', stopRequested: false, request };
  if (process.platform !== 'linux') throw tinyError('UNSUPPORTED_PLATFORM', 'worker stop requires Linux /proc to verify the launcher');
  if (!await isLaunchLauncher(pid, location.directory)) {
    throw tinyError('LAUNCH_NOT_OURS', `process ${pid} is alive but is not the launcher of ${id}; refusing to signal it`);
  }
  // The launcher handles one SIGTERM; a second one would kill it before it
  // finalizes, so a repeated stop only waits.
  if (!await readJsonFile(stopPath, { code: 'LAUNCH_MALFORMED' })) {
    await atomicWriteJson(stopPath, { schemaVersion: 1, id, requestedAt: new Date().toISOString() });
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      await unlink(stopPath).catch(() => {});
      // The launcher exited on its own between the checks and the signal.
      if (error?.code === 'ESRCH') {
        const late = await readResult();
        return late ? finished(late, false) : { id, status: 'interrupted', stopRequested: false, request };
      }
      throw error;
    }
  }
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const result = await readResult();
    if (result) return finished(result, true);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
  }
  return { id, status: 'stopping', stopRequested: true, request, statusCommand: `tinysdd worker status --id ${id}` };
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) throw cliError(`--${name} requires a value`);
  return value;
}

function parseUsageToken(value, flag) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw cliError(`${flag} must be a nonnegative safe integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw cliError(`${flag} must be a nonnegative safe integer`);
  return parsed;
}

async function recordUsageCommand(project, options) {
  if (options.task === undefined && options.feature === undefined) throw cliError('--task or --feature is required for usage attribution');
  const record = await appendUsageRecord(project, {
    phase: requiredOption(options, 'phase'),
    model: requiredOption(options, 'model'),
    input: parseUsageToken(requiredOption(options, 'input'), '--input'),
    output: parseUsageToken(requiredOption(options, 'output'), '--output'),
    ...(options.reasoning === undefined ? {} : { reasoning: parseUsageToken(options.reasoning, '--reasoning') }),
    ...(options['cache-read'] === undefined ? {} : { cacheRead: parseUsageToken(options['cache-read'], '--cache-read') }),
    ...(options['cache-write'] === undefined ? {} : { cacheWrite: parseUsageToken(options['cache-write'], '--cache-write') }),
    ...(options.total === undefined ? {} : { totalTokens: parseUsageToken(options.total, '--total') }),
    ...(options.task === undefined ? {} : { taskId: options.task }),
    ...(options.feature === undefined ? {} : { feature: options.feature }),
  });
  return { record };
}

async function readUsageImportFile(project, requested) {
  const relative = normalizeProjectRelative(requiredOption({ file: requested }, 'file'), '--file');
  const path = await assertInternalPath(project, relative.split('/'), { allowMissing: false });
  const info = await lstat(path);
  if (!info.isFile()) throw tinyError('INVALID_FILE', `usage import file must be a regular file: ${relative}`);
  if (info.size > USAGE_LEDGER_MAX_BYTES) throw tinyError('USAGE_IMPORT_TOO_LARGE', `usage import exceeds ${USAGE_LEDGER_MAX_BYTES} bytes`);
  return readFile(path, 'utf8');
}

async function importUsageCommand(project, options) {
  const text = await readUsageImportFile(project, options.file);
  const records = await importUsageRecords(project, text);
  return { records };
}

function reportMetricText(report, component) {
  const value = report?.[component] ?? 'UNKNOWN';
  if (value !== 'UNKNOWN') return String(value);
  const known = report?.knownSubtotals?.[component];
  return known === null || known === undefined ? 'UNKNOWN' : `UNKNOWN (known subtotal ${known})`;
}

function renderUsageReport(data) {
  const state = data.accepted === true
    ? (data.stale ? 'accepted snapshot, stale' : 'accepted snapshot, current')
    : 'live report, not accepted';
  const frontier = data.report?.frontier?.totals;
  const local = data.report?.local?.totals;
  process.stdout.write(`Feature ${data.feature}: ${state}\n`);
  process.stdout.write(`Frontier input ${reportMetricText(frontier, 'input')}; output ${reportMetricText(frontier, 'output')}\n`);
  process.stdout.write(`Local input ${reportMetricText(local, 'input')}; output ${reportMetricText(local, 'output')}\n`);
}

function qualificationStatusLabel(status) {
  if (status === 'qualified') return 'qualified';
  if (status === 'not_qualified') return 'not qualified';
  return 'insufficient evidence';
}

function qualificationBoundLabel(value, reason) {
  if (value === null) return `unavailable (${reason ?? 'unknown'})`;
  return String(value);
}

function renderQualification(data) {
  const record = data.record;
  process.stdout.write(`Qualification ${record.suite.id}@${record.suite.version}\n`);
  for (const [role, score] of Object.entries(record.roles)) {
    process.stdout.write(`Role ${role}: ${qualificationStatusLabel(score.status)}\n`);
    process.stdout.write(`n: ${score.n}; passes: ${score.passes}; lowerBound: ${score.lowerBound}; upperBound: ${score.upperBound}; target: ${score.target}\n`);
    process.stdout.write(`passesToQualify: ${qualificationBoundLabel(score.passesToQualify, score.passesToQualifyReason)} (best-case bound, not a prediction)\n`);
    process.stdout.write(`failuresToRuleOut: ${qualificationBoundLabel(score.failuresToRuleOut, score.failuresToRuleOutReason)} (best-case bound, not a prediction)\n`);
  }
  if (data.applicability) process.stdout.write(`Applicability: ${data.applicability.status}\n`);
  if (data.path) process.stdout.write(`Record: ${data.path}\n`);
  for (const duplicate of data.duplicateInputs ?? []) process.stdout.write(`Duplicate input ignored: ${duplicate}\n`);
}

async function run(argv) {
  const { args, json, help, version, project } = extractGlobals(argv);
  if (version) return { ok: true, data: { version: VERSION }, presentation: 'version' };
  if (help) return { ok: true, data: { help: HELP }, presentation: 'help' };
  const parsed = parseCommand(args);
  let data;
  let presentation;
  if (parsed.command === 'init') data = await initProject(project, parsed.values);
  else if (parsed.command === 'config') data = parsed.subcommand === 'show'
    ? await configShow(project, { worker: parsed.values.worker })
    : await configValidate(project, { worker: parsed.values.worker });
  else if (parsed.command === 'status') {
    data = await controllerStatus(project, { feature: parsed.values.feature });
    return { ok: true, data, presentation: 'status' };
  }
  else if (parsed.command === 'next') data = await controllerNext(project);
  else if (parsed.command === 'task' && parsed.subcommand === 'add') data = await addTask(project, {
    id: parsed.values.id,
    brief: parsed.values.brief,
    context: parsed.values.context,
    checks: parsed.values.checks,
    dependsOn: parsed.values['depends-on'],
    allow: parsed.values.allow,
    protect: parsed.values.protect,
    preparation: parsed.values.preparation,
    feature: parsed.values.feature,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'update') data = await updateTask(project, {
    id: parsed.values.id,
    by: parsed.values.by,
    reason: parsed.values.reason,
    brief: parsed.values.brief,
    context: parsed.values.context,
    checks: parsed.values.checks,
    allow: parsed.values.allow,
    protect: parsed.values.protect,
    preparation: parsed.values.preparation,
    dependsOn: parsed.values['depends-on'],
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'approve') data = await approveTask(project, {
    id: parsed.values.id,
    by: parsed.values.by,
    reason: parsed.values.reason,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'packet') data = await resolveTaskPacket(project, parsed.values.id);
  else if (parsed.command === 'task' && parsed.subcommand === 'apply') data = await applyTask(project, {
    id: parsed.values.id,
    run: parsed.values.run,
    by: parsed.values.by,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'review') data = await reviewTask(project, {
    id: parsed.values.id,
    verdict: parsed.values.verdict,
    evidence: parsed.values.evidence,
    by: parsed.values.by,
    candidatePaths: parsed.values['candidate-paths'],
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'close') data = await closeTask(project, {
    id: parsed.values.id,
    by: parsed.values.by,
    reason: parsed.values.reason,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'supersede') data = await supersedeTask(project, {
    id: parsed.values.id,
    with: parsed.values.with,
    by: parsed.values.by,
    reason: parsed.values.reason,
  });
  else if (parsed.command === 'worker' && parsed.subcommand === 'run') data = await runWorkerCommand(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'start') data = await startWorker(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'status') data = await workerStatus(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'stop') data = await workerStop(project, { id: parsed.values.id, waitMs: parsed.values['wait-ms'] });
  else if (parsed.command === 'bench' && parsed.subcommand === 'run') data = await runBenchmarkCommand(project, parsed.values);
  else if (parsed.command === 'bench' && parsed.subcommand === 'qualify') {
    data = await qualifyBenchmarkCommand(project, parsed.values);
    presentation = 'qualification';
  }
  else if (parsed.command === 'bench' && parsed.subcommand === 'rescore') {
    data = await rescoreBenchmarkCommand(project, parsed.values);
    presentation = 'qualification';
  }
  else if (parsed.command === 'bench' && parsed.subcommand === 'qualification' && parsed.action === 'show') {
    data = await showQualificationCommand(project, parsed.values);
    presentation = 'qualification';
  }
  else if (parsed.command === 'usage' && parsed.subcommand === 'record') {
    data = await recordUsageCommand(project, parsed.values);
    presentation = 'usage-record';
  }
  else if (parsed.command === 'usage' && parsed.subcommand === 'import') {
    data = await importUsageCommand(project, parsed.values);
    presentation = 'usage-import';
  }
  else if (parsed.command === 'usage' && parsed.subcommand === 'report') {
    data = await reportFeature(project, { feature: requiredOption(parsed.values, 'feature') });
    presentation = 'usage-report';
  }
  else if (parsed.command === 'feature' && parsed.subcommand === 'accept') {
    data = await acceptFeature(project, {
      feature: requiredOption(parsed.values, 'feature'),
      by: requiredOption(parsed.values, 'by'),
      reason: requiredOption(parsed.values, 'reason'),
    });
    presentation = 'feature-accept';
  }
  else if (parsed.command === 'feature' && parsed.subcommand === 'report') {
    data = await reportFeature(project, { feature: requiredOption(parsed.values, 'feature') });
    presentation = 'usage-report';
  }
  else if (parsed.command === 'phase' && (parsed.subcommand === 'record' || parsed.subcommand === 'research')) {
    const phase = parsed.values.phase ?? 'research';
    if (phase !== 'research') throw cliError('only the research phase can be recorded', 'PHASE_UNSUPPORTED');
    data = await recordPhase(project, {
      phase,
      feature: requiredOption(parsed.values, 'feature'),
      proposal: requiredOption(parsed.values, 'proposal'),
      context: requiredOption(parsed.values, 'context'),
      by: requiredOption(parsed.values, 'by'),
      reason: requiredOption(parsed.values, 'reason'),
      predecessor: parsed.values.predecessor,
      worker: parsed.values.worker,
    });
    presentation = 'phase-record';
  }
  else if (parsed.command === 'phase' && parsed.subcommand === 'status') {
    data = await phaseStatus(project, { feature: requiredOption(parsed.values, 'feature'), worker: parsed.values.worker });
    presentation = 'phase-status';
  }
  else if (parsed.command === 'phase' && parsed.subcommand === 'advance') {
    data = await advancePhase(project, {
      from: parsed.values.from,
      to: parsed.values.to,
      feature: requiredOption(parsed.values, 'feature'),
      recordId: parsed.values.record,
      by: requiredOption(parsed.values, 'by'),
      reason: requiredOption(parsed.values, 'reason'),
      worker: parsed.values.worker,
    });
    presentation = 'phase-advance';
  }
  else if (parsed.command === 'slice-tests' && parsed.subcommand === 'report') {
    data = await reportSliceTestReviews(project, { feature: parsed.values.feature });
    presentation = 'slice-test-review-report';
  }
  else throw cliError('unsupported command');
  const failedOutcome = isFailedWorkerOutcome(data?.outcome);
  const scopeViolations = Array.isArray(data?.scopeViolations) && data.scopeViolations.length > 0;
  if (failedOutcome || scopeViolations) {
    return {
      ok: false,
      error: {
        code: scopeViolations ? 'WORKER_SCOPE_VIOLATION' : 'WORKER_FAILED',
        message: scopeViolations
          ? 'worker changed paths outside packet.allowedPaths'
          : `worker ended with outcome ${data.outcome}`,
        details: { outcome: data?.outcome, scopeViolations: data?.scopeViolations ?? [] },
      },
      data,
    };
  }
  return { ok: true, data, presentation };
}

function describeStop(data) {
  if (data.status === 'stopping') return `stopping; poll: ${data.statusCommand}`;
  if (data.status !== 'finished') return data.status;
  const outcome = data.result?.data?.outcome;
  if (outcome === 'stopped') return 'finished (stopped by operator)';
  return outcome ? `finished (outcome ${outcome})` : 'finished';
}

function describeTask(task) {
  if (task.closure?.kind === 'superseded') return `superseded by ${task.closure.supersededBy.join(', ')}`;
  return task.status ?? 'registered';
}

function describeStatusTask(task) {
  let description = `${task.id}  ${describeTask(task)}`;
  if (task.status === 'accepted' && task.applied) description += ` (applied from ${task.applied.runId})`;
  if (task.blockedBy?.length) description += ` (requires ${task.blockedBy.join(', ')})`;
  return description;
}

function renderStatusTree(data) {
  const tasks = data.tasks ?? [];
  if (tasks.length === 0) {
    process.stdout.write(`${Object.hasOwn(data, 'feature') ? `No tasks in feature ${data.feature}.` : 'No tasks registered.'}\n`);
    return;
  }
  const open = tasks.filter((task) => !task.closure);
  const openById = new Map(open.map((task) => [task.id, task]));
  const children = new Map(open.map((task) => [task.id, []]));
  const roots = [];
  for (const task of open) {
    const parent = task.dependsOn
      .filter((dependency) => openById.has(dependency))
      .sort((left, right) => openById.get(left).order - openById.get(right).order)[0];
    if (parent === undefined) roots.push(task);
    else children.get(parent).push(task);
  }
  const byOrder = (left, right) => left.order - right.order;
  roots.sort(byOrder);
  for (const childList of children.values()) childList.sort(byOrder);
  const lines = [];
  const draw = (task, prefix, connector) => {
    lines.push(`${prefix}${connector}${describeStatusTask(task)}`);
    const childPrefix = connector === '' ? prefix : `${prefix}${connector === '└─ ' ? '   ' : '│  '}`;
    const childList = children.get(task.id);
    childList.forEach((child, index) => draw(child, childPrefix, index === childList.length - 1 ? '└─ ' : '├─ '));
  };
  roots.forEach((task) => draw(task, '', ''));
  const retired = tasks.filter((task) => task.closure).sort(byOrder);
  if (retired.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Closed or superseded:');
    for (const task of retired) lines.push(`${task.id}: ${describeTask(task)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeRunCheckWarnings(result) {
  const warnings = [
    ...(result.warnings ?? []),
    ...(result.data?.warnings ?? []),
    ...(result.data?.preflight?.warnings ?? []),
    ...(result.error?.details?.qualification?.warnings ?? []),
  ].filter((warning) => typeof warning === 'string');
  for (const warning of [...new Set(warnings)]) process.stderr.write(`Warning: ${warning}\n`);
}

function writeResult(result, json) {
  const envelope = { ...result };
  delete envelope.presentation;
  writeRunCheckWarnings(result);
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (result.presentation === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (result.presentation === 'help') {
    process.stdout.write(`${HELP}`);
    return;
  }
  if (result.presentation === 'slice-test-review-report') {
    const report = result.data;
    process.stdout.write(`Slice-test review: ${report.assessments} assessments, ${report.escalations} escalations.\n`);
    process.stdout.write(`Positive review disagreement: ${report.positiveReviewDisagreement.numerator}/${report.positiveReviewDisagreement.denominator}; unreviewed negatives: ${report.unreviewedNegatives}.\n`);
    return;
  }
  if (result.presentation === 'status') {
    renderStatusTree(result.data);
    return;
  }
  if (result.presentation === 'usage-record') {
    process.stdout.write(`Recorded usage ${result.data.record.id} (${result.data.record.phase}, input ${result.data.record.input}, output ${result.data.record.output}).\n`);
    return;
  }
  if (result.presentation === 'usage-import') {
    process.stdout.write(`Imported ${result.data.records.length} usage record(s).\n`);
    return;
  }
  if (result.presentation === 'usage-report' || result.presentation === 'feature-accept') {
    if (result.presentation === 'feature-accept') process.stdout.write(`Feature ${result.data.feature}: acceptance recorded.\n`);
    renderUsageReport(result.data);
    return;
  }
  if (result.presentation === 'qualification') {
    renderQualification(result.data);
    return;
  }
  if (result.presentation === 'phase-record') {
    process.stdout.write(`Phase ${result.data.phase}: approval recorded for ${result.data.feature}.\n`);
    return;
  }
  if (result.presentation === 'phase-advance') {
    process.stdout.write(`Phase ${result.data.feature}: advanced ${result.data.from} to ${result.data.to}.\n`);
    return;
  }
  if (result.presentation === 'phase-status') {
    process.stdout.write(`Feature ${result.data.feature ?? 'all'} phases:\n`);
    for (const [name, value] of Object.entries(result.data.phases ?? {})) process.stdout.write(`${name}: ${value.status}\n`);
    return;
  }
  if (result.ok) {
    const data = result.data;
    if (typeof data?.stopRequested === 'boolean') {
      process.stdout.write(`Launch ${data.id}: ${describeStop(data)}\n`);
    } else if (data?.outcome) {
      process.stdout.write(`Worker ${data.outcome}; verification and review are pending.\n`);
      for (const change of data.changedPaths ?? []) process.stdout.write(`  ${change.change}: ${change.path}\n`);
      if (data.artifactPaths?.directory) process.stdout.write(`Evidence: ${data.artifactPaths.directory}\n`);
    } else if (Array.isArray(data?.tasks)) {
      if (data.tasks.length === 0) process.stdout.write('No tasks registered.\n');
      for (const task of data.tasks) {
        // A retired task's blockers no longer matter.
        process.stdout.write(`${task.id}: ${describeTask(task)}${task.blockedBy?.length && !task.closure ? ` (requires ${task.blockedBy.join(', ')})` : ''}\n`);
      }
      if (Object.hasOwn(data, 'next')) process.stdout.write(data.next ? `Next: ${data.next.taskId} — ${data.next.action}\n` : 'No pending task.\n');
    } else if (Array.isArray(data?.applied?.files)) {
      const already = data.applied.files.filter((file) => file.status === 'already-applied').length;
      process.stdout.write(`${data.task.id}: applied ${data.applied.files.length} file(s) from ${data.applied.runId}${already > 0 ? ` (${already} already applied)` : ''}\n`);
    } else if (data?.task?.id) {
      process.stdout.write(`${data.task.id}: ${describeTask(data.task)}\n`);
      for (const warning of data.sizing?.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
    } else if (data?.taskId && data?.brief?.text) {
      process.stdout.write(`Task: ${data.taskId}\nAllowed files: ${data.allowedPaths.join(', ')}\n\n${data.brief.text}\n`);
      if (data.review?.evidence?.text) process.stdout.write(`\nReview feedback:\n${data.review.evidence.text}\n`);
    } else if (data?.statusCommand) {
      process.stdout.write(`Started ${data.id} (${data.worker}, task ${data.taskId}). Poll: ${data.statusCommand}\n`);
      for (const warning of data.preflight?.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
    } else if (data?.invocation?.invocationId && data?.summary?.groups) {
      const scheduled = data.summary.groups.reduce((total, group) => total + group.scheduled, 0);
      process.stdout.write(`Benchmark ${data.invocation.invocationId}: ${scheduled} attempt(s) recorded.\nResults: ${data.directory}\n`);
    } else if (data?.configPath) {
      process.stdout.write(`${data.configCreated ? 'Created' : 'Preserved'} config: ${data.configPath}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  } else {
    process.stderr.write(`ERROR [${result.error.code}] ${result.error.message}\n`);
    if (result.data?.artifactPaths?.directory) process.stderr.write(`Evidence: ${result.data.artifactPaths.directory}\n`);
    if (result.data?.candidateState?.allowedPathsTouched > 0) {
      const { allowedPathsTouched, allowedPaths } = result.data.candidateState;
      process.stderr.write(`Candidate: ${allowedPathsTouched} of ${allowedPaths} allowed paths changed; review it before discarding.\n`);
    }
  }
}

const requestedJson = process.argv.slice(2).includes('--json');
try {
  const result = await run(process.argv.slice(2));
  writeResult(result, requestedJson);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const result = { ok: false, error: publicError(error), ...(error.cliWarnings ? { warnings: error.cliWarnings } : {}) };
  writeResult(result, requestedJson);
  process.exitCode = 1;
}
