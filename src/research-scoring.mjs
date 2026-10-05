import { canonicalProjectRoot, isTinySDDError, sha256, tinyError } from './fs-utils.mjs';
import { compileContext, MAX_COMPILED_CONTEXT_BYTES, parseContextManifest } from './context-compiler.mjs';

export const RESEARCH_SCORING_SCHEMA_VERSION = 1;
export const RESEARCH_UNKNOWN = 'UNKNOWN';
export const MAX_RESEARCH_MANIFEST_BYTES = 512 * 1024;

function errorDetails(error) {
  return {
    code: isTinySDDError(error) ? error.code : (typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR'),
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

function invalidInput(message, details = undefined) {
  return tinyError('RESEARCH_SCORING_INVALID', message, details);
}

function packetContext(value, label, defaultPath) {
  if (typeof value === 'string') {
    return { path: defaultPath, text: value, sha256: sha256(value) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput(`${label} must be a manifest JSON string, packet context, or manifest object`);
  }

  if (typeof value.text === 'string') {
    const path = value.path === undefined ? defaultPath : value.path;
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw invalidInput(`${label}.path must be nonempty text without NUL bytes`);
    }
    return {
      path,
      text: value.text,
      sha256: value.sha256 === undefined ? sha256(value.text) : value.sha256,
    };
  }

  if (Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'facts') || Object.hasOwn(value, 'resources')) {
    const text = JSON.stringify(value);
    return { path: defaultPath, text, sha256: sha256(text) };
  }

  throw invalidInput(`${label} must contain manifest text or schemaVersion, facts, and resources`);
}

function rangeUnion(resources) {
  const byPath = new Map();
  for (const resource of resources) {
    const intervals = byPath.get(resource.path) ?? [];
    intervals.push([resource.startLine, resource.endLine]);
    byPath.set(resource.path, intervals);
  }

  const merged = new Map();
  for (const [path, intervals] of byPath) {
    intervals.sort(([leftStart, leftEnd], [rightStart, rightEnd]) => leftStart - rightStart || leftEnd - rightEnd);
    const result = [];
    for (const [startLine, endLine] of intervals) {
      const previous = result.at(-1);
      if (previous && startLine <= previous[1] + 1) {
        previous[1] = Math.max(previous[1], endLine);
      } else {
        result.push([startLine, endLine]);
      }
    }
    merged.set(path, result);
  }
  return merged;
}

function lineCount(union) {
  let count = 0;
  for (const intervals of union.values()) {
    for (const [startLine, endLine] of intervals) count += endLine - startLine + 1;
  }
  return count;
}

function intersectionCount(left, right) {
  let count = 0;
  for (const [path, leftIntervals] of left) {
    const rightIntervals = right.get(path);
    if (!rightIntervals) continue;
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftIntervals.length && rightIndex < rightIntervals.length) {
      const [leftStart, leftEnd] = leftIntervals[leftIndex];
      const [rightStart, rightEnd] = rightIntervals[rightIndex];
      const startLine = Math.max(leftStart, rightStart);
      const endLine = Math.min(leftEnd, rightEnd);
      if (startLine <= endLine) count += endLine - startLine + 1;
      if (leftEnd < rightEnd) leftIndex += 1;
      else rightIndex += 1;
    }
  }
  return count;
}

function ratio(numerator, denominator, label) {
  if (denominator === 0) {
    return {
      value: RESEARCH_UNKNOWN,
      status: RESEARCH_UNKNOWN,
      reason: `${label} denominator is zero`,
    };
  }
  return { value: numerator / denominator, status: 'KNOWN', reason: null };
}

function sourceObservation(compiled, manifest) {
  return {
    status: 'valid',
    manifest: compiled.manifest,
    facts: manifest.facts.length,
    resources: manifest.resources.length,
    bytes: compiled.bytes,
    sha256: compiled.sha256,
    resourceRanges: compiled.resources.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
  };
}

function invalidObservation(error, status = 'invalid') {
  return { status, error: errorDetails(error) };
}

function gate(status, reason = null, error = undefined) {
  return {
    status,
    ...(reason === null ? {} : { reason }),
    ...(error === undefined ? {} : { error }),
  };
}

function emptyResult({ projectRoot, budgetBytes, gold, candidate, status, evaluation, hardGates, reason = undefined }) {
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status,
    evaluation,
    projectRoot,
    budget: {
      limitBytes: budgetBytes,
      maxBytes: MAX_COMPILED_CONTEXT_BYTES,
      status: 'not_evaluated',
    },
    gold,
    candidate,
    metrics: null,
    hardGates,
    hardGateObservations: Object.entries(hardGates).map(([name, observation]) => ({ name, ...observation })),
    ...(reason === undefined ? {} : { reason }),
    semanticTruth: {
      status: 'not_evaluated',
      reason: 'facts and purpose prose are not semantic-truth judgments',
    },
  };
}

