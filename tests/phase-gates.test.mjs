import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  advancePhase,
  initProject,
  phaseStatus,
  recordResearch,
} from '../src/controller.mjs';
import { validateConfigDocument } from '../src/config.mjs';
import { appendPhaseRecord, PHASE_LEDGER_MAX_RECORDS, phasePolicyDigest, phaseStatus as phaseGateStatus, recordResearchDecision, transitionTestReview, validatePhasePolicy, validateTestReviewPolicy } from '../src/phase-gates.mjs';
import { MAX_CONTEXT_SOURCE_BYTES } from '../src/context-compiler.mjs';
import { digestJson } from '../src/fs-utils.mjs';

const exec = promisify(execFile);
const canonicalTmpdir = await realpath(tmpdir());

async function project(policy = { research: { mode: 'human' } }) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-phase-gates-'));
  await initProject(root);
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'docs', 'proposal.md'), '# Research proposal\n');
  await writeFile(join(root, 'src', 'module.mjs'), 'export const value = 1;\nuncited();\n');
  await writeFile(join(root, 'context.json'), JSON.stringify({
    schemaVersion: 1,
    facts: ['The first line is the cited entry point.'],
    resources: [{ path: 'src/module.mjs', startLine: 1, endLine: 1, purpose: 'entry point' }],
  }));
  const configPath = join(root, '.tinysdd', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.phaseGates = policy;
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function research(root, options = {}) {
  return recordResearch(root, {
    feature: 'feature-one',
    proposal: 'docs/proposal.md',
    context: 'context.json',
    by: 'operator',
    reason: 'reviewed the current research inputs',
    ...options,
  });
}

function decision({ id, feature = 'feature-one', phase = 'specify', decision = 'approved', policy }) {
  const record = {
    schemaVersion: 1,
    type: 'phase-decision',
    id,
    timestamp: new Date().toISOString(),
    feature,
    phase,
    decision,
    mode: 'human',
    by: 'operator',
    reason: 'recorded predecessor',
    policyDigest: phasePolicyDigest(policy),
  };
  return { ...record, recordDigest: digestJson(record) };
}

test('phase policy is optional and strictly validates canonical gate modes', () => {
  assert.deepEqual(validatePhasePolicy({ research: { mode: 'human' } }), { research: { mode: 'human' } });
  assert.deepEqual(validatePhasePolicy({ implement: { mode: 'human' } }), { implement: { mode: 'human' } });
  assert.throws(() => validatePhasePolicy({ research: { mode: 'unknown' } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validatePhasePolicy({ research: { mode: 'human', producer: 'qwen', qualification: { worker: 'other', role: 'research' } } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validatePhasePolicy({ research: { mode: 'human', producer: 'qwen', qualification: { required: false } } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validatePhasePolicy({ implement: { mode: 'frontier' } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validatePhasePolicy({ implement: { mode: 'human', predecessor: 'research' } }), { code: 'CONFIG_INVALID' });
});

test('#81 transition interface requires explicit policy and never grants acceptance', () => {
  const inputDigest = 'a'.repeat(64);
  const policy = { positiveThreshold: 0.8, revisionLimit: 2, uncertainRoute: 'escalation', unavailableRoute: 'unavailable' };
  const assessment = { verdict: 'positive', inputDigest, producer: { id: 'small-worker', role: 'test-assessor' }, provenance: 'synthetic' };
  assert.deepEqual(validateTestReviewPolicy(policy), policy);
  assert.deepEqual(validateConfigDocument({ schemaVersion: 1, workers: {}, testReview: policy }).testReview, policy);
  assert.throws(() => transitionTestReview({ assessment }), { code: 'TEST_REVIEW_POLICY_MISSING' });
  assert.deepEqual(transitionTestReview({ policy, assessment: { ...assessment, verdict: 'negative' }, revision: 0 }).route, 'revision');
  assert.deepEqual(transitionTestReview({ policy, assessment: { ...assessment, verdict: 'negative' }, revision: 2 }).route, 'escalation');
  assert.deepEqual(transitionTestReview({ policy, assessment }).route, 'independent-review');
  assert.throws(() => transitionTestReview({ policy, assessment, independentReview: { verdict: 'accepted', inputDigest: 'b'.repeat(64) } }), { code: 'TEST_REVIEW_INPUT_MISMATCH' });
  assert.equal(transitionTestReview({ policy, assessment, independentReview: { verdict: 'accepted', inputDigest } }).route, 'review-required');
  assert.throws(() => transitionTestReview({ policy, assessment, independentReview: {
    verdict: 'accepted', inputDigest, reviewer: { id: 'small-worker', role: 'test-assessor' }, strength: 'strong', attested: true, provenance: 'synthetic',
  } }), { code: 'TEST_REVIEW_NOT_INDEPENDENT' });
  const reviewed = transitionTestReview({ policy, assessment, independentReview: {
    verdict: 'accepted', inputDigest, reviewer: { id: 'operator-reviewer', role: 'strong-reviewer' }, strength: 'strong', attested: true, provenance: 'caller-declared',
  } });
  assert.equal(reviewed.approved, false);
  assert.equal(reviewed.route, 'operator-acceptance');
  for (const verdict of ['uncertain', 'unavailable']) {
    const boundedPolicy = { ...policy, uncertainRoute: 'revision', unavailableRoute: 'revision' };
    assert.equal(transitionTestReview({ policy: boundedPolicy, assessment: { ...assessment, verdict }, revision: 1 }).route, 'revision');
    assert.equal(transitionTestReview({ policy: boundedPolicy, assessment: { ...assessment, verdict }, revision: 2 }).route, 'escalation');
  }
  assert.equal(transitionTestReview({ policy, assessment, independentReview: {
    verdict: 'accepted', inputDigest, reviewer: { id: '   ', role: ' ' }, strength: 'strong', attested: true, provenance: 'caller-declared',
  } }).route, 'review-required');
  assert.throws(() => transitionTestReview({ policy, assessment, independentReview: {
    verdict: 'accepted', inputDigest, reviewer: { id: 'small-worker', role: 'test-assessor' }, strength: 'strong', attested: true, provenance: 'caller-declared',
  } }), { code: 'TEST_REVIEW_NOT_INDEPENDENT' });
  assert.throws(() => transitionTestReview({ policy, assessment: { verdict: 'positive', inputDigest } }), { code: 'TEST_REVIEW_IDENTITY_REQUIRED' });
});

test('records research, survives a fresh read, and advances only through an explicit transition', async () => {
  const root = await project();
  try {
    const result = await research(root);
    assert.equal(result.record.phase, 'research');
    assert.equal(result.record.decision, 'approved');
    assert.equal(result.record.inputs.compiledContext.compiledSha256.length, 64);
    const current = await phaseStatus(root, { feature: 'feature-one' });
    assert.equal(current.phases.research.status, 'approved');
    assert.equal(current.phases.plan.status, 'pending');
    const advanced = await advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'research is complete' });
    assert.equal(advanced.from, 'research');
    assert.equal(advanced.to, 'plan');
    assert.equal((await phaseStatus(root, { feature: 'feature-one' })).phases.plan.status, 'entered');
  } finally {
    await cleanup(root);
  }
});

test('phase status requires a feature and keeps independent feature states separate', async () => {
  const root = await project();
  try {
    await research(root, { feature: 'feature-one' });
    await advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'enter planning' });
    await writeFile(join(root, 'docs', 'second-proposal.md'), '# Second research proposal\n');
    await research(root, { feature: 'feature-two', proposal: 'docs/second-proposal.md' });
    await advancePhase(root, { feature: 'feature-two', by: 'operator', reason: 'enter planning' });
    await writeFile(join(root, 'docs', 'proposal.md'), '# Changed first proposal\n');
    const first = await phaseStatus(root, { feature: 'feature-one' });
    const second = await phaseStatus(root, { feature: 'feature-two' });
    assert.equal(first.feature, 'feature-one');
    assert.equal(first.phases.research.status, 'stale');
    assert.equal(first.phases.plan.status, 'stale');
    assert.equal(second.feature, 'feature-two');
    assert.equal(second.phases.research.status, 'approved');
    assert.equal(second.phases.plan.status, 'entered');
    await assert.rejects(phaseStatus(root), { code: 'PHASE_FEATURE_REQUIRED' });
  } finally {
    await cleanup(root);
  }
});

test('uncited source edits keep research fresh while cited edits stale research and its plan transition', async () => {
  const root = await project();
  try {
    await research(root);
    await advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'enter planning' });
    await writeFile(join(root, 'src', 'module.mjs'), 'export const value = 1;\nchanged uncited line\n');
    assert.equal((await phaseStatus(root, { feature: 'feature-one' })).phases.plan.status, 'entered');
    await writeFile(join(root, 'src', 'module.mjs'), 'export const value = 2;\nchanged cited line\n');
    const current = await phaseStatus(root, { feature: 'feature-one' });
    assert.equal(current.phases.research.status, 'stale');
    assert.equal(current.phases.plan.status, 'stale');
    await assert.rejects(advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'retry planning' }), { code: 'PHASE_RECORD_STALE' });
  } finally {
    await cleanup(root);
  }
});

test('proposal and manifest changes stale the research record', async () => {
  const root = await project();
  try {
    await research(root);
    await writeFile(join(root, 'docs', 'proposal.md'), '# Changed proposal\n');
    assert.equal((await phaseStatus(root, { feature: 'feature-one' })).phases.research.status, 'stale');
    await assert.rejects(advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'advance' }), { code: 'PHASE_RECORD_STALE' });
  } finally {
    await cleanup(root);
  }
});

