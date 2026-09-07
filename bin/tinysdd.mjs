#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';

import {
  addTask,
  approveTask,
  configShow,
  configValidate,
  controllerNext,
  controllerStatus,
  dispatchWorker,
  initProject,
  publicError,
  resolveTaskPacket,
  reviewTask,
} from '../src/controller.mjs';
import { assertInternalPath, atomicWriteJson, canonicalProjectRoot, ensureDirectory, readJsonFile, tinyError } from '../src/fs-utils.mjs';

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
  tinysdd [--json] [--project PATH] worker run --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker start --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
  tinysdd [--json] [--project PATH] worker status --id LAUNCH_ID

Workers return isolated candidates and patches; they never apply or accept them.
Use \`worker start\` for real model calls from an agent: it detaches the controller
from short-lived interactive shells. Poll it with \`worker status\`.
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
    if (!['add', 'approve', 'packet', 'review'].includes(subcommand)) throw cliError('task requires add, approve, packet, or review');
    const allowedByCommand = {
      add: new Map([['id', 'value'], ['brief', 'value'], ['context', 'value'], ['depends-on', 'list'], ['allow', 'list']]),
      approve: new Map([['id', 'value'], ['by', 'value'], ['reason', 'value']]),
      packet: new Map([['id', 'value']]),
      review: new Map([['id', 'value'], ['by', 'value'], ['verdict', 'value'], ['evidence', 'value']]),
    };
    const allowed = allowedByCommand[subcommand];
    const { values, positional } = parseFlags(rest, allowed);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'worker') {
    if (!['run', 'start', 'status'].includes(subcommand)) throw cliError('worker requires run, start, or status');
    const allowed = subcommand === 'status'
      ? new Map([['id', 'value']])
      : new Map([['task', 'value'], ['worker', 'value'], ['base-run', 'value'], ['baseline-run', 'value']]);
    const { values, positional } = parseFlags(rest, allowed);
    if (positional.length) throw cliError(`unexpected argument: ${positional[0]}`);
    return { command, subcommand, values };
  }
  if (command === 'status' || command === 'next') {
    if (subcommand !== undefined) throw cliError(`unexpected argument: ${subcommand}`);
    return { command, values: {} };
  }
  throw cliError(`unknown command: ${command}`);
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
  return { id, taskId: options.task, worker: resolved.workerName, status: 'running', pid: child.pid, statusCommand: `tinysdd worker status --id ${id}` };
}

async function workerStatus(project, options) {
  const id = launchId(options.id);
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
  const result = await readJsonFile(join(location.directory, 'result.json'), { code: 'LAUNCH_MALFORMED' });
  if (result) return { id, status: 'finished', request: info.value, result: result.value };
  let alive = false;
  if (Number.isInteger(info.value.pid) && info.value.pid > 0) {
    try { process.kill(info.value.pid, 0); alive = true; } catch (error) { alive = error?.code === 'EPERM'; }
  }
  return { id, status: alive ? 'running' : 'interrupted', request: info.value };
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
  else if (parsed.command === 'worker' && parsed.subcommand === 'run') data = await dispatchWorker(project, {
    taskId: parsed.values.task,
    worker: parsed.values.worker,
    baseRunId: parsed.values['base-run'],
    baselineRunId: parsed.values['baseline-run'],
  });
  else if (parsed.command === 'worker' && parsed.subcommand === 'start') data = await startWorker(project, parsed.values);
  else if (parsed.command === 'worker' && parsed.subcommand === 'status') data = await workerStatus(project, parsed.values);
  else throw cliError('unsupported command');
  const failedOutcome = ['failed', 'timeout', 'tool_limit', 'output_limit'].includes(data?.outcome);
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
    if (data?.outcome) {
      process.stdout.write(`Worker ${data.outcome}; verification and review are pending.\n`);
      for (const change of data.changedPaths ?? []) process.stdout.write(`  ${change.change}: ${change.path}\n`);
      if (data.artifactPaths?.directory) process.stdout.write(`Evidence: ${data.artifactPaths.directory}\n`);
    } else if (Array.isArray(data?.tasks)) {
      if (data.tasks.length === 0) process.stdout.write('No tasks registered.\n');
      for (const task of data.tasks) {
        process.stdout.write(`${task.id}: ${task.status}${task.blockedBy?.length ? ` (requires ${task.blockedBy.join(', ')})` : ''}\n`);
      }
      if (Object.hasOwn(data, 'next')) process.stdout.write(data.next ? `Next: ${data.next.taskId} — ${data.next.action}\n` : 'No pending task.\n');
    } else if (data?.task?.id) {
      process.stdout.write(`${data.task.id}: ${data.task.status ?? 'registered'}\n`);
    } else if (data?.taskId && data?.brief?.text) {
      process.stdout.write(`Task: ${data.taskId}\nAllowed files: ${data.allowedPaths.join(', ')}\n\n${data.brief.text}\n`);
      if (data.review?.evidence?.text) process.stdout.write(`\nReview feedback:\n${data.review.evidence.text}\n`);
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
