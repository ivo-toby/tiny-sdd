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
  if ((model.api ?? provider.api) !== "openai-completions") throw new Error("macOS workers currently require the openai-completions inference API");
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

export async function startInferenceRelay({ provider, model, env, sourceEnv = process.env }) {
  const token = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const handler = inferenceRelayHandler({ provider, model, env, sourceEnv, token, signal: controller.signal });
  const server = createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      controller.abort();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

export function relayPiProvider(provider, model, baseUrl) {
  const filtered = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["headers", "apiKey", "baseUrl", "models"].includes(key)));
  return { ...filtered(provider), api: "openai-completions", baseUrl, apiKey: "$TINYSDD_INFERENCE_TOKEN", authHeader: true, models: [{ ...filtered(model), api: "openai-completions", baseUrl }] };
}
