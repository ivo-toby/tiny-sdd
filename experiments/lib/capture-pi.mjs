import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const POLL_INTERVAL_MS = 50;
const READ_CHUNK_BYTES = 64 * 1024;
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('capturePi options are required');
  }

  const { executable, args = [], cwd, env, outputDir } = options;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new TypeError('executable must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new TypeError('cwd must be a string when provided');
  }
  if (env !== undefined && (env === null || typeof env !== 'object')) {
    throw new TypeError('env must be an object when provided');
  }
  if (typeof outputDir !== 'string' || outputDir.length === 0) {
    throw new TypeError('outputDir must be a non-empty string');
  }

  for (const [name, value] of [
    ['timeoutMs', options.timeoutMs],
    ['maxToolCalls', options.maxToolCalls],
    ['maxObservedTokens', options.maxObservedTokens],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`${name} must be a non-negative safe integer when provided`);
    }
  }

  return { executable, args, cwd, env, outputDir };
}

function scrubArgs(args) {
  const recorded = [...args];
  for (let index = 0; index < recorded.length; index += 1) {
    if (recorded[index] === '--api-key' && index + 1 < recorded.length) {
      recorded[index + 1] = '<redacted>';
    } else if (recorded[index].startsWith('--api-key=')) {
      recorded[index] = '--api-key=<redacted>';
    }
  }
  return recorded;
}

