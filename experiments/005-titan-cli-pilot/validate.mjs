#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const EXPERIMENT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EXPERIMENT, '../..');
const RUN = join(ROOT, 'experiments/runs/005-titan-cli-pilot');
const ARTIFACTS = join(RUN, 'validation-artifacts');
const REPORT = join(RUN, 'validation-report.md');
const METADATA = join(RUN, 'validation-metadata.json');
const FIXTURE = join(EXPERIMENT, 'fixture');
const REFERENCE = join(EXPERIMENT, 'reference');
const VERIFY = join(EXPERIMENT, 'verify.mjs');
const INPUTS = [
  'protocol.md',
  'fixture/task.md',
  'fixture/src/store.mjs',
  'fixture/test/base.test.mjs',
  'checks/store.test.mjs',
  'reference/src/store.mjs',
  'verify.mjs',
];
const ORIGINAL_TESTS = [
  'get and put preserve versioning and absent result',
  'seed, get, put inputs and returned data are detached',
];
const SYNTAX_MARKERS = [
  'SyntaxError',
  'Unexpected token',
  'ERR_MODULE_NOT_FOUND',
  'Cannot find module',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equalJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function regular(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function directory(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

async function absent(path) {
  try {
    await lstat(path);
    throw new Error(`refusing existing validation artifact: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function records(root) {
  const output = [];
  async function visit(path, rel) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`symlink in validation input: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), join(rel, name));
    } else if (stat.isFile()) {
      const bytes = await readFile(path);
      output.push({ path: rel.split('\\').join('/'), bytes: bytes.length, sha256: sha(bytes) });
    } else {
      throw new Error(`unsupported validation input: ${path}`);
    }
  }
  await visit(root, '');
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyTree(source, destination) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`symlink copy source: ${source}`);
  if (!sourceStat.isDirectory()) throw new Error(`copy source must be a directory: ${source}`);
  await mkdir(destination, { recursive: true });
  async function visit(path, rel) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`symlink copy source: ${path}`);
    const target = join(destination, rel);
    if (stat.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), join(rel, name));
    } else if (stat.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
    } else {
      throw new Error(`unsupported copy source: ${path}`);
    }
  }
  for (const name of (await readdir(source)).sort()) await visit(join(source, name), name);
}

async function inputHashes() {
  const output = {};
  for (const path of INPUTS) {
    const bytes = await readFile(join(EXPERIMENT, path));
    output[path] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testLine(tap, status, name) {
  return new RegExp(`^${status} \\d+ - ${escapeRegExp(name)}$`, 'm').test(tap);
}

function tapCounts(tap) {
  const value = label => Number(tap.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] ?? -1);
  return { tests: value('tests'), pass: value('pass'), fail: value('fail') };
}

function hasSyntaxFailure(tap, stderr) {
  return SYNTAX_MARKERS.some(marker => `${tap}\n${stderr}`.includes(marker));
}

function originalRegressionsPass(tap) {
  return ORIGINAL_TESTS.every(name => testLine(tap, 'ok', name));
}

function assertExpected(label, condition, detail, errors) {
  if (!condition) errors.push(`${label}: ${detail}`);
}

function mutate(referenceSource, name) {
  const replacements = {
    'returned-stored-alias': {
      needle: 'return { key: op.key, ...structuredClone(entry) };',
      replacement: 'return { key: op.key, ...entry };',
      target: 'values are detached across input/result/store and shared input references',
      description: 'removes the result clone, aliasing the returned value to stored state',
    },
    'length17-accepted': {
      needle: 'operations.length > 16',
      replacement: 'operations.length > 17',
      target: 'batch length accepts16, rejects17 atomically',
      description: 'accepts a 17-operation batch despite the maximum length of 16',
    },
  };
  if (name === 'eager-commit-late-conflict') {
    const needle = [
      '      for (const op of operations) {',
      '        const actualVersion = entries.get(op.key)?.version ?? 0;',
      '        if (actualVersion !== op.expectedVersion) return {',
      "          ok: false, error: 'version_conflict', key: op.key,",
      '          expectedVersion: op.expectedVersion, actualVersion,',
      '        };',
      '      }',
    ].join('\n');
    const replacement = [
      '      for (const op of operations) {',
      '        const actualVersion = entries.get(op.key)?.version ?? 0;',
      '        if (actualVersion !== op.expectedVersion) return {',
      "          ok: false, error: 'version_conflict', key: op.key,",
      '          expectedVersion: op.expectedVersion, actualVersion,',
      '        };',
      '        const entry = { value: structuredClone(op.value), version: op.expectedVersion + 1 };',
      '        entries.set(op.key, entry);',
      '      }',
    ].join('\n');
    if (!referenceSource.includes(needle)) throw new Error(`eager mutant source anchor missing: ${name}`);
    return {
      source: referenceSource.replace(needle, replacement),
      target: 'late conflict is atomic and returns first conflicting input position',
      description: 'commits each validated operation before discovering a later conflict',
    };
  }
  const mutation = replacements[name];
  if (!mutation) throw new Error(`unknown mutant: ${name}`);
  if (referenceSource.split(mutation.needle).length !== 2) throw new Error(`mutant source anchor is not unique: ${name}`);
  return {
    source: referenceSource.replace(mutation.needle, mutation.replacement),
    target: mutation.target,
    description: mutation.description,
  };
}

function spawnVerifier(candidate, output) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [VERIFY, candidate, output, 'all'], {
      cwd: EXPERIMENT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolveResult({ exitCode, signal, stdout, stderr }));
  });
}

