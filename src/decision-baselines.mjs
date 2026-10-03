const FAILURE_RULES = [
  {
    name: 'environment',
    decision: 'environment',
    matches: (line) => (
      /\b(?:ECONNREFUSED|ENOTFOUND|ENOSPC|EACCES|ETIMEDOUT)\b/u.test(line)
      || /^\s*Killed\s*$/u.test(line)
      || /JavaScript heap out of memory|FATAL ERROR: .* out of memory|Cannot allocate memory/u.test(line)
    ),
  },
  {
    name: 'missing-context',
    decision: 'missing-context',
    matches: (line) => /Cannot find module ['"][^'"]+['"]|ERR_MODULE_NOT_FOUND/u.test(line),
  },
  {
    name: 'tdz',
    decision: 'fixable-from-log',
    matches: (line) => /ReferenceError:\s+Cannot access ['"][^'"]+['"] before initialization/u.test(line),
  },
  {
    name: 'tsc',
    decision: 'fixable-from-log',
    matches: (line) => /error TS\d+:/u.test(line),
  },
  {
    name: 'eslint',
    decision: 'fixable-from-log',
    matches: (line) => /\d+:\d+\s+error\s+.+\s+[@a-z0-9/-]+$/u.test(line),
  },
  {
    name: 'assertion',
    decision: 'fixable-from-log',
    matches: (line) => /AssertionError|Expected|Received/u.test(line),
  },
];

function logLines(checkLog) {
  return String(checkLog ?? '').split(/\r?\n/u);
}

function evidenceFor(lines, matches) {
  return lines.filter(matches).slice(0, 3).map((line) => line.slice(0, 300));
}

export function triageFailure({ checkLog } = {}) {
  const lines = logLines(checkLog);
  for (const rule of FAILURE_RULES) {
    const evidence = evidenceFor(lines, rule.matches);
    if (evidence.length > 0) {
      return { decision: rule.decision, rule: rule.name, evidence };
    }
  }
  return { decision: 'unknown', rule: null, evidence: [] };
}

function hasPublicApiChange(patch) {
  return String(patch ?? '').split(/\r?\n/u).some((line) => (
    (line.startsWith('+') || line.startsWith('-'))
    && line.slice(1).trimStart().startsWith('export ')
  ));
}

export function triageReview({ result, controllerChecks, patch } = {}) {
  const reasons = [];
  if (result?.outcome !== 'completed') reasons.push('worker outcome is not completed');
  if (!Array.isArray(result?.scopeViolations) || result.scopeViolations.length > 0) {
    reasons.push('scope violations are present');
  }
  if (!Array.isArray(controllerChecks) || controllerChecks.length === 0) {
    reasons.push('controller checks are missing');
  } else if (!controllerChecks.every((check) => check?.passed === true)) {
    reasons.push('controller checks did not all pass');
  }
  if (hasPublicApiChange(patch)) reasons.push('public API change');
  return { needsFrontierReview: reasons.length > 0, reasons };
}
