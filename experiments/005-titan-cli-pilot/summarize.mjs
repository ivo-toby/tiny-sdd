import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];
const ARTIFACT_FIELDS = [
  "directory", "candidate", "patch", "afterSnapshot", "beforeSnapshot",
  "workspaceBefore", "workspaceAfter", "prompt", "runtime", "context", "stdout", "stderr",
];

function emptyUsage() {
  return {
    events: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyAggregate() {
  return {
    attempts: 0,
    usageScope: "authoritative assistant message_end events only",
    usage: emptyUsage(),
    assistantMessageEndEvents: 0,
    ignoredTurnEndUsageEvents: 0,
    ignoredMessageUpdateUsageEvents: 0,
    rawToolExecutionStarts: 0,
    rawToolExecutionEnds: 0,
    reportedToolCalls: 0,
    reportedToolCallObservations: 0,
    wallTimeMs: { observed: 0, total: 0, minimum: null, maximum: null },
    outcomes: {},
  };
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  let observed = false;
  for (const field of TOKEN_FIELDS) {
    if (typeof usage[field] === "number" && Number.isFinite(usage[field])) {
      total[field] += usage[field];
      observed = true;
    }
  }
  if (usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)) {
    for (const field of COST_FIELDS) {
      if (typeof usage.cost[field] === "number" && Number.isFinite(usage.cost[field])) {
        total.cost[field] += usage.cost[field];
        observed = true;
      }
    }
  }
  return observed;
}

async function readJson(path) {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: { code: error?.code, message: error instanceof Error ? error.message : String(error) } };
  }
}

async function observePath(runDir, rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  const path = resolve(runDir, rawPath);
  try {
    const info = await stat(path);
    return {
      path: rawPath,
      exists: true,
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      bytes: info.isFile() ? info.size : null,
    };
  } catch (error) {
    return { path: rawPath, exists: false, reason: error?.code ?? "unavailable" };
  }
}

async function readRawEvents(runDir, rawPath) {
  const base = {
    path: rawPath ?? null,
    exists: false,
    lines: 0,
    parsed: 0,
    parseErrors: 0,
    typeCounts: {},
    assistantMessageEndEvents: 0,
    assistantMessageEndUsageEvents: 0,
    ignoredTurnEndUsageEvents: 0,
    ignoredMessageUpdateUsageEvents: 0,
    toolExecutionStarts: 0,
    toolExecutionEnds: 0,
    usage: emptyUsage(),
    warnings: [],
  };
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    base.warnings.push("worker stdout JSONL path was not reported");
    return base;
  }
  const path = resolve(runDir, rawPath);
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    base.warnings.push(`worker stdout JSONL unavailable: ${error?.code ?? error.message}`);
    return base;
  }
  base.exists = true;
  const lines = content.split(/\r?\n/u);
  for (const line of lines) {
    if (line.length === 0) continue;
    base.lines += 1;
    let event;
    try {
      event = JSON.parse(line);
      base.parsed += 1;
    } catch {
      base.parseErrors += 1;
      continue;
    }
    const type = typeof event?.type === "string" ? event.type : "<missing-type>";
    base.typeCounts[type] = (base.typeCounts[type] ?? 0) + 1;
    if (type === "tool_execution_start") base.toolExecutionStarts += 1;
    if (type === "tool_execution_end") base.toolExecutionEnds += 1;
    if (type === "message_end") {
      if (event.message?.role === "assistant") {
        base.assistantMessageEndEvents += 1;
        const usage = event.message.usage ?? event.usage;
        if (addUsage(base.usage, usage)) {
          base.assistantMessageEndUsageEvents += 1;
          base.usage.events += 1;
        }
      }
    } else if (type === "turn_end" && event.message?.usage !== undefined) {
      base.ignoredTurnEndUsageEvents += 1;
    } else if (type === "message_update" && event.usage !== undefined) {
      base.ignoredMessageUpdateUsageEvents += 1;
    }
  }
  if (base.parseErrors > 0) base.warnings.push(`${base.parseErrors} raw JSONL line(s) could not be parsed`);
  return base;
}