async function runVerifier(name, candidate, output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const runner = await spawnVerifier(candidate, output);
  await writeFile(join(dirname(output), 'runner-stdout.txt'), runner.stdout, { flag: 'wx', mode: 0o600 });
  await writeFile(join(dirname(output), 'runner-stderr.txt'), runner.stderr, { flag: 'wx', mode: 0o600 });
  let verifierResult = null;
  try {
    verifierResult = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  } catch (error) {
    verifierResult = { parseError: error instanceof Error ? error.message : String(error) };
  }
  const tap = await readFile(join(output, 'stdout.txt'), 'utf8').catch(() => '');
  const stderr = await readFile(join(output, 'stderr.txt'), 'utf8').catch(() => '');
  return {
    name,
    candidate,
    output,
    runner,
    verifierResult,
    tap,
    stderr,
    counts: tapCounts(tap),
    originalRegressionsPass: originalRegressionsPass(tap),
    syntaxFailure: hasSyntaxFailure(tap, stderr),
  };
}

function evaluateBaseline(outcome, errors) {
  const result = outcome.verifierResult;
  assertExpected('baseline verifier', result?.exitCode === 1 && result?.pass === false,
    'expected held-out checks to fail', errors);
  assertExpected('baseline original regressions', outcome.originalRegressionsPass,
    'both original fixture tests must pass', errors);
  assertExpected('baseline counts', outcome.counts.tests === 10 && outcome.counts.pass === 2 && outcome.counts.fail === 8,
    `expected 10 tests / 2 pass / 8 fail, got ${JSON.stringify(outcome.counts)}`, errors);
  assertExpected('baseline syntax', !outcome.syntaxFailure,
    'red evidence must be missing behavior, not syntax failure', errors);
}

function evaluateReference(outcome, errors) {
  const result = outcome.verifierResult;
  assertExpected('reference verifier', result?.exitCode === 0 && result?.pass === true,
    'reference must pass all original and held-out checks', errors);
  assertExpected('reference original regressions', outcome.originalRegressionsPass,
    'both original fixture tests must pass', errors);
  assertExpected('reference counts', outcome.counts.tests === 10 && outcome.counts.pass === 10 && outcome.counts.fail === 0,
    `expected 10 tests / 10 pass / 0 fail, got ${JSON.stringify(outcome.counts)}`, errors);
  assertExpected('reference syntax', !outcome.syntaxFailure,
    'reference must not rely on syntax-error masking', errors);
}

