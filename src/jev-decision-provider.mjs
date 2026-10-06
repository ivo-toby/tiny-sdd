import { performance } from 'node:perf_hooks';

import { buildJudgeRequest } from './jev.mjs';
import { assertArtifactPathAllowed } from './change-format.mjs';
import {
  validateDecisionQuestion,
} from './decision-providers.mjs';
import { DECISION_UNKNOWN } from './decision-dataset.mjs';
import {
  digestJson,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';

export const JEV_DECISION_PROVIDER_SCHEMA_VERSION = 1;
export const JEV_DECISION_MAX_REQUEST_BYTES = 512 * 1024;
export const JEV_DECISION_MAX_RESPONSE_BYTES = 512 * 1024;
export const JEV_DECISION_MAX_CRITERIA = 256;
export const JEV_DECISION_MAX_ARTIFACTS = 4096;
export const JEV_DECISION_MAX_ARTIFACT_BYTES = 512 * 1024;
export const JEV_DECISION_MAX_TOTAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const JEV_DECISION_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const JEV_DECISION_UNKNOWN = DECISION_UNKNOWN;

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const TYPE = /^[a-z][a-z0-9._:-]{0,63}$/u;
const MAX_TEXT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function providerError(code, message, details = undefined) {
  const error = tinyError(code, message, details);
  Object.defineProperty(error, PROVIDER_ERROR, { value: true });
  return error;
}

const PROVIDER_ERROR = Symbol('tinySddJevProviderError');

function plainObject(value, label, code = 'JEV_DECISION_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw providerError(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw providerError(code, `${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label, code = 'JEV_DECISION_INVALID') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw providerError(code, `${label} contains an unsupported key`);
  }
}

