import { validateProfileDocument } from '../../../src/config.mjs';
import { validateBenchmarkCard } from '../../../src/model-registry.mjs';

export const HARNESS = 'tinysdd bench/polyglot';
const SETTING_KEYS = ['route', 'contextWindow', 'maxTokens', 'thinking', 'timeoutMs', 'parallel'];

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// The configuration a benchmark entry ran with, in registry terms.
export function settingsOf(model, timeoutMs) {
  return {
    route: model.route,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinking: model.thinking ?? 'medium',
    timeoutMs,
    parallel: model.parallel ?? 1,
  };
}

// Only aggregates go into the card: no prompts, diffs, test output or exercise names.
// Baselines cover every split; candidates are only reported on holdout, where decide() ran.
export function buildCard({ results, runName, datasetCommit, validExercises, model, profile = 'baseline', timeoutMs, decision = null, note }) {
  const split = profile === 'baseline' ? 'all' : 'holdout';
  const rows = results.filter((r) => r.model === model.key && r.profile === profile && (split === 'all' || r.split === split));
  if (rows.length === 0) throw new Error(`no ${split} results for ${model.key} ${profile}`);
  const exercises = new Set(rows.map((r) => r.exercise));
  const perLanguage = {};
  for (const r of rows) {
    const entry = perLanguage[r.language] ??= { n: 0, pass1: 0, pass2: 0 };
    entry.n += 1;
    if (r.pass1) entry.pass1 += 1;
    if (r.pass2) entry.pass2 += 1;
  }
  for (const entry of Object.values(perLanguage)) {
    entry.pass1 = round(entry.pass1 / entry.n);
    entry.pass2 = round(entry.pass2 / entry.n);
  }
  const minutes = rows.map((r) => (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 60000).filter(Number.isFinite);
  const lastFinished = rows.map((r) => r.finishedAt).filter(Boolean).sort().at(-1);
  const card = {
    suite: `aider-polyglot@${datasetCommit.slice(0, 7)}`,
    harness: HARNESS,
    date: lastFinished.slice(0, 10),
    variant: profile,
    split,
    run: runName,
    settings: settingsOf(model, timeoutMs),
    exercises: exercises.size,
    ...(split === 'all' ? { validExercises } : {}),
    repeats: Math.max(...rows.map((r) => r.repeat)),
    pass1: round(rows.filter((r) => r.pass1).length / rows.length),
    pass2: round(rows.filter((r) => r.pass2).length / rows.length),
    ...(minutes.length ? { minutesPerTask: round(minutes.reduce((a, b) => a + b, 0) / minutes.length, 1) } : {}),
    perLanguage: Object.fromEntries(Object.entries(perLanguage).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  if (decision) {
    card.decision = {
      metric: decision.metric,
      keep: decision.keep,
      ...(decision.n > 0 ? { n: decision.n } : {}),
      ...(Number.isFinite(decision.delta) ? { delta: round(decision.delta) } : {}),
      reasons: [...(decision.reasons ?? [])],
    };
    if (card.decision.reasons.length === 0) delete card.decision.reasons;
  }
  if (note) card.note = note;
  return validateBenchmarkCard(card);
}

// A new registry profile for the configuration the card was measured on.
export function newRegistryProfile({ id, model, card, instructions = '' }) {
  return validateProfileDocument({
    schemaVersion: 1,
    id,
    status: card.variant === 'baseline' ? 'baseline' : 'proposed',
    model: {
      route: model.route,
      contextWindow: model.contextWindow,
      parallel: model.parallel ?? 1,
      ...(model.note ? { note: model.note } : {}),
    },
    runtime: { thinking: card.settings.thinking, reasoning: true },
    limits: { timeoutMs: card.settings.timeoutMs },
    responseBudget: { maxTokens: card.settings.maxTokens },
    instructions,
    benchmarks: [card],
  }, id);
}

// Evidence only counts for the configuration it was measured with, so a card
// whose settings differ from the profile's is refused instead of attached.
export function attachCard(profile, card) {
  const expected = {
    route: profile.model?.route,
    contextWindow: profile.model?.contextWindow,
    maxTokens: profile.responseBudget?.maxTokens,
    thinking: profile.runtime?.thinking,
    timeoutMs: profile.limits?.timeoutMs,
    parallel: profile.model?.parallel,
  };
  const mismatched = SETTING_KEYS.filter((key) => expected[key] !== card.settings[key]);
  if (mismatched.length) {
    throw new Error(`card settings differ from profile ${profile.id}: ${mismatched.map((key) => `${key} ${card.settings[key]} vs ${expected[key]}`).join(', ')}`);
  }
  const same = (other) => other.suite === card.suite && other.variant === card.variant && other.split === card.split && other.run === card.run;
  const benchmarks = [...(profile.benchmarks ?? []).filter((other) => !same(other)), card];
  return validateProfileDocument({ ...profile, benchmarks }, profile.id);
}
