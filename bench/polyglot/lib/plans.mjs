// Queue plans. All sampling uses a seeded PRNG so the same inputs give the same queue.

import { mulberry32, shuffle, mcnemar } from './stats.mjs';

export const SCREEN_REPEAT = 101;
const ATTEMPTS = 2;

const keyOf = (model) => (typeof model === 'string' ? model : model.key);
const profileIdOf = (profile) => (typeof profile === 'string' ? profile : profile.id);
const toSet = (values) => new Set(values ?? []);

export function entryId({ model, profile, exercise, repeat }) {
  return `${model}__${profile}__${exercise.replaceAll('/', '__')}__r${repeat}`;
}

function entry(model, profile, exercise, repeat) {
  return { id: entryId({ model, profile, exercise, repeat }), model, profile, exercise, repeat, attempts: ATTEMPTS };
}

function sortedExercises(manifest, excluded, split) {
  const skip = toSet(excluded);
  return manifest.exercises
    .filter((exercise) => !skip.has(exercise.id) && (split === undefined || exercise.split === split))
    .map((exercise) => exercise.id)
    .sort();
}

export function baselinePlan({ models, manifest, excluded = [], repeats = 2 }) {
  const exercises = sortedExercises(manifest, excluded);
  const entries = [];
  for (const model of models.map(keyOf)) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const exercise of exercises) entries.push(entry(model, 'baseline', exercise, repeat));
    }
  }
  return entries;
}

const METRICS = ['pass1', 'pass2'];
function metricOf(metric) {
  if (!METRICS.includes(metric)) throw new Error(`metric must be one of ${METRICS.join(', ')}`);
  return metric;
}

// Discovery-only selection from the model's baseline results: exercises that failed
// the metric (pass@1 or pass@2) in any repeat, plus a seeded sample of exercises that passed in every repeat.
export function screenSelection({ results, model, passSample = 20, seed, metric = 'pass2' }) {
  const field = metricOf(metric);
  const modelKey = keyOf(model);
  const outcomes = new Map();
  for (const result of results) {
    if (result.model !== modelKey || result.profile !== 'baseline' || result.split !== 'discovery') continue;
    if (!outcomes.has(result.exercise)) outcomes.set(result.exercise, true);
    if (!result[field]) outcomes.set(result.exercise, false);
  }
  const failed = [...outcomes].filter(([, allPassed]) => !allPassed).map(([id]) => id).sort();
  const eligible = [...outcomes].filter(([, allPassed]) => allPassed).map(([id]) => id).sort();
  const rng = mulberry32(seed);
  const sample = shuffle(eligible, rng).slice(0, passSample).sort();
  return { seed, metric: field, failed, passSample: sample };
}

export function screenPlan({ results, model, candidates, passSample = 20, seed, metric = 'pass2' }) {
  const modelKey = keyOf(model);
  const selection = screenSelection({ results, model: modelKey, passSample, seed, metric });
  const exercises = [...new Set([...selection.failed, ...selection.passSample])].sort();
  const profiles = ['baseline-rerun', ...candidates.map(profileIdOf)];
  const entries = [];
  for (const profile of profiles) {
    for (const exercise of exercises) entries.push(entry(modelKey, profile, exercise, SCREEN_REPEAT));
  }
  return entries;
}

export function confirmPlan({ model, candidate, manifest, excluded = [], repeats = 2 }) {
  const modelKey = keyOf(model);
  const profile = profileIdOf(candidate);
  const exercises = sortedExercises(manifest, excluded, 'holdout');
  const entries = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const exercise of exercises) entries.push(entry(modelKey, profile, exercise, repeat));
  }
  return entries;
}

// Pre-registered rule, on holdout pass@2 paired by (exercise, repeat):
// keep iff candidate - baseline > 0.05 and no language drops by more than 0.10.
// Comparisons are done on integer counts so exact boundary values are not
// decided by floating-point error.
export function decide({ results, model, candidate, metric = 'pass2' }) {
  const field = metricOf(metric);
  const modelKey = keyOf(model);
  const profile = profileIdOf(candidate);
  const holdout = results.filter((result) => result.model === modelKey && result.split === 'holdout');
  const baselineByKey = new Map();
  const candidateByKey = new Map();
  for (const result of holdout) {
    const key = `${result.exercise}|${result.repeat}`;
    if (result.profile === 'baseline') baselineByKey.set(key, result);
    if (result.profile === profile) candidateByKey.set(key, result);
  }

  const pairs = [];
  const byLanguage = new Map();
  for (const [key, cand] of candidateByKey) {
    const base = baselineByKey.get(key);
    if (!base) continue;
    const x = Boolean(base[field]);
    const y = Boolean(cand[field]);
    pairs.push({ x, y });
    const lang = cand.language ?? base.language;
    if (!byLanguage.has(lang)) byLanguage.set(lang, { n: 0, baseline: 0, candidate: 0 });
    const counts = byLanguage.get(lang);
    counts.n += 1;
    if (x) counts.baseline += 1;
    if (y) counts.candidate += 1;
  }

  const n = pairs.length;
  const baselinePasses = pairs.filter((pair) => pair.x).length;
  const candidatePasses = pairs.filter((pair) => pair.y).length;
  const reasons = [];
  if (n === 0) reasons.push('no_paired_holdout_results');

  const deltaOk = n > 0 && 20 * (candidatePasses - baselinePasses) > n;
  if (n > 0 && !deltaOk) reasons.push('delta_not_above_0.05');

  const perLanguage = {};
  for (const lang of [...byLanguage.keys()].sort()) {
    const counts = byLanguage.get(lang);
    const drop = counts.baseline - counts.candidate;
    const veto = 10 * drop > counts.n;
    if (veto) reasons.push(`language_drop:${lang}`);
    perLanguage[lang] = {
      n: counts.n,
      baselineRate: counts.baseline / counts.n,
      candidateRate: counts.candidate / counts.n,
      delta: (counts.candidate - counts.baseline) / counts.n,
      veto,
    };
  }

  const test = mcnemar(pairs);
  return {
    keep: reasons.length === 0,
    reasons,
    n,
    metric: field,
    delta: n > 0 ? (candidatePasses - baselinePasses) / n : null,
    p: test.p,
    baselineRate: n > 0 ? baselinePasses / n : null,
    candidateRate: n > 0 ? candidatePasses / n : null,
    perLanguage,
  };
}
