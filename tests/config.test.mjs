import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_TIMEOUT_MS,
  resolveConfig,
  validateConfigDocument,
} from '../src/config.mjs';
import { initProject } from '../src/controller.mjs';

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-config-'));
  await mkdir(join(root, '.tinysdd'), { recursive: true });
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test('resolves an empty initialized config with provenance', async () => {
  const root = await project();
  try {
    await initProject(root);
    const resolved = await resolveConfig(root);
    assert.equal(resolved.config.schemaVersion, 1);
    assert.deepEqual(resolved.config.workers, {});
    assert.equal(resolved.workerName, undefined);
    assert.equal(resolved.provenance.config.exists, true);
    assert.equal(resolved.provenance.local.exists, false);
  } finally {
    await cleanup(root);
  }
});

test('explicitly selecting an absent constructor-named worker fails', async () => {
  const root = await project();
  try {
    await initProject(root);
    await assert.rejects(resolveConfig(root, { worker: 'constructor' }), { code: 'WORKER_NOT_FOUND' });
  } finally {
    await cleanup(root);
  }
});

test('local config replaces named workers as a whole and records sources', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'profiles'), { recursive: true });
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'profiles', 'worker.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'profile-one',
      runtime: { thinking: 'low', compat: { supportsDeveloperRole: true } },
    }));
    await writeFile(join(root, 'skills', 'SKILL.md'), '# Skill\n');
    await writeFile(join(root, 'instructions.txt'), 'instructions\n');
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'pi-one',
      workers: {
        'pi-one': {
          type: 'pi', provider: 'provider-a', model: 'model-a',
          profile: 'profiles/worker.json', skills: ['skills/SKILL.md'], instructions: ['instructions.txt'],
        },
      },
    }));
    await writeFile(join(root, '.tinysdd', 'config.local.json'), JSON.stringify({
      workers: {
        'pi-one': { type: 'pi', provider: 'provider-local', model: 'model-local' },
      },
    }));
    const resolved = await resolveConfig(root);
    assert.equal(resolved.worker.provider, 'provider-local');
    assert.equal(resolved.worker.model, 'model-local');
    assert.deepEqual(resolved.worker.limits, { timeoutMs: 300000, maxToolCalls: 40 });
    assert.equal(resolved.worker.profile, undefined);
    assert.equal(resolved.provenance.workers['pi-one'].source, 'config.local.json');
  } finally {
    await cleanup(root);
  }
});

test('rejects unknown, null, unsupported, and out-of-range config values', () => {
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, workers: {}, extra: true }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, workers: null }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, defaultWorker: 'constructor', workers: {} }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({ schemaVersion: 1, workers: { pi: { type: 'other', provider: 'p', model: 'm' } } }), { code: 'UNSUPPORTED_WORKER' });
  assert.throws(() => validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: MAX_TIMEOUT_MS + 1 } } },
  }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: null } } },
  }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { maxToolCalls: null } } },
  }), { code: 'CONFIG_INVALID' });
  for (const firstWriteMs of [null, 0, 300000, 1.5]) {
    assert.throws(() => validateConfigDocument({
      schemaVersion: 1,
      workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: 300000, firstWriteMs } } },
    }), { code: 'CONFIG_INVALID' });
  }
  const watched = validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: 1200000, firstWriteMs: 480000 } } },
  });
  assert.deepEqual(watched.workers.pi.limits, { timeoutMs: 1200000, maxToolCalls: 40, firstWriteMs: 480000 });
});

test('rejects symlinked profile paths', async (t) => {
  const root = await project();
  try {
    await writeFile(join(root, 'real.json'), JSON.stringify({ schemaVersion: 1, id: 'p' }));
    try {
      await symlink('real.json', join(root, 'profile.json'));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      workers: { pi: { type: 'pi', provider: 'p', model: 'm', profile: 'profile.json' } },
    }));
    await assert.rejects(resolveConfig(root), { code: 'SYMLINK_PATH' });
  } finally {
    await cleanup(root);
  }
});

test('init preserves an existing config and gitignore', async () => {
  const root = await project();
  try {
    const config = JSON.stringify({ schemaVersion: 1, workers: {} });
    await writeFile(join(root, '.tinysdd', 'config.json'), config);
    await writeFile(join(root, '.tinysdd', '.gitignore'), 'keep-me\n');
    const result = await initProject(root, { worker: 'pi', provider: 'p', model: 'm' });
    assert.equal(result.configCreated, false);
    assert.equal(result.gitignoreCreated, false);
    assert.equal(await readFile(join(root, '.tinysdd', 'config.json'), 'utf8'), config);
    assert.equal(await readFile(join(root, '.tinysdd', '.gitignore'), 'utf8'), 'keep-me\nruns/\nlaunches/\nconfig.local.json\n');
  } finally {
    await cleanup(root);
  }
});

