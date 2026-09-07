#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePi } from '../lib/capture-pi.mjs';
import { preparePiEnvironment } from '../lib/pi-environment.mjs';

const REPOSITORY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPERIMENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = join(REPOSITORY_DIR, 'experiments/runs/003-idempotent-reservations');
const PARTICIPANTS = new Set(['qwen', 'gemma', 'nemotron']);
const TASKS = new Set(['01-validation', '02-service', '03-api']);
const PI_VERSION = '0.84.4';
const MAX_INVOCATIONS = 2;
const MAX_WALL_MS = 360_000;
const MAX_TOOL_STARTS = 60;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

const sourceRoots = [
  ['feature', join(EXPERIMENT_DIR, 'feature.md')],
  ['tasks', join(EXPERIMENT_DIR, 'tasks')],
  ['skills', join(EXPERIMENT_DIR, 'skills')],
  ['fixture', join(EXPERIMENT_DIR, 'fixture')],
  ['checks', join(EXPERIMENT_DIR, 'checks')],
  ['protocol', join(EXPERIMENT_DIR, 'protocol.md')],
  ['reference', join(EXPERIMENT_DIR, 'reference')],
  ['runner', fileURLToPath(import.meta.url)],
  ['library', join(REPOSITORY_DIR, 'experiments/lib/capture-pi.mjs')],
  ['library', join(REPOSITORY_DIR, 'experiments/lib/pi-environment.mjs')],
];

const errorText = (error) => error instanceof Error ? error.message : String(error);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function entry(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`);
  if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported path: ${path}`);
  return info;
}

async function filesUnder(path) {
  const info = await entry(path);
  if (info.isFile()) return [path];
  const files = [];
  for (const name of (await readdir(path)).sort()) files.push(...await filesUnder(join(path, name)));
  return files;
}

