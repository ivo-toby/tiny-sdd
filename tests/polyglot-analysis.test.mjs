import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { featuresFor, isCompileError } from '../bench/polyglot/lib/features.mjs';
import { mcnemar, mulberry32, shuffle, summarize } from '../bench/polyglot/lib/stats.mjs';
import { buildReport, report } from '../bench/polyglot/lib/report.mjs';
import { baselinePlan, confirmPlan, decide, entryId, screenPlan, screenSelection } from '../bench/polyglot/lib/plans.mjs';
import { exportFailures, lineDiff } from '../bench/polyglot/lib/export.mjs';
import { TRIAGE_QUESTIONS, triage, triageLabel } from '../bench/polyglot/lib/triage.mjs';

const LANGUAGE_OF = (exercise) => exercise.split('/')[0];

function attempt(n, { outcome = 'completed', changedFiles = ['a.py'], scopeViolation = false, passed = false, timedOut = false, outputTail = '' } = {}) {
  return {
    n,
    workerOutcome: outcome,
    workerError: null,
    elapsedMs: 1,
    usage: { input: 0, output: 0 },
    toolCalls: 1,
    changedFiles,
    scopeViolation,
    test: { passed, exitCode: passed ? 0 : 1, timedOut, durationMs: 1, outputTail },
  };
}

function res({ model = 'm1', profile = 'baseline', exercise, split = 'discovery', repeat = 1, pass2 = false, pass1 = pass2 }) {
  return {
    id: entryId({ model, profile, exercise, repeat }),
    model,
    profile,
    exercise,
    language: LANGUAGE_OF(exercise),
    split,
    repeat,
    attempts: [attempt(1, { passed: pass2 })],
    pass1,
    pass2,
    features: [],
    startedAt: '2026-10-19T00:00:00.000Z',
    finishedAt: '2026-10-19T00:00:01.000Z',
  };
}

function ex(id, split, extra = {}) {
  const language = id.split('/')[0];
  return {
    id,
    language,
    dir: `${language}/exercises/practice/${id.split('/')[1]}`,
    solutionFiles: [`${id.split('/')[1]}.py`],
    testFiles: [`${id.split('/')[1]}_test.py`],
    exampleFiles: ['.meta/example.py'],
    instructions: `instructions for ${id}`,
    split,
    ...extra,
  };
}

test('features: passing run, plain test failure and worker outcome classes', () => {
  assert.deepEqual(featuresFor({ language: 'python', attempts: [attempt(1, { passed: true })] }), ['passed']);
  assert.deepEqual(
    featuresFor({ language: 'python', attempts: [attempt(1, { outputTail: 'AssertionError: 1 != 2' })] }),
    ['tests_failed'],
  );
  const cases = {
    timeout: 'worker_timeout',
    tool_limit: 'tool_limit',
    response_token_limit: 'response_token_limit',
    raw_output_limit: 'raw_output_limit',
    no_progress: 'no_progress',
    stopped: 'worker_failed',
  };
  for (const [outcome, feature] of Object.entries(cases)) {
    const features = featuresFor({ language: 'python', attempts: [attempt(1, { outcome, outputTail: 'x' })] });
    assert.ok(features.includes(feature), `${outcome} -> ${feature}, got ${features}`);
  }
});

test('features: edits, scope, test timeout and last-attempt semantics', () => {
  assert.ok(featuresFor({ language: 'go', attempts: [attempt(1, { changedFiles: [] })] }).includes('no_edits'));
  assert.ok(featuresFor({ language: 'go', attempts: [attempt(1, { scopeViolation: true })] }).includes('scope_violation'));
  assert.deepEqual(
    featuresFor({ language: 'go', attempts: [attempt(1, { timedOut: true })] }),
    ['test_timeout'],
  );
  const result = {
    language: 'python',
    attempts: [attempt(1, { outcome: 'timeout', outputTail: 'boom' }), attempt(2, { passed: true })],
  };
  assert.deepEqual(featuresFor(result), ['passed']);
});

