import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBenchmark } from '../src/benchmark-runner.mjs';
import { parseBenchmarkCaseResult } from '../src/benchmark-results.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const execFileAsync = promisify(execFile);
const SUITE_ROOT = fileURLToPath(new URL('../bench/write-tests-suite/', import.meta.url));
const VERIFIER = resolve(SUITE_ROOT, 'verifier/write-tests-verifier.mjs');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function childEnvironment() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function makeRuntime(root, candidateRoots) {
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeJson(join(agent, 'models.json'), {
    providers: {
      fake: {
        api: 'openai-completions',
        baseUrl: '$FAKE_BASE',
        apiKey: '$FAKE_TOKEN',
        models: [{ id: 'fake/model', contextWindow: 4096, maxTokens: 256, input: ['text'], reasoning: false }],
      },
    },
  });
  const pi = join(root, 'fake-pi.mjs');
  await writeFile(pi, `#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const challenge = process.env.TINYSDD_TEST_CHALLENGE;
const roots = JSON.parse(process.env.TINYSDD_TEST_CANDIDATE_ROOTS || '{}');
const source = roots[challenge];
if (source && existsSync(source)) {
  mkdirSync(join(process.cwd(), 'tests'), { recursive: true });
  cpSync(source, join(process.cwd(), 'tests', 'contract.test.mjs'));
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }));
`);
  await chmod(pi, 0o755);
  return {
    test: true,
    piExecutable: pi,
    sourceAgentDir: agent,
    sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
    testEnv: { TINYSDD_TEST_CANDIDATE_ROOTS: JSON.stringify(candidateRoots) },
    checkRunner: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      output: { text: '', tail: '', truncated: false },
      sandbox: { runner: 'test-check-runner', network: 'none' },
    }),
  };
}

// This callback is only accepted by runBenchmark with runtime.test === true.
// It executes the canonical overlaid verifier argv and derives status from Node.
async function runGenuineVerifier({ check, candidateDir, visibility, dependencyMounts }) {
  assert.ok(candidateDir.includes('tinysdd-benchmark-evaluator-'));
  assert.deepEqual(dependencyMounts, []);
  try {
    const output = await execFileAsync(process.execPath, check.argv.slice(1), {
      cwd: candidateDir,
      env: childEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    });
    return {
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      outputText: `${output.stdout}${output.stderr}`,
      sandbox: { runner: 'test-only-verifier-injection', network: 'none', evaluator: 'independent-copy', visibility },
    };
  } catch (error) {
    return {
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : 1,
      signal: error.signal ?? null,
      timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
      durationMs: 1,
      outputText: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      sandbox: { runner: 'test-only-verifier-injection', network: 'none', evaluator: 'independent-copy', visibility },
    };
  }
}

async function caseResults(result, outputRoot) {
  return Promise.all(result.invocation.caseResults.map(async (ref) => ({
    ref,
    value: parseBenchmarkCaseResult(await readFile(join(outputRoot, ref.path), 'utf8')),
  })));
}

function outputPath(outputRoot, record) {
  return join(outputRoot, record.output.ref);
}

