import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { benchmarkFixtureDigest, runBenchmark } from '../src/benchmark-runner.mjs';
import { parseBenchmarkChallenge, parseBenchmarkSuite } from '../src/benchmark-schema.mjs';
import { parseChecksManifest } from '../src/checks-manifest.mjs';
import { parseContextManifest } from '../src/context-compiler.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const execFileAsync = promisify(execFile);
const SUITE_ROOT = fileURLToPath(new URL('../bench/implement-slice-suite/', import.meta.url));
const EXPECTED_CATEGORIES = new Map([
  ['copper-tokenize', 'new-module'],
  ['orbit-window', 'new-module'],
  ['harbor-playlist', 'brownfield'],
  ['quartz-ledger', 'brownfield'],
  ['maple-queue-fix', 'bugfix'],
  ['cedar-receipt-fix', 'bugfix'],
  ['ripple-batch-async', 'async-heavy'],
  ['ember-option-api', 'library-api-trap'],
  ['linen-retry-lint', 'lint-rule-trap'],
  ['opal-missing-inputs', 'stop-and-ask'],
]);
const EXPECTED_VISIBLE_TESTS = new Map([
  ['copper-tokenize', 2],
  ['orbit-window', 2],
  ['harbor-playlist', 2],
  ['quartz-ledger', 3],
  ['maple-queue-fix', 1],
  ['cedar-receipt-fix', 3],
  ['ripple-batch-async', 1],
  ['ember-option-api', 2],
  ['linen-retry-lint', 2],
  ['opal-missing-inputs', 1],
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function inside(root, candidate) {
  const escaped = relative(root, candidate);
  return escaped === '' || (escaped !== '..' && !escaped.startsWith(`..${'/'}`) && !escaped.startsWith('/'));
}

async function allFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `suite contains symlink ${relativePath}`);
    if (info.isDirectory()) result.push(...await allFiles(path, relativePath));
    else if (info.isFile()) result.push(relativePath);
    else assert.fail(`suite contains unsupported entry ${relativePath}`);
  }
  return result;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function childEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function assertNodeTestSummary(output, expectedTests, label) {
  const summary = (name) => {
    const match = output.match(new RegExp(`^(?:# |ℹ )${name} (\\d+)$`, 'mu'));
    assert.ok(match, `${label} did not report ${name}`);
    return Number(match[1]);
  };
  assert.equal(summary('tests'), expectedTests, `${label} test count`);
  assert.equal(summary('pass'), expectedTests, `${label} pass count`);
  assert.equal(summary('fail'), 0, `${label} fail count`);
  assert.equal(summary('skipped'), 0, `${label} skipped count`);
}

