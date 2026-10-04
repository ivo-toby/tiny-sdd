import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { compileContext, MAX_COMPILED_CONTEXT_BYTES } from '../src/context-compiler.mjs';
import { scoreResearchSelection } from '../src/research-scoring.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());

function manifest(resources, facts = []) {
  return { schemaVersion: 1, facts, resources };
}

function packet(value, path) {
  const text = JSON.stringify(value);
  return { path, text, sha256: sha256(text) };
}

async function makeProject() {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-score-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha.mjs'), [
    'export function first(value) {',
    '  return value + 1;',
    '}',
    '',
    'export function second(value) {',
    '  return value + 2;',
    '}',
    'const label = "café";',
  ].join('\n') + '\n');
  await writeFile(join(root, 'src', 'beta.mjs'), [
    'export function other(value) {',
    '  return value * 2;',
    '}',
  ].join('\n') + '\n');
  return root;
}

async function score(root, gold, candidate, budgetBytes = MAX_COMPILED_CONTEXT_BYTES) {
  return scoreResearchSelection({
    projectRoot: root,
    goldManifest: packet(gold, '.tinysdd/research/gold.json'),
    candidateManifest: packet(candidate, '.tinysdd/research/candidate.json'),
    budgetBytes,
  });
}

async function withSourceReversal(path, replacement, callback) {
  const original = await readFile(path);
  await writeFile(path, replacement);
  try {
    await callback(original);
  } finally {
    await writeFile(path, original);
    assert.deepEqual(await readFile(path), original, 'source bytes must be restored exactly');
  }
}