function evaluateMutant(outcome, mutation, errors) {
  const result = outcome.verifierResult;
  const behavioralFailure = testLine(outcome.tap, 'not ok', mutation.target)
    && /failureType:\s*['"]?testCodeFailure['"]?/.test(outcome.tap);
  assertExpected(`${outcome.name} verifier`, result?.exitCode === 1 && result?.pass === false,
    'defective reference must be rejected', errors);
  assertExpected(`${outcome.name} original regressions`, outcome.originalRegressionsPass,
    'mutant rejection must preserve the two original regression passes', errors);
  assertExpected(`${outcome.name} intended check`, behavioralFailure,
    `expected behavioral failure in '${mutation.target}'`, errors);
  assertExpected(`${outcome.name} syntax`, !outcome.syntaxFailure,
    'mutant rejection must not be caused by syntax or module resolution', errors);
}

function relativeRun(path) {
  return relative(RUN, path) || '.';
}

async function artifactRecords() {
  return records(ARTIFACTS);
}

async function main() {
  await directory(EXPERIMENT, 'experiment');
  await regular(VERIFY, 'verifier');
  await absent(REPORT);
  await absent(METADATA);
  await absent(ARTIFACTS);
  await mkdir(RUN, { recursive: true, mode: 0o700 });
  await mkdir(ARTIFACTS, { recursive: false, mode: 0o700 });

  const inputsBefore = await inputHashes();
  const tempRoot = await mkdtemp(join(tmpdir(), 'tinysdd-005-validation-'));
  const outcomes = [];
  const mutations = {};
  const errors = [];
  const referenceSource = await readFile(join(REFERENCE, 'src/store.mjs'), 'utf8');

  const baselineCandidate = join(tempRoot, 'baseline');
  await copyTree(FIXTURE, baselineCandidate);
  outcomes.push(await runVerifier('baseline', baselineCandidate, join(ARTIFACTS, 'baseline', 'verifier')));
  evaluateBaseline(outcomes.at(-1), errors);

  const referenceCandidate = join(tempRoot, 'reference');
  await copyTree(FIXTURE, referenceCandidate);
  await copyTree(join(REFERENCE, 'src'), join(referenceCandidate, 'src'));
  outcomes.push(await runVerifier('reference', referenceCandidate, join(ARTIFACTS, 'reference', 'verifier')));
  evaluateReference(outcomes.at(-1), errors);

  for (const name of ['returned-stored-alias', 'length17-accepted', 'eager-commit-late-conflict']) {
    const mutation = mutate(referenceSource, name);
    mutations[name] = mutation;
    const candidate = join(tempRoot, name);
    await copyTree(FIXTURE, candidate);
    await copyTree(join(REFERENCE, 'src'), join(candidate, 'src'));
    const mutantDir = join(ARTIFACTS, 'mutants', name);
    await mkdir(mutantDir, { recursive: true, mode: 0o700 });
    const sourcePath = join(mutantDir, 'store.mjs');
    await writeFile(sourcePath, mutation.source, { flag: 'wx', mode: 0o600 });
    await writeFile(join(candidate, 'src/store.mjs'), mutation.source, { flag: 'w', mode: 0o600 });
    const outcome = await runVerifier(name, candidate, join(mutantDir, 'verifier'));
    outcome.mutantSource = sourcePath;
    outcome.mutantSourceSha256 = sha(Buffer.from(mutation.source));
    outcomes.push(outcome);
    evaluateMutant(outcome, mutation, errors);
  }

  const inputsAfter = await inputHashes();
  const inputsStable = equalJson(inputsBefore, inputsAfter);
  assertExpected('experiment inputs', inputsStable,
    'fixture, reference, checks, verifier or protocol changed during validation', errors);

  const metadata = {
    schemaVersion: 1,
    kind: 'titan-cli-pilot-validation',
    experiment: '005-titan-cli-pilot',
    verifier: relativeRun(VERIFY),
    tempRoot,
    inputsBefore,
    inputsAfter,
    inputsStable,
    outcomes: outcomes.map(outcome => ({
      name: outcome.name,
      candidate: outcome.candidate,
      output: relativeRun(outcome.output),
      verifierResult: outcome.verifierResult,
      counts: outcome.counts,
      originalRegressionsPass: outcome.originalRegressionsPass,
      syntaxFailure: outcome.syntaxFailure,
      mutantSource: outcome.mutantSource ? relativeRun(outcome.mutantSource) : undefined,
      mutantSourceSha256: outcome.mutantSourceSha256,
    })),
    mutations: Object.fromEntries(Object.entries(mutations).map(([name, mutation]) => [name, {
      description: mutation.description,
      intendedRejectingCheck: mutation.target,
      sourceSha256: sha(Buffer.from(mutation.source)),
    }])),
    errors,
  };
  metadata.artifacts = await artifactRecords();
  await writeFile(METADATA, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  const report = [
    '# Experiment 005 validation report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This validation uses only the supplied credential-free `verify.mjs`; it does not run models, access the network, or modify experiment inputs.',
    '',
    `- Verifier: \`${relativeRun(VERIFY)}\``,
    `- Temporary candidate root: \`${tempRoot}\` (retained for inspection)`,
    `- Input hashes stable: **${inputsStable ? 'yes' : 'no'}**`,
    `- Metadata: \`${relativeRun(METADATA)}\``,
    '',
    '## Outcomes',
    '',
    '| Candidate | Result | Tests | Original regressions | Syntax-free | Evidence |',
    '| --- | --- | ---: | --- | --- | --- |',
    ...outcomes.map(outcome => {
      const result = outcome.verifierResult;
      const label = outcome.name === 'baseline'
        ? (result?.pass === false && outcome.counts.pass === 2 && outcome.counts.fail === 8 ? 'expected red' : 'unexpected')
        : outcome.name === 'reference'
          ? (result?.pass === true && outcome.counts.pass === 10 ? 'pass' : 'unexpected')
          : (errors.some(error => error.startsWith(`${outcome.name} `)) ? 'unexpected' : 'behaviorally rejected');
      const evidence = outcome.name === 'baseline' || outcome.name === 'reference'
        ? relativeRun(outcome.output)
        : `${relativeRun(outcome.mutantSource)}; ${relativeRun(outcome.output)}`;
      return `| ${outcome.name} | ${label} | ${outcome.counts.pass}/${outcome.counts.tests} | ${outcome.originalRegressionsPass ? 'pass' : 'fail'} | ${outcome.syntaxFailure ? 'no' : 'yes'} | \`${evidence}\` |`;
    }),
    '',
    'The baseline preserves both original tests but fails all eight new checks, establishing missing-behavior red evidence. The reference passes both original regressions and all eight new checks. Each mechanical mutant is rejected by its named behavioral check while retaining the original regressions and avoiding syntax/module-resolution failure.',
    '',
    '## Fixture/oracle review',
    '',
    'No contradiction was found between the task brief, held-out checks and the trusted reference. The checks cover the required atomic late-conflict path, shape-before-version validation, duplicate/length boundaries, detached values and shared version state. They intentionally do not claim coverage for out-of-scope cycles/getters/classes/resource exhaustion or every possible JSON-compatible value boundary.',
    '',
    '## Benchmark readiness',
    '',
    errors.length === 0
      ? 'Mechanically ready for the bounded pilot: baseline red evidence, reference green evidence, and three behaviorally rejected defective references are retained. This is preparation evidence only; it does not support model ranking, reliability or causal claims.'
      : `NOT READY: ${errors.join(' ')}`,
    '',
  ].join('\n');
  await writeFile(REPORT, report, { flag: 'wx', mode: 0o600 });

  console.log(JSON.stringify({
    report,
    metadata,
    outcomes: outcomes.map(outcome => ({ name: outcome.name, result: outcome.verifierResult, counts: outcome.counts })),
    errors,
  }));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
