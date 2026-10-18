import { assertExactKeys, assertPlainObject, tinyError } from './fs-utils.mjs';
import { validateBenchmarkCaseResult } from './benchmark-results.mjs';
import { validateBenchmarkConfigIdentity } from './benchmark-schema.mjs';
import { isSuccessfulBenchmarkCase } from './qualification.mjs';

export const INSTRUCTION_UNKNOWN = 'UNKNOWN';
export const INSTRUCTION_CATEGORIES = Object.freeze(['length-detail', 'structure', 'interfaces-callers', 'edge-cases', 'context-selection', 'integration']);
const CODE = 'INSTRUCTION_EXPERIMENT_INVALID';
const U = INSTRUCTION_UNKNOWN;

export function invalidInstruction(message) { throw tinyError(CODE, message); }
export function instructionObject(value, allowed, label) {
  assertPlainObject(value, CODE, label);
  assertExactKeys(value, allowed, CODE, label);
  return value;
}
export function instructionString(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0)) invalidInstruction(`${label} must be a string${empty ? '' : ' with content'}`);
  return value;
}
export function instructionId(value, label) {
  instructionString(value, label);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) invalidInstruction(`${label} must be a lowercase identifier`);
  return value;
}
export function instructionRef(value, label) {
  instructionObject(value, ['path', 'sha256'], label);
  instructionString(value.path, `${label}.path`);
  if (!/^[0-9a-f]{64}$/u.test(value.sha256)) invalidInstruction(`${label}.sha256 must be SHA-256`);
  return { path: value.path, sha256: value.sha256 };
}
export function instructionInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalidInstruction(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

export function validateInstructionPartitions(value, challengeIds) {
  if (!Array.isArray(value) || value.length !== challengeIds.length) invalidInstruction('partitions must assign every challenge exactly once');
  const ids = new Set();
  const lineages = new Map();
  const result = value.map((entry) => {
    instructionObject(entry, ['challengeId', 'lineage', 'partition'], 'partition');
    instructionId(entry.challengeId, 'partition.challengeId');
    instructionId(entry.lineage, 'partition.lineage');
    if (!['discovery', 'control'].includes(entry.partition)) invalidInstruction('partition must be discovery or control');
    if (!challengeIds.includes(entry.challengeId) || ids.has(entry.challengeId)) invalidInstruction('partitions contain an unknown or duplicate challenge');
    ids.add(entry.challengeId);
    if (lineages.has(entry.lineage) && lineages.get(entry.lineage) !== entry.partition) invalidInstruction(`lineage ${entry.lineage} crosses discovery/control partitions`);
    lineages.set(entry.lineage, entry.partition);
    return { ...entry };
  });
  if (new Set(result.map((entry) => entry.partition)).size !== 2) invalidInstruction('separate discovery and control tasks are required');
  return result;
}

export function instructionRuntimeIdentity(value) {
  const identity = validateBenchmarkConfigIdentity(value);
  return { ...identity, worker: { ...identity.worker, profileDigest: U }, missing: identity.missing.filter(({ field }) => field !== 'worker.profileDigest') };
}

function verifierQuality(result) {
  if (Object.values(result.hardGates).some((value) => value === true)) return false;
  if (result.outcome === 'setup_error' || ['not_run', 'unavailable'].includes(result.outcome)) return U;
  const checks = [...result.verifier.visible, ...result.verifier.heldOut];
  if (result.verifier.visible.length === 0 || result.verifier.heldOut.length === 0
    || checks.some((check) => ['unavailable', 'not_run'].includes(check.status))) return U;
  return isSuccessfulBenchmarkCase(result);
}

function metricNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : U; }

