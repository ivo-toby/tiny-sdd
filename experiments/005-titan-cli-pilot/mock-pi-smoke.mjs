import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../../src/worker.mjs";

const syntheticKey = "synthetic-mock-key";
const syntheticProviderHeader = "synthetic-provider-header";
const syntheticModelHeader = "synthetic-model-header";

function sseResponse(id) {
  const first = { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] };
  const last = { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

const root = await mkdtemp(join(tmpdir(), "tinysdd-mock-pi-smoke-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
const home = join(root, "home");
const observed = { path: null, authorization: false, providerHeader: false, modelHeader: false };
let server;

try {
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(project, "TASK.md"), "Reply without editing files.\n");
  await writeFile(join(project, "src", "allowed.txt"), "before\n");

  server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before sending the deterministic local response.
    }
    observed.path = request.url;
    observed.authorization = request.headers.authorization === `Bearer ${syntheticKey}`;
    observed.providerHeader = request.headers["x-mock-provider"] === syntheticProviderHeader;
    observed.modelHeader = request.headers["x-mock-model"] === syntheticModelHeader;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.end(sseResponse("chatcmpl-local-smoke"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      mock: {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "$TINYSDD_MOCK_KEY",
        headers: { "X-Mock-Provider": "$TINYSDD_MOCK_PROVIDER_HEADER" },
        models: [{
          id: "mock/exact-model",
          contextWindow: 4096,
          maxTokens: 64,
          input: ["text"],
          reasoning: false,
          headers: { "X-Mock-Model": "$TINYSDD_MOCK_MODEL_HEADER" },
        }],
      },
    },
  })}\n`);

  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    key: process.env.TINYSDD_MOCK_KEY,
    providerHeader: process.env.TINYSDD_MOCK_PROVIDER_HEADER,
    modelHeader: process.env.TINYSDD_MOCK_MODEL_HEADER,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TINYSDD_MOCK_KEY = syntheticKey;
  process.env.TINYSDD_MOCK_PROVIDER_HEADER = syntheticProviderHeader;
  process.env.TINYSDD_MOCK_MODEL_HEADER = syntheticModelHeader;
  try {
    const result = await runWorker({
      projectRoot: project,
      packet: {
        schemaVersion: 1,
        taskId: "mock-pi-smoke",
        briefText: "Reply without editing files.",
        allowedPaths: ["src/allowed.txt"],
      },
      worker: {
        type: "pi",
        provider: "mock",
        model: "mock/exact-model",
        limits: { timeoutMs: 20_000, maxToolCalls: 4 },
      },
    });
    console.log(JSON.stringify({
      result: result.outcome,
      assistantStopReason: result.observed.assistantTermination.stopReason,
      processExitCode: result.observed.processTermination.exitCode,
      requestPathKind: observed.path?.endsWith("/v1/chat/completions") ?? false,
      authorizationMatched: observed.authorization,
      providerHeaderMatched: observed.providerHeader,
      modelHeaderMatched: observed.modelHeader,
      changedPaths: result.changedPaths.map((entry) => entry.path),
      scopeViolations: result.scopeViolations.map((entry) => entry.path),
    }, null, 2));
  } finally {
    for (const [name, value] of Object.entries({
      PI_CODING_AGENT_DIR: previous.agentDir,
      TINYSDD_MOCK_KEY: previous.key,
      TINYSDD_MOCK_PROVIDER_HEADER: previous.providerHeader,
      TINYSDD_MOCK_MODEL_HEADER: previous.modelHeader,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
} finally {
  server?.closeAllConnections?.();
  server?.close();
  await rm(root, { recursive: true, force: true });
}
