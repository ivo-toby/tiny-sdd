import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { piRuntimePreflight, preparePiEnvironment } from "../src/pi-environment.mjs";
import { copyProjectTree, runWorker } from "../src/worker.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  await execFileAsync("git", args, { cwd, env });
}

// A git project whose gitignored runtime state contains a symlink and a
// credential-looking file, like the talon data/ directory that broke run 1.
async function makeGitProject() {
  const root = await makeProject();
  await git(root, "init", "-q");
  await writeFile(join(root, ".gitignore"), "data/\n*.log\n");
  await git(root, "add", ".gitignore", "TASK.md", "src/allowed.txt");
  await mkdir(join(root, "data", "home", ".codex"), { recursive: true });
  await writeFile(join(root, "data", "home", ".codex", "auth.json"), "{\"token\":\"synthetic\"}\n");
  await symlink("/definitely/not/copied", join(root, "data", "home", "apply_patch"));
  await writeFile(join(root, "debug.log"), "ignored\n");
  await writeFile(join(root, "src", "untracked.ts"), "export const fresh = true;\n");
  return root;
}

async function listTree(root, prefix = "") {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await listTree(join(root, entry.name), rel));
    else output.push(rel);
  }
  return output.sort();
}

const originalTestFlag = process.env.TINYSDD_WORKER_TEST;
let fakePi;
let sourceAgentDir;

const models = {
  providers: {
    fake: {
      api: "openai-completions",
      baseUrl: "$FAKE_BASE",
      apiKey: "literal-provider-secret",
      headers: { Authorization: "Bearer $FAKE_TOKEN" },
      models: [
        { id: "fake/exact-model", contextWindow: 4096, maxTokens: 256, input: ["text"], reasoning: false, headers: { Authorization: "Bearer $FAKE_TOKEN", "X-Mixed": "prefix-$$literal-$FAKE_TOKEN" } },
        // Like the talon Qwen entry: no maxTokens and no thinking compat.
        { id: "fake/bare-model", contextWindow: 4096, input: ["text"], reasoning: false },
      ],
    },
  },
};

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "tinysdd-worker-test-project-"));
  await writeFile(join(root, "TASK.md"), "Implement the bounded test change.\n");
  await (await import("node:fs/promises")).mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "allowed.txt"), "before\n");
  return root;
}