export function summarizeInstructionCase(value, integrationChecks = []) {
  const result = validateBenchmarkCaseResult(value);
  const usage = result.observed?.cumulativeUsage;
  // Older workers initialize cumulative counters to zero even without usage.
  const finalUsage = result.observed?.usage;
  const usageObserved = finalUsage && typeof finalUsage === 'object' && usage?.assistantMessages === 1;
  const tokenCount = (field) => usageObserved && metricNumber(finalUsage[field]) !== U ? metricNumber(usage?.[field]) : U;
  return {
    challengeId: result.challenge.id, role: result.role, configDigest: result.configDigest,
    outcome: result.outcome, failureCategory: result.failure.category, quality: verifierQuality(result),
    integration: integrationChecks.length === 0 ? U : integrationChecks.map(({ visibility, checkId }) => result.verifier[visibility].find((check) => check.checkId === checkId)).some((check) => !check || ['not_run', 'unavailable'].includes(check.status)) ? U
      : integrationChecks.every(({ visibility, checkId }) => result.verifier[visibility].find((check) => check.checkId === checkId).status === 'passed'),
    visible: result.verifier.visible.map(({ checkId, status }) => ({ checkId, status })),
    heldOut: result.verifier.heldOut.map(({ status }) => status),
    hardGates: result.hardGates,
    telemetry: {
      elapsedMs: metricNumber(result.observed?.processTermination?.elapsedMs),
      repairRounds: U,
      inputTokens: tokenCount('input'),
      outputTokens: tokenCount('output'),
      reasoningTokens: tokenCount('reasoning'),
      totalTokens: tokenCount('totalTokens'),
    },
  };
}

export function validateInstructionProposal(value) {
  instructionObject(value, ['id', 'configDigest', 'role', 'category', 'observation', 'hypothesis', 'before', 'after', 'expectedEffect', 'evidence', 'experimentPlan'], 'proposal');
  instructionId(value.id, 'proposal.id');
  if (!/^[0-9a-f]{64}$/u.test(value.configDigest)) invalidInstruction('proposal.configDigest must be SHA-256');
  for (const field of ['role', 'observation', 'hypothesis', 'expectedEffect', 'experimentPlan']) instructionString(value[field], `proposal.${field}`);
  if (!INSTRUCTION_CATEGORIES.includes(value.category)) invalidInstruction('proposal.category is invalid');
  instructionString(value.before, 'proposal.before', { empty: true });
  instructionString(value.after, 'proposal.after');
  if (value.before === value.after || value.after.length > 8192 || value.before.length > 8192) invalidInstruction('proposal must make one bounded instruction change (up to 8192 characters per variant)');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) invalidInstruction('proposal.evidence must reference discovery observations');
  return { ...value, evidence: value.evidence.map((ref) => instructionRef(ref, 'proposal.evidence')) };
}

