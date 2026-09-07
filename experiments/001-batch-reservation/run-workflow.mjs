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
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePi } from '../lib/capture-pi.mjs';
import { preparePiEnvironment } from '../lib/pi-environment.mjs';

const REPOSITORY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPERIMENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const EXPERIMENTS_DIR = dirname(EXPERIMENT_DIR);
const RUNS_ROOT = join(EXPERIMENTS_DIR, 'runs');
const DEFAULT_EXPERIMENT_ID = '001-batch-reservation';
const EXPERIMENT_IDS = new Set([DEFAULT_EXPERIMENT_ID, '002-label-truncation']);
const SKILL_DIR = join(REPOSITORY_DIR, 'skills/tinysdd');
const TASK_TIMEOUT_MS = 180_000;
const MAX_INVOCATIONS = 2;
const MAX_TOOL_STARTS = 60;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

const COMMON_PROMPT = "Implement the change described in TASK.md using the repository files as the source of truth. Work only in this disposable repository and stay within TASK.md's edit scope. Do not use the network, inspect environment variables, install dependencies, or make Git changes. This is a synthetic experiment, not production work. Report actual verification results and any unresolved questions.";
const APPROVAL_PROMPT = 'SIMULATED BENCHMARK USER APPROVAL (not an actual human approval): the task brief is approved to the extent it matches TASK.md. Implement that scope now, including tests. No extra behavior is authorized. Stop and report any unresolved contract contradiction; do not infer a new requirement.';

function usage() {
  return 'Usage: node run-workflow.mjs start <qwen|gemma|nemotron> <baseline|treatment> '
    + '[--experiment <experiment-id>] [--skill-dir <absolute-repo-directory>]\n'
    + '   or: node run-workflow.mjs continue <absolute-run-dir>';
}