test('research context rejects an oversized cited source through the bounded reader', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'src', 'module.mjs'), `${'x'.repeat(MAX_CONTEXT_SOURCE_BYTES + 1)}\n`);
    await assert.rejects(research(root), { code: 'CONTEXT_MANIFEST_INVALID' });
  } finally {
    await cleanup(root);
  }
});

test('non-human research modes report unavailable and do not create an approval', async () => {
  const root = await project({ research: { mode: 'frontier' } });
  try {
    await assert.rejects(research(root), { code: 'PHASE_GATE_UNAVAILABLE' });
    const status = await phaseStatus(root, { feature: 'feature-one' });
    assert.equal(status.phases.research.status, 'pending');
    assert.deepEqual(status.records, []);
  } finally {
    await cleanup(root);
  }
});

test('required research qualification is retained and revalidated against current record identity', async () => {
  const root = await project({ research: { mode: 'human', producer: 'researcher' } });
  const policy = { research: { mode: 'human', producer: 'researcher' } };
  const qualified = {
    worker: 'researcher',
    role: 'research',
    recordDigest: 'a'.repeat(64),
    recordPath: '.tinysdd/qualifications/record.json',
    recordSha256: 'b'.repeat(64),
    identityDigest: 'c'.repeat(64),
  };
  try {
    await recordResearchDecision(root, {
      feature: 'feature-one',
      proposal: 'docs/proposal.md',
      context: 'context.json',
      by: 'operator',
      reason: 'qualified research producer reviewed the inputs',
      policy,
      qualificationResolver: async () => qualified,
    });
    const current = await phaseGateStatus(root, {
      feature: 'feature-one',
      policy,
      qualificationResolver: async () => qualified,
    });
    assert.equal(current.phases.research.status, 'approved');
    const stale = await phaseGateStatus(root, {
      feature: 'feature-one',
      policy,
      qualificationResolver: async () => ({ ...qualified, recordSha256: 'd'.repeat(64) }),
    });
    assert.equal(stale.phases.research.status, 'stale');
  } finally {
    await cleanup(root);
  }
});

