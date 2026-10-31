import { realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_MANAGED_PREFERENCES,
  OPENCODE_MACOS_MANAGED_DIRECTORY,
  OPENCODE_SANDBOX_BINARY,
  OPENCODE_SANDBOX_NODE_ROOT,
  OPENCODE_SANDBOX_STATE,
  assertPinnedVersion,
  buildOpenCodeConfig,
  openCodeArguments,
  openCodeEnvironment,
  openCodeVersion,
  preflightOpenCodeWorker,
  prepareOpenCodeEnvironment,
  validateOpenCodeWorker,
} from "../opencode-environment.mjs";
import { executablePath } from "../worker-host.mjs";

const MAX_CLAIM_BYTES = 128 * 1024;
const WRITE_TOOLS = new Set(["write", "edit", "patch"]);

/** OpenCode as bubblewrap sees it: its Node root for the relay launcher, the binary read-only, its state writable. */
export function openCodeBubblewrapInvocation({ nodeRoot, binaryPath, stateDir, args, env }) {
  return {
    launcher: `${OPENCODE_SANDBOX_NODE_ROOT}/bin/node`,
    argv: [OPENCODE_SANDBOX_BINARY, ...args],
    env,
    // Bun, which the OpenCode binary embeds, needs a procfs. Pi does not set this.
    procfs: true,
    mounts: [
      { source: nodeRoot, target: OPENCODE_SANDBOX_NODE_ROOT, writable: false },
      { source: binaryPath, target: OPENCODE_SANDBOX_BINARY, writable: false },
      { source: stateDir, target: OPENCODE_SANDBOX_STATE, writable: true },
    ],
  };
}

/** OpenCode as Seatbelt sees it. The managed-configuration locations are denied explicitly. */
export function openCodeSeatbeltInvocation({ stateDir, binaryPath }) {
  return {
    executable: binaryPath,
    program: { path: binaryPath, label: "OpenCode executable" },
    readable: [dirname(binaryPath)],
    writable: [stateDir],
    private: [OPENCODE_MACOS_MANAGED_DIRECTORY, ...OPENCODE_MANAGED_PREFERENCES],
  };
}

function executableCandidate({ runtime, test }) {
  if (test) return { path: runtime.opencodeExecutable, label: "test OpenCode executable" };
  return { path: runtime?.opencodeExecutable || join(homedir(), ".opencode", "bin", "opencode"), label: "OpenCode executable" };
}

async function identify(executable) {
  const version = assertPinnedVersion(await openCodeVersion(executable.resolved));
  return { version, root: null };
}

function sessionHostPath(prepared) {
  return join(prepared.stateDir, "events.jsonl");
}

async function buildInvocation({ sandbox, prepared, worker, prompt, executable }) {
  await writeFile(join(prepared.stateDir, "task-prompt.md"), prompt.rendered, { mode: 0o600 });
  const stateDir = sandbox === "seatbelt" ? await realpath(prepared.stateDir) : prepared.stateDir;
  const visible = sandbox === "bubblewrap" ? OPENCODE_SANDBOX_STATE : stateDir;
  const env = openCodeEnvironment({
    modelsPath: join(visible, "models.json"),
    configDir: join(visible, "config-dir"),
    home: join(visible, "home"),
    tmp: join(visible, "tmp"),
    xdg: {
      config: join(visible, "xdg", "config"),
      data: join(visible, "xdg", "data"),
      cache: join(visible, "xdg", "cache"),
      state: join(visible, "xdg", "state"),
    },
  });
  const args = openCodeArguments({ providerId: worker.provider, modelId: worker.model, promptPath: join(visible, "task-prompt.md") });
  if (sandbox === "test") return { argv: [executable.path, ...args], env };
  if (sandbox === "seatbelt") {
    return { argv: [executable.resolved, ...args], env, seatbelt: openCodeSeatbeltInvocation({ stateDir, binaryPath: executable.resolved }) };
  }
  // The relay forwarder runs under Node, so the host Node installation is mounted read-only, as the check runner does.
  const nodeRoot = dirname(dirname(process.execPath));
  await executablePath(join(nodeRoot, "bin", "node"), "Node executable in the OpenCode launcher root");
  return openCodeBubblewrapInvocation({ nodeRoot, binaryPath: executable.resolved, stateDir: prepared.stateDir, args, env });
}

function inferenceTarget({ prepared }) {
  return prepared.relayTarget;
}