test('semanticGate is optional: absent key keeps validating unchanged with mode off', () => {
  assert.deepEqual(validateConfigDocument({ schemaVersion: 1, workers: {} }), { schemaVersion: 1, workers: {} });
  const doc = validateConfigDocument({ schemaVersion: 1, workers: {}, semanticGate: { mode: 'enforce' } });
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.semanticGate.mode, 'enforce');
  assert.equal(doc.semanticGate.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(doc.semanticGate.model, 'jev-latest');
  assert.deepEqual(doc.semanticGate.thresholds, { accept: 0.75, reject: 0.4 });
  for (const mode of ['off', 'shadow', 'enforce']) {
    assert.equal(validateConfigDocument({ schemaVersion: 1, workers: {}, semanticGate: { mode } }).semanticGate.mode, mode);
  }
});

test('rejects invalid semanticGate shapes without accepting partial overrides', () => {
  const base = { schemaVersion: 1, workers: {} };
  const invalid = [
    { semanticGate: null },
    { semanticGate: 'enforce' },
    { semanticGate: {} },
    { semanticGate: { mode: 'sometimes' } },
    { semanticGate: { mode: 'ENFORCE' } },
    { semanticGate: { mode: 'enforce', extra: true } },
    { semanticGate: { mode: 'enforce', endpoint: 'not a url' } },
    { semanticGate: { mode: 'enforce', endpoint: 'ftp://judge.example/v1' } },
    { semanticGate: { mode: 'enforce', endpoint: null } },
    { semanticGate: { mode: 'enforce', model: '' } },
    { semanticGate: { mode: 'enforce', thresholds: null } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 0.8 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 0.8, reject: 0.2, extra: 1 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 0, reject: 0.2 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 1, reject: 0.2 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 0.2, reject: 0.2 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: 0.4, reject: 0.75 } } },
    { semanticGate: { mode: 'enforce', thresholds: { accept: NaN, reject: 0.2 } } },
  ];
  for (const doc of invalid) {
    assert.throws(() => validateConfigDocument({ ...base, ...doc }), { code: 'CONFIG_INVALID' }, JSON.stringify(doc));
  }
  assert.deepEqual(
    validateConfigDocument({ schemaVersion: 1, workers: {}, semanticGate: { mode: 'shadow', thresholds: { accept: 0.8, reject: 0.3 } } }).semanticGate,
    { mode: 'shadow', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', thresholds: { accept: 0.8, reject: 0.3 } },
  );
});

test('resolveConfig surfaces the validated semanticGate and stays off when absent', async () => {
  const root = await project();
  try {
    await initProject(root);
    let resolved = await resolveConfig(root);
    assert.equal(resolved.config.semanticGate, undefined);
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      workers: {},
      semanticGate: { mode: 'shadow', thresholds: { accept: 0.8, reject: 0.3 } },
    }));
    resolved = await resolveConfig(root);
    assert.equal(resolved.config.semanticGate.mode, 'shadow');
    assert.equal(resolved.config.semanticGate.endpoint, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(resolved.config.semanticGate.model, 'jev-latest');
    assert.deepEqual(resolved.config.semanticGate.thresholds, { accept: 0.8, reject: 0.3 });
  } finally {
    await cleanup(root);
  }
});

test('profiles may set a thinking budget field and per-level budgets, strictly', async () => {
  const root = await project();
  const write = (runtime) => writeFile(join(root, 'profile.json'), JSON.stringify({ schemaVersion: 1, id: 'budget', runtime }));
  try {
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
      schemaVersion: 1,
      defaultWorker: 'qwen',
      workers: { qwen: { type: 'pi', provider: 'titan', model: 'qwen', profile: 'profile.json' } },
    }));
    await write({ thinking: 'medium', reasoning: true, compat: { thinkingFormat: 'qwen-chat-template', thinkingTokenBudgetField: 'thinking_budget_tokens' }, thinkingBudgets: { medium: 6000, high: 12000 } });
    const resolved = await resolveConfig(root);
    assert.deepEqual(resolved.profile.runtime.thinkingBudgets, { medium: 6000, high: 12000 });
    assert.equal(resolved.profile.runtime.compat.thinkingTokenBudgetField, 'thinking_budget_tokens');
    for (const thinkingBudgets of [{ xhigh: 1000 }, { medium: 0 }, { medium: 1.5 }, []]) {
      await write({ thinking: 'medium', thinkingBudgets });
      await assert.rejects(resolveConfig(root), { code: 'PROFILE_INVALID' });
    }
  } finally {
    await cleanup(root);
  }
});
