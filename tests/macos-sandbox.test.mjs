import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { buildMacosSandboxProfile } from "../src/macos-sandbox.mjs";
import { inferenceRelayHandler, relayPiProvider } from "../src/inference-relay.mjs";

const sandbox = {
  workspace: "/private/tmp/candidate",
  stateDir: "/private/tmp/pi-state",
  sourceRoot: "/Users/operator/project",
  sourceAgentDir: "/Users/operator/.pi/agent",
  nodeExecutable: "/opt/node/bin/node",
  piExecutable: "/opt/node/lib/node_modules/pi/dist/cli.js",
  piRoot: "/opt/node/lib/node_modules/pi",
  inferencePort: 54321,
};
const model = { id: "exact-model", maxTokens: 1024, headers: { "X-Model": "$TINYSDD_PI_SECRET_2" } };
const provider = { api: "openai-completions", baseUrl: "https://inference.example/v1", apiKey: "$TINYSDD_PI_SECRET_0", headers: { "X-Provider": "$TINYSDD_PI_SECRET_1" }, models: [model, { id: "other-model" }] };
const env = { TINYSDD_PI_SECRET_0: "synthetic-key", TINYSDD_PI_SECRET_1: "synthetic-provider", TINYSDD_PI_SECRET_2: "synthetic-model" };

async function request(handler, { body = { model: model.id, messages: [] }, method = "POST", url = "/chat/completions", authorization = "Bearer test-token", rawBody } = {}) {
  const incoming = Readable.from([rawBody ?? Buffer.from(JSON.stringify(body))]);
  Object.assign(incoming, { method, url, headers: { authorization } });
  const chunks = [];
  const response = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
  response.writeHead = (status, headers) => { Object.assign(response, { statusCode: status, headers, headersSent: true }); };
  await handler(incoming, response);
  return { status: response.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: response.headers };
}

