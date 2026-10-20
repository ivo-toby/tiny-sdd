import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKER_TIMEOUT_MS = 600000;
export const WORKER_MAX_TOOL_CALLS = 100;
export const VERIFY_TIMEOUT_MS = 180000;
export const PREVIOUS_OUTPUT_CHARS = 6000;

// Infrastructure failure: no model result may be recorded for this attempt.
export class RunHarnessError extends Error {
  constructor(message, { cause, code = 'HARNESS' } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HarnessError';
    this.harness = true;
    this.code = code;
  }
}

export function isHarnessError(error) {
  return error?.harness === true || error?.name === 'HarnessError' || error?.constructor?.name === 'HarnessError';
}

export function taskIdFor(exerciseId) {
  return exerciseId.replaceAll('/', '__');
}

export function buildBrief({ exercise, previous = null }) {
  const lines = [
    `# Task: ${exercise.id}`,
    `Implement this ${exercise.language} exercise. Edit only: ${exercise.solutionFiles.join(', ')}.`,
    `The tests (${exercise.testFiles.join(', ')}) define the required interface and behavior; read them, do not modify them.`,
    'Use only the standard library unless the project files already declare a dependency.',
    '',
    exercise.instructions ?? '',
  ];
  let text = lines.join('\n');
  if (previous) {
    const tail = (previous.outputTail ?? '').slice(-PREVIOUS_OUTPUT_CHARS);
    text += `\n\n## Previous attempt\nYour previous implementation is in the files above. The tests failed with this output:\n\`\`\`\n${tail}\n\`\`\`\nFix the implementation so all tests pass.`;
  }
  return text;
}

export function buildPacket({ exercise, previous = null }) {
  return {
    taskId: taskIdFor(exercise.id),
    briefText: buildBrief({ exercise, previous }),
    allowedPaths: [...exercise.solutionFiles],
    protectedPaths: [...exercise.testFiles],
    context: null,
    checks: null,
  };
}

async function harnessStep(label, fn) {
  try {
    return await fn();
  } catch (error) {
    if (isHarnessError(error)) throw error;
    throw new RunHarnessError(`${label} failed: ${error?.message ?? error}`, { cause: error, code: 'STEP' });
  }
}

async function resolveDeps(deps = {}) {
  const out = { ...deps };
  if (!out.runWorker) out.runWorker = (await import('../../../src/worker.mjs')).runWorker;
  if (!out.prepareWorkspace) out.prepareWorkspace = (await import('./dataset.mjs')).prepareWorkspace;
  if (!out.runTests) out.runTests = (await import('./docker.mjs')).runTests;
  return out;
}

// Reads regular files only; a symlink in the candidate is never followed.
async function readCandidateSolutions(candidateDir, solutionFiles) {
  const overlay = {};
  for (const path of solutionFiles) {
    const absolute = join(candidateDir, path);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    overlay[path] = await readFile(absolute, 'utf8');
  }
  return overlay;
}

