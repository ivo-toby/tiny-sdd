import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;
const CHALLENGES = Object.freeze({
  'amber-input-validation': {
    module: 'options.mjs',
    witnesses: [
      'C1 defaults omitted options without dropping explicit values',
      'C2 rejects non-integer timeout values instead of coercing them',
      'C3 enforces the inclusive timeout bounds',
      'C4 canonicalizes header names while retaining their values',
    ],
  },
  'birch-collection-order': {
    module: 'group-by.mjs',
    witnesses: [
      'C1 preserves first-seen group order',
      'C2 preserves member order within each group',
      'C3 does not mutate the input collection',
    ],
  },
  'cobalt-state-machine': {
    module: 'state-machine.mjs',
    witnesses: [
      'C1 accepts only legal state transitions',
      'C2 rejects events after a terminal state',
      'C3 returns a new state without mutating the input',
    ],
  },
  'crimson-settlement': {
    module: 'settle.mjs',
    witnesses: [
      'C1 records fulfillment and rejection without rejecting the batch',
      'C2 keeps results in declaration order when completion order differs',
      'C3 starts every task before awaiting settlement',
    ],
  },
  'dune-emitter-edge': {
    module: 'emitter.mjs',
    witnesses: [
      'C1 deduplicates the same subscription',
      'C2 dispatches a snapshot in subscription order',
      'C3 removes only the target subscription and is idempotent',
    ],
  },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function childEnvironment() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function summary(output, name) {
  const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'mu'));
  return match ? Number(match[1]) : null;
}

function witnessLine(output, prefix, name) {
  return output.split(/\r?\n/u).some((line) => line.startsWith(`${prefix} `) && line.endsWith(` - ${name}`));
}

function witnessBlock(output, prefix, name) {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`${prefix} `) && line.endsWith(` - ${name}`));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line === '  ...');
  return lines.slice(start, end < 0 ? lines.length : end + 1).join('\n');
}

function hasEvaluatorFailure(block) {
  return /\b(?:ERR_MODULE_[A-Z_]+|MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT|ERR_INVALID_MODULE_SPECIFIER)\b/u.test(block)
    || /Cannot find (?:module|package)/u.test(block)
    || /node:internal\/modules\/(?:esm|cjs)\//u.test(block)
    || (/name: 'SyntaxError'/u.test(block) && /\bnew Function \(<anonymous>\)/u.test(block));
}

function executionFailure(error) {
  return {
    exitCode: typeof error.code === 'number' ? error.code : 1,
    signal: error.signal ?? null,
    timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
    output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
  };
}

async function evaluateCandidate(challenge, sourcePath) {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-write-tests-evaluator-'));
  try {
    const tests = await readFile(join(process.cwd(), 'tests', 'contract.test.mjs'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'tests', 'contract.test.mjs'), tests, { mode: 0o600 });
    const source = sourcePath === undefined
      ? join(process.cwd(), 'src', challenge.module)
      : resolve(process.cwd(), sourcePath);
    await cp(source, join(root, 'src', basename(challenge.module)));
    const candidateDigest = sha256(tests);
    try {
      const result = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', 'tests/contract.test.mjs'], {
        cwd: root,
        env: childEnvironment(),
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: TIMEOUT_MS,
      });
      return { ...result, exitCode: 0, signal: null, timedOut: false, candidateDigest };
    } catch (error) {
      return { ...executionFailure(error), candidateDigest };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validReference(result, challenge) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return result.exitCode === 0
    && result.signal === null
    && result.timedOut === false
    && summary(output, 'tests') > 0
    && summary(output, 'pass') === summary(output, 'tests')
    && summary(output, 'fail') === 0
    && summary(output, 'cancelled') === 0
    && summary(output, 'skipped') === 0
    && summary(output, 'todo') === 0
    && challenge.witnesses.every((name) => witnessLine(output, 'ok', name));
}

function validMutant(result, challenge, expectedWitness) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tests = summary(output, 'tests');
  const failed = summary(output, 'fail');
  return result.exitCode === 1
    && result.signal === null
    && result.timedOut === false
    && tests > 0
    && failed > 0
    && summary(output, 'pass') + failed === tests
    && summary(output, 'cancelled') === 0
    && summary(output, 'skipped') === 0
    && summary(output, 'todo') === 0
    && witnessLine(output, 'not ok', expectedWitness)
    && challenge.witnesses.filter((name) => name !== expectedWitness).every((name) => witnessLine(output, 'ok', name) || witnessLine(output, 'not ok', name))
    && witnessBlock(output, 'not ok', expectedWitness).includes("failureType: 'testCodeFailure'")
    && !hasEvaluatorFailure(witnessBlock(output, 'not ok', expectedWitness));
}

async function main() {
  const [mode, challengeId, sourcePath, expectedWitness] = process.argv.slice(2);
  const challenge = CHALLENGES[challengeId];
  if (!challenge || (mode !== 'reference' && mode !== 'mutant')) {
    throw new Error('invalid verifier arguments');
  }
  if (mode === 'mutant' && (!sourcePath || !expectedWitness || !challenge.witnesses.includes(expectedWitness))) {
    throw new Error('invalid mutant verifier arguments');
  }
  const result = await evaluateCandidate(challenge, mode === 'mutant' ? sourcePath : undefined);
  const output = result.stdout === undefined ? result.output : `${result.stdout}${result.stderr}`;
  const valid = mode === 'reference' ? validReference(result, challenge) : validMutant({ ...result, stdout: result.stdout ?? result.output, stderr: result.stderr ?? '' }, challenge, expectedWitness);
  process.stdout.write(`${output}${output.endsWith('\n') ? '' : '\n'}candidate-sha256:${result.candidateDigest}\n`);
  if (!valid) process.stderr.write(`write-tests verifier rejected ${mode} execution\n`);
  process.exitCode = valid ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`write-tests verifier setup failure: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