function experimentPaths(experimentId) {
  if (!EXPERIMENT_IDS.has(experimentId)) throw new Error(`Unknown experiment: ${experimentId}`);
  const directory = join(EXPERIMENTS_DIR, experimentId);
  return {
    id: experimentId,
    directory,
    fixtureDir: join(directory, 'fixture'),
    checksPath: join(directory, 'checks/acceptance.test.mjs'),
    qualificationPath: join(directory, 'workflow-qualification.md'),
    protocolPath: join(directory, 'protocol.md'),
    runsDir: join(RUNS_ROOT, experimentId),
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkedEntries(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`);
  if (info.isDirectory()) return { info, entries: await readdir(path) };
  if (!info.isFile()) throw new Error(`Only regular files and directories are allowed: ${path}`);
  return { info, entries: [] };
}

async function filesUnder(path) {
  const { info, entries } = await checkedEntries(path);
  if (info.isFile()) return [path];
  const files = [];
  for (const entry of entries.sort()) files.push(...await filesUnder(join(path, entry)));
  return files;
}

async function copyTree(source, target) {
  const { info, entries } = await checkedEntries(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of entries.sort()) await copyTree(join(source, entry), join(target, entry));
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

function repositoryRelative(path) {
  const result = relative(REPOSITORY_DIR, path);
  if (!result || result.startsWith('..') || isAbsolute(result)) {
    throw new Error(`Source is outside repository: ${path}`);
  }
  return result;
}

async function snapshotSources(runDir, {
  fixtureDir,
  checksPath,
  skillDir,
  qualificationPath,
  protocolPath,
}) {
  const roots = [
    ['fixture', fixtureDir],
    ['skill', skillDir],
    ['checks', checksPath],
    ['runner', fileURLToPath(import.meta.url)],
    ['library', join(REPOSITORY_DIR, 'experiments/lib/capture-pi.mjs')],
    ['library', join(REPOSITORY_DIR, 'experiments/lib/pi-environment.mjs')],
  ];
  if (await exists(qualificationPath)) roots.push(['qualification', qualificationPath]);
  if (await exists(protocolPath)) roots.push(['protocol', protocolPath]);
  const records = [];
  for (const [group, root] of roots) {
    for (const source of await filesUnder(root)) {
      const bytes = await readFile(source);
      const path = repositoryRelative(source);
      const snapshot = join(runDir, 'sources', path);
      await mkdir(dirname(snapshot), { recursive: true });
      await writeFile(snapshot, bytes, { encoding: 'buffer', flag: 'wx', mode: 0o600 });
      records.push({
        group,
        path,
        snapshot: relative(runDir, snapshot),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function snapshotWorkspace(runDir, workspaceDir, phase) {
  const destination = join(runDir, 'workspace-after', phase);
  if (await exists(destination)) throw new Error(`Workspace snapshot already exists: ${destination}`);
  const records = [];
  for (const source of await filesUnder(workspaceDir)) {
    const bytes = await readFile(source);
    const path = relative(workspaceDir, source);
    const snapshot = join(destination, path);
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(snapshot, bytes, { encoding: 'buffer', flag: 'wx', mode: 0o600 });
    records.push({
      path,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { directory: relative(runDir, destination), files: records.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function snapshotSession(runDir, sessionPath, phase) {
  const info = await lstat(sessionPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Session must be a regular file: ${sessionPath}`);
  const bytes = await readFile(sessionPath);
  if (bytes.byteLength === 0) throw new Error(`Session must be nonempty: ${sessionPath}`);
  const destination = join(runDir, 'session-after', `${phase}.jsonl`);
  if (await exists(destination)) throw new Error(`Session snapshot already exists: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { encoding: 'buffer', flag: 'wx', mode: 0o600 });
  return {
    path: relative(runDir, sessionPath),
    snapshot: relative(runDir, destination),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function writeManifest(runDir, manifest) {
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(runDir) {
  return JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
}

function commandArgs({ runDir, provider, modelId, arm, prompt, skillPath }) {
  const args = [
    '--offline',
    '--print',
    '--mode',
    'json',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
    '--tools',
    'read,write,edit,bash',
    '--thinking',
    'off',
    '--provider',
    provider,
    '--model',
    modelId,
    '--session',
    join(runDir, 'session.jsonl'),
  ];
  if (arm === 'treatment') args.push('--skill', skillPath);
  args.push(prompt);
  if (args.includes('--no-session')) throw new Error('The workflow must retain Pi sessions');
  return args;
}

function relativeWorkspacePath(path, workspaceDir) {
  if (typeof path !== 'string') return path;
  if (!isAbsolute(path)) return path;
  const result = relative(workspaceDir, path);
  return result && !result.startsWith('..') && !isAbsolute(result) ? result : path;
}

function toolArgs(toolName, args, workspaceDir) {
  if (!args || typeof args !== 'object') return {};
  if (toolName === 'bash') return { command: typeof args.command === 'string' ? args.command : null };
  if (['read', 'write', 'edit'].includes(toolName)) {
    return { path: relativeWorkspacePath(args.path, workspaceDir) };
  }
  return {};
}

function assistantText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

async function phaseSummary(captureDir, workspaceDir) {
  const stdout = await readFile(join(captureDir, 'stdout.jsonl'), 'utf8');
  const events = [];
  const parseErrors = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, message: errorText(error) });
    }
  }

  const starts = new Map();
  for (const event of events) {
    if (event?.type === 'tool_execution_start') {
      starts.set(event.toolCallId ?? event.id ?? starts.size, event);
    }
  }
  const successfulObservations = [];
  const changed = [];
  for (const event of events) {
    if (event?.type !== 'tool_execution_end' || event.isError !== false) continue;
    const start = starts.get(event.toolCallId ?? event.id);
    const toolName = event.toolName ?? start?.toolName;
    if (!['read', 'write', 'edit', 'bash'].includes(toolName)) continue;
    const args = toolArgs(toolName, start?.args, workspaceDir);
    successfulObservations.push({
      toolCallId: event.toolCallId ?? event.id ?? null,
      toolName,
      args,
    });
    if ((toolName === 'write' || toolName === 'edit') && typeof args.path === 'string') changed.push(args.path);
  }
  const messages = events
    .filter((event) => event?.type === 'message_end' && event.message?.role === 'assistant')
    .map((event) => event.message);
  const errors = messages
    .filter((message) => message.stopReason === 'error' || message.errorMessage)
    .map((message) => message.errorMessage ?? assistantText(message));
  const uniqueChanged = [...new Set(changed)];
  return {
    successfulObservations,
    codeChangedPaths: uniqueChanged,
    testChangedPaths: uniqueChanged.filter((path) => /(^|[\\/])tests?([\\/]|$)|\.test\./i.test(path)),
    assistantFinalText: messages.length ? assistantText(messages.at(-1)) : '',
    assistantErrors: errors,
    parseErrors,
  };
}

function phaseIsCompleted(capture, summary, sessionSnapshot) {
  return Boolean(
    capture
      && capture.stopReason === 'completed'
      && capture.exitCode === 0
      && capture.output?.stdoutBytes > 0
      && capture.output?.stdoutTruncated === false
      && capture.output?.stderrTruncated === false
      && capture.parseErrors?.length === 0
      && summary.parseErrors.length === 0
      && summary.assistantErrors.length === 0
      && sessionSnapshot,
  );
}

function totals(manifest, currentCapture) {
  const previous = Object.values(manifest.phases)
    .filter(Boolean)
    .reduce((total, phase) => ({
      wallMs: total.wallMs + (phase.capture?.wallMs ?? 0),
      toolStarts: total.toolStarts + (phase.capture?.counts?.toolExecutionStarts ?? 0),
    }), { wallMs: 0, toolStarts: 0 });
  const currentWallMs = currentCapture?.wallMs ?? 0;
  const current = currentCapture?.counts?.toolExecutionStarts ?? 0;
  const elapsedMs = previous.wallMs + currentWallMs;
  return {
    elapsedMs,
    remainingWallMs: Math.max(0, TASK_TIMEOUT_MS - elapsedMs),
    observedToolStarts: previous.toolStarts + current,
    remainingToolStarts: Math.max(0, MAX_TOOL_STARTS - previous.toolStarts - current),
  };
}

async function runPhase({ manifest, phaseName, invocation, prepared, prompt, skillPath, timeoutMs, maxToolCalls }) {
  const captureDir = join(manifest.runDirectory, 'phases', phaseName, 'capture');
  if (await exists(captureDir)) throw new Error(`Phase output already exists: ${captureDir}`);
  const args = commandArgs({
    runDir: manifest.runDirectory,
    provider: prepared.provider,
    modelId: prepared.modelId,
    arm: manifest.arm,
    prompt,
    skillPath,
  });
  let capture = null;
  let captureError = null;
  const phaseStartedAt = Date.now();
  try {
    capture = await capturePi({
      executable: 'pi',
      args,
      cwd: manifest.workspaceDir,
      env: prepared.env,
      outputDir: captureDir,
      timeoutMs,
      maxToolCalls,
    });
  } catch (error) {
    captureError = errorText(error);
  }

  let summary = {
    successfulObservations: [],
    codeChangedPaths: [],
    testChangedPaths: [],
    assistantFinalText: '',
    assistantErrors: captureError ? [captureError] : [],
    parseErrors: [],
  };
  if (capture) {
    try {
      summary = await phaseSummary(captureDir, manifest.workspaceDir);
    } catch (error) {
      summary.parseErrors.push({ line: null, message: errorText(error) });
    }
  }

  let workspaceSnapshot = null;
  let snapshotError = null;
  try {
    workspaceSnapshot = await snapshotWorkspace(manifest.runDirectory, manifest.workspaceDir, phaseName);
  } catch (error) {
    snapshotError = errorText(error);
  }

  let sessionSnapshot = null;
  let sessionError = null;
  try {
    sessionSnapshot = await snapshotSession(manifest.runDirectory, manifest.sessionPath, phaseName);
  } catch (error) {
    sessionError = errorText(error);
  }

  const completed = phaseIsCompleted(capture, summary, sessionSnapshot);
  const budget = totals(manifest, capture);
  const runtimeFailure = Boolean(captureError || snapshotError || sessionError || !completed);
  return {
    invocation,
    status: runtimeFailure ? 'runtime_failure' : phaseName === 'start' ? 'first_exchange_complete' : 'completed',
    startedAt: new Date(phaseStartedAt).toISOString(),
    elapsedMs: Date.now() - phaseStartedAt,
    prompt,
    command: { executable: 'pi', args },
    runtime: prepared.metadata,
    timeoutMs,
    maxToolCalls,
    captureCompleted: completed,
    capture: capture
      ? { ...capture, resultPath: relative(manifest.runDirectory, join(captureDir, 'result.json')) }
      : null,
    captureError,
    workspaceSnapshot,
    snapshotError,
    sessionSnapshot,
    sessionError,
    summary: {
      ...summary,
      tokenUsage: 'UNKNOWN (streaming usage is unavailable)',
      budget,
    },
  };
}

async function makeRunDirectory(experimentId, participant, arm) {
  const experiment = experimentPaths(experimentId);
  await mkdir(experiment.runsDir, { recursive: true });
  const suffix = randomUUID().slice(0, 8);
  const name = `workflow-${new Date().toISOString().replace(/[:.]/g, '-')}-${participant}-${arm}-${suffix}`;
  const runDirectory = join(experiment.runsDir, name);
  await mkdir(runDirectory);
  return runDirectory;
}

function output(manifest) {
  console.log(JSON.stringify({
    runDirectory: manifest.runDirectory,
    status: manifest.status,
    invocationCount: manifest.invocationCount,
    observedToolStarts: manifest.phases.continue?.summary?.budget?.observedToolStarts
      ?? manifest.phases.start?.summary?.budget?.observedToolStarts
      ?? 0,
  }));
}

function parseStartArgs(args) {
  if (args.length < 2) throw new Error(usage());
  const [participant, arm] = args;
  if (!['qwen', 'gemma', 'nemotron'].includes(participant)) throw new Error('Unknown participant');
  if (!['baseline', 'treatment'].includes(arm)) throw new Error('Unknown arm');

  let experimentId = DEFAULT_EXPERIMENT_ID;
  let skillDir = null;
  let experimentSeen = false;
  let skillDirSeen = false;
  for (let index = 2; index < args.length;) {
    const option = args[index];
    if (option === '--experiment') {
      if (experimentSeen) throw new Error('Duplicate --experiment option');
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--experiment requires a value');
      if (!EXPERIMENT_IDS.has(value)) throw new Error(`Unknown experiment: ${value}`);
      experimentSeen = true;
      experimentId = value;
      index += 2;
      continue;
    }
    if (option === '--skill-dir') {
      if (arm === 'baseline') throw new Error('--skill-dir is only valid for treatment');
      if (skillDirSeen) throw new Error('Duplicate --skill-dir option');
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--skill-dir requires a value');
      if (!isAbsolute(value)) throw new Error('--skill-dir requires an absolute path');
      skillDirSeen = true;
      skillDir = value;
      index += 2;
      continue;
    }
    throw new Error(`Unknown start option: ${option}`);
  }
  return { participant, arm, experimentId, skillDir };
}

async function validateSkillDir(path) {
  const selected = resolve(path);
  const repositoryPath = relative(REPOSITORY_DIR, selected);
  if (!repositoryPath || repositoryPath.startsWith('..') || isAbsolute(repositoryPath)) {
    throw new Error(`Skill directory is outside repository: ${path}`);
  }
  const { info } = await checkedEntries(selected);
  if (!info.isDirectory()) throw new Error(`Skill directory must be a directory: ${path}`);
  return selected;
}

async function start(participant, arm, experimentId = DEFAULT_EXPERIMENT_ID, skillDirOption = null) {
  const experiment = experimentPaths(experimentId);
  const selectedSkillDir = await validateSkillDir(skillDirOption ?? SKILL_DIR);
  const prepared = await preparePiEnvironment(participant);
  const runDirectory = await makeRunDirectory(experiment.id, participant, arm);
  const workspaceDir = await mkdtemp(join(tmpdir(), 'tinysdd-workflow-workspace-'));
  await copyTree(experiment.fixtureDir, workspaceDir);

  let skillResourceDir = null;
  let skillPath = null;
  if (arm === 'treatment') {
    skillResourceDir = await mkdtemp(join(tmpdir(), 'tinysdd-workflow-resource-'));
    const copiedSkillDir = join(skillResourceDir, 'tinysdd');
    await copyTree(selectedSkillDir, copiedSkillDir);
    skillPath = join(copiedSkillDir, 'SKILL.md');
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'exploratory-skill-workflow',
    runId: relative(experiment.runsDir, runDirectory),
    experimentId: experiment.id,
    runDirectory,
    participant,
    arm,
    workspaceDir,
    sessionPath: join(runDirectory, 'session.jsonl'),
    skillResourceDir,
    skillPath,
    skillSourcePath: selectedSkillDir,
    startedAt: new Date().toISOString(),
    startedAtEpochMs: Date.now(),
    prompts: {
      common: COMMON_PROMPT,
      start: arm === 'treatment' ? `/skill:tinysdd ${COMMON_PROMPT}` : COMMON_PROMPT,
      approval: APPROVAL_PROMPT,
    },
    runtime: prepared.metadata,
    limits: {
      maxInvocations: MAX_INVOCATIONS,
      taskTimeoutMs: TASK_TIMEOUT_MS,
      maxObservedToolStarts: MAX_TOOL_STARTS,
      maxStreamBytes: MAX_STREAM_BYTES,
      tokenBudget: 'UNKNOWN',
    },
    sourceHashes: await snapshotSources(runDirectory, {
      fixtureDir: experiment.fixtureDir,
      checksPath: experiment.checksPath,
      skillDir: selectedSkillDir,
      qualificationPath: experiment.qualificationPath,
      protocolPath: experiment.protocolPath,
    }),
    phases: { start: null, continue: null },
    invocationCount: 0,
    continueUsed: false,
    status: 'starting',
  };
  await writeManifest(runDirectory, manifest);

  const phase = { invocation: 1, status: 'running', prompt: manifest.prompts.start };
  manifest.phases.start = phase;
  await writeManifest(runDirectory, manifest);
  const result = await runPhase({
    manifest,
    phaseName: 'start',
    invocation: 1,
    prepared,
    prompt: manifest.prompts.start,
    skillPath,
    timeoutMs: TASK_TIMEOUT_MS,
    maxToolCalls: MAX_TOOL_STARTS,
  });
  manifest.phases.start = result;
  manifest.invocationCount = 1;
  const budget = result.summary.budget;
  if (result.status === 'first_exchange_complete') {
    manifest.status = budget.remainingWallMs > 0 && budget.remainingToolStarts > 0
      ? 'first_exchange_complete'
      : 'budget_exhausted';
  } else {
    manifest.status = result.status;
  }
  await writeManifest(runDirectory, manifest);
  output(manifest);
  return manifest.status === 'first_exchange_complete' ? 0 : 1;
}

async function verifySources(manifest) {
  for (const record of manifest.sourceHashes ?? []) {
    const bytes = await readFile(join(manifest.runDirectory, record.snapshot));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== record.sha256) throw new Error(`Initial source snapshot changed: ${record.path}`);
  }
}

async function verifySessionUnchanged(manifest) {
  const expected = manifest.phases.start?.sessionSnapshot;
  if (!expected?.sha256) throw new Error('The first phase has no retained session snapshot');
  const expectedPath = join(manifest.runDirectory, 'session.jsonl');
  if (manifest.sessionPath !== expectedPath) throw new Error('Session path does not belong to this run');
  const info = await lstat(expectedPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Session must be a regular file');
  const bytes = await readFile(expectedPath);
  if (bytes.byteLength === 0) throw new Error('Session must be nonempty');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.sha256) throw new Error('Session changed after the first phase');
}

async function continueRun(argument) {
  if (!isAbsolute(argument)) throw new Error('continue requires an absolute run directory');
  const runDirectory = resolve(argument);
  const runInfo = await lstat(runDirectory);
  if (runInfo.isSymbolicLink() || !runInfo.isDirectory()) throw new Error('Run directory must be a regular directory');
  const manifest = await readManifest(runDirectory);
  if (manifest.runDirectory !== runDirectory) throw new Error('Manifest run directory does not match argument');
  if (manifest.continueUsed || manifest.invocationCount >= MAX_INVOCATIONS || manifest.phases.continue) {
    throw new Error('A run may have at most one continuation');
  }
  if (manifest.status !== 'first_exchange_complete' || !manifest.phases.start?.captureCompleted) {
    throw new Error('Continuation requires a completed first exchange');
  }
  const current = manifest.phases.start.summary?.budget;
  if (!current || current.remainingWallMs <= 0 || current.remainingToolStarts <= 0) {
    throw new Error('Continuation budget is exhausted');
  }
  await verifySources(manifest);
  await verifySessionUnchanged(manifest);
  const workspaceInfo = await lstat(manifest.workspaceDir);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new Error('Workspace must be a regular directory');
  if (manifest.arm === 'treatment') {
    if (!manifest.skillPath || !isAbsolute(manifest.skillPath)) throw new Error('Treatment skill path is invalid');
    const skillInfo = await lstat(manifest.skillPath);
    if (skillInfo.isSymbolicLink() || !skillInfo.isFile()) throw new Error('Treatment skill path is unavailable');
  }

  const prepared = await preparePiEnvironment(manifest.participant);
  if (
    prepared.provider !== manifest.runtime.provider
    || prepared.modelId !== manifest.runtime.modelId
    || prepared.metadata.profileSha256 !== manifest.runtime.profileSha256
    || prepared.metadata.piVersion !== manifest.runtime.piVersion
  ) {
    throw new Error('Participant runtime identity changed between invocations');
  }
  manifest.phases.continue = { invocation: 2, status: 'running', prompt: manifest.prompts.approval };
  await writeManifest(runDirectory, manifest);
  const result = await runPhase({
    manifest,
    phaseName: 'continue',
    invocation: 2,
    prepared,
    prompt: manifest.prompts.approval,
    skillPath: manifest.skillPath,
    timeoutMs: current.remainingWallMs,
    maxToolCalls: current.remainingToolStarts,
  });
  manifest.phases.continue = result;
  manifest.continueUsed = true;
  manifest.invocationCount = 2;
  manifest.status = result.status === 'completed' ? 'completed' : result.status;
  await writeManifest(runDirectory, manifest);
  output(manifest);
  return manifest.status === 'completed' ? 0 : 1;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'start') {
    const { participant, arm, experimentId, skillDir } = parseStartArgs(args);
    return start(participant, arm, experimentId, skillDir);
  }
  if (command === 'continue' && args.length === 1) return continueRun(args[0]);
  throw new Error(usage());
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(errorText(error));
    console.error(usage());
    process.exitCode = 1;
  });