test('features: compile error regexes per language', () => {
  const samples = {
    python: ['SyntaxError: invalid syntax', 'IndentationError: unexpected indent'],
    go: ['./a.go:3:2: undefined: foo', 'FAIL pkg [build failed]'],
    rust: ['error[E0425]: cannot find value `x`', 'error: could not compile `x`'],
    javascript: ['Test suite failed to run\n SyntaxError: Unexpected token'],
    java: ['error: cannot find symbol', 'Task :compileJava FAILED'],
    cpp: ['a.cpp:4:1: error: expected `;`', 'undefined reference to `foo()`'],
  };
  for (const [language, texts] of Object.entries(samples)) {
    for (const text of texts) assert.equal(isCompileError(language, text), true, `${language}: ${text}`);
  }
  assert.equal(isCompileError('python', 'AssertionError: expected 3'), false);
  assert.equal(isCompileError('go', '--- FAIL: TestX (0.00s)'), false);
  assert.deepEqual(
    featuresFor({ language: 'python', attempts: [attempt(1, { outputTail: 'SyntaxError: bad' })] }),
    ['compile_error'],
  );
});

test('mcnemar: exact two-sided binomial on discordant pairs', () => {
  const pairs = (b, c) => [
    ...Array.from({ length: b }, () => ({ x: true, y: false })),
    ...Array.from({ length: c }, () => ({ x: false, y: true })),
    { x: true, y: true },
  ];
  const zeroSix = mcnemar(pairs(0, 6));
  assert.equal(zeroSix.b, 0);
  assert.equal(zeroSix.c, 6);
  assert.equal(zeroSix.n, 6);
  assert.ok(Math.abs(zeroSix.p - 0.03125) < 1e-12);
  assert.equal(mcnemar(pairs(3, 3)).p, 1);
  assert.equal(mcnemar([]).p, 1);
  assert.ok(Math.abs(mcnemar(pairs(1, 5)).p - 0.21875) < 1e-12);
});

test('summarize groups and computes pass rates', () => {
  const results = [
    res({ exercise: 'python/a', pass2: true }),
    res({ exercise: 'python/b', pass2: false }),
    res({ exercise: 'go/c', pass2: true, profile: 'cand' }),
  ];
  const groups = summarize(results, { groupBy: ['profile'] });
  assert.deepEqual(groups.map((g) => [g.key, g.n, g.pass2, g.pass2Rate]), [
    ['profile=baseline', 2, 1, 0.5],
    ['profile=cand', 1, 1, 1],
  ]);
  assert.equal(summarize([], { groupBy: [] }).length, 0);
});

test('seeded PRNG is deterministic and shuffle is a permutation', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const items = ['a', 'b', 'c', 'd', 'e'];
  const once = shuffle(items, mulberry32(7));
  assert.deepEqual(once, shuffle(items, mulberry32(7)));
  assert.deepEqual([...once].sort(), items);
  assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
});

test('buildReport contains overview, language, feature and paired comparison rows', () => {
  const results = [
    res({ exercise: 'python/a', pass2: true }),
    res({ exercise: 'python/b', pass2: false }),
    res({ exercise: 'python/c', pass2: true }),
    res({ exercise: 'python/a', profile: 'baseline-rerun', repeat: 101, pass2: true }),
    res({ exercise: 'python/b', profile: 'baseline-rerun', repeat: 101, pass2: false }),
    res({ exercise: 'python/c', profile: 'baseline-rerun', repeat: 101, pass2: false }),
    res({ exercise: 'python/a', profile: 'cand-a', repeat: 101, pass2: true }),
    res({ exercise: 'python/b', profile: 'cand-a', repeat: 101, pass2: true }),
    res({ exercise: 'python/c', profile: 'cand-a', repeat: 101, pass2: false }),
  ];
  const { markdown, csv } = buildReport(results);
  assert.match(markdown, /\| m1 \| baseline \| 3 \| 66\.7% \| 66\.7% \|/);
  assert.match(markdown, /\| m1 \| cand-a \| python \| 3 \|/);
  assert.match(markdown, /\| m1 \| cand-a \| baseline-rerun \| 3 \| 66\.7% \| 33\.3% \| \+33\.3pp \| 1\.000 \| 66\.7% \| 33\.3% \| \+33\.3pp \| 1\.000 \|/);
  assert.doesNotMatch(markdown, /\| m1 \| cand-a \| baseline \|/);
  assert.match(markdown, /\| m1 \| baseline \| tests_failed \| 1 \|/);
  assert.match(csv, /^model,profile,scope,language,n,pass1,pass2,pass1_rate,pass2_rate\n/);
  assert.match(csv, /^m1,cand-a,all,all,3,/m);
});

