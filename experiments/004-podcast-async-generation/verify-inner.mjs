#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const WORK = '/work';
const EVIDENCE = '/evidence';
const NODE = '/opt/node/bin/node';
const NPM = '/opt/node/bin/npm';
const COMMAND_TIMEOUT_MS = 110_000;

function errorInfo(error) {
  return error ? {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  } : null;
}

/** A deliberately small, framework-free environment for optional probes. */
export function probeCLIEnv({ mutant = process.env.TINYSDD_PROBE_MUTANT } = {}) {
  return {
    PATH: '/opt/node/bin:/usr/bin:/bin',
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    NODE_ENV: 'test',
    NPM_CONFIG_CACHE: '/tmp/npm-cache',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    TINYSDD_CANDIDATE_DIR: '/work/dist',
    TINYSDD_BASELINE_DIR: '/work/dist',
    TINYSDD_DEPENDENCIES_DIR: '/work/node_modules',
    TINYSDD_NODE_DIR: '/opt/node',
    ...(process.env.TINYSDD_CHECKS_DIR ? { TINYSDD_CHECKS_DIR: '/work/checks' } : {}),
    ...(process.env.TINYSDD_PROBE_DIR ? { TINYSDD_PROBE_DIR: '/probes' } : {}),
    ...(mutant ? { TINYSDD_PROBE_MUTANT: mutant } : {}),
  };
}

export const probeCLIenv = probeCLIEnv;

function tapCounts(text) {
  const counts = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null };
  text = stripVTControlCharacters(text);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/i);
    if (match) counts[match[1].toLowerCase()] = Number(match[2]);
  }
  const vitest = /^\s*Tests\s+(.+)$/mi.exec(text)?.[1];
  if (vitest) {
    counts.fail ??= 0;
    counts.cancelled ??= 0;
    counts.skipped ??= 0;
    counts.todo ??= 0;
    const passed = /(\d+)\s+passed/.exec(vitest);
    const failed = /(\d+)\s+failed/.exec(vitest);
    const cancelled = /(\d+)\s+cancelled/.exec(vitest);
    const skipped = /(\d+)\s+skipped/.exec(vitest);
    const todo = /(\d+)\s+todo/.exec(vitest);
    const total = /\((\d+)\)/.exec(vitest);
    if (passed) counts.pass = Number(passed[1]);
    if (failed) counts.fail = Number(failed[1]);
    if (cancelled) counts.cancelled = Number(cancelled[1]);
    if (skipped) counts.skipped = Number(skipped[1]);
    if (todo) counts.todo = Number(todo[1]);
    if (total) counts.tests = Number(total[1]);
    if (counts.tests === null && counts.pass !== null && counts.fail !== null) {
      counts.tests = counts.pass + counts.fail;
    }
  }
  return counts;
}

function testPass(outcome, counts) {
  return !outcome.timedOut && !outcome.spawnError && !outcome.captureError
    && outcome.exitCode === 0 && outcome.signal === null
    && counts.tests !== null && counts.tests > 0 && counts.pass === counts.tests
    && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* child already ended */ }
    }
  }
}

async function runCommand(name, executable, args, kind = 'test') {
  const stdoutPath = `${EVIDENCE}/${name}.stdout.txt`;
  const stderrPath = `${EVIDENCE}/${name}.stderr.txt`;
  const stdoutFile = await open(stdoutPath, 'wx', 0o600);
  const stderrFile = await open(stderrPath, 'wx', 0o600);
  const startedAt = Date.now();
  let timedOut = false;
  let spawnError = null;
  let captureError = null;
  let timer;
  let killTimer;
  let child;
  let outcome;
  try {
    outcome = await new Promise((finish) => {
      let settled = false;
      const done = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        finish({ exitCode, signal });
      };
      try {
        child = spawn(executable, args, {
          cwd: WORK,
          env: probeCLIEnv(),
          shell: false,
          detached: true,
          stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
        });
      } catch (error) {
        spawnError = errorInfo(error);
        done(null, null);
        return;
      }
      child.once('error', (error) => { spawnError = errorInfo(error); });
      child.once('close', (exitCode, signal) => done(exitCode, signal));
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 750);
      }, COMMAND_TIMEOUT_MS);
    });
  } finally {
    try { await stdoutFile.close(); } catch (error) { captureError = errorInfo(error); }
    try { await stderrFile.close(); } catch (error) { captureError = errorInfo(error); }
  }
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  try {
    stdout = await readFile(stdoutPath);
    stderr = await readFile(stderrPath);
  } catch (error) {
    captureError = errorInfo(error);
  }
  const counts = tapCounts(`${stdout.toString('utf8')}\n${stderr.toString('utf8')}`);
  return {
    name,
    kind,
    command: { executable, argv: [executable, ...args], cwd: WORK, env: probeCLIEnv() },
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    spawnError,
    captureError,
    elapsedMs: Date.now() - startedAt,
    stdout: { path: stdoutPath, bytes: stdout.byteLength },
    stderr: { path: stderrPath, bytes: stderr.byteLength },
    counts,
    pass: kind === 'build' || kind === 'probe'
      ? !timedOut && !spawnError && !captureError && outcome?.exitCode === 0 && outcome?.signal === null
      : testPass({ ...(outcome ?? {}), timedOut, spawnError, captureError }, counts),
  };
}

