import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experimentDir = dirname(fileURLToPath(import.meta.url));
const validatorPath = fileURLToPath(import.meta.url);
const repositoryDir = resolve(experimentDir, '../..');
const fixtureDir = join(experimentDir, 'fixture');
const acceptancePath = join(experimentDir, 'checks', 'acceptance.test.mjs');
const referencePath = join(experimentDir, 'reference', 'inventory.ts');
const stubPath = join(fixtureDir, 'src', 'inventory.ts');
const partialUpdatePath = join(
  experimentDir,
  'reference',
  'mutants',
  'partial-update.ts',
);
const staleAvailabilityPath = join(
  experimentDir,
  'reference',
  'mutants',
  'stale-availability.ts',
);
const runsDir = join(
  repositoryDir,
  'experiments',
  'runs',
  '001-batch-reservation',
);

const childTimeoutMs = 20_000;
const publicTestCount = 5;
const acceptanceTestCount = 13;

function asPortablePath(filePath) {
  return relative(repositoryDir, filePath).split('/').join('/');
}

function errorDetails(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  };
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function sourceFiles(target) {
  const targetStat = await stat(target);
  return targetStat.isDirectory() ? filesUnder(target) : [target];
}

async function sourceHashes() {
  const groups = [
    { name: 'fixture', targets: [fixtureDir] },
    { name: 'reference', targets: [referencePath] },
    {
      name: 'mutants',
      targets: [partialUpdatePath, staleAvailabilityPath],
    },
    { name: 'checks', targets: [acceptancePath] },
    { name: 'validator', targets: [validatorPath] },
  ];
  const hashes = [];

  for (const group of groups) {
    for (const target of group.targets) {
      for (const filePath of await sourceFiles(target)) {
        const contents = await readFile(filePath);
        const sha256 = createHash('sha256').update(contents).digest('hex');
        hashes.push({
          group: group.name,
          path: asPortablePath(filePath),
          sha256,
          filePath,
          contents,
        });
      }
    }
  }

  return hashes.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotSources(runDirectory, hashes) {
  const sourceDirectory = join(runDirectory, 'sources');
  const snapshots = [];

  for (const hash of hashes) {
    const snapshotPath = join(sourceDirectory, hash.path);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, hash.contents, { flag: 'wx', mode: 0o600 });
    snapshots.push({
      group: hash.group,
      path: hash.path,
      sha256: hash.sha256,
      snapshotPath: `sources/${hash.path}`,
    });
  }

  return snapshots;
}

async function createRunDirectory() {
  await mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runId = `validation-${timestamp}-${process.pid}-${randomBytes(6).toString('hex')}`;
    const runDirectory = join(runsDir, runId);
    try {
      await mkdir(runDirectory);
      return { runId, runDirectory };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error('could not allocate a unique validation directory');
}

async function runChild({ cwd, args, extraEnv = {}, stdoutPath, stderrPath }) {
  const startedAt = Date.now();
  let stdoutHandle;
  let stderrHandle;

  try {
    stdoutHandle = await open(stdoutPath, 'wx', 0o600);
    stderrHandle = await open(stderrPath, 'wx', 0o600);
  } catch (error) {
    await Promise.allSettled([
      stdoutHandle?.close(),
      stderrHandle?.close(),
    ]);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: null,
      captureError: errorDetails(error),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: Date.now() - startedAt,
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
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      try {
        await Promise.all([
          stdoutHandle?.close(),
          stderrHandle?.close(),
        ]);
      } catch (error) {
        captureError = error;
      }

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      if (!captureError) {
        try {
          [stdout, stderr] = await Promise.all([
            readFile(stdoutPath),
            readFile(stderrPath),
          ]);
        } catch (error) {
          captureError = error;
        }
      }

      resolveResult({
        exitCode,
        signal,
        timedOut,
        spawnError: errorDetails(spawnError),
        captureError: errorDetails(captureError),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    };

    try {
      const childEnv = { ...process.env };
      delete childEnv.TINYSDD_CANDIDATE_MODULE;
      Object.assign(childEnv, extraEnv);
      child = spawn(process.execPath, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
    } catch (error) {
      spawnError = error;
      void finish(null, null);
      return;
    }

    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      void finish(exitCode, signal);
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, childTimeoutMs);
  });
}

function summaryFrom(output) {
  const summary = {
    tests: null,
    pass: null,
    fail: null,
    cancelled: null,
    skipped: null,
  };

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:ℹ|#)\s+(tests|pass|fail|cancelled|skipped)\s+(\d+)\s*$/,
    );
    if (match) {
      summary[match[1]] = Number(match[2]);
    }
  }

  return summary;
}

function classify(result) {
  const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
  const assertionFailure =
    /\bAssertionError\b|\bERR_ASSERTION\b|Expected values to be/.test(output);

  let classification;
  if (result.timedOut) {
    classification = 'timeout';
  } else if (result.spawnError) {
    classification = 'spawn-error';
  } else if (result.captureError) {
    classification = 'capture-error';
  } else if (result.exitCode === 0) {
    classification = 'pass';
  } else if (assertionFailure) {
    classification = 'assertion-failure';
  } else {
    classification = 'nonzero-no-assertion';
  }

  return { classification, assertionFailure };
}