export function analyzeInstructionObservations({ observations, partitions, proposals, preparation }) {
  const groups = new Map();
  const seen = new Set();
  const retained = [];
  for (const entry of observations) {
    const result = validateBenchmarkCaseResult(entry.caseResult);
    const partition = partitions.find(({ challengeId }) => challengeId === result.challenge.id);
    if (!partition) invalidInstruction('observation has no partition');
    if (partition.partition !== 'discovery') continue;
    const key = `${entry.invocationId}/${result.attemptId}`;
    if (seen.has(key)) invalidInstruction(`duplicate observation: ${key}`);
    seen.add(key);
    const summary = summarizeInstructionCase(result);
    const item = { source: instructionRef(entry.source, 'observation source'), invocationId: entry.invocationId, attemptId: result.attemptId, lineage: partition.lineage, ...summary, publicArtifacts: entry.publicArtifacts ?? [] };
    retained.push(item);
    const groupKey = `${result.configDigest}/${result.role}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { configDigest: result.configDigest, configIdentity: result.configIdentity, role: result.role, observations: [] });
    groups.get(groupKey).observations.push(item);
  }
  const ids = new Set();
  const evaluated = proposals.map((raw) => {
    const proposal = validateInstructionProposal(raw);
    if (ids.has(proposal.id)) invalidInstruction('duplicate proposal id');
    ids.add(proposal.id);
    const selected = proposal.evidence.map((ref) => {
      const item = retained.find(({ source }) => source.path === ref.path && source.sha256 === ref.sha256);
      if (!item) invalidInstruction('proposal evidence must be a discovery observation; control or hidden artifact references are forbidden');
      if (item.configDigest !== proposal.configDigest || item.role !== proposal.role) invalidInstruction('proposal evidence mixes configurations or roles');
      return item;
    });
    if (new Set(selected.map(({ source }) => source.path)).size !== selected.length) invalidInstruction('duplicate proposal evidence');
    const failures = selected.filter(({ quality }) => quality === false).length;
    const unknown = selected.filter(({ quality }) => quality === U).length;
    const contradictory = selected.filter(({ quality }) => quality === true).length;
    const status = failures >= 2 && unknown === 0 && contradictory === 0 ? 'proposed' : 'inconclusive';
    return { ...proposal, status, explanation: status === 'proposed'
      ? 'Repeated independently checked failures support testing this supplied hypothesis; causality is untested.'
      : `Insufficient or conflicting evidence: ${failures} verified failures, ${unknown} setup/unavailable observations, ${contradictory} successes.`, counts: { failures, unknown, contradictory } };
  });
  return { schemaVersion: 1, kind: 'instruction-analysis', partitions, preparation, groups: [...groups.values()], proposals: evaluated,
    limitations: ['Hypotheses are supplied by the analyst, not inferred from verifier names or failure text.', 'Only discovery public artifacts are exported. Held-out logs and control answers are excluded.', 'Lineages and prior exposure are analyst attestations; semantic leakage outside this workflow cannot be detected.'] };
}

export function validateInstructionCriteria(value) {
  instructionObject(value, ['minPairsPerPartition', 'minQualityGain', 'maxRegressions', 'rationale'], 'criteria');
  instructionInteger(value.minPairsPerPartition, 'criteria.minPairsPerPartition', 1);
  if (typeof value.minQualityGain !== 'number' || !Number.isFinite(value.minQualityGain) || value.minQualityGain <= 0 || value.minQualityGain > 1) invalidInstruction('criteria.minQualityGain must be > 0 and <= 1');
  instructionInteger(value.maxRegressions, 'criteria.maxRegressions');
  instructionString(value.rationale, 'criteria.rationale');
  return { ...value };
}

export function instructionSchedule(repetitions) {
  instructionInteger(repetitions, 'repetitions', 2, 1000);
  return Array.from({ length: repetitions }, (_, index) => (index % 2 === 0 ? ['A', 'B'] : ['B', 'A']).map((arm) => ({ repetition: index + 1, arm }))).flat();
}

function pairedMetric(pairs, name) {
  const measured = pairs.filter(({ A, B }) => A?.telemetry[name] !== U && B?.telemetry[name] !== U && A?.telemetry[name] !== undefined && B?.telemetry[name] !== undefined);
  const differences = measured.map(({ A, B }) => B.telemetry[name] - A.telemetry[name]);
  return { measuredPairs: measured.length, scheduledPairs: pairs.length,
    A: measured.length ? measured.reduce((sum, { A }) => sum + A.telemetry[name], 0) : U,
    B: measured.length ? measured.reduce((sum, { B }) => sum + B.telemetry[name], 0) : U,
    meanPairedDifference: measured.length ? differences.reduce((sum, value) => sum + value, 0) / measured.length : U,
    differenceRange: measured.length ? [Math.min(...differences), Math.max(...differences)] : U };
}

function integrationCounts(pairs) {
  const complete = pairs.filter(({ A, B }) => typeof A?.integration === 'boolean' && typeof B?.integration === 'boolean');
  const improved = complete.filter(({ A, B }) => !A.integration && B.integration).length;
  const regressed = complete.filter(({ A, B }) => A.integration && !B.integration).length;
  return { A: { success: pairs.filter(({ A }) => A?.integration === true).length, unknown: pairs.filter(({ A }) => typeof A?.integration !== 'boolean').length, scheduled: pairs.length },
    B: { success: pairs.filter(({ B }) => B?.integration === true).length, unknown: pairs.filter(({ B }) => typeof B?.integration !== 'boolean').length, scheduled: pairs.length },
    completePairs: complete.length, improved, regressed, meanPairedDifference: complete.length ? (improved - regressed) / complete.length : U };
}

function summarizePairs(pairs, criteria) {
  const complete = pairs.filter(({ A, B }) => typeof A?.quality === 'boolean' && typeof B?.quality === 'boolean');
  const improved = complete.filter(({ A, B }) => !A.quality && B.quality).length;
  const regressed = complete.filter(({ A, B }) => A.quality && !B.quality).length;
  const n = complete.length;
  const gain = n ? (improved - regressed) / n : U;
  const counts = (arm) => ({ success: pairs.filter((pair) => pair[arm]?.quality === true).length, failure: pairs.filter((pair) => pair[arm]?.quality === false).length, unknown: pairs.filter((pair) => typeof pair[arm]?.quality !== 'boolean').length, scheduled: pairs.length });
  const lineages = [...new Set(pairs.map(({ lineage }) => lineage))].map((lineage) => {
    const selected = complete.filter((pair) => pair.lineage === lineage);
    return { lineage, pairs: selected.length, difference: selected.length ? selected.reduce((sum, { A, B }) => sum + Number(B.quality) - Number(A.quality), 0) / selected.length : U };
  });
  let state = 'inconclusive';
  if (regressed > criteria.maxRegressions) state = 'regressed';
  else if (n === pairs.length && n >= criteria.minPairsPerPartition) state = gain >= criteria.minQualityGain ? 'tested-improved' : gain < 0 ? 'regressed' : 'no-improvement';
  return { state, A: counts('A'), B: counts('B'), integration: integrationCounts(pairs), completePairs: n, improved, regressed, tied: n - improved - regressed, meanPairedDifference: gain,
    uncertainty: { missingPairs: pairs.length - n, lineages, method: 'descriptive lineage-level paired differences; repeated runs within a lineage are not independent samples', confidenceInterval: U },
    telemetry: Object.fromEntries(['elapsedMs', 'repairRounds', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'].map((name) => [name, pairedMetric(pairs, name)])) };
}

export function reportInstructionPairs({ plan, outcomes, preparation = U, review = U }) {
  const criteria = validateInstructionCriteria(plan.criteria);
  const expected = instructionSchedule(plan.repetitions);
  const seen = new Set();
  for (const outcome of outcomes) {
    const key = `${outcome.repetition}/${outcome.arm}/${outcome.challengeId}`;
    if (!expected.some((slot) => slot.repetition === outcome.repetition && slot.arm === outcome.arm)
      || !plan.partitions.some(({ challengeId }) => challengeId === outcome.challengeId) || seen.has(key)) invalidInstruction('unexpected or duplicate paired outcome');
    seen.add(key);
  }
  const pairs = plan.partitions.flatMap(({ challengeId, partition, lineage }) => Array.from({ length: plan.repetitions }, (_, index) => ({
    challengeId, partition, lineage, repetition: index + 1,
    A: outcomes.find((entry) => entry.challengeId === challengeId && entry.repetition === index + 1 && entry.arm === 'A') ?? null,
    B: outcomes.find((entry) => entry.challengeId === challengeId && entry.repetition === index + 1 && entry.arm === 'B') ?? null,
  })));
  const partitions = Object.fromEntries(['discovery', 'control'].map((partition) => [partition, summarizePairs(pairs.filter((pair) => pair.partition === partition), criteria)]));
  const states = Object.values(partitions).map(({ state }) => state);
  const state = states.includes('regressed') ? 'regressed' : states.includes('inconclusive') ? 'inconclusive'
    : states.every((value) => value === 'tested-improved') ? 'tested-improved' : 'no-improvement';
  return { schemaVersion: 1, kind: 'instruction-experiment-report', state,
    recommendation: state === 'tested-improved' ? 'consider B for the tested configuration' : ['regressed', 'no-improvement'].includes(state) ? 'keep A' : 'gather more evidence',
    criteria, partitions, pairs, overhead: { preparation, review },
    limitations: [...plan.confounds, 'Decision criteria are predeclared descriptive pilot criteria, not statistical proof or feature acceptance.', 'Correctness is the existing independent benchmark check/hard-gate result; integration coverage depends on the declared checks.', 'Repair rounds are UNKNOWN: the benchmark runner does not measure semantic repair cycles.', 'Token totals require an observed single-message usage record. Multi-message cumulative completeness is UNKNOWN because this worker schema does not count missing usage records; totals exclude unmeasured overhead.', ...(plan.synthetic ? ['SYNTHETIC offline harness; this report provides no model-effectiveness evidence.'] : [])] };
}