test('report writes report.md and report.csv into the run directory', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'polyglot-report-'));
  try {
    await writeFile(join(runDir, 'results.jsonl'), `${JSON.stringify(res({ exercise: 'python/a', pass2: true }))}\n`);
    const out = await report({ runDir });
    assert.equal(out.results, 1);
    assert.match(await readFile(join(runDir, 'report.md'), 'utf8'), /# Polyglot benchmark report/);
    assert.match(await readFile(join(runDir, 'report.csv'), 'utf8'), /^model,profile/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('baselinePlan covers all non-excluded exercises with deterministic ids', () => {
  const manifest = {
    exercises: [ex('python/a', 'discovery'), ex('python/b', 'discovery'), ex('go/c', 'holdout'), ex('go/d', 'holdout')],
  };
  const plan = baselinePlan({ models: [{ key: 'm1' }], manifest, excluded: ['go/d'], repeats: 2 });
  assert.equal(plan.length, 6);
  assert.deepEqual(plan[0], {
    id: 'm1__baseline__go__c__r1',
    model: 'm1',
    profile: 'baseline',
    exercise: 'go/c',
    repeat: 1,
    attempts: 2,
  });
  assert.deepEqual(plan, baselinePlan({ models: [{ key: 'm1' }], manifest, excluded: ['go/d'], repeats: 2 }));
});

test('screenPlan picks failed discovery plus a pass sample, for baseline-rerun and candidates only', () => {
  const results = [
    res({ exercise: 'python/a', pass2: false }),
    res({ exercise: 'python/b', pass2: true }),
    res({ exercise: 'python/b', pass2: true, repeat: 2 }),
    res({ exercise: 'python/c', pass2: true }),
    res({ exercise: 'python/d', pass2: true }),
    res({ exercise: 'python/d', pass2: false, repeat: 2 }),
    res({ exercise: 'python/e', pass2: true }),
    res({ exercise: 'go/h', split: 'holdout', pass2: false }),
  ];
  const seed = 2026;
  const selection = screenSelection({ results, model: 'm1', passSample: 2, seed });
  assert.deepEqual(selection.failed, ['python/a', 'python/d']);
  assert.equal(selection.passSample.length, 2);
  for (const id of selection.passSample) assert.ok(['python/b', 'python/c', 'python/e'].includes(id));

  const plan = screenPlan({ results, model: 'm1', candidates: ['cand-a'], passSample: 2, seed });
  assert.equal(plan.length, 2 * (2 + 2));
  const exercises = new Set(plan.map((entry) => entry.exercise));
  assert.ok(exercises.has('python/a') && exercises.has('python/d'));
  assert.ok(!exercises.has('go/h'));
  assert.deepEqual([...new Set(plan.map((entry) => entry.profile))].sort(), ['baseline-rerun', 'cand-a']);
  assert.ok(plan.every((entry) => entry.repeat === 101));
  const baselineIds = new Set(baselinePlan({ models: ['m1'], manifest: { exercises: [ex('python/a', 'discovery')] } }).map((e) => e.id));
  assert.ok(plan.every((entry) => !baselineIds.has(entry.id)));
  assert.deepEqual(plan, screenPlan({ results, model: 'm1', candidates: ['cand-a'], passSample: 2, seed }));
});

test('confirmPlan uses only holdout exercises for the candidate', () => {
  const manifest = {
    exercises: [ex('python/a', 'discovery'), ex('python/b', 'holdout'), ex('go/c', 'holdout')],
  };
  const plan = confirmPlan({ model: 'm1', candidate: 'cand-a', manifest, repeats: 2 });
  assert.equal(plan.length, 4);
  assert.ok(plan.every((entry) => entry.profile === 'cand-a' && entry.exercise !== 'python/a'));
  assert.ok(plan.every((entry) => ['python/b', 'go/c'].includes(entry.exercise)));
});

function holdoutResults(spec) {
  const results = [];
  for (const [exercise, baseline, candidate] of spec) {
    results.push(res({ exercise, split: 'holdout', profile: 'baseline', pass2: baseline }));
    results.push(res({ exercise, split: 'holdout', profile: 'cand-a', pass2: candidate }));
  }
  return results;
}

test('decide keeps when delta > 0.05 and no language drops by more than 0.10', () => {
  const spec = Array.from({ length: 10 }, (_, i) => [`python/h${i}`, i < 5, i < 8]);
  const verdict = decide({ results: holdoutResults(spec), model: 'm1', candidate: 'cand-a' });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.n, 10);
  assert.ok(Math.abs(verdict.delta - 0.3) < 1e-12);
  assert.equal(verdict.baselineRate, 0.5);
  assert.equal(verdict.candidateRate, 0.8);
  assert.equal(verdict.perLanguage.python.veto, false);
});

test('decide with metric pass1 compares first-attempt passes, not pass@2', () => {
  // pass@2 identical (all pass); pass@1 improves from 5/10 to 8/10.
  const results = [];
  for (let i = 0; i < 10; i += 1) {
    results.push(res({ exercise: `python/m${i}`, split: 'holdout', profile: 'baseline', pass2: true, pass1: i < 5 }));
    results.push(res({ exercise: `python/m${i}`, split: 'holdout', profile: 'cand-a', pass2: true, pass1: i < 8 }));
  }
  assert.equal(decide({ results, model: 'm1', candidate: 'cand-a' }).keep, false);
  const verdict = decide({ results, model: 'm1', candidate: 'cand-a', metric: 'pass1' });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.metric, 'pass1');
  assert.ok(Math.abs(verdict.delta - 0.3) < 1e-12);
  assert.throws(() => decide({ results, model: 'm1', candidate: 'cand-a', metric: 'pass3' }));
});

test('screenSelection with metric pass1 selects first-attempt failures', () => {
  const results = [
    res({ exercise: 'python/a', pass2: true, pass1: false }),
    res({ exercise: 'python/b', pass2: true, pass1: true }),
  ];
  assert.deepEqual(screenSelection({ results, model: 'm1', passSample: 0, seed: 1 }).failed, []);
  assert.deepEqual(screenSelection({ results, model: 'm1', passSample: 0, seed: 1, metric: 'pass1' }).failed, ['python/a']);
});

test('decide rejects when the delta is not above 0.05 (boundary is exclusive)', () => {
  const exact = Array.from({ length: 20 }, (_, i) => [`python/p${i}`, i < 10, i < 11]);
  const atBoundary = decide({ results: holdoutResults(exact), model: 'm1', candidate: 'cand-a' });
  assert.equal(atBoundary.keep, false);
  assert.deepEqual(atBoundary.reasons, ['delta_not_above_0.05']);

  const flat = Array.from({ length: 10 }, (_, i) => [`python/f${i}`, i < 5, i < 5]);
  assert.equal(decide({ results: holdoutResults(flat), model: 'm1', candidate: 'cand-a' }).keep, false);
});

test('decide vetoes when a language drops by more than 0.10 even if the overall delta passes', () => {
  const spec = [
    ...Array.from({ length: 5 }, (_, i) => [`python/p${i}`, true, i < 2]),
    ...Array.from({ length: 5 }, (_, i) => [`go/g${i}`, false, true]),
  ];
  const verdict = decide({ results: holdoutResults(spec), model: 'm1', candidate: 'cand-a' });
  assert.equal(verdict.keep, false);
  assert.ok(verdict.reasons.includes('language_drop:python'));
  assert.equal(verdict.perLanguage.python.veto, true);
  assert.equal(verdict.perLanguage.go.veto, false);
  assert.ok(Math.abs(verdict.delta - 0.2) < 1e-12);
});

test('decide allows a language drop of exactly 0.10', () => {
  const spec = [
    ...Array.from({ length: 10 }, (_, i) => [`python/p${i}`, i < 5, i < 4]),
    ...Array.from({ length: 10 }, (_, i) => [`go/g${i}`, false, true]),
  ];
  const verdict = decide({ results: holdoutResults(spec), model: 'm1', candidate: 'cand-a' });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.perLanguage.python.veto, false);
});

