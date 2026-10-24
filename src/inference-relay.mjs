import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function credential(value, env, sourceEnv) {
  if (value === undefined) return undefined;
  const match = typeof value === "string" && value.match(/^\$(TINYSDD_PI_(?:SECRET|ENV)_\d+)$/u);
  if (!match || typeof env[match[1]] !== "string") throw new Error("Inference relay requires filtered credential references");
  const resolved = env[match[1]];
  const reference = resolved.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (!reference) return resolved;
  const source = sourceEnv[reference[1]];
  if (typeof source !== "string" || source.length === 0) throw new Error(`Required inference credential environment variable is unavailable: ${reference[1]}`);
  return source;
}

function upstreamSettings(provider, model, env, sourceEnv) {
  const api = model.api ?? provider.api;
  if (api !== "openai-completions") throw new Error(`Sandboxed workers currently require the openai-completions inference API; the selected model uses ${api === undefined ? "no declared API" : JSON.stringify(api)}`);
  let url;
  try { url = new URL(model.baseUrl ?? provider.baseUrl); } catch { throw new Error("Inference relay requires an explicit HTTP(S) baseUrl"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Inference relay requires an HTTP(S) baseUrl without URL credentials, query or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = credential(model.apiKey ?? provider.apiKey, env, sourceEnv);
  if (apiKey && provider.authHeader !== false) headers.set("Authorization", `Bearer ${apiKey}`);
  for (const [key, value] of Object.entries({ ...provider.headers, ...model.headers })) headers.set(key, credential(value, env, sourceEnv));
  return { url: url.href, headers };
}

function authorized(value, token) {
  const actual = Buffer.from(typeof value === "string" ? value : "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function inferenceRelayHandler({ provider, model, env, sourceEnv = {}, token, signal, transport = fetch }) {
  const upstream = upstreamSettings(provider, model, env, sourceEnv);
  let busy = false;
  return async (request, response) => {
    const reject = (status, message) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message } }));
    };
    if (!authorized(request.headers.authorization, token)) return reject(401, "Unauthorized inference request");
    if (request.method !== "POST" || request.url !== "/chat/completions") return reject(403, "Only the approved inference route is available");
    if (busy) return reject(429, "An inference request is already running");
    busy = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    response.once("close", abort);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) return reject(413, "Inference request exceeds the bounded input size");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let parsed;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { return reject(400, "Inference request must be JSON"); }
      if (!parsed || parsed.model !== model.id) return reject(403, "Only the selected model is available");
      const result = await transport(upstream.url, { method: "POST", headers: upstream.headers, body, signal: controller.signal, redirect: "error" });
      if (!result.ok) {
        await result.body?.cancel();
        return reject(result.status, "The selected inference provider refused the request");
      }
      response.writeHead(result.status, { "Content-Type": result.headers.get("content-type") ?? "application/json" });
      let responseBytes = 0;
      for await (const chunk of result.body ?? []) {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("Inference response exceeds the bounded output size");
        if (!response.write(chunk)) {
          await new Promise((resolve, rejectPromise) => {
            const finish = (error) => {
              response.removeListener("drain", drained);
              response.removeListener("close", closed);
              if (error) rejectPromise(error); else resolve();
            };
            const drained = () => finish();
            const closed = () => finish(new Error("Inference client disconnected"));
            response.once("drain", drained);
            response.once("close", closed);
            if (response.destroyed) closed();
          });
        }
      }
      response.end();
    } catch {
      // Provider errors can include credentials; only a fixed diagnostic crosses the relay.
      if (!response.headersSent) reject(502, "The approved inference request failed");
      else response.destroy();
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", abort);
      response.removeListener("close", abort);
      busy = false;
    }
  };
}

