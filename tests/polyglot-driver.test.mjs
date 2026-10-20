import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue, RunStoppedError, readResults } from '../bench/polyglot/lib/driver.mjs';
import { buildBrief, buildPacket, RunHarnessError, runAttempt } from '../bench/polyglot/lib/worker-run.mjs';
import { createPiAgentDir } from '../bench/polyglot/lib/pi-agent-dir.mjs';

let root;
let originalKey;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-polyglot-test-'));
  originalKey = process.env.HOMELAB_AI_GATEWAY_API_KEY;
  process.env.HOMELAB_AI_GATEWAY_API_KEY = 'test-key-not-real';
});

after(async () => {
  if (originalKey === undefined) delete process.env.HOMELAB_AI_GATEWAY_API_KEY;
  else process.env.HOMELAB_AI_GATEWAY_API_KEY = originalKey;
  await rm(root, { recursive: true, force: true });
});

async function freshDir(label) {
  counter += 1;
  const dir = join(root, `${label}-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function exerciseFor(id, extra = {}) {
  return {
    id,
    language: 'python',
    dir: id,
    solutionFiles: ['affine_cipher.py'],
    testFiles: ['affine_cipher_test.py'],
    exampleFiles: ['.meta/example.py'],
    instructions: 'Implement the cipher.',
    split: 'discovery',
    ...extra,
  };
}

const model = { key: 'qwen', route: 'titan/llamacpp/qwen3.8-q3-128k', provider: 'litellm', contextWindow: 128000, maxTokens: 16384, thinking: 'medium', parallel: 1 };
const profile = { schemaVersion: 1, id: 'baseline', runtime: { thinking: 'medium', reasoning: true }, instructions: '' };

// Fake dataset: stub solution, original tests, overlay limited to solution files.
function fakePrepare(calls = []) {
  return async ({ exercise, destDir, overlay }) => {
    calls.push({ destDir, overlay });
    await mkdir(destDir, { recursive: true });
    const files = { [exercise.solutionFiles[0]]: 'STUB', [exercise.testFiles[0]]: 'TEST_ORIGINAL' };
    for (const key of Object.keys(overlay ?? {})) {
      if (!exercise.solutionFiles.includes(key)) throw new Error(`overlay key ${key} is not a solution file`);
    }
    Object.assign(files, overlay ?? {});
    for (const [path, text] of Object.entries(files)) await writeFile(join(destDir, path), text);
  };
}

// Fake worker: `script` gives the candidate's full file contents and the outcome.
function fakeWorker(script, calls = []) {
  return async (args) => {
    calls.push(args);
    const spec = typeof script === 'function' ? script(args) : script;
    const dir = await freshDir('candidate');
    const candidate = join(dir, 'candidate');
    await mkdir(candidate, { recursive: true });
    for (const [path, text] of Object.entries(spec.files ?? {})) await writeFile(join(candidate, path), text);
    const prompt = join(dir, 'prompt.txt');
    await writeFile(prompt, 'PROMPT TEXT');
    return {
      outcome: spec.outcome ?? 'completed',
      changedPaths: (spec.changes ?? []).map((path) => ({ path })),
      scopeViolations: spec.scopeViolations ?? [],
      fileScope: { extraPaths: [] },
      observed: {
        assistantTermination: { observed: spec.assistantObserved ?? true, stopReason: spec.stopReason ?? null, errorMessage: spec.errorMessage ?? null },
        toolCalls: spec.toolCalls ?? 3,
        cumulativeUsage: { input: 10, output: 5 },
        processTermination: { elapsedMs: 42 },
      },
      artifactPaths: { directory: dir, candidate, prompt },
    };
  };
}

function fakeTests(seen = []) {
  return async ({ workDir, timeoutMs, language }) => {
    const solution = await readFile(join(workDir, 'affine_cipher.py'), 'utf8');
    const tests = await readFile(join(workDir, 'affine_cipher_test.py'), 'utf8');
    seen.push({ solution, tests, timeoutMs, language });
    const passed = solution === 'SOLVED' && tests === 'TEST_ORIGINAL';
    return { passed, exitCode: passed ? 0 : 1, timedOut: false, durationMs: 5, outputTail: passed ? 'ok' : 'FAILED tests' };
  };
}

describe('pi agent dir', () => {
  test('writes one litellm provider with an env-referenced key and no secret', async () => {
    const dir = await createPiAgentDir({ model, dir: join(await freshDir('agent'), 'qwen') });
    const config = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'));
    const provider = config.providers.litellm;
    assert.deepEqual(Object.keys(config.providers), ['litellm']);
    assert.equal(provider.api, 'openai-completions');
    assert.equal(provider.baseUrl, 'https://ai-gateway.cloud.toby.nu/v1');
    assert.equal(provider.apiKey, '$HOMELAB_AI_GATEWAY_API_KEY');
    assert.deepEqual(provider.models, [{ id: model.route, contextWindow: 128000, maxTokens: 16384, input: ['text'], reasoning: true }]);
    assert.ok(!(await readFile(join(dir, 'models.json'), 'utf8')).includes('test-key-not-real'));
  });
});

describe('runAttempt', () => {
  test('packet, brief, workspace and verification use fresh tests and overlaid solution only', async () => {
    const caseDir = await freshDir('case');
    const workerCalls = [];
    const prepared = [];
    const testSeen = [];
    const exercise = exerciseFor('python/affine-cipher');
    const record = await runAttempt({
      checkoutDir: '/unused', exercise, model, profile, attempt: 1, caseDir,
      deps: {
        runWorker: fakeWorker({ files: { 'affine_cipher.py': 'SOLVED', 'affine_cipher_test.py': 'TAMPERED' }, changes: ['affine_cipher.py', 'affine_cipher_test.py'], scopeViolations: [{ path: 'affine_cipher_test.py' }] }, workerCalls),
        prepareWorkspace: fakePrepare(prepared),
        runTests: fakeTests(testSeen),
      },
    });

    const [call] = workerCalls;
    assert.equal(call.projectRoot, prepared[0].destDir);
    assert.equal(call.profile, profile);
    assert.deepEqual(call.worker, { type: 'pi', provider: 'litellm', model: model.route, limits: { timeoutMs: 600000, maxToolCalls: 100 } });
    assert.equal(call.packet.taskId, 'python__affine-cipher');
    assert.deepEqual(call.packet.allowedPaths, ['affine_cipher.py']);
    assert.deepEqual(call.packet.protectedPaths, ['affine_cipher_test.py']);
    assert.equal(call.packet.context, null);
    assert.equal(call.packet.checks, null);
    assert.ok(call.packet.briefText.startsWith('# Task: python/affine-cipher\n'));
    assert.ok(call.packet.briefText.includes('Edit only: affine_cipher.py.'));
    assert.ok(call.packet.briefText.includes('Implement the cipher.'));
    assert.ok(!call.packet.briefText.includes('## Previous attempt'));
    assert.equal(prepared[0].overlay, undefined);

    // Verification: solution from the candidate, tests from the dataset (tamper ignored).
    assert.deepEqual(testSeen, [{ solution: 'SOLVED', tests: 'TEST_ORIGINAL', timeoutMs: 180000, language: 'python' }]);
    assert.equal(record.n, 1);
    assert.equal(record.workerOutcome, 'completed');
    assert.equal(record.workerError, null);
    assert.deepEqual(record.changedFiles, ['affine_cipher.py', 'affine_cipher_test.py']);
    assert.equal(record.scopeViolation, true);
    assert.equal(record.test.passed, true);
    assert.deepEqual(record.usage, { input: 10, output: 5 });
    assert.equal(record.toolCalls, 3);

    const saved = await readdir(join(caseDir, 'attempt-1'));
    assert.deepEqual(saved.sort(), ['packet.json', 'prompt.txt', 'solution', 'test.json', 'worker-result.json']);
    assert.equal(await readFile(join(caseDir, 'attempt-1', 'solution', 'affine_cipher.py'), 'utf8'), 'SOLVED');
    assert.equal(await readFile(join(caseDir, 'attempt-1', 'prompt.txt'), 'utf8'), 'PROMPT TEXT');
  });

  test('attempt 2 overlays attempt-1 solution and appends the tail of the previous output', async () => {
    const workerCalls = [];
    const prepared = [];
    const exercise = exerciseFor('python/affine-cipher');
    const previousOutput = `${'x'.repeat(7000)}END`;
    await runAttempt({
      checkoutDir: '/unused', exercise, model, profile, attempt: 2, caseDir: await freshDir('case2'),
      previous: { overlay: { 'affine_cipher.py': 'FIRST' }, outputTail: previousOutput },
      deps: { runWorker: fakeWorker({ files: { 'affine_cipher.py': 'SOLVED' }, changes: ['affine_cipher.py'] }, workerCalls), prepareWorkspace: fakePrepare(prepared), runTests: fakeTests() },
    });
    const brief = workerCalls[0].packet.briefText;
    assert.deepEqual(prepared[0].overlay, { 'affine_cipher.py': 'FIRST' });
    assert.ok(brief.includes('## Previous attempt'));
    // The last 6000 characters: 5997 x's and the END marker.
    assert.ok(brief.includes(`${'x'.repeat(5997)}END`));
    assert.ok(!brief.includes(`${'x'.repeat(5998)}END`));
    assert.ok(brief.includes('Fix the implementation so all tests pass.'));
  });

  test('a timeout is a model result: no verification when no solution file changed', async () => {
    const testCalls = [];
    const record = await runAttempt({
      checkoutDir: '/unused', exercise: exerciseFor('python/slow'), model, profile, attempt: 1, caseDir: await freshDir('case3'),
      deps: { runWorker: fakeWorker({ outcome: 'timeout', changes: [], toolCalls: 0 }), prepareWorkspace: fakePrepare(), runTests: async (args) => { testCalls.push(args); throw new Error('must not run'); } },
    });
    assert.equal(record.workerOutcome, 'timeout');
    assert.equal(record.test, null);
    assert.deepEqual(testCalls, []);
  });

  test('infrastructure failures throw harness errors instead of results', async () => {
    const base = { checkoutDir: '/unused', exercise: exerciseFor('python/x'), model, profile, attempt: 1, caseDir: await freshDir('case4') };
    await assert.rejects(runAttempt({ ...base, deps: { runWorker: async () => { throw new Error('pi missing'); }, prepareWorkspace: fakePrepare(), runTests: fakeTests() } }), (error) => error.harness === true);
    await assert.rejects(runAttempt({ ...base, deps: { runWorker: fakeWorker({ outcome: 'failed', assistantObserved: false, toolCalls: 0, errorMessage: 'connect ECONNREFUSED' }), prepareWorkspace: fakePrepare(), runTests: fakeTests() } }), (error) => error instanceof RunHarnessError && /ECONNREFUSED|no model output/.test(error.message));
    await assert.rejects(runAttempt({ ...base, deps: { runWorker: fakeWorker({ outcome: 'failed', assistantObserved: true, stopReason: 'error', toolCalls: 0, errorMessage: '400: Invalid model name passed in model=titan/x' }), prepareWorkspace: fakePrepare(), runTests: fakeTests() } }), (error) => error instanceof RunHarnessError && /Invalid model name/.test(error.message));
    const docker = Object.assign(new Error('daemon down'), { name: 'HarnessError' });
    await assert.rejects(runAttempt({ ...base, deps: { runWorker: fakeWorker({ files: { 'affine_cipher.py': 'SOLVED' }, changes: ['affine_cipher.py'] }), prepareWorkspace: fakePrepare(), runTests: async () => { throw docker; } } }), (error) => error.harness === true || error.name === 'HarnessError');
  });

  test('buildPacket and buildBrief are pure', () => {
    const exercise = exerciseFor('python/pure');
    assert.equal(buildBrief({ exercise }), buildPacket({ exercise }).briefText);
    assert.equal(buildPacket({ exercise }).taskId, 'python__pure');
  });
});

// Writes a run dir with a queue, a profile and optional prior results.
async function makeRun({ entries, results = [], exercises }) {
  const runDir = await freshDir('run');
  await mkdir(join(runDir, 'profiles'), { recursive: true });
  await writeFile(join(runDir, 'profiles', 'baseline.json'), `${JSON.stringify(profile)}\n`);
  await writeFile(join(runDir, 'queue.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  if (results.length > 0) await writeFile(join(runDir, 'results.jsonl'), results.map((result) => JSON.stringify(result)).join('\n') + '\n');
  return { runDir, manifest: { exercises: exercises.map((exercise) => exerciseFor(exercise)) } };
}

function entry(id, exercise, extra = {}) {
  return { id, model: 'qwen', profile: 'baseline', exercise, repeat: 1, attempts: 2, ...extra };
}

const passing = { workerOutcome: 'completed', test: { passed: true, outputTail: 'ok' } };
const featuresFor = (result) => (result.pass2 ? ['passed'] : ['tests_failed']);
const noSleep = async () => {};

describe('runQueue', () => {
  test('resume skips finished entries and excluded exercises', async () => {
    const { runDir, manifest } = await makeRun({
      entries: [entry('e1', 'python/a'), entry('e2', 'python/b'), entry('e3', 'python/c')],
      results: [{ id: 'e1', pass1: true, pass2: true }],
      exercises: ['python/a', 'python/b', 'python/c'],
    });
    const started = [];
    const logs = [];
    const summary = await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, excluded: ['python/c'], log: (line) => logs.push(line),
      deps: { runAttempt: async ({ exercise, attempt }) => { started.push(`${exercise.id}#${attempt}`); return { ...passing, n: attempt }; }, featuresFor, sleep: noSleep },
    });
    assert.deepEqual(started, ['python/b#1']);
    const results = await readResults(runDir);
    assert.deepEqual(results.map((result) => result.id), ['e1', 'e2']);
    assert.equal(results[1].pass1, true);
    assert.deepEqual(results[1].features, ['passed']);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.stopped, null);
    // Total counts non-excluded entries; e1 was already done, so this is 2 of 2.
    assert.match(logs[0], /^\[2\/2\] qwen baseline python\/b 1\/1 /);
  });

  test('attempt 2 runs only after a failed attempt 1 and gets its candidate and output', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a')], exercises: ['python/a'] });
    const seen = [];
    await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, log: () => {},
      deps: {
        runAttempt: async ({ attempt, previous, caseDir }) => {
          seen.push({ attempt, previous });
          if (attempt === 1) {
            await mkdir(join(caseDir, 'attempt-1', 'solution'), { recursive: true });
            await writeFile(join(caseDir, 'attempt-1', 'solution', 'affine_cipher.py'), 'FIRST');
            return { n: 1, workerOutcome: 'completed', test: { passed: false, outputTail: 'boom' } };
          }
          return { n: 2, workerOutcome: 'completed', test: { passed: true, outputTail: 'ok' } };
        },
        featuresFor, sleep: noSleep,
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].previous, null);
    assert.deepEqual(seen[1].previous, { overlay: { 'affine_cipher.py': 'FIRST' }, outputTail: 'boom' });
    const [result] = await readResults(runDir);
    assert.equal(result.pass1, false);
    assert.equal(result.pass2, true);
    assert.equal(result.attempts.length, 2);
  });

  test('model failures are written as results (timeouts count as failed attempts)', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a')], exercises: ['python/a'] });
    await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, log: () => {},
      deps: { runAttempt: async ({ attempt }) => ({ n: attempt, workerOutcome: 'timeout', test: null }), featuresFor, sleep: noSleep },
    });
    const [result] = await readResults(runDir);
    assert.equal(result.pass1, false);
    assert.equal(result.pass2, false);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[1].workerOutcome, 'timeout');
  });

  test('harness errors are retried with backoff, then stop the run without a result', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a'), entry('e2', 'python/b')], exercises: ['python/a', 'python/b'] });
    const sleeps = [];
    let calls = 0;
    await assert.rejects(runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, backoffMs: 60000, maxConsecutiveSkips: 1, log: () => {},
      deps: {
        runAttempt: async () => { calls += 1; throw new RunHarnessError('gateway down'); },
        featuresFor, sleep: async (ms) => { sleeps.push(ms); },
      },
    }), (error) => error instanceof RunStoppedError && error.code === 'HARNESS_RETRY_LIMIT');
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [60000, 60000, 60000]);
    assert.deepEqual(await readResults(runDir), []);
    const harness = (await readFile(join(runDir, 'harness-errors.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(harness.length, 4);
    assert.equal(harness[0].id, 'e1');
  });

  test('an entry with persistent harness errors is skipped unrecorded and the run continues', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a'), entry('e2', 'python/b')], exercises: ['python/a', 'python/b'] });
    await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, log: () => {},
      deps: {
        runAttempt: async ({ exercise, attempt }) => {
          if (exercise.id === 'python/a') throw new RunHarnessError('broken fixture');
          return { n: attempt, workerOutcome: 'completed', test: { passed: true, outputTail: '' } };
        },
        featuresFor, sleep: noSleep,
      },
    });
    const results = await readResults(runDir);
    assert.deepEqual(results.map((result) => result.id), ['e2']);
  });

  test('a harness error that clears within the retry budget is recorded and the entry completes', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a')], exercises: ['python/a'] });
    let calls = 0;
    await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, log: () => {},
      deps: {
        runAttempt: async () => { calls += 1; if (calls < 3) throw new RunHarnessError('gateway 503'); return { ...passing, n: 1 }; },
        featuresFor, sleep: noSleep,
      },
    });
    assert.equal((await readResults(runDir)).length, 1);
    assert.equal((await readFile(join(runDir, 'harness-errors.jsonl'), 'utf8')).trim().split('\n').length, 2);
  });

  test('at most model.parallel entries run at once', async () => {
    const { runDir, manifest } = await makeRun({
      entries: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id, `python/${id}`)),
      exercises: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `python/${id}`),
    });
    let active = 0;
    let maxActive = 0;
    await runQueue({
      runDir, models: [{ ...model, parallel: 2 }], checkoutDir: '/unused', manifest, log: () => {},
      deps: {
        runAttempt: async ({ attempt }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          return { ...passing, n: attempt };
        },
        featuresFor, sleep: noSleep,
      },
    });
    assert.equal(maxActive, 2);
    assert.equal((await readResults(runDir)).length, 6);
  });

  test('SIGINT lets the in-flight entry finish and starts nothing new', async () => {
    const { runDir, manifest } = await makeRun({
      entries: ['a', 'b', 'c'].map((id) => entry(id, `python/${id}`)),
      exercises: ['a', 'b', 'c'].map((id) => `python/${id}`),
    });
    let calls = 0;
    const summary = await runQueue({
      runDir, models: [model], checkoutDir: '/unused', manifest, log: () => {},
      deps: {
        runAttempt: async ({ attempt }) => {
          calls += 1;
          if (calls === 1) process.emit('SIGINT');
          return { ...passing, n: attempt };
        },
        featuresFor, sleep: noSleep,
      },
    });
    assert.equal(calls, 1);
    assert.equal(summary.stopped, 'sigint');
    assert.equal((await readResults(runDir)).length, 1);
    assert.equal(process.listenerCount('SIGINT'), 0);
  });

  test('refuses to start without the gateway key', async () => {
    const { runDir, manifest } = await makeRun({ entries: [entry('e1', 'python/a')], exercises: ['python/a'] });
    const saved = process.env.HOMELAB_AI_GATEWAY_API_KEY;
    delete process.env.HOMELAB_AI_GATEWAY_API_KEY;
    try {
      await assert.rejects(runQueue({ runDir, models: [model], checkoutDir: '/unused', manifest, deps: { runAttempt: async () => { throw new Error('must not run'); } } }), /HOMELAB_AI_GATEWAY_API_KEY/);
    } finally {
      process.env.HOMELAB_AI_GATEWAY_API_KEY = saved;
    }
  });
});
