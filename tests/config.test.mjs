import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
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
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: 900001 } } },
  }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { timeoutMs: null } } },
  }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfigDocument({
    schemaVersion: 1,
    workers: { pi: { type: 'pi', provider: 'p', model: 'm', limits: { maxToolCalls: null } } },
  }), { code: 'CONFIG_INVALID' });
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