test('decide ignores discovery results and rejects when no holdout pairs exist', () => {
  const discovery = [res({ exercise: 'python/a', profile: 'baseline', pass2: false }), res({ exercise: 'python/a', profile: 'cand-a', pass2: true })];
  const verdict = decide({ results: discovery, model: 'm1', candidate: 'cand-a' });
  assert.equal(verdict.keep, false);
  assert.deepEqual(verdict.reasons, ['no_paired_holdout_results']);
  assert.equal(verdict.n, 0);
});

test('lineDiff shows changed lines with context and no-op for identical files', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nb\nc'), '');
  const diff = lineDiff('def f():\n    pass', 'def f():\n    return 1');
  assert.match(diff, /^ def f\(\):/m);
  assert.match(diff, /^-    pass$/m);
  assert.match(diff, /^\+    return 1$/m);
});

async function exportFixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'polyglot-export-'));
  const runDir = join(dataRoot, 'runs', 'r1');
  const checkoutDir = join(dataRoot, 'polyglot-benchmark');
  const manifest = {
    exercises: [
      ex('python/disc', 'discovery'),
      ex('python/hold', 'holdout', { instructions: 'HOLDOUT_INSTRUCTIONS_MARKER' }),
    ],
  };
  for (const exercise of manifest.exercises) {
    await mkdir(join(checkoutDir, exercise.dir, '.meta'), { recursive: true });
    await writeFile(join(checkoutDir, exercise.dir, exercise.solutionFiles[0]), 'def f():\n    pass\n');
    await writeFile(join(checkoutDir, exercise.dir, '.meta', 'example.py'), 'REFERENCE_SOLUTION_MARKER\n');
  }
  const discFail = res({ exercise: 'python/disc', pass2: false });
  discFail.attempts = [attempt(1, { outputTail: 'AssertionError' }), attempt(2, { outputTail: 'SyntaxError: last' })];
  const holdFail = res({ exercise: 'python/hold', split: 'holdout', pass2: false });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'results.jsonl'), [discFail, holdFail].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const caseDir = join(runDir, 'cases', discFail.id, 'attempt-2', 'solution');
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'disc.py'), 'def f():\n    return 1\n');
  await mkdir(join(runDir, 'triage'), { recursive: true });
  await writeFile(join(runDir, 'triage', `${discFail.id}.json`), JSON.stringify({
    answers: { signature: { type: 'noul', noul: 0.9 }, env: { type: 'noul', noul: 0.1 } },
    modelVersion: 'jev-1.13.0',
  }));
  return { dataRoot, runDir, checkoutDir, manifest, discFail };
}

