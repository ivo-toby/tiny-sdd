import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertInternalPath,
  canonicalProjectRoot,
  ensureDirectory,
  tinyError,
} from './fs-utils.mjs';

export const GATE_ID = 'evidence-sufficiency';
export const JUDGE_UNAVAILABLE_ACTION = 'semantic-judge-unavailable';
export const SHADOW_POLICY_ACTION = 'ignored-shadow';

const DECISION_TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const POLICY_BANDS = ['allow', 'confirm', 'block'];
const POLICY_MODES = ['off', 'shadow', 'enforce'];

// noul >= accept → allow; noul < reject → block; between → confirm (warn).
export function computeBand(noul, thresholds) {
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw tinyError('POLICY_INVALID', 'noul must be a finite number in [0,1]');
  }
  if (typeof thresholds?.accept !== 'number' || !Number.isFinite(thresholds.accept)
    || typeof thresholds?.reject !== 'number' || !Number.isFinite(thresholds.reject)) {
    throw tinyError('POLICY_INVALID', 'thresholds must provide finite accept and reject numbers');
  }
  if (noul >= thresholds.accept) return 'allow';
  if (noul < thresholds.reject) return 'block';
  return 'confirm';
}

// The gate may only block an accepted verdict. Shadow mode records the band
// but never enforces it; enforce maps the aggregated band onto the verdict.
export function aggregateGateOutcome({ evaluated, mode }) {
  if (!POLICY_MODES.includes(mode)) throw tinyError('POLICY_INVALID', 'mode must be off, shadow, or enforce');
  if (!Array.isArray(evaluated) || evaluated.some((item) => item === null || typeof item !== 'object' || !POLICY_BANDS.includes(item.band))) {
    throw tinyError('POLICY_INVALID', 'evaluated criteria must each carry an allow, confirm, or block band');
  }
  let action = 'allow';
  for (const item of evaluated) {
    if (item.band === 'block') {
      action = 'block';
      break;
    }
    if (item.band === 'confirm') action = 'confirm';
  }
  const policyAction = mode === 'shadow' ? SHADOW_POLICY_ACTION : action;
  return { action, policyAction };
}

export function buildDecisionRecord({
  timestamp,
  taskId,
  mode,
  model,
  modelVersion = null,
  questionId = null,
  criterionDigest = null,
  noul = null,
  band = null,
  policyAction,
  artifactDigests = null,
  reason = undefined,
}) {
  if (typeof timestamp !== 'string' || timestamp.length === 0) throw tinyError('POLICY_INVALID', 'record timestamp is required');
  if (typeof taskId !== 'string' || !DECISION_TASK_ID_PATTERN.test(taskId)) throw tinyError('POLICY_INVALID', 'record taskId is required');
  if (!POLICY_MODES.includes(mode)) throw tinyError('POLICY_INVALID', 'record mode is required');
  if (typeof model !== 'string' || model.length === 0) throw tinyError('POLICY_INVALID', 'record model is required');
  if (typeof policyAction !== 'string' || policyAction.length === 0) throw tinyError('POLICY_INVALID', 'record policyAction is required');
  if (band !== null && !POLICY_BANDS.includes(band)) throw tinyError('POLICY_INVALID', 'record band must be null or an allow, confirm, or block band');
  if (noul !== null && (typeof noul !== 'number' || !Number.isFinite(noul))) throw tinyError('POLICY_INVALID', 'record noul must be null or a finite number');
  return {
    timestamp,
    taskId,
    gate: GATE_ID,
    mode,
    model,
    modelVersion,
    questionId,
    criterionDigest,
    noul,
    band,
    policyAction,
    ...(artifactDigests === null ? {} : { artifactDigests }),
    ...(reason === undefined ? {} : { reason }),
  };
}

// One JSONL file per task under .tinysdd/runs/decisions/. Records carry
// digests and noul values only — never brief or evidence payloads.
export async function appendDecisionRecords(projectRoot, taskId, records) {
  if (typeof taskId !== 'string' || !DECISION_TASK_ID_PATTERN.test(taskId)) {
    throw tinyError('POLICY_INVALID', 'taskId is required');
  }
  if (!Array.isArray(records) || records.length === 0) return;
  const root = await canonicalProjectRoot(projectRoot);
  const decisions = await assertInternalPath(root, ['.tinysdd', 'runs', 'decisions'], { allowMissing: true });
  await ensureDirectory(decisions);
  const lines = records.map((record) => JSON.stringify(record)).join('\n');
  await appendFile(join(decisions, `${taskId}.jsonl`), `${lines}\n`, 'utf8');
}
