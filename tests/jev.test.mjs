import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJudgeRequest,
  extractAcceptanceCriteria,
  extractEvidenceChecks,
  judgeEvidenceSufficiency,
} from '../src/jev.mjs';

const BRIEF = [
  '# Brief',
  '',
  '## Acceptance and checks',
  '',
  '| Situation | Expected result and preserved state | Source | Exact check |',
  '| --- | --- | --- | --- |',
  '| C1 | behavior one is demonstrated | brief | run tests |',
  '| unnumbered | warn-only row | brief | inspect |',
  '| C2 | behavior two is demonstrated | brief | inspect output |',
  '',
  '## Other section',
  '',
  '| C9 | outside the acceptance table | brief | never read |',
].join('\n');

function stubFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = Array.isArray(script) ? (script[calls.length - 1] ?? script[script.length - 1]) : script;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return { status: step.status, json: async () => step.body };
  };
  return { calls, fetchImpl };
}

function withApiKey(fn) {
  const original = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = original;
    });
}

test('extracts only C-prefixed acceptance table rows as verbatim criteria', () => {
  assert.deepEqual(extractAcceptanceCriteria(BRIEF), [
    { id: 'C1', text: 'behavior one is demonstrated | brief | run tests' },
    { id: 'C2', text: 'behavior two is demonstrated | brief | inspect output' },
  ]);
});

test('criteria extraction tolerates missing sections, missing separators, and duplicates', () => {
  assert.deepEqual(extractAcceptanceCriteria('# No table here\n'), []);
  assert.deepEqual(extractAcceptanceCriteria('## Acceptance and checks\n\n| Situation | Expected |\n| --- | --- |\n| no id | something |\n'), []);
  assert.deepEqual(extractAcceptanceCriteria('## Acceptance and checks\n\n| Situation | Expected |\n| C1 | first |\n| C1 | duplicate |\n'), [{ id: 'C1', text: 'first' }]);
});

test('evidence checks parse the ## Checks list and report absence', () => {
  const evidence = [
    '# Evidence',
    '',
    '## Checks',
    '',
    '- run tests: pass',
    '- inspect output: fail',
    '- not a check line',
    '',
    '## Notes',
    '',
    '- outside: pass',
  ].join('\n');
  assert.deepEqual(extractEvidenceChecks(evidence), {
    present: true,
    checks: [
      { name: 'run tests', result: 'pass' },
      { name: 'inspect output', result: 'fail' },
    ],
  });
  assert.deepEqual(extractEvidenceChecks('observed evidence\n'), { present: false, checks: [] });
});

test('judge request stays lean with one positive-phrased Noul per criterion', () => {
  const criteria = [
    { id: 'C1', text: 'behavior one is demonstrated | brief | run tests' },
    { id: 'C2', text: 'behavior two is demonstrated | brief | inspect output' },
  ];
  const checks = [{ name: 'run tests', result: 'pass' }];
  const { state, questions } = buildJudgeRequest({ taskId: 'one', criteria, checks });
  assert.deepEqual(state, {
    task: { id: 'one' },
    criteria,
    evidence: { checks: [{ name: 'run tests', result: 'pass' }] },
  });
  assert.equal(Object.keys(questions).length, 2);
  assert.deepEqual(Object.keys(questions), ['C1', 'C2']);
  assert.equal(questions.C1.type, 'noul');
  assert.equal(questions.C1.instruction, 'Does this evidence demonstrate that: behavior one is demonstrated | brief | run tests?');
  assert.equal(typeof questions.C1.criteria.true, 'string');
  assert.equal(typeof questions.C1.criteria.false, 'string');
});

