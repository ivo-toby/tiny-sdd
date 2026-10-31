import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_TOOL_CALLS } from "./config.mjs";
import { stripJsonComments } from "./pi-environment.mjs";

/**
 * OpenCode as a TinySDD worker. Everything OpenCode reads is decided here: the
 * run gets its own HOME and XDG roots, an empty config directory, an empty
 * model catalog and one provider entry that points at the inference relay.
 * Nothing from the host's OpenCode configuration, data or environment is passed in.
 */

const execFileAsync = promisify(execFile);

// Pinned runtime. Source: tag v2.1.4, commit 68bc26b of the OpenCode repository.
export const OPENCODE_VERSION = "2.1.4";
export const OPENCODE_SOURCE_COMMIT = "68bc26b";
export const OPENCODE_PACKAGE = "@ai-sdk/openai-compatible";
export const OPENCODE_SANDBOX_STATE = "/opencode-state";
export const OPENCODE_SANDBOX_BINARY = "/opt/opencode/bin/opencode";
export const OPENCODE_SANDBOX_NODE_ROOT = "/opt/node";
// The agent is OpenCode's default one. Its own permission rules come before ours,
// and every config rule comes after them, so ours decide.
export const OPENCODE_AGENT = "build";
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
export const OPENCODE_MESSAGE = "Follow the attached TinySDD task packet exactly. It starts with the worker contract.";
// Only read, write and edit are allowed. A `*` deny is the last rule that matches
// the `external_directory`, `shell`, `webfetch`, `question`, `subagent` and other
// actions, so they are refused without asking. Write and edit share the `edit`
// action (tool/plugin/write.ts, edit.ts), and `patch` uses that action too.
export const OPENCODE_PERMISSIONS = Object.freeze([
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
]);
// The OPENCODE_* names the worker sets. Anything else OpenCode reads from the environment is absent.
export const OPENCODE_ENV_NAMES = Object.freeze([
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_FILEWATCHER",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_MODELS_PATH",
]);
// Host locations OpenCode reads for managed (organization) configuration. The
// worker never reads them, and the sandboxes must not expose them.
export const OPENCODE_MACOS_MANAGED_DIRECTORY = "/Library/Application Support/opencode";
export const OPENCODE_LINUX_MANAGED_DIRECTORY = "/etc/opencode";
export const OPENCODE_MANAGED_PREFERENCES = ["/Library/Managed Preferences"];
const SECRET_PLACEHOLDER = "TINYSDD_PI_SECRET_0";
const ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_.-]+$/u;
const MODEL_ID_FORBIDDEN = /[#{}\x00-\x1f\x7f]/u;
const VERSION_LINE = /^opencode v(\S+)$/u;

export const OPENCODE_DEFAULT_TOOL_LIMIT = DEFAULT_MAX_TOOL_CALLS;
export const OPENCODE_MAX_TOOL_LIMIT = MAX_TOOL_CALLS;

export class OpenCodeEnvironmentError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OpenCodeEnvironmentError";
  }
}

function fail(message) {
  throw new OpenCodeEnvironmentError(message);
}

export function validateOpenCodeWorker(worker) {
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) fail("OpenCode worker configuration is required");
  if (worker.type !== "opencode") fail(`Unsupported worker adapter: ${String(worker.type ?? "missing")}`);
  if (typeof worker.provider !== "string" || worker.provider.length === 0) fail("OpenCode worker.provider is required");
  if (!PROVIDER_ID.test(worker.provider)) fail("OpenCode worker.provider may contain only letters, digits, '.', '_' and '-'");
  if (typeof worker.model !== "string" || worker.model.length === 0) fail("OpenCode worker.model is required");
  if (MODEL_ID_FORBIDDEN.test(worker.model)) fail("OpenCode worker.model cannot contain '#', braces or control characters");
  if (typeof worker.opencodeConfig !== "string" || worker.opencodeConfig.length === 0) {
    fail("OpenCode worker.opencodeConfig is required: an absolute path to the OpenCode config file that defines the provider");
  }
  const limits = worker.limits ?? {};
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) fail("OpenCode worker.limits must be an object");
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxToolCalls = limits.maxToolCalls ?? OPENCODE_DEFAULT_TOOL_LIMIT;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(`OpenCode timeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}]`);
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls <= 0 || maxToolCalls > OPENCODE_MAX_TOOL_LIMIT) {
    fail(`OpenCode maxToolCalls must be an integer in (0, ${OPENCODE_MAX_TOOL_LIMIT}]`);
  }
  const firstWriteMs = limits.firstWriteMs ?? null;
  if (firstWriteMs !== null && (!Number.isInteger(firstWriteMs) || firstWriteMs <= 0 || firstWriteMs >= timeoutMs)) {
    fail("OpenCode firstWriteMs must be a positive integer below timeoutMs");
  }
  const maxCheckRuns = limits.maxCheckRuns === undefined ? 12 : limits.maxCheckRuns;
  if (!Number.isInteger(maxCheckRuns) || maxCheckRuns < 1 || maxCheckRuns > 20) fail("OpenCode maxCheckRuns must be an integer from 1 to 20");
  return { timeoutMs, maxToolCalls, firstWriteMs, maxCheckRuns };
}

function httpBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail(`${label} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/u, "");
}

/**
 * Read the provider the operator named. The file is OpenCode's own config format:
 * `provider.<id>` with `npm`, `options` and `models` (V1), or `providers.<id>` with
 * `package`, `settings` and `models` (native). Only the named provider and model are
 * read. The API key must be an `{env:NAME}` reference, so the file holds no secret.
 */
export async function readOperatorProvider({ worker, sourceEnv = process.env }) {
  let text;
  try {
    text = await readFile(worker.opencodeConfig, "utf8");
  } catch (error) {
    fail(`Cannot read OpenCode config ${worker.opencodeConfig}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let document;
  try {
    document = JSON.parse(stripJsonComments(text));
  } catch {
    // Do not echo parser output: the file can contain references to secrets.
    fail(`Cannot parse OpenCode config ${worker.opencodeConfig}`);
  }
  const native = document?.providers?.[worker.provider];
  const legacy = document?.provider?.[worker.provider];
  if (native !== undefined && legacy !== undefined) fail(`OpenCode config defines provider ${worker.provider} twice`);
  const entry = native ?? legacy;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`OpenCode config has no provider ${worker.provider}`);
  const packageName = native ? entry.package : entry.npm;
  if (packageName !== OPENCODE_PACKAGE) {
    fail(`OpenCode provider ${worker.provider} uses ${JSON.stringify(packageName ?? "no package")}; only ${OPENCODE_PACKAGE} (openai-completions) is supported`);
  }
  const options = (native ? entry.settings : entry.options) ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) fail(`OpenCode provider ${worker.provider} options must be an object`);
  // The relay sends only `Authorization: Bearer` (from options.apiKey). A User-Agent is
  // ignored with a warning; any other header is refused, and its value is never shown.
  const ignoredHeaders = [];
  for (const source of [entry.headers, options.headers]) {
    if (source === undefined) continue;
    if (!source || typeof source !== "object" || Array.isArray(source)) fail(`OpenCode provider ${worker.provider} headers must be an object`);
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== "string") fail(`OpenCode provider ${worker.provider} header ${name} must be a string`);
      if (name.toLowerCase() === "user-agent") {
        ignoredHeaders.push(name);
        continue;
      }
      fail(`OpenCode provider ${worker.provider} sets header ${name}, which the sandboxed worker cannot send. Set options.apiKey to an {env:NAME} reference instead; the relay sends it as Authorization: Bearer`);
    }
  }
  if (typeof options.baseURL !== "string") fail(`OpenCode provider ${worker.provider} needs options.baseURL`);
  const baseUrl = httpBaseUrl(options.baseURL, `OpenCode provider ${worker.provider}.baseURL`);
  let apiKey = null;
  if (options.apiKey !== undefined) {
    const reference = typeof options.apiKey === "string" ? options.apiKey.match(ENV_REFERENCE) : null;
    if (!reference) fail(`OpenCode provider ${worker.provider}.apiKey must be an {env:NAME} reference`);
    const value = sourceEnv[reference[1]];
    if (typeof value !== "string" || value.length === 0) fail(`Required OpenCode credential environment variable is unavailable: ${reference[1]}`);
    apiKey = value;
  }
  const models = entry.models ?? {};
  const model = models[worker.model];
  if (!model || typeof model !== "object") fail(`OpenCode provider ${worker.provider} does not define model ${worker.model}`);
  const limit = model.limit && typeof model.limit === "object" ? model.limit : {};
  const contextLimit = Number.isInteger(limit.context) && limit.context > 0 ? limit.context : null;
  const outputLimit = Number.isInteger(limit.output) && limit.output > 0 ? limit.output : null;
  return { providerId: worker.provider, modelId: worker.model, baseUrl, apiKey, contextLimit, outputLimit, ignoredHeaders };
}

