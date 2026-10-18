import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { benchmarkFixtureDigest, runBenchmark } from '../../src/benchmark-runner.mjs';
import { sha256 } from '../../src/fs-utils.mjs';

const execFileAsync = promisify(execFile);
export const baselineInstructions = 'Implement the requested helper and keep the existing API.';
export const variantInstructions = 'Implement the requested helper and keep the existing API. Trace the existing caller and wire it to the helper; verify the behavior through that public entrypoint.';
export const partitions = [
  { challengeId: 'greeting', lineage: 'greeting-feature', partition: 'discovery' },
  { challengeId: 'checkout', lineage: 'checkout-feature', partition: 'control' },
];
export const criteria = { minPairsPerPartition: 2, minQualityGain: 0.5, maxRegressions: 0, rationale: 'Synthetic fixture criteria only; choose a real sample size and decision rule before live runs.' };
export async function jsonFile(root, path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
  return { path, sha256: sha256(text) };
}

export async function instructionFixture(root) {
  const suiteRoot = join(root, 'source-suite');
  await mkdir(suiteRoot, { recursive: true });
  const challenges = [];
  for (const { challengeId: id } of partitions) {
    const fixture = join(suiteRoot, 'fixtures', id);
    await mkdir(join(fixture, 'src'), { recursive: true });
    const initial = id === 'greeting' ? "export function greet(name) { return name; }\n" : 'export function total(amount) { return amount; }\n';
    await writeFile(join(fixture, 'src', 'index.mjs'), initial);
    await mkdir(join(suiteRoot, 'packets', id), { recursive: true });
    const briefText = id === 'greeting' ? 'Make greet return Hello followed by the name. Add format in helper.mjs and use it from index.mjs.\n'
      : 'Make total apply a 10 percent discount. Add discount in helper.mjs and use it from index.mjs.\n';
    await writeFile(join(suiteRoot, 'packets', id, 'brief.md'), briefText);
    const context = await jsonFile(suiteRoot, `packets/${id}/context.json`, { schemaVersion: 1, facts: [], resources: [] });
    const checks = await jsonFile(suiteRoot, `packets/${id}/checks.json`, { schemaVersion: 1, dependencyMounts: [], checks: [{ id: 'visible', argv: ['node', '--test', 'visible.test.mjs'], timeoutMs: 3000 }] });
    const verifier = {};
    for (const visibility of ['visible', 'heldOut']) {
      await mkdir(join(suiteRoot, 'verifier'), { recursive: true });
      const expression = id === 'greeting' ? "assert.equal(greet('Ada'), 'Hello Ada');" : 'assert.equal(total(100), 90);';
      const test = `import assert from 'node:assert/strict';\nimport { ${id === 'greeting' ? 'greet' : 'total'} } from '../../src/index.mjs';\n${expression}\n${visibility === 'heldOut' ? "// HIDDEN_ANSWER_SENTINEL\n" : ''}`;
      await writeFile(join(suiteRoot, 'verifier', `${id}-${visibility}.test.mjs`), test);
      verifier[visibility] = await jsonFile(suiteRoot, `verifier/${id}-${visibility}.json`, { schemaVersion: 1, dependencyMounts: [], checks: [{ id: visibility === 'heldOut' ? 'integration' : 'public-api', argv: ['node', '--test', `verifier/${id}-${visibility}.test.mjs`], timeoutMs: 3000 }] });
    }
    challenges.push(await jsonFile(suiteRoot, `challenges/${id}.json`, { schemaVersion: 1, id, version: '1', role: 'implement-slice', difficultyTags: ['caller-wiring'],
      fixture: { path: `fixtures/${id}`, sha256: (await benchmarkFixtureDigest(fixture)).sha256 },
      packet: { brief: { path: `packets/${id}/brief.md`, sha256: sha256(briefText) }, context, checks, allowedPaths: ['src/index.mjs', 'src/helper.mjs'], protectedPaths: [] }, verifier }));
  }
  await jsonFile(suiteRoot, 'suite.json', { schemaVersion: 1, id: 'instruction-fixture', version: '1', challenges, defaults: { repeat: 2 } });
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await jsonFile(agent, 'models.json', { providers: { fake: { api: 'openai-completions', baseUrl: '$FAKE_BASE', apiKey: '$FAKE_TOKEN', models: [{ id: 'fake/model', contextWindow: 8192, maxTokens: 512, input: ['text'], reasoning: false }] } } });
  const pi = join(root, 'fake-pi.mjs');
  await writeFile(pi, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(process.argv[process.argv.indexOf('--append-system-prompt') + 1], 'utf8');
const variant = prompt.includes('Trace the existing caller');
const greeting = process.env.TINYSDD_TEST_CHALLENGE === 'greeting';
writeFileSync('src/helper.mjs', greeting ? "export function format(name) { return 'Hello ' + name; }\\n" : 'export function discount(amount) { return amount * 0.9; }\\n');
if (variant) writeFileSync('src/index.mjs', greeting ? "import { format } from './helper.mjs'; export function greet(name) { return format(name); }\\n" : "import { discount } from './helper.mjs'; export function total(amount) { return discount(amount); }\\n");
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',usage:{input:100,output:20,totalTokens:120},content:[{type:'text',text:'done'}]}}));
`);
  await chmod(pi, 0o755);
  const runtime = { test: true, piExecutable: pi, sourceAgentDir: agent,
    sourceEnv: { FAKE_BASE: 'http://127.0.0.1:9/v1', FAKE_TOKEN: 'synthetic-test-token' },
    checkRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: '', tail: '', truncated: false }, sandbox: { runner: 'test', network: 'none' } }) };
  const worker = { type: 'pi', name: 'fake', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 5000, maxToolCalls: 10 }, modelMetadata: { provider: 'fake', id: 'fake/model', quantization: 'synthetic', server: { id: 'fixture', version: '1' } } };
  const profile = { schemaVersion: 1, id: 'fixture-instructions-v1', instructions: baselineInstructions };
  const verifier = async ({ candidateDir, check }) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const result = await execFileAsync(process.execPath, check.argv.slice(1), { cwd: candidateDir, timeout: 3000, env });
      return { status: 'passed', outputText: result.stdout, sandbox: { runner: 'independent-node-test', synthetic: true } };
    } catch (error) { return { status: 'failed', exitCode: 1, outputText: error.stdout ?? String(error), sandbox: { runner: 'independent-node-test', synthetic: true } }; }
  };
  return { root, suiteRoot, worker, profile, runtime, verifier };
}

export async function discoveryRun(fixture) {
  const result = await runBenchmark({ ...fixture, projectRoot: fixture.suiteRoot, outputRoot: join(fixture.root, 'discovery'), repeat: 2, invocationId: 'discovery' });
  const observations = [];
  for (const ref of result.invocation.caseResults) {
    const caseResult = JSON.parse(await readFile(join(result.directory, ref.path), 'utf8'));
    observations.push({ caseResult, invocationId: result.invocation.invocationId, source: { path: `discovery/${ref.path}`, sha256: ref.sha256 } });
  }
  return { result, observations };
}

export function analysisRequest(observations, configDigest) {
  return { suite: 'source-suite/suite.json', results: ['discovery/invocation.json'], partitions, preparation: { model: 'synthetic-analyst', usage: 'UNKNOWN', evidence: 'UNKNOWN' }, exposureAttestation: 'Synthetic example: the analysis export excludes control content and hidden verifier output.',
    proposals: [{ id: 'wire-callers', configDigest, role: 'implement-slice', category: 'interfaces-callers', observation: 'Two discovery attempts created the helper while leaving the public entrypoint unchanged; independently executed entrypoint checks failed.',
      hypothesis: 'Explicit caller wiring guidance may prevent isolated helper implementations.', before: baselineInstructions, after: variantInstructions, expectedEffect: 'More independently verified public-entrypoint success with no control-task regressions.',
      evidence: observations.filter(({ caseResult }) => caseResult.challenge.id === 'greeting').map(({ source }) => source), experimentPlan: 'Repeat matched A/B with unchanged runtime, fixtures and verifier; evaluate discovery greeting and held-back checkout lineages separately.' }] };
}