async function copyTree(source, target) {
  const info = await entry(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of (await readdir(source)).sort()) await copyTree(join(source, name), join(target, name));
  } else {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

function repoPath(path) {
  const result = relative(REPOSITORY_DIR, resolve(path));
  if (!result || result.startsWith('..') || isAbsolute(result)) throw new Error(`Path is outside repository: ${path}`);
  return result;
}

async function snapshotFiles(runDirectory) {
  const records = [];
  for (const [group, root] of sourceRoots) {
    for (const source of await filesUnder(root)) {
      const bytes = await readFile(source);
      const path = repoPath(source);
      const snapshot = join(runDirectory, 'sources', path);
      await mkdir(dirname(snapshot), { recursive: true });
      await writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
      records.push({ group, path, snapshot: relative(runDirectory, snapshot), bytes: bytes.byteLength, sha256: digest(bytes) });
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function snapshotWorkspace(runDirectory, workspace, task, invocation, phase) {
  const destination = join(runDirectory, phase, task, `invocation-${String(invocation).padStart(2, '0')}`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  const records = [];
  for (const source of await filesUnder(workspace)) {
    const path = relative(workspace, source);
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error(`Workspace path escaped: ${source}`);
    const bytes = await readFile(source);
    const snapshot = join(destination, path);
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
    records.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
  }
  return { directory: relative(runDirectory, destination), files: records.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function snapshotSession(runDirectory, sessionPath, task, invocation, phase) {
  try {
    const info = await lstat(sessionPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Session must be a regular file: ${sessionPath}`);
    const bytes = await readFile(sessionPath);
    if (bytes.byteLength === 0) throw new Error(`Session must be nonempty: ${sessionPath}`);
    const snapshot = join(runDirectory, phase, task, `invocation-${String(invocation).padStart(2, '0')}.jsonl`);
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
    return { path: relative(runDirectory, sessionPath), snapshot: relative(runDirectory, snapshot), bytes: bytes.byteLength, sha256: digest(bytes) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function writeManifest(runDirectory, manifest) {
  await writeFile(join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function readManifest(runDirectory) {
  return JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8'));
}

function initialPrompt(task) {
  return `/skill:tinysdd-task SIMULATED BENCHMARK OPERATOR APPROVAL, not actual human acceptance: implement only tasks/${task}.md against FEATURE.md. Read the task packet and its prerequisites before editing. Do not use the network, inspect environment variables, install dependencies, or make Git changes. Stay within the task scope packet. Log checks to check-output.txt. Do not start another task; return the evidence handoff for operator review.`;
}

function continuationPrompt(task, feedback = '') {
  return `/skill:tinysdd-task Continue only tasks/${task}.md against FEATURE.md in this same workspace. Re-read the task packet and prerequisites, preserve the packet scope, and do not start another task. Do not use the network, inspect environment variables, install dependencies, or make Git changes. Log checks to check-output.txt.\n\nPLANNED BENCHMARK REVIEW FEEDBACK (supplied text recorded verbatim; not an additional approval):\n${feedback}`;
}

function commandArgs(manifest, prepared, task, prompt) {
  return [
    '--offline', '--print', '--mode', 'json', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-approve', '--tools',
    'read,write,edit,bash', '--thinking', 'off', '--provider', prepared.provider,
    '--model', prepared.modelId, '--session', manifest.tasks[task].sessionPath,
    '--skill', manifest.skillPaths.task, prompt,
  ];
}

async function verifySources(manifest) {
  if (!Array.isArray(manifest.sourceHashes) || manifest.sourceHashes.length === 0) throw new Error('Manifest has no source hashes');
  for (const record of manifest.sourceHashes ?? []) {
    const snapshotPath = join(manifest.runDirectory, record.snapshot);
    if (relative(manifest.runDirectory, snapshotPath) !== record.snapshot) throw new Error(`Source snapshot escaped run: ${record.path}`);
    const snapshotInfo = await entry(snapshotPath);
    if (!snapshotInfo.isFile()) throw new Error(`Source snapshot is not a file: ${record.path}`);
    const snapshot = await readFile(snapshotPath);
    if (snapshot.byteLength !== record.bytes || digest(snapshot) !== record.sha256) throw new Error(`Source snapshot changed: ${record.path}`);
    const source = resolve(REPOSITORY_DIR, record.path);
    if (repoPath(source) !== record.path) throw new Error(`Source escaped repository: ${record.path}`);
    const sourceInfo = await entry(source);
    if (!sourceInfo.isFile()) throw new Error(`Source is not a file: ${record.path}`);
    const current = await readFile(source);
    if (current.byteLength !== record.bytes || digest(current) !== record.sha256) throw new Error(`Source changed after init: ${record.path}`);
  }
}

async function verifyManifest(manifest, runDirectory, task) {
  if (manifest.schemaVersion !== 1 || manifest.experimentId !== '003-idempotent-reservations') throw new Error('Unsupported task-run manifest');
  if (manifest.runDirectory !== runDirectory || !PARTICIPANTS.has(manifest.participant)) throw new Error('Manifest identity does not match run');
  if (!TASKS.has(task) || !manifest.tasks?.[task]) throw new Error(`Unknown task: ${task}`);
  const workspaceRelative = relative(RUNS_DIR, resolve(manifest.workspaceDir));
  const tempRelative = relative(resolve(tmpdir()), resolve(manifest.workspaceDir));
  if (!workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) throw new Error('Workspace must not be inside the run directory');
  if (!tempRelative || tempRelative.startsWith('..') || isAbsolute(tempRelative)) throw new Error('Workspace must be under the temporary directory');
  if (!basename(resolve(manifest.workspaceDir)).startsWith('tinysdd-task-workspace-')) throw new Error('Workspace name is not a minted task workspace');
  const workspaceInfo = await entry(manifest.workspaceDir);
  if (!workspaceInfo.isDirectory()) throw new Error('Workspace must be a directory');
  if (manifest.featurePath !== join(manifest.workspaceDir, 'FEATURE.md')
      || manifest.tasksPath !== join(manifest.workspaceDir, 'tasks')) throw new Error('Workspace packet paths changed');
  for (const path of [manifest.featurePath, manifest.tasksPath]) await entry(path);
  for (const path of [manifest.skillPaths?.prepare, manifest.skillPaths?.task]) {
    const pathRelative = relative(runDirectory, resolve(path));
    if (!pathRelative || pathRelative.startsWith('..') || isAbsolute(pathRelative)) throw new Error('Run resource escaped run directory');
    await entry(path);
  }
  await verifySources(manifest);
  const record = manifest.tasks[task];
  if (record.sessionPath !== join(runDirectory, 'sessions', `${task}.jsonl`)) throw new Error('Session path does not belong to this task');
  if (!Array.isArray(record.invocations) || record.invocations.length >= MAX_INVOCATIONS) throw new Error('Task already used both invocations');
  for (const kind of ['prepare', 'task']) {
    const source = manifest.sourceHashes.find((item) => item.path === `experiments/003-idempotent-reservations/skills/tinysdd-${kind}/SKILL.md`);
    const bytes = await readFile(manifest.skillPaths[kind]);
    if (!source || bytes.byteLength !== source.bytes || digest(bytes) !== source.sha256) throw new Error(`Skill resource changed: ${kind}`);
  }
  const featureRecord = manifest.sourceHashes.find((item) => item.group === 'feature');
  await entry(manifest.featurePath);
  const feature = await readFile(manifest.featurePath);
  if (!featureRecord || feature.byteLength !== featureRecord.bytes || digest(feature) !== featureRecord.sha256) throw new Error('FEATURE.md changed');
  const taskPrefix = 'experiments/003-idempotent-reservations/tasks/';
  for (const source of manifest.sourceHashes.filter((item) => item.path.startsWith(taskPrefix))) {
    const packetPath = join(manifest.tasksPath, source.path.slice(taskPrefix.length));
    await entry(packetPath);
    const packet = await readFile(packetPath);
    if (packet.byteLength !== source.bytes || digest(packet) !== source.sha256) throw new Error(`Task packet changed: ${source.path}`);
  }
  return record;
}

async function prepareParticipant(manifest) {
  const prepared = await preparePiEnvironment(manifest.participant);
  if (prepared.metadata.piVersion !== PI_VERSION
      || prepared.provider !== manifest.runtime.provider
      || prepared.modelId !== manifest.runtime.modelId
      || JSON.stringify(prepared.metadata) !== JSON.stringify(manifest.runtime)) {
    throw new Error('Participant runtime profile changed after init');
  }
  return prepared;
}

async function runTask(runDirectory, task, feedbackPath) {
  const manifest = await readManifest(runDirectory);
  const record = await verifyManifest(manifest, runDirectory, task);
  const invocation = record.invocations.length + 1;
  if (invocation === 1 && feedbackPath) throw new Error('Feedback requires a prior invocation');
  if (invocation === 1) {
    try { await lstat(record.sessionPath); throw new Error('Task session already exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const previous = record.invocations.at(-1);
  if (invocation === 2 && (!feedbackPath || !previous?.sessionAfter?.sha256 || previous.sessionAfter.bytes <= 0)) throw new Error('Continuation requires nonempty feedback and prior session');
  if (previous?.sessionAfter?.sha256) {
    const session = await readFile(record.sessionPath);
    if (digest(session) !== previous.sessionAfter.sha256) throw new Error('Session changed since the prior invocation');
  }
  const usedWall = record.invocations.reduce((n, item) => n + (item.capture?.wallMs ?? 0), 0);
  const usedTools = record.invocations.reduce((n, item) => n + (item.capture?.counts?.toolExecutionStarts ?? 0), 0);
  const timeoutMs = MAX_WALL_MS - usedWall;
  const maxToolCalls = MAX_TOOL_STARTS - usedTools;
  if (timeoutMs <= 0 || maxToolCalls <= 0) throw new Error('Task budget is exhausted');
  const prepared = await prepareParticipant(manifest);
  let feedback = '';
  if (feedbackPath) {
    const info = await entry(feedbackPath);
    if (!info.isFile()) throw new Error('Feedback must be a regular file');
    feedback = await readFile(feedbackPath, 'utf8');
    if (feedback.trim().length === 0) throw new Error('Feedback must be nonempty');
  }
  const prompt = invocation === 1 ? initialPrompt(task) : continuationPrompt(task, feedback);
  const phase = join(runDirectory, 'phases', task, `invocation-${String(invocation).padStart(2, '0')}`);
  const promptPath = join(phase, 'prompt.txt');
  await mkdir(dirname(phase), { recursive: true });
  await mkdir(phase, { recursive: false });
  await writeFile(promptPath, prompt, { flag: 'wx', mode: 0o600 });
  await mkdir(join(runDirectory, 'sessions'), { recursive: true });
  const beforeWorkspace = await snapshotWorkspace(runDirectory, manifest.workspaceDir, task, invocation, 'workspace-before');
  const beforeSession = await snapshotSession(runDirectory, record.sessionPath, task, invocation, 'session-before');
  const args = commandArgs(manifest, prepared, task, prompt);
  const item = {
    invocation,
    startedAt: new Date().toISOString(),
    promptPath: relative(runDirectory, promptPath),
    prompt,
    feedbackPath: feedbackPath ?? null,
    command: { executable: 'pi', args, cwd: manifest.workspaceDir },
    timeoutMs,
    maxToolCalls,
    workspaceBefore: beforeWorkspace,
    sessionBefore: beforeSession,
    capture: null,
    captureError: null,
    workspaceAfter: null,
    sessionAfter: null,
    status: 'running',
  };
  record.invocations.push(item);
  record.status = 'running';
  manifest.status = 'running';
  await writeManifest(runDirectory, manifest);
  try {
    item.capture = await capturePi({ executable: 'pi', args, cwd: manifest.workspaceDir, env: prepared.env, outputDir: join(phase, 'capture'), timeoutMs, maxToolCalls });
    item.command = item.capture.command;
  } catch (error) {
    item.captureError = errorText(error);
  }
  try { item.workspaceAfter = await snapshotWorkspace(runDirectory, manifest.workspaceDir, task, invocation, 'workspace-after'); }
  catch (error) { item.workspaceAfterError = errorText(error); }
  try { item.sessionAfter = await snapshotSession(runDirectory, record.sessionPath, task, invocation, 'session-after'); }
  catch (error) { item.sessionAfterError = errorText(error); }
  item.endedAt = new Date().toISOString();
  item.status = item.captureError || item.workspaceAfterError || item.sessionAfterError ? 'error' : 'captured';
  record.status = 'awaiting_operator';
  manifest.status = 'awaiting_operator';
  await writeManifest(runDirectory, manifest);
  console.log(JSON.stringify({ runDirectory, task, invocation, status: manifest.status, captureStopReason: item.capture?.stopReason ?? null }));
  return 0;
}

async function init(participant) {
  if (!PARTICIPANTS.has(participant)) throw new Error('Unknown participant');
  for (const [, path] of sourceRoots) await entry(path);
  const prepared = await preparePiEnvironment(participant);
  if (prepared.metadata.piVersion !== PI_VERSION) throw new Error(`Expected Pi ${PI_VERSION}`);
  await mkdir(RUNS_DIR, { recursive: true });
  const runDirectory = join(RUNS_DIR, `task-${new Date().toISOString().replace(/[:.]/g, '-')}-${participant}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDirectory);
  const workspaceDir = await mkdtemp(join(tmpdir(), 'tinysdd-task-workspace-'));
  await copyTree(join(EXPERIMENT_DIR, 'fixture'), workspaceDir);
  await copyFile(join(EXPERIMENT_DIR, 'feature.md'), join(workspaceDir, 'FEATURE.md'));
  await copyTree(join(EXPERIMENT_DIR, 'tasks'), join(workspaceDir, 'tasks'));
  const resourceRoot = join(runDirectory, 'resources', 'skills');
  await copyTree(join(EXPERIMENT_DIR, 'skills'), resourceRoot);
  const manifest = {
    schemaVersion: 1,
    kind: 'manual-exploratory-task-run',
    experimentId: '003-idempotent-reservations',
    runId: relative(RUNS_DIR, runDirectory),
    runDirectory,
    participant,
    workspaceDir,
    featurePath: join(workspaceDir, 'FEATURE.md'),
    tasksPath: join(workspaceDir, 'tasks'),
    skillPaths: {
      prepare: join(resourceRoot, 'tinysdd-prepare', 'SKILL.md'),
      task: join(resourceRoot, 'tinysdd-task', 'SKILL.md'),
    },
    sourceRoots: sourceRoots.map(([group, path]) => ({ group, path })),
    runtime: prepared.metadata,
    limits: {
      maxInvocationsPerTask: MAX_INVOCATIONS,
      maxCapturedWallMsPerTask: MAX_WALL_MS,
      maxObservedToolStartsPerTask: MAX_TOOL_STARTS,
      maxStreamBytes: MAX_STREAM_BYTES,
      tokenBudget: 'UNKNOWN',
    },
    sourceHashes: await snapshotFiles(runDirectory),
    tasks: Object.fromEntries([...TASKS].map((task) => [task, {
      packetPath: join(workspaceDir, 'tasks', `${task}.md`),
      sessionPath: join(runDirectory, 'sessions', `${task}.jsonl`),
      invocations: [],
      status: 'not_started',
    }])),
    createdAt: new Date().toISOString(),
    status: 'ready',
  };
  await writeManifest(runDirectory, manifest);
  console.log(JSON.stringify({ runDirectory, participant, status: manifest.status }));
  return 0;
}

function usage() {
  return 'Usage: node run-task.mjs init <qwen|gemma|nemotron>\n'
    + '   or: node run-task.mjs run <absolute-run-dir> <01-validation|02-service|03-api> [absolute-feedback-file]';
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'init' && args.length === 1) return init(args[0]);
  if (command === 'run' && (args.length === 2 || args.length === 3)) {
    if (!isAbsolute(args[0])) throw new Error('run directory must be absolute');
    const runDirectory = resolve(args[0]);
    const runInfo = await entry(runDirectory);
    const runRelative = relative(RUNS_DIR, runDirectory);
    if (!runInfo.isDirectory() || !runRelative || runRelative.startsWith('..') || isAbsolute(runRelative)) throw new Error('Run directory is outside experiment runs');
    const feedbackPath = args[2];
    if (feedbackPath && !isAbsolute(feedbackPath)) throw new Error('Feedback path must be absolute');
    return runTask(runDirectory, args[1], feedbackPath);
  }
  throw new Error(usage());
}

main(process.argv.slice(2)).catch((error) => {
  console.error(errorText(error));
  console.error(usage());
  process.exitCode = 1;
});
