import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experimentDir = dirname(fileURLToPath(import.meta.url));
const validatorPath = fileURLToPath(import.meta.url);
const repositoryDir = resolve(experimentDir, '../..');
const fixtureDir = join(experimentDir, 'fixture');
const acceptancePath = join(experimentDir, 'checks', 'acceptance.test.mjs');
const referencePath = join(experimentDir, 'reference', 'labels.ts');
const stubPath = join(fixtureDir, 'src', 'labels.ts');
const utf16Path = join(experimentDir, 'reference', 'mutants', 'utf16.ts');
const extraEllipsisPath = join(experimentDir, 'reference', 'mutants', 'extra-ellipsis.ts');
const protocolPath = join(experimentDir, 'protocol.md');
const runsDir = join(repositoryDir, 'experiments', 'runs', '002-label-truncation');

const childTimeoutMs = 20_000;
const publicTestCount = 5;
const acceptanceTestCount = 10;
const tapArgs = ['--test', '--experimental-test-isolation=none', '--test-reporter=tap'];

function portablePath(filePath) {
  return relative(repositoryDir, filePath).split('/').join('/');
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
  for (const entry of (await readdir(path)).sort()) {
    files.push(...await filesUnder(join(path, entry)));
  }
  return files;
}

async function sourceRecords() {
  const groups = [
    ['fixture', fixtureDir],
    ['checks', acceptancePath],
    ['reference', referencePath],
    ['mutants', utf16Path],
    ['mutants', extraEllipsisPath],
    ['protocol', protocolPath],
    ['validator', validatorPath],
  ];
  const records = [];
  for (const [group, root] of groups) {
    for (const filePath of await filesUnder(root)) {
      const contents = await readFile(filePath);
      records.push({
        group,
        path: portablePath(filePath),
        contents,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotSources(runDirectory, records) {
  const snapshots = [];
  for (const record of records) {
    const snapshotPath = join(runDirectory, 'sources', record.path);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, record.contents, { flag: 'wx', mode: 0o600 });
    snapshots.push({
      group: record.group,
      path: record.path,
      bytes: record.bytes,
      sha256: record.sha256,
      snapshotPath: `sources/${record.path}`,
    });
  }
  return snapshots;
}

async function createRunDirectory() {
  await mkdir(runsDir, { recursive: true });
  const suffix = `${Date.now().toString(36)}-${process.pid}-${randomBytes(5).toString('hex')}`;
  return mkdtemp(join(runsDir, `validation-${suffix}-`));
}

async function runChild({ runDirectory, name, cwd, args, candidatePath }) {
  const stdoutFile = `${name}.stdout.log`;
  const stderrFile = `${name}.stderr.log`;
  const stdoutPath = join(runDirectory, stdoutFile);
  const stderrPath = join(runDirectory, stderrFile);
  const startedAt = Date.now();
  let stdoutHandle;
  let stderrHandle;
  try {
    stdoutHandle = await open(stdoutPath, 'wx', 0o600);
    stderrHandle = await open(stderrPath, 'wx', 0o600);
  } catch (error) {
    await Promise.allSettled([stdoutHandle?.close(), stderrHandle?.close()]);
    return {
      exitCode: null, signal: null, timedOut: false, spawnError: null,
      captureError: details(error), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      stdoutFile, stderrFile, durationMs: Date.now() - startedAt,
    };
  }

  return new Promise((resolveResult) => {
    let child;
    let timedOut = false;
    let spawnError = null;
    let captureError = null;
    let timeoutHandle;
    let settled = false;
    const finish = async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
        const [stdout, stderr] = await Promise.all([readFile(stdoutPath), readFile(stderrPath)]);
        resolveResult({
          exitCode, signal, timedOut, spawnError: details(spawnError), captureError: null,
          stdout, stderr, stdoutFile, stderrFile, durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        captureError = details(error);
        resolveResult({
          exitCode, signal, timedOut, spawnError: details(spawnError), captureError,
          stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutFile, stderrFile,
          durationMs: Date.now() - startedAt,
        });
      }
    };

    const childEnv = { PATH: process.env.PATH ?? '' };
    if (candidatePath) childEnv.TINYSDD_CANDIDATE_MODULE = candidatePath;
    try {
      child = spawn(process.execPath, args, {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
    } catch (error) {
      spawnError = error;
      void finish(null, null);
      return;
    }
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => { void finish(code, signal); });
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, childTimeoutMs);
  });
}

function summaryFrom(output) {
  const summary = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null };
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
    if (match) summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function classify(result) {
  const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
  const assertionFailure = /\bAssertionError\b|\bERR_ASSERTION\b|Expected values to be/.test(output);
  let classification;
  if (result.timedOut) classification = 'timeout';
  else if (result.spawnError) classification = 'spawn-error';
  else if (result.captureError) classification = 'capture-error';
  else if (result.exitCode === 0) classification = 'pass';
  else if (output.includes('Not implemented')) classification = 'stub-semantic-failure';
  else if (assertionFailure) classification = 'assertion-failure';
  else classification = 'nonzero-no-assertion';
  return { classification, assertionFailure };
}

function completeSummary(summary) {
  return summary.tests !== null
    && summary.pass !== null
    && summary.fail !== null
    && summary.cancelled === 0
    && summary.skipped === 0
    && summary.todo === 0
    && summary.pass + summary.fail === summary.tests;
}

function expectation(name, result, summary, classification) {
  if (result.timedOut || result.spawnError || result.captureError || !completeSummary(summary)) return false;
  if (name === 'public-fixture') {
    return result.exitCode === 0 && summary.tests === publicTestCount
      && summary.pass === publicTestCount && summary.fail === 0;
  }
  if (name === 'holdout-reference') {
    return result.exitCode === 0 && summary.tests === acceptanceTestCount
      && summary.pass === acceptanceTestCount && summary.fail === 0;
  }
  if (name === 'holdout-stub') {
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
    return result.exitCode !== 0 && summary.tests === acceptanceTestCount
      && summary.pass === 1 && summary.fail === 9
      && classification === 'stub-semantic-failure' && output.includes('Not implemented');
  }
  return result.exitCode !== 0 && summary.tests === acceptanceTestCount
    && summary.fail > 0 && classification === 'assertion-failure';
}

function cases() {
  const holdout = [...tapArgs, acceptancePath];
  return [
    {
      name: 'public-fixture',
      cwd: fixtureDir,
      args: [...tapArgs, join(fixtureDir, 'test', 'labels.test.mjs')],
      expected: 'exit 0 with 5 public tests passing',
    },
    {
      name: 'holdout-stub', cwd: experimentDir, args: holdout, candidatePath: stubPath,
      expected: '10 holdout tests with semantic stub failures',
    },
    {
      name: 'holdout-reference', cwd: experimentDir, args: holdout, candidatePath: referencePath,
      expected: 'exit 0 with 10 holdout tests passing',
    },
    {
      name: 'holdout-utf16', cwd: experimentDir, args: holdout, candidatePath: utf16Path,
      expected: '10 holdout tests with assertion failures',
    },
    {
      name: 'holdout-extra-ellipsis', cwd: experimentDir, args: holdout, candidatePath: extraEllipsisPath,
      expected: '10 holdout tests with assertion failures',
    },
  ];
}

async function main() {
  const runDirectory = await createRunDirectory();
  const startedAt = new Date().toISOString();
  const records = await sourceRecords();
  const snapshots = await snapshotSources(runDirectory, records);
  const results = [];

  for (const testCase of cases()) {
    const child = await runChild({ runDirectory, ...testCase });
    const combined = `${child.stdout.toString('utf8')}\n${child.stderr.toString('utf8')}`;
    const summary = summaryFrom(combined);
    const { classification, assertionFailure } = classify(child);
    const expectationMet = expectation(testCase.name, child, summary, classification);
    results.push({
      name: testCase.name,
      command: [process.execPath, ...testCase.args],
      cwd: testCase.cwd,
      env: testCase.candidatePath
        ? { PATH: '<inherited PATH>', TINYSDD_CANDIDATE_MODULE: testCase.candidatePath }
        : { PATH: '<inherited PATH>' },
      ...(testCase.candidatePath ? { candidateModule: testCase.candidatePath } : {}),
      expected: testCase.expected,
      exitCode: child.exitCode,
      signal: child.signal,
      timedOut: child.timedOut,
      spawnError: child.spawnError,
      captureError: child.captureError,
      durationMs: child.durationMs,
      stdoutBytes: child.stdout.byteLength,
      stderrBytes: child.stderr.byteLength,
      stdoutFile: child.stdoutFile,
      stderrFile: child.stderrFile,
      classification,
      assertionFailure,
      summary,
      expectationMet,
    });
  }

  const overallPassed = results.every((result) => result.expectationMet);
  const manifest = {
    schemaVersion: 1,
    kind: 'label-truncation-fixture-validation',
    runId: relative(runsDir, runDirectory),
    runDirectory,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    childTimeoutMs,
    childSpawn: { executable: process.execPath, shell: false, environment: 'clean PATH plus candidate variable only' },
    sourceSnapshots: snapshots,
    results,
    overallPassed,
  };
  const manifestPath = join(runDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  console.log(`Validation run: ${runDirectory}`);
  for (const result of results) {
    console.log(`${result.name}: ${result.classification}; exit=${result.exitCode ?? 'null'}; `
      + `tests=${result.summary.tests ?? 'unknown'}; pass=${result.summary.pass ?? 'unknown'}; `
      + `fail=${result.summary.fail ?? 'unknown'}; expected=${result.expectationMet ? 'yes' : 'no'}`);
  }
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Overall: ${overallPassed ? 'PASS' : 'FAIL'}`);
  if (!overallPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Validation script error: ${error.stack ?? error}`);
  process.exitCode = 1;
});