function text(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw providerError('JEV_DECISION_INVALID', `${label} must be bounded text`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw providerError('JEV_DECISION_INVALID', `${label} must be a bounded identifier`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw providerError('JEV_DECISION_INVALID', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function criterionType(value, label) {
  if (typeof value !== 'string' || !TYPE.test(value)) throw providerError('JEV_DECISION_INVALID', `${label} must be a bounded criterion type`);
  return value;
}

function path(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw providerError('JEV_DECISION_INVALID', `${label} must be a project-relative path`);
  }
  try {
    assertArtifactPathAllowed(value, label);
  } catch (error) {
    throw providerError(error?.code ?? 'JEV_DECISION_INVALID', error?.message ?? `${label} is not allowed`);
  }
  return value;
}

function boundedJson(value, label, depth = 0, seen = new Set()) {
  if (depth > 8) throw providerError('JEV_DECISION_INVALID', `${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') text(value, label, 128 * 1024);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw providerError('JEV_DECISION_INVALID', `${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') throw providerError('JEV_DECISION_INVALID', `${label} contains an unsupported value`);
  if (seen.has(value)) throw providerError('JEV_DECISION_INVALID', `${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw providerError('JEV_DECISION_INVALID', `${label} contains too many entries`);
    const result = value.map((item, index) => boundedJson(item, `${label}[${index}]`, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const entries = Object.entries(value);
  if (entries.length > 256) throw providerError('JEV_DECISION_INVALID', `${label} contains too many keys`);
  const result = {};
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw providerError('JEV_DECISION_INVALID', `${label} contains a reserved key`);
    Object.defineProperty(result, key, { value: boundedJson(item, `${label}.${key}`, depth + 1, seen), enumerable: true, configurable: true, writable: true });
  }
  seen.delete(value);
  return result;
}

function uniqueStrings(value, label, normalizer) {
  if (!Array.isArray(value) || value.length === 0) throw providerError('JEV_DECISION_INVALID', `${label} must be a nonempty array`);
  const result = value.map((item, index) => normalizer(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw providerError('JEV_DECISION_INVALID', `${label} contains duplicates`);
  return result;
}

function criterion(value, index) {
  const label = `criterion ${index + 1}`;
  const item = plainObject(value, label);
  exactKeys(item, ['id', 'type', 'question', 'requirementIds', 'interfaces', 'testPaths'], label);
  return {
    id: identifier(item.id, `${label}.id`),
    type: criterionType(item.type, `${label}.type`),
    question: text(item.question, `${label}.question`),
    requirementIds: uniqueStrings(item.requirementIds, `${label}.requirementIds`, identifier),
    interfaces: uniqueStrings(item.interfaces, `${label}.interfaces`, path),
    testPaths: uniqueStrings(item.testPaths, `${label}.testPaths`, path),
  };
}

export function validateSliceTestCriterion(value, index = 0) {
  return criterion(value, index);
}

export function validateSliceTestCriteria(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > JEV_DECISION_MAX_CRITERIA) {
    throw providerError('JEV_DECISION_INVALID', `criteria must contain between 1 and ${JEV_DECISION_MAX_CRITERIA} items`);
  }
  const result = value.map((item, index) => criterion(item, index));
  if (new Set(result.map((item) => item.id)).size !== result.length) throw providerError('JEV_DECISION_INVALID', 'criteria contains duplicate ids');
  return result;
}

function normalizeCheck(value, index) {
  const item = plainObject(value, `checks[${index}]`);
  exactKeys(item, ['name', 'result'], `checks[${index}]`);
  const name = text(item.name, `checks[${index}].name`, 4096);
  if (!['pass', 'fail'].includes(item.result)) throw providerError('JEV_DECISION_INVALID', `checks[${index}].result must be pass or fail`);
  return { name, result: item.result };
}

function artifact(value, index) {
  const label = `artifact ${index + 1}`;
  const item = plainObject(value, label);
  exactKeys(item, ['role', 'path', 'bytes', 'sha256', 'contentBase64'], label);
  const role = criterionType(item.role, `${label}.role`);
  const artifactPath = path(item.path, `${label}.path`);
  digest(item.sha256, `${label}.sha256`);
  if (typeof item.contentBase64 !== 'string' || item.contentBase64.length > Math.ceil(JEV_DECISION_MAX_ARTIFACT_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.contentBase64)) {
    throw providerError('JEV_DECISION_INVALID', `${label}.contentBase64 is invalid or too large`);
  }
  const bytes = Buffer.from(item.contentBase64, 'base64');
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > JEV_DECISION_MAX_ARTIFACT_BYTES || item.bytes !== bytes.byteLength) {
    throw providerError('JEV_DECISION_INVALID', `${label}.bytes does not match the bounded content`);
  }
  if (sha256(bytes) !== item.sha256) throw providerError('JEV_DECISION_INVALID', `${label}.sha256 does not match content`);
  return { role, path: artifactPath, bytes: item.bytes, sha256: item.sha256, contentBase64: item.contentBase64 };
}

export function validateSliceTestArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > JEV_DECISION_MAX_ARTIFACTS) {
    throw providerError('JEV_DECISION_INVALID', `artifacts must contain between 1 and ${JEV_DECISION_MAX_ARTIFACTS} items`);
  }
  const result = value.map(artifact);
  const paths = new Set();
  let bytes = 0;
  for (const item of result) {
    if (paths.has(item.path)) throw providerError('JEV_DECISION_INVALID', `artifacts contains duplicate path: ${item.path}`);
    paths.add(item.path);
    bytes += item.bytes;
    if (bytes > JEV_DECISION_MAX_TOTAL_ARTIFACT_BYTES) throw providerError('JEV_DECISION_INVALID', 'artifacts exceed the total byte limit');
  }
  return result;
}

function normalizeStateInput(value) {
  const input = plainObject(value, 'slice-test assessment');
  exactKeys(input, ['taskId', 'criteria', 'checks', 'requirements', 'interfaces', 'integration', 'artifacts', 'inputSha256', 'lineage'], 'slice-test assessment');
  const taskId = identifier(input.taskId, 'taskId');
  const criteria = validateSliceTestCriteria(input.criteria);
  if (!Array.isArray(input.checks)) throw providerError('JEV_DECISION_INVALID', 'checks must be an array');
  const checks = input.checks.map(normalizeCheck);
  const requirements = boundedJson(input.requirements ?? [], 'requirements');
  const interfaces = boundedJson(input.interfaces ?? [], 'interfaces');
  const integration = boundedJson(input.integration ?? [], 'integration');
  const artifacts = validateSliceTestArtifacts(input.artifacts);
  const inputSha256 = input.inputSha256 === undefined ? undefined : digest(input.inputSha256, 'inputSha256');
  const lineage = input.lineage === undefined ? undefined : boundedJson(input.lineage, 'lineage');
  return { taskId, criteria, checks, requirements, interfaces, integration, artifacts, ...(inputSha256 === undefined ? {} : { inputSha256 }), ...(lineage === undefined ? {} : { lineage }) };
}

function canonicalJevQuestion(item) {
  const { questions } = buildJudgeRequest({
    taskId: 'slice-test-review',
    criteria: [{ id: item.id, text: item.question }],
    checks: [],
  });
  const normalized = validateDecisionQuestion({ schemaVersion: 1, id: item.id, ...questions[item.id] });
  return {
    type: normalized.type,
    instruction: normalized.instruction,
    criteria: normalized.criteria,
  };
}

export function buildSliceTestJudgeRequest(value) {
  const input = normalizeStateInput(value);
  const base = buildJudgeRequest({
    taskId: input.taskId,
    criteria: input.criteria.map((item) => ({ id: item.id, text: item.question })),
    checks: input.checks,
  });
  const questions = Object.fromEntries(input.criteria.map((item) => [item.id, canonicalJevQuestion(item)]));
  const state = {
    ...base.state,
    criteria: input.criteria.map((item) => ({ ...item, text: item.question })),
    requirements: input.requirements,
    interfaces: input.interfaces,
    integration: input.integration,
    artifacts: input.artifacts,
    ...(input.inputSha256 === undefined ? {} : { inputSha256: input.inputSha256 }),
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
  };
  const body = { state, questions };
  const requestSha256 = sha256(stableStringify(body));
  const inputSha256 = input.inputSha256 ?? digestJson({
    taskId: input.taskId,
    criteria: input.criteria,
    checks: input.checks,
    requirements: input.requirements,
    interfaces: input.interfaces,
    integration: input.integration,
    artifacts: input.artifacts,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
  });
  return { state, questions, body, requestSha256, inputSha256, criteria: input.criteria, artifacts: input.artifacts };
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw providerError('JEV_DECISION_CONFIG_INVALID', 'endpoint is required');
  let parsed;
  try { parsed = new URL(value); } catch { throw providerError('JEV_DECISION_CONFIG_INVALID', 'endpoint must be a valid URL'); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw providerError('JEV_DECISION_CONFIG_INVALID', 'endpoint must be an https URL without credentials or fragments');
  }
  return parsed.toString();
}

export function validateJevDecisionProviderConfig(value) {
  const config = plainObject(value, 'Jev decision provider config', 'JEV_DECISION_CONFIG_INVALID');
  exactKeys(config, ['id', 'endpoint', 'model', 'configSha256', 'timeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'fetch'], 'Jev decision provider config', 'JEV_DECISION_CONFIG_INVALID');
  const id = identifier(config.id, 'provider id');
  const endpoint = normalizeEndpoint(config.endpoint);
  const model = text(config.model, 'model', 256);
  const configSha256 = digest(config.configSha256, 'configSha256');
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > JEV_DECISION_MAX_TIMEOUT_MS) throw providerError('JEV_DECISION_CONFIG_INVALID', 'timeoutMs must be a bounded positive integer');
  const maxRequestBytes = config.maxRequestBytes === undefined ? JEV_DECISION_MAX_REQUEST_BYTES : config.maxRequestBytes;
  const maxResponseBytes = config.maxResponseBytes === undefined ? JEV_DECISION_MAX_RESPONSE_BYTES : config.maxResponseBytes;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > JEV_DECISION_MAX_REQUEST_BYTES) throw providerError('JEV_DECISION_CONFIG_INVALID', 'maxRequestBytes is invalid');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > JEV_DECISION_MAX_RESPONSE_BYTES) throw providerError('JEV_DECISION_CONFIG_INVALID', 'maxResponseBytes is invalid');
  if (config.fetch !== undefined && typeof config.fetch !== 'function') throw providerError('JEV_DECISION_CONFIG_INVALID', 'fetch must be a function when supplied');
  return { id, endpoint, model, configSha256, timeoutMs, maxRequestBytes, maxResponseBytes, ...(config.fetch === undefined ? {} : { fetch: config.fetch }) };
}

function cancelResponseBody(response) {
  const body = response?.body;
  try {
    if (body && typeof body.cancel === 'function') {
      const result = body.cancel();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } else if (body && typeof body.destroy === 'function') {
      body.destroy();
    }
  } catch {
    // A provider-owned response can fail while being cancelled. The original
    // bounded transport error is the only error exposed to the caller.
  }
}

async function responseText(response, maxBytes, deadline) {
  let readPromise;
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    readPromise = (async () => {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw providerError('JEV_DECISION_RESPONSE_TOO_LARGE', 'Jev response exceeds the bounded byte limit');
        chunks.push(value);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    })();
  } else {
    if (typeof response?.text !== 'function') throw providerError('JEV_DECISION_BAD_RESPONSE', 'Jev response body is unavailable');
    readPromise = Promise.resolve().then(() => response.text()).then((value) => {
      if (typeof value !== 'string') throw providerError('JEV_DECISION_BAD_RESPONSE', 'Jev response body is not text');
      if (Buffer.byteLength(value) > maxBytes) throw providerError('JEV_DECISION_RESPONSE_TOO_LARGE', 'Jev response exceeds the bounded byte limit');
      return value;
    });
  }
  try {
    return await Promise.race([readPromise, deadline.promise]);
  } catch (error) {
    cancelResponseBody(response);
    readPromise.catch(() => {});
    throw error;
  }
}

function usage(value) {
  const result = {
    inputTokens: DECISION_UNKNOWN,
    outputTokens: DECISION_UNKNOWN,
    totalTokens: DECISION_UNKNOWN,
  };
  if (value === undefined) return result;
  const item = plainObject(value, 'Jev usage', 'JEV_DECISION_BAD_RESPONSE');
  exactKeys(item, ['inputTokens', 'outputTokens', 'totalTokens'], 'Jev usage', 'JEV_DECISION_BAD_RESPONSE');
  for (const key of Object.keys(result)) {
    if (item[key] === undefined || item[key] === DECISION_UNKNOWN) continue;
    if (!Number.isSafeInteger(item[key]) || item[key] < 0) throw providerError('JEV_DECISION_BAD_RESPONSE', `Jev usage.${key} is invalid`);
    result[key] = item[key];
  }
  return result;
}

export function validateJevDecisionResponse(value, criteria) {
  const normalizedCriteria = validateSliceTestCriteria(criteria);
  const response = plainObject(value, 'Jev response', 'JEV_DECISION_BAD_RESPONSE');
  exactKeys(response, ['answers', 'modelVersion', 'usage'], 'Jev response', 'JEV_DECISION_BAD_RESPONSE');
  const answers = plainObject(response.answers, 'Jev response.answers', 'JEV_DECISION_BAD_RESPONSE');
  const expected = new Set(normalizedCriteria.map((item) => item.id));
  const answerKeys = Object.keys(answers);
  if (answerKeys.length !== expected.size || answerKeys.some((key) => !expected.has(key))) throw providerError('JEV_DECISION_BAD_RESPONSE', 'Jev response answers do not match the requested criteria');
  const observations = normalizedCriteria.map((item) => {
    const answer = plainObject(answers[item.id], `Jev response.answers.${item.id}`, 'JEV_DECISION_BAD_RESPONSE');
    exactKeys(answer, ['noul'], `Jev response.answers.${item.id}`, 'JEV_DECISION_BAD_RESPONSE');
    if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw providerError('JEV_DECISION_BAD_RESPONSE', `Jev response.answers.${item.id}.noul is invalid`);
    return {
      criterionId: item.id,
      criterionType: item.type,
      question: canonicalJevQuestion(item).instruction,
      probability: answer.noul,
      judgment: DECISION_UNKNOWN,
    };
  });
  const modelVersion = response.modelVersion === undefined || response.modelVersion === null ? DECISION_UNKNOWN : text(response.modelVersion, 'Jev response.modelVersion', 256);
  return { observations, modelVersion, usage: usage(response.usage) };
}

async function requestBody({ config, credential, request, signal }) {
  if (typeof credential !== 'string' || credential.length === 0 || credential.includes('\0')) throw providerError('JEV_DECISION_CONFIG_INVALID', 'credential is required at the transport boundary');
  const body = JSON.stringify({ model: config.model, state: request.state, questions: request.questions });
  const bytes = Buffer.byteLength(body);
  if (bytes > config.maxRequestBytes) throw providerError('JEV_DECISION_REQUEST_TOO_LARGE', 'Jev request exceeds the bounded byte limit', { bytes, limit: config.maxRequestBytes });
  return {
    body,
    bytes,
    requestSha256: sha256(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    signal,
  };
}

export async function assessSliceTestWithJev({ config, credential, assessment } = {}) {
  const normalizedConfig = validateJevDecisionProviderConfig(config);
  const request = buildSliceTestJudgeRequest(assessment);
  const requestForTransport = await requestBody({ config: normalizedConfig, credential, request, signal: undefined });
  const fetchImpl = normalizedConfig.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw providerError('JEV_DECISION_UNAVAILABLE', 'Jev transport is unavailable');
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = {
    promise: new Promise((_, reject) => { rejectDeadline = reject; }),
  };
  let deadlineExpired = false;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
    rejectDeadline(providerError('JEV_DECISION_UNAVAILABLE', 'Jev provider request exceeded its deadline'));
  }, normalizedConfig.timeoutMs);
  const started = performance.now();
  let response;
  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(normalizedConfig.endpoint, {
      method: 'POST',
      headers: requestForTransport.headers,
      body: requestForTransport.body,
      signal: controller.signal,
      redirect: 'error',
    })).then((result) => {
      response = result;
      if (deadlineExpired) cancelResponseBody(result);
      return result;
    });
    try {
      response = await Promise.race([fetchPromise, deadline.promise]);
    } catch (error) {
      fetchPromise.catch(() => {});
      cancelResponseBody(response);
      throw error;
    }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) {
      throw providerError('JEV_DECISION_UNAVAILABLE', 'Jev provider returned an unavailable response', { status: Number.isInteger(response?.status) ? response.status : 0 });
    }
    const raw = await responseText(response, normalizedConfig.maxResponseBytes, deadline);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw providerError('JEV_DECISION_BAD_RESPONSE', 'Jev response is not valid JSON'); }
    const validated = validateJevDecisionResponse(payload, request.criteria);
    return {
      schemaVersion: JEV_DECISION_PROVIDER_SCHEMA_VERSION,
      provider: {
        id: normalizedConfig.id,
        configSha256: normalizedConfig.configSha256,
        model: { id: normalizedConfig.model, version: validated.modelVersion },
        availability: { status: 'available', available: true },
      },
      request: { sha256: requestForTransport.requestSha256, bytes: requestForTransport.bytes },
      questionSha256: digestJson(request.questions),
      inputSha256: request.inputSha256,
      observations: validated.observations,
      measurements: {
        latencyMs: Math.max(0, performance.now() - started),
        ...validated.usage,
      },
    };
  } catch (error) {
    if (error?.[PROVIDER_ERROR] === true) throw error;
    throw providerError('JEV_DECISION_UNAVAILABLE', 'Jev provider request failed');
  } finally {
    clearTimeout(timer);
  }
}

export function createJevDecisionProvider(config) {
  const normalized = validateJevDecisionProviderConfig(config);
  return Object.freeze({
    id: normalized.id,
    configSha256: normalized.configSha256,
    model: { id: normalized.model, version: DECISION_UNKNOWN },
    availability: { status: 'available', available: true },
    assess: (options) => assessSliceTestWithJev({ ...options, config: normalized }),
  });
}

export function buildJevQuestion(criterionValue) {
  const criterionValueNormalized = criterion(criterionValue, 0);
  return canonicalJevQuestion(criterionValueNormalized);
}

export function jevProviderConfigDigest(config) {
  const normalized = validateJevDecisionProviderConfig(config);
  return sha256(stableStringify({ id: normalized.id, endpoint: normalized.endpoint, model: normalized.model, configSha256: normalized.configSha256 }));
}
