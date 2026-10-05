import { join } from 'node:path';
import { dispatchWorker, publicError } from './controller.mjs';
import { atomicWriteJson } from './fs-utils.mjs';
import { isFailedWorkerOutcome } from './outcomes.mjs';

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_LAUNCH';
  return error;
}

const [projectRoot, taskId, workerName, launchDirectory, baseRunId, baselineRunId] = process.argv.slice(2);

// `worker stop` sends SIGTERM. Handling it (instead of the default exit) keeps
// this process alive to kill Pi and finalize the run as `stopped`. The handlers
// are once-only, so a second signal falls back to the default and kills it.
const stopController = new AbortController();
process.once('SIGTERM', () => stopController.abort());
process.once('SIGINT', () => stopController.abort());

try {
  if (![projectRoot, taskId, workerName, launchDirectory].every((value) => typeof value === 'string' && value.length > 0)) {
    throw invalid('worker launcher requires project root, task, worker, and launch directory');
  }
  const data = await dispatchWorker(projectRoot, {
    taskId,
    worker: workerName,
    baseRunId: baseRunId || undefined,
    baselineRunId: baselineRunId || undefined,
    signal: stopController.signal,
  });
  const failedOutcome = isFailedWorkerOutcome(data?.outcome);
  const scopeViolations = Array.isArray(data?.scopeViolations) && data.scopeViolations.length > 0;
  const stopped = data?.outcome === 'stopped';
  let code = 'WORKER_FAILED';
  let message = `worker ended with outcome ${data?.outcome}`;
  if (scopeViolations) {
    code = 'WORKER_SCOPE_VIOLATION';
    message = 'worker retained ineligible candidate changes';
  } else if (stopped) {
    code = 'WORKER_STOPPED';
    message = 'worker was stopped by the operator';
  }
  const result = failedOutcome || scopeViolations
    ? {
      ok: false,
      error: { code, message, details: { outcome: data?.outcome, scopeViolations: data?.scopeViolations ?? [] } },
      data,
    }
    : { ok: true, data };
  await atomicWriteJson(join(launchDirectory, 'result.json'), result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  await atomicWriteJson(join(launchDirectory, 'result.json'), { ok: false, error: publicError(error) });
  process.exitCode = 1;
}
