import { sha256, tinyError } from './fs-utils.mjs';
import { preflightPiWorker } from './pi-environment.mjs';

export const THINKING_CONTROL_MISMATCH = 'THINKING_CONTROL_MISMATCH';

function invalid(message) {
  throw tinyError('MODEL_SETTINGS_INVALID', message);
}

export async function inspectEffectiveModelSettings({ worker, profile, sourceAgentDir, sourceEnv, entryKind, observedReasoningTokens } = {}) {
  if (!['real', 'synthetic'].includes(entryKind)) invalid('entryKind must explicitly identify the model entry as real or synthetic');
  if (observedReasoningTokens !== undefined && (!Number.isSafeInteger(observedReasoningTokens) || observedReasoningTokens < 0)) {
    invalid('observedReasoningTokens must be a non-negative integer');
  }
  const preflight = await preflightPiWorker({ worker, profile, sourceAgentDir, sourceEnv });
  const settings = {
    ...preflight.modelSettings,
    entryKind,
    routeDigest: sha256(preflight.endpointFingerprint ?? 'UNKNOWN'),
    entryKindSource: 'operator-declared',
    requestedThinking: preflight.thinking.requested,
    effectiveThinking: preflight.thinking.effective,
    effectiveThinkingControl: preflight.thinking.control,
    effectiveThinkingReason: preflight.thinking.reason,
    maxTokens: preflight.maxTokens.value,
    maxTokensSource: preflight.maxTokens.source,
    thinkingBudget: preflight.thinkingBudget,
    thinkingTokenBudgetField: preflight.thinkingTokenBudgetField,
    basis: preflight.basis,
  };
  const findings = [];
  if (['not-sent', 'unverified'].includes(preflight.thinking.control)
    || (preflight.thinking.effective !== 'UNKNOWN' && preflight.thinking.requested !== preflight.thinking.effective)) {
    findings.push({
      code: THINKING_CONTROL_MISMATCH,
      acknowledgementRequired: true,
      message: `Requested thinking ${preflight.thinking.requested}, effective ${preflight.thinking.effective}: ${preflight.thinking.reason}. The server default may apply; off does not prove reasoning is disabled.`,
    });
  }
  if (entryKind === 'synthetic') {
    findings.push({ code: 'SYNTHETIC_MODEL_ENTRY', acknowledgementRequired: false, message: 'Synthetic model settings are not evidence about the operator real model entry.' });
  }
  if (observedReasoningTokens !== undefined && observedReasoningTokens >= settings.maxTokens) {
    findings.push({
      code: 'REASONING_EXHAUSTS_RESPONSE_BUDGET',
      acknowledgementRequired: false,
      message: `Operator-supplied observed reasoning (${observedReasoningTokens} tokens) meets or exceeds the ${settings.maxTokens}-token response cap. Review the cap before benchmarking; this is advisory and does not establish model quality.`,
    });
  }
  return {
    settings,
    settingsDigest: sha256(JSON.stringify(settings)),
    findings,
    errors: preflight.errors,
    warnings: preflight.warnings,
    observedReasoningTokens: observedReasoningTokens ?? 'UNKNOWN',
    observedReasoningSource: observedReasoningTokens === undefined ? 'UNKNOWN' : 'operator-supplied',
  };
}

export function assertEffectiveModelSettingsConfirmed(report, { settingsDigest, acknowledgedFindings = [] } = {}) {
  if (report.errors.length > 0) {
    throw tinyError('WORKER_PREFLIGHT_FAILED', 'Effective model settings cannot be honored', { errors: report.errors, settings: report });
  }
  if (settingsDigest !== report.settingsDigest) {
    throw tinyError('MODEL_SETTINGS_CONFIRMATION_REQUIRED', 'Inspect the current worker settings and obtain operator confirmation of this settingsDigest before live benchmark execution', { settings: report });
  }
  if (!Array.isArray(acknowledgedFindings) || acknowledgedFindings.some((code) => typeof code !== 'string')) invalid('acknowledgedFindings must be an array of finding codes');
  const missing = report.findings.filter((finding) => finding.acknowledgementRequired && !acknowledgedFindings.includes(finding.code)).map((finding) => finding.code);
  if (missing.length > 0) {
    throw tinyError('MODEL_SETTINGS_FINDING_ACKNOWLEDGEMENT_REQUIRED', 'Operator acknowledgement is required for the named settings findings', { missing, settings: report });
  }
}
