import { mkdir, mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_TOOL_CALLS } from "./config.mjs";
import { piCompactionSettings, resolveCompactionSettings } from "./compaction-runtime.mjs";

/**
 * The worker owns a very small copy of Pi's model configuration.  In
 * particular, this module deliberately does not import Pi's runtime: doing so
 * would make a controller process inherit Pi's global state before the
 * disposable worker sandbox exists.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_KEY = /(?:api[_-]?key|authorization|bearer|cookie|credential|password|secret|token(?:$|[_-]))/iu;

export const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
// Limits have one source of truth (config.mjs) so the controller's config
// validation and the worker's own check cannot disagree.
export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
export const DEFAULT_TOOL_LIMIT = DEFAULT_MAX_TOOL_CALLS;
export const MAX_TOOL_LIMIT = MAX_TOOL_CALLS;
// Pi 0.84.4 documents these model defaults (docs/models.md).  A model entry
// without maxTokens is silently capped at PI_DEFAULT_MAX_TOKENS per response.
export const PI_DEFAULT_MAX_TOKENS = 16_384;
// pi-ai 0.84.4 DEFAULT_THINKING_BUDGETS and MIN_ANSWER_TOKENS
// (dist/api/simple-options.js): the per-level reasoning cap Pi sends when a
// thinkingTokenBudgetField is configured, clamped to leave answer room.
export const PI_DEFAULT_THINKING_BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384 });
const PI_MIN_ANSWER_TOKENS = 1024;

export class PiEnvironmentError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PiEnvironmentError";
  }
}

function fail(message) {
  throw new PiEnvironmentError(message);
}

function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        i += 1;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      i += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      i += 1;
    } else {
      result += char;
    }
  }
  return result;
}

function rewriteTemplate(value, description, sourceEnv, generatedEnv, nextSecret, materializeEnvironmentRefs = true) {
  if (typeof value !== "string") fail(`${description} must be a string`);
  if (isCommandValue(value)) fail(`${description} cannot use a shell command reference`);
  let output = "";
  let resolved = "";
  let found = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "$") {
      output += char;
      resolved += char;
      continue;
    }
    const next = value[index + 1];
    if (next === "$" || next === "!") {
      output += next;
      resolved += next === "$" ? "$" : "!";
      index += 1;
      continue;
    }
    let name;
    let end = index + 1;
    if (next === "{") {
      const close = value.indexOf("}", index + 2);
      const candidate = close < 0 ? "" : value.slice(index + 2, close);
      if (ENV_NAME.test(candidate)) {
        name = candidate;
        end = close + 1;
      }
    } else {
      const match = value.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
      if (match) {
        name = match[0];
        end = index + 1 + name.length;
      }
    }
    if (!name) {
      output += "$";
      resolved += "$";
      continue;
    }
    const sourceValue = ensureEnvironmentValue(name, sourceEnv);
    if (materializeEnvironmentRefs) {
      const generatedName = `TINYSDD_PI_ENV_${nextSecret.value++}`;
      generatedEnv[generatedName] = sourceValue;
      output += `$${generatedName}`;
    } else {
      output += sourceValue;
    }
    resolved += sourceValue;
    found = true;
    index = end - 1;
  }
  return { value: output, resolved, found };
}

function isCommandValue(value) {
  return typeof value === "string" && value.startsWith("!");
}

function ensureEnvironmentValue(name, sourceEnv) {
  if (!ENV_NAME.test(name)) fail(`Invalid credential environment reference: ${name}`);
  const value = sourceEnv[name] ?? process.env[name];
  if (value === undefined || value === "") {
    fail(`Required Pi credential environment variable is unavailable: ${name}`);
  }
  return value;
}

function rejectCredentialUrl(value, description) {
  if (typeof value !== "string") return;
  if (isCommandValue(value)) fail(`${description} cannot use a shell command reference`);
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) fail(`${description} contains embedded URL credentials`);
  } catch (error) {
    if (error instanceof PiEnvironmentError) throw error;
    // A non-URL literal is rejected by Pi later if it is used as a base URL;
    // this check is only for credentials embedded in a URL.
  }
}

function credentialValue(value, description, sourceEnv, generatedEnv, nextSecret) {
  const rewritten = rewriteTemplate(value, description, sourceEnv, generatedEnv, nextSecret, false);
  const name = `TINYSDD_PI_SECRET_${nextSecret.value++}`;
  // Resolve the complete approved template once.  Leaving escaped dollars or
  // mixed literal/env fragments in models.json would make Pi parse them a
  // second time and could accidentally reference an unsafe process variable.
  generatedEnv[name] = rewritten.resolved;
  return `$${name}`;
}

function endpointFingerprint(value) {
  if (typeof value !== "string") return "UNKNOWN";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "UNKNOWN";
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch {
    return "UNKNOWN";
  }
}

function copyScalar(value, description) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  fail(`${description} must contain JSON scalar values`);
}

function sanitizeSampling(value, description, sourceEnv, generatedEnv, nextSecret, keyName = "") {
  if (Array.isArray(value)) {
    return value.map((child, index) => sanitizeSampling(child, `${description}[${index}]`, sourceEnv, generatedEnv, nextSecret, keyName));
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && SECRET_KEY.test(keyName)) {
      return credentialValue(value, description, sourceEnv, generatedEnv, nextSecret);
    }
    return copyScalar(value, description);
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = sanitizeSampling(child, `${description}.${key}`, sourceEnv, generatedEnv, nextSecret, key);
  }
  return output;
}

function sanitizeHeaders(headers, description, sourceEnv, generatedEnv, nextSecret) {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) fail(`${description} must be an object`);
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== "string" || name.length === 0) fail(`${description} contains an invalid header name`);
    output[name] = credentialValue(value, `${description}.${name}`, sourceEnv, generatedEnv, nextSecret);
  }
  return output;
}

function sanitizeModel(model, description, sourceEnv, generatedEnv, nextSecret) {
  if (!model || typeof model !== "object" || Array.isArray(model)) fail(`${description} must be an object`);
  const output = {};
  for (const [key, value] of Object.entries(model)) {
    if (key === "headers") {
      output[key] = sanitizeHeaders(value, `${description}.headers`, sourceEnv, generatedEnv, nextSecret);
    } else if (key === "samplingParams") {
      output[key] = sanitizeSampling(value, `${description}.samplingParams`, sourceEnv, generatedEnv, nextSecret);
    } else if (key === "apiKey" || SECRET_KEY.test(key)) {
      output[key] = credentialValue(value, `${description}.${key}`, sourceEnv, generatedEnv, nextSecret);
    } else if (key === "baseUrl") {
      if (typeof value !== "string") fail(`${description}.baseUrl must be a string`);
      const rewritten = rewriteTemplate(value, `${description}.baseUrl`, sourceEnv, generatedEnv, nextSecret, false);
      rejectCredentialUrl(rewritten.resolved, `${description}.baseUrl`);
      output[key] = rewritten.resolved;
    } else if (Array.isArray(value)) {
      output[key] = value.map((child, index) => {
        if (child && typeof child === "object") return sanitizeSampling(child, `${description}.${key}[${index}]`, sourceEnv, generatedEnv, nextSecret, key);
        return copyScalar(child, `${description}.${key}[${index}]`);
      });
    } else if (value && typeof value === "object") {
      output[key] = sanitizeSampling(value, `${description}.${key}`, sourceEnv, generatedEnv, nextSecret, key);
    } else {
      output[key] = copyScalar(value, `${description}.${key}`);
    }
  }
  return output;
}

function sanitizeProvider(provider, providerId, model, sourceEnv, generatedEnv, nextSecret) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) fail(`Pi provider ${providerId} is invalid`);
  if (provider.oauth) fail(`Pi provider ${providerId} uses OAuth; temporary filtered state cannot expose OAuth storage`);
  const output = {};
  // Keep only provider fields that Pi's model registry needs.  In particular,
  // do not carry modelOverrides or another provider's model list into state.
  for (const key of ["name", "api", "baseUrl", "compat", "authHeader"]) {
    if (provider[key] !== undefined) {
      if (key === "baseUrl") {
        if (typeof provider[key] !== "string") fail(`Pi provider ${providerId}.baseUrl must be a string`);
        const rewritten = rewriteTemplate(provider[key], `Pi provider ${providerId}.baseUrl`, sourceEnv, generatedEnv, nextSecret, false);
        rejectCredentialUrl(rewritten.resolved, `Pi provider ${providerId}.baseUrl`);
        output[key] = rewritten.resolved;
        continue;
      }
      output[key] = sanitizeSampling(provider[key], `Pi provider ${providerId}.${key}`, sourceEnv, generatedEnv, nextSecret, key);
    }
  }
  if (provider.apiKey !== undefined) {
    output.apiKey = credentialValue(provider.apiKey, `Pi provider ${providerId}.apiKey`, sourceEnv, generatedEnv, nextSecret);
  }
  if (provider.headers !== undefined) {
    output.headers = sanitizeHeaders(provider.headers, `Pi provider ${providerId}.headers`, sourceEnv, generatedEnv, nextSecret);
  }
  output.models = [sanitizeModel(model, `Pi model ${providerId}/${model.id}`, sourceEnv, generatedEnv, nextSecret)];
  return output;
}

async function readJson(path, description) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail(`Cannot read ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    // Do not echo parser snippets: models.json can contain operator-managed
    // credential material in malformed input, and diagnostics must stay blind.
    fail(`Cannot parse ${description}`);
  }
}

function defaultSourceAgentDir() {
  return process.env[PI_AGENT_ENV] || join(homedir(), ".config", "pi", "agent");
}

function validateWorker(worker) {
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) fail("Pi worker configuration is required");
  if (worker.type !== "pi") fail(`Unsupported worker adapter: ${String(worker.type ?? "missing")}`);
  if (typeof worker.provider !== "string" || worker.provider.length === 0) fail("Pi worker.provider is required");
  if (typeof worker.model !== "string" || worker.model.length === 0) fail("Pi worker.model is required");
  const limits = worker.limits ?? {};
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) fail("Pi worker.limits must be an object");
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxToolCalls = limits.maxToolCalls ?? DEFAULT_TOOL_LIMIT;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(`Pi timeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}]`);
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls <= 0 || maxToolCalls > MAX_TOOL_LIMIT) {
    fail(`Pi maxToolCalls must be an integer in (0, ${MAX_TOOL_LIMIT}]`);
  }
  const firstWriteMs = limits.firstWriteMs ?? null;
  if (firstWriteMs !== null && (!Number.isInteger(firstWriteMs) || firstWriteMs <= 0 || firstWriteMs >= timeoutMs)) {
    fail("Pi firstWriteMs must be a positive integer below timeoutMs");
  }
  const maxCheckRuns = limits.maxCheckRuns === undefined ? 12 : limits.maxCheckRuns;
  if (!Number.isInteger(maxCheckRuns) || maxCheckRuns < 1 || maxCheckRuns > 20) fail("Pi maxCheckRuns must be an integer from 1 to 20");
  return { timeoutMs, maxToolCalls, firstWriteMs, maxCheckRuns };
}

// Thinking-control rules for Pi's openai-completions requests, read from
// @earendil-works/pi-ai 0.84.4 (dist/api/openai-completions.js).  Every branch
// there requires model.reasoning === true; without it no thinking parameter is
// sent in either direction.  Re-check these sets when the Pi version changes.
export const PREFLIGHT_BASIS = "pi-ai 0.84.4 openai-completions thinking rules";
const OFF_ALWAYS_SENT = new Set(["qwen", "qwen-chat-template", "zai", "together"]);
const OFF_SENT_UNLESS_MAP_NULL = new Set(["deepseek", "openrouter", "string-thinking"]);
const OFF_SENT_IF_MAP_STRING = new Set(["openai", "baseten"]);
const ON_ALWAYS_SENT = new Set(["qwen", "qwen-chat-template", "zai", "together", "deepseek", "openrouter", "string-thinking", "baseten"]);

function hasEntries(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function thinkingControl({ api, thinking, reasoning, compat, thinkingLevelMap }) {
  const format = compat?.thinkingFormat ?? null;
  const base = { requested: thinking, reasoning: reasoning ?? null, thinkingFormat: format };
  if (reasoning !== true) {
    return { ...base, control: "not-sent", reason: "model entry does not have reasoning: true, so Pi sends no thinking parameter" };
  }
  if (api !== "openai-completions") {
    return { ...base, control: "provider-native", reason: `Pi controls thinking natively for api ${api ?? "unknown"}; TinySDD does not model it` };
  }
  if (thinking !== "off") {
    if (thinkingLevelMap?.[thinking] === null) return { ...base, control: "not-sent", reason: `thinkingLevelMap marks level ${thinking} unsupported` };
    if (format === null) return { ...base, control: "unverified", reason: "no explicit compat.thinkingFormat; Pi auto-detects the request format from provider and baseUrl" };
    if (ON_ALWAYS_SENT.has(format)) return { ...base, control: "sent", reason: `thinkingFormat ${format} sends an enable value` };
    if (format === "openai") {
      return compat?.supportsReasoningEffort === false
        ? { ...base, control: "not-sent", reason: "thinkingFormat openai with supportsReasoningEffort false sends nothing" }
        : { ...base, control: "sent", reason: "thinkingFormat openai sends reasoning_effort; the server may ignore it" };
    }
    if (format === "chat-template") {
      return hasEntries(compat?.chatTemplateKwargs)
        ? { ...base, control: "sent", reason: "chat-template sends the configured chatTemplateKwargs" }
        : { ...base, control: "not-sent", reason: "chat-template without chatTemplateKwargs sends nothing" };
    }
    if (format === "ant-ling") {
      return typeof thinkingLevelMap?.[thinking] === "string"
        ? { ...base, control: "sent", reason: "ant-ling sends the mapped effort" }
        : { ...base, control: "not-sent", reason: "ant-ling sends nothing without a thinkingLevelMap entry" };
    }
    return { ...base, control: "unverified", reason: `thinkingFormat ${format} is not modelled by this preflight` };
  }
  if (format === null) return { ...base, control: "unverified", reason: "no explicit compat.thinkingFormat; whether an off value is sent depends on Pi's provider auto-detection" };
  if (OFF_ALWAYS_SENT.has(format)) return { ...base, control: "sent", reason: `thinkingFormat ${format} sends an explicit off value` };
  if (OFF_SENT_UNLESS_MAP_NULL.has(format)) {
    return thinkingLevelMap?.off === null
      ? { ...base, control: "not-sent", reason: "thinkingLevelMap.off is null: the model cannot disable thinking" }
      : { ...base, control: "sent", reason: `thinkingFormat ${format} sends an explicit off value` };
  }
  if (OFF_SENT_IF_MAP_STRING.has(format)) {
    return typeof thinkingLevelMap?.off === "string"
      ? { ...base, control: "sent", reason: `thinkingFormat ${format} sends thinkingLevelMap.off` }
      : { ...base, control: "not-sent", reason: `thinkingFormat ${format} sends an off value only when thinkingLevelMap.off is a string` };
  }
  if (format === "chat-template") {
    return hasEntries(compat?.chatTemplateKwargs)
      ? { ...base, control: "sent", reason: "chat-template sends the configured chatTemplateKwargs" }
      : { ...base, control: "not-sent", reason: "chat-template without chatTemplateKwargs sends nothing" };
  }
  if (format === "ant-ling") return { ...base, control: "not-sent", reason: "ant-ling sends nothing when thinking is off" };
  return { ...base, control: "unverified", reason: `thinkingFormat ${format} is not modelled by this preflight` };
}

/**
 * Compare what the worker requests with what Pi will actually send.
 *
 * Errors mean the request cannot be honored and the run must not start.
 * Warnings are recorded in runtime.json and the result envelope.
 */
