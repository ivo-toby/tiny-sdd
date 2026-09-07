#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experimentDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(experimentDir, '../..');
const fixtureDir = join(experimentDir, 'fixture');
const referenceDir = join(experimentDir, 'reference');
const checksDir = join(experimentDir, 'checks');
const runsDir = join(repositoryDir, 'experiments/runs/003-idempotent-reservations');
const validatorPath = fileURLToPath(import.meta.url);
const nodeTimeoutMs = 20_000;
const cleanPath = '/usr/bin:/bin';
const tapArgs = ['--experimental-test-isolation=none', '--test-reporter=tap'];
const stageNames = ['validation', 'service', 'api'];

function portable(path) {
  return relative(repositoryDir, path).split('/').join('/');
}

function details(error) {
  return error ? {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  } : null;
}

async function filesUnder(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error(`Unsupported source path: ${path}`);
  const files = [];
  for (const entry of (await readdir(path)).sort()) files.push(...await filesUnder(join(path, entry)));
  return files;
}

async function sourceRecords() {
  const roots = [
    ['fixture', fixtureDir],
    ['reference', referenceDir],
    ['checks', checksDir],
    ['feature', join(experimentDir, 'feature.md')],
    ['tasks', join(experimentDir, 'tasks')],
    ['skills', join(experimentDir, 'skills')],
    ['protocol', join(experimentDir, 'protocol.md')],
    ['validator', validatorPath],
  ];
  const records = [];
  for (const [group, root] of roots) {
    for (const path of await filesUnder(root)) {
      const contents = await readFile(path);
      records.push({
        group,
        path: portable(path),
        snapshot: `sources/${portable(path)}`,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
        contents,
      });
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotSources(runDir, records) {
  for (const record of records) {
    const path = join(runDir, record.snapshot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, record.contents, { flag: 'wx', mode: 0o600 });
  }
  return records.map(({ contents, ...record }) => record);
}

async function copyTree(sourceRoot, targetRoot, paths) {
  const copies = [];
  for (const source of paths) {
    const target = join(targetRoot, relative(sourceRoot, source));
    const contents = await readFile(source);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
    copies.push({ source, target, bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex') });
  }
  return copies;
}

function tapSummary(text) {
  const summary = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
    if (match) summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function complete(summary) {
  return summary.tests !== null && summary.pass !== null && summary.fail !== null
    && summary.cancelled === 0 && summary.skipped === 0 && summary.todo === 0
    && summary.pass + summary.fail === summary.tests;
}

function importTests(paths) {
  return `Promise.all(${JSON.stringify(paths)}.map((path) => import(path)))`;
}

async function runChild({ name, args, cwd, env, runDir }) {
  const stdoutPath = join(runDir, `${name}.stdout.txt`);
  const stderrPath = join(runDir, `${name}.stderr.txt`);
  const stdoutFile = await open(stdoutPath, 'wx', 0o600);
  const stderrFile = await open(stderrPath, 'wx', 0o600);
  const startedAt = Date.now();
  let child;
  let timedOut = false;
  let spawnError = null;
  let timer;
  let outcome;
  try {
    outcome = await new Promise((finish) => {
      let settled = false;
      const done = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish({ exitCode, signal });
      };
      try {
        child = spawn(process.execPath, args, {
          cwd,
          env,
          shell: false,
          stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
        });
      } catch (error) {
        spawnError = error;
        done(null, null);
        return;
      }
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (exitCode, signal) => done(exitCode, signal));
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, nodeTimeoutMs);
    });
  } finally {
    await stdoutFile.close();
    await stderrFile.close();
  }
  const stdout = await readFile(stdoutPath, 'utf8');
  const stderr = await readFile(stderrPath, 'utf8');
  return {
    executable: process.execPath,
    args,
    cwd,
    env,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    spawnError: details(spawnError),
    stdout: stdoutPath,
    stderr: stderrPath,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    summary: tapSummary(`${stdout}\n${stderr}`),
    durationMs: Date.now() - startedAt,
  };
}

function classify(result) {
  const output = `${result.stdoutText ?? ''}\n${result.stderrText ?? ''}`;
  if (result.timedOut) return 'timeout';
  if (result.spawnError) return 'spawn-error';
  if (output.includes('Not implemented')) return 'stub-semantic-failure';
  if (/AssertionError|ERR_ASSERTION|Expected values are/.test(output)) return 'assertion-failure';
  return result.exitCode === 0 ? 'pass' : 'nonzero-no-assertion';
}

function expectation(caseInfo, result, stdout, stderr) {
  const summary = result.summary;
  const completeRun = !result.timedOut && !result.spawnError && complete(summary);
  if (!completeRun) return false;
  const output = `${stdout}\n${stderr}`;
  if (caseInfo.kind === 'public') {
    return result.exitCode === 0 && summary.tests === caseInfo.expectedTests
      && summary.pass === caseInfo.expectedTests && summary.fail === 0;
  }
  if (caseInfo.kind === 'reference-public') {
    return result.exitCode === 0 && summary.tests === caseInfo.expectedTests
      && summary.pass === caseInfo.expectedTests && summary.fail === 0;
  }
  if (caseInfo.kind === 'reference') {
    return result.exitCode === 0 && summary.tests === 8 && summary.pass === 8 && summary.fail === 0;
  }
  if (caseInfo.stage === 'api') {
    return result.exitCode !== 0 && summary.tests === 8 && summary.pass === 1 && summary.fail === 7
      && /AssertionError|ERR_ASSERTION|Expected values are/.test(output)
      && !output.includes('Not implemented');
  }
  if (caseInfo.kind === 'mutant') {
    return result.exitCode !== 0 && summary.tests === 8 && summary.fail > 0
      && /AssertionError|ERR_ASSERTION|Expected values are/.test(output)
      && !output.includes('Not implemented');
  }
  return result.exitCode !== 0 && summary.tests === 8 && summary.pass === 0 && summary.fail === 8
    && output.includes('Not implemented');
}

async function main() {
  const fixtureTests = (await filesUnder(join(fixtureDir, 'test')))
    .filter((path) => path.endsWith('.test.mjs')).sort();
  if (fixtureTests.length !== 2) throw new Error(`Expected two original test files, found ${fixtureTests.length}`);
  const records = await sourceRecords();
  await mkdir(runsDir, { recursive: true });
  const runDir = await mkdtemp(join(runsDir, `validation-${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString('hex')}-`));
  const frozenRecords = await snapshotSources(runDir, records);
  const referenceOriginalDir = join(runDir, 'reference-original');
  const referenceSourceFiles = await filesUnder(join(referenceDir, 'src'));
  const referenceOriginalCopies = [
    ...await copyTree(join(referenceDir, 'src'), join(referenceOriginalDir, 'src'), referenceSourceFiles),
    ...await copyTree(join(fixtureDir, 'test'), join(referenceOriginalDir, 'test'), fixtureTests),
    ...await copyTree(fixtureDir, referenceOriginalDir, [join(fixtureDir, 'package.json')]),
  ];
  const referenceTests = referenceOriginalCopies
    .filter((copy) => copy.target.endsWith('.test.mjs')).map((copy) => copy.target).sort();
  const cases = [{
    name: 'public-fixture', kind: 'public', expectedTests: 9, cwd: fixtureDir,
    args: [...tapArgs, '-e', importTests(fixtureTests)], env: { PATH: cleanPath },
  }, {
    name: 'public-reference', kind: 'reference-public', expectedTests: 9, cwd: referenceOriginalDir,
    args: [...tapArgs, '-e', importTests(referenceTests)], env: { PATH: cleanPath },
  }];
  for (const stage of stageNames) {
    const check = join(checksDir, `${stage === 'api' ? '03-api' : stage === 'service' ? '02-service' : '01-validation'}.test.mjs`);
    const candidateStub = join(fixtureDir, 'src');
    const candidateReference = join(referenceDir, 'src');
    cases.push({
      name: `${stage}-stub`, kind: 'stub', stage, cwd: experimentDir,
      args: [...tapArgs, check],
      env: { PATH: cleanPath, TINYSDD_CANDIDATE_DIR: candidateStub },
    });
    cases.push({
      name: `${stage}-reference`, kind: 'reference', stage, cwd: experimentDir,
      args: [...tapArgs, check],
      env: { PATH: cleanPath, TINYSDD_CANDIDATE_DIR: candidateReference },
    });
  }
  for (const mutant of ['double-debit', 'replay-current-stock', 'cache-failures']) {
    const mutantPath = join(referenceDir, 'mutants', `${mutant}.ts`);
    cases.push({
      name: `service-mutant-${mutant}`, kind: 'mutant', stage: 'service', cwd: experimentDir,
      args: [...tapArgs, join(checksDir, '02-service.test.mjs')],
      env: {
        PATH: cleanPath,
        TINYSDD_CANDIDATE_DIR: join(referenceDir, 'src'),
        TINYSDD_SERVICE_MODULE: mutantPath,
      },
    });
  }
  const results = [];
  for (const caseInfo of cases) {
    const result = await runChild({ ...caseInfo, runDir });
    const [stdout, stderr] = await Promise.all([
      readFile(result.stdout, 'utf8'),
      readFile(result.stderr, 'utf8'),
    ]);
    result.classification = classify({ ...result, stdoutText: stdout, stderrText: stderr });
    result.expectationMet = expectation(caseInfo, result, stdout, stderr);
    results.push({ ...caseInfo, ...result });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'idempotent-reservations-fixture-validation',
    experimentId: '003-idempotent-reservations',
    runDirectory: runDir,
    nodeVersion: process.version,
    childTimeoutMs: nodeTimeoutMs,
    childSpawn: { executable: process.execPath, shell: false, environment: 'PATH plus candidate directory only' },
    sourceHashes: frozenRecords,
    referenceOriginalCopies,
    results,
    overallPassed: results.every((result) => result.expectationMet),
  };
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Validation run: ${runDir}`);
  for (const result of results) {
    console.log(`${result.name}: ${result.classification}; exit=${result.exitCode ?? 'null'}; tests=${result.summary.tests ?? 'unknown'}; pass=${result.summary.pass ?? 'unknown'}; fail=${result.summary.fail ?? 'unknown'}; expected=${result.expectationMet ? 'yes' : 'no'}`);
  }
  console.log(`Overall: ${manifest.overallPassed ? 'pass' : 'fail'}`);
  if (!manifest.overallPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