test('controller refuses a required producer when qualification is disabled or unavailable', async () => {
  const root = await project({ research: { mode: 'human', producer: 'researcher' } });
  try {
    const path = join(root, '.tinysdd', 'config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.workers = { researcher: { type: 'pi', provider: 'offline', model: 'offline/model' } };
    config.qualification = { mode: 'off' };
    await writeFile(path, `${JSON.stringify(config)}\n`);
    await assert.rejects(research(root), (error) => ['MODEL_NOT_QUALIFIED', 'PHASE_QUALIFICATION_REQUIRED'].includes(error.code));
  } finally {
    await cleanup(root);
  }
});

test('configured research predecessors require a supported live record', async () => {
  const policy = { research: { mode: 'human', predecessor: { phase: 'specify', required: true } }, specify: { mode: 'human' } };
  const root = await project(policy);
  try {
    await assert.rejects(research(root), { code: 'PHASE_PREDECESSOR_REQUIRED' });
    const predecessor = decision({ id: 'phase-specify', phase: 'specify', policy });
    await appendPhaseRecord(root, predecessor);
    await assert.rejects(research(root), { code: 'PHASE_PREDECESSOR_UNSUPPORTED' });
  } finally {
    await cleanup(root);
  }
});

test('research refuses a plan-entry predecessor without plan artifact approval', async () => {
  const oldPolicy = { research: { mode: 'human' }, plan: { mode: 'human' } };
  const root = await project(oldPolicy);
  try {
    await research(root, { policy: oldPolicy });
    await advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'enter planning' });
    const currentPolicy = { research: { mode: 'human', predecessor: { phase: 'plan', required: true } }, plan: { mode: 'human' } };
    await assert.rejects(recordResearchDecision(root, {
      feature: 'feature-one',
      proposal: 'docs/proposal.md',
      context: 'context.json',
      by: 'operator',
      reason: 'attempt with unsupported plan predecessor',
      policy: currentPolicy,
    }), { code: 'PHASE_PREDECESSOR_STALE' });
  } finally {
    await cleanup(root);
  }
});

