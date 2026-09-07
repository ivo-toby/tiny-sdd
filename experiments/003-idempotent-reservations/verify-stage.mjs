#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 20_000;
const CLEAN_PATH = '/usr/bin:/bin';
const SELF = fileURLToPath(import.meta.url);
const EXECUTABLE = resolve(process.execPath);
const usage = 'Usage: node verify-stage.mjs <absolute-workspace-snapshot> <absolute-frozen-experiment-source-dir> <1|2|3> <absolute-new-output-dir>';
const fail = (message) => { throw new Error(message); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const errorInfo = (error) => error ? {
  name: error.name,
  message: error.message,
  ...(error.code ? { code: error.code } : {}),
} : null;

async function regular(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular file: ${path}`);
  return path;
}

async function directory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory: ${path}`);
  return path;
}

async function filesUnder(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`Symlink is not allowed: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) fail(`Unsupported source path: ${path}`);
  const files = [];
  for (const name of (await readdir(path)).sort()) files.push(...await filesUnder(join(path, name)));
  return files;
}

function rel(root, path) {
  return relative(root, path).split('\\').join('/');
}

function inside(base, path) {
  const fromBase = relative(base, path);
  return fromBase !== '' && !fromBase.startsWith('..') && !isAbsolute(fromBase);
}

async function records(files, root) {
  const output = [];
  for (const path of files) {
    const bytes = await readFile(path);
    output.push({ path: rel(root, path), absolutePath: path, bytes: bytes.byteLength, sha256: digest(bytes) });
  }
  return output;
}

async function copyRecords(items, outputRoot, outputDir) {
  const copied = [];
  for (const item of items) {
    const target = join(outputRoot, item.path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = await readFile(item.absolutePath);
    if (bytes.byteLength !== item.bytes || digest(bytes) !== item.sha256) fail(`Input changed: ${item.absolutePath}`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    const copy = await readFile(target);
    copied.push({
      sourcePath: item.absolutePath,
      outputPath: rel(outputDir, target),
      bytes: item.bytes,
      sha256: item.sha256,
      copiedBytes: copy.byteLength,
      copiedSha256: digest(copy),
    });
  }
  return copied;
}

function tapCounts(text) {
  const counts = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
    if (match) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

async function runChild(name, args, cwd, env, outputDir, expectedTests) {
  const stdoutPath = join(outputDir, `${name}.stdout.txt`);
  const stderrPath = join(outputDir, `${name}.stderr.txt`);
  const stdoutHandle = await open(stdoutPath, 'wx', 0o600);
  const stderrHandle = await open(stderrPath, 'wx', 0o600);
  let timedOut = false;
  let spawnError = null;
  let captureError = null;
  const started = Date.now();
  const outcome = await new Promise((finishPromise) => {
    let child;
    let timer;
    let killTimer;
    let settled = false;
    const finish = async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      try {
        await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
        const [stdout, stderr] = await Promise.all([readFile(stdoutPath), readFile(stderrPath)]);
        finishPromise({ exitCode, signal, stdout, stderr });
      } catch (error) {
        captureError = errorInfo(error);
        finishPromise({ exitCode, signal, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      }
    };
    try {
      child = spawn(EXECUTABLE, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
    } catch (error) {
      spawnError = errorInfo(error);
      void finish(null, null);
      return;
    }
    child.once('error', (error) => { spawnError = errorInfo(error); });
    child.once('close', (code, signal) => { void finish(code, signal); });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    }, TIMEOUT_MS);
  });
  const stdoutText = outcome.stdout.toString('utf8');
  const stderrText = outcome.stderr.toString('utf8');
  const counts = tapCounts(`${stdoutText}\n${stderrText}`);
  const pass = !timedOut && !spawnError && !captureError
    && outcome.exitCode === 0 && outcome.signal === null
    && counts.tests === expectedTests && counts.pass === expectedTests
    && counts.fail === 0 && counts.cancelled === 0
    && counts.skipped === 0 && counts.todo === 0;
  return {
    command: { executable: EXECUTABLE, argv: [EXECUTABLE, ...args], cwd, env },
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    spawnError,
    captureError,
    elapsedMs: Date.now() - started,
    stdout: { path: rel(outputDir, stdoutPath), bytes: outcome.stdout.byteLength },
    stderr: { path: rel(outputDir, stderrPath), bytes: outcome.stderr.byteLength },
    counts,
    expectedTests,
    pass,
  };
}

async function main(argv) {
  if (argv.length !== 4 || argv.some((value, index) => index !== 2 && !isAbsolute(value))) fail(usage);
  if (!['1', '2', '3'].includes(argv[2])) fail('Stage must be 1, 2, or 3');
  const workspace = resolve(argv[0]);
  const frozen = resolve(argv[1]);
  const stage = Number(argv[2]);
  const output = resolve(argv[3]);
  await directory(workspace, 'Workspace snapshot');
  await directory(frozen, 'Frozen experiment source');
  if (inside(workspace, output) || inside(frozen, output)) fail('Output must not be inside an input directory');
  try { await lstat(output); fail(`Refusing existing output directory: ${output}`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await directory(dirname(output), 'Output parent');

  const candidateDir = join(workspace, 'src');
  const checksDir = join(frozen, 'checks');
  const originalDir = join(frozen, 'fixture', 'test');
  await directory(candidateDir, 'Candidate source');
  await directory(checksDir, 'Frozen checks');
  await directory(originalDir, 'Frozen fixture tests');
  const candidateFiles = await filesUnder(candidateDir);
  if (candidateFiles.length === 0) fail('Candidate source is empty');
  const candidate = await records(candidateFiles, candidateDir);
  const original = [];
  for (const name of ['app.test.mjs', 'inventory.test.mjs']) {
    const path = await regular(join(originalDir, name), `Original ${name}`);
    original.push(...await records([path], originalDir));
  }
  const checks = [];
  for (let index = 1; index <= stage; index++) {
    const name = `${String(index).padStart(2, '0')}-${['validation', 'service', 'api'][index - 1]}.test.mjs`;
    const path = await regular(join(checksDir, name), `Frozen check ${name}`);
    checks.push(...await records([path], checksDir));
  }

  await mkdir(output, { recursive: false });
  const validatorBytes = await readFile(SELF);
  const validatorSnapshot = join(output, 'sources', 'verify-stage.mjs');
  await mkdir(dirname(validatorSnapshot), { recursive: true });
  await writeFile(validatorSnapshot, validatorBytes, { flag: 'wx', mode: 0o600 });
  const frozenRegression = join(output, 'frozen-regressions');
  const copiedCandidate = await copyRecords(candidate, join(frozenRegression, 'src'), output);
  const copiedOriginal = await copyRecords(original, join(frozenRegression, 'test'), output);
  const checkRuns = [];
  for (const check of checks) {
    const args = ['--permission', `--allow-fs-read=${candidateDir}`, `--allow-fs-read=${checksDir}`, '--test-reporter=tap', join(checksDir, check.path)];
    checkRuns.push({ name: check.path, ...(await runChild(`check-${check.path.slice(0, 2)}`, args, output, { PATH: CLEAN_PATH, TINYSDD_CANDIDATE_DIR: candidateDir }, output, 8)) });
  }
  const appTest = join(frozenRegression, 'test', 'app.test.mjs');
  const inventoryTest = join(frozenRegression, 'test', 'inventory.test.mjs');
  const regressionRuns = [];
  for (const [name, path, expected] of [['app', appTest, 4], ['inventory', inventoryTest, 5]]) {
    const args = ['--permission', `--allow-fs-read=${frozenRegression}`, '--test-reporter=tap', path];
    regressionRuns.push({ name, ...(await runChild(`regression-${name}`, args, frozenRegression, { PATH: CLEAN_PATH }, output, expected)) });
  }
  const result = {
    schemaVersion: 1,
    kind: 'idempotent-reservations-stage-verification',
    workspaceSnapshot: workspace,
    frozenExperimentSource: frozen,
    stage,
    node: { executable: EXECUTABLE, version: process.version },
    limits: { childTimeoutMs: TIMEOUT_MS },
    sources: {
      checks,
      candidateSrc: candidate,
      originalTests: original,
      validator: {
        sourcePath: SELF,
        snapshotPath: rel(output, validatorSnapshot),
        bytes: validatorBytes.byteLength,
        sha256: digest(validatorBytes),
      },
    },
    copies: { candidateSrc: copiedCandidate, originalTests: copiedOriginal },
    checks: checkRuns,
    regressions: regressionRuns,
    pass: {
      checks: checkRuns.every((run) => run.pass),
      app: regressionRuns.find((run) => run.name === 'app')?.pass === true,
      inventory: regressionRuns.find((run) => run.name === 'inventory')?.pass === true,
    },
  };
  result.pass.overall = result.pass.checks && result.pass.app && result.pass.inventory;
  await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, stage, pass: result.pass, checks: checkRuns.map(({ name, counts, pass }) => ({ name, counts, pass })), regressions: regressionRuns.map(({ name, counts, pass }) => ({ name, counts, pass })) }));
  if (!result.pass.overall) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(errorInfo(error)?.message ?? String(error));
  console.error(usage);
  process.exitCode = 1;
});
