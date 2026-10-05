import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { addTask, approveTask, initProject, reviewTask } from '../src/controller.mjs';
import { appendUsageRecord } from '../src/usage.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const canonicalTmpdir = await realpath(tmpdir());

async function project() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-usage-cli-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'brief.md'), '# Brief\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'src', 'entrypoint.mjs'), 'export const entrypoint = true;\n');
  await writeFile(join(root, 'tests', 'feature-integration-cli.mjs'), 'if (process.cwd().includes(".tinysdd")) process.exit(1);\n');
  await mkdir(join(root, '.tinysdd', 'reviews'), { recursive: true });
  await writeFile(join(root, '.tinysdd', 'reviews', 'evidence.md'), 'accepted evidence\n');
  await initProject(root);
  await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    workers: {},
    featureIntegration: {
      argv: ['node', 'tests/feature-integration-cli.mjs'],
      testPaths: ['tests/feature-integration-cli.mjs'],
      entrypoints: ['src/entrypoint.mjs'],
    },
  }));
  return root;
}

async function invoke(root, ...args) {
  try {
    const result = await exec(process.execPath, [cli, '--json', '--project', root, ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function invokeHuman(root, ...args) {
  try {
    const result = await exec(process.execPath, [cli, '--project', root, ...args], {
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

async function acceptedFeature(root) {
  await addTask(root, { id: 'one', feature: 'broker', brief: 'docs/brief.md', allow: ['src/one.mjs'], protect: ['tests/feature-integration-cli.mjs'] });
  await approveTask(root, { id: 'one', by: 'operator', reason: 'approved scope' });
  await reviewTask(root, { id: 'one', verdict: 'accepted', evidence: '.tinysdd/reviews/evidence.md', by: 'reviewer' });
}

test('usage record validates finite safe integers, attribution, and strict flags', async () => {
  const root = await project();
  try {
    const recorded = await invoke(root, 'usage', 'record', '--phase', 'review', '--model', 'frontier/model', '--input', '4', '--output', '2', '--reasoning', '1', '--cache-read', '0', '--cache-write', '0', '--total', '6', '--feature', 'broker');
    assert.equal(recorded.status, 0);
    const result = parseSingleJson(recorded);
    assert.equal(result.ok, true);
    assert.equal(result.data.record.input, 4);
    assert.equal(result.data.record.cacheRead, 0);

    for (const args of [
      ['usage', 'record', '--phase', 'review', '--model', 'm', '--input', '9007199254740992', '--output', '1', '--feature', 'broker'],
      ['usage', 'record', '--phase', 'review', '--model', 'm', '--input', '1', '--output', '1', '--unknown', 'x', '--feature', 'broker'],
      ['usage', 'record', '--phase', 'review', '--model', 'm', '--input', '1', '--output', '1'],
    ]) {
      const rejected = await invoke(root, ...args);
      assert.equal(rejected.status, 1);
      const error = parseSingleJson(rejected);
      assert.equal(error.ok, false);
      assert.match(error.error.message, /safe integer|unknown option|attribution/u);
    }
    const humanRejected = await invokeHuman(root, 'usage', 'record', '--phase', 'review', '--model', 'm', '--input', '1', '--output', '1', '--unknown', 'x', '--feature', 'broker');
    assert.equal(humanRejected.status, 1);
    assert.match(humanRejected.stderr, /^ERROR \[INVALID_ARGUMENT\] unknown option: --unknown/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage import and feature accept keep deterministic JSON when integration proof is missing', async () => {
  const root = await project();
  try {
    await acceptedFeature(root);
    await writeFile(join(root, 'usage-export.json'), JSON.stringify({
      schemaVersion: 1,
      type: 'usage-import',
      source: 'synthetic-talon',
      exportId: 'export-1',
      records: [{ externalRecordId: 'record-1', phase: 'review', model: 'frontier/model', feature: 'broker', input: 7, output: 3 }],
    }), 'utf8');
    const imported = await invoke(root, 'usage', 'import', '--file', 'usage-export.json');
    assert.equal(imported.status, 0);
    const importedResult = parseSingleJson(imported);
    assert.equal(importedResult.ok, true);
    assert.equal(importedResult.data.records[0].provenance.externalRecordId, 'record-1');

    const beforeAcceptReport = parseSingleJson(await invoke(root, 'usage', 'report', '--feature', 'broker'));
    assert.equal(beforeAcceptReport.ok, true);
    assert.equal(beforeAcceptReport.data.accepted, false);
    assert.equal(beforeAcceptReport.data.report.frontier.byPhase.review.input, 7);

    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({ schemaVersion: 1, workers: {} }), 'utf8');
    const acceptedResult = parseSingleJson(await invoke(root, 'feature', 'accept', '--feature', 'broker', '--by', 'operator', '--reason', 'feature complete'));
    assert.equal(acceptedResult.ok, false);
    assert.equal(acceptedResult.error.code, 'FEATURE_INTEGRATION_CONFIG');

    const late = await appendUsageRecord(root, { phase: 'review', model: 'frontier/model', feature: 'broker', input: 5, output: 2 });
    const frozen = parseSingleJson(await invoke(root, 'usage', 'report', '--feature', 'broker'));
    assert.equal(frozen.ok, true);
    assert.equal(frozen.data.accepted, false);
    assert.equal(frozen.data.report.frontier.byPhase.review.input, 12);
    assert.equal(frozen.data.report.frontier.ledgerRecordIds.includes(late.id), true);

    const human = await exec(process.execPath, [cli, '--project', root, 'feature', 'report', '--feature', 'broker'], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    assert.equal(human.stdout.split('\n').filter(Boolean).length, 3);
    assert.match(human.stdout, /^Feature broker: live report, not accepted/mu);
    assert.match(human.stdout, /Frontier input UNKNOWN \(known subtotal 12\); output UNKNOWN \(known subtotal 5\)/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage import refuses traversal and missing files without extra JSON output', async () => {
  const root = await project();
  try {
    for (const file of ['../outside.json', 'missing.json']) {
      const result = await invoke(root, 'usage', 'import', '--file', file);
      assert.equal(result.status, 1);
      const parsed = parseSingleJson(result);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error.code, /INVALID_PATH|PATH_NOT_FOUND/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