test('judge client posts the batched request and parses noul answers', () => withApiKey(async () => {
  const { calls, fetchImpl } = stubFetch({
    status: 200,
    body: { modelVersion: 'v9', answers: { C1: { noul: 0.9 }, C2: { noul: 0.2 } } },
  });
  const result = await judgeEvidenceSufficiency({
    taskId: 'one',
    criteria: [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }],
    checks: [{ name: 'run tests', result: 'pass' }],
    endpoint: 'https://judge.example/v1/systemone',
    model: 'jev-test',
    judge: { fetch: fetchImpl, retryDelayMs: 0 },
  });
  assert.deepEqual(result, { answers: { C1: 0.9, C2: 0.2 }, modelVersion: 'v9' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://judge.example/v1/systemone');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'jev-test');
  assert.equal(body.state.task.id, 'one');
  assert.deepEqual(body.state.criteria.map((item) => item.id), ['C1', 'C2']);
  assert.equal(Object.keys(body.questions).length, 2);
  assert.ok(!JSON.stringify(body).includes('source code payload'));
}));

test('judge client retries once on 429 and on 5xx then gives up', async () => {
  const ok = { status: 200, body: { answers: { C1: { noul: 0.9 } } } };
  for (const first of [{ status: 429, body: {} }, { status: 503, body: {} }]) {
    const { calls, fetchImpl } = stubFetch([first, ok]);
    await withApiKey(async () => {
      const result = await judgeEvidenceSufficiency({
        taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
        endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
        judge: { fetch: fetchImpl, retryDelayMs: 0 },
      });
      assert.deepEqual(result.answers, { C1: 0.9 });
    });
    assert.equal(calls.length, 2);
  }
  const down = { status: 500, body: {} };
  const failing = stubFetch([down, down]);
  await assert.rejects(
    withApiKey(() => judgeEvidenceSufficiency({
      taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
      endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
      judge: { fetch: failing.fetchImpl, retryDelayMs: 0 },
    })),
    { code: 'JEV_UNAVAILABLE' },
  );
  assert.equal(failing.calls.length, 2);
});

test('judge client does not retry 4xx errors and reports network failures as unavailable', async () => {
  const unauthorized = stubFetch({ status: 401, body: {} });
  await assert.rejects(
    withApiKey(() => judgeEvidenceSufficiency({
      taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
      endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
      judge: { fetch: unauthorized.fetchImpl, retryDelayMs: 0 },
    })),
    { code: 'JEV_UNAVAILABLE' },
  );
  assert.equal(unauthorized.calls.length, 1);
  const broken = stubFetch([new Error('socket hang up'), new Error('socket hang up')]);
  await assert.rejects(
    withApiKey(() => judgeEvidenceSufficiency({
      taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
      endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
      judge: { fetch: broken.fetchImpl, retryDelayMs: 0 },
    })),
    { code: 'JEV_UNAVAILABLE' },
  );
  assert.equal(broken.calls.length, 2);
});

test('judge client fails as unavailable without an API key and without calling fetch', async () => {
  const original = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const { calls, fetchImpl } = stubFetch({ status: 200, body: { answers: {} } });
  try {
    await assert.rejects(judgeEvidenceSufficiency({
      taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
      endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
      judge: { fetch: fetchImpl, retryDelayMs: 0 },
    }), { code: 'JEV_UNAVAILABLE' });
    assert.equal(calls.length, 0);
  } finally {
    if (original === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = original;
  }
});

test('judge client treats missing or out-of-range noul answers as unavailable', async () => {
  for (const body of [{ answers: {} }, { answers: { C1: { noul: 1.4 } } }, { answers: { C1: null } }]) {
    const { fetchImpl } = stubFetch({ status: 200, body });
    await assert.rejects(
      withApiKey(() => judgeEvidenceSufficiency({
        taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
        endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
        judge: { fetch: fetchImpl, retryDelayMs: 0 },
      })),
      { code: 'JEV_UNAVAILABLE' },
    );
  }
});

test('judge client aborts through the timeout and reports unavailable', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    withApiKey(() => judgeEvidenceSufficiency({
      taskId: 'one', criteria: [{ id: 'C1', text: 'a' }], checks: [],
      endpoint: 'https://judge.example/v1/systemone', model: 'jev-test',
      judge: { fetch: hanging, timeoutMs: 1, retryDelayMs: 0 },
    })),
    { code: 'JEV_UNAVAILABLE' },
  );
});