/** The config OpenCode reads from OPENCODE_CONFIG_CONTENT. It uses the relay URL and the per-run token only. */
export function buildOpenCodeConfig({ providerId, modelId, baseUrl, apiKey, contextLimit = null, outputLimit = null }) {
  const limit = {
    ...(contextLimit === null ? {} : { context: contextLimit }),
    ...(outputLimit === null ? {} : { output: outputLimit }),
  };
  const config = {
    providers: {
      [providerId]: {
        package: OPENCODE_PACKAGE,
        settings: { baseURL: baseUrl, ...(apiKey === null ? {} : { apiKey }) },
        models: { [modelId]: { name: modelId, ...(Object.keys(limit).length === 0 ? {} : { limit }) } },
      },
    },
    permissions: OPENCODE_PERMISSIONS.map((rule) => ({ ...rule })),
    // Compaction is a model call that OpenCode may run without a prompt. The
    // worker has no deterministic compaction on this runner, so it stays off.
    compaction: { auto: false },
    // Each of these would start a program or a network client from inside the sandbox.
    formatter: false,
    lsp: false,
    snapshots: false,
    share: "disabled",
    update: "disable",
    agents: { title: { disabled: true }, summary: { disabled: true } },
  };
  return config;
}

/** Environment for OpenCode with state and home at the given paths. Nothing from the host is copied. */
export function openCodeEnvironment({ modelsPath, configDir, home, tmp, xdg, pathValue = "/usr/bin:/bin" }) {
  return {
    PATH: pathValue,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DB: ":memory:",
    OPENCODE_MODELS_PATH: modelsPath,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

/** Argv for one headless run. `--standalone` keeps the run out of the shared background service. */
export function openCodeArguments({ providerId, modelId, promptPath }) {
  return [
    "run",
    "--format",
    "json",
    "--standalone",
    "--agent",
    OPENCODE_AGENT,
    "--model",
    `${providerId}/${modelId}`,
    "--file",
    promptPath,
    OPENCODE_MESSAGE,
  ];
}

export function isManagedDirectoryPresent(path) {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

export async function hostManagedConfigPresence() {
  const system = (await isManagedDirectoryPresent(OPENCODE_MACOS_MANAGED_DIRECTORY)) || (await isManagedDirectoryPresent(OPENCODE_LINUX_MANAGED_DIRECTORY));
  const preferences = await stat(join(OPENCODE_MANAGED_PREFERENCES[0], "ai.opencode.managed.plist")).then(
    (info) => info.isFile(),
    () => false,
  );
  // Presence only: contents are never read.
  return { systemDirectory: system, managedPreferences: preferences };
}

/** The OpenCode version at `executable`, run with an empty environment outside any worker sandbox. */
export async function openCodeVersion(executable) {
  const home = await mkdtemp(join(tmpdir(), "tinysdd-opencode-version-"));
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      cwd: home,
      timeout: 15_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = String(stdout).trim().match(VERSION_LINE);
    if (!match) fail("Cannot identify the OpenCode executable: unexpected --version output");
    return match[1];
  } catch (error) {
    if (error instanceof OpenCodeEnvironmentError) throw error;
    fail(`Cannot run the OpenCode executable for version identification: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function assertPinnedVersion(version) {
  if (version !== OPENCODE_VERSION) {
    fail(`OpenCode ${version} is installed, but the worker is pinned to ${OPENCODE_VERSION} (source tag v${OPENCODE_VERSION}, commit ${OPENCODE_SOURCE_COMMIT})`);
  }
  return version;
}

/** Check the worker's OpenCode settings without creating state. */
export async function preflightOpenCodeWorker({ worker, profile = null, sourceEnv = process.env } = {}) {
  validateOpenCodeWorker(worker);
  const provider = await readOperatorProvider({ worker, sourceEnv });
  const errors = [];
  const warnings = [];
  const thinking = profile?.runtime?.thinking ?? "off";
  if (thinking !== "off") errors.push(`OpenCode worker runtime.thinking "${thinking}" cannot be applied: the OpenCode runner sends no thinking level`);
  if (profile?.runtime?.compaction?.enabled === true) {
    errors.push("OpenCode worker has no deterministic compaction: runtime.compaction.enabled cannot be applied");
  }
  for (const name of provider.ignoredHeaders) warnings.push(`provider header ${name} is ignored: the relay does not forward it`);
  if (profile?.runtime?.compat !== undefined || profile?.runtime?.reasoning !== undefined || profile?.runtime?.thinkingBudgets !== undefined) {
    warnings.push("profile runtime.compat, runtime.reasoning and runtime.thinkingBudgets are not applied by the OpenCode runner");
  }
  return {
    basis: "OpenCode 2.1.4 config and run source (tag v2.1.4, commit 68bc26b)",
    thinking: { control: "none", reason: "the OpenCode runner sends no thinking level", requested: thinking },
    maxTokens: { value: provider.outputLimit, source: provider.outputLimit === null ? "unknown" : "model" },
    thinkingTokenBudgetField: null,
    thinkingBudget: null,
    compaction: { enabled: false, deterministic: "unavailable", reason: "OpenCode runner: auto-compaction is disabled and deterministic compaction is not implemented" },
    endpointFingerprint: `${new URL(provider.baseUrl).origin}${new URL(provider.baseUrl).pathname}`,
    effectiveReasoning: null,
    effectiveCompat: null,
    errors,
    warnings,
    modelSettings: {
      provider: provider.providerId,
      model: provider.modelId,
      api: "openai-completions",
      source: worker.opencodeConfig,
      contextWindow: provider.contextLimit ?? "UNKNOWN",
      contextWindowSource: provider.contextLimit === null ? "UNKNOWN" : "model",
    },
  };
}

/**
 * Prepare the run state: home, XDG roots, an empty config directory, an empty model
 * catalog and the relay target. The caller must call `cleanup()` in a finally block.
 */
export async function prepareOpenCodeEnvironment({ worker, profile = null, sourceEnv = process.env } = {}) {
  const limits = validateOpenCodeWorker(worker);
  for (const [key, value] of Object.entries(profile?.limits ?? {})) {
    if (limits[key] !== value) fail(`Worker limits.${key} is ${limits[key]} but profile ${profile.id} requires ${value}; resolve the profile through the project config`);
  }
  const preflight = await preflightOpenCodeWorker({ worker, profile, sourceEnv });
  if (preflight.errors.length > 0) fail(`Worker preflight failed: ${preflight.errors.join("; ")}`);
  const provider = await readOperatorProvider({ worker, sourceEnv });
  const hostConfig = await hostManagedConfigPresence();
  const stateDir = await mkdtemp(join(tmpdir(), "tinysdd-opencode-state-"));
  let cleaned = false;
  try {
    for (const name of ["home", "tmp", "config-dir", "xdg/config", "xdg/data", "xdg/cache", "xdg/state"]) {
      await mkdir(join(stateDir, name), { recursive: true, mode: 0o700 });
    }
    await writeFile(join(stateDir, "models.json"), "{}\n", { mode: 0o600 });
  } catch (error) {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    fail(`Cannot prepare temporary OpenCode state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const env = provider.apiKey === null ? {} : { [SECRET_PLACEHOLDER]: provider.apiKey };
  const relayTarget = {
    provider: {
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      ...(provider.apiKey === null ? {} : { apiKey: `$${SECRET_PLACEHOLDER}`, authHeader: true }),
    },
    model: { id: provider.modelId, api: "openai-completions", baseUrl: provider.baseUrl },
  };
  const metadata = {
    schemaVersion: 1,
    provider: provider.providerId,
    model: provider.modelId,
    api: "openai-completions",
    contextWindow: provider.contextLimit,
    maxTokens: provider.outputLimit,
    rawReasoning: null,
    effectiveReasoning: null,
    rawProviderCompat: null,
    rawModelCompat: null,
    rawCompat: null,
    effectiveCompat: null,
    profileId: profile?.id ?? null,
    timeoutMs: limits.timeoutMs,
    maxToolCalls: limits.maxToolCalls,
    firstWriteMs: limits.firstWriteMs,
    maxCheckRuns: limits.maxCheckRuns,
    credentialEnvironmentNames: [],
    generatedCredentialReferenceCount: 0,
    preflight: {
      basis: preflight.basis,
      thinking: preflight.thinking,
      maxTokens: preflight.maxTokens,
      thinkingTokenBudgetField: null,
      thinkingBudget: null,
      endpointFingerprint: preflight.endpointFingerprint,
      warnings: preflight.warnings,
      errors: [],
    },
    compaction: preflight.compaction,
    runtimeFacts: {
      managedConfig: hostConfig,
      isolatedEnvironment: [...OPENCODE_ENV_NAMES],
      permissions: OPENCODE_PERMISSIONS.map((rule) => ({ ...rule })),
    },
  };
  return {
    stateDir,
    env,
    metadata,
    relayTarget,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

