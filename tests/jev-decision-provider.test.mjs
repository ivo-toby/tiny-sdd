import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  JEV_DECISION_MAX_RESPONSE_BYTES,
  assessSliceTestWithJev,
  buildJevQuestion,
  buildSliceTestJudgeRequest,
  createJevDecisionProvider,
  validateJevDecisionProviderConfig,
  validateJevDecisionResponse,
} from '../src/jev-decision-provider.mjs';
import { decisionQuestionDigest, validateDecisionQuestion } from '../src/decision-providers.mjs';

const digest = (letter) => letter.repeat(64);

function criterion() {
  return {
    id: 'criterion-one',
    type: 'slice-test-adequacy',
    question: 'The writable slice test checks the approved behavior through the declared interface.',
    requirementIds: ['requirement-one'],
    interfaces: ['src/feature.mjs'],
    testPaths: ['tests/feature.test.mjs'],
  };
}

function config(fetch, extra = {}) {
  return {
    id: 'jev-slice',
    endpoint: 'https://jev.example/v1/systemone',
    model: 'strong-judge-v1',
    configSha256: digest('c'),
    fetch,
    ...extra,
  };
}

function assessment(extra = {}) {
  const bytes = Buffer.from('candidate bytes\n');
  return {
    taskId: 'task-one',
    criteria: [criterion()],
    checks: [{ name: 'slice test', result: 'pass' }],
    requirements: [{ id: 'requirement-one', text: 'approved behavior' }],
    interfaces: [{ path: 'src/feature.mjs', sha256: digest('i') }],
    integration: [{ id: 'integration-one', entrypoints: ['src/entry.mjs'], wiringSlice: 'slice-one', testPaths: ['tests/feature.test.mjs'], checkIds: ['feature-check'] }],
    artifacts: [{ role: 'candidate', path: 'src/feature.mjs', bytes: bytes.byteLength, sha256: digest('x').slice(0, 64), contentBase64: bytes.toString('base64') }].map((item) => ({ ...item, sha256: requireDigest(bytes) })),
    inputSha256: digest('a'),
    ...extra,
  };
}

function requireDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return { status, text: async () => text };
}

test('optional question instruction and criteria preserve the legacy digest when absent', () => {
  const legacy = { schemaVersion: 1, id: 'q', type: 'noul' };
  const normalized = validateDecisionQuestion(legacy);
  assert.deepEqual(normalized, legacy);
  assert.equal(decisionQuestionDigest(legacy), decisionQuestionDigest(normalized));
  const question = buildJevQuestion(criterion());
  assert.equal(question.instruction, criterion().question);
  assert.equal(question.criteria.true.length > 0, true);
});

test('builds the known Jev wire shape while retaining typed criteria and exact artifact bytes', () => {
  const request = buildSliceTestJudgeRequest(assessment());
  assert.equal(request.body.model, undefined);
  assert.equal(request.state.task.id, 'task-one');
  assert.equal(request.state.criteria[0].type, 'slice-test-adequacy');
  assert.equal(request.state.criteria[0].question, criterion().question);
  assert.equal(request.questions['criterion-one'].type, 'noul');
  assert.equal(request.state.artifacts[0].contentBase64, Buffer.from('candidate bytes\n').toString('base64'));
  assert.equal(typeof request.requestSha256, 'string');
});

