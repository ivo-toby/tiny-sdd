import { mkdir, mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The worker owns a very small copy of Pi's model configuration.  In
 * particular, this module deliberately does not import Pi's runtime: doing so
 * would make a controller process inherit Pi's global state before the
 * disposable worker sandbox exists.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_KEY = /(?:api[_-]?key|authorization|bearer|cookie|credential|password|secret|token(?:$|[_-]))/iu;

export const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_TOOL_LIMIT = 40;
export const MAX_TOOL_LIMIT = 100;

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
  return { timeoutMs, maxToolCalls };
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
  const stateDir = await mkdtemp(join(tmpdir(), "tinysdd-pi-state-"));
  let cleaned = false;
  try {
    await writeFile(join(stateDir, "models.json"), `${JSON.stringify({ providers: { [worker.provider]: safeProvider } }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDir, "settings.json"), `${JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } }, compaction: { enabled: false } }, null, 2)}\n`, { mode: 0o600 });
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
    api: provider.api ?? null,
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
    credentialEnvironmentNames: [],
    generatedCredentialReferenceCount: Object.keys(generatedEnv).length,
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
