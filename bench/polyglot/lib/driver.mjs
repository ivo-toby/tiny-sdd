import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPiAgentDir, GATEWAY_KEY_ENV } from './pi-agent-dir.mjs';
import { isHarnessError, runAttempt as realRunAttempt } from './worker-run.mjs';

export const HARNESS_RETRIES = 3;
export const HARNESS_BACKOFF_MS = 60000;

export class RunStoppedError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RunStoppedError';
    this.code = code;
  }
}

const ABANDONED = Symbol('abandoned');

async function readJsonLines(path, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').map((line, index) => ({ line, index })).filter(({ line }) => line.trim().length > 0).map(({ line, index }) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

export function readQueue(runDir) {
  return readJsonLines(join(runDir, 'queue.jsonl'));
}

export function readResults(runDir) {
  return readJsonLines(join(runDir, 'results.jsonl'), { optional: true });
}

export async function appendResult(runDir, result) {
  await appendFile(join(runDir, 'results.jsonl'), `${JSON.stringify(result)}\n`);
}

export async function appendHarnessError(runDir, record) {
  await appendFile(join(runDir, 'harness-errors.jsonl'), `${JSON.stringify(record)}\n`);
}

async function readSolutionOverlay(dir, solutionFiles) {
  const overlay = {};
  for (const path of solutionFiles) {
    try {
      overlay[path] = await readFile(join(dir, path), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDeps(deps = {}) {
  const out = { runAttempt: realRunAttempt, sleep: defaultSleep, ...deps };
  if (!out.featuresFor) out.featuresFor = (await import('./features.mjs')).featuresFor;
  return out;
}

// Runs every queue entry that has no result yet. Entries are grouped by model
// (queue order); one model runs at a time with at most `parallel` entries in
// flight. Harness errors are retried; an entry that keeps failing is left
// unrecorded, and the run stops after several such entries in a row.
export async function runQueue({
  runDir,
  models,
  checkoutDir,
  manifest,
  excluded = [],
  onlyModels = null,
  runtime = undefined,
  harnessRetries = HARNESS_RETRIES,
  maxConsecutiveSkips = 3,
  backoffMs = HARNESS_BACKOFF_MS,
  log = (line) => process.stderr.write(`${line}\n`),
  deps = {},
}) {
  if (!process.env[GATEWAY_KEY_ENV]) throw new Error(`${GATEWAY_KEY_ENV} is not set; the gateway key is required`);
  const d = await resolveDeps(deps);
  const modelByKey = new Map(models.map((model) => [model.key, model]));
  const exercises = new Map(manifest.exercises.map((exercise) => [exercise.id, exercise]));
  const excludedSet = new Set(excluded);
  const queue = await readQueue(runDir);
  const doneIds = new Set((await readResults(runDir)).map((result) => result.id));

  const todo = [];
  for (const entry of queue) {
    if (excludedSet.has(entry.exercise)) continue;
    if (onlyModels && !onlyModels.has(entry.model)) continue;
    const model = modelByKey.get(entry.model);
    if (!model) throw new Error(`queue entry ${entry.id} names unknown model ${entry.model}`);
    if (!exercises.has(entry.exercise)) throw new Error(`queue entry ${entry.id} names unknown exercise ${entry.exercise}`);
    todo.push(entry);
  }
  const total = todo.length;
  let done = total - todo.filter((entry) => !doneIds.has(entry.id)).length;

  const profiles = new Map();
  for (const entry of todo) {
    if (doneIds.has(entry.id) || profiles.has(entry.profile)) continue;
    const text = await readFile(join(runDir, 'profiles', `${entry.profile}.json`), 'utf8');
    profiles.set(entry.profile, JSON.parse(text));
  }

  const groups = new Map();
  for (const entry of todo) {
    if (doneIds.has(entry.id)) continue;
    if (!groups.has(entry.model)) groups.set(entry.model, []);
    groups.get(entry.model).push(entry);
  }

  const agentDirs = new Map();
  for (const key of groups.keys()) {
    agentDirs.set(key, await createPiAgentDir({ model: modelByKey.get(key), dir: join(runDir, 'pi-agent', key) }));
  }

  let stopReason = null;
  let consecutiveSkips = 0;
  let fatal = null;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const onSigint = () => {
    if (stopReason === 'sigint') {
      log('second interrupt: exiting now; re-run to resume');
      process.exit(130);
    }
    stopReason = 'sigint';
    log('interrupt received: finishing in-flight entries, then stopping (press Ctrl-C again to exit now)');
  };
  process.on('SIGINT', onSigint);

  async function withHarnessRetry(entry, attempt, call) {
    for (let tries = 0; ; tries += 1) {
      try {
        return await call();
      } catch (error) {
        if (!isHarnessError(error)) throw error;
        const message = error?.message ?? String(error);
        await appendHarnessError(runDir, { id: entry.id, model: entry.model, profile: entry.profile, exercise: entry.exercise, attempt, try: tries + 1, code: error.code ?? null, error: message, at: new Date().toISOString() });
        if (tries >= harnessRetries) {
          consecutiveSkips += 1;
          log(`skipping ${entry.id} after ${tries + 1} tries (left unrecorded, retried on the next run): ${message}`);
          if (consecutiveSkips >= maxConsecutiveSkips) {
            throw new RunStoppedError(`${consecutiveSkips} entries in a row hit persistent harness errors; last ${entry.id}: ${message}`, { cause: error, code: 'HARNESS_RETRY_LIMIT' });
          }
          return ABANDONED;
        }
        log(`harness error on ${entry.id} (try ${tries + 1}): ${message}; retrying in ${Math.round(backoffMs / 1000)}s`);
        await d.sleep(backoffMs);
        if (stopReason) return ABANDONED;
      }
    }
  }

  async function runEntry(entry, model) {
    const exercise = exercises.get(entry.exercise);
    const caseDir = join(runDir, 'cases', entry.id);
    const stored = profiles.get(entry.profile);
    // Profiles carry only instructions; thinking is a property of the model under test.
    const profile = { ...stored, runtime: { ...(stored.runtime ?? {}), thinking: model.thinking ?? stored.runtime?.thinking ?? 'medium', reasoning: true } };
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const attempts = [];
    let previous = null;
    for (let n = 1; n <= (entry.attempts ?? 2); n += 1) {
      const record = await withHarnessRetry(entry, n, () => d.runAttempt({
        checkoutDir, exercise, model, profile, attempt: n, previous, caseDir, runtime, agentDir: agentDirs.get(model.key),
      }));
      if (record === ABANDONED) return;
      attempts.push(record);
      if (record.test?.passed === true) break;
      previous = { overlay: await readSolutionOverlay(join(caseDir, `attempt-${n}`, 'solution'), exercise.solutionFiles), outputTail: record.test?.outputTail ?? '' };
    }
    const pass1 = attempts[0]?.test?.passed === true;
    const pass2 = attempts.some((attempt) => attempt.test?.passed === true);
    const result = {
      id: entry.id, model: entry.model, profile: entry.profile, exercise: entry.exercise,
      language: exercise.language, split: exercise.split, repeat: entry.repeat,
      attempts, pass1, pass2,
    };
    result.features = await d.featuresFor(result);
    result.startedAt = startedAt;
    result.finishedAt = new Date().toISOString();
    await appendResult(runDir, result);
    consecutiveSkips = 0;
    done += 1;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log(`[${done}/${total}] ${entry.model} ${entry.profile} ${entry.exercise} ${pass1 ? 1 : 0}/${pass2 ? 1 : 0} ${elapsed}s`);
  }

  const remaining = todo.filter((entry) => !doneIds.has(entry.id)).length;
  const summary = { total, skipped: total - remaining, completed: 0 };
  try {
    for (const [key, entries] of groups) {
      if (stopReason || fatal) break;
      const model = modelByKey.get(key);
      const width = Math.max(1, model.parallel ?? 1);
      if (agentDirs.get(key)) process.env.PI_CODING_AGENT_DIR = agentDirs.get(key);
      let next = 0;
      const lane = async () => {
        while (!stopReason && !fatal && next < entries.length) {
          const entry = entries[next];
          next += 1;
          try {
            await runEntry(entry, model);
            summary.completed += 1;
          } catch (error) {
            fatal ??= error;
            stopReason ??= 'harness';
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(width, entries.length) }, lane));
    }
  } finally {
    process.off('SIGINT', onSigint);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (fatal) throw fatal instanceof RunStoppedError ? fatal : new RunStoppedError(`run stopped: ${fatal?.message ?? fatal}`, { cause: fatal, code: 'ENTRY_FAILED' });
  return { ...summary, stopped: stopReason };
}