test('scores whole, partial, and cross-file selection by merged line unions', async () => {
  const root = await makeProject();
  try {
    const gold = manifest([
      { path: 'src/alpha.mjs', startLine: 1, endLine: 4, purpose: 'first interface' },
      { path: 'src/beta.mjs', startLine: 1, endLine: 2, purpose: 'other interface' },
    ]);
    const candidate = manifest([
      { path: 'src/alpha.mjs', startLine: 2, endLine: 3, purpose: 'same lines, different prose' },
      { path: 'src/alpha.mjs', startLine: 8, endLine: 8, purpose: 'unrelated line' },
    ]);
    const result = await score(root, gold, candidate);
    assert.equal(result.status, 'scored');
    assert.equal(result.metrics.goldLines, 6);
    assert.equal(result.metrics.candidateLines, 3);
    assert.equal(result.metrics.intersectionLines, 2);
    assert.equal(result.metrics.precision, 2 / 3);
    assert.equal(result.metrics.recall, 1 / 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merges overlapping and adjacent ranges before measuring cardinality', async () => {
  const root = await makeProject();
  try {
    const gold = manifest([
      { path: 'src/alpha.mjs', startLine: 1, endLine: 3, purpose: 'part one' },
      { path: 'src/alpha.mjs', startLine: 3, endLine: 5, purpose: 'part two' },
    ]);
    const candidate = manifest([
      { path: 'src/alpha.mjs', startLine: 2, endLine: 4, purpose: 'overlap one' },
      { path: 'src/alpha.mjs', startLine: 4, endLine: 6, purpose: 'overlap two' },
    ]);
    const result = await score(root, gold, candidate);
    assert.equal(result.metrics.goldLines, 5);
    assert.equal(result.metrics.candidateLines, 5);
    assert.equal(result.metrics.intersectionLines, 4);
    assert.equal(result.metrics.precision, 4 / 5);
    assert.equal(result.metrics.recall, 4 / 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports UNKNOWN for zero denominators instead of treating empty selection as perfect', async () => {
  const root = await makeProject();
  try {
    const empty = manifest([]);
    const gold = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'expected' }]);
    const candidate = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'selected' }]);
    const candidateEmpty = await score(root, gold, empty);
    assert.equal(candidateEmpty.metrics.precision, 'UNKNOWN');
    assert.equal(candidateEmpty.metrics.precisionStatus, 'UNKNOWN');
    assert.equal(candidateEmpty.metrics.recall, 0);
    assert.match(candidateEmpty.metrics.precisionReason, /denominator is zero/u);

    const goldEmpty = await score(root, empty, candidate);
    assert.equal(goldEmpty.metrics.precision, 0);
    assert.equal(goldEmpty.metrics.recall, 'UNKNOWN');
    assert.equal(goldEmpty.metrics.recallStatus, 'UNKNOWN');

    const bothEmpty = await score(root, empty, empty);
    assert.equal(bothEmpty.metrics.precision, 'UNKNOWN');
    assert.equal(bothEmpty.metrics.recall, 'UNKNOWN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses an invalid gold oracle before evaluating the candidate', async () => {
  const root = await makeProject();
  try {
    const candidate = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'candidate' }]);
    const result = await scoreResearchSelection({
      projectRoot: root,
      goldManifest: '{"schemaVersion":1,"facts":[],"resources":[',
      candidateManifest: packet(candidate, '.tinysdd/research/candidate.json'),
      budgetBytes: MAX_COMPILED_CONTEXT_BYTES,
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.evaluation, 'invalid_gold');
    assert.equal(result.gold.status, 'refused');
    assert.equal(result.candidate.status, 'not_evaluated');
    assert.equal(result.hardGates.gold.status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('turns malformed, invented, internal, and out-of-range candidate citations into hard-gate observations', async () => {
  const root = await makeProject();
  try {
    const gold = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'expected' }]);
    const invalidCandidates = [
      ['malformed JSON', '{'],
      ['invented path', manifest([{ path: 'src/missing.mjs', startLine: 1, endLine: 1, purpose: 'missing' }])],
      ['internal path', manifest([{ path: '.tinysdd/runs/run.json', startLine: 1, endLine: 1, purpose: 'internal' }])],
      ['out of range', manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 99, purpose: 'too long' }])],
    ];
    for (const [label, candidate] of invalidCandidates) {
      const result = await scoreResearchSelection({
        projectRoot: root,
        goldManifest: packet(gold, '.tinysdd/research/gold.json'),
        candidateManifest: typeof candidate === 'string' ? candidate : packet(candidate, '.tinysdd/research/candidate.json'),
        budgetBytes: MAX_COMPILED_CONTEXT_BYTES,
      });
      assert.equal(result.status, 'invalid', label);
      assert.equal(result.evaluation, 'invalid_candidate', label);
      assert.equal(result.hardGates.candidate.status, 'failed', label);
      assert.notEqual(result.candidate.status, 'valid', label);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinked candidate resources through the ordinary compiler path', async (t) => {
  const root = await makeProject();
  const outside = join(root, '..', `tinysdd-research-outside-${process.pid}.mjs`);
  try {
    await writeFile(outside, 'export const outside = true;\n');
    try {
      await symlink(outside, join(root, 'src', 'linked.mjs'));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    const manifestValue = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'expected' }]);
    const candidate = manifest([{ path: 'src/linked.mjs', startLine: 1, endLine: 1, purpose: 'unsafe' }]);
    const result = await score(root, manifestValue, candidate);
    assert.equal(result.status, 'invalid');
    assert.equal(result.candidate.error.details.cause, 'SYMLINK_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('reports exact caller budget boundaries using compiled UTF-8 bytes', async () => {
  const root = await makeProject();
  try {
    const value = manifest([{ path: 'src/alpha.mjs', startLine: 8, endLine: 8, purpose: 'Unicode boundary' }]);
    const baseline = await score(root, value, value);
    assert.equal(baseline.status, 'scored');
    assert.ok(baseline.candidate.bytes > 0);
    const exact = await score(root, value, value, baseline.candidate.bytes);
    assert.equal(exact.status, 'scored');
    assert.equal(exact.budget.candidateExceeded, false);
    const under = await score(root, value, value, baseline.candidate.bytes - 1);
    assert.equal(under.status, 'hard_gate_failed');
    assert.equal(under.evaluation, 'budget_exceeded');
    assert.equal(under.budget.candidateExceeded, true);
    assert.equal(under.hardGates.budget.status, 'failed');
    assert.equal(under.metrics.precision, 1);
    const invalidBudget = await scoreResearchSelection({ projectRoot: root, goldManifest: value, candidateManifest: value, budgetBytes: MAX_COMPILED_CONTEXT_BYTES + 1 });
    assert.equal(invalidBudget.status, 'invalid');
    assert.equal(invalidBudget.evaluation, 'invalid_budget');
    assert.equal(invalidBudget.hardGates.budget.status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restores a reversed source hunk and then returns to the valid score', async () => {
  const root = await makeProject();
  const sourcePath = join(root, 'src', 'alpha.mjs');
  try {
    const gold = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 1, purpose: 'first line' }]);
    const candidate = manifest([{ path: 'src/alpha.mjs', startLine: 8, endLine: 8, purpose: 'same line' }]);
    const original = await readFile(sourcePath);
    await withSourceReversal(sourcePath, Buffer.from('export function shortened() {\n}\n'), async (restored) => {
      const reversed = await score(root, gold, candidate);
      assert.equal(reversed.status, 'invalid');
      assert.equal(reversed.evaluation, 'invalid_candidate');
      assert.equal(reversed.candidate.error.code, 'CONTEXT_MANIFEST_INVALID');
      assert.deepEqual(restored, original);
    });
    const after = await score(root, gold, candidate);
    assert.equal(after.status, 'scored');
    assert.equal(after.metrics.precision, 0);
    assert.equal(after.metrics.recall, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('matches the existing compiler output and remains stable across repeated calls', async () => {
  const root = await makeProject();
  try {
    const value = manifest([{ path: 'src/alpha.mjs', startLine: 1, endLine: 3, purpose: 'interface' }], ['Keep the public interface.']);
    const context = packet(value, '.tinysdd/research/candidate.json');
    const compiled = await compileContext(root, context);
    const first = await scoreResearchSelection({
      projectRoot: root,
      goldManifest: context,
      candidateManifest: context,
      budgetBytes: compiled.bytes,
    });
    const second = await scoreResearchSelection({
      projectRoot: root,
      goldManifest: context,
      candidateManifest: context,
      budgetBytes: compiled.bytes,
    });
    assert.deepEqual(second, first);
    assert.equal(first.gold.sha256, compiled.sha256);
    assert.equal(first.candidate.bytes, compiled.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds a malformed 512 KiB manifest without executing anything', async () => {
  const root = await makeProject();
  try {
    const malformed = `{"schemaVersion":1,"facts":[],"resources":[${' '.repeat(512 * 1024)}]`;
    const started = performance.now();
    const result = await scoreResearchSelection({
      projectRoot: root,
      goldManifest: packet(manifest([]), '.tinysdd/research/gold.json'),
      candidateManifest: malformed,
      budgetBytes: MAX_COMPILED_CONTEXT_BYTES,
    });
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 2000, `expected malformed input under 2000 ms, took ${elapsedMs.toFixed(1)} ms`);
    assert.equal(result.status, 'invalid');
    assert.equal(result.evaluation, 'invalid_candidate');
    assert.equal(result.hardGates.candidate.status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