test('uses only explicit provider identity and injected fetch, retaining raw probabilities and UNKNOWN usage', async () => {
  let call;
  const fetch = async (url, init) => {
    call = { url, init };
    return response({ modelVersion: 'model-build-7', answers: { 'criterion-one': { noul: 0.73 } } });
  };
  const result = await assessSliceTestWithJev({ config: config(fetch), credential: 'secret-at-boundary', assessment: assessment() });
  assert.equal(call.url, 'https://jev.example/v1/systemone');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.authorization, 'Bearer secret-at-boundary');
  const request = JSON.parse(call.init.body);
  assert.equal(request.model, 'strong-judge-v1');
  assert.equal(request.questions['criterion-one'].type, 'noul');
  assert.equal(result.observations[0].probability, 0.73);
  assert.equal(result.observations[0].judgment, 'UNKNOWN');
  assert.equal(result.provider.model.version, 'model-build-7');
  assert.equal(result.measurements.inputTokens, 'UNKNOWN');
  assert.equal(result.measurements.outputTokens, 'UNKNOWN');
  assert.equal(result.measurements.totalTokens, 'UNKNOWN');
  assert.equal(result.request.bytes, Buffer.byteLength(call.init.body));
});

test('rejects missing credentials and malformed provider output without fallback', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return response({ answers: { 'criterion-one': { noul: 0.4 } } }); };
  await assert.rejects(assessSliceTestWithJev({ config: config(fetch), assessment: assessment() }), { code: 'JEV_DECISION_CONFIG_INVALID' });
  const malformed = async () => { calls += 1; return response({ answers: {} }); };
  await assert.rejects(assessSliceTestWithJev({ config: config(malformed), credential: 'secret', assessment: assessment() }), { code: 'JEV_DECISION_BAD_RESPONSE' });
  assert.equal(calls, 1);
});

test('bounds actual response bytes and request deadline', async () => {
  const large = 'x'.repeat(JEV_DECISION_MAX_RESPONSE_BYTES + 1);
  await assert.rejects(assessSliceTestWithJev({ config: config(async () => ({ status: 200, text: async () => large })), credential: 'secret', assessment: assessment() }), { code: 'JEV_DECISION_RESPONSE_TOO_LARGE' });
  const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(assessSliceTestWithJev({ config: config(hanging, { timeoutMs: 1 }), credential: 'secret', assessment: assessment() }), { code: 'JEV_DECISION_UNAVAILABLE' });
});

test('rejects request artifacts that do not match their exact digest or secret paths', () => {
  const bytes = Buffer.from('x');
  const bad = assessment({ artifacts: [{ role: 'candidate', path: 'src/feature.mjs', bytes: 1, sha256: digest('z'), contentBase64: bytes.toString('base64') }] });
  assert.throws(() => buildSliceTestJudgeRequest(bad), { code: 'JEV_DECISION_INVALID' });
  const secret = assessment({ artifacts: [{ role: 'candidate', path: '.env', bytes: 16, sha256: digest('z'), contentBase64: Buffer.alloc(16).toString('base64') }] });
  assert.throws(() => buildSliceTestJudgeRequest(secret), { code: 'ARTIFACT_CREDENTIAL_PATH' });
});

test('provider factory does not expose credentials or ambient configuration', () => {
  const provider = createJevDecisionProvider(config(async () => response({ answers: { 'criterion-one': { noul: 0.5 } } })));
  assert.equal(provider.id, 'jev-slice');
  assert.equal(Object.hasOwn(provider, 'credential'), false);
  assert.equal(provider.model.version, 'UNKNOWN');
  assert.throws(() => validateJevDecisionProviderConfig({ id: 'jev-slice', endpoint: 'http://jev.example', model: 'm', configSha256: digest('c') }), { code: 'JEV_DECISION_CONFIG_INVALID' });
});

test('response validation retains every typed criterion and refuses missing answers', () => {
  const criteria = [criterion()];
  const parsed = validateJevDecisionResponse({ answers: { 'criterion-one': { noul: 0.1 } } }, criteria);
  assert.deepEqual(parsed.observations, [{ criterionId: 'criterion-one', criterionType: 'slice-test-adequacy', question: criterion().question, probability: 0.1, judgment: 'UNKNOWN' }]);
  assert.equal(parsed.modelVersion, 'UNKNOWN');
  assert.throws(() => validateJevDecisionResponse({ answers: {} }, criteria), { code: 'JEV_DECISION_BAD_RESPONSE' });
});