function wallTime(record, envelopeData) {
  if (typeof record?.wallTimeMs === "number" && Number.isFinite(record.wallTimeMs)) {
    return { value: record.wallTimeMs, source: "attempt.wallTimeMs" };
  }
  const started = Date.parse(record?.startedAt ?? "");
  const finished = Date.parse(record?.finishedAt ?? "");
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    return { value: finished - started, source: "attempt timestamps" };
  }
  if (typeof envelopeData?.observed?.processTermination?.elapsedMs === "number") {
    return { value: envelopeData.observed.processTermination.elapsedMs, source: "worker process elapsedMs" };
  }
  return { value: null, source: null };
}

async function summarizeAttempt(runDir, number, attemptDir, manifestRecord) {
  const missing = [];
  let record = manifestRecord ?? null;
  if (attemptDir) {
    const attemptResult = await readJson(join(attemptDir, "attempt.json"));
    if (attemptResult.value) record = attemptResult.value;
    else if (attemptResult.error?.code !== "ENOENT") missing.push(`attempt.json: ${attemptResult.error?.message}`);
  } else {
    missing.push("attempt directory");
  }

  let captured = null;
  if (attemptDir) {
    const envelopeResult = await readJson(join(attemptDir, "cli-envelope.json"));
    if (envelopeResult.value) captured = envelopeResult.value;
    else if (envelopeResult.error?.code === "ENOENT") missing.push("cli-envelope.json");
    else missing.push(`cli-envelope.json: ${envelopeResult.error?.message}`);
  }
  const envelope = captured?.envelope ?? null;
  const data = envelope?.data ?? {};
  const observed = data.observed ?? {};
  const artifacts = data.artifactPaths ?? {};
  const raw = await readRawEvents(runDir, artifacts.stdout);
  if (!raw.exists) missing.push("worker stdout JSONL");

  let result = null;
  let resultPath = null;
  if (typeof artifacts.directory === "string") {
    resultPath = join(artifacts.directory, "result.json");
    const resultRead = await readJson(resolve(runDir, resultPath));
    if (resultRead.value) result = resultRead.value;
    else if (resultRead.error?.code !== "ENOENT") missing.push(`result.json: ${resultRead.error?.message}`);
  }

  const artifactSummary = {};
  for (const field of ARTIFACT_FIELDS) artifactSummary[field] = await observePath(runDir, artifacts[field]);
  artifactSummary.result = await observePath(runDir, resultPath);

  const timing = wallTime(record, data);
  const outcome = {
    status: record?.status ?? null,
    cliOk: record?.cliOk ?? captured?.envelope?.ok ?? null,
    workerOutcome: record?.workerOutcome ?? data.outcome ?? null,
    exitCode: record?.exitCode ?? captured?.exitCode ?? null,
    signal: record?.signal ?? captured?.signal ?? null,
    stopReason: observed.assistantTermination?.stopReason ?? null,
    errorMessage: observed.assistantTermination?.errorMessage ?? null,
  };
  const reportedUsage = observed.usage ?? null;
  const checks = {
    envelopePatchApplyCheck: data.patch?.applyCheck ?? null,
    resultPatchApplyCheck: result?.patch?.applyCheck ?? null,
    resultVerification: result?.verification ?? null,
    resultChecks: result?.checks ?? null,
    runnerVerificationField: record?.verification ?? null,
  };
  return {
    number,
    wallTimeMs: timing.value,
    wallTimeSource: timing.source,
    tools: {
      reported: typeof observed.toolCalls === "number" ? observed.toolCalls : null,
      rawExecutionStarts: raw.toolExecutionStarts,
      rawExecutionEnds: raw.toolExecutionEnds,
    },
    outcome,
    tokens: {
      authoritativeRawUsage: raw.usage,
      authoritativeAssistantMessageEndEvents: raw.assistantMessageEndEvents,
      authoritativeUsageEvents: raw.assistantMessageEndUsageEvents,
      adapterReportedUsage: reportedUsage,
    },
    artifacts: artifactSummary,
    patch: data.patch ?? result?.patch ?? null,
    checkVerification: checks,
    rawEvents: raw,
    missingLogs: missing,
  };
}

