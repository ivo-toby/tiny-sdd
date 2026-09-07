import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePiEnvironment } from "../src/pi-environment.mjs";
import { runWorker } from "../src/worker.mjs";

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
      models: [{ id: "fake/exact-model", contextWindow: 4096, maxTokens: 256, input: ["text"], reasoning: false, headers: { Authorization: "Bearer $FAKE_TOKEN", "X-Mixed": "prefix-$$literal-$FAKE_TOKEN" } }],
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
  console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"length",content:[{type:"text",text:"truncated"}]}}));
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
    for (const [action, expected, stopReason] of [["error", "failed", "error"], ["length", "output_limit", "length"]]) {
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

  test("classifies a tool limit while retaining raw output", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ maxToolCalls: 2, timeoutMs: 5_000 }), runtime: runtime(undefined, "tools") });
      assert.equal(result.outcome, "tool_limit");
      assert.ok(result.observed.toolCalls >= 2);
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
