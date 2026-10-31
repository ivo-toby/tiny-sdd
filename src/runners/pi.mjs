import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PI_DEFAULT_MAX_TOKENS, preflightPiWorker, preparePiEnvironment, validatePiWorker } from "../pi-environment.mjs";
import { relayPiProvider } from "../inference-relay.mjs";
import { stableStringify } from "../deterministic-compaction.mjs";
import { executablePath, existingAbsoluteDirectory, fail, writeJson } from "../worker-host.mjs";

const MAX_CLAIM_BYTES = 128 * 1024;
const WRITE_TOOLS = new Set(["write", "edit"]);
const SANDBOX_STATE = "/pi-state";
const SANDBOX_NODE_ROOT = "/opt/node";

function buildPiArgs({ provider, model, sessionPath, thinking, systemPromptPath, userPrompt, checkExtension, compactionExtension }) {
  const args = [
    "--offline",
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    // --no-extensions already leaves out the built-in MCP extension in Pi 1.4.0;
    // this also keeps any MCP server config (for example a project .pi/mcp.json) from connecting.
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--tools",
    checkExtension ? "read,write,edit,run_checks" : "read,write,edit",
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking,
    "--session",
    sessionPath,
    "--append-system-prompt",
    systemPromptPath,
  ];
  for (const extension of [checkExtension, compactionExtension].filter(Boolean)) args.push("-e", extension);
  args.push(userPrompt);
  return args;
}

/** Pi as bubblewrap sees it: its Node installation read-only, its state writable. */
export function piBubblewrapInvocation({ nodeRoot, stateDir, args }) {
  return {
    launcher: `${SANDBOX_NODE_ROOT}/bin/node`,
    argv: [`${SANDBOX_NODE_ROOT}/bin/pi`, ...args],
    env: { HOME: "/home", PI_CODING_AGENT_DIR: SANDBOX_STATE, PATH: `${SANDBOX_NODE_ROOT}/bin:/usr/bin:/bin` },
    mounts: [
      { source: nodeRoot, target: SANDBOX_NODE_ROOT, writable: false },
      { source: stateDir, target: SANDBOX_STATE, writable: true },
    ],
  };
}

/** Pi as Seatbelt sees it; `private` is the user's original Pi state. */
export function piSeatbeltInvocation({ stateDir, sourceAgentDir, nodeExecutable, piExecutable, piRoot }) {
  return {
    executable: nodeExecutable,
    program: { path: piExecutable, label: "Pi executable" },
    readable: [piRoot],
    writable: [stateDir],
    private: [sourceAgentDir],
  };
}

function executableCandidate({ runtime, test, platform }) {
  if (test) return { path: runtime.piExecutable, label: "test Pi executable" };
  const fallback = join(dirname(process.execPath), "pi");
  return { path: platform === "darwin" ? runtime?.piExecutable ?? fallback : runtime?.piExecutable || fallback, label: "Pi executable" };
}

async function identify(executable, { test }) {
  let current = dirname(executable.resolved);
  let info = { version: null, root: null };
  for (let count = 0; count < 8; count += 1) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
        info = { version: packageJson.version, root: current };
        break;
      }
    } catch {
      // Continue toward the bounded install root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { version: test ? "test-harness" : info.version, root: info.root };
}

async function buildInvocation({ sandbox, prepared, worker, profile, prompt, executable, node, packageRoot, checkExtension, compactionExtension }) {
  await writeFile(join(prepared.stateDir, "system-prompt.txt"), prompt.system, { mode: 0o600 });
  const thinking = profile?.runtime?.thinking ?? "off";
  const stateDir = sandbox === "seatbelt" ? await realpath(prepared.stateDir) : prepared.stateDir;
  const visibleState = sandbox === "bubblewrap" ? SANDBOX_STATE : stateDir;
  await writeFile(join(prepared.stateDir, "task-prompt.txt"), prompt.user, { mode: 0o600 });
  const promptArgumentPath = join(visibleState, "task-prompt.txt");
  const args = buildPiArgs({
    checkExtension,
    compactionExtension,
    provider: worker.provider,
    model: worker.model,
    sessionPath: join(visibleState, "session.jsonl"),
    thinking,
    systemPromptPath: join(visibleState, "system-prompt.txt"),
    userPrompt: promptArgumentPath.startsWith("/") ? `@${promptArgumentPath}` : prompt.user,
  });
  if (sandbox === "test") {
    return { argv: [executable.path, ...args], env: { ...prepared.env, HOME: prepared.env.HOME } };
  }
  if (sandbox === "seatbelt") {
    if (!packageRoot) fail("Cannot identify the installed Pi package for the macOS sandbox");
    const sourceAgentDir = await realpath(dirname(prepared.sourceModelsPath));
    await mkdir(join(stateDir, "home"), { mode: 0o700 });
    await mkdir(join(stateDir, "tmp"), { mode: 0o700 });
    return {
      argv: [node.resolved, executable.resolved, ...args],
      env: { HOME: join(stateDir, "home"), TMPDIR: join(stateDir, "tmp"), PATH: dirname(node.resolved), PI_CODING_AGENT_DIR: stateDir },
      seatbelt: piSeatbeltInvocation({ stateDir, sourceAgentDir, nodeExecutable: node.resolved, piExecutable: executable.resolved, piRoot: packageRoot }),
    };
  }
  // Pi is installed inside a Node installation, which bubblewrap mounts whole.
  const nodeRoot = dirname(dirname(executable.path));
  await existingAbsoluteDirectory(nodeRoot, "Pi installation root");
  await executablePath(join(nodeRoot, "bin", "node"), "Node executable in the Pi installation root");
  return piBubblewrapInvocation({ nodeRoot, stateDir: prepared.stateDir, args });
}