function skipped(name, reason, kind = 'check') {
  return { name, kind, skipped: true, reason, pass: false, counts: null };
}

const probeCode = `
const jobs = await import('/work/dist/jobs/job-manager.js');
const app = await import('/work/dist/server/create-app.js');
const mcp = await import('/work/dist/server/create-mcp-server.js');
for (const [label, value] of [
  ['candidate createJobManager', jobs.createJobManager],
  ['candidate createApp', app.createApp],
  ['candidate createMcpServer', mcp.createMcpServer],
]) if (typeof value !== 'function') throw new Error(label + ' export is missing');
console.log(JSON.stringify({ loaded: true, exports: ['createJobManager', 'createApp', 'createMcpServer'] }));
`;

async function stageProbeModules() {
  const copies = [
    { source: '/probes/jobs-reference.mjs', targets: ['/work/dist/jobs/job-manager.js'] },
    { source: '/probes/http-reference.mjs', targets: ['/work/dist/server/create-app.js', '/work/dist/server/create-mcp-server.js'] },
  ];
  for (const copy of copies) {
    for (const target of copy.targets) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(copy.source, target);
    }
  }
  return copies;
}

async function main(stage) {
  if (!Number.isInteger(stage) || stage < 0 || stage > 4) throw new Error('Stage must be 0 through 4');
  const commands = [];
  const build = await runCommand('build', NPM, ['run', 'build'], 'build');
  commands.push(build);
  const tests = await runCommand('original-tests', NPM, ['test'], 'test');
  commands.push(tests);

  const probeRequested = Boolean(process.env.TINYSDD_PROBE_DIR);
  let probeStage = null;
  if (probeRequested) {
    if (build.pass) {
      try {
        probeStage = { copies: await stageProbeModules() };
        commands.push(await runCommand('probe-imports', NODE, ['--input-type=module', '-e', probeCode], 'probe'));
      } catch (error) {
        probeStage = { error: errorInfo(error) };
        commands.push({ name: 'probe-stage', kind: 'probe', pass: false, error: errorInfo(error) });
      }
    } else {
      probeStage = { skipped: true, reason: 'build failed; post-build probe not staged' };
      commands.push(skipped('probe-imports', 'build failed; post-build probe not run', 'probe'));
    }
  }

  const checkNames = stage >= 3
    ? ['jobs.test.mjs', 'factories.test.mjs', 'http.test.mjs']
    : stage === 2
      ? ['jobs.test.mjs', 'factories.test.mjs']
      : stage === 1 ? ['jobs.test.mjs'] : [];
  for (const name of checkNames) {
    commands.push(build.pass
      ? await runCommand(`check-${name.replace('.test.mjs', '')}`, NODE,
        ['--test', '--test-reporter=tap', `/checks/${name}`], 'check')
      : skipped(`check-${name.replace('.test.mjs', '')}`, 'build failed; compiled check not run'));
  }
  const runnable = commands.filter((command) => !command.skipped);
  const overallPass = runnable.length > 0 && commands.every((command) => command.pass === true);
  const result = {
    schemaVersion: 1,
    kind: 'podcast-async-verification-inner',
    stage,
    node: { executable: NODE, version: process.version },
    environment: probeCLIEnv(),
    limits: { commandTimeoutMs: COMMAND_TIMEOUT_MS },
    probeStage,
    commands,
    overallPass,
  };
  await writeFile(`${EVIDENCE}/inner-result.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ stage, overallPass, commands: commands.map(({ name, pass, skipped: wasSkipped, counts }) => ({ name, pass, skipped: wasSkipped ?? false, counts })) }));
  if (!overallPass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(Number(process.argv[2])).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