test("Seatbelt grants only disposable writes, trusted runtime reads and one loopback port", () => {
  const profile = buildMacosSandboxProfile(sandbox);
  assert.match(profile, /\(deny default\)/u);
  assert.match(profile, /\(deny file-read\* file-write\* \(subpath "\/Users\/operator\/project"\) \(subpath "\/Users\/operator\/\.pi\/agent"\)\)/u);
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:54321"\)\)/u);
  assert.doesNotMatch(profile, /\(allow (?:default|process-fork|mach-lookup|network-inbound|network-bind)\b/u);
  assert.doesNotMatch(profile, /\(subpath "(?:\/|\/Users|\/System|\/private\/tmp)"\)/u);
  assert.doesNotMatch(profile, /\(allow sysctl-read\)/u);
  const writes = profile.split("\n").filter((line) => line.startsWith("(allow file-read* file-write*"));
  assert.deepEqual(writes, ['(allow file-read* file-write* (subpath "/private/tmp/candidate"))', '(allow file-read* file-write* (subpath "/private/tmp/pi-state"))']);
});

test("Seatbelt refuses paths that expose the source or original Pi configuration", () => {
  for (const override of [{ stateDir: "/Users/operator/project/state" }, { workspace: "/Users/operator/.pi/agent/candidate" }, { piRoot: "/Users", piExecutable: "/Users/pi.js" }, { sourceRoot: "/usr/share/project" }, { stateDir: "/private/tmp/candidate/state" }]) {
    assert.throws(() => buildMacosSandboxProfile({ ...sandbox, ...override }), /overlap|separate/u);
  }
});

test("Seatbelt validates paths and ports and escapes profile syntax", () => {
  for (const workspace of ["relative", "/private/tmp/../candidate", "/private/tmp/candidate\n"]) assert.throws(() => buildMacosSandboxProfile({ ...sandbox, workspace }), /absolute paths/u);
  for (const inferencePort of [0, 65536, "54321", 1.5]) assert.throws(() => buildMacosSandboxProfile({ ...sandbox, inferencePort }), /relay port/u);
  assert.throws(() => buildMacosSandboxProfile({ ...sandbox, piExecutable: "/other/pi.js" }), /installed package/u);
  assert.match(buildMacosSandboxProfile({ ...sandbox, workspace: '/private/tmp/quoted"(allow default)' }), /quoted\\"\(allow default\)/u);
});

test("temporary Pi configuration has only the relay credential and selected model", () => {
  const original = JSON.stringify({ provider, model });
  const filtered = relayPiProvider(provider, model, "http://127.0.0.1:54321");
  assert.equal(filtered.baseUrl, "http://127.0.0.1:54321");
  assert.equal(filtered.apiKey, "$TINYSDD_INFERENCE_TOKEN");
  assert.equal(filtered.models.length, 1);
  assert.equal(filtered.models[0].id, model.id);
  assert.equal(filtered.models[0].maxTokens, 1024);
  assert.equal(filtered.headers, undefined);
  assert.equal(filtered.models[0].headers, undefined);
  assert.doesNotMatch(JSON.stringify(filtered), /TINYSDD_PI_SECRET|inference\.example|other-model/u);
  assert.equal(JSON.stringify({ provider, model }), original);
});

test("relay streams only to the approved endpoint with host-held credentials", async () => {
  const calls = [];
  const handler = inferenceRelayHandler({ provider, model, env, token: "test-token", transport: async (...args) => {
    calls.push(args);
    return new Response('data: {"text":"done"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  const result = await request(handler);
  assert.equal(result.status, 200);
  assert.equal(result.text, 'data: {"text":"done"}\n\n');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "https://inference.example/v1/chat/completions");
  assert.equal(options.headers.get("authorization"), "Bearer synthetic-key");
  assert.equal(options.headers.get("x-provider"), "synthetic-provider");
  assert.equal(options.headers.get("x-model"), "synthetic-model");
  assert.equal(options.redirect, "error");
  assert.equal(JSON.parse(options.body).model, model.id);
  assert.equal(options.signal.aborted, true);
});

test("relay rejects unapproved routes, credentials and model substitutions without calling inference", async () => {
  let calls = 0;
  const handler = inferenceRelayHandler({ provider, model, env, token: "test-token", transport: async () => { calls += 1; return new Response("unexpected"); } });
  for (const options of [{ authorization: undefined }, { authorization: "Bearer wrong" }, { method: "GET" }, { url: "/models" }, { url: "/chat/completions?url=https://other.example" }, { url: "https://other.example/chat/completions" }, { body: { model: "other-model" } }]) {
    // An omitted header is different from the helper's default value.
    const result = await request(handler, options.authorization === undefined && "authorization" in options ? { ...options, authorization: "" } : options);
    assert.ok([401, 403].includes(result.status));
  }
  assert.equal(calls, 0);
});

test("relay bounds input and rejects malformed JSON before inference", async () => {
  let calls = 0;
  const handler = inferenceRelayHandler({ provider, model, env, token: "test-token", transport: async () => { calls += 1; return new Response("unexpected"); } });
  assert.equal((await request(handler, { rawBody: Buffer.from("{") })).status, 400);
  assert.equal((await request(handler, { rawBody: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(calls, 0);
});

test("relay errors do not disclose credentials and unsupported providers fail closed", async () => {
  const handler = inferenceRelayHandler({ provider, model, env, token: "test-token", transport: async () => { throw new Error("failed with synthetic-key"); } });
  const result = await request(handler);
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.text, /synthetic-key/u);
  for (const override of [{ api: "anthropic-messages" }, { baseUrl: "file:///private/etc/passwd" }, { baseUrl: "http://user:pass@example.test" }, { baseUrl: "https://example.test?token=secret" }, { apiKey: "literal-secret" }]) {
    assert.throws(() => inferenceRelayHandler({ provider: { ...provider, ...override }, model, env, token: "test-token" }), /require/u);
  }
});

test("relay honors model URL and authorization overrides without carrying client headers", async () => {
  let observed;
  const handler = inferenceRelayHandler({ provider: { ...provider, authHeader: false }, model: { ...model, baseUrl: "http://127.0.0.1:1234/v1", headers: { Authorization: "$TINYSDD_PI_SECRET_2" } }, env, token: "test-token", transport: async (url, options) => { observed = { url, options }; return new Response("done"); } });
  assert.equal((await request(handler)).status, 200);
  assert.equal(observed.url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(observed.options.headers.get("authorization"), "synthetic-model");
});

test("relay resolves declared env references on the host and hides provider error bodies", async () => {
  const filteredEnv = { ...env, TINYSDD_PI_SECRET_0: "env:GATEWAY_KEY" };
  assert.throws(() => inferenceRelayHandler({ provider, model, env: filteredEnv, token: "test-token" }), /GATEWAY_KEY/u);
  let authorization;
  const handler = inferenceRelayHandler({ provider, model, env: filteredEnv, sourceEnv: { GATEWAY_KEY: "synthetic-host-key" }, token: "test-token", transport: async (url, options) => {
    authorization = options.headers.get("authorization");
    return new Response("rejected synthetic-host-key", { status: 401 });
  } });
  const result = await request(handler);
  assert.equal(authorization, "Bearer synthetic-host-key");
  assert.equal(result.status, 401);
  assert.doesNotMatch(result.text, /synthetic-host-key/u);
});