test('research refuses a same-phase predecessor before publishing a new record', async () => {
  const root = await project();
  try {
    const first = await research(root);
    await writeFile(join(root, 'docs', 'second-proposal.md'), '# Second research proposal\n');
    await assert.rejects(research(root, {
      proposal: 'docs/second-proposal.md',
      predecessor: first.record.id,
    }), { code: 'PHASE_PREDECESSOR_UNSUPPORTED' });
    assert.equal((await phaseGateStatus(root, { feature: 'feature-one' })).records.length, 1);
  } finally {
    await cleanup(root);
  }
});

test('research refuses an indirect plan predecessor whose live chain contains research', async () => {
  const root = await project();
  try {
    await research(root, { proposal: 'docs/proposal.md' });
    const plan = await advancePhase(root, { feature: 'feature-one', by: 'operator', reason: 'enter planning' });
    await writeFile(join(root, 'docs', 'second-proposal.md'), '# Second research proposal\n');
    await assert.rejects(research(root, {
      proposal: 'docs/second-proposal.md',
      predecessor: plan.record.id,
    }), { code: 'PHASE_PREDECESSOR_UNSUPPORTED' });
    const status = await phaseStatus(root, { feature: 'feature-one' });
    assert.equal(status.phases.research.status, 'approved');
    assert.equal(status.phases.plan.status, 'entered');
    assert.equal(status.records.length, 2);
  } finally {
    await cleanup(root);
  }
});

test('append failure removes only the newly written research artifact', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('requires a non-root filesystem permission boundary');
    return;
  }
  const root = await project();
  const ledger = join(root, '.tinysdd', 'runs', 'phases.jsonl');
  const artifactDirectory = join(root, '.tinysdd', 'runs', 'phase-artifacts');
  try {
    await writeFile(ledger, '');
    await chmod(ledger, 0o400);
    for (const id of ['phase-append-fails-1', 'phase-append-fails-2']) {
      await assert.rejects(research(root, { id }), { code: 'EACCES' });
    }
    assert.deepEqual(await readdir(artifactDirectory), []);
    assert.equal(await readFile(ledger, 'utf8'), '');
  } finally {
    await chmod(ledger, 0o600).catch(() => {});
    await cleanup(root);
  }
});

test('append failure preserves a replacement artifact after rollback reads', async () => {
  const root = await project();
  const ledger = join(root, '.tinysdd', 'runs', 'phases.jsonl');
  const artifact = join(root, '.tinysdd', 'runs', 'phase-artifacts', 'phase-read-swap.json');
  const originalAppend = fs.promises.appendFile;
  const originalRead = fs.promises.readFile;
  let appendFailed = false;
  let substituted = false;
  try {
    await writeFile(ledger, '');
    fs.promises.appendFile = async function patchedAppend(target, ...args) {
      if (String(target) !== ledger) return originalAppend(target, ...args);
      appendFailed = true;
      throw Object.assign(new Error('controlled append refusal'), { code: 'EACCES' });
    };
    fs.promises.readFile = async function patchedRead(target, ...args) {
      const bytes = await originalRead(target, ...args);
      if (String(target) === artifact && appendFailed && !substituted) {
        const replacement = join(root, 'foreign-replacement.txt');
        await writeFile(replacement, 'foreign replacement');
        await rename(replacement, artifact);
        substituted = true;
      }
      return bytes;
    };
    syncBuiltinESMExports();
    await assert.rejects(recordResearchDecision(root, {
      feature: 'feature-one',
      proposal: 'docs/proposal.md',
      context: 'context.json',
      by: 'operator',
      reason: 'rollback substitution regression',
      id: 'phase-read-swap',
      policy: { research: { mode: 'human' } },
    }), { code: 'EACCES' });
    assert.equal(substituted, true);
    assert.equal(await readFile(artifact, 'utf8'), 'foreign replacement');
  } finally {
    fs.promises.appendFile = originalAppend;
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    await cleanup(root);
  }
});