async function saveAttemptFiles({ attemptDir, result, artifacts, packet, solutionOverlay, test }) {
  await mkdir(join(attemptDir, 'solution'), { recursive: true });
  await writeFile(join(attemptDir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
  await writeFile(join(attemptDir, 'worker-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(attemptDir, 'test.json'), `${JSON.stringify(test, null, 2)}\n`);
  if (artifacts.prompt) await copyFile(artifacts.prompt, join(attemptDir, 'prompt.txt')).catch(() => {});
  if (artifacts.patch) await copyFile(artifacts.patch, join(attemptDir, 'patch.diff')).catch(() => {});
  for (const [path, text] of Object.entries(solutionOverlay)) {
    const target = join(attemptDir, 'solution', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text);
  }
}

// Runs one worker attempt and verifies the candidate with the dataset's own tests.
// `previous` = { overlay: {solutionPath: text}, outputTail } from attempt n-1.
// `agentDir`, when given, becomes PI_CODING_AGENT_DIR for the worker call; the
// caller must not run two different agent dirs concurrently in one process.
// Any infrastructure failure throws RunHarnessError (or the original harness error).
export async function runAttempt({
  checkoutDir,
  exercise,
  model,
  profile,
  attempt,
  previous = null,
  caseDir,
  runtime = undefined,
  agentDir = undefined,
  timeoutMs = WORKER_TIMEOUT_MS,
  maxToolCalls = WORKER_MAX_TOOL_CALLS,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  deps = {},
}) {
  const d = await resolveDeps(deps);
  const provider = model.provider ?? 'litellm';
  const packet = buildPacket({ exercise, previous });
  const tmp = await realpath(tmpdir());
  const workRoot = await mkdtemp(join(tmp, 'tinysdd-polyglot-work-'));
  let verifyRoot = null;
  try {
    await harnessStep(`worker workspace for ${exercise.id}`, () => d.prepareWorkspace({ checkoutDir, exercise, destDir: workRoot, overlay: previous?.overlay && Object.keys(previous.overlay).length > 0 ? previous.overlay : undefined }));
    if (agentDir) process.env.PI_CODING_AGENT_DIR = agentDir;
    const result = await harnessStep(`worker run for ${exercise.id}`, () => d.runWorker({
      projectRoot: workRoot,
      packet,
      worker: { type: 'pi', provider, model: model.route, limits: { timeoutMs, maxToolCalls } },
      profile,
      runtime,
    }));
    const artifacts = result.artifactPaths ?? {};
    const assistant = result.observed?.assistantTermination ?? {};
    const toolCalls = result.observed?.toolCalls ?? 0;
    // Pi exited without any model message or tool call, or the gateway rejected the
    // first request (HTTP error before any tool call, e.g. an unknown route): this is
    // infrastructure, not the model. Retried by the driver; no result written.
    const gatewayRejected = assistant.stopReason === 'error' && /^\d{3}\b/.test(assistant.errorMessage ?? '');
    if (result.outcome === 'failed' && toolCalls === 0 && (!assistant.observed || gatewayRejected)) {
      throw new RunHarnessError(`worker produced no model output for ${exercise.id}: ${assistant.errorMessage ?? 'no error message'}`, { code: 'NO_MODEL_OUTPUT' });
    }
    const changed = (result.changedPaths ?? []).map((change) => change.path);
    const solutionChanged = changed.some((path) => exercise.solutionFiles.includes(path));
    const solutionOverlay = artifacts.candidate ? await readCandidateSolutions(artifacts.candidate, exercise.solutionFiles) : {};

    let test = null;
    if (solutionChanged || result.outcome === 'completed') {
      verifyRoot = await mkdtemp(join(tmp, 'tinysdd-polyglot-verify-'));
      // Tests always come from a fresh dataset copy; only solution files are overlaid.
      await harnessStep(`verification workspace for ${exercise.id}`, () => d.prepareWorkspace({ checkoutDir, exercise, destDir: verifyRoot, overlay: Object.keys(solutionOverlay).length > 0 ? solutionOverlay : undefined }));
      const run = await harnessStep(`test run for ${exercise.id}`, () => d.runTests({ workDir: verifyRoot, language: exercise.language, timeoutMs: verifyTimeoutMs }));
      test = { passed: run.passed === true, exitCode: run.exitCode, timedOut: run.timedOut === true, durationMs: run.durationMs, outputTail: run.outputTail ?? '' };
    }

    const cumulative = result.observed?.cumulativeUsage ?? {};
    const attemptRecord = {
      n: attempt,
      workerOutcome: result.outcome,
      workerError: result.outcome === 'completed' ? null : (assistant.errorMessage ?? null),
      elapsedMs: result.observed?.processTermination?.elapsedMs ?? null,
      usage: { input: cumulative.input ?? 0, output: cumulative.output ?? 0 },
      toolCalls,
      changedFiles: [...new Set(changed)].sort(),
      scopeViolation: (result.scopeViolations?.length ?? 0) > 0 || (result.fileScope?.extraPaths?.length ?? 0) > 0,
      test,
    };
    await saveAttemptFiles({ attemptDir: join(caseDir, `attempt-${attempt}`), result, artifacts, packet, solutionOverlay, test });
    return attemptRecord;
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    if (verifyRoot) await rm(verifyRoot, { recursive: true, force: true }).catch(() => {});
  }
}