function isCompleteSummary(summary) {
  return summary.tests !== null &&
    summary.pass !== null &&
    summary.fail !== null &&
    summary.cancelled === 0 &&
    summary.skipped === 0 &&
    summary.pass + summary.fail === summary.tests;
}

function meetsExpectation(caseName, result, summary, classification) {
  if (
    result.timedOut ||
    result.spawnError ||
    result.captureError ||
    !isCompleteSummary(summary)
  ) {
    return false;
  }

  if (caseName === 'public-fixture') {
    return result.exitCode === 0 &&
      summary.tests === publicTestCount &&
      summary.pass === publicTestCount &&
      summary.fail === 0;
  }

  if (caseName === 'holdout-reference') {
    return result.exitCode === 0 &&
      summary.tests === acceptanceTestCount &&
      summary.pass === acceptanceTestCount &&
      summary.fail === 0;
  }

  if (caseName === 'holdout-stub') {
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
    return result.exitCode !== 0 &&
      summary.tests === acceptanceTestCount &&
      summary.fail > 0 &&
      output.includes('Not implemented');
  }

  return result.exitCode !== 0 &&
    summary.tests === acceptanceTestCount &&
    summary.fail > 0 &&
    classification === 'assertion-failure';
}

function casesToRun() {
  const nodeArgs = ['--test', '--experimental-test-isolation=none'];
  return [
    {
      name: 'public-fixture',
      cwd: fixtureDir,
      args: [...nodeArgs, 'test/inventory.test.mjs'],
      expected: 'exit 0 with all public tests passing',
    },
    {
      name: 'holdout-stub',
      cwd: experimentDir,
      args: [...nodeArgs, 'checks/acceptance.test.mjs'],
      candidatePath: stubPath,
      expected: 'nonzero semantic failure from the unimplemented stub',
    },
    {
      name: 'holdout-reference',
      cwd: experimentDir,
      args: [...nodeArgs, 'checks/acceptance.test.mjs'],
      candidatePath: referencePath,
      expected: 'exit 0 with all hold-out tests passing',
    },
    {
      name: 'holdout-partial-update',
      cwd: experimentDir,
      args: [...nodeArgs, 'checks/acceptance.test.mjs'],
      candidatePath: partialUpdatePath,
      expected: 'nonzero assertion failure from the partial-update mutant',
    },
    {
      name: 'holdout-stale-availability',
      cwd: experimentDir,
      args: [...nodeArgs, 'checks/acceptance.test.mjs'],
      candidatePath: staleAvailabilityPath,
      expected: 'nonzero assertion failure from the stale-availability mutant',
    },
  ];
}

async function main() {
  const { runId, runDirectory } = await createRunDirectory();
  const startedAt = new Date().toISOString();
  const hashes = await sourceHashes();
  const sourceHashRecords = await snapshotSources(runDirectory, hashes);
  const results = [];

  for (const testCase of casesToRun()) {
    const extraEnv = testCase.candidatePath
      ? { TINYSDD_CANDIDATE_MODULE: testCase.candidatePath }
      : {};
    const stdoutFile = `${testCase.name}.stdout.log`;
    const stderrFile = `${testCase.name}.stderr.log`;
    const childResult = await runChild({
      cwd: testCase.cwd,
      args: testCase.args,
      extraEnv,
      stdoutPath: join(runDirectory, stdoutFile),
      stderrPath: join(runDirectory, stderrFile),
    });
    const output = `${childResult.stdout.toString('utf8')}\n${childResult.stderr.toString('utf8')}`;
    const summary = summaryFrom(output);
    const { classification, assertionFailure } = classify(childResult);
    const expectationMet = meetsExpectation(
      testCase.name,
      childResult,
      summary,
      classification,
    );
    results.push({
      name: testCase.name,
      command: [process.execPath, ...testCase.args],
      cwd: testCase.cwd,
      ...(testCase.candidatePath
        ? { candidateModule: testCase.candidatePath }
        : {}),
      expected: testCase.expected,
      exitCode: childResult.exitCode,
      signal: childResult.signal,
      timedOut: childResult.timedOut,
      spawnError: childResult.spawnError,
      captureError: childResult.captureError,
      durationMs: childResult.durationMs,
      classification,
      assertionFailure,
      summary,
      expectationMet,
      stdoutFile,
      stderrFile,
    });
  }

  const overallPassed = results.every((result) => result.expectationMet);
  const manifest = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    timeoutMs: childTimeoutMs,
    sourceHashes: sourceHashRecords,
    results,
    overallPassed,
  };
  const manifestFile = join(runDirectory, 'manifest.json');
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Validation run: ${runDirectory}`);
  for (const result of results) {
    console.log(
      `${result.name}: ${result.classification}; ` +
      `exit=${result.exitCode ?? 'null'}; ` +
      `tests=${result.summary.tests ?? 'unknown'}; ` +
      `fail=${result.summary.fail ?? 'unknown'}; ` +
      `expected=${result.expectationMet ? 'yes' : 'no'}`,
    );
  }
  console.log(`Manifest: ${manifestFile}`);
  console.log(`Overall: ${overallPassed ? 'PASS' : 'FAIL'}`);

  if (!overallPassed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Validation script error: ${error.stack ?? error}`);
  process.exitCode = 1;
});
