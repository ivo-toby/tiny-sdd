import { DEFAULT_TIMEOUT_MS } from './config.mjs';
import { tinyError } from './fs-utils.mjs';

export { DEFAULT_SEMANTIC_GATE_ENDPOINT as DEFAULT_JEV_ENDPOINT, DEFAULT_SEMANTIC_GATE_MODEL as DEFAULT_JEV_MODEL } from './config.mjs';
export const DEFAULT_JEV_RETRY_DELAY_MS = 1000;
export const JEV_UNAVAILABLE = 'JEV_UNAVAILABLE';
export const CRITERION_ID_PATTERN = /^C\d+$/;

const TRUE_CRITERION = 'The evidence contains a concrete check or observation that would fail if this were untrue';
const FALSE_CRITERION = 'The evidence does not address this or only asserts completion';
const CHECK_LINE_PATTERN = /^\s*[-*][ \t]+(.+?)[ \t]*:[ \t]*(pass|fail)[ \t]*$/iu;
const NEXT_HEADING_PATTERN = /^#{1,2}[ \t]/u;

function extractSectionLines(text, heading) {
  const lines = String(text).split(/\r?\n/u);
  const startPattern = new RegExp(`^#{1,2}[ \\t]+${heading}[ \\t]*$`, 'iu');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (NEXT_HEADING_PATTERN.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function tableBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      current.push(line);
    } else {
      if (current.length > 0) blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// Criteria are rows of the brief's "Acceptance and checks" table whose first
// cell carries a stable C<n> id. Rows without ids are warn-only: they are not
// judged, and a table without C<n> rows can confirm but never block.
export function extractAcceptanceCriteria(briefText) {
  const section = extractSectionLines(briefText, 'Acceptance and checks');
  if (section === null) return [];
  const criteria = [];
  const seen = new Set();
  for (const block of tableBlocks(section)) {
    const start = block.length >= 2 && isSeparatorRow(block[1]) ? 2 : 0;
    for (const line of block.slice(start)) {
      const cells = splitTableRow(line);
      if (cells.length < 2) continue;
      const id = cells[0];
      if (!CRITERION_ID_PATTERN.test(id) || seen.has(id)) continue;
      const text = cells.slice(1).join(' | ');
      if (text.trim().length === 0) continue;
      seen.add(id);
      criteria.push({ id, text: text.trim() });
    }
  }
  return criteria;
}

// The evidence file may carry a "## Checks" section of "- name: pass|fail"
// lines. Absence of the section is handled by the policy as confirm (warn),
// never block.
export function extractEvidenceChecks(evidenceText) {
  const section = extractSectionLines(evidenceText, 'Checks');
  if (section === null) return { present: false, checks: [] };
  const checks = [];
  for (const line of section) {
    const match = CHECK_LINE_PATTERN.exec(line);
    if (match === null) continue;
    checks.push({ name: match[1].trim(), result: match[2].toLowerCase() });
  }
  return { present: true, checks };
}

// Lean judge state: task id, verbatim criterion texts, evidence checks.
// No source code payloads.
export function buildJudgeRequest({ taskId, criteria, checks }) {
  if (typeof taskId !== 'string' || taskId.length === 0) throw tinyError('JEV_INVALID_STATE', 'taskId is required');
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw tinyError('JEV_INVALID_STATE', 'at least one criterion is required');
  }
  const state = {
    task: { id: taskId },
    criteria: criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
    evidence: { checks: Array.isArray(checks) ? checks.map((check) => ({ ...check })) : [] },
  };
  // The live API expects questions as a dict keyed by question id, each with
  // a type discriminator (verified live 2026-09-23; array shapes get 422).
  const questions = Object.fromEntries(criteria.map((criterion) => [criterion.id, {
    type: 'noul',
    instruction: `Does this evidence demonstrate that: ${criterion.text}?`,
    criteria: { true: TRUE_CRITERION, false: FALSE_CRITERION },
  }]));
  return { state, questions };
}

async function postOnce({ endpoint, body, apiKey, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw tinyError('JEV_NETWORK', `judge request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const status = Number.isInteger(response?.status) ? response.status : 0;
  if (status === 429 || status >= 500) throw tinyError('JEV_HTTP_RETRY', `judge responded ${status}`);
  if (status < 200 || status >= 300) throw tinyError('JEV_HTTP_ERROR', `judge responded ${status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw tinyError('JEV_BAD_RESPONSE', 'judge response is not JSON');
  }
  return payload;
}

function toUnavailable(error) {
  if (error instanceof Error && error.code === JEV_UNAVAILABLE) return error;
  const reason = typeof error?.code === 'string' ? error.code : 'JEV_NETWORK';
  return tinyError(JEV_UNAVAILABLE, `semantic judge is unavailable: ${error?.message ?? 'unknown error'}`, { reason });
}

// One batched Noul-per-criterion call. Any failure path surfaces as a
// JEV_UNAVAILABLE TinySDDError; the caller then behaves exactly as mode off.
// fetch is injectable (judge.fetch) so tests never touch the network.
export async function judgeEvidenceSufficiency({ taskId, criteria, checks, endpoint, model, judge = {} }) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw tinyError('JEV_INVALID_STATE', 'endpoint is required');
  if (typeof model !== 'string' || model.length === 0) throw tinyError('JEV_INVALID_STATE', 'model is required');
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw tinyError(JEV_UNAVAILABLE, 'TYPESAFE_API_KEY is not set', { reason: 'MISSING_API_KEY' });
  }
  const { state, questions } = buildJudgeRequest({ taskId, criteria, checks });
  const body = { model, state, questions };
  const fetchImpl = typeof judge.fetch === 'function' ? judge.fetch : fetch;
  const timeoutMs = typeof judge.timeoutMs === 'number' && Number.isFinite(judge.timeoutMs) && judge.timeoutMs > 0 ? judge.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retryDelayMs = typeof judge.retryDelayMs === 'number' && Number.isFinite(judge.retryDelayMs) && judge.retryDelayMs >= 0 ? judge.retryDelayMs : DEFAULT_JEV_RETRY_DELAY_MS;
  const attempt = () => postOnce({ endpoint, body, apiKey, fetchImpl, timeoutMs });
  let payload;
  try {
    payload = await attempt();
  } catch (error) {
    if (error?.code !== 'JEV_NETWORK' && error?.code !== 'JEV_HTTP_RETRY') throw toUnavailable(error);
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      payload = await attempt();
    } catch (retryError) {
      throw toUnavailable(retryError);
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || payload.answers === null || typeof payload.answers !== 'object' || Array.isArray(payload.answers)) {
    throw tinyError(JEV_UNAVAILABLE, 'judge response is missing answers', { reason: 'JEV_BAD_RESPONSE' });
  }
  const answers = {};
  for (const questionId of Object.keys(questions)) {
    const noul = payload.answers[questionId]?.noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw tinyError(JEV_UNAVAILABLE, `judge response has no usable noul for ${questionId}`, { reason: 'JEV_BAD_RESPONSE' });
    }
    answers[questionId] = noul;
  }
  const modelVersion = typeof payload.modelVersion === 'string' ? payload.modelVersion : typeof payload.model === 'string' ? payload.model : null;
  return { answers, modelVersion };
}
