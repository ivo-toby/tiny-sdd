#!/usr/bin/env node
// Experiment plumbing, not the proposed product CLI.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePi } from '../lib/capture-pi.mjs';
import { preparePiEnvironment } from '../lib/pi-environment.mjs';

const EXP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EXP, '../..');
const TARGET = '/home/ivo/workspace/mcp-podcast-generator';
const NODE = '/home/ivo/.local/share/mise/installs/node/24.15.0';
const RUNS = join(ROOT, 'experiments/runs/004-podcast-async-generation');
const TASKS = ['01-job-manager', '02-server-factories', '03-async-tools', '04-http-integration'];
const INPUTS = ['src', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'README.md', 'Dockerfile',
  'docs/SPEC-async-generation-publishing.md', 'docs/research-async-mcp-jobs.md', 'docs/implementation-plan-async-jobs.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function files(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed: ${path}`);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`Not a file/directory: ${path}`);
  return (await Promise.all((await readdir(path)).sort().map(n => files(join(path, n))))).flat();
}
async function copy(source, dest) {
  for (const path of await files(source)) {
    const to = (await lstat(source)).isFile() ? dest : join(dest, relative(source, path));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(path, to);
  }
}
async function records(directory, skip = new Set()) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    if (skip.has(name)) continue;
    for (const path of await files(join(directory, name))) {
      const bytes = await readFile(path);
      output.push({ path: relative(directory, path), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return output;
}
async function snapshot(manifest, destination) {
  const hashes = await records(manifest.workspace, new Set(['.verification', 'node_modules']));
  for (const record of hashes) {
    const to = join(destination, record.path);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(manifest.workspace, record.path), to);
  }
  return hashes;
}
async function readRun(path) {
  const run = resolve(path);
  const rel = relative(RUNS, run);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Not an experiment run');
  const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
  if (manifest.run !== run || manifest.experiment !== '004-podcast-async-generation') throw new Error('Manifest identity mismatch');
  if (dirname(manifest.workspace) !== '/tmp' || !basename(manifest.workspace).startsWith('tinysdd-podcast-workspace-')) throw new Error('Workspace is not a minted disposable directory');
  const workspaceStat = await lstat(manifest.workspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error('Workspace identity invalid');
  for (const item of manifest.frozen) {
    if (typeof item.path !== 'string' || isAbsolute(item.path) || !item.path || relative(ROOT, resolve(ROOT, item.path)).startsWith('..')) throw new Error('Frozen path escaped root');
    for (const path of [join(run, 'frozen', item.path), join(ROOT, item.path)]) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Frozen/live input must be a regular file');
    }
    const bytes = await readFile(join(run, 'frozen', item.path));
    if (sha(bytes) !== item.sha256) throw new Error(`Frozen input changed: ${item.path}`);
    if (sha(await readFile(join(ROOT, item.path))) !== item.sha256) throw new Error(`Live experiment input changed after freezing: ${item.path}`);
  }
  return manifest;
}
async function init() {
  // Check the exact source/document fingerprint independently of Git tracking.
  const inventory = await readFile(join(EXP, 'baseline-inventory.md'), 'utf8');
  for (const match of inventory.matchAll(/\| `([^`]+)` \| \d+ \| `([a-f0-9]{64})` \|/g)) {
    if (sha(await readFile(join(TARGET, match[1]))) !== match[2]) throw new Error(`Baseline drift: ${match[1]}`);
  }
  const prepared = await preparePiEnvironment('qwen');
  if (prepared.metadata.piVersion !== '0.84.4') throw new Error('Pi version drift');
  if (Object.keys(prepared.metadata.advertisedModel).some(k => /api.?key|headers|secret|password/i.test(k))) throw new Error('Unexpected model-level credentials');
  await mkdir(RUNS, { recursive: true });
  const run = join(RUNS, `qwen-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(run);
  const workspace = await mkdtemp('/tmp/tinysdd-podcast-workspace-');
  for (const name of INPUTS) await copy(join(TARGET, name), join(workspace, name));
  for (const name of ['feature.md', 'protocol.md', 'approval.md', 'baseline-inventory.md', 'tasks']) await copy(join(EXP, name), join(workspace, name));
  await mkdir(join(workspace, 'evidence'));
  await mkdir(join(workspace, '.verification'));
  const sources = [EXP, join(ROOT, 'experiments/003-idempotent-reservations/skills'), join(ROOT, 'experiments/lib/capture-pi.mjs'), join(ROOT, 'experiments/lib/pi-environment.mjs')];
  for (const source of sources) await copy(source, join(run, 'frozen', relative(ROOT, source)));
  const frozen = await records(join(run, 'frozen'));
  await mkdir(join(run, 'sessions'));
  const manifest = { experiment: '004-podcast-async-generation', run, workspace, createdAt: new Date().toISOString(),
    runtime: prepared.metadata, frozen, approval: 'Actual user delegation in frozen approval.md; primary review controls progression',
    limits: { invocationsPerTask: 3, invocationTimeoutMs: 900000, invocationToolStarts: 100 },
    tasks: Object.fromEntries(TASKS.map(t => [t, { invocations: [], decision: 'pending' }])), preflight: 'pending' };
  manifest.baseline = await snapshot(manifest, join(run, 'baseline'));
  await json(join(run, 'manifest.json'), manifest);
  console.log(JSON.stringify({ run, workspace, provider: prepared.provider, model: prepared.modelId }));
}
function piMounts(m, stateDir) {
  const frozenExp = join(m.run, 'frozen/experiments/004-podcast-async-generation');
  return ['--unshare-user', '--unshare-pid', '--die-with-parent',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/worker',
    '--ro-bind', NODE, '/opt/node', '--bind', m.workspace, '/work',
    '--ro-bind', join(TARGET, 'node_modules'), '/work/node_modules',
    '--tmpfs', '/work/node_modules/.vite', '--tmpfs', '/work/node_modules/.vite-temp', '--tmpfs', '/work/node_modules/.cache',
    '--bind', stateDir, '/pi-state', '--bind', join(m.run, 'sessions'), '/sessions',
    '--ro-bind', join(m.run, 'frozen/experiments/003-idempotent-reservations/skills/tinysdd-task'), '/skill/tinysdd-task',
    '--ro-bind', join(frozenExp, 'verify.mjs'), '/tinysdd/verify.mjs',
    '--ro-bind', join(frozenExp, 'verify-inner.mjs'), '/tinysdd/verify-inner.mjs', '--chdir', '/work'];
}
function cleanRuntime(prepared) {
  const env = { PATH: '/opt/node/bin:/usr/bin:/bin', HOME: '/home/worker', TMPDIR: '/tmp', NODE_ENV: 'test',
    PI_CODING_AGENT_DIR: '/pi-state', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    TINYSDD_DEPENDENCIES_DIR: '/work/node_modules', TINYSDD_NODE_DIR: '/opt/node' };
  for (const key of prepared.metadata.credentialReferences) env[key] = prepared.env[key];
  return env;
}
async function invoke(path, task, feedbackPath) {
  const m = await readRun(path);
  const index = TASKS.indexOf(task);
  if (index < 0 || m.preflight !== 'passed') throw new Error('Unknown task or preflight not passed');
  if (TASKS.slice(0, index).some(t => m.tasks[t].decision !== 'accepted')) throw new Error('Prior task not accepted');
  const record = m.tasks[task];
  if (record.decision === 'accepted' || record.invocations.length >= 3) throw new Error('Task accepted or invocation budget exhausted');
  if (record.invocations.length > 0 && !feedbackPath) throw new Error('Revision requires recorded feedback');
  if (record.invocations.length === 0 && feedbackPath) throw new Error('Initial invocation cannot have review feedback');
  const prepared = await preparePiEnvironment('qwen');
  if (JSON.stringify(prepared.metadata) !== JSON.stringify(m.runtime)) throw new Error('Runtime drift');
  const number = record.invocations.length + 1;
  const phase = join(m.run, task, `invocation-${number}`);
  await mkdir(phase, { recursive: true });
  if (feedbackPath) {
    const rel = relative(m.run, resolve(feedbackPath));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Feedback must be a reviewed run-owned file');
    const stat = await lstat(resolve(feedbackPath));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Feedback must be a regular file');
  }
  const feedback = feedbackPath ? await readFile(resolve(feedbackPath), 'utf8') : '';
  const prompt = `/skill:tinysdd-task ${number === 1 ? 'ACTUAL USER-DELEGATED APPROVAL' : 'BOUNDED REVIEW REVISION'}: implement ONLY tasks/${task}.md against feature.md. The user said they trust the primary agent judgement and to run this checkpoint; approval.md records that delegation. Primary has approved this task and prerequisites. Old draft labels in task packets are superseded by this explicit approval.\n`
    + `Read the task packet and relevant code before editing. Use read/write/edit and bash as needed inside /work. Do not use WDD or global code-style skills. Never inspect environment variables, /proc, credentials, /pi-state, /sessions or files outside the workspace except installed dependencies, the supplied task skill and verifier. No network calls, dependency installs, Git changes or real generation/publishing.\n`
    + `IMPORTANT VERIFICATION: do not run npm test, tsc, node tests, servers or generated code directly. Run all build/tests through: node /tinysdd/verify.mjs /work /work/.verification/${task}-inv${number}-CHECKNAME 0 (choose a new CHECKNAME each time). This runs your real tests and build with private /tmp and no external network, writes observed logs/result.json to that folder, and leaves original files alone. Read those logs. You may inspect source with ordinary commands.\n`
    + `Implement only the packet write set. Record your evidence in /work/evidence/task-${task.slice(0, 2)}.md (collected into the experiment run, not delivered as product code). Preserve all original and accepted prior-task assertions. State any missing behavior-specific red evidence honestly. Return self-review and observed checks, then stop; do not implement the next task.\n`
    + (feedback ? `\nPRIMARY REVIEW FEEDBACK (exact permitted revision):\n${feedback}\n` : '');
  await writeFile(join(phase, 'prompt.txt'), prompt, { mode: 0o600 });
  const before = await snapshot(m, join(phase, 'before'));
  const item = { number, startedAt: new Date().toISOString(), promptSha256: sha(prompt), before, status: 'running' };
  record.invocations.push(item);
  await json(join(m.run, 'manifest.json'), m);
  const args = [...piMounts(m, prepared.stateDir), '/opt/node/bin/pi', '--offline', '--print', '--mode', 'json', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-approve', '--tools', 'read,write,edit,bash', '--thinking', 'off',
    '--provider', prepared.provider, '--model', prepared.modelId, '--session', `/sessions/${task}.jsonl`, '--skill', '/skill/tinysdd-task/SKILL.md', prompt];
  item.capture = await capturePi({ executable: '/usr/bin/bwrap', args, cwd: m.workspace, env: cleanRuntime(prepared),
    outputDir: join(phase, 'capture'), timeoutMs: 900000, maxToolCalls: 100 });
  item.after = await snapshot(m, join(phase, 'after'));
  const old = new Map(before.map(r => [r.path, r.sha256]));
  const now = new Map(item.after.map(r => [r.path, r.sha256]));
  item.changed = [...new Set([...old.keys(), ...now.keys()])].filter(p => old.get(p) !== now.get(p)).sort();
  item.status = 'awaiting_primary_review';
  item.endedAt = new Date().toISOString();
  await json(join(m.run, 'manifest.json'), m);
  console.log(JSON.stringify({ run: m.run, task, invocation: number, stopReason: item.capture.stopReason, toolStarts: item.capture.counts.toolExecutionStarts, wallMs: item.capture.wallMs, changed: item.changed }));
}
async function smoke(path) {
  const m = await readRun(path);
  const stateDir = await mkdtemp('/tmp/tinysdd-podcast-smoke-state-');
  const args = [...piMounts(m, stateDir), '/opt/node/bin/node', '/tinysdd/verify.mjs', '/work', `/work/.verification/nested-baseline-${randomUUID().slice(0, 8)}`, '0'];
  // No inference configuration or credentials are needed for this test.
  const result = spawnSync('/usr/bin/bwrap', args, { env: cleanRuntime({ metadata: { credentialReferences: [] } }), encoding: 'utf8', timeout: 120000 });
  const report = { args, exitCode: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  await json(join(m.run, 'nested-verifier-smoke.json'), report);
  console.log(JSON.stringify(report));
  process.exitCode = result.status === 0 ? 0 : 1;
}
async function decide(path, task, verdict, evidencePath) {
  const m = await readRun(path);
  if (!isAbsolute(evidencePath) || !relative(m.run, evidencePath) || relative(m.run, evidencePath).startsWith('..')) throw new Error('Evidence must be inside this run');
  const evidence = await readFile(evidencePath, 'utf8');
  if (!evidence.trim()) throw new Error('Empty decision evidence');
  const decision = { at: new Date().toISOString(), verdict, authority: 'primary agent under actual operator delegation',
    evidence: relative(m.run, evidencePath), evidenceSha256: sha(evidence) };
  if (task === 'preflight' && verdict === 'passed') {
    m.preflight = 'passed';
    m.preflightDecision = decision;
  } else {
    if (!TASKS.includes(task) || !['accepted', 'revision', 'blocked'].includes(verdict)) throw new Error('Unsupported decision');
    m.tasks[task].decision = verdict;
    (m.tasks[task].reviews ??= []).push(decision);
  }
  await json(join(m.run, 'manifest.json'), m);
  console.log(JSON.stringify({ task, ...decision }));
}
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'init' && args.length === 0) await init();
  else if (command === 'run' && (args.length === 2 || args.length === 3)) await invoke(...args);
  else if (command === 'smoke' && args.length === 1) await smoke(args[0]);
  else if (command === 'decide' && args.length === 4) await decide(...args);
  else throw new Error('Usage: run.mjs init | smoke RUN | run RUN TASK [FEEDBACK] | decide RUN TASK VERDICT EVIDENCE');
} catch (error) { console.error(error.message); process.exitCode = 1; }