function sessionHostPath(prepared) {
  return join(prepared.stateDir, "session.jsonl");
}

async function inferenceTarget({ prepared, worker }) {
  const models = JSON.parse(await readFile(join(prepared.stateDir, "models.json"), "utf8"));
  const provider = models.providers[worker.provider];
  return { provider, model: provider.models[0] };
}

async function routeInference({ prepared, worker, target, baseUrl }) {
  await writeJson(join(prepared.stateDir, "models.json"), { providers: { [worker.provider]: relayPiProvider(target.provider, target.model, baseUrl, worker.provider) } });
}

function responseTokenLimit(metadata) {
  return { maxTokens: metadata.maxTokens ?? PI_DEFAULT_MAX_TOKENS, maxTokensSource: metadata.maxTokens === null ? "pi-default" : "model" };
}

export function parseEvents(text) {
  const assistant = [];
  const turnEnds = [];
  let toolCalls = 0;
  let writeCalls = 0;
  const toolCallsByName = {};
  const readPaths = [];
  const compactions = [];
  // Pi 1.4.0 announces the tools it declares to the model in a system message before the first turn.
  let toolLoadout = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      const name = typeof event.toolName === "string" ? event.toolName : "unknown";
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
      if (WRITE_TOOLS.has(name)) writeCalls += 1;
      if (name === "read" && typeof event.args?.path === "string") readPaths.push(event.args.path);
    }
    if (event.type === "compaction_end") {
      const summary = typeof event.result?.summary === "string" ? event.result.summary : null;
      const details = event.result?.details && typeof event.result.details === "object" ? event.result.details : null;
      const detailsSerialized = details === null ? null : stableStringify(details);
      compactions.push({
        reason: event.reason ?? null,
        aborted: event.aborted === true,
        tokensBefore: Number.isFinite(event.result?.tokensBefore) ? event.result.tokensBefore : null,
        estimatedTokensAfter: Number.isFinite(event.result?.estimatedTokensAfter) ? event.result.estimatedTokensAfter : null,
        summarySha256: summary === null ? null : createHash("sha256").update(summary).digest("hex"),
        summaryBytes: summary === null ? null : Buffer.byteLength(summary),
        detailsSha256: detailsSerialized === null ? null : createHash("sha256").update(detailsSerialized).digest("hex"),
        detailsBytes: detailsSerialized === null ? null : Buffer.byteLength(detailsSerialized),
        details,
        deterministic: details?.strategy === "deterministic",
        fromHook: event.result?.fromHook === true || details?.strategy === "deterministic",
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : null,
      });
    }
    if (toolLoadout === null && event.message?.role === "system" && Array.isArray(event.message.toolsAdded)) {
      toolLoadout = event.message.toolsAdded.map((tool) => tool?.name).filter((name) => typeof name === "string");
    }
    if (event.type === "message_end" && event.message?.role === "assistant") assistant.push(event.message);
    else if (event.type === "turn_end" && event.message?.role === "assistant") turnEnds.push(event.message);
    if (event.type === "toolCall" || event.type === "tool_call") toolCalls += 1;
  }
  const authoritative = assistant.length > 0 ? assistant : turnEnds;
  const finalMessage = authoritative.at(-1) ?? null;
  const textParts = [];
  for (const message of authoritative) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === "text" && typeof part.text === "string") textParts.push(part.text);
  }
  // Sum of per-response usage. Input is re-counted on every response because
  // each request resends the context; it is not unique prompt tokens.
  const cumulativeUsage = { assistantMessages: authoritative.length, input: 0, output: 0, reasoning: null, totalTokens: 0 };
  for (const message of authoritative) {
    const usage = message.usage ?? {};
    for (const key of ["input", "output", "totalTokens"]) if (Number.isFinite(usage[key])) cumulativeUsage[key] += usage[key];
    if (Number.isFinite(usage.reasoning)) cumulativeUsage.reasoning = (cumulativeUsage.reasoning ?? 0) + usage.reasoning;
  }
  let claims = textParts.join("\n\n");
  let truncated = false;
  if (Buffer.byteLength(claims) > MAX_CLAIM_BYTES) {
    claims = claims.slice(0, MAX_CLAIM_BYTES);
    truncated = true;
  }
  const stopReason = finalMessage?.stopReason ?? finalMessage?.rawStopReason ?? null;
  const errorMessage = finalMessage?.errorMessage ?? finalMessage?.error?.message ?? null;
  return { assistant: authoritative, finalMessage, stopReason, errorMessage, usage: finalMessage?.usage ?? null, toolCalls, writeCalls, toolCallsByName, readPaths, compactions, toolLoadout, cumulativeUsage, claims, claimsTruncated: truncated };
}

export const piRunner = Object.freeze({
  type: "pi",
  label: "Pi",
  validateWorker: validatePiWorker,
  preflight: preflightPiWorker,
  executableCandidate,
  identify,
  prepareEnvironment: preparePiEnvironment,
  sessionHostPath,
  buildInvocation,
  inferenceTarget,
  routeInference,
  responseTokenLimit,
  parseEvents,
});