export function piRuntimePreflight({ api, model, thinking = "off", thinkingBudgets = null, compaction: compactionProfile = undefined }) {
  const errors = [];
  const warnings = [];
  const control = thinkingControl({ api, thinking, reasoning: model.reasoning, compat: model.compat, thinkingLevelMap: model.thinkingLevelMap });
  if (thinking !== "off" && (control.control === "not-sent")) {
    errors.push(`thinking "${thinking}" was requested but cannot be sent: ${control.reason}`);
  } else if (thinking !== "off" && control.control === "unverified") {
    warnings.push(`thinking "${thinking}" may not reach the server: ${control.reason}`);
  } else if (thinking === "off" && ["not-sent", "unverified"].includes(control.control)) {
    warnings.push(`thinking "off" may not disable thinking: ${control.reason}; a model whose chat template thinks by default will still think`);
  }
  const configuredMaxTokens = Number.isFinite(model.maxTokens) ? model.maxTokens : null;
  const maxTokens = { value: configuredMaxTokens ?? PI_DEFAULT_MAX_TOKENS, source: configuredMaxTokens === null ? "pi-default" : "model" };
  if (configuredMaxTokens === null) {
    warnings.push(`model entry has no maxTokens; Pi caps every response at its default ${PI_DEFAULT_MAX_TOKENS} output tokens, reasoning included`);
  }
  const budgetField = model.compat?.thinkingTokenBudgetField ?? (model.compat?.supportsThinkingTokenBudget ? "thinking_token_budget" : null);
  if (thinking !== "off" && control.control === "sent" && api === "openai-completions" && !budgetField) {
    warnings.push(`reasoning and the answer share one ${maxTokens.value}-token response cap and no compat.thinkingTokenBudgetField is set, so a single thinking phase can consume the whole response`);
  }
  if (thinkingBudgets && !budgetField && api === "openai-completions") {
    warnings.push("thinkingBudgets are configured but no compat.thinkingTokenBudgetField is set, so Pi will not send them");
  }
  let thinkingBudget = null;
  if (thinking !== "off" && control.control === "sent" && api === "openai-completions" && budgetField) {
    const configured = thinkingBudgets?.[thinking];
    const levelBudget = configured ?? PI_DEFAULT_THINKING_BUDGETS[thinking];
    const tokens = Math.min(levelBudget, Math.max(0, maxTokens.value - PI_MIN_ANSWER_TOKENS));
    // Pi omits the field when the clamped budget is zero.
    thinkingBudget = { field: budgetField, tokens, source: configured === undefined ? "pi-default" : "profile", clamped: tokens < levelBudget, sent: tokens > 0 };
    if (tokens === 0) warnings.push(`maxTokens ${maxTokens.value} leaves no room for a thinking budget after Pi's ${PI_MIN_ANSWER_TOKENS}-token answer reserve, so none is sent`);
  }
  let compaction;
  try {
    compaction = resolveCompactionSettings({ compaction: compactionProfile }, maxTokens.value);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    compaction = { enabled: false, invalid: true, code: error?.code ?? "COMPACTION_PROFILE_INVALID" };
  }
  return { basis: PREFLIGHT_BASIS, thinking: control, maxTokens, thinkingTokenBudgetField: budgetField, thinkingBudget, compaction, errors, warnings };
}