function normalizeOptions(first, second, third, fourth) {
  if (
    first !== null
    && typeof first === 'object'
    && !Array.isArray(first)
    && Object.hasOwn(first, 'projectRoot')
  ) {
    return first;
  }
  return {
    projectRoot: first,
    goldManifest: second,
    candidateManifest: third,
    budgetBytes: fourth,
  };
}

function readBudget(options) {
  const requested = options.budgetBytes ?? options.callerBudgetBytes ?? options.budget;
  const value = requested !== null && typeof requested === 'object' ? requested.bytes : requested;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMPILED_CONTEXT_BYTES) {
    throw invalidInput(`budgetBytes must be a positive integer at most ${MAX_COMPILED_CONTEXT_BYTES}`);
  }
  return value;
}

async function compileManifest(projectRoot, input, label, defaultPath, readSource) {
  let packet;
  try {
    if (readSource !== undefined && typeof readSource !== 'function') throw invalidInput('readSource must be a function when supplied');
    packet = packetContext(input, label, defaultPath);
    if (Buffer.byteLength(packet.text) > MAX_RESEARCH_MANIFEST_BYTES) {
      throw invalidInput(`${label} exceeds ${MAX_RESEARCH_MANIFEST_BYTES} bytes`);
    }
    const manifest = parseContextManifest(packet.text);
    const compiled = await compileContext(projectRoot, packet, readSource === undefined ? undefined : { readSource });
    return { ok: true, packet, manifest, compiled };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Score a candidate context manifest against a reviewed gold manifest.
 *
 * This is deliberately an offline measurement helper. It compiles both
 * manifests through the same context compiler used by task packets and never
 * executes checks, invokes a model, or changes controller state.
 */
export async function scoreResearchSelection(first, second, third, fourth) {
  const options = normalizeOptions(first, second, third, fourth);
  const projectRootInput = options.projectRoot;
  const budgetBytes = (() => {
    try {
      return readBudget(options);
    } catch {
      return null;
    }
  })();

  if (budgetBytes === null) {
    let error;
    try {
      readBudget(options);
    } catch (caught) {
      error = caught;
    }
    const observation = invalidObservation(error);
    return emptyResult({
      projectRoot: projectRootInput,
      budgetBytes: null,
      gold: { status: 'not_evaluated' },
      candidate: { status: 'not_evaluated' },
      status: 'invalid',
      evaluation: 'invalid_budget',
      hardGates: { gold: gate('not_evaluated'), candidate: gate('not_evaluated'), budget: gate('failed', 'invalid caller budget', observation.error) },
      reason: observation.error.message,
    });
  }

  let projectRoot;
  try {
    projectRoot = await canonicalProjectRoot(projectRootInput);
  } catch (error) {
    const observation = invalidObservation(error);
    return emptyResult({
      projectRoot: projectRootInput,
      budgetBytes,
      gold: { status: 'not_evaluated' },
      candidate: { status: 'not_evaluated' },
      status: 'refused',
      evaluation: 'invalid_project',
      hardGates: { gold: gate('not_evaluated'), candidate: gate('not_evaluated'), budget: gate('not_evaluated') },
      reason: observation.error.message,
    });
  }

  const gold = await compileManifest(projectRoot, options.goldManifest, 'goldManifest', '.tinysdd/research/gold.context.json', options.readSource);
  if (!gold.ok) {
    const observation = invalidObservation(gold.error, 'refused');
    return emptyResult({
      projectRoot,
      budgetBytes,
      gold: observation,
      candidate: { status: 'not_evaluated' },
      status: 'refused',
      evaluation: 'invalid_gold',
      hardGates: {
        gold: gate('failed', 'gold manifest is not a valid compiler input', observation.error),
        candidate: gate('not_evaluated'),
        budget: gate('not_evaluated'),
      },
      reason: 'invalid gold manifest refuses evaluation',
    });
  }

  const goldObservation = sourceObservation(gold.compiled, gold.manifest);
  const candidate = await compileManifest(projectRoot, options.candidateManifest, 'candidateManifest', '.tinysdd/research/candidate.context.json', options.readSource);
  if (!candidate.ok) {
    const observation = invalidObservation(candidate.error);
    return emptyResult({
      projectRoot,
      budgetBytes,
      gold: goldObservation,
      candidate: observation,
      status: 'invalid',
      evaluation: 'invalid_candidate',
      hardGates: {
        gold: gate('passed'),
        candidate: gate('failed', 'candidate manifest is not a valid compiler input', observation.error),
        budget: gate('not_evaluated'),
      },
      reason: 'candidate citation hard gate failed',
    });
  }

  const candidateObservation = sourceObservation(candidate.compiled, candidate.manifest);
  const budgetExceeded = {
    gold: gold.compiled.bytes > budgetBytes,
    candidate: candidate.compiled.bytes > budgetBytes,
  };
  // The caller's budget constrains the candidate selection. Gold is a
  // reference observation: it may exceed that budget without making an
  // otherwise in-budget candidate fail its hard gate.
  const budgetFailed = budgetExceeded.candidate;
  const goldUnion = rangeUnion(gold.compiled.resources);
  const candidateUnion = rangeUnion(candidate.compiled.resources);
  const metrics = {
    goldLines: lineCount(goldUnion),
    candidateLines: lineCount(candidateUnion),
    intersectionLines: intersectionCount(goldUnion, candidateUnion),
  };
  const precision = ratio(metrics.intersectionLines, metrics.candidateLines, 'precision');
  const recall = ratio(metrics.intersectionLines, metrics.goldLines, 'recall');
  metrics.precision = precision.value;
  metrics.recall = recall.value;
  metrics.precisionStatus = precision.status;
  metrics.recallStatus = recall.status;
  metrics.precisionReason = precision.reason;
  metrics.recallReason = recall.reason;
  metrics.ratios = { precision, recall };

  const budgetObservation = {
    status: budgetFailed ? 'failed' : 'passed',
    limitBytes: budgetBytes,
    maxBytes: MAX_COMPILED_CONTEXT_BYTES,
    goldBytes: gold.compiled.bytes,
    candidateBytes: candidate.compiled.bytes,
    goldExceeded: budgetExceeded.gold,
    candidateExceeded: budgetExceeded.candidate,
    exceeded: budgetFailed,
    reference: {
      status: budgetExceeded.gold ? 'exceeded' : 'within',
      bytes: gold.compiled.bytes,
    },
    candidate: {
      status: budgetExceeded.candidate ? 'exceeded' : 'within',
      bytes: candidate.compiled.bytes,
    },
  };
  return {
    schemaVersion: RESEARCH_SCORING_SCHEMA_VERSION,
    status: budgetFailed ? 'hard_gate_failed' : 'scored',
    evaluation: budgetFailed ? 'budget_exceeded' : 'scored',
    projectRoot,
    budget: budgetObservation,
    gold: goldObservation,
    candidate: candidateObservation,
    metrics,
    hardGates: {
      gold: gate('passed'),
      candidate: gate('passed'),
      budget: gate(budgetFailed ? 'failed' : 'passed', budgetFailed ? 'compiled context exceeds caller budget' : null),
    },
    hardGateObservations: [
      { name: 'gold', ...gate('passed') },
      { name: 'candidate', ...gate('passed') },
      { name: 'budget', ...gate(budgetFailed ? 'failed' : 'passed', budgetFailed ? 'compiled context exceeds caller budget' : null) },
    ],
    semanticTruth: {
      status: 'not_evaluated',
      reason: 'facts and purpose prose are not semantic-truth judgments',
    },
  };
}

export const scoreResearch = scoreResearchSelection;
export const scoreResearchManifests = scoreResearchSelection;
export const scoreResearchContext = scoreResearchSelection;