async function prepareOutputDir(outputDir) {
  await mkdir(dirname(outputDir), { recursive: true });

  let created = false;
  try {
    await mkdir(outputDir);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stats = await lstat(outputDir);
  if (!stats.isDirectory()) {
    throw new Error(`outputDir is not a directory: ${outputDir}`);
  }

  const entries = await readdir(outputDir);
  if (entries.length > 0) {
    throw new Error(`outputDir must be empty: ${outputDir}`);
  }

  return created;
}

function makeUsageState() {
  return {
    totals: Object.fromEntries(USAGE_KEYS.map((key) => [key, 0])),
    complete: true,
    usageRecords: 0,
  };
}

function observeUsage(state, usage) {
  state.usageRecords += 1;
  if (!usage || typeof usage !== 'object') {
    state.complete = false;
    return null;
  }

  const values = Object.fromEntries(
    USAGE_KEYS.map((key) => [key, usage[key]]),
  );
  const valid = USAGE_KEYS.every(
    (key) => Number.isFinite(values[key]) && values[key] >= 0,
  );
  if (!valid) {
    state.complete = false;
    return null;
  }

  for (const key of USAGE_KEYS) state.totals[key] += values[key];
  return USAGE_KEYS.reduce((total, key) => total + values[key], 0);
}

function makeTokenUsage(state) {
  if (!state.complete) {
    return {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      observed: null,
      totalTokens: null,
      known: false,
      unknown: true,
      missing: true,
      assistantMessagesWithUsage: state.usageRecords,
    };
  }

  const observed = USAGE_KEYS.reduce((total, key) => total + state.totals[key], 0);
  return {
    ...state.totals,
    observed,
    totalTokens: observed,
    known: state.usageRecords > 0,
    unknown: state.usageRecords === 0,
    missing: state.usageRecords === 0,
    assistantMessagesWithUsage: state.usageRecords,
  };
}

function killProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // detached:true makes the child the process-group leader on Linux. The
    // negative PID targets exactly that process group, including descendants.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function parseError(lineNumber, error) {
  return {
    line: lineNumber,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Run a Pi-compatible JSON-mode process and preserve its bounded raw output.
 *
 * This is deliberately a process adapter, not a Pi SDK/client: callers supply
 * the executable and complete argv (including any prompt), and stdin is EOF.
 */
export async function capturePi(options) {
  const { executable, args, cwd, env, outputDir } = validateOptions(options);
  await prepareOutputDir(outputDir);

  const stdoutPath = join(outputDir, 'stdout.jsonl');
  const stderrPath = join(outputDir, 'stderr.txt');
  const resultPath = join(outputDir, 'result.json');
  const stdoutFile = await open(stdoutPath, 'wx', 0o600);
  const stderrFile = await open(stderrPath, 'wx', 0o600);
  const recordedArgs = scrubArgs(args);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const monotonicStart = process.hrtime.bigint();

  const counts = {
    toolExecutionStarts: 0,
    assistantMessageEnds: 0,
  };
  const usageState = makeUsageState();
  const parseErrors = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTotalBytes = 0;
  let stderrTotalBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stdoutBuffer = Buffer.alloc(0);
  let stdoutLineNumber = 0;
  let stopReason;
  let stopRequested = false;
  let killTimer;
  let wallTimer;
  let child;
  let spawnError;
  let exitCode = null;
  let signal = null;
  let stdoutReader;
  let stderrReader;
  let childClosed = false;
  let childClose;
  let killPromise;

  const recordStreamError = (error) => {
    spawnError ??= {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      code: error?.code,
    };
  };

  const timeoutMs = options.timeoutMs;
  const maxToolCalls = options.maxToolCalls;
  const maxObservedTokens = options.maxObservedTokens;

  const requestStop = (reason) => {
    if (stopRequested) return;
    stopRequested = true;
    stopReason = reason;
    if (childClosed || !child?.pid) return;

    let termSent = false;
    try {
      termSent = killProcessGroup(child.pid, 'SIGTERM');
    } catch (error) {
      spawnError ??= {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        code: error?.code,
      };
    }

    if (termSent) {
      killPromise = new Promise((resolve) => {
        killTimer = setTimeout(() => {
          try {
            killProcessGroup(child.pid, 'SIGKILL');
          } catch (error) {
            spawnError ??= {
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
              code: error?.code,
            };
          } finally {
            resolve();
          }
        }, TERM_GRACE_MS);
      });
    }
  };

  const inspectEvent = (event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;

    if (event.type === 'tool_execution_start') {
      counts.toolExecutionStarts += 1;
      if (
        maxToolCalls !== undefined &&
        counts.toolExecutionStarts >= maxToolCalls
      ) {
        requestStop('tool_limit');
      }
    }

    if (
      event.type === 'message_end' &&
      event.message &&
      typeof event.message === 'object' &&
      event.message.role === 'assistant'
    ) {
      counts.assistantMessageEnds += 1;
      const observed = observeUsage(usageState, event.message.usage);
      if (
        observed !== null &&
        maxObservedTokens !== undefined &&
        usageState.complete &&
        makeTokenUsage(usageState).observed >= maxObservedTokens
      ) {
        requestStop('token_limit');
      }
    }
  };

  const inspectLine = (line) => {
    stdoutLineNumber += 1;
    let event;
    try {
      const text = line.at(-1) === 0x0d
        ? line.subarray(0, line.length - 1).toString('utf8')
        : line.toString('utf8');
      event = JSON.parse(text);
    } catch (error) {
      parseErrors.push(parseError(stdoutLineNumber, error));
      return;
    }
    inspectEvent(event);
  };

  const inspectStdout = (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf(0x0a)) !== -1) {
      inspectLine(stdoutBuffer.subarray(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
    }
  };

  const pollFile = async (file, kind) => {
    const size = Number((await file.stat()).size);
    if (kind === 'stdout') stdoutTotalBytes = Math.max(stdoutTotalBytes, size);
    else stderrTotalBytes = Math.max(stderrTotalBytes, size);

    const overLimit = size > MAX_STREAM_BYTES;
    if (kind === 'stdout' && overLimit) stdoutTruncated = true;
    if (kind === 'stderr' && overLimit) stderrTruncated = true;
    if (overLimit) requestStop('output_limit');

    let offset = kind === 'stdout' ? stdoutBytes : stderrBytes;
    const limit = Math.min(size, MAX_STREAM_BYTES);
    while (offset < limit) {
      const length = Math.min(READ_CHUNK_BYTES, limit - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (kind === 'stdout') inspectStdout(buffer.subarray(0, bytesRead));
    }
    if (kind === 'stdout') stdoutBytes = offset;
    else stderrBytes = offset;
  };

  const pollOutput = async () => {
    if (stdoutReader) await pollFile(stdoutReader, 'stdout');
    if (stderrReader) await pollFile(stderrReader, 'stderr');
  };

  const truncateIfNeeded = async (path, truncated) => {
    if (!truncated) return;
    const file = await open(path, 'r+');
    try {
      await file.truncate(MAX_STREAM_BYTES);
    } finally {
      await file.close();
    }
  };

  try {
    try {
      child = spawn(executable, args, {
        cwd,
        env: env ?? process.env,
        shell: false,
        detached: true,
        stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
      });
    } catch (error) {
      spawnError = {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        code: error?.code,
      };
      stopReason = 'spawn_error';
    }

    if (child) {
      child.once('error', (error) => {
        spawnError ??= {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          code: error?.code,
        };
        if (!stopReason) stopReason = 'spawn_error';
      });
      if (timeoutMs !== undefined) {
        wallTimer = setTimeout(() => requestStop('timeout'), timeoutMs);
        wallTimer.unref();
      }
      childClose = new Promise((resolve) => {
        child.once('close', (code, childSignal) => {
          exitCode = code;
          signal = childSignal;
          childClosed = true;
          if (wallTimer) clearTimeout(wallTimer);
          resolve();
        });
      });
    }

    await stdoutFile.close();
    await stderrFile.close();

    if (child) {
      stdoutReader = await open(stdoutPath, 'r');
      stderrReader = await open(stderrPath, 'r');

      while (!childClosed) {
        await Promise.race([
          childClose,
          new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
        ]);
        if (childClosed) break;
        try {
          await pollOutput();
        } catch (error) {
          recordStreamError(error);
          requestStop('spawn_error');
        }
        if (childClosed) break;
      }
      await childClose;
      if (killPromise) await killPromise;
      try {
        await pollOutput();
      } catch (error) {
        recordStreamError(error);
      }
    }
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (stdoutBuffer.length > 0) inspectLine(stdoutBuffer);
    if (stdoutReader) await stdoutReader.close().catch(recordStreamError);
    if (stderrReader) await stderrReader.close().catch(recordStreamError);
  }

  await truncateIfNeeded(stdoutPath, stdoutTruncated);
  await truncateIfNeeded(stderrPath, stderrTruncated);

  if (!stopReason) {
    stopReason = exitCode === 0 && signal === null ? 'completed' : 'nonzero';
  }
  if (spawnError && stopReason !== 'timeout' && stopReason !== 'tool_limit' && stopReason !== 'token_limit' && stopReason !== 'output_limit') {
    stopReason = 'spawn_error';
  }

  const tokenUsage = makeTokenUsage(usageState);
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const wallMs = Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;
  const result = {
    command: {
      executable,
      args: recordedArgs,
      cwd: cwd ?? process.cwd(),
    },
    startedAt,
    endedAt,
    wallMs: Math.round(wallMs),
    exitCode,
    signal,
    stopReason,
    counts: {
      ...counts,
      toolCalls: counts.toolExecutionStarts,
      assistantMessages: counts.assistantMessageEnds,
    },
    tokenUsage,
    limits: {
      maxToolCalls: maxToolCalls ?? null,
      maxObservedTokens: maxObservedTokens ?? null,
      toolCallsOvershoot:
        maxToolCalls === undefined
          ? null
          : Math.max(0, counts.toolExecutionStarts - maxToolCalls),
      observedTokensOvershoot:
        maxObservedTokens === undefined || tokenUsage.observed === null
          ? null
          : Math.max(0, tokenUsage.observed - maxObservedTokens),
    },
    output: {
      stdoutBytes,
      stderrBytes,
      stdoutTotalBytes,
      stderrTotalBytes,
      stdoutTruncated,
      stderrTruncated,
    },
    parseErrors,
    spawnError: spawnError ?? null,
    files: {
      stdout: 'stdout.jsonl',
      stderr: 'stderr.txt',
      result: 'result.json',
    },
  };

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return result;
}
