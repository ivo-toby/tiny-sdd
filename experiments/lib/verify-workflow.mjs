#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 20_000;
const CLEAN_PATH = '/usr/bin:/bin';
const SPECS = {
  '001-batch-reservation': { module: 'inventory.ts', acceptance: 13 },
  '002-label-truncation': { module: 'labels.ts', acceptance: 10 },
};
const usage = 'Usage: node experiments/lib/verify-workflow.mjs <absolute-run-dir> <start|continue>';
const fail = (message) => { throw new Error(message); };

function inside(base, path) {
  const pathFromBase = relative(base, path);
  return pathFromBase !== '' && !pathFromBase.startsWith('..') && !isAbsolute(pathFromBase);
}

async function regular(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a regular file: ${path}`);
  return path;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function verifySource(run, record, label) {
  if (!record || typeof record.snapshot !== 'string' || typeof record.sha256 !== 'string') {
    fail(`Invalid ${label} source record`);
  }
  const path = resolve(run, record.snapshot);
  if (!inside(run, path)) fail(`${label} snapshot escapes run directory`);
  await regular(path, label);
  const hash = await sha256(path);
  if (hash !== record.sha256) fail(`${label} snapshot hash mismatch`);
  return { path, sha256: hash, recordPath: record.path, snapshot: record.snapshot };
}

function tapCounts(text) {
  const count = (name) => {
    const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    tests: count('tests'), pass: count('pass'), fail: count('fail'),
    cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo'),
  };
}

function passed(result, expected) {
  const c = result.counts;
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.error
    && c.tests === expected && c.pass === expected && c.fail === 0
    && c.cancelled === 0 && c.skipped === 0 && c.todo === 0;
}

async function runTest(name, argv, cwd, env, outputDir) {
  const stdoutPath = join(outputDir, `${name}.stdout.txt`);
  const stderrPath = join(outputDir, `${name}.stderr.txt`);
  const stdout = await open(stdoutPath, 'wx', 0o600);
  const stderr = await open(stderrPath, 'wx', 0o600);
  let timedOut = false;
  let error = null;
  const outcome = await new Promise((finishPromise) => {
    let settled = false;
    let timer;
    let killTimer;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      finishPromise({ exitCode, signal });
    };
    let child;
    try {
      child = spawn(process.execPath, argv, {
        cwd, env, shell: false, stdio: ['ignore', stdout.fd, stderr.fd],
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      finish(null, null);
      return;
    }
    child.once('error', (cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
      finish(null, null);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    }, TIMEOUT_MS);
  });
  await stdout.close();
  await stderr.close();
  const stdoutText = await readFile(stdoutPath, 'utf8');
  return {
    executable: process.execPath, argv, cwd, env,
    exitCode: outcome.exitCode, signal: outcome.signal, timedOut, error,
    stdout: stdoutPath, stderr: stderrPath,
    stdoutBytes: Buffer.byteLength(stdoutText),
    stderrBytes: (await readFile(stderrPath)).byteLength,
    counts: tapCounts(stdoutText),
  };
}

async function main(argv) {
  const [runArg, phase] = argv;
  if (argv.length !== 2 || !isAbsolute(runArg)) fail(usage);
  if (phase !== 'start' && phase !== 'continue') fail('Phase must be start or continue');
  const run = resolve(runArg);
  const runInfo = await lstat(run);
  if (runInfo.isSymbolicLink() || !runInfo.isDirectory()) fail(`Run directory is invalid: ${run}`);
  const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
  if (manifest.runDirectory !== run) fail('Manifest runDirectory does not match argument');
  const experimentId = manifest.experimentId ?? '001-batch-reservation';
  const spec = SPECS[experimentId];
  if (!spec) fail(`Unsupported experiment: ${experimentId}`);
  const phaseRecord = manifest.phases?.[phase];
  if (!phaseRecord || typeof phaseRecord !== 'object') fail(`Missing manifest phase: ${phase}`);

  const candidate = resolve(run, `workspace-after/${phase}/src/${spec.module}`);
  await regular(candidate, 'Candidate');
  const candidateHash = await sha256(candidate);
  const workspaceFiles = phaseRecord.workspaceSnapshot?.files ?? [];
  const candidateRecords = workspaceFiles.filter((record) => record.path === `src/${spec.module}`);
  if (candidateRecords.length !== 1 || candidateRecords[0].sha256 !== candidateHash) {
    fail('Candidate hash does not match the phase workspace snapshot');
  }
  const sources = manifest.sourceHashes ?? [];
  const checkPath = `experiments/${experimentId}/checks/acceptance.test.mjs`;
  const checks = sources.filter((record) => record.group === 'checks' && record.path === checkPath);
  const tests = sources.filter((record) => record.group === 'fixture'
    && typeof record.path === 'string'
    && record.path.startsWith(`experiments/${experimentId}/fixture/test/`)
    && record.path.endsWith('.test.mjs'));
  if (checks.length !== 1) fail('Expected exactly one frozen acceptance source record');
  if (tests.length !== 1) fail('Expected exactly one original test source record');
  const acceptance = await verifySource(run, checks[0], 'Acceptance');
  const originalTest = await verifySource(run, tests[0], 'Original test');

  const verification = join(run, `verification-${phase}`);
  try { await mkdir(verification); } catch (cause) {
    if (cause?.code === 'EEXIST') fail(`Refusing existing verification directory: ${verification}`);
    throw cause;
  }
  const frozen = join(verification, 'frozen-regressions');
  await mkdir(join(frozen, 'src'), { recursive: true });
  await mkdir(join(frozen, 'test'), { recursive: true });
  const verifierSource = fileURLToPath(import.meta.url);
  await regular(verifierSource, 'Verifier source');
  const verifierSnapshot = join(verification, 'verify-workflow.mjs');
  await copyFile(verifierSource, verifierSnapshot);
  const verifierHash = await sha256(verifierSnapshot);
  const copiedCandidate = join(frozen, 'src', spec.module);
  const copiedTest = join(frozen, 'test', tests[0].path.split('/').at(-1));
  await copyFile(candidate, copiedCandidate);
  await copyFile(originalTest.path, copiedTest);
  const copiedCandidateHash = await sha256(copiedCandidate);
  const copiedTestHash = await sha256(copiedTest);
  if (copiedCandidateHash !== candidateHash || copiedTestHash !== originalTest.sha256) {
    fail('Verification copies failed byte-for-byte hash check');
  }

  const acceptanceArgs = [
    '--permission', `--allow-fs-read=${dirname(candidate)}`, `--allow-fs-read=${dirname(acceptance.path)}`,
    '--test-reporter=tap', acceptance.path,
  ];
  const regressionArgs = [
    '--permission', `--allow-fs-read=${frozen}`, '--test-reporter=tap', copiedTest,
  ];
  const acceptanceRun = await runTest('acceptance', acceptanceArgs, run,
    { PATH: CLEAN_PATH, TINYSDD_CANDIDATE_MODULE: candidate }, verification);
  const regressionRun = await runTest('regression', regressionArgs, frozen,
    { PATH: CLEAN_PATH }, verification);
  const acceptancePass = passed(acceptanceRun, spec.acceptance);
  const regressionPass = passed(regressionRun, 5);
  const result = {
    schemaVersion: 1,
    kind: 'workflow-verification',
    runDirectory: run,
    experimentId,
    phase,
    expected: { acceptanceTests: spec.acceptance, originalTests: 5 },
    verifier: {
      source: verifierSource,
      snapshot: verifierSnapshot,
      sha256: verifierHash,
      nodeVersion: process.version,
    },
    candidate: { path: candidate, sha256: candidateHash, workspaceRecord: candidateRecords[0] },
    sources: { acceptance, originalTest },
    copies: {
      candidate: { path: copiedCandidate, sha256: copiedCandidateHash },
      originalTest: { path: copiedTest, sha256: copiedTestHash },
    },
    workflowCapture: {
      stopReason: phaseRecord.capture?.stopReason ?? null,
      exitCode: phaseRecord.capture?.exitCode ?? null,
    },
    commands: { acceptance: acceptanceRun, regression: regressionRun },
    pass: { acceptance: acceptancePass, regression: regressionPass, overall: acceptancePass && regressionPass },
    limitations: ['This verifies captured artifacts only; it does not claim the workflow itself passed.'],
  };
  await writeFile(join(verification, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ verification, pass: result.pass, workflowCapture: result.workflowCapture }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
});
