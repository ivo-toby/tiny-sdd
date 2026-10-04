import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildBenchmarkConfigIdentity } from '../src/benchmark-schema.mjs';
import { buildQualificationRecord } from '../src/qualification.mjs';
import { writeQualificationRecord } from '../src/qualification-store.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const canonicalTmpdir = await realpath(tmpdir());
const digest = (letter) => letter.repeat(64);

function retainedRecord() {
  const identity = buildBenchmarkConfigIdentity({
    model: { provider: 'fake', id: 'model', quantization: 'Q4', server: { id: 'server', version: '1' } },
    worker: { profileDigest: digest('a'), limits: { timeoutMs: 1000, maxToolCalls: 10, firstWriteMs: null }, settings: { sandbox: 'test' } },
    pi: { version: 'test' },
    tinySdd: { version: '0.1.0', codeRevision: digest('b') },
    suite: { id: 'cli-suite', version: '1', contentSha256: digest('c') },
    verifier: { configSha256: digest('d'), checkRunner: { version: 'runCheck-v1', configSha256: digest('e') } },
    runChecks: { declared: true, available: false, budget: 12, unavailableReason: 'test unavailable', provenance: { source: 'test', unavailableReason: 'test unavailable' } },
    environment: { runtime: 'node', runtimeVersion: 'test', platform: 'test', arch: 'test' },
  });
  return buildQualificationRecord({
    configIdentity: identity.identity,
    configDigest: identity.configDigest,
    suite: { id: 'cli-suite', version: '1', sha256: digest('c') },
    roles: {
      'implement-slice': {
        n: 1,
        passes: 1,
        target: 0.8,
        perChallenge: [{
          id: 'challenge-a',
          version: '1',
          sha256: digest('f'),
          n: 1,
          passes: 1,
          results: [{ attemptId: 'attempt-1', repetition: 1, passed: true }],
        }],
      },
    },
  });
}

async function invoke(project, ...args) {
  try {
    const result = await exec(process.execPath, [cli, '--json', '--project', project, ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function parseSingleJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test('bench rescore and qualification show work offline from a retained record', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-qualification-cli-'));
  try {
    const saved = await writeQualificationRecord(root, retainedRecord());
    const prototypeTarget = await invoke(root, 'bench', 'rescore', '--record', saved.path, '--target', '__proto__=0.9');
    assert.equal(prototypeTarget.status, 1);
    const prototypeError = parseSingleJson(prototypeTarget);
    assert.equal(prototypeError.ok, false);
    assert.equal(prototypeError.error.code, 'INVALID_ARGUMENT');
    assert.match(prototypeError.error.message, /--target role/u);

    const rescored = await invoke(root, 'bench', 'rescore', '--record', saved.path, '--target', 'implement-slice=0.9');
    assert.equal(rescored.status, 0);
    const rescoredJson = parseSingleJson(rescored);
    assert.equal(rescoredJson.ok, true);
    assert.equal(rescoredJson.data.record.roles['implement-slice'].target, 0.9);
    assert.equal(rescoredJson.data.applicability.status, 'not_checked');

    const shown = await invoke(root, 'bench', 'qualification', 'show', '--record', saved.path);
    assert.equal(shown.status, 0);
    const shownJson = parseSingleJson(shown);
    assert.equal(shownJson.ok, true);
    assert.equal(shownJson.data.record.roles['implement-slice'].target, 0.9);

    const human = await exec(process.execPath, [cli, '--project', root, 'bench', 'qualification', 'show', '--record', saved.path], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    assert.match(human.stdout, /passesToQualify:/u);
    assert.match(human.stdout, /failuresToRuleOut:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
