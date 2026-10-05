import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { compileContext } from "../src/context-compiler.mjs";
import { piRuntimePreflight, preparePiEnvironment } from "../src/pi-environment.mjs";
import { copyProjectTree, runWorker } from "../src/worker.mjs";
import { buildSessionContext } from "./pi100-session-projection.mjs";

const execFileAsync = promisify(execFile);
// The worker rejects a project root or temp dir that resolves through a symlink,
// and tmpdir() does on macOS (/var -> /private/var), so use the real path.
const canonicalTmpdir = await realpath(tmpdir());

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

// Aborts once the fake Pi has emitted its tool events, so the abort never races
// the run's setup or the fake's startup.
async function abortWhenReading(project, controller) {
  const runs = join(project, ".tinysdd", "runs");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      for (const run of await readdir(runs)) {
        if ((await readFile(join(runs, run, "stdout.jsonl"), "utf8")).includes("tool_execution_start")) return controller.abort();
      }
    } catch {
      // The run directory or its output does not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
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
const originalTmpdirOverride = process.env.TINYSDD_TMPDIR;
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
  const root = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-test-project-"));
  await writeFile(join(root, "TASK.md"), "Implement the bounded test change.\n");
  await (await import("node:fs/promises")).mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "allowed.txt"), "before\n");
  return root;
}