test('exportFailures includes discovery failures only and never .meta or holdout content', async () => {
  const fixture = await exportFixture();
  try {
    const out = join(fixture.dataRoot, 'export');
    const result = await exportFailures({
      runDir: fixture.runDir,
      model: 'm1',
      profile: 'baseline',
      out,
      manifest: fixture.manifest,
      checkoutDir: fixture.checkoutDir,
    });
    assert.equal(result.count, 1);
    const markdown = await readFile(result.markdownPath, 'utf8');
    const json = JSON.parse(await readFile(result.jsonPath, 'utf8'));
    assert.match(markdown, /## m1__baseline__python__disc__r1/);
    assert.doesNotMatch(markdown, /holdout|HOLDOUT_INSTRUCTIONS_MARKER|python__hold/);
    assert.doesNotMatch(markdown, /REFERENCE_SOLUTION_MARKER/);
    assert.match(markdown, /^\+    return 1$/m);
    assert.match(markdown, /^-    pass$/m);
    assert.match(markdown, /SyntaxError: last/);
    assert.match(markdown, /jev labels: signature/);
    assert.deepEqual(json.items.map((item) => item.exercise), ['python/disc']);
    assert.deepEqual(json.items[0].triage.signature, { noul: 0.9, label: true });
    assert.equal(json.items[0].triage.env.label, false);
    assert.ok(json.items[0].features.includes('compile_error'));
  } finally {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('exportFailures refuses holdout as a split', async () => {
  await assert.rejects(exportFailures({ runDir: '/nonexistent/runs/r1', model: 'm1', split: 'holdout' }), /discovery exercises only/);
});

test('triageLabel uses the 0.7 threshold', () => {
  assert.equal(triageLabel({ noul: 0.7 }), true);
  assert.equal(triageLabel({ noul: 0.69 }), false);
  assert.equal(triageLabel({ unavailable: true }), false);
  assert.equal(Object.keys(TRIAGE_QUESTIONS).length, 5);
});

async function triageFixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'polyglot-triage-'));
  const runDir = join(dataRoot, 'runs', 'r1');
  const manifest = { exercises: [ex('python/a', 'discovery', { instructions: 'implement a' }), ex('go/b', 'discovery', { instructions: 'implement b' })] };
  const first = res({ exercise: 'python/a', pass2: false });
  first.attempts = [attempt(1, { outputTail: 'NameError: f' })];
  const second = res({ exercise: 'go/b', pass2: false });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'results.jsonl'), [first, second].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const caseDir = join(runDir, 'cases', first.id, 'attempt-1', 'solution');
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'a.py'), 'def f():\n    pass\n');
  return { dataRoot, runDir, manifest, first, second };
}