async function makeRuntime() {
  const root = await mkdtemp(join(tmpdir(), "tinysdd-worker-test-runtime-"));
  sourceAgentDir = join(root, "agent");
  await (await import("node:fs/promises")).mkdir(sourceAgentDir, { recursive: true });
  await writeFile(join(sourceAgentDir, "models.json"), `${JSON.stringify(models)}\n`);
  fakePi = join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const action = process.env.TINYSDD_TEST_ACTION || "complete";
if (action === "allowed") writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
if (action === "outside") writeFileSync(join(process.cwd(), "outside.txt"), "outside\\n");
if (action === "error") {
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"synthetic provider failure",content:[{type:"text",text:"I could not continue."}]}}));
  process.exit(0);
}
if (action === "length") {
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"length",usage:{input:900,output:16384,reasoning:15579,cacheRead:0,cacheWrite:0,totalTokens:17284},content:[{type:"text",text:"truncated"}]}}));
  process.exit(0);
}
if (action === "think") {
  // Reads, then a long silent planning phase with no write (talon run 3).
  for (let i = 0; i < 2; i += 1) console.log(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"src/allowed.txt"}}));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
}
if (action === "write-late") {
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(JSON.stringify({type:"tool_execution_start",toolName:"write",args:{path:"src/allowed.txt"}}));
  writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
  await new Promise((resolve) => setTimeout(resolve, 900));
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"Wrote the file."}]}}));
  process.exit(0);
}
if (action === "reread") {
  for (const path of [join(process.cwd(), "src", "allowed.txt"), "./src/allowed.txt", "src/allowed.txt", "TASK.md"]) {
    console.log(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path}}));
  }
  console.log(JSON.stringify({type:"compaction_end",reason:"threshold",aborted:false,willRetry:false,result:{summary:"Summary of the task so far.",firstKeptEntryId:"e7",tokensBefore:90000,estimatedTokensAfter:24000}}));
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"Done reading."}]}}));
  process.exit(0);
}
if (action === "tools") {
  for (let i = 0; i < 4; i += 1) console.log(JSON.stringify({type:"tool_execution_start",toolName:"read"}));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.exit(0);
}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"Changed the file; verification is unrun."}]}}));
`);
  await chmod(fakePi, 0o755);
  return root;
}

function worker(limits = {}) {
  return { type: "pi", provider: "fake", model: "fake/exact-model", limits: { timeoutMs: 2_000, maxToolCalls: 4, ...limits } };
}

function packet(allowedPaths = ["src/allowed.txt"]) {
  return { schemaVersion: 1, taskId: "task-worker-test", briefText: "Implement the exact bounded change. Do not broaden scope.", allowedPaths };
}

function runtime(runtimeRoot, action = "complete") {
  return {
    test: true,
    piExecutable: fakePi,
    sourceAgentDir,
      sourceEnv: { FAKE_BASE: "http://127.0.0.1:9/v1", FAKE_TOKEN: "synthetic-header-secret" },
    testEnv: { TINYSDD_TEST_ACTION: action },
  };
}

before(async () => {
  process.env.TINYSDD_WORKER_TEST = "1";
  const runtimeRoot = await makeRuntime();
  // Keep the directory alive for the suite; each project remains independent.
  process.env.TINYSDD_TEST_RUNTIME_ROOT = runtimeRoot;
});

after(async () => {
  const runtimeRoot = process.env.TINYSDD_TEST_RUNTIME_ROOT;
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  if (originalTestFlag === undefined) delete process.env.TINYSDD_WORKER_TEST;
  else process.env.TINYSDD_WORKER_TEST = originalTestFlag;
  delete process.env.TINYSDD_TEST_RUNTIME_ROOT;
});

describe("Pi environment filtering", () => {
  test("copies only placeholders and expands selected credential references in child env", async () => {
    const prepared = await preparePiEnvironment({ worker: worker(), profile: { schemaVersion: 1, id: "test-profile", runtime: { reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } } }, sourceAgentDir, sourceEnv: { FAKE_BASE: "http://127.0.0.1:9/v1", FAKE_TOKEN: "synthetic-header-secret" } });
    try {
      const state = await readFile(join(prepared.stateDir, "models.json"), "utf8");
      assert.doesNotMatch(state, /literal-provider-secret|synthetic-header-secret/u);
      assert.match(state, /TINYSDD_PI_SECRET_/u);
      assert.match(state, /"baseUrl": "http:\/\/127\.0\.0\.1:9\/v1"/u);
      assert.doesNotMatch(state, /\$TINYSDD_PI_ENV_/u);
      assert.doesNotMatch(state, /prefix-\$literal/u);
      assert.match(state, /"reasoning": true/u);
      assert.ok(Object.values(prepared.env).includes("Bearer synthetic-header-secret"));
      assert.ok(Object.values(prepared.env).includes("prefix-$literal-synthetic-header-secret"));
      const settings = JSON.parse(await readFile(join(prepared.stateDir, "settings.json"), "utf8"));
      assert.deepEqual(settings, { retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } }, compaction: { enabled: false } });
      assert.equal(prepared.metadata.provider, "fake");
      assert.equal(prepared.metadata.model, "fake/exact-model");
      assert.equal(prepared.metadata.rawReasoning, false);
      assert.equal(prepared.metadata.effectiveReasoning, true);
      assert.equal(JSON.stringify(prepared.metadata).includes("secret"), false);
    } finally {
      await prepared.cleanup();
    }
  });

  test("requires the exact configured provider and model without fallback", async () => {
    await assert.rejects(
      preparePiEnvironment({ worker: { ...worker(), model: "fake/other-model" }, sourceAgentDir }),
      /Configured Pi model is unavailable/u,
    );
    await assert.rejects(
      preparePiEnvironment({ worker: { ...worker(), provider: "other" }, sourceAgentDir }),
      /Configured Pi provider is unavailable/u,
    );
  });
});

describe("Pi runtime preflight", () => {
  const api = "openai-completions";

  test("flags the talon run 2 entry: thinking off but no toggle sent and Pi's default token cap", () => {
    const report = piRuntimePreflight({ api, model: { id: "qwen", reasoning: false }, thinking: "off" });
    assert.equal(report.thinking.control, "not-sent");
    assert.deepEqual(report.maxTokens, { value: 16384, source: "pi-default" });
    assert.deepEqual(report.errors, []);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings[0], /may not disable thinking/u);
    assert.match(report.warnings[1], /no maxTokens.*16384/u);
  });

  test("refuses a thinking level that Pi cannot send", () => {
    const report = piRuntimePreflight({ api, model: { id: "qwen", reasoning: false, maxTokens: 65536 }, thinking: "high" });
    assert.equal(report.thinking.control, "not-sent");
    assert.match(report.errors[0], /thinking "high" was requested but cannot be sent/u);
    const unmapped = piRuntimePreflight({ api, model: { id: "q", reasoning: true, maxTokens: 8192, thinkingLevelMap: { high: null }, compat: { thinkingFormat: "qwen-chat-template" } }, thinking: "high" });
    assert.equal(unmapped.errors.length, 1);
  });

  test("accepts explicit qwen chat-template control and warns when reasoning can consume the whole response", () => {
    const thinkingOn = { id: "qwen", reasoning: true, maxTokens: 65536, compat: { thinkingFormat: "qwen-chat-template" } };
    const high = piRuntimePreflight({ api, model: thinkingOn, thinking: "high" });
    assert.equal(high.thinking.control, "sent");
    assert.deepEqual(high.errors, []);
    assert.deepEqual(high.warnings.map((warning) => /share one 65536-token response cap/u.test(warning)), [true]);
    const budgeted = piRuntimePreflight({ api, model: { ...thinkingOn, compat: { ...thinkingOn.compat, thinkingTokenBudgetField: "thinking_budget_tokens" } }, thinking: "high" });
    assert.deepEqual(budgeted.warnings, []);
    assert.equal(budgeted.thinkingTokenBudgetField, "thinking_budget_tokens");
    const off = piRuntimePreflight({ api, model: thinkingOn, thinking: "off" });
    assert.equal(off.thinking.control, "sent");
    assert.deepEqual(off.warnings, []);
  });

  test("reports the per-response thinking budget Pi will send", () => {
    const qwen = { id: "qwen", reasoning: true, maxTokens: 65536, compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } };
    const medium = piRuntimePreflight({ api, model: qwen, thinking: "medium" });
    assert.deepEqual(medium.thinkingBudget, { field: "thinking_budget_tokens", tokens: 8192, source: "pi-default", clamped: false, sent: true });
    assert.deepEqual(medium.warnings, []);
    const custom = piRuntimePreflight({ api, model: qwen, thinking: "high", thinkingBudgets: { high: 12000 } });
    assert.equal(custom.thinkingBudget.tokens, 12000);
    assert.equal(custom.thinkingBudget.source, "profile");
    const tight = piRuntimePreflight({ api, model: { ...qwen, maxTokens: 4096 }, thinking: "high" });
    assert.deepEqual([tight.thinkingBudget.tokens, tight.thinkingBudget.clamped], [3072, true]);
    const none = piRuntimePreflight({ api, model: { ...qwen, maxTokens: 1024 }, thinking: "high" });
    assert.equal(none.thinkingBudget.sent, false);
    assert.match(none.warnings.join("\n"), /no room for a thinking budget/u);
    const unsent = piRuntimePreflight({ api, model: { ...qwen, compat: { thinkingFormat: "qwen-chat-template" } }, thinking: "high", thinkingBudgets: { high: 12000 } });
    assert.equal(unsent.thinkingBudget, null);
    assert.match(unsent.warnings.join("\n"), /thinkingBudgets are configured but no compat.thinkingTokenBudgetField/u);
  });

  test("writes profile thinking budgets into the worker's temporary Pi settings only", async () => {
    const profile = { schemaVersion: 1, id: "budgeted", runtime: { thinking: "medium", reasoning: true, compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" }, thinkingBudgets: { medium: 6000 } } };
    const prepared = await preparePiEnvironment({ worker: { ...worker(), model: "fake/bare-model" }, profile, sourceAgentDir, sourceEnv: { FAKE_BASE: "http://127.0.0.1:9/v1", FAKE_TOKEN: "synthetic-header-secret" } });
    try {
      const settings = JSON.parse(await readFile(join(prepared.stateDir, "settings.json"), "utf8"));
      assert.deepEqual(settings.thinkingBudgets, { medium: 6000 });
      const state = JSON.parse(await readFile(join(prepared.stateDir, "models.json"), "utf8"));
      assert.equal(state.providers.fake.models[0].compat.thinkingTokenBudgetField, "thinking_budget_tokens");
      assert.deepEqual(prepared.metadata.preflight.thinkingBudget, { field: "thinking_budget_tokens", tokens: 6000, source: "profile", clamped: false, sent: true });
    } finally {
      await prepared.cleanup();
    }
  });

  test("models the off value for reasoning_effort formats and unknown or native APIs", () => {
    const openai = { id: "m", reasoning: true, maxTokens: 4096, compat: { thinkingFormat: "openai" } };
    assert.equal(piRuntimePreflight({ api, model: openai, thinking: "off" }).thinking.control, "not-sent");
    assert.equal(piRuntimePreflight({ api, model: { ...openai, thinkingLevelMap: { off: "none" } }, thinking: "off" }).thinking.control, "sent");
    const autodetected = piRuntimePreflight({ api, model: { id: "m", reasoning: true, maxTokens: 4096 }, thinking: "off" });
    assert.equal(autodetected.thinking.control, "unverified");
    assert.equal(autodetected.warnings.length, 1);
    const native = piRuntimePreflight({ api: "anthropic-messages", model: { id: "m", reasoning: true, maxTokens: 4096 }, thinking: "high" });
    assert.equal(native.thinking.control, "provider-native");
    assert.deepEqual(native.errors, []);
  });
});

describe("Pi worker capture and scope", () => {
  test("runs a fake Pi only through the test harness and reports an allowed edit", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
      assert.equal(result.outcome, "completed");
      assert.equal(result.observed.assistantTermination.stopReason, "stop");
      assert.deepEqual(result.scopeViolations, []);
      assert.deepEqual(result.changedPaths.map((entry) => entry.path), ["src/allowed.txt"]);
      assert.equal(result.patch.portable, true);
      assert.equal(result.patch.applyCheck.pass, true);
      assert.equal(await readFile(join(result.artifactPaths.candidate, "src", "allowed.txt"), "utf8"), "after\n");
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), "before\n");
      assert.equal(result.modelClaims.unverified, true);
      assert.match(await readFile(result.artifactPaths.patch, "utf8"), /allowed\.txt/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains an out-of-scope edit as a violation without applying it to source", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "outside") });
      assert.equal(result.outcome, "completed");
      assert.deepEqual(result.scopeViolations.map((entry) => entry.path), ["outside.txt"]);
      await assert.rejects(readFile(join(project, "outside.txt")));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("renders an approved revision review as bounded worker context", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), review: { verdict: "revision", by: "reviewer", evidence: { text: "Fix only the named assertion gap." } } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      assert.equal(result.outcome, "completed");
      assert.match(await readFile(result.artifactPaths.prompt, "utf8"), /Caller revision constraints/u);
      const context = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
      assert.ok(context.resources.some((entry) => entry.path === "<inline-review-evidence>" && entry.sha256));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("overlays only an explicit completed scope-clean base run into a revision candidate", async () => {
    const project = await makeProject();
    const baseRunId = "worker-2026-09-06T00-00-00-000Z-abcdef12";
    try {
      const baseRoot = join(project, ".tinysdd", "runs", baseRunId);
      await mkdir(join(baseRoot, "workspace-after", "src"), { recursive: true });
      await writeFile(join(baseRoot, "workspace-after", "src", "allowed.txt"), "base candidate\n");
      await writeFile(join(baseRoot, "result.json"), JSON.stringify({
        outcome: "completed",
        changedPaths: [{ path: "src/allowed.txt", change: "modified" }],
        scopeViolations: [],
      }));
      const result = await runWorker({
        projectRoot: project,
        packet: packet(),
        worker: worker(),
        baseRunId,
        runtime: runtime(undefined, "complete"),
      });
      assert.deepEqual(result.baseRun, { id: baseRunId, paths: ["src/allowed.txt"] });
      assert.equal(await readFile(join(result.artifactPaths.candidate, "src", "allowed.txt"), "utf8"), "base candidate\n");
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), "before\n");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("overlays every scope-clean ancestor so later revisions retain earlier allowed edits", async () => {
    const project = await makeProject();
    const ancestorId = "worker-2026-09-06T00-00-00-000Z-ancestor01";
    const parentId = "worker-2026-09-06T00-00-01-000Z-parent000";
    try {
      await writeFile(join(project, "src", "other.txt"), "source other\n");
      const ancestorRoot = join(project, ".tinysdd", "runs", ancestorId);
      await mkdir(join(ancestorRoot, "workspace-after", "src"), { recursive: true });
      await writeFile(join(ancestorRoot, "workspace-after", "src", "allowed.txt"), "ancestor edit\n");
      await writeFile(join(ancestorRoot, "result.json"), JSON.stringify({
        taskId: "task-worker-test",
        outcome: "completed",
        changedPaths: [{ path: "src/allowed.txt", change: "modified" }],
        scopeViolations: [],
      }));
      const parentRoot = join(project, ".tinysdd", "runs", parentId);
      await mkdir(join(parentRoot, "workspace-after", "src"), { recursive: true });
      // A historical direct-parent snapshot may lack the ancestor's edit. The
      // resolver must reconstruct both files from the lineage, not trust it.
      await writeFile(join(parentRoot, "workspace-after", "src", "other.txt"), "parent edit\n");
      await writeFile(join(parentRoot, "result.json"), JSON.stringify({
        taskId: "task-worker-test",
        baseRun: { id: ancestorId, paths: ["src/allowed.txt"] },
        outcome: "completed",
        changedPaths: [{ path: "src/other.txt", change: "modified" }],
        scopeViolations: [],
      }));
      const result = await runWorker({
        projectRoot: project,
        packet: packet(["src/allowed.txt", "src/other.txt"]),
        worker: worker(),
        baseRunId: parentId,
        runtime: runtime(undefined, "complete"),
      });
      assert.deepEqual(result.baseRun, {
        id: parentId,
        paths: ["src/allowed.txt", "src/other.txt"],
        chain: [
          { id: ancestorId, paths: ["src/allowed.txt"] },
          { id: parentId, paths: ["src/other.txt"] },
        ],
      });
      assert.equal(await readFile(join(result.artifactPaths.candidate, "src", "allowed.txt"), "utf8"), "ancestor edit\n");
      assert.equal(await readFile(join(result.artifactPaths.candidate, "src", "other.txt"), "utf8"), "parent edit\n");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("replays a task from an immutable worker baseline instead of the current project", async () => {
    const project = await makeProject();
    try {
      const source = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "complete") });
      await writeFile(join(project, "src", "allowed.txt"), "current-project-state\n");
      const replay = await runWorker({
        projectRoot: project,
        packet: packet(),
        worker: worker(),
        baselineRunId: source.runId,
        runtime: runtime(undefined, "complete"),
      });
      assert.deepEqual(replay.baselineRun, { id: source.runId });
      assert.equal(await readFile(join(replay.artifactPaths.workspaceBefore, "src", "allowed.txt"), "utf8"), "before\n");
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), "current-project-state\n");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects a brief whose supplied digest does not match its text", async () => {
    const project = await makeProject();
    try {
      await assert.rejects(
        runWorker({
          projectRoot: project,
          packet: { ...packet(), briefText: undefined, brief: { path: "docs/brief.md", text: "approved brief\n", sha256: "0".repeat(64) } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        }),
        /brief digest does not match/u,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains brief path identity and loads its directory AGENTS guidance", async () => {
    const project = await makeProject();
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(project, "docs"), { recursive: true });
      const briefText = "approved brief from a project file\n";
      await writeFile(join(project, "docs", "brief.md"), briefText);
      await writeFile(join(project, "docs", "AGENTS.md"), "Use the docs-specific guidance.\n");
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), briefText: undefined, brief: { path: "docs/brief.md", text: briefText, sha256: createHash("sha256").update(briefText).digest("hex") } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      const context = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
      assert.ok(context.resources.some((entry) => entry.path === "docs/brief.md" && entry.sha256));
      assert.ok(context.resources.some((entry) => entry.path === "docs/AGENTS.md" && entry.sha256));
      assert.match(await readFile(result.artifactPaths.prompt, "utf8"), /Use the docs-specific guidance/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("injects a dedicated controller task artifact without exposing controller state", async () => {
    const project = await makeProject();
    try {
      const fs = await import("node:fs/promises");
      const briefText = "controller task brief\n";
      await fs.mkdir(join(project, ".tinysdd", "tasks"), { recursive: true });
      await writeFile(join(project, ".tinysdd", "tasks", "brief.md"), briefText);
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), briefText: undefined, brief: { path: ".tinysdd/tasks/brief.md", text: briefText, sha256: createHash("sha256").update(briefText).digest("hex") } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      const context = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
      assert.ok(context.resources.some((entry) => entry.path === ".tinysdd/tasks/brief.md" && entry.sha256));
      assert.equal(context.resources.some((entry) => entry.path.startsWith(".tinysdd/") && entry.path !== ".tinysdd/tasks/brief.md"), false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("injects compiled facts and exact source excerpts as auditable reference data", async () => {
    const project = await makeProject();
    try {
      const contextText = JSON.stringify({
        schemaVersion: 1,
        facts: ["The first line is an immutable compatibility contract."],
        resources: [{ path: "src/allowed.txt", startLine: 1, endLine: 1, purpose: "Current behavior to preserve." }],
      });
      const result = await runWorker({
        projectRoot: project,
        packet: {
          ...packet(),
          context: {
            path: ".tinysdd/tasks/task.context.json",
            text: contextText,
            sha256: createHash("sha256").update(contextText).digest("hex"),
          },
        },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      assert.ok(result.artifactPaths.compiledContext);
      const rendered = await readFile(result.artifactPaths.compiledContext, "utf8");
      assert.match(rendered, /immutable compatibility contract/u);
      assert.match(rendered, /1 \| before/u);
      assert.match(await readFile(result.artifactPaths.prompt, "utf8"), /Do not re-read cited source files/u);
      const metadata = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
      assert.equal(metadata.compiledContext.manifest.path, ".tinysdd/tasks/task.context.json");
      assert.equal(metadata.compiledContext.resources[0].path, "src/allowed.txt");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("classifies assistant errors and length stops independently of process exit zero", async () => {
    for (const [action, expected, stopReason] of [["error", "failed", "error"], ["length", "response_token_limit", "length"]]) {
      const project = await makeProject();
      try {
        const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, action) });
        assert.equal(result.outcome, expected);
        assert.equal(result.observed.processTermination.exitCode, 0);
        assert.equal(result.observed.assistantTermination.stopReason, stopReason);
        assert.equal(result.observed.usageScope, "final-assistant-message");
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }
  });

  test("records the effective token cap and reasoning share for a response token limit", async () => {
    for (const [model, maxTokens, maxTokensSource] of [["fake/exact-model", 256, "model"], ["fake/bare-model", 16384, "pi-default"]]) {
      const project = await makeProject();
      try {
        const result = await runWorker({ projectRoot: project, packet: packet(), worker: { ...worker(), model }, runtime: runtime(undefined, "length") });
        assert.equal(result.outcome, "response_token_limit");
        assert.deepEqual(result.limitDetails, { maxTokens, maxTokensSource, outputTokens: 16384, reasoningTokens: 15579 });
        assert.deepEqual(result.observed.cumulativeUsage, { assistantMessages: 1, input: 900, output: 16384, reasoning: 15579, totalTokens: 17284 });
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }
  });

  test("refuses an unhonorable thinking request and records effective runtime state", async () => {
    const project = await makeProject();
    try {
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(), worker: worker(), profile: { schemaVersion: 1, id: "wants-thinking", runtime: { thinking: "high" } }, runtime: runtime(undefined, "complete") }),
        /Worker preflight failed: thinking "high" was requested but cannot be sent/u,
      );
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: { ...worker(), model: "fake/bare-model" }, runtime: runtime(undefined, "complete") });
      const metadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(metadata.thinking, "off");
      assert.equal(metadata.effectiveThinkingControl, "not-sent");
      assert.equal(metadata.effectiveMaxTokens, 16384);
      assert.equal(metadata.maxTokensSource, "pi-default");
      assert.equal(metadata.preflight.warnings.length, 2);
      assert.equal(result.warnings.filter((warning) => warning.startsWith("Preflight: ")).length, 2);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("stops a run with no write or edit by firstWriteMs as no_progress", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ timeoutMs: 10_000, firstWriteMs: 400 }), runtime: runtime(undefined, "think") });
      assert.equal(result.outcome, "no_progress");
      assert.ok(result.observed.processTermination.elapsedMs < 3_000);
      assert.equal(result.limitDetails.firstWriteMs, 400);
      assert.equal(result.observed.writeCalls, 0);
      assert.equal(result.observed.firstWriteAtMs, null);
      assert.deepEqual(result.observed.toolCallsByName, { read: 2 });
      assert.match(await readFile(result.artifactPaths.stdout, "utf8"), /tool_execution_start/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("lets a run continue once it has started a write before firstWriteMs", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ timeoutMs: 10_000, firstWriteMs: 600 }), runtime: runtime(undefined, "write-late") });
      assert.equal(result.outcome, "completed");
      assert.equal(result.observed.writeCalls, 1);
      assert.ok(result.observed.firstWriteAtMs !== null && result.observed.firstWriteAtMs < 600);
      assert.ok(result.observed.processTermination.elapsedMs > 600);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("measures cited re-reads and records compaction without trusting its summary", async () => {
    const project = await makeProject();
    try {
      const contextText = JSON.stringify({ schemaVersion: 1, facts: [], resources: [{ path: "src/allowed.txt", startLine: 1, endLine: 1, purpose: "Cited contract." }] });
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), context: { path: ".tinysdd/tasks/task.context.json", text: contextText, sha256: createHash("sha256").update(contextText).digest("hex") } },
        worker: worker({ maxToolCalls: 10 }),
        runtime: runtime(undefined, "reread"),
      });
      assert.equal(result.outcome, "completed");
      assert.equal(result.observed.reads, 4);
      assert.equal(result.observed.citedRereads, 3);
      assert.deepEqual(result.taskShape, { allowedFiles: 1, contextFacts: 0, compiledContextBytes: result.taskShape.compiledContextBytes, citedResources: 1, citedLines: 1, citedTestLines: 0 });
      assert.ok(result.taskShape.compiledContextBytes > 0);
      assert.deepEqual(result.observed.repeatedReads, { "src/allowed.txt": 3 });
      assert.equal(result.observed.compactions.length, 1);
      assert.equal(result.observed.compactions[0].tokensBefore, 90000);
      assert.equal(result.observed.compactions[0].summarySha256, createHash("sha256").update("Summary of the task so far.").digest("hex"));
      assert.ok(result.warnings.some((warning) => /compacted the worker context/u.test(warning)));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("classifies a tool limit while retaining raw output", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ maxToolCalls: 2, timeoutMs: 5_000 }), runtime: runtime(undefined, "tools") });
      assert.equal(result.outcome, "tool_limit");
      assert.ok(result.observed.toolCalls >= 2);
      assert.equal(result.limitDetails.maxToolCalls, 2);
      assert.match(await readFile(result.artifactPaths.stdout, "utf8"), /tool_execution_start/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects source symlink escapes before any model execution", async () => {
    const project = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), "tinysdd-worker-test-outside-"));
    try {
      await (await import("node:fs/promises")).symlink(outside, join(project, "linked"));
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "complete") }),
        /Source contains a symlink/u,
      );
      assert.equal(await realpath(join(project, "linked")), await realpath(outside));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("copies a git project from ls-files so ignored runtime state never reaches the worker", async () => {
    const project = await makeGitProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
      assert.equal(result.outcome, "completed");
      assert.equal(result.workspaceCopy.mode, "git-ls-files");
      assert.deepEqual(await listTree(result.artifactPaths.workspaceBefore), [".gitignore", "TASK.md", "src/allowed.txt", "src/untracked.ts"]);
      assert.deepEqual(result.changedPaths.map((entry) => entry.path), ["src/allowed.txt"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("records the walk fallback outside a git repository", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "complete") });
      assert.equal(result.workspaceCopy.mode, "walk");
      assert.equal(typeof result.workspaceCopy.fallbackReason, "string");
      assert.deepEqual(await listTree(result.artifactPaths.workspaceBefore), ["TASK.md", "src/allowed.txt"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects an allowed path or context resource that the git copy leaves out", async () => {
    const project = await makeGitProject();
    try {
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(["src/allowed.txt", "debug.log"]), worker: worker(), runtime: runtime(undefined, "complete") }),
        /Allowed path exists but is not part of the worker copy.*debug\.log/u,
      );
      const manifest = JSON.stringify({ schemaVersion: 1, facts: [], resources: [{ path: "debug.log", startLine: 1, endLine: 1, purpose: "Ignored file." }] });
      await assert.rejects(
        runWorker({
          projectRoot: project,
          packet: { ...packet(), context: { path: ".tinysdd/tasks/ctx.json", text: manifest, sha256: createHash("sha256").update(manifest).digest("hex") } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        }),
        /Context resource is not part of the worker copy.*debug\.log/u,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("git copy refuses an empty listing instead of an empty workspace", async () => {
    const outer = await mkdtemp(join(tmpdir(), "tinysdd-copy-outer-"));
    const destination = await mkdtemp(join(tmpdir(), "tinysdd-copy-test-"));
    try {
      await git(outer, "init", "-q");
      await writeFile(join(outer, ".gitignore"), "project/\n");
      await mkdir(join(outer, "project", "src"), { recursive: true });
      await writeFile(join(outer, "project", "src", "allowed.txt"), "before\n");
      await assert.rejects(copyProjectTree(join(outer, "project"), destination), /listed no copyable files.*gitignored by an enclosing repository/u);
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("git copy keeps symlink rejection, skips deleted tracked files and enforces limits", async () => {
    const project = await makeGitProject();
    const destinations = [];
    const destination = async () => {
      const path = await mkdtemp(join(tmpdir(), "tinysdd-copy-test-"));
      destinations.push(path);
      return path;
    };
    try {
      await writeFile(join(project, "src", "gone.txt"), "tracked\n");
      await git(project, "add", "src/gone.txt");
      await rm(join(project, "src", "gone.txt"));
      const copy = await copyProjectTree(project, await destination());
      assert.equal(copy.mode, "git-ls-files");
      assert.equal(copy.missingSkipped, 1);
      assert.equal(copy.files, 4);
      await assert.rejects(copyProjectTree(project, await destination(), { maxFiles: 3 }), /exceeds bounded worker input size/u);
      await assert.rejects(copyProjectTree(project, await destination(), { maxBytes: 8 }), /exceeds bounded worker input size/u);
      await symlink("allowed.txt", join(project, "src", "tracked-link"));
      await git(project, "add", "src/tracked-link");
      await assert.rejects(copyProjectTree(project, await destination()), /Source contains a symlink; refusing to copy src\/tracked-link/u);
    } finally {
      await rm(project, { recursive: true, force: true });
      for (const path of destinations) await rm(path, { recursive: true, force: true });
    }
  });

  test("fails closed when the Linux sandbox executable is unavailable", async () => {
    const project = await makeProject();
    try {
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: { test: false, bwrapExecutable: "/definitely/missing/bwrap", piExecutable: fakePi } }),
        /bubblewrap.*unavailable|unavailable.*bubblewrap/u,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