async function makeRuntime(root, candidateRoots, mutations = {}) {
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
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const challenge = process.env.TINYSDD_TEST_CHALLENGE;
const roots = JSON.parse(process.env.TINYSDD_TEST_CANDIDATE_ROOTS || '{}');
const mutation = JSON.parse(process.env.TINYSDD_TEST_MUTATIONS || '{}')[challenge];
const candidate = roots[challenge];
if (candidate && mutation !== 'required-patch-absent') {
  for (const name of ['src', 'questions']) {
    const source = join(candidate, name);
    if (existsSync(source)) cpSync(source, join(process.cwd(), name), { recursive: true });
  }
}
if (mutation === 'out-of-scope') writeFileSync(join(process.cwd(), 'unexpected.txt'), 'out of scope\\n');
if (mutation === 'protected-file') writeFileSync(join(process.cwd(), 'src', 'option.mjs'), '/* retained protected file */\\n', { flag: 'a' });
if (mutation === 'protected-test') writeFileSync(join(process.cwd(), 'tests', 'visible.test.mjs'), '\\n// retained protected test\\n', { flag: 'a' });
if (mutation === 'stop-and-ask-source') writeFileSync(join(process.cwd(), 'src', 'service.mjs'), '\\n// retained protected source\\n', { flag: 'a' });
if (process.env.TINYSDD_TEST_SPAWN_MARKER && existsSync(process.env.TINYSDD_TEST_SPAWN_MARKER)) writeFileSync(process.env.TINYSDD_TEST_SPAWN_MARKER, 'spawned\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }));
`);
  await chmod(pi, 0o755);
  return {
    test: true,
    piExecutable: pi,
    sourceAgentDir: agent,
    sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
    testEnv: {
      TINYSDD_TEST_CANDIDATE_ROOTS: JSON.stringify(candidateRoots),
      TINYSDD_TEST_MUTATIONS: JSON.stringify(mutations),
    },
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

async function runVerifier({ check, candidateDir }) {
  try {
    const output = await execFileAsync(process.execPath, check.argv.slice(1), {
      cwd: candidateDir,
      env: childEnvironment({ NODE_OPTIONS: '' }),
      maxBuffer: 1024 * 1024,
    });
    return {
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      outputText: `${output.stdout}${output.stderr}`,
      sandbox: { runner: 'test-verifier', network: 'none' },
    };
  } catch (error) {
    return {
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : 1,
      signal: null,
      timedOut: false,
      durationMs: 1,
      outputText: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      sandbox: { runner: 'test-verifier', network: 'none' },
    };
  }
}

async function candidateRootsFor(suiteRoot, kind) {
  const audit = await readJson(join(suiteRoot, 'challenge-audit.json'));
  return Object.fromEntries(audit.challenges.map((entry) => [
    entry.id,
    resolve(suiteRoot, kind === 'reference' ? entry.reference.path : entry.wrong[0].path),
  ]));
}

async function runSuite(kind, { repeat = 1, mutations = {}, suiteMutation = null } = {}) {
  const root = await mkdtemp(join(await realpathTmpdir(), `tinysdd-challenges-${kind}-`));
  const suiteRoot = join(root, 'suite');
  await cp(SUITE_ROOT, suiteRoot, { recursive: true });
  if (suiteMutation) await suiteMutation(suiteRoot);
  const candidateRoots = await candidateRootsFor(suiteRoot, kind);
  const runtime = await makeRuntime(root, candidateRoots, mutations);
  const outputRoot = join(root, 'results');
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  let result;
  try {
    result = await runBenchmark({
      suiteRoot,
      outputRoot,
      worker: { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 10000, maxToolCalls: 20 } },
      runtime,
      repeat,
      verifier: runVerifier,
    });
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
  }
  return { root, suiteRoot, outputRoot, result };
}

async function realpathTmpdir() {
  return (await import('node:fs/promises')).realpath(tmpdir());
}

async function caseResults(run) {
  return Promise.all(run.result.invocation.caseResults.map(async (ref) => ({
    ref,
    value: JSON.parse(await readFile(join(run.outputRoot, ref.path), 'utf8')),
  })));
}

test('suite manifests contain exactly the ten supported challenge classes', async () => {
  const suite = parseBenchmarkSuite(await readFile(join(SUITE_ROOT, 'suite.json'), 'utf8'));
  assert.equal(suite.challenges.length, EXPECTED_CATEGORIES.size);
  const audit = await readJson(join(SUITE_ROOT, 'challenge-audit.json'));
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.suiteId, suite.id);
  assert.deepEqual(new Set(audit.challenges.map((entry) => entry.id)), new Set(EXPECTED_CATEGORIES.keys()));
  const seen = new Set();
  for (const ref of suite.challenges) {
    assert.equal(await sha256(await readFile(join(SUITE_ROOT, ref.path))), ref.sha256);
    const challenge = parseBenchmarkChallenge(await readFile(join(SUITE_ROOT, ref.path), 'utf8'));
    assert.equal(seen.has(challenge.id), false);
    seen.add(challenge.id);
    assert.equal(EXPECTED_CATEGORIES.get(challenge.id), challenge.difficultyTags[0]);
    assert.equal(challenge.role, challenge.id === 'opal-missing-inputs' ? 'stop-and-ask' : 'implement-slice');
    assert.equal(challenge.packet.allowedPaths.some((path) => challenge.packet.protectedPaths.includes(path)), false);
    assert.equal((await benchmarkFixtureDigest(join(SUITE_ROOT, challenge.fixture.path))).sha256, challenge.fixture.sha256);
    for (const resource of [challenge.packet.brief, challenge.packet.context, challenge.packet.checks, challenge.verifier.visible, challenge.verifier.heldOut]) {
      assert.equal(await sha256(await readFile(join(SUITE_ROOT, resource.path))), resource.sha256, resource.path);
    }
    parseChecksManifest(await readFile(join(SUITE_ROOT, challenge.packet.checks.path), 'utf8'));
    parseContextManifest(await readFile(join(SUITE_ROOT, challenge.packet.context.path), 'utf8'));
    parseChecksManifest(await readFile(join(SUITE_ROOT, challenge.verifier.visible.path), 'utf8'));
    parseChecksManifest(await readFile(join(SUITE_ROOT, challenge.verifier.heldOut.path), 'utf8'));
    assert.doesNotMatch(JSON.stringify(challenge), /reference|wrong/u);
  }
  assert.deepEqual([...seen], [...EXPECTED_CATEGORIES.keys()]);
  for (const entry of audit.challenges) {
    for (const candidate of [entry.reference, ...entry.wrong]) {
      const candidateRoot = resolve(SUITE_ROOT, candidate.path);
      assert.equal(inside(SUITE_ROOT, candidateRoot), true);
      assert.equal(candidateRoot.includes(`${join('fixtures')}${'/'}`), false);
      assert.equal((await benchmarkFixtureDigest(candidateRoot)).sha256, candidate.sha256, candidate.path);
    }
  }
});

test('reference candidates pass visible and held-out checks, wrong candidates fail substantive held-out checks', async () => {
  const reference = await runSuite('reference', { repeat: 2 });
  try {
    assert.equal(reference.result.invocation.caseResults.length, 20);
    assert.equal(reference.result.summary.groups.reduce((total, group) => total + group.scheduled, 0), 20);
    assert.equal(reference.result.summary.groups.reduce((total, group) => total + group.completed, 0), 20);
    const cases = await caseResults(reference);
    for (const { value } of cases) {
      assert.equal(value.outcome, 'completed', value.challenge.id);
      assert.deepEqual(value.verifier.visible.map(({ status }) => status), ['passed']);
      assert.deepEqual(value.verifier.heldOut.map(({ status }) => status), ['passed']);
      assert.deepEqual(value.hardGates, {
        outOfScopeEdit: false,
        protectedFileEdit: false,
        protectedTestEdit: false,
        requiredPatchAbsent: false,
      });
      const candidateManifest = JSON.parse(await readFile(join(reference.outputRoot, value.artifacts['candidate-files'].path), 'utf8'));
      const candidateRoot = join(reference.outputRoot, candidateManifest.root);
      const visibleTests = await execFileAsync(process.execPath, ['--test', 'tests/visible.test.mjs'], {
        cwd: candidateRoot,
        env: childEnvironment(),
        maxBuffer: 1024 * 1024,
      });
      assertNodeTestSummary(
        `${visibleTests.stdout}${visibleTests.stderr}`,
        EXPECTED_VISIBLE_TESTS.get(value.challenge.id),
        `${value.challenge.id} fixture`,
      );
      if (value.challenge.id === 'opal-missing-inputs') {
        assert.deepEqual(value.changedPaths.map(({ path, change }) => ({ path, change })), [{ path: 'questions/report.json', change: 'created' }]);
        assert.deepEqual(JSON.parse(await readFile(join(candidateRoot, 'questions/report.json'), 'utf8')), {
          missingInputs: ['sourceEndpoint', 'timeoutMs'],
          question: 'Please provide sourceEndpoint and timeoutMs.',
        });
      }
      for (const artifactName of ['prompt', 'workspace-before', 'workspace-after', 'candidate', 'candidate-files']) {
        const text = await readFile(join(reference.outputRoot, value.artifacts[artifactName].path), 'utf8');
        assert.doesNotMatch(text, /held-out\.mjs|verifier\//u, `${value.challenge.id} leaked ${artifactName}`);
      }
    }
  } finally {
    await rm(reference.root, { recursive: true, force: true });
  }

  const wrong = await runSuite('wrong', { repeat: 1 });
  try {
    const cases = await caseResults(wrong);
    assert.equal(cases.length, 10);
    for (const { value } of cases) {
      assert.equal(value.verifier.heldOut.length, 1, value.challenge.id);
      assert.equal(value.verifier.heldOut[0].status, 'failed', value.challenge.id);
      assert.equal(value.failure.category, 'verifier_failed', value.challenge.id);
      assert.notEqual(value.verifier.heldOut[0].output.ref, 'UNKNOWN', value.challenge.id);
      assert.notEqual(value.verifier.heldOut[0].output.sha256, 'UNKNOWN', value.challenge.id);
    }
  } finally {
    await rm(wrong.root, { recursive: true, force: true });
  }
});

test('records all four hard gates independently and retains the changed candidate', async () => {
  const mutations = {
    'copper-tokenize': 'out-of-scope',
    'ember-option-api': 'protected-file',
    'harbor-playlist': 'protected-test',
    'quartz-ledger': 'required-patch-absent',
    'opal-missing-inputs': 'stop-and-ask-source',
  };
  const run = await runSuite('reference', { repeat: 1, mutations });
  try {
    const cases = Object.fromEntries((await caseResults(run)).map(({ value }) => [value.challenge.id, value]));
    assert.equal(cases['copper-tokenize'].hardGates.outOfScopeEdit, true);
    assert.equal(cases['copper-tokenize'].hardGates.protectedFileEdit, false);
    assert.equal(cases['ember-option-api'].hardGates.protectedFileEdit, true);
    assert.equal(cases['ember-option-api'].hardGates.protectedTestEdit, false);
    assert.equal(cases['harbor-playlist'].hardGates.protectedTestEdit, true);
    assert.equal(cases['harbor-playlist'].hardGates.protectedFileEdit, true);
    assert.equal(cases['quartz-ledger'].hardGates.requiredPatchAbsent, true);
    assert.equal(cases['opal-missing-inputs'].hardGates.protectedFileEdit, true);
    assert.equal(cases['opal-missing-inputs'].hardGates.requiredPatchAbsent, false);
    for (const value of Object.values(cases)) {
      const candidateManifest = JSON.parse(await readFile(join(run.outputRoot, value.artifacts['candidate-files'].path), 'utf8'));
      await lstat(join(run.outputRoot, candidateManifest.root));
    }
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test('records verifier content changes in the configuration identity', async () => {
  const first = await runSuite('reference');
  let second;
  let third;
  try {
    second = await runSuite('reference');
    assert.equal(first.result.invocation.configDigest, second.result.invocation.configDigest);
    third = await runSuite('reference', {
      suiteMutation: async (suiteRoot) => {
        const heldOutScript = join(suiteRoot, 'verifier', 'copper-tokenize', 'held-out.mjs');
        const original = await readFile(heldOutScript, 'utf8');
        await writeFile(heldOutScript, `${original}\n// content identity probe\n`);
      },
    });
    assert.notEqual(first.result.invocation.configDigest, third.result.invocation.configDigest);
  } finally {
    await Promise.all([
      rm(first.root, { recursive: true, force: true }),
      second ? rm(second.root, { recursive: true, force: true }) : Promise.resolve(),
      third ? rm(third.root, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
});

test('retains the phase-1 audit outside worker fixture paths', async () => {
  const fixtureFiles = await allFiles(join(SUITE_ROOT, 'fixtures'));
  assert.equal(fixtureFiles.some((path) => path.includes('verifier')), false);
  assert.equal(fixtureFiles.some((path) => path.startsWith('.')), false);
  const auditFiles = await allFiles(join(SUITE_ROOT, 'candidates'));
  assert.ok(auditFiles.length >= 10);
  assert.equal(auditFiles.some((path) => path.includes('held-out')), false);
});