// With socketPath the relay listens only on that Unix socket (the Linux worker
// reaches it through a bind mount); otherwise on an ephemeral loopback port.
export async function startInferenceRelay({ provider, model, env, sourceEnv = process.env, socketPath }) {
  const token = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const handler = inferenceRelayHandler({ provider, model, env, sourceEnv, token, signal: controller.signal });
  const server = createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (socketPath) server.listen(socketPath, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  const port = socketPath ? undefined : server.address().port;
  return {
    ...(socketPath ? { socketPath } : { port, baseUrl: `http://127.0.0.1:${port}` }),
    token,
    close: async () => {
      controller.abort();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

// Mirrors the baseUrl-dependent part of pi-ai 1.0.0 detectCompat
// (dist/api/openai-completions.js). Pi derives these request-shape settings
// from the provider id and the URL, and the relay address hides the URL.
function piUrlCompat(providerId, modelId, baseUrl) {
  const url = typeof baseUrl === "string" ? baseUrl : "";
  const isZai = providerId === "zai" || providerId === "zai-coding-cn" || url.includes("api.z.ai") || url.includes("open.bigmodel.cn");
  const isTogether = providerId === "together" || url.includes("api.together.ai") || url.includes("api.together.xyz");
  const isMoonshot = providerId === "moonshotai" || providerId === "moonshotai-cn" || url.includes("api.moonshot.");
  const isOpenRouter = providerId === "openrouter" || url.includes("openrouter.ai");
  const isCloudflareWorkersAI = providerId === "cloudflare-workers-ai" || url.includes("api.cloudflare.com");
  const isCloudflareAiGateway = providerId === "cloudflare-ai-gateway" || url.includes("gateway.ai.cloudflare.com");
  const isNvidia = providerId === "nvidia" || url.includes("integrate.api.nvidia.com");
  const isAntLing = providerId === "ant-ling" || url.includes("api.ant-ling.com");
  const isCerebras = providerId === "cerebras" || url.includes("cerebras.ai");
  const isDeepSeek = providerId === "deepseek" || url.toLowerCase().includes("deepseek.com");
  const isGrok = providerId === "xai" || url.includes("api.x.ai");
  const isNonStandard = isNvidia || isCerebras || isGrok || isTogether || url.includes("chutes.ai") || isDeepSeek || isZai || isMoonshot
    || providerId === "opencode" || url.includes("opencode.ai") || isCloudflareWorkersAI || isCloudflareAiGateway || isAntLing;
  const useMaxTokens = url.includes("chutes.ai") || isDeepSeek || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia || isAntLing || isZai;
  const developerRoleModel = isOpenRouter && typeof modelId === "string" && (modelId.startsWith("anthropic/") || modelId.startsWith("openai/"));
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: developerRoleModel || (!isNonStandard && !isOpenRouter),
    supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresReasoningContentOnAssistantMessages: isDeepSeek,
    thinkingFormat: isDeepSeek ? "deepseek" : isZai ? "zai" : isTogether ? "together" : isAntLing ? "ant-ling" : isOpenRouter ? "openrouter" : "openai",
    sendSessionAffinityHeaders: isOpenRouter,
    sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
    supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing),
  };
}

// Settings Pi would have derived from the upstream URL but not from the relay
// URL become explicit model compat, unless the operator already set them.
function preservedCompat(providerId, provider, model, relayUrl) {
  const upstream = piUrlCompat(providerId, model.id, model.baseUrl ?? provider.baseUrl);
  const relayed = piUrlCompat(providerId, model.id, relayUrl);
  const explicit = { ...provider.compat, ...model.compat };
  return Object.fromEntries(Object.entries(upstream).filter(([key, value]) => relayed[key] !== value && explicit[key] === undefined));
}

export function relayPiProvider(provider, model, baseUrl, providerId) {
  const filtered = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["headers", "apiKey", "baseUrl", "models"].includes(key)));
  const preserved = preservedCompat(providerId, provider, model, baseUrl);
  const compat = Object.keys(preserved).length > 0 ? { ...preserved, ...model.compat } : model.compat;
  return { ...filtered(provider), api: "openai-completions", baseUrl, apiKey: "$TINYSDD_INFERENCE_TOKEN", authHeader: true, models: [{ ...filtered(model), ...(compat === undefined ? {} : { compat }), api: "openai-completions", baseUrl }] };
}