function jevResponse(noul) {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.keys(TRIAGE_QUESTIONS).map((id) => [id, { type: 'noul', noul }])),
    usage: {},
  };
}

test('triage batches all five questions into one POST and stores answers', async () => {
  const fixture = await triageFixture();
  try {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => jevResponse(0.8) };
    };
    const summary = await triage({
      runDir: fixture.runDir,
      model: 'm1',
      profile: 'baseline',
      manifest: fixture.manifest,
      fetch: fakeFetch,
      env: { JEV_API_KEY: 'k-test' },
    });
    assert.deepEqual(summary, { failures: 2, called: 2, unavailable: 0, skipped: 0 });
    assert.equal(calls.length, 2);
    const call = calls[0];
    assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer k-test');
    assert.equal(call.body.model, 'jev-latest');
    assert.deepEqual(Object.keys(call.body.questions).sort(), Object.keys(TRIAGE_QUESTIONS).sort());
    for (const question of Object.values(call.body.questions)) {
      assert.equal(question.type, 'noul');
      assert.ok(question.criteria && question.criteria.true && question.criteria.false);
    }
    for (const value of Object.values(call.body.state)) assert.ok(value.length <= 4000);
    assert.match(call.body.state.solutionExcerpt, /def f\(\)/);

    const stored = JSON.parse(await readFile(join(fixture.runDir, 'triage', `${fixture.first.id}.json`), 'utf8'));
    assert.equal(stored.modelVersion, 'jev-1.13.0');
    assert.equal(stored.answers.signature.noul, 0.8);
  } finally {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('triage records a 400 as unavailable and continues', async () => {
  const fixture = await triageFixture();
  try {
    const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'criteria required' });
    const summary = await triage({
      runDir: fixture.runDir,
      model: 'm1',
      profile: 'baseline',
      manifest: fixture.manifest,
      fetch: fakeFetch,
      env: { JEV_API_KEY: 'k-test' },
    });
    assert.equal(summary.unavailable, 2);
    const stored = JSON.parse(await readFile(join(fixture.runDir, 'triage', `${fixture.first.id}.json`), 'utf8'));
    assert.equal(stored.unavailable, true);
    assert.match(stored.reason, /^HTTP 400: criteria required/);
  } finally {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('triage without JEV_API_KEY writes unavailable and never calls fetch', async () => {
  const fixture = await triageFixture();
  try {
    let called = false;
    const summary = await triage({
      runDir: fixture.runDir,
      model: 'm1',
      profile: 'baseline',
      manifest: fixture.manifest,
      fetch: async () => {
        called = true;
        throw new Error('should not be called');
      },
      env: {},
    });
    assert.equal(called, false);
    assert.equal(summary.unavailable, 2);
    const stored = JSON.parse(await readFile(join(fixture.runDir, 'triage', `${fixture.second.id}.json`), 'utf8'));
    assert.deepEqual(stored, { unavailable: true, reason: 'missing JEV_API_KEY' });
  } finally {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});

test('triage records network errors as unavailable', async () => {
  const fixture = await triageFixture();
  try {
    const summary = await triage({
      runDir: fixture.runDir,
      model: 'm1',
      profile: 'baseline',
      manifest: fixture.manifest,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      env: { JEV_API_KEY: 'k-test' },
    });
    assert.equal(summary.unavailable, 2);
    const stored = JSON.parse(await readFile(join(fixture.runDir, 'triage', `${fixture.first.id}.json`), 'utf8'));
    assert.equal(stored.reason, 'network: ECONNREFUSED');
  } finally {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  }
});
