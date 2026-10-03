import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { sha256 } from '../src/fs-utils.mjs';
import { benchmarkFixtureDigest, runBenchmark } from '../src/benchmark-runner.mjs';
import { parseBenchmarkInvocation } from '../src/benchmark-results.mjs';

const digest = (value) => sha256(value);

async function writeJson(path, value) {
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text);
  return { path, sha256: digest(text) };
}

async function makeRuntime(root) {
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
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const challenge = process.env.TINYSDD_TEST_CHALLENGE;
if (existsSync(join(process.cwd(), 'verifier', 'held-out.test.mjs'))) {
  writeFileSync(join(process.cwd(), 'src', 'worker-saw-hidden.txt'), 'leak\\n');
}
if (challenge === 'slow-slice') {
  writeFileSync(join(process.cwd(), 'src', 'index.mjs'), 'slow\\n');
  await new Promise((resolve) => setTimeout(resolve, 2500));
} else {
  writeFileSync(join(process.cwd(), 'src', 'index.mjs'), 'changed\\n');
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));
`);
  await chmod(pi, 0o755);
  return {
    test: true,
    piExecutable: pi,
    sourceAgentDir: agent,
    sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
    testEnv: { TINYSDD_TEST_CHALLENGE: 'normal-slice' },
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

async function makeSuite(root) {
  await mkdir(join(root, 'challenges'), { recursive: true });
  const challengeDefinitions = [
    { id: 'slow-slice', fixtureFiles: { 'src/index.mjs': 'before\n', 'tests/contract.test.mjs': 'export {};\n' } },
    { id: 'collision-slice', fixtureFiles: { 'src/index.mjs': 'before\n', 'tests/contract.test.mjs': 'export {};\n', '__tinysdd_benchmark_verifier/visible/collision-slice-visible.test.mjs': 'candidate collision\n' } },
  ];
  const challengeRefs = [];
  for (const definition of challengeDefinitions) {
    const fixture = join(root, 'fixtures', definition.id);
    await mkdir(fixture, { recursive: true });
    for (const [path, text] of Object.entries(definition.fixtureFiles)) {
      const target = join(fixture, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, text);
    }
    const packetRoot = join(root, 'packets', definition.id);
    await mkdir(packetRoot, { recursive: true });
    await writeFile(join(packetRoot, 'brief.md'), `Implement ${definition.id}.\n`);
    await writeJson(join(packetRoot, 'context.json'), { schemaVersion: 1, facts: [], resources: [] });
    await writeJson(join(packetRoot, 'checks.json'), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'visible', argv: ['node', '--test', 'visible.test.mjs'], timeoutMs: 1000 }],
    });
    const verifierRoot = join(root, 'verifier');
    await mkdir(verifierRoot, { recursive: true });
    await writeFile(join(verifierRoot, `${definition.id}-visible.test.mjs`), 'export {};\n');
    await writeFile(join(verifierRoot, `${definition.id}-held-out.test.mjs`), 'export {};\n');
    const visible = await writeJson(join(verifierRoot, `${definition.id}-visible.json`), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'visible', argv: ['node', '--test', `verifier/${definition.id}-visible.test.mjs`], timeoutMs: 1000 }],
    });
    const heldOut = await writeJson(join(verifierRoot, `${definition.id}-held-out.json`), {
      schemaVersion: 1,
      dependencyMounts: [],
      checks: [{ id: 'held-out', argv: ['node', '--test', `verifier/${definition.id}-held-out.test.mjs`], timeoutMs: 1000 }],
    });
    challengeRefs.push(await writeJson(join(root, 'challenges', `${definition.id}.json`), {
      schemaVersion: 1,
      id: definition.id,
      version: '1',
      role: 'implement-slice',
      difficultyTags: ['small'],
      fixture: { path: `fixtures/${definition.id}`, sha256: (await benchmarkFixtureDigest(fixture)).sha256 },
      packet: {
        brief: { path: `packets/${definition.id}/brief.md`, sha256: (await writeFile(join(packetRoot, 'brief.md'), `Implement ${definition.id}.\n`).then(() => digest(`Implement ${definition.id}.\n`))) },
        context: { path: `packets/${definition.id}/context.json`, sha256: digest(`${JSON.stringify({ schemaVersion: 1, facts: [], resources: [] })}\n`) },
        checks: { path: `packets/${definition.id}/checks.json`, sha256: digest(`${JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'visible', argv: ['node', '--test', 'visible.test.mjs'], timeoutMs: 1000 }] })}\n`) },
        allowedPaths: ['src/index.mjs'],
        protectedPaths: ['tests/contract.test.mjs'],
      },
      verifier: {
        visible: { path: `verifier/${definition.id}-visible.json`, sha256: visible.sha256 },
        heldOut: { path: `verifier/${definition.id}-held-out.json`, sha256: heldOut.sha256 },
      },
    }));
  }
  const suite = await writeJson(join(root, 'suite.json'), {
    schemaVersion: 1,
    id: 'runner-fixture',
    version: '1',
    challenges: challengeRefs.map(({ path, sha256 }) => ({ path: path.slice(root.length + 1), sha256 })),
    defaults: { repeat: 2 },
  });
  return suite;
}

test('runs fresh repeated fixtures, retains timeout/setup attempts, and defers held-out overlays', async () => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-benchmark-runner-')));
  const output = join(root, 'results');
  const previousWorkerTest = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  try {
    await makeSuite(root);
    const runtime = await makeRuntime(root);
    const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 1000, maxToolCalls: 10 } };
    const seen = [];
    const result = await runBenchmark({
      suiteRoot: root,
      outputRoot: output,
      worker,
      runtime,
      codeRevision: 'a'.repeat(40),
      verifier: async ({ visibility, candidateDir }) => {
        seen.push({ visibility, candidateDir });
        return { status: 'passed', outputText: `${visibility}\n`, sandbox: { runner: 'test-only', network: 'none' } };
      },
    });
    assert.equal(result.invocation.caseResults.length, 4);
    assert.equal(result.summary.groups[0].scheduled, 4);
    assert.equal(result.summary.groups[0].incomplete, 2);
    assert.equal(result.summary.groups[0].failed, 2);
    assert.equal(seen.length, 4);
    const invocation = parseBenchmarkInvocation(await readFile(join(output, 'invocation.json'), 'utf8'));
    assert.equal(invocation.configIdentity.runChecks.available, true);
    assert.equal(invocation.configIdentity.runChecks.budget, 12);
    const cases = await Promise.all(invocation.caseResults.map(async ({ path }) => JSON.parse(await readFile(join(output, path), 'utf8'))));
    assert.ok(cases.every((entry) => entry.observed.runChecks.available === true));
    assert.equal(cases.filter((entry) => entry.outcome === 'timeout').length, 2);
    assert.equal(cases.filter((entry) => entry.failure.missing.some(({ field }) => field === 'attempt')).length, 2);
    for (const entry of cases) {
      assert.ok(entry.verifier.heldOut.length === 1);
      const prompt = await readFile(join(output, entry.artifacts.result.path), 'utf8');
      assert.doesNotMatch(prompt, /held-out\.test\.mjs/u);
    }
    assert.equal(await readFile(join(root, 'fixtures', 'slow-slice', 'src', 'index.mjs'), 'utf8'), 'before\n');
  } finally {
    if (previousWorkerTest === undefined) delete process.env.TINYSDD_WORKER_TEST;
    else process.env.TINYSDD_WORKER_TEST = previousWorkerTest;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects verifier injection outside the explicit test runtime', async () => {
  await assert.rejects(
    runBenchmark({ suiteRoot: '/tmp', worker: { type: 'pi', provider: 'fake', model: 'fake/model' }, verifier: () => ({ status: 'passed' }) }),
    { code: 'BENCHMARK_RUNNER_INVALID' },
  );
});