async function makeRuntime() {
  const root = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-test-runtime-"));
  sourceAgentDir = join(root, "agent");
  await (await import("node:fs/promises")).mkdir(sourceAgentDir, { recursive: true });
  await writeFile(join(sourceAgentDir, "models.json"), `${JSON.stringify(models)}\n`);
  fakePi = join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const action = process.env.TINYSDD_TEST_ACTION || "complete";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const checkChannel = process.env.TINYSDD_CHECK_CHANNEL;
function writeCheckRequest(toolCallId, params) {
  const name = \`${'${'}createHash("sha256").update(toolCallId).digest("hex")}.json\`;
  const temporary = join(checkChannel, "requests", \`${'${'}name}.tmp\`);
  writeFileSync(temporary, JSON.stringify(params), { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(checkChannel, "requests", name));
  return name;
}
async function requestCheck(toolCallId, params) {
  const name = writeCheckRequest(toolCallId, params);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { return JSON.parse(readFileSync(join(checkChannel, "responses", name), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("check response timeout");
}
async function runCheckTool(toolCallId, params) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "run_checks", args: params }));
  return requestCheck(toolCallId, params);
}
if (action === "allowed") writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
if (action === "protected") writeFileSync(join(process.cwd(), "src", "contract.txt"), "changed\\n");
if (action === "input") writeFileSync(join(process.cwd(), "docs", "brief.md"), "rewritten brief\\n");
if (action === "outside") writeFileSync(join(process.cwd(), "outside.txt"), "outside\\n");
if (action === "dependency") writeFileSync(join(process.cwd(), "vendor", "dependency", "extra.mjs"), "extra\\n");
if (action === "type-change") { rmSync(join(process.cwd(), "empty"), { recursive: true, force: true }); writeFileSync(join(process.cwd(), "empty"), "file\\n"); }
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
if (action === "write-then-hang") {
  writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
  console.log(JSON.stringify({type:"tool_execution_start",toolName:"write",args:{path:"src/allowed.txt"}}));
  await new Promise((resolve) => setTimeout(resolve, 3000));
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
if (action === "deterministic-compaction") {
  const extensionIndex = process.argv.indexOf("-e");
  const extensionPath = extensionIndex >= 0 ? process.argv[extensionIndex + 1] : null;
  const anchorPath = process.env.TINYSDD_COMPACTION_ANCHOR;
  const anchor = anchorPath ? JSON.parse(readFileSync(anchorPath, "utf8")).anchor : null;
  const sessionIndex = process.argv.indexOf("--session");
  const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : null;
  if (extensionIndex < 0 || !extensionPath || !anchor || !sessionPath) throw new Error("deterministic compaction extension was not loaded with its anchor and session");
  const entries = [
    { type: "session", version: 3, id: "session-1", parentId: null },
    { type: "message", id: "old-1", parentId: "session-1", message: { role: "user", content: "old context" } },
    { type: "message", id: "keep-1", parentId: "old-1", message: { role: "assistant", content: [{ type: "text", text: "kept context" }] } },
  ];
  writeFileSync(sessionPath, \`\${entries.map((entry) => JSON.stringify(entry)).join("\\n")}\\n\`, { mode: 0o600 });
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data, id: \`custom-\${entries.length}\`, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-10-04T10:00:00.000Z" };
      entries.push(entry);
      appendFileSync(sessionPath, \`\${JSON.stringify(entry)}\\n\`);
    },
  };
  const extension = await import(pathToFileURL(extensionPath).href);
  extension.default(pi);
  const handler = handlers.get("session_before_compact");
  if (typeof handler !== "function") throw new Error("deterministic compaction hook was not registered");
  const response = await handler({
    preparation: {
      firstKeptEntryId: "keep-1",
      tokensBefore: 90000,
      messagesToSummarize: [{ role: "user", content: "old context" }],
      turnPrefixMessages: [],
    },
    branchEntries: entries,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  }, {});
  if (response.cancel || !response.compaction) throw new Error("deterministic compaction hook refused synthetic retained input");
  const compactionEntry = {
    type: "compaction",
    id: "compact-1",
    parentId: "keep-1",
    summary: response.compaction.summary,
    firstKeptEntryId: response.compaction.firstKeptEntryId,
    tokensBefore: response.compaction.tokensBefore,
    details: response.compaction.details,
    fromHook: true,
    timestamp: "2026-10-04T10:00:01.000Z",
  };
  entries.push(compactionEntry);
  appendFileSync(sessionPath, \`\${JSON.stringify(compactionEntry)}\\n\`);
  const newMessage = { type: "message", id: "new-1", parentId: "compact-1", message: { role: "assistant", content: [{ type: "text", text: "after retained compaction" }] } };
  entries.push(newMessage);
  appendFileSync(sessionPath, \`\${JSON.stringify(newMessage)}\\n\`);
  const refusal = await handler({
    preparation: { firstKeptEntryId: "new-1", tokensBefore: 1, messagesToSummarize: [], turnPrefixMessages: [] },
    branchEntries: entries,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  }, {});
  if (!refusal.cancel || refusal.details?.code !== "COMPACTION_EMPTY") throw new Error("deterministic compaction hook did not refuse empty input");
  // Pi 1.0 emits no cancel details in compaction_end; the custom audit entry
  // above is the persisted refusal record and remains outside model context.
  console.log(JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: response.compaction.summary, firstKeptEntryId: response.compaction.firstKeptEntryId, tokensBefore: response.compaction.tokensBefore, estimatedTokensAfter: response.compaction.estimatedTokensAfter, details: response.compaction.details, fromHook: true } }));
  console.log(JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done after deterministic compaction." }] } }));
  process.exit(0);
}
if (action === "tools") {
  for (let i = 0; i < 4; i += 1) console.log(JSON.stringify({type:"tool_execution_start",toolName:"read"}));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.exit(0);
}
if (action === "checks") {
  const individual = await runCheckTool("checks-individual", { checkId: "first" });
  const all = await runCheckTool("checks-all", {});
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ individual, all }) }] } }));
  process.exit(0);
}
if (action === "check-watchdog") {
  await runCheckTool("check-watchdog", { checkId: "first" });
  await delay(3000);
  process.exit(0);
}
if (action === "check-hang") {
  await runCheckTool("check-hang", { checkId: "first" });
}
if (action === "check-exit") {
  writeCheckRequest("check-exit", { checkId: "first" });
  await delay(250);
  process.exit(0);
}
if (action === "args") {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] } }));
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

function retainedSnapshot(files) {
  const snapshot = Object.create(null);
  for (const [path, value] of Object.entries(files)) {
    if (value === null) continue;
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      snapshot[directory] ??= { kind: "directory", sha256: null, size: null };
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    snapshot[path] = { kind: "file", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  }
  return snapshot;
}

function retainedChanges(before, after) {
  const identity = (value) => {
    if (value === undefined || value === null) return null;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { kind: "file", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  };
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((path) => {
    const was = before[path] ?? null;
    const now = after[path] ?? null;
    if (Buffer.isBuffer(was) && Buffer.isBuffer(now) ? was.equals(now) : was === now) return [];
    return [{ path, change: now === null ? "deleted" : was === null ? "created" : "modified", before: identity(was), after: identity(now) }];
  });
}

async function writeRetainedRun(root, runId, { taskId = "task-worker-test", before = {}, after = {}, baseRun, changedPaths } = {}) {
  const directory = join(root, ".tinysdd", "runs", runId);
  await mkdir(join(directory, "workspace-before"), { recursive: true });
  await mkdir(join(directory, "workspace-after"), { recursive: true });
  for (const [workspace, files] of [["workspace-before", before], ["workspace-after", after]]) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) continue;
      await mkdir(dirname(join(directory, workspace, path)), { recursive: true });
      await writeFile(join(directory, workspace, path), content);
    }
  }
  await writeFile(join(directory, "before-snapshot.json"), JSON.stringify(retainedSnapshot(before)));
  await writeFile(join(directory, "after-snapshot.json"), JSON.stringify(retainedSnapshot(after)));
  const changes = retainedChanges(before, after);
  const claimed = changedPaths === undefined ? changes : changedPaths.map((change) => ({ ...changes.find((entry) => entry.path === change.path), ...change }));
  await writeFile(join(directory, "result.json"), JSON.stringify({
    taskId,
    outcome: "completed",
    ...(baseRun ? { baseRun } : {}),
    changedPaths: claimed,
    scopeViolations: [],
    fileScope: { mode: "ordinary-create-modify", actualPaths: changes.map(({ path }) => path).sort(), ordinaryCreateModify: true, deletions: false },
  }));
}

function checksPacket(ids = ["first", "second"]) {
  const text = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: ids.map((id) => ({ id, argv: ["node", "-e", "0"], timeoutMs: 1000 })) });
  return { path: ".tinysdd/tasks/checks.json", text, sha256: createHash("sha256").update(text).digest("hex") };
}

function normalizePiArgs(result) {
  const args = JSON.parse(result.modelClaims.text);
  return args.map((value, index) => {
    if (index > 0 && ["--session", "--append-system-prompt"].includes(args[index - 1])) return "<temporary-path>";
    if (value.startsWith("@/") && value.endsWith("/task-prompt.txt")) return "@<temporary-path>";
    return value;
  });
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
  process.env.TINYSDD_TMPDIR = canonicalTmpdir;
  const runtimeRoot = await makeRuntime();
  // Keep the directory alive for the suite; each project remains independent.
  process.env.TINYSDD_TEST_RUNTIME_ROOT = runtimeRoot;
});

after(async () => {
  const runtimeRoot = process.env.TINYSDD_TEST_RUNTIME_ROOT;
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  if (originalTestFlag === undefined) delete process.env.TINYSDD_WORKER_TEST;
  else process.env.TINYSDD_WORKER_TEST = originalTestFlag;
  if (originalTmpdirOverride === undefined) delete process.env.TINYSDD_TMPDIR;
  else process.env.TINYSDD_TMPDIR = originalTmpdirOverride;
  delete process.env.TINYSDD_TEST_RUNTIME_ROOT;
});

async function withWorkerEnvironment({ ambientTmpdir, override, platform }, callback) {
  const saved = { TMPDIR: process.env.TMPDIR, TINYSDD_TMPDIR: process.env.TINYSDD_TMPDIR };
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (ambientTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = ambientTmpdir;
  if (override === undefined) delete process.env.TINYSDD_TMPDIR;
  else process.env.TINYSDD_TMPDIR = override;
  if (platform !== undefined) Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

async function assertNoWorkerRun(project) {
  await assert.rejects(readdir(join(project, ".tinysdd", "runs")), { code: "ENOENT" });
}

describe("worker temporary root", () => {
  test("canonicalizes an ambient Linux TMPDIR final symlink", async () => {
    const project = await makeProject();
    const target = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-default-target-"));
    const link = `${target}-link`;
    await symlink(target, link);
    try {
      const before = await readFile(join(project, "src", "allowed.txt"), "utf8");
      await withWorkerEnvironment({ ambientTmpdir: link, override: undefined, platform: "linux" }, async () => {
        const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
        assert.equal(result.outcome, "completed");
      });
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), before);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(link, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("canonicalizes an ambient Linux TMPDIR parent alias", async () => {
    const project = await makeProject();
    const targetParent = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-default-parent-"));
    const target = join(targetParent, "scratch");
    await mkdir(target);
    const parentLink = `${targetParent}-link`;
    await symlink(targetParent, parentLink);
    try {
      const before = await readFile(join(project, "src", "allowed.txt"), "utf8");
      await withWorkerEnvironment({ ambientTmpdir: join(parentLink, "scratch"), override: undefined, platform: "linux" }, async () => {
        const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
        assert.equal(result.outcome, "completed");
      });
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), before);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(parentLink, { recursive: true, force: true });
      await rm(targetParent, { recursive: true, force: true });
    }
  });

  test("keeps explicit temp aliases and invalid roots strict before model execution", async () => {
    const project = await makeProject();
    const targetParent = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-explicit-parent-"));
    const target = join(targetParent, "scratch");
    await mkdir(target);
    const finalLink = `${target}-link`;
    const parentLink = `${targetParent}-link`;
    const file = `${target}-file`;
    await symlink(target, finalLink);
    await symlink(targetParent, parentLink);
    await writeFile(file, "not a directory\n");
    const missing = `${target}-missing`;
    const cases = [
      [finalLink, /must be a real directory, not a symlink/u],
      [join(parentLink, "scratch"), /resolves through a symlink/u],
      [missing, /temporary directory is unavailable/u],
      [file, /must be a real directory, not a symlink/u],
      ["", /must name an existing directory/u],
    ];
    try {
      const before = await readFile(join(project, "src", "allowed.txt"), "utf8");
      for (const [override, refusal] of cases) {
        await withWorkerEnvironment({ ambientTmpdir: canonicalTmpdir, override, platform: "linux" }, async () => {
          await assert.rejects(
            runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") }),
            refusal,
          );
        });
        await assertNoWorkerRun(project);
      }
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), before);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(finalLink, { recursive: true, force: true });
      await rm(parentLink, { recursive: true, force: true });
      await rm(file, { force: true });
      await rm(targetParent, { recursive: true, force: true });
    }
  });

  test("gives a valid explicit temp root precedence over an invalid ambient TMPDIR", async () => {
    const project = await makeProject();
    const explicit = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-explicit-valid-"));
    const ambientTarget = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-ambient-invalid-"));
    const ambientLink = `${ambientTarget}-link`;
    await symlink(ambientTarget, ambientLink);
    try {
      const before = await readFile(join(project, "src", "allowed.txt"), "utf8");
      await withWorkerEnvironment({ ambientTmpdir: ambientLink, override: explicit, platform: "linux" }, async () => {
        const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
        assert.equal(result.outcome, "completed");
      });
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), before);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(ambientLink, { recursive: true, force: true });
      await rm(ambientTarget, { recursive: true, force: true });
      await rm(explicit, { recursive: true, force: true });
    }
  });
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

  test("writes opt-in deterministic compaction settings and refuses an undersized reserve", async () => {
    const profile = { schemaVersion: 1, id: "compact", runtime: { compaction: { enabled: true } } };
    const prepared = await preparePiEnvironment({ worker: worker(), profile, sourceAgentDir, sourceEnv: { FAKE_BASE: "http://127.0.0.1:9/v1", FAKE_TOKEN: "synthetic-header-secret" } });
    try {
      const settings = JSON.parse(await readFile(join(prepared.stateDir, "settings.json"), "utf8"));
      assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 256 });
      assert.deepEqual(prepared.metadata.compaction, { enabled: true, reserveTokens: 256, profile: { enabled: true } });
    } finally {
      await prepared.cleanup();
    }
    await assert.rejects(
      preparePiEnvironment({ worker: worker(), profile: { ...profile, runtime: { compaction: { enabled: true, reserveTokens: 128 } } }, sourceAgentDir, sourceEnv: { FAKE_BASE: "http://127.0.0.1:9/v1", FAKE_TOKEN: "synthetic-header-secret" } }),
      /reserveTokens 128 must be at least effective maxTokens 256/u,
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
      assert.equal(Object.hasOwn(result, "candidateState"), false);
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

  test("persists the dispatch qualification decision in runtime and result artifacts", async () => {
    const project = await makeProject();
    try {
      const qualification = {
        recordDigest: "a".repeat(64),
        path: ".tinysdd/qualifications/" + "a".repeat(64) + ".json",
        status: "unqualified",
        mode: "warn",
        reason: "insufficient_evidence",
        changedFields: ["model.id"],
        warnings: ["qualification unqualified: insufficient_evidence"],
      };
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed"), qualification });
      const runtimeMetadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      const resultJson = JSON.parse(await readFile(result.artifactPaths.directory + "/result.json", "utf8"));
      assert.deepEqual(runtimeMetadata.qualification, qualification);
      assert.deepEqual(resultJson.qualification, qualification);
      assert.ok(resultJson.warnings.includes(qualification.warnings[0]));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains ordinary extra edits as candidates without applying them to source", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "outside") });
      assert.equal(result.outcome, "completed");
      assert.deepEqual(result.scopeViolations, []);
      assert.deepEqual(result.fileScope.extraPaths, ["outside.txt"]);
      assert.deepEqual(result.changedPaths.map(({ path, change }) => ({ path, change })), [{ path: "outside.txt", change: "created" }]);
      await assert.rejects(readFile(join(project, "outside.txt")));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains preparation creation as a boundary violation", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), preparation: [{ path: "outside.txt", exists: false }] },
        worker: worker(),
        runtime: runtime(undefined, "outside"),
      });
      assert.deepEqual(result.scopeViolations, [{ path: "outside.txt", change: "created", reason: "immutable preparation input" }]);
      assert.deepEqual(result.fileScope.actualPaths, ["outside.txt"]);
      await assert.rejects(readFile(join(project, "outside.txt")));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains selected task input edits as a boundary violation", async () => {
    const project = await makeProject();
    try {
      await mkdir(join(project, "docs"), { recursive: true });
      const briefText = "approved brief\n";
      await writeFile(join(project, "docs", "brief.md"), briefText);
      const result = await runWorker({
        projectRoot: project,
        packet: {
          ...packet(),
          briefText: undefined,
          brief: { path: "docs/brief.md", text: briefText, sha256: createHash("sha256").update(briefText).digest("hex") },
        },
        worker: worker(),
        runtime: runtime(undefined, "input"),
      });
      assert.deepEqual(result.scopeViolations, [{ path: "docs/brief.md", change: "modified", reason: "task packet input" }]);
      assert.deepEqual(result.fileScope.actualPaths, ["docs/brief.md"]);
      await assert.equal(await readFile(join(project, "docs", "brief.md"), "utf8"), briefText);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains an empty-directory replacement as a type violation", async () => {
    const project = await makeProject();
    await mkdir(join(project, "empty"));
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "type-change") });
      assert.deepEqual(result.changedPaths.map(({ path, change }) => ({ path, change })), [{ path: "empty", change: "type_changed" }]);
      assert.deepEqual(result.scopeViolations, [{ path: "empty", change: "type_changed", reason: "filesystem type changes are not authorized" }]);
      await assert.equal((await stat(join(project, "empty"))).isDirectory(), true);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("retains a dependency mount edit when the check runner is unavailable", async () => {
    const project = await makeProject();
    await mkdir(join(project, "vendor", "dependency"), { recursive: true });
    await writeFile(join(project, "vendor", "dependency", "package.json"), "{}\n");
    try {
      const checks = checksPacket(["unit"]);
      const manifest = JSON.parse(checks.text);
      manifest.dependencyMounts = ["vendor/dependency"];
      checks.text = JSON.stringify(manifest);
      checks.sha256 = createHash("sha256").update(checks.text).digest("hex");
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), checks },
        worker: worker(),
        runtime: runtime(undefined, "dependency"),
      });
      assert.equal(result.runChecks.available, false);
      assert.deepEqual(result.scopeViolations, [{ path: "vendor/dependency/extra.mjs", change: "created", reason: "dependency mount path" }]);
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
      await writeRetainedRun(project, baseRunId, {
        before: { "src/allowed.txt": "before\n" },
        after: { "src/allowed.txt": "base candidate\n" },
      });
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

  test("refuses a revision base without an exact task identity", async () => {
    const project = await makeProject();
    const baseRunId = "worker-2026-09-06T00-00-00-000Z-missingid1";
    try {
      await writeRetainedRun(project, baseRunId, {
        before: { "src/allowed.txt": "before\n" },
        after: { "src/allowed.txt": "foreign candidate\n" },
      });
      const resultPath = join(project, ".tinysdd", "runs", baseRunId, "result.json");
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      delete result.taskId;
      await writeFile(resultPath, JSON.stringify(result));
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(), worker: worker(), baseRunId, runtime: runtime(undefined, "complete") }),
        /base run lineage belongs to a different task/u,
      );
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
      await writeRetainedRun(project, ancestorId, {
        before: { "src/allowed.txt": "before\n" },
        after: { "src/allowed.txt": "ancestor edit\n" },
      });
      // A historical direct-parent snapshot may lack the ancestor's edit. The
      // resolver must reconstruct both files from the lineage, not trust it.
      await writeRetainedRun(project, parentId, {
        before: { "src/allowed.txt": "ancestor edit\n", "src/other.txt": "source other\n" },
        after: { "src/allowed.txt": "ancestor edit\n", "src/other.txt": "parent edit\n" },
        baseRun: { id: ancestorId, paths: ["src/allowed.txt"] },
      });
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
      assert.equal("matchedDigest" in metadata.compiledContext, false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  async function approvedContextPacket(project) {
    const text = JSON.stringify({
      schemaVersion: 1,
      facts: [],
      resources: [{ path: "src/allowed.txt", startLine: 1, endLine: 1, purpose: "Current behavior to preserve." }],
    });
    const context = { path: ".tinysdd/tasks/task.context.json", text, sha256: createHash("sha256").update(text).digest("hex") };
    return { context, compiled: await compileContext(project, context) };
  }

  test("accepts a compiled-context digest approved before source digests left the compiled text", async () => {
    const project = await makeProject();
    try {
      const { context, compiled } = await approvedContextPacket(project);
      assert.match(compiled.legacySha256, /^[a-f0-9]{64}$/u);
      assert.notEqual(compiled.legacySha256, compiled.sha256);
      for (const [matchedDigest, compiledSha256] of [["sha256", compiled.sha256], ["legacySha256", compiled.legacySha256]]) {
        const result = await runWorker({
          projectRoot: project,
          packet: { ...packet(), context: { ...context, compiledSha256 } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        });
        assert.equal(result.outcome, "completed");
        assert.equal(await readFile(result.artifactPaths.compiledContext, "utf8"), compiled.rendered);
        const metadata = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
        assert.equal(metadata.compiledContext.matchedDigest, matchedDigest);
        assert.equal(metadata.compiledContext.sha256, compiled.sha256);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects a compiled-context digest that is neither the current nor the legacy digest", async () => {
    const project = await makeProject();
    try {
      const { context, compiled } = await approvedContextPacket(project);
      await assert.rejects(
        runWorker({
          projectRoot: project,
          packet: { ...packet(), context: { ...context, compiledSha256: "0".repeat(64) } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        }),
        /selected source no longer matches the approved context digest/u,
      );
      // A cited line that changed after approval still fails both digests.
      await writeFile(join(project, "src", "allowed.txt"), "after\n");
      await assert.rejects(
        runWorker({
          projectRoot: project,
          packet: { ...packet(), context: { ...context, compiledSha256: compiled.legacySha256 } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        }),
        /selected source no longer matches the approved context digest/u,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects a checks packet whose sha256 does not match its text", async () => {
    const project = await makeProject();
    try {
      await assert.rejects(
        runWorker({
          projectRoot: await realpath(project),
          packet: { ...packet(), checks: { path: ".tinysdd/tasks/checks.json", text: "declared checks\n", sha256: "0".repeat(64) } },
          worker: worker(),
          runtime: runtime(undefined, "complete"),
        }),
        /checks digest does not match/u,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("keeps a valid checks declaration in packet.json", async () => {
    const project = await makeProject();
    try {
      const text = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: "declared", argv: ["node", "-e", "0"], timeoutMs: 1000 }] });
      const digest = createHash("sha256").update(text).digest("hex");
      const result = await runWorker({
        projectRoot: await realpath(project),
        packet: { ...packet(), checks: { path: ".tinysdd/tasks/checks.json", text, sha256: digest } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      const saved = JSON.parse(await readFile(result.artifactPaths.packet, "utf8"));
      assert.deepEqual(saved.checks, { path: ".tinysdd/tasks/checks.json", text, sha256: digest });
      assert.deepEqual(saved.runtimeScope, { mode: "ordinary-create-modify", ordinaryCreateModify: true, deletions: false });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("records an unavailable declared runner without exposing a check tool", async () => {
    const project = await makeProject();
    try {
      const text = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: "declared", argv: ["node", "-e", "0"], timeoutMs: 1000 }] });
      const digest = createHash("sha256").update(text).digest("hex");
      const result = await runWorker({
        projectRoot: await realpath(project),
        packet: { ...packet(), checks: { path: ".tinysdd/tasks/checks.json", text, sha256: digest } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      const runtimeMetadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.deepEqual(runtimeMetadata.runtimeScope, { mode: "ordinary-create-modify", ordinaryCreateModify: true, deletions: false });
      assert.equal(runtimeMetadata.runChecks.declared, true);
      assert.equal(runtimeMetadata.runChecks.available, false);
      assert.equal(runtimeMetadata.capabilities.tools.includes("run_checks"), false);
      assert.equal(runtimeMetadata.capabilities.extensions, false);
      assert.equal(runtimeMetadata.limits.maxCheckRuns, 12);
      assert.match(result.warnings.find((warning) => warning.startsWith("run_checks unavailable: ")), /requires Linux|test runtime did not provide/u);
      assert.equal(result.artifactPaths.checks, undefined);
      assert.equal(result.runChecks.available, false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("guides the available check loop while retaining no-tool prompt and argument bytes", async () => {
    const project = await makeProject();
    try {
      const { context } = await approvedContextPacket(project);
      const checks = checksPacket(["first"]);
      const noTool = await runWorker({
        projectRoot: project,
        packet: { ...packet(), context },
        worker: worker(),
        runtime: runtime(undefined, "args"),
      });
      const unavailable = await runWorker({
        projectRoot: project,
        packet: { ...packet(), context, checks },
        worker: worker(),
        runtime: runtime(undefined, "args"),
      });
      const available = await runWorker({
        projectRoot: project,
        packet: { ...packet(), context, checks },
        worker: worker(),
        runtime: {
          ...runtime(undefined, "args"),
          checkRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: "ok\n", tail: "ok\n", totalBytes: 3, truncated: false } }),
        },
      });
      const noToolPrompt = await readFile(noTool.artifactPaths.prompt, "utf8");
      const unavailablePrompt = await readFile(unavailable.artifactPaths.prompt, "utf8");
      const availablePrompt = await readFile(available.artifactPaths.prompt, "utf8");
      assert.equal(noToolPrompt, unavailablePrompt);
      assert.match(noToolPrompt, /report checks as unrun unless the packet itself supplies observed evidence/u);
      assert.match(noToolPrompt, /Start by planning the allowed-file edit/u);
      assert.match(availablePrompt, /named `run_checks` host tool/u);
      assert.match(availablePrompt, /After each written or edited allowed file, call `run_checks`/u);
      assert.match(availablePrompt, /fix reported failures within the approved scope/u);
      assert.match(availablePrompt, /do not simulate checks in reasoning/u);
      assert.match(availablePrompt, /declared check budget is exhausted/u);
      assert.match(availablePrompt, /missing information or permission/u);
      assert.match(availablePrompt, /worker-observed host-check evidence, never operator verification or acceptance/u);
      assert.match(availablePrompt, /final handoff, name observed checks separately from checks still unrun/u);
      assert.doesNotMatch(availablePrompt, /report checks as unrun unless the packet itself supplies observed evidence/u);
      assert.doesNotMatch(availablePrompt, /Start by planning the allowed-file edit/u);

      const noToolArgs = normalizePiArgs(noTool);
      const unavailableArgs = normalizePiArgs(unavailable);
      assert.deepEqual(noToolArgs, unavailableArgs);
      assert.equal(noToolArgs[noToolArgs.indexOf("--tools") + 1], "read,write,edit");
      assert.equal(available.modelClaims.unverified, true);
      assert.equal(available.workerObservedChecks.acceptanceEvidence, false);
      const availableArgs = normalizePiArgs(available);
      assert.equal(availableArgs[availableArgs.indexOf("--tools") + 1], "read,write,edit,run_checks");
      assert.equal(availableArgs.includes("bash"), false);
      assert.equal(availableArgs.includes("sh"), false);
      assert.equal(availableArgs.includes("shell"), false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("uses live dependency mounts and compares their identity on a replay", async () => {
    const project = await makeProject();
    try {
      await mkdir(join(project, "node_modules"), { recursive: true });
      await writeFile(join(project, "node_modules", "package.json"), '{"name":"fixture"}\n');
      const checksText = JSON.stringify({ schemaVersion: 1, dependencyMounts: ["node_modules"], checks: [{ id: "unit", argv: ["node", "-e", "0"], timeoutMs: 1000 }] });
      const checks = { path: ".tinysdd/tasks/checks.json", text: checksText, sha256: createHash("sha256").update(checksText).digest("hex") };
      const checkRuntime = { ...runtime(undefined, "complete"), checkRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: "ok", tail: "ok", totalBytes: 2, truncated: false } }) };
      const first = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: checkRuntime });
      const firstRuntime = JSON.parse(await readFile(first.artifactPaths.runtime, "utf8"));
      assert.equal(firstRuntime.runChecks.available, true);
      assert.equal(firstRuntime.runChecks.maxCheckRuns, 12);
      assert.equal(firstRuntime.runChecks.dependencyIdentity.provenance, "live-source-root");
      assert.equal(firstRuntime.capabilities.tools.includes("run_checks"), true);
      const replay = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: checkRuntime, baselineRunId: first.runId });
      const replayRuntime = JSON.parse(await readFile(replay.artifactPaths.runtime, "utf8"));
      assert.equal(replayRuntime.runChecks.baselineComparison.status, "identical");
      assert.equal(replay.runChecks.baselineComparison.status, "identical");
      await rm(first.artifactPaths.runtime);
      const oldReplay = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: checkRuntime, baselineRunId: first.runId });
      assert.equal(oldReplay.runChecks.baselineComparison.status, "unknown");
      const parent = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: { ...checkRuntime, testEnv: { TINYSDD_TEST_ACTION: "allowed" } } });
      await writeFile(join(project, "node_modules", "package.json"), '{"name":"changed"}\n');
      const revision = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: checkRuntime, baseRunId: parent.runId });
      assert.equal(revision.runChecks.baselineComparison.status, "different");
      await rm(parent.artifactPaths.runtime);
      const oldRevision = await runWorker({ projectRoot: await realpath(project), packet: { ...packet(), checks }, worker: worker(), runtime: checkRuntime, baseRunId: parent.runId });
      assert.equal(oldRevision.runChecks.baselineComparison.status, "unknown");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("runs individual and all checks through the Pi channel and retains budget errors", async () => {
    const project = await makeProject();
    const calls = [];
    try {
      const checks = checksPacket();
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), checks },
        worker: worker({ maxCheckRuns: 2 }),
        runtime: {
          ...runtime(undefined, "checks"),
          checkRunner: async ({ check }) => {
            calls.push(check.id);
            return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: `passed ${check.id}\n`, tail: `passed ${check.id}\n`, totalBytes: 14, truncated: false } };
          },
        },
      });
      assert.equal(result.outcome, "completed");
      assert.deepEqual(calls, ["first", "first"]);
      assert.equal(result.runChecks.maxCheckRuns, 2);
      assert.equal(result.workerObservedChecks.runs.length, 3);
      assert.equal(result.workerObservedChecks.runs.at(-1).error.code, "CHECK_BUDGET_EXHAUSTED");
      assert.equal(result.workerObservedChecks.runs.at(-1).checkId, "second");
      const log = (await readFile(result.artifactPaths.checks, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(log.length, 3);
      assert.equal(log.at(-1).error.code, "CHECK_BUDGET_EXHAUSTED");
      assert.ok(result.artifactPaths.checks);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("counts a run_checks call toward the worker tool limit", async () => {
    const project = await makeProject();
    try {
      const checks = checksPacket(["first"]);
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), checks },
        worker: worker({ maxToolCalls: 1, timeoutMs: 5_000 }),
        runtime: {
          ...runtime(undefined, "checks"),
          checkRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: "ok\n", tail: "ok\n", totalBytes: 3, truncated: false } }),
        },
      });
      assert.equal(result.outcome, "tool_limit");
      assert.equal(result.limitDetails.maxToolCalls, 1);
      assert.ok(result.observed.toolCallsByName.run_checks >= 1);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("does not treat check-only activity as a first write", async () => {
    const project = await makeProject();
    try {
      const checks = checksPacket(["first"]);
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), checks },
        worker: worker({ timeoutMs: 5_000, firstWriteMs: 400 }),
        runtime: {
          ...runtime(undefined, "check-watchdog"),
          checkRunner: async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text: "ok\n", tail: "ok\n", totalBytes: 3, truncated: false } }),
        },
      });
      assert.equal(result.outcome, "no_progress");
      assert.equal(result.observed.writeCalls, 0);
      assert.equal(result.observed.firstWriteAtMs, null);
      assert.equal(result.observed.toolCallsByName.run_checks, 1);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("cancels an in-flight check on timeout, abort, and Pi exit", async () => {
    for (const mode of ["timeout", "abort", "exit"]) {
      const project = await makeProject();
      let runnerStarted;
      let markStarted;
      let runnerCancelled = false;
      runnerStarted = new Promise((resolve) => { markStarted = resolve; });
      const checkRunner = async ({ signal }) => {
        markStarted();
        await new Promise((resolve, reject) => {
          const cancel = () => {
            runnerCancelled = true;
            reject(Object.assign(new Error("check cancelled"), { code: "CHECK_CANCELLED" }));
          };
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
        });
      };
      try {
        const controller = new AbortController();
        const action = mode === "exit" ? "check-exit" : "check-hang";
        const promise = runWorker({
          projectRoot: project,
          packet: { ...packet(), checks: checksPacket(["first"]) },
          worker: worker({ timeoutMs: mode === "timeout" ? 1_500 : 5_000 }),
          runtime: { ...runtime(undefined, action), checkRunner },
          ...(mode === "abort" ? { signal: controller.signal } : {}),
        });
        await runnerStarted;
        if (mode === "abort") controller.abort();
        const result = await promise;
        assert.equal(runnerCancelled, true, mode);
        assert.equal(result.outcome, mode === "timeout" ? "timeout" : mode === "abort" ? "stopped" : "failed");
      } finally {
        await rm(project, { recursive: true, force: true });
      }
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

  test("reports allowed paths touched by a timed-out candidate", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ timeoutMs: 500 }), runtime: runtime(undefined, "write-then-hang") });
      assert.equal(result.outcome, "timeout");
      assert.deepEqual(result.candidateState, { allowedPaths: 1, allowedPathsTouched: 1, untouchedPaths: [] });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("reports untouched allowed paths when a timed-out candidate has no writes", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ timeoutMs: 500 }), runtime: runtime(undefined, "think") });
      assert.equal(result.outcome, "timeout");
      assert.deepEqual(result.candidateState, { allowedPaths: 1, allowedPathsTouched: 0, untouchedPaths: ["src/allowed.txt"] });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("finalizes a run stopped by an abort signal as stopped, keeping its evidence", async () => {
    const project = await makeProject();
    try {
      const controller = new AbortController();
      const aborter = abortWhenReading(project, controller);
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker({ timeoutMs: 10_000 }), runtime: runtime(undefined, "think"), signal: controller.signal });
      await aborter;
      assert.equal(result.outcome, "stopped");
      assert.equal(result.observed.processTermination.stopRequested, true);
      assert.equal(result.observed.processTermination.stoppedBeforeSpawn, undefined);
      assert.ok(result.observed.processTermination.elapsedMs < 3_000);
      assert.ok(result.limitDetails.toolCalls >= 1);
      assert.equal(result.limitDetails.elapsedMs, result.observed.processTermination.elapsedMs);
      assert.equal(JSON.parse(await readFile(join(result.artifactPaths.directory, "result.json"), "utf8")).outcome, "stopped");
      assert.ok((await stat(result.artifactPaths.patch)).isFile());
      assert.ok((await stat(result.artifactPaths.workspaceAfter)).isDirectory());
      assert.deepEqual(result.scopeViolations, []);
      assert.match(await readFile(result.artifactPaths.stdout, "utf8"), /tool_execution_start/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("does not spawn Pi when already stopped, but still finalizes", async () => {
    const project = await makeProject();
    try {
      const controller = new AbortController();
      controller.abort();
      // The "allowed" action would edit src/allowed.txt if Pi ran.
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed"), signal: controller.signal });
      assert.equal(result.outcome, "stopped");
      assert.equal(result.observed.processTermination.stoppedBeforeSpawn, true);
      assert.equal(result.observed.processTermination.stopRequested, true);
      assert.equal(result.observed.processTermination.exitCode, null);
      assert.equal(await readFile(result.artifactPaths.stdout, "utf8"), "");
      assert.equal(await readFile(result.artifactPaths.stderr, "utf8"), "");
      assert.deepEqual(result.changedPaths, []);
      assert.ok((await stat(result.artifactPaths.workspaceAfter)).isDirectory());
      assert.equal(JSON.parse(await readFile(join(result.artifactPaths.directory, "result.json"), "utf8")).outcome, "stopped");
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
      assert.deepEqual(result.taskShape, { allowedFiles: 1, contextFacts: 0, compiledContextBytes: result.taskShape.compiledContextBytes, citedResources: 1, citedLines: 1, citedTestLines: 0, citedFakeTimers: 0, citedDeferredPromises: 0, citedConcurrencyMarkers: 0, citedOrderingAssertions: 0 });
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

  test("loads deterministic compaction from an opt-in profile and records trusted anchor and details digests", async () => {
    const project = await makeProject();
    try {
      const profile = { schemaVersion: 1, id: "deterministic-compaction", runtime: { compaction: { enabled: true } } };
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), profile, runtime: runtime(undefined, "deterministic-compaction") });
      assert.equal(result.outcome, "completed");
      const metadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.deepEqual(metadata.capabilities.extensions, ["compaction-extension.mjs"]);
      assert.equal(metadata.session.available, true);
      assert.equal(metadata.session.sha256, result.observed.session.sha256);
      assert.deepEqual(metadata.compaction, {
        enabled: true,
        mode: "deterministic",
        reserveTokens: 256,
        keepRecentTokens: null,
        extensionVersion: 1,
        anchorId: "task-worker-test",
        anchorSha256: metadata.compaction.anchorSha256,
        anchorBytes: metadata.compaction.anchorBytes,
      });
      assert.ok(metadata.compaction.anchorBytes > 0);
      const anchorArtifact = JSON.parse(await readFile(join(result.artifactPaths.compaction, "anchor.json"), "utf8"));
      assert.equal((await stat(join(result.artifactPaths.compaction, "anchor.json"))).mode & 0o777, 0o400);
      const prompt = await readFile(result.artifactPaths.prompt, "utf8");
      assert.equal(prompt.endsWith(anchorArtifact.anchor.text), true);
      assert.equal(result.observed.compactions.length, 2);
      assert.equal(result.observed.compactions[0].deterministic, true);
      assert.equal(result.observed.compactions[0].fromHook, true);
      assert.match(result.observed.compactions[0].detailsSha256, /^[a-f0-9]{64}$/u);
      assert.equal(result.observed.compactions[1].aborted, true);
      assert.equal(result.observed.compactions[1].details, null);
      assert.equal(result.observed.session.available, true);
      assert.ok(result.observed.session.bytes > 0);
      assert.match(result.observed.session.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(result.artifactPaths.session.endsWith("/session.jsonl"), true);
      const retainedEntries = (await readFile(result.artifactPaths.session, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const refusalAudit = retainedEntries.find((entry) => entry.type === "custom" && entry.data?.code === "COMPACTION_EMPTY");
      assert.ok(refusalAudit);
      assert.equal(refusalAudit.customType, "tinysdd.compaction-audit");
      assert.equal(retainedEntries.some((entry) => entry.type === "custom_message"), false);
      const rebuilt = buildSessionContext(retainedEntries);
      const summaryMessage = rebuilt.messages.find((message) => message.role === "compactionSummary");
      assert.ok(summaryMessage);
      assert.equal(Buffer.from(summaryMessage.summary, "utf8").includes(Buffer.from(anchorArtifact.anchor.text, "utf8")), true);
      assert.equal(rebuilt.messages.some((message) => message.role === "assistant" && message.content?.[0]?.text === "after retained compaction"), true);
      assert.equal(result.warnings.some((warning) => /model-written summary/u.test(warning)), false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("records cited test characteristics in result taskShape only", async () => {
    const project = await makeProject();
    try {
      await mkdir(join(project, "tests"));
      await writeFile(join(project, "tests", "timers.test.mjs"), "t.mock.timers.enable({ apis: ['setTimeout'] });\nPromise.withResolvers();\nPromise.race([]);\nassert.deepEqual(events, []);\n");
      const contextText = JSON.stringify({ schemaVersion: 1, facts: [], resources: [{ path: "tests/timers.test.mjs", startLine: 1, endLine: 4, purpose: "Async edge tests." }] });
      const result = await runWorker({
        projectRoot: project,
        packet: { ...packet(), context: { path: ".tinysdd/tasks/task.context.json", text: contextText, sha256: createHash("sha256").update(contextText).digest("hex") } },
        worker: worker(),
        runtime: runtime(undefined, "complete"),
      });
      assert.equal(result.outcome, "completed");
      const stored = JSON.parse(await readFile(join(result.artifactPaths.directory, "result.json"), "utf8"));
      for (const shape of [result.taskShape, stored.taskShape]) {
        assert.equal(shape.citedFakeTimers, 1);
        assert.equal(shape.citedDeferredPromises, 1);
        assert.equal(shape.citedConcurrencyMarkers, 1);
        assert.equal(shape.citedOrderingAssertions, 1);
      }
      const context = JSON.parse(await readFile(result.artifactPaths.context, "utf8"));
      assert.equal(Object.hasOwn(context.compiledContext, "testCharacteristics"), false);
      assert.equal(Object.hasOwn(context.compiledContext.resources[0], "testCharacteristics"), false);
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
    const outside = await mkdtemp(join(canonicalTmpdir, "tinysdd-worker-test-outside-"));
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

  test("skips tracked and unignored .tinysdd state in the git copy instead of failing", async () => {
    const project = await makeGitProject();
    try {
      // talon: .tinysdd/ has no ignore rule; init only ignores runs/ and launches/.
      await mkdir(join(project, ".tinysdd", "tasks"), { recursive: true });
      await writeFile(join(project, ".tinysdd", "config.json"), "{\"schemaVersion\":1,\"workers\":{}}\n");
      await writeFile(join(project, ".tinysdd", "tasks", "slice.md"), "# Slice\n");
      await git(project, "add", ".tinysdd/config.json");
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(undefined, "allowed") });
      assert.equal(result.outcome, "completed");
      assert.equal(result.workspaceCopy.mode, "git-ls-files");
      assert.deepEqual(await listTree(result.artifactPaths.workspaceBefore), [".gitignore", "TASK.md", "src/allowed.txt", "src/untracked.ts"]);
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
    const outer = await mkdtemp(join(canonicalTmpdir, "tinysdd-copy-outer-"));
    const destination = await mkdtemp(join(canonicalTmpdir, "tinysdd-copy-test-"));
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
      const path = await mkdtemp(join(canonicalTmpdir, "tinysdd-copy-test-"));
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

  test("captures sandbox output through host-owned pipes without granting artifact writes", async () => {
    const project = await makeProject();
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: { ...runtime(undefined, "allowed"), pipeOutput: true } });
      assert.equal(result.outcome, "completed");
      assert.equal(await readFile(join(result.artifactPaths.workspaceAfter, "src", "allowed.txt"), "utf8"), "after\n");
      assert.match(await readFile(result.artifactPaths.stdout, "utf8"), /message_end/u);
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), "before\n");
      const metadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(metadata.sandbox, "test-runtime");
      assert.equal(metadata.bubblewrap, null);
      assert.equal(metadata.sandboxExec, undefined);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("fails closed when the platform sandbox executable is unavailable", async () => {
    const project = await makeProject();
    const refusal = process.platform === "darwin" ? /macOS sandbox-exec.*unavailable/u : process.platform === "linux" ? /bubblewrap.*unavailable|unavailable.*bubblewrap/u : /require Linux bubblewrap or macOS sandbox-exec/u;
    try {
      await assert.rejects(
        runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: { test: false, bwrapExecutable: "/definitely/missing/bwrap", sandboxExecExecutable: "/definitely/missing/sandbox-exec", piExecutable: fakePi } }),
        refusal,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});


test("protected edits retain the candidate and report the contract violation", async () => {
  const project = await makeProject();
  try {
    await writeFile(join(project, "src", "contract.txt"), "original\n");
    const result = await runWorker({ projectRoot: project, packet: { ...packet(), protectedPaths: ["src/contract.txt"] }, worker: worker(), runtime: runtime(undefined, "protected") });
    assert.deepEqual(result.scopeViolations, [{ path: "src/contract.txt", change: "modified", reason: "protected contract file" }]);
    assert.equal(await readFile(join(project, "src", "contract.txt"), "utf8"), "original\n");
    assert.equal(await readFile(join(result.artifactPaths.candidate, "src", "contract.txt"), "utf8"), "changed\n");
    const prompt = await readFile(result.artifactPaths.prompt, "utf8");
    assert.match(prompt, /Protected contract files \(read-only\)/u);
    assert.match(prompt, /never write, edit, create, delete or rename/u);
    const retained = JSON.parse(await readFile(result.artifactPaths.packet, "utf8"));
    assert.deepEqual(retained.protectedPaths, ["src/contract.txt"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("unprotected packets keep the prompt unchanged and normalize to an empty protected list", async () => {
  const project = await makeProject();
  try {
    const results = [];
    for (const selectedPacket of [packet(), { ...packet(), protectedPaths: [] }]) {
      const result = await runWorker({ projectRoot: project, packet: selectedPacket, worker: worker(), runtime: runtime(undefined, "complete") });
      results.push(await readFile(result.artifactPaths.prompt, "utf8"));
      const retained = JSON.parse(await readFile(result.artifactPaths.packet, "utf8"));
      assert.deepEqual(retained.protectedPaths, []);
    }
    assert.equal(results[0], results[1]);
    assert.doesNotMatch(results[0], /Protected contract files/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("worker rejects overlapping, duplicate and invalid protected paths", async () => {
  const project = await makeProject();
  try {
    for (const [protectedPaths, message] of [
      [["src/allowed.txt"], /must not overlap/u],
      [["src/contract.txt", "src/contract.txt"], /must not contain duplicates/u],
      [[".tinysdd/contract.txt"], /protected path/u],
      [[null], /array of strings/u],
      ["src/contract.txt", /array of strings/u],
    ]) {
      await assert.rejects(runWorker({ projectRoot: project, packet: { ...packet(), protectedPaths }, worker: worker(), runtime: runtime(undefined, "complete") }), message);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("worker refuses protected inputs missing from its copy", async () => {
  const project = await makeGitProject();
  try {
    for (const path of ["debug.log", "src/missing.txt"]) {
      await assert.rejects(runWorker({ projectRoot: project, packet: { ...packet(), protectedPaths: [path] }, worker: worker(), runtime: runtime(undefined, "complete") }), /Protected path is not part of the worker copy/u);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