test('write-tests runs the same submitted bytes against reference and all declared mutants', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-runner-'));
  const suiteRoot = join(root, 'suite');
  const outputRoot = join(root, 'results');
  await cp(SUITE_ROOT, suiteRoot, { recursive: true });
  const audit = await readJson(join(suiteRoot, 'challenge-audit.json'));
  const candidateRoots = Object.fromEntries(audit.challenges.map((entry) => [
    entry.id,
    join(suiteRoot, entry.referenceTest.path),
  ]));
  const runtime = await makeRuntime(root, candidateRoots);
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    const result = await runBenchmark({
      suiteRoot,
      outputRoot,
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 10000, maxToolCalls: 20 } },
      runtime,
      repeat: 1,
      verifier: runGenuineVerifier,
    });
    const cases = await caseResults(result, outputRoot);
    assert.equal(cases.length, audit.challenges.length);
    let declaredMutants = 0;
    let killedMutants = 0;
    for (const { value } of cases) {
      const audited = audit.challenges.find((entry) => entry.id === value.challenge.id);
      assert.ok(audited);
      if (value.outcome !== 'completed') {
        const verifierOutput = await Promise.all([...value.verifier.visible, ...value.verifier.heldOut].map(async (record) => ({
          checkId: record.checkId,
          status: record.status,
          output: record.output.ref === 'UNKNOWN' ? '' : await readFile(outputPath(outputRoot, record), 'utf8'),
        })));
        assert.fail(`${value.challenge.id}: ${JSON.stringify({ failure: value.failure, verifierOutput })}`);
      }
      assert.equal(value.verifier.visible.length, 1, value.challenge.id);
      assert.equal(value.verifier.visible[0].checkId, 'reference-tests');
      assert.equal(value.verifier.visible[0].status, 'passed', value.challenge.id);
      const visibleOutput = await readFile(outputPath(outputRoot, value.verifier.visible[0]), 'utf8');
      assert.match(visibleOutput, new RegExp(`# tests ${audited.witnesses.length}\\b`, 'u'));
      assert.match(visibleOutput, new RegExp(`# pass ${audited.witnesses.length}\\b`, 'u'));
      assert.match(visibleOutput, /# fail 0\b/u);
      assert.match(visibleOutput, /# skipped 0\b/u);
      assert.match(visibleOutput, /# todo 0\b/u);
      assert.match(visibleOutput, new RegExp(`candidate-sha256:${audited.referenceTest.sha256}`, 'u'));

      const expectedIds = new Set(audited.wrongSources.map((mutant) => `mutant-${mutant.id}`));
      assert.deepEqual(new Set(value.verifier.heldOut.map((record) => record.checkId)), expectedIds);
      declaredMutants += value.verifier.heldOut.length;
      for (const record of value.verifier.heldOut) {
        const mutant = audited.wrongSources.find((entry) => `mutant-${entry.id}` === record.checkId);
        const witness = audited.witnesses.find((entry) => entry.id === mutant.kills[0]);
        const heldOutOutput = await readFile(outputPath(outputRoot, record), 'utf8');
        assert.equal(record.status, 'passed', `${value.challenge.id}/${mutant.id}`);
        const testsMatch = heldOutOutput.match(/# tests (\d+)/u);
        const passMatch = heldOutOutput.match(/# pass (\d+)/u);
        const failMatch = heldOutOutput.match(/# fail (\d+)/u);
        assert.ok(testsMatch && passMatch && failMatch, `${value.challenge.id}/${mutant.id} missing TAP summary`);
        assert.ok(Number(testsMatch[1]) > 0, `${value.challenge.id}/${mutant.id} ran no tests`);
        assert.equal(Number(passMatch[1]) + Number(failMatch[1]), Number(testsMatch[1]), `${value.challenge.id}/${mutant.id} has an incomplete TAP summary`);
        assert.ok(Number(failMatch[1]) > 0, `${value.challenge.id}/${mutant.id} has no failed test`);
        assert.match(heldOutOutput, new RegExp(`not ok \\d+ - ${witness.testName}`, 'u'));
        assert.match(heldOutOutput, /failureType: 'testCodeFailure'/u);
        assert.match(heldOutOutput, /# cancelled 0\b/u);
        assert.match(heldOutOutput, /# skipped 0\b/u);
        assert.match(heldOutOutput, /# todo 0\b/u);
        assert.match(heldOutOutput, new RegExp(`candidate-sha256:${audited.referenceTest.sha256}`, 'u'));
        killedMutants += 1;
      }
      const candidateTest = join(outputRoot, `cases/${value.attemptId}/worker-candidate/tests/contract.test.mjs`);
      assert.equal(await sha256(await readFile(candidateTest)), audited.referenceTest.sha256, value.challenge.id);
    }
    assert.equal(declaredMutants, 20);
    assert.equal(killedMutants, 20);
    assert.equal(result.summary.groups[0].completed, 5);
    assert.equal(result.summary.groups[0].failed, 0);
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('write-tests verifier rejects empty, skipped, syntax-invalid, and setup-failing candidates', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-invalid-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'tests'), { recursive: true });
  const mutant = resolve(SUITE_ROOT, 'candidates/amber-input-validation/wrong-endpoint-timeout/src/options.mjs');
  const expectedWitness = 'C3 enforces the inclusive timeout bounds';
  const variants = [
    ['empty', ''],
    ['named-empty', "import test from 'node:test';\ntest('C3 enforces the inclusive timeout bounds', () => {});\n"],
    ['skipped', "import test from 'node:test';\ntest('C3 enforces the inclusive timeout bounds', { skip: true }, () => {});\n"],
    ['syntax-invalid', "import test from 'node:test';\ntest('C3 enforces the inclusive timeout bounds', () => {\n"],
    ['setup-failing', "throw new Error('setup failed');\n"],
  ];
  try {
    for (const [label, source] of variants) {
      await writeFile(join(candidate, 'tests/contract.test.mjs'), source);
      await assert.rejects(
        execFileAsync(process.execPath, [VERIFIER, 'mutant', 'amber-input-validation', mutant, expectedWitness], {
          cwd: candidate,
          env: childEnvironment(),
          maxBuffer: 2 * 1024 * 1024,
          timeout: 10000,
        }),
        (error) => {
          const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
          assert.notEqual(error.code, 0, label);
          assert.match(output, /candidate-sha256:[a-f0-9]{64}/u, label);
          assert.doesNotMatch(output, new RegExp(`not ok \\d+ - ${expectedWitness}`, 'u'), label);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write-tests verifier rejects an evaluator import failure as a mutant kill', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-import-failure-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'src'), { recursive: true });
  await mkdir(join(candidate, 'tests'), { recursive: true });
  await cp(
    resolve(SUITE_ROOT, 'fixtures/amber-input-validation/src/options.mjs'),
    join(candidate, 'src/options.mjs'),
  );
  const expectedWitness = 'C3 enforces the inclusive timeout bounds';
  const referenceTest = await readFile(resolve(SUITE_ROOT, 'candidates/amber-input-validation/reference/tests/contract.test.mjs'), 'utf8');
  const c3Start = referenceTest.indexOf(`test('${expectedWitness}'`);
  const c4Start = referenceTest.indexOf("test('C4", c3Start);
  assert.ok(c3Start >= 0 && c4Start > c3Start);
  const importFailureWitness = `test('${expectedWitness}', async () => {
  try {
    normalizeOptions({ timeoutMs: 1 });
  } catch {
    await import('../src/missing-dependency.mjs');
  }
});

`;
  await writeFile(join(candidate, 'tests/contract.test.mjs'), `${referenceTest.slice(0, c3Start)}${importFailureWitness}${referenceTest.slice(c4Start)}`);
  const mutant = resolve(SUITE_ROOT, 'candidates/amber-input-validation/wrong-endpoint-timeout/src/options.mjs');
  try {
    const reference = await execFileAsync(process.execPath, [VERIFIER, 'reference', 'amber-input-validation'], {
      cwd: candidate,
      env: childEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    });
    assert.match(reference.stdout, /# tests 4\b/u);
    assert.match(reference.stdout, /# pass 4\b/u);
    await assert.rejects(
      execFileAsync(process.execPath, [VERIFIER, 'mutant', 'amber-input-validation', mutant, expectedWitness], {
        cwd: candidate,
        env: childEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
      }),
      (error) => {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        assert.notEqual(error.code, 0);
        assert.match(output, /ERR_MODULE_NOT_FOUND/u);
        assert.match(output, /candidate-sha256:[a-f0-9]{64}/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write-tests verifier rejects evaluator syntax failures but keeps API SyntaxErrors substantive', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-syntax-failure-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'src'), { recursive: true });
  await mkdir(join(candidate, 'tests'), { recursive: true });
  const expectedWitness = 'C3 enforces the inclusive timeout bounds';
  const referenceTest = `import { Script } from 'node:vm';\n${await readFile(resolve(SUITE_ROOT, 'candidates/amber-input-validation/reference/tests/contract.test.mjs'), 'utf8')}`;
  const c3Start = referenceTest.indexOf(`test('${expectedWitness}'`);
  const c4Start = referenceTest.indexOf("test('C4", c3Start);
  assert.ok(c3Start >= 0 && c4Start > c3Start);
  const syntaxExpressions = [
    "new Function('const invalid = ;');",
    "eval('const invalid = ;');",
    "new Script('const invalid = ;');",
  ];
  const endpointMutant = resolve(SUITE_ROOT, 'candidates/amber-input-validation/wrong-endpoint-timeout/src/options.mjs');
  const apiSyntaxErrorSource = (await readFile(resolve(SUITE_ROOT, 'fixtures/amber-input-validation/src/options.mjs'), 'utf8'))
    .replace(
      "  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;",
      "  if (input.timeoutMs === 1) throw new SyntaxError('contract API failure');\n\n  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;",
    );
  await cp(
    resolve(SUITE_ROOT, 'fixtures/amber-input-validation/src/options.mjs'),
    join(candidate, 'src/options.mjs'),
  );
  try {
    for (const expression of syntaxExpressions) {
      const syntaxFailureTest = `test('${expectedWitness}', () => {
  try {
    normalizeOptions({ timeoutMs: 1 });
  } catch {
    ${expression}
  }
});

`;
      await writeFile(join(candidate, 'tests/contract.test.mjs'), `${referenceTest.slice(0, c3Start)}${syntaxFailureTest}${referenceTest.slice(c4Start)}`);
      const reference = await execFileAsync(process.execPath, [VERIFIER, 'reference', 'amber-input-validation'], {
        cwd: candidate,
        env: childEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
      });
      assert.match(reference.stdout, /# tests 4\b/u);
      assert.match(reference.stdout, /# pass 4\b/u);
      await assert.rejects(
        execFileAsync(process.execPath, [VERIFIER, 'mutant', 'amber-input-validation', endpointMutant, expectedWitness], {
          cwd: candidate,
          env: childEnvironment(),
          maxBuffer: 2 * 1024 * 1024,
          timeout: 10000,
        }),
        (error) => {
          const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
          assert.notEqual(error.code, 0);
          assert.match(output, /name: 'SyntaxError'/u);
          assert.match(output, /tests\/contract\.test\.mjs/u);
          return true;
        },
      );
    }

    await writeFile(join(candidate, 'src/options.mjs'), apiSyntaxErrorSource);
    await writeFile(join(candidate, 'tests/contract.test.mjs'), `${referenceTest.slice(0, c3Start)}test('${expectedWitness}', () => {\n  normalizeOptions({ timeoutMs: 1 });\n});\n\n${referenceTest.slice(c4Start)}`);
    const apiSyntaxError = await execFileAsync(process.execPath, [VERIFIER, 'mutant', 'amber-input-validation', 'src/options.mjs', expectedWitness], {
      cwd: candidate,
      env: childEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    });
    assert.match(apiSyntaxError.stdout, /name: 'SyntaxError'/u);
    assert.match(apiSyntaxError.stdout, /\/src\/options\.mjs:\d+:\d+/u);
    assert.match(apiSyntaxError.stdout, /# fail 1\b/u);
    assert.match(apiSyntaxError.stdout, /candidate-sha256:[a-f0-9]{64}/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write-tests verifier accepts extra tests and multiple mapped failures', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-compound-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'src'), { recursive: true });
  await mkdir(join(candidate, 'tests'), { recursive: true });
  await cp(
    resolve(SUITE_ROOT, 'fixtures/amber-input-validation/src/options.mjs'),
    join(candidate, 'src/options.mjs'),
  );
  const referenceTest = await readFile(resolve(SUITE_ROOT, 'candidates/amber-input-validation/reference/tests/contract.test.mjs'), 'utf8');
  await writeFile(join(candidate, 'tests/contract.test.mjs'), `${referenceTest}\ntest('extra endpoint coverage', () => { assert.equal(normalizeOptions({ timeoutMs: 1 }).timeoutMs, 1); });\n`);
  const mutant = resolve(SUITE_ROOT, 'candidates/amber-input-validation/wrong-endpoint-timeout/src/options.mjs');
  try {
    const reference = await execFileAsync(process.execPath, [VERIFIER, 'reference', 'amber-input-validation'], {
      cwd: candidate,
      env: childEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    });
    assert.match(reference.stdout, /# tests 5\b/u);
    assert.match(reference.stdout, /# pass 5\b/u);
    const mutantResult = await execFileAsync(process.execPath, [VERIFIER, 'mutant', 'amber-input-validation', mutant, 'C3 enforces the inclusive timeout bounds'], {
      cwd: candidate,
      env: childEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    });
    assert.match(mutantResult.stdout, /# tests 5\b/u);
    assert.match(mutantResult.stdout, /# pass 3\b/u);
    assert.match(mutantResult.stdout, /# fail 2\b/u);
    assert.match(mutantResult.stdout, /not ok \d+ - C3 enforces the inclusive timeout bounds/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
