import { join } from 'node:path';
import { dispatchWorker, publicError } from './controller.mjs';
import { atomicWriteJson } from './fs-utils.mjs';

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_LAUNCH';
  return error;
}

const [projectRoot, taskId, workerName, launchDirectory, baseRunId, baselineRunId] = process.argv.slice(2);

try {
  if (![projectRoot, taskId, workerName, launchDirectory].every((value) => typeof value === 'string' && value.length > 0)) {
    throw invalid('worker launcher requires project root, task, worker, and launch directory');
  }
  const data = await dispatchWorker(projectRoot, {
    taskId,
    worker: workerName,
    baseRunId: baseRunId || undefined,
    baselineRunId: baselineRunId || undefined,
  });
  const failedOutcome = ['failed', 'timeout', 'tool_limit', 'output_limit'].includes(data?.outcome);
  const scopeViolations = Array.isArray(data?.scopeViolations) && data.scopeViolations.length > 0;
  const result = failedOutcome || scopeViolations
    ? {
      ok: false,
      error: {
        code: scopeViolations ? 'WORKER_SCOPE_VIOLATION' : 'WORKER_FAILED',
        message: scopeViolations ? 'worker changed paths outside packet.allowedPaths' : `worker ended with outcome ${data.outcome}`,
        details: { outcome: data?.outcome, scopeViolations: data?.scopeViolations ?? [] },
      },
      data,
    }
    : { ok: true, data };
  await atomicWriteJson(join(launchDirectory, 'result.json'), result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  await atomicWriteJson(join(launchDirectory, 'result.json'), { ok: false, error: publicError(error) });
  process.exitCode = 1;
}