async function attemptNumbers(runDir, manifest) {
  const numbers = new Set();
  try {
    for (const entry of await readdir(join(runDir, "attempts"), { withFileTypes: true })) {
      const match = /^attempt-(\d{3})$/u.exec(entry.name);
      if (entry.isDirectory() && match) numbers.add(Number(match[1]));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const item of manifest?.attempts ?? []) {
    if (Number.isInteger(item?.number)) numbers.add(item.number);
  }
  return [...numbers].sort((left, right) => left - right);
}

function addAggregate(aggregate, attempt) {
  aggregate.attempts += 1;
  aggregate.assistantMessageEndEvents += attempt.tokens.authoritativeAssistantMessageEndEvents;
  aggregate.ignoredTurnEndUsageEvents += attempt.rawEvents.ignoredTurnEndUsageEvents;
  aggregate.ignoredMessageUpdateUsageEvents += attempt.rawEvents.ignoredMessageUpdateUsageEvents;
  aggregate.rawToolExecutionStarts += attempt.tools.rawExecutionStarts;
  aggregate.rawToolExecutionEnds += attempt.tools.rawExecutionEnds;
  if (typeof attempt.tools.reported === "number") {
    aggregate.reportedToolCalls += attempt.tools.reported;
    aggregate.reportedToolCallObservations += 1;
  }
  if (typeof attempt.wallTimeMs === "number") {
    aggregate.wallTimeMs.observed += 1;
    aggregate.wallTimeMs.total += attempt.wallTimeMs;
    aggregate.wallTimeMs.minimum = aggregate.wallTimeMs.minimum === null
      ? attempt.wallTimeMs : Math.min(aggregate.wallTimeMs.minimum, attempt.wallTimeMs);
    aggregate.wallTimeMs.maximum = aggregate.wallTimeMs.maximum === null
      ? attempt.wallTimeMs : Math.max(aggregate.wallTimeMs.maximum, attempt.wallTimeMs);
  }
  addUsage(aggregate.usage, attempt.tokens.authoritativeRawUsage);
  aggregate.usage.events += attempt.tokens.authoritativeUsageEvents;
  const outcome = attempt.outcome.workerOutcome ?? attempt.outcome.status ?? "unknown";
  aggregate.outcomes[outcome] = (aggregate.outcomes[outcome] ?? 0) + 1;
}

export async function summarize(runValue) {
  const runDir = resolve(runValue);
  const manifestResult = await readJson(join(runDir, "manifest.json"));
  if (!manifestResult.value) {
    return {
      schemaVersion: 1,
      ok: false,
      run: runDir,
      error: manifestResult.error?.message ?? "manifest.json is unavailable",
      attempts: [],
      aggregate: emptyAggregate(),
      acceptance: { recorded: false, note: "This summarizer never infers acceptance." },
    };
  }
  const manifest = manifestResult.value;
  const records = new Map((manifest.attempts ?? []).filter((item) => Number.isInteger(item?.number)).map((item) => [item.number, item]));
  const attempts = [];
  for (const number of await attemptNumbers(runDir, manifest)) {
    const attemptDir = join(runDir, "attempts", `attempt-${String(number).padStart(3, "0")}`);
    const exists = await stat(attemptDir).then((info) => info.isDirectory()).catch(() => false);
    attempts.push(await summarizeAttempt(runDir, number, exists ? attemptDir : null, records.get(number)));
  }
  const aggregate = emptyAggregate();
  for (const attempt of attempts) addAggregate(aggregate, attempt);
  return {
    schemaVersion: 1,
    ok: true,
    run: runDir,
    participant: manifest.participant ?? null,
    model: manifest.model ?? null,
    taskId: manifest.taskId ?? null,
    limits: manifest.limits ?? null,
    revisionPolicy: manifest.revisionPolicy ?? null,
    lineage: manifest.lineage ?? null,
    attempts,
    aggregate,
    acceptance: { recorded: false, note: "This summarizer reports observations only; it never infers acceptance." },
  };
}

function usage() {
  return { schemaVersion: 1, ok: false, error: "Usage: node experiments/005-titan-cli-pilot/summarize.mjs RUN", attempts: [], aggregate: emptyAggregate() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runValue = process.argv[2];
  let output;
  try {
    output = runValue ? await summarize(runValue) : usage();
  } catch (error) {
    output = {
      schemaVersion: 1,
      ok: false,
      run: runValue ? resolve(runValue) : null,
      error: error instanceof Error ? error.message : String(error),
      attempts: [],
      aggregate: emptyAggregate(),
      acceptance: { recorded: false, note: "This summarizer never infers acceptance." },
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!runValue || output.ok === false) process.exitCode = 1;
}