test('changing the phase policy stales an existing research decision', async () => {
  const root = await project();
  try {
    await research(root);
    const path = join(root, '.tinysdd', 'config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.phaseGates.research.mode = 'frontier';
    await writeFile(path, `${JSON.stringify(config)}\n`);
    assert.equal((await phaseStatus(root, { feature: 'feature-one' })).phases.research.status, 'stale');
  } finally {
    await cleanup(root);
  }
});

test('duplicate ids do not replace the retained artifact', async () => {
  const root = await project();
  try {
    const first = await research(root, { id: 'phase-fixed' });
    const artifactPath = join(root, first.record.artifact.path);
    const before = await readFile(artifactPath);
    await assert.rejects(research(root, { id: 'phase-fixed', reason: 'second attempt' }), { code: 'PHASE_RECORD_DUPLICATE' });
    assert.deepEqual(await readFile(artifactPath), before);
  } finally {
    await cleanup(root);
  }
});

test('ledger capacity is checked before retaining a research artifact', async () => {
  const policy = { research: { mode: 'human' } };
  const root = await project(policy);
  try {
    const lines = Array.from({ length: PHASE_LEDGER_MAX_RECORDS }, (_, index) => JSON.stringify(decision({
      id: `phase-specify-${index}`,
      phase: 'specify',
      policy,
    })));
    await writeFile(join(root, '.tinysdd', 'runs', 'phases.jsonl'), `${lines.join('\n')}\n`);
    await assert.rejects(research(root, { id: 'phase-capacity-refused' }), { code: 'PHASE_LEDGER_TOO_LARGE' });
    await assert.rejects(readFile(join(root, '.tinysdd', 'runs', 'phase-artifacts', 'phase-capacity-refused.json')), { code: 'ENOENT' });
  } finally {
    await cleanup(root);
  }
});

test('tampered retained artifacts refuse status', async () => {
  const root = await project();
  try {
    const result = await research(root);
    await writeFile(join(root, result.record.artifact.path), '{}\n');
    await assert.rejects(phaseStatus(root, { feature: 'feature-one' }), { code: 'PHASE_ARTIFACT_TAMPERED' });
  } finally {
    await cleanup(root);
  }
});

test('missing retained artifacts are rejected before a ledger record is published', async () => {
  const root = await project();
  try {
    const record = decision({ id: 'phase-missing-artifact', phase: 'specify' });
    record.artifact = {
      path: '.tinysdd/runs/phase-artifacts/phase-missing-artifact.json',
      sha256: 'a'.repeat(64),
      bytes: 1,
    };
    record.recordDigest = digestJson(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'recordDigest')));
    await assert.rejects(appendPhaseRecord(root, record), { code: 'PHASE_ARTIFACT_MISSING' });
    assert.deepEqual(await phaseGateStatus(root, { feature: 'feature-one', policy: { research: { mode: 'human' } } }).then((status) => status.records), []);
  } finally {
    await cleanup(root);
  }
});

test('CLI phase commands return one JSON object and keep human output short', async () => {
  const root = await project();
  const bin = join(process.cwd(), 'bin', 'tinysdd.mjs');
  try {
    const recorded = await exec(process.execPath, [bin, '--project', root, '--json', 'phase', 'record', '--phase', 'research', '--feature', 'feature-one', '--proposal', 'docs/proposal.md', '--context', 'context.json', '--by', 'operator', '--reason', 'reviewed']);
    const parsed = JSON.parse(recorded.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.phase, 'research');
    const status = await exec(process.execPath, [bin, '--project', root, 'phase', 'status', '--feature', 'feature-one']);
    assert.match(status.stdout, /research: approved/u);
    assert.equal(status.stderr, '');
    const missingFeature = await exec(process.execPath, [bin, '--project', root, 'phase', 'status']).catch((error) => error);
    assert.match(missingFeature.stderr, /--feature requires a value/u);
  } finally {
    await cleanup(root);
  }
});