async function resolvePiModel({ worker, profile, sourceAgentDir, sourceEnv }) {
  const modelsPath = join(sourceAgentDir, "models.json");
  const models = await readJson(modelsPath, "Pi models.json");
  if (!models || typeof models !== "object" || Array.isArray(models) || !models.providers || typeof models.providers !== "object") {
    fail("Pi models.json has no providers object");
  }
  if (!Object.hasOwn(models.providers, worker.provider)) fail(`Configured Pi provider is unavailable: ${worker.provider}`);
  const provider = models.providers[worker.provider];
  if (!Array.isArray(provider.models)) fail(`Configured Pi provider ${worker.provider} has no model list`);
  const configuredModel = provider.models.find((candidate) => candidate && candidate.id === worker.model);
  if (!configuredModel) fail(`Configured Pi model is unavailable: ${worker.provider}/${worker.model}`);
  const rawReasoning = configuredModel.reasoning;
  const rawCompat = configuredModel.compat;
  const model = structuredClone(configuredModel);
  if (provider.compat || model.compat) model.compat = { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
  const profileRuntime = profile?.runtime;
  if (profileRuntime?.reasoning !== undefined) model.reasoning = profileRuntime.reasoning;
  if (profileRuntime?.compat) model.compat = { ...(model.compat ?? {}), ...profileRuntime.compat };
  const generatedEnv = {};
  const nextSecret = { value: 0 };
  const safeProvider = sanitizeProvider(provider, worker.provider, model, sourceEnv, generatedEnv, nextSecret);
  const api = model.api ?? provider.api ?? null;
  const endpoint = endpointFingerprint(safeProvider.models[0]?.baseUrl ?? safeProvider.baseUrl);
  const preflight = {
    ...piRuntimePreflight({ api, model, thinking: profileRuntime?.thinking ?? "off", thinkingBudgets: profileRuntime?.thinkingBudgets ?? null, compaction: profileRuntime?.compaction }),
    endpointFingerprint: endpoint,
  };
  return { modelsPath, provider, model, api, rawReasoning, rawCompat, generatedEnv, safeProvider, preflight };
}

/**
 * Check a worker's Pi model entry without creating any state.  `worker start`
 * uses this to fail before detaching when the request cannot be honored.
 */
export async function preflightPiWorker({ worker, profile = null, sourceAgentDir = defaultSourceAgentDir(), sourceEnv = process.env } = {}) {
  validateWorker(worker);
  const resolved = await resolvePiModel({ worker, profile, sourceAgentDir, sourceEnv });
  return {
    ...resolved.preflight,
    effectiveReasoning: resolved.model.reasoning ?? null,
    effectiveCompat: resolved.model.compat ?? null,
  };
}

/**
 * Prepare a temporary, credential-filtered Pi state directory.
 *
 * The returned `env` contains only the credential variables referenced by the
 * selected provider/model plus the Pi state selector.  The caller must invoke
 * `cleanup()` in a finally block.
 */
export async function preparePiEnvironment({ worker, profile = null, sourceAgentDir = defaultSourceAgentDir(), sourceEnv = process.env } = {}) {
  const limits = validateWorker(worker);
  const { modelsPath, provider, model, api, rawReasoning, rawCompat, generatedEnv, safeProvider, preflight } = await resolvePiModel({ worker, profile, sourceAgentDir, sourceEnv });
  if (preflight.errors.length > 0) fail(`Worker preflight failed: ${preflight.errors.join("; ")}`);
  const stateDir = await mkdtemp(join(tmpdir(), "tinysdd-pi-state-"));
  let cleaned = false;
  try {
    await writeFile(join(stateDir, "models.json"), `${JSON.stringify({ providers: { [worker.provider]: safeProvider } }, null, 2)}\n`, { mode: 0o600 });
    // The user's global Pi settings are never inherited; a profile's thinking
    // budgets are the only settings it contributes.
    const settings = { retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } }, compaction: piCompactionSettings(preflight.compaction) };
    if (profile?.runtime?.thinkingBudgets) settings.thinkingBudgets = { ...profile.runtime.thinkingBudgets };
    await writeFile(join(stateDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    // Pi's startup/auth checks may create this file.  It is intentionally an
    // empty temporary store, never a copy of the user's auth.json.
    await writeFile(join(stateDir, "auth.json"), "{}\n", { mode: 0o600 });
  } catch (error) {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    fail(`Cannot prepare temporary Pi state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/home/tinysdd",
    [PI_AGENT_ENV]: stateDir,
    ...generatedEnv,
  };
  const metadata = {
    schemaVersion: 1,
    provider: worker.provider,
    model: worker.model,
    api,
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
    rawReasoning: rawReasoning ?? null,
    effectiveReasoning: model.reasoning ?? null,
    rawProviderCompat: provider.compat ?? null,
    rawModelCompat: rawCompat ?? null,
    rawCompat: rawCompat ?? null,
    effectiveCompat: model.compat ?? null,
    profileId: profile?.id ?? null,
    timeoutMs: limits.timeoutMs,
    maxToolCalls: limits.maxToolCalls,
    firstWriteMs: limits.firstWriteMs,
    maxCheckRuns: limits.maxCheckRuns,
    credentialEnvironmentNames: [],
    generatedCredentialReferenceCount: Object.keys(generatedEnv).length,
    preflight,
    compaction: preflight.compaction,
  };
  return {
    stateDir,
    env,
    metadata,
    sourceModelsPath: modelsPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

export function validatePiWorker(worker) {
  return validateWorker(worker);
}

export function defaultPiAgentDir() {
  return defaultSourceAgentDir();
}
