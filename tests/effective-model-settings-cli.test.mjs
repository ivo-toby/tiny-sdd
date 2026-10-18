import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, readFile, writeFile, cp, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/controller.mjs';
import { inspectEffectiveModelSettings } from '../src/effective-model-settings.mjs';
import { runBenchmark } from '../src/benchmark-runner.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tinysdd-settings-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suiteRoot = join(root, 'source-suite');
  await cp(fileURLToPath(new URL('../bench/implement-slice-suite', import.meta.url)), suiteRoot, { recursive: true });
  const suitePath = join(suiteRoot, 'suite.json');
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
  await writeFile(suitePath, JSON.stringify({ ...suite, challenges: suite.challenges.slice(0, 2) }));
  const sourceAgentDir = join(root, 'agent');
  await mkdir(sourceAgentDir);
  await writeFile(join(sourceAgentDir, 'models.json'), JSON.stringify({ providers: { fake: {
    api: 'openai-completions', baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-test-token',
    models: [{ id: 'fake/model', reasoning: false, maxTokens: 512, contextWindow: 8192 }],
  } } }));
  const piExecutable = join(root, 'fake-pi.mjs');
  await writeFile(piExecutable, `#!/usr/bin/env node
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'synthetic incomplete response'}]}}));
`);
  await chmod(piExecutable, 0o755);
  const fixture = {
    root, suiteRoot,
    worker: { type: 'pi', provider: 'fake', model: 'fake/model', limits: { timeoutMs: 5000, maxToolCalls: 10 } },
    runtime: { test: true, piExecutable, sourceAgentDir, sourceEnv: {} },
    verifier: async () => ({ status: 'failed', exitCode: 1, outputText: 'Synthetic candidate fails the declared check', sandbox: { runner: 'test', network: 'none' } }),
  };
  await initProject(root, { worker: 'fake', provider: 'fake', model: 'fake/model' });
  return fixture;
}

async function invoke(fixture, args, json = true) {
  const env = { ...process.env, ...fixture.runtime.sourceEnv, PI_CODING_AGENT_DIR: fixture.runtime.sourceAgentDir, TYPESAFE_API_KEY: 'stub' };
  try {
    return { status: 0, ...await exec(process.execPath, [cli, ...(json ? ['--json'] : []), '--project', fixture.root, ...args], { env }) };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function data(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return JSON.parse(result.stdout);
}

test('CLI shows current secret-free settings and refuses missing, stale or unacknowledged benchmark confirmation before output', async (t) => {
  const fixture = await setup(t);
  const shown = await invoke(fixture, ['worker', 'settings', '--worker', 'fake', '--entry-kind', 'real']);
  assert.equal(shown.status, 0);
  const report = data(shown).data;
  assert.equal(report.settings.maxTokens, 512);
  assert.equal(report.settings.entryKind, 'real');
  assert.doesNotMatch(shown.stdout, /synthetic-test-token|apiKey|FAKE_TOKEN/);
  const args = ['bench', 'run', '--worker', 'fake', '--suite', 'source-suite', '--entry-kind', 'real'];
  assert.equal(data(await invoke(fixture, args)).error.code, 'MODEL_SETTINGS_CONFIRMATION_REQUIRED');
  assert.equal(data(await invoke(fixture, [...args, '--confirm-settings', '0'.repeat(64)])).error.code, 'MODEL_SETTINGS_CONFIRMATION_REQUIRED');
  assert.equal(data(await invoke(fixture, [...args, '--confirm-settings', report.settingsDigest])).error.code, 'MODEL_SETTINGS_FINDING_ACKNOWLEDGEMENT_REQUIRED');
  await assert.rejects(readFile(join(fixture.root, '.tinysdd/bench/implement-slice-v1')), { code: 'ENOENT' });
});

test('confirmed fake benchmark retains settings and qualification attributes token stops without changing counts', async (t) => {
  const fixture = await setup(t);
  const previous = process.env.TINYSDD_WORKER_TEST;
  process.env.TINYSDD_WORKER_TEST = '1';
  t.after(() => { if (previous === undefined) delete process.env.TINYSDD_WORKER_TEST; else process.env.TINYSDD_WORKER_TEST = previous; });
  const pi = await readFile(fixture.runtime.piExecutable, 'utf8');
  await writeFile(fixture.runtime.piExecutable, pi.replace("stopReason:'stop'", "stopReason:'length'"));
  const report = await inspectEffectiveModelSettings({ ...fixture, ...fixture.runtime, entryKind: 'synthetic' });
  const settingsConfirmation = { entryKind: 'synthetic', settingsDigest: report.settingsDigest, acknowledgedFindings: ['THINKING_CONTROL_MISMATCH'] };
  const result = await runBenchmark({ ...fixture, projectRoot: fixture.root, outputRoot: join(fixture.root, 'benchmark'), invocationId: 'settings-fixture', repeat: 1, settingsConfirmation });
  const retained = JSON.parse(await readFile(join(result.directory, 'model-settings.json'), 'utf8'));
  assert.equal(retained.settingsDigest, report.settingsDigest);
  assert.deepEqual(retained.acknowledgedFindings, ['THINKING_CONTROL_MISMATCH']);
  const args = ['bench', 'qualify', '--results', 'benchmark', '--suite', 'source-suite'];
  const qualified = await invoke(fixture, args);
  assert.equal(qualified.status, 0, qualified.stderr);
  const qualifiedData = data(qualified).data;
  assert.equal(qualifiedData.configurationCauses.responseTokenLimitCount, 2);
  assert.equal(qualifiedData.record.roles['implement-slice'].n, 2);
  assert.equal(qualifiedData.record.roles['implement-slice'].passes, 0);
  const human = await invoke(fixture, args, false);
  assert.match(human.stdout, /Configuration-limited: 2 response_token_limit/);
  const modelsPath = join(fixture.runtime.sourceAgentDir, 'models.json');
  const models = JSON.parse(await readFile(modelsPath, 'utf8'));
  models.providers.fake.models[0].maxTokens = 4096;
  await writeFile(modelsPath, JSON.stringify(models));
  await assert.rejects(runBenchmark({ ...fixture, projectRoot: fixture.root, outputRoot: join(fixture.root, 'stale'), repeat: 1, settingsConfirmation }), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  await assert.rejects(readFile(join(fixture.root, 'stale')), { code: 'ENOENT' });
});
