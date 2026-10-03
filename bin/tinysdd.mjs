#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { lstat, readFile, unlink } from 'node:fs/promises';

import {
  addTask,
  approveTask,
  closeTask,
  configShow,
  configValidate,
  controllerNext,
  controllerStatus,
  dispatchWorker,
  initProject,
  publicError,
  resolveTaskPacket,
  reviewTask,
  supersedeTask,
} from '../src/controller.mjs';
import { assertInternalPath, atomicWriteJson, canonicalProjectRoot, ensureDirectory, readJsonFile, tinyError } from '../src/fs-utils.mjs';
import { isFailedWorkerOutcome } from '../src/outcomes.mjs';
import { preflightPiWorker } from '../src/pi-environment.mjs';

const VERSION = '0.1.0';
const HELP = `TinySDD ${VERSION}

Usage:
  tinysdd [--json] [--project PATH] init [--worker NAME --provider ID --model ID]
  tinysdd [--json] [--project PATH] config show|validate [--worker NAME]
  tinysdd [--json] [--project PATH] status|next
  tinysdd [--json] [--project PATH] task add --id ID --brief PATH --allow FILE[,FILE] [--context PATH] [--depends-on ID[,ID]]
  tinysdd [--json] [--project PATH] task approve --id ID --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] task packet --id ID
  tinysdd [--json] [--project PATH] task review --id ID --verdict accepted|revision|blocked --evidence PATH --by LABEL
  tinysdd [--json] [--project PATH] task close --id ID --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] task supersede --id ID --with ID[,ID] --by LABEL --reason TEXT
  tinysdd [--json] [--project PATH] worker run --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker start --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker status --id LAUNCH_ID
  tinysdd [--json] [--project PATH] worker stop --id LAUNCH_ID [--wait-ms N]

Retired (closed or superseded) tasks leave \`next\`, cannot be approved, reviewed or
dispatched, and are refused while open tasks depend on them.
Workers return isolated candidates and patches; they never apply or accept them.
Use \`worker start\` for real model calls from an agent: it detaches the controller
from short-lived interactive shells. Poll it with \`worker status\`.
Stopping a launch with \`worker stop\` finalizes the run with outcome \`stopped\`,
keeping its evidence and candidate.
Use --json for machine-readable results, including failed worker evidence.
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
    if (!['add', 'approve', 'packet', 'review', 'close', 'supersede'].includes(subcommand)) throw cliError('task requires add, approve, packet, review, close, or supersede');
    const allowedByCommand = {
      add: new Map([['id', 'value'], ['brief', 'value'], ['context', 'value'], ['depends-on', 'list'], ['allow', 'list']]),
      approve: new Map([['id', 'value'], ['by', 'value'], ['reason', 'value']]),
      packet: new Map([['id', 'value']]),
      review: new Map([['id', 'value'], ['by', 'value'], ['verdict', 'value'], ['evidence', 'value']]),
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
  if (command === 'status' || command === 'next') {
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
    preflight: { thinking: preflight.thinking, maxTokens: preflight.maxTokens, warnings: preflight.warnings },
  };
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

async function run(argv) {
  const { args, json, help, version, project } = extractGlobals(argv);
  if (version) return { ok: true, data: { version: VERSION }, presentation: 'version' };
  if (help) return { ok: true, data: { help: HELP }, presentation: 'help' };
  const parsed = parseCommand(args);
  let data;
  if (parsed.command === 'init') data = await initProject(project, parsed.values);
  else if (parsed.command === 'config') data = parsed.subcommand === 'show'
    ? await configShow(project, { worker: parsed.values.worker })
    : await configValidate(project, { worker: parsed.values.worker });
  else if (parsed.command === 'status') data = await controllerStatus(project);
  else if (parsed.command === 'next') data = await controllerNext(project);
  else if (parsed.command === 'task' && parsed.subcommand === 'add') data = await addTask(project, {
    id: parsed.values.id,
    brief: parsed.values.brief,
    context: parsed.values.context,
    dependsOn: parsed.values['depends-on'],
    allow: parsed.values.allow,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'approve') data = await approveTask(project, {
    id: parsed.values.id,
    by: parsed.values.by,
    reason: parsed.values.reason,
  });
  else if (parsed.command === 'task' && parsed.subcommand === 'packet') data = await resolveTaskPacket(project, parsed.values.id);
  else if (parsed.command === 'task' && parsed.subcommand === 'review') data = await reviewTask(project, {
    id: parsed.values.id,
    verdict: parsed.values.verdict,
    evidence: parsed.values.evidence,
    by: parsed.values.by,
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
  else if (parsed.command === 'worker' && parsed.subcommand === 'run') data = await dispatchWorker(project, {
    taskId: parsed.values.task,
    worker: parsed.values.worker,
    baseRunId: parsed.values['base-run'],
    baselineRunId: parsed.values['baseline-run'],
  });
  else if (parsed.command === 'worker' && parsed.subcommand === 'start') data = await startWorker(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'status') data = await workerStatus(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'stop') data = await workerStop(project, { id: parsed.values.id, waitMs: parsed.values['wait-ms'] });
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
  return { ok: true, data, ...(json ? {} : {}) };
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

function writeResult(result, json) {
  const envelope = { ...result };
  delete envelope.presentation;
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
    } else if (data?.task?.id) {
      process.stdout.write(`${data.task.id}: ${describeTask(data.task)}\n`);
      for (const warning of data.sizing?.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
    } else if (data?.taskId && data?.brief?.text) {
      process.stdout.write(`Task: ${data.taskId}\nAllowed files: ${data.allowedPaths.join(', ')}\n\n${data.brief.text}\n`);
      if (data.review?.evidence?.text) process.stdout.write(`\nReview feedback:\n${data.review.evidence.text}\n`);
    } else if (data?.statusCommand) {
      process.stdout.write(`Started ${data.id} (${data.worker}, task ${data.taskId}). Poll: ${data.statusCommand}\n`);
      for (const warning of data.preflight?.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
    } else if (data?.configPath) {
      process.stdout.write(`${data.configCreated ? 'Created' : 'Preserved'} config: ${data.configPath}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  } else {
    process.stderr.write(`ERROR [${result.error.code}] ${result.error.message}\n`);
    if (result.data?.artifactPaths?.directory) process.stderr.write(`Evidence: ${result.data.artifactPaths.directory}\n`);
  }
}

const requestedJson = process.argv.slice(2).includes('--json');
try {
  const result = await run(process.argv.slice(2));
  writeResult(result, requestedJson);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const result = { ok: false, error: publicError(error) };
  writeResult(result, requestedJson);
  process.exitCode = 1;
}
