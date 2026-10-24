import test from 'node:test';
import assert from 'node:assert/strict';

import { attachCard, buildCard, newRegistryProfile } from '../bench/polyglot/lib/card.mjs';

const MODEL = { key: 'gemma', route: 'titan/llamacpp/gemma', contextWindow: 64000, maxTokens: 16384, thinking: 'medium', parallel: 2 };

function result(exercise, { profile = 'baseline', split = 'discovery', pass1 = true, pass2 = true, minutes = 2, repeat = 1 } = {}) {
  const start = Date.parse('2026-10-21T10:00:00Z');
  return {
    model: 'gemma', profile, exercise, language: exercise.split('/')[0], split, repeat, pass1, pass2,
    attempts: [{ test: { outputTail: 'SECRET TEST OUTPUT' } }],
    startedAt: new Date(start).toISOString(), finishedAt: new Date(start + minutes * 60000).toISOString(),
  };
}

const RESULTS = [
  result('rust/a', { pass1: false, pass2: true, minutes: 4 }),
  result('rust/b', { split: 'holdout', pass1: false, pass2: false, minutes: 6 }),
  result('python/c', { minutes: 2 }),
  result('python/d', { split: 'holdout', minutes: 4 }),
  result('python/d', { profile: 'gemma-r1-x', split: 'holdout', pass1: true }),
  result('rust/b', { profile: 'gemma-r1-x', split: 'holdout', pass1: true, pass2: true }),
  result('rust/a', { profile: 'gemma-r1-x', split: 'discovery', pass1: false }),
  { ...result('python/e'), model: 'other' },
];

function base(overrides = {}) {
  return { results: RESULTS, runName: 'main', datasetCommit: '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f', validExercises: 207, model: MODEL, timeoutMs: 600000, ...overrides };
}

test('a baseline card holds only aggregates over every split', () => {
  const card = buildCard(base());
  assert.deepEqual(card, {
    suite: 'aider-polyglot@7e0611e',
    harness: 'tinysdd bench/polyglot',
    date: '2026-10-21',
    variant: 'baseline',
    split: 'all',
    run: 'main',
    settings: { route: 'titan/llamacpp/gemma', contextWindow: 64000, maxTokens: 16384, thinking: 'medium', timeoutMs: 600000, parallel: 2 },
    exercises: 4,
    validExercises: 207,
    repeats: 1,
    pass1: 0.5,
    pass2: 0.75,
    minutesPerTask: 4,
    perLanguage: { python: { n: 2, pass1: 1, pass2: 1 }, rust: { n: 2, pass1: 0, pass2: 0.5 } },
  });
  assert.equal(JSON.stringify(card).includes('SECRET'), false);
  assert.equal(JSON.stringify(card).includes('rust/a'), false);
});

test('a candidate card covers holdout only and carries the decision', () => {
  const decision = { keep: false, metric: 'pass1', n: 2, delta: 0.5, reasons: ['delta_not_above_0.05'], perLanguage: { rust: {} } };
  const card = buildCard(base({ profile: 'gemma-r1-x', decision }));
  assert.equal(card.split, 'holdout');
  assert.equal(card.exercises, 2);
  assert.equal(card.pass1, 1);
  assert.equal(Object.hasOwn(card, 'validExercises'), false);
  assert.deepEqual(card.decision, { metric: 'pass1', keep: false, n: 2, delta: 0.5, reasons: ['delta_not_above_0.05'] });
});

test('a new registry profile records the measured settings', () => {
  const card = buildCard(base());
  const profile = newRegistryProfile({ id: 'gemma-titan-v1', model: MODEL, card });
  assert.equal(profile.status, 'baseline');
  assert.deepEqual(profile.model, { route: 'titan/llamacpp/gemma', contextWindow: 64000, parallel: 2 });
  assert.deepEqual(profile.responseBudget, { maxTokens: 16384 });
  assert.deepEqual(profile.limits, { timeoutMs: 600000 });
  assert.deepEqual(profile.runtime, { thinking: 'medium', reasoning: true });
  assert.equal(profile.instructions, '');
});

test('attaching replaces the same card and refuses different settings', () => {
  const card = buildCard(base());
  const profile = newRegistryProfile({ id: 'gemma-titan-v1', model: MODEL, card });
  const candidate = buildCard(base({ profile: 'gemma-r1-x', decision: { keep: false, metric: 'pass1', reasons: [] } }));
  const twice = attachCard(attachCard(profile, candidate), candidate);
  assert.deepEqual(twice.benchmarks.map((c) => c.variant), ['baseline', 'gemma-r1-x']);
  const other = buildCard(base({ model: { ...MODEL, maxTokens: 32768 } }));
  assert.throws(() => attachCard(profile, other), /maxTokens 32768 vs 16384/);
});

test('no results is an error, not an empty card', () => {
  assert.throws(() => buildCard(base({ profile: 'missing' })), /no holdout results/);
});