// OpenCode gets its provider from its configuration, which names the relay. Nothing
// else is written into the sandbox, so there is no separate routing step.
async function routeInference() {}

/**
 * The configuration OpenCode reads, built after the relay exists: its URL and the per-run relay
 * token, and the run_checks plugin directory as the sandbox sees it when checks are available.
 */
function inferenceEnvironment({ prepared, worker, baseUrl, token, checkExtension = null }) {
  const { contextWindow, maxTokens } = prepared.metadata;
  return {
    [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(buildOpenCodeConfig({
      providerId: worker.provider,
      modelId: worker.model,
      baseUrl,
      apiKey: token,
      contextLimit: contextWindow,
      outputLimit: maxTokens,
      checkPlugin: checkExtension,
    })),
  };
}

function responseTokenLimit(metadata) {
  return { maxTokens: metadata.maxTokens ?? null, maxTokensSource: metadata.maxTokens === null ? "unknown" : "model" };
}

function tokenTotals(tokens) {
  const input = Number.isFinite(tokens?.input) ? tokens.input : 0;
  const output = Number.isFinite(tokens?.output) ? tokens.output : 0;
  const reasoning = Number.isFinite(tokens?.reasoning) ? tokens.reasoning : 0;
  const cacheRead = Number.isFinite(tokens?.cache?.read) ? tokens.cache.read : 0;
  const cacheWrite = Number.isFinite(tokens?.cache?.write) ? tokens.cache.write : 0;
  return { input, output, reasoning, cacheRead, cacheWrite, totalTokens: input + output + reasoning + cacheRead + cacheWrite };
}

/**
 * Parse `opencode run --format json` output, one event per line:
 * `{type, timestamp, sessionID, part}` with `tool_use` for a finished tool call,
 * `text`, `reasoning` (only with --thinking), `step_start`, `step_finish` and `error`.
 * Tool calls are counted when they finish, which is what the live limits need.
 */
export function parseEvents(text) {
  let toolCalls = 0;
  let writeCalls = 0;
  const toolCallsByName = {};
  const readPaths = [];
  const textParts = [];
  const steps = [];
  let errorMessage = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "tool_use") {
      toolCalls += 1;
      const name = typeof event.part?.tool === "string" ? event.part.tool : "unknown";
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
      if (WRITE_TOOLS.has(name)) writeCalls += 1;
      if (name === "read" && typeof event.part?.state?.input?.path === "string") readPaths.push(event.part.state.input.path);
    } else if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.push(event.part.text);
    } else if (event.type === "step_finish" && event.part && typeof event.part === "object") {
      steps.push(event.part);
    } else if (event.type === "error") {
      errorMessage = typeof event.error?.message === "string" ? event.error.message : "OpenCode reported an error";
    }
  }
  let claims = textParts.join("\n\n");
  let truncated = false;
  if (Buffer.byteLength(claims) > MAX_CLAIM_BYTES) {
    claims = claims.slice(0, MAX_CLAIM_BYTES);
    truncated = true;
  }
  const last = steps.at(-1) ?? null;
  const usage = last ? tokenTotals(last.tokens) : null;
  const cumulative = { assistantMessages: steps.length, input: 0, output: 0, reasoning: 0, totalTokens: 0 };
  for (const step of steps) {
    const totals = tokenTotals(step.tokens);
    cumulative.input += totals.input;
    cumulative.output += totals.output;
    cumulative.reasoning += totals.reasoning;
    cumulative.totalTokens += totals.totalTokens;
  }
  const stopReason = last?.reason ?? null;
  return {
    assistant: [],
    finalMessage: last ? { stopReason, usage } : null,
    stopReason,
    errorMessage,
    usage,
    toolCalls,
    writeCalls,
    toolCallsByName,
    readPaths,
    compactions: [],
    cumulativeUsage: cumulative,
    claims,
    claimsTruncated: truncated,
  };
}

export const openCodeRunner = Object.freeze({
  type: "opencode",
  label: "OpenCode",
  validateWorker: validateOpenCodeWorker,
  preflight: preflightOpenCodeWorker,
  executableCandidate,
  identify,
  prepareEnvironment: prepareOpenCodeEnvironment,
  sessionHostPath,
  buildInvocation,
  inferenceTarget,
  routeInference,
  inferenceEnvironment,
  responseTokenLimit,
  parseEvents,
  // run_checks is a local OpenCode plugin (src/run-checks-opencode-plugin.mjs).
  checkTool: "opencode-plugin",
});
