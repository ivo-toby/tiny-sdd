import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigDocument } from "../src/config.mjs";
import {
  OPENCODE_ENV_NAMES,
  OPENCODE_PERMISSIONS,
  OPENCODE_VERSION,
  buildOpenCodeConfig,
  openCodeArguments,
} from "../src/opencode-environment.mjs";
import { buildMacosSandboxProfile } from "../src/macos-sandbox.mjs";
import { openCodeBubblewrapInvocation, openCodeRunner, openCodeSeatbeltInvocation, parseEvents } from "../src/runners/opencode.mjs";
import { buildBubblewrapArgs, runWorker } from "../src/worker.mjs";

// The OpenCode worker runs through the test runtime only: a fake executable that
// prints `--format json` events from the recorded fixture. No binary, network or model.
const canonicalTmpdir = await realpath(tmpdir());
const fixturePath = fileURLToPath(new URL("./fixtures/opencode/run-events.jsonl", import.meta.url));
const originalTestFlag = process.env.TINYSDD_WORKER_TEST;
const originalTmpdir = process.env.TINYSDD_TMPDIR;
let fixtureRoot;
let fakeOpenCode;
let fakeOldOpenCode;
let providerFile;
const CONFIG_KEYS = ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_TEST_HOME"];

function fakeScript(version, { emit } = { emit: true }) {
  // The version check runs with a minimal PATH, so the interpreter is named absolutely.
  return `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const VERSION = ${JSON.stringify(version)};
if (process.argv[2] === "--version") {
  process.stdout.write("opencode v" + VERSION + "\\n");
  process.exit(0);
}
if (${emit ? "true" : "false"} && process.env.TINYSDD_TEST_RECORD) {
  writeFileSync(process.env.TINYSDD_TEST_RECORD, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
}
if (process.env.TINYSDD_TEST_ACTION === "allowed") writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
process.stdout.write(readFileSync(process.env.TINYSDD_TEST_EVENTS, "utf8"));
`;
}

before(async () => {
  process.env.TINYSDD_WORKER_TEST = "1";
  process.env.TINYSDD_TMPDIR = canonicalTmpdir;
  fixtureRoot = await mkdtemp(join(canonicalTmpdir, "tinysdd-opencode-test-"));
  fakeOpenCode = join(fixtureRoot, "fake-opencode.mjs");
  fakeOldOpenCode = join(fixtureRoot, "fake-opencode-old.mjs");
  await writeFile(fakeOpenCode, fakeScript(OPENCODE_VERSION));
  await writeFile(fakeOldOpenCode, fakeScript("2.0.0", { emit: false }));
  await chmod(fakeOpenCode, 0o755);
  await chmod(fakeOldOpenCode, 0o755);
  providerFile = join(fixtureRoot, "opencode.json");
  await writeFile(providerFile, `${JSON.stringify({
    provider: {
      oc: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "{env:OPENCODE_TEST_KEY}" },
        models: { "exact-model": { limit: { context: 4096, output: 256 } } },
      },
    },
  }, null, 2)}\n`);
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (originalTestFlag === undefined) delete process.env.TINYSDD_WORKER_TEST;
  else process.env.TINYSDD_WORKER_TEST = originalTestFlag;
  if (originalTmpdir === undefined) delete process.env.TINYSDD_TMPDIR;
  else process.env.TINYSDD_TMPDIR = originalTmpdir;
});

function worker(overrides = {}) {
  return { type: "opencode", provider: "oc", model: "exact-model", opencodeConfig: providerFile, limits: { timeoutMs: 5_000, maxToolCalls: 8 }, ...overrides };
}

function packet(allowedPaths = ["src/allowed.txt"], extra = {}) {
  return { schemaVersion: 1, taskId: "task-opencode-test", briefText: "Implement the exact bounded change. Do not broaden scope.", allowedPaths, ...extra };
}

async function makeProject() {
  const root = await mkdtemp(join(canonicalTmpdir, "tinysdd-opencode-project-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "TASK.md"), "Implement the bounded test change.\n");
  await writeFile(join(root, "src", "allowed.txt"), "before\n");
  return root;
}

function runtime(record, { action = "allowed", executable = fakeOpenCode, sourceEnv = { OPENCODE_TEST_KEY: "synthetic-key-value" } } = {}) {
  return {
    test: true,
    opencodeExecutable: executable,
    sourceEnv,
    testEnv: { TINYSDD_TEST_ACTION: action, TINYSDD_TEST_RECORD: record, TINYSDD_TEST_EVENTS: fixturePath },
  };
}

// Last matching rule wins; no match asks. Only `*` and exact action names occur in the ruleset.
function effectFor(action, rules) {
  return rules.findLast((rule) => rule.action === "*" || rule.action === action)?.effect ?? "ask";
}

describe("OpenCode worker configuration", () => {
  test("requires an absolute opencodeConfig for type opencode and refuses it for pi", () => {
    const document = (entry) => ({ schemaVersion: 1, workers: { w: entry } });
    const base = { provider: "oc", model: "exact-model", limits: { timeoutMs: 5000, maxToolCalls: 8 } };
    assert.throws(() => validateConfigDocument(document({ type: "opencode", ...base })), (error) => error.code === "CONFIG_INVALID" && /opencodeConfig must be an absolute path/u.test(error.message));
    assert.throws(() => validateConfigDocument(document({ type: "opencode", ...base, opencodeConfig: "opencode.json" })), /opencodeConfig must be an absolute path/u);
    const valid = validateConfigDocument(document({ type: "opencode", ...base, opencodeConfig: providerFile }));
    assert.equal(valid.workers.w.opencodeConfig, providerFile);
    assert.throws(() => validateConfigDocument(document({ type: "pi", provider: "oc", model: "m", opencodeConfig: providerFile })), /only valid for type "opencode"/u);
  });

  test("builds the provider from the operator file, with the key and the relay token kept apart", async () => {
    const prepared = await openCodeRunner.prepareEnvironment({ worker: worker(), sourceEnv: { OPENCODE_TEST_KEY: "synthetic-key-value" } });
    try {
      assert.equal(prepared.env.TINYSDD_PI_SECRET_0, "synthetic-key-value");
      const content = openCodeRunner.inferenceEnvironment({ prepared, worker: worker(), baseUrl: "http://127.0.0.1:41434", token: "relay-token-1" });
      const text = content.OPENCODE_CONFIG_CONTENT;
      assert.equal(text.includes("synthetic-key-value"), false, "the provider key must stay on the host");
      const config = JSON.parse(text);
      assert.equal(config.providers.oc.package, "@ai-sdk/openai-compatible");
      assert.equal(config.providers.oc.settings.baseURL, "http://127.0.0.1:41434");
      assert.equal(config.providers.oc.settings.apiKey, "relay-token-1");
      assert.deepEqual(config.providers.oc.models["exact-model"].limit, { context: 4096, output: 256 });
      assert.equal(config.compaction.auto, false);
    } finally {
      await prepared.cleanup();
    }
  });

  test("refuses providers that are not openai-completions style and compaction profiles before launch", async () => {
    const other = join(fixtureRoot, "other.json");
    await writeFile(other, JSON.stringify({ provider: { oc: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://example.invalid/v1" }, models: { "exact-model": {} } } } }));
    await assert.rejects(openCodeRunner.prepareEnvironment({ worker: worker({ opencodeConfig: other }) }), /only @ai-sdk\/openai-compatible/u);
    const literal = join(fixtureRoot, "literal.json");
    await writeFile(literal, JSON.stringify({ provider: { oc: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-literal" }, models: { "exact-model": {} } } } }));
    await assert.rejects(openCodeRunner.prepareEnvironment({ worker: worker({ opencodeConfig: literal }) }), /must be an \{env:NAME\} reference/u);
    const compaction = { schemaVersion: 1, id: "compact", runtime: { compaction: { enabled: true } } };
    await assert.rejects(openCodeRunner.prepareEnvironment({ worker: worker(), profile: compaction, sourceEnv: { OPENCODE_TEST_KEY: "x" } }), /no deterministic compaction/u);
  });
});

describe("OpenCode isolation", () => {
  test("the sandbox environment has exactly the worker's OpenCode names, under run state, with no host values", async () => {
    const saved = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));
    process.env.OPENCODE_CONFIG_DIR = "/host/evil-config";
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "0";
    process.env.OPENCODE_TEST_HOME = "/host/evil-home";
    process.env.OPENCODE_CONFIG_CONTENT = '{"plugin":["evil"]}';
    const prepared = await openCodeRunner.prepareEnvironment({ worker: worker(), sourceEnv: { OPENCODE_TEST_KEY: "synthetic-key-value" } });
    try {
      const invocation = await openCodeRunner.buildInvocation({
        sandbox: "bubblewrap",
        prepared,
        worker: worker(),
        prompt: { rendered: "system\n\n## User task\npacket" },
        executable: { path: fakeOpenCode, resolved: fakeOpenCode },
      });
      const env = invocation.env;
      const names = Object.keys(env).filter((name) => name.startsWith("OPENCODE_")).sort();
      assert.deepEqual(names, OPENCODE_ENV_NAMES.filter((name) => name !== "OPENCODE_CONFIG_CONTENT").sort());
      assert.equal(Object.values(env).some((value) => String(value).includes("/host/")), false);
      assert.equal(env.HOME, "/opencode-state/home");
      assert.equal(env.XDG_CONFIG_HOME, "/opencode-state/xdg/config");
      assert.equal(env.XDG_DATA_HOME, "/opencode-state/xdg/data");
      assert.equal(env.OPENCODE_CONFIG_DIR, "/opencode-state/config-dir");
      assert.equal(env.OPENCODE_DB, ":memory:");
      assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
      assert.equal(env.TMPDIR, "/opencode-state/tmp");
      assert.equal(JSON.stringify(env).includes("synthetic-key-value"), false, "provider credentials stay out of the sandbox");
      // The launcher is the Node root's relay forwarder; the OpenCode binary is the argv after it.
      assert.deepEqual(invocation.argv.slice(0, 1), ["/opt/opencode/bin/opencode"]);
      assert.equal(invocation.argv.includes("--auto") || invocation.argv.includes("--dangerously-skip-permissions"), false);
    } finally {
      await prepared.cleanup();
      for (const key of CONFIG_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  test("bubblewrap mounts the binary read-only and the state writable, and never mounts /etc/opencode", () => {
    const invocation = openCodeBubblewrapInvocation({
      nodeRoot: "/usr",
      binaryPath: "/home/worker/.opencode/bin/opencode",
      stateDir: "/tmp/tinysdd-opencode-state-x",
      args: ["run", "--format", "json"],
      env: { HOME: "/opencode-state/home" },
    });
    const args = buildBubblewrapArgs({
      workspace: "/tmp/tinysdd-workspace-x",
      invocation,
      checkChannel: undefined,
      compactionBundle: undefined,
      inference: { forwarder: "/tmp/forwarder.mjs", socketDir: "/tmp/socket", socketName: "relay.sock" },
    });
    const binaryAt = args.indexOf("/home/worker/.opencode/bin/opencode");
    assert.equal(args[binaryAt - 1], "--ro-bind");
    assert.equal(args[binaryAt + 1], "/opt/opencode/bin/opencode");
    const stateAt = args.indexOf("/tmp/tinysdd-opencode-state-x");
    assert.equal(args[stateAt - 1], "--bind");
    assert.equal(args[stateAt + 1], "/opencode-state");
    assert.equal(args.some((value) => value === "/etc/opencode" || value.startsWith("/etc/opencode/")), false);
  });

  test("Seatbelt denies the macOS managed configuration locations", () => {
    const profile = buildMacosSandboxProfile({
      workspace: "/private/tmp/tinysdd-workspace-x",
      sourceRoot: "/private/tmp/tinysdd-source-x",
      compactionBundle: undefined,
      inferencePort: 41434,
      invocation: openCodeSeatbeltInvocation({ stateDir: "/private/tmp/tinysdd-opencode-state-x", binaryPath: "/Users/worker/.opencode/bin/opencode" }),
    });
    assert.match(profile, /\(deny file-read\* file-write\* .*\(subpath "\/Library\/Application Support\/opencode"\) \(subpath "\/Library\/Managed Preferences"\)\)/u);
  });
});

describe("OpenCode runtime identity and arguments", () => {
  test("pins the OpenCode version and fails closed on any other version", async () => {
    const same = await openCodeRunner.identify({ resolved: fakeOpenCode });
    assert.equal(same.version, OPENCODE_VERSION);
    await assert.rejects(openCodeRunner.identify({ resolved: fakeOldOpenCode }), /OpenCode 2\.0\.0 is installed, but the worker is pinned to 2\.1\.4/u);
    const project = await makeProject();
    try {
      await assert.rejects(runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(join(fixtureRoot, "unused.json"), { executable: fakeOldOpenCode }) }), /pinned to 2\.1\.4/u);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("runs headless with --standalone and --format json, and never with --auto", () => {
    const args = openCodeArguments({ providerId: "oc", modelId: "exact-model", promptPath: "/opencode-state/task-prompt.md" });
    assert.equal(args[0], "run");
    assert.ok(args.includes("--standalone"));
    assert.equal(args[args.indexOf("--format") + 1], "json");
    assert.equal(args[args.indexOf("--agent") + 1], "build");
    assert.equal(args[args.indexOf("--model") + 1], "oc/exact-model");
    assert.equal(args[args.indexOf("--file") + 1], "/opencode-state/task-prompt.md");
    assert.equal(args.includes("--auto"), false);
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
  });

  test("permissions allow only read and edit, and the config carries that ruleset", () => {
    const config = buildOpenCodeConfig({ providerId: "oc", modelId: "exact-model", baseUrl: "http://127.0.0.1:41434", apiKey: "t" });
    assert.deepEqual(config.permissions, OPENCODE_PERMISSIONS);
    for (const action of ["read", "edit"]) assert.equal(effectFor(action, config.permissions), "allow", action);
    // These are the actions behind shell, web, question, subagent, glob, grep, todo, skill and outside-directory access.
    for (const action of ["shell", "webfetch", "websearch", "question", "subagent", "external_directory", "glob", "grep", "todowrite", "skill"]) {
      assert.equal(effectFor(action, config.permissions), "deny", action);
    }
    assert.equal(config.compaction.auto, false);
    assert.equal(config.formatter, false);
    assert.equal(config.lsp, false);
    assert.equal(config.snapshots, false);
    assert.equal(config.share, "disabled");
    assert.equal(config.agents.title.disabled, true);
  });

  test("records the host's managed configuration as presence only", async () => {
    const prepared = await openCodeRunner.prepareEnvironment({ worker: worker(), sourceEnv: { OPENCODE_TEST_KEY: "x" } });
    try {
      const managed = prepared.metadata.runtimeFacts.managedConfig;
      assert.equal(typeof managed.systemDirectory, "boolean");
      assert.equal(typeof managed.managedPreferences, "boolean");
      assert.deepEqual(Object.keys(managed).sort(), ["managedPreferences", "systemDirectory"]);
    } finally {
      await prepared.cleanup();
    }
  });
});

describe("OpenCode events", () => {
  test("parseEvents counts the recorded tool calls, reads, writes, usage and stop reason", async () => {
    const parsed = parseEvents(await readFile(fixturePath, "utf8"));
    assert.equal(parsed.toolCalls, 3);
    assert.deepEqual(parsed.toolCallsByName, { read: 1, edit: 1, shell: 1 });
    assert.equal(parsed.writeCalls, 1);
    assert.deepEqual(parsed.readPaths, ["src/allowed.txt"]);
    assert.equal(parsed.stopReason, "stop");
    assert.equal(parsed.errorMessage, null);
    assert.deepEqual(parsed.usage, { input: 1190, output: 42, reasoning: 0, cacheRead: 812, cacheWrite: 0, totalTokens: 2044 });
    assert.deepEqual(parsed.cumulativeUsage, { assistantMessages: 2, input: 2002, output: 138, reasoning: 0, totalTokens: 2002 + 138 + 812 });
    assert.equal(parsed.claims, "The file has one line. I will change it.\n\nThe edit is in place. I did not run the checks.");
    assert.deepEqual(parsed.compactions, []);
  });

  test("ignores lines that are not JSON and reports an error event", () => {
    const parsed = parseEvents(`not json\n{"type":"error","timestamp":1,"sessionID":"s","error":{"message":"provider refused"}}\n`);
    assert.equal(parsed.errorMessage, "provider refused");
    assert.equal(parsed.toolCalls, 0);
    assert.equal(parsed.stopReason, null);
  });
});

describe("OpenCode fake-runtime runs", () => {
  test("a fake OpenCode run produces a normal result with an allowed edit and records the isolated invocation", async () => {
    const project = await makeProject();
    const record = join(fixtureRoot, "record-allowed.json");
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(record) });
      assert.equal(result.outcome, "completed");
      assert.deepEqual(result.scopeViolations, []);
      assert.deepEqual(result.changedPaths.map((entry) => entry.path), ["src/allowed.txt"]);
      assert.equal(result.observed.assistantTermination.stopReason, "stop");
      assert.equal(result.observed.toolCalls, 3);
      assert.equal(await readFile(join(project, "src", "allowed.txt"), "utf8"), "before\n");

      const seen = JSON.parse(await readFile(record, "utf8"));
      assert.ok(seen.args.includes("--standalone"));
      assert.equal(seen.args[seen.args.indexOf("--format") + 1], "json");
      assert.equal(seen.args.includes("--auto"), false);
      const openCodeNames = Object.keys(seen.env).filter((name) => name.startsWith("OPENCODE_")).sort();
      assert.deepEqual(openCodeNames, [...OPENCODE_ENV_NAMES].sort());
      assert.equal(JSON.stringify(seen.env).includes("/host/evil"), false);
      assert.equal(JSON.stringify(seen.env).includes("synthetic-key-value"), false);
      const config = JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.providers.oc.settings.baseURL, "http://127.0.0.1:9/test-runtime");
      assert.equal(config.compaction.auto, false);

      const runtimeRecord = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(runtimeRecord.adapter, "opencode");
      assert.equal(runtimeRecord.runnerVersion, OPENCODE_VERSION);
      assert.equal(runtimeRecord.piExecutable, undefined);
      assert.deepEqual(runtimeRecord.capabilities.tools, ["read", "write", "edit"]);
      assert.equal(runtimeRecord.compaction.enabled, false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("declared checks on an OpenCode worker are reported unavailable with the runner named", async () => {
    const project = await makeProject();
    const checkText = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: "first", argv: ["node", "-e", "0"], timeoutMs: 1000 }] });
    const checks = { path: ".tinysdd/tasks/checks.json", text: checkText, sha256: createHash("sha256").update(checkText).digest("hex") };
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(["src/allowed.txt"], { checks }), worker: worker(), runtime: runtime(join(fixtureRoot, "record-checks.json")) });
      const runtimeRecord = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(runtimeRecord.runChecks.declared, true);
      assert.equal(runtimeRecord.runChecks.available, false);
      assert.match(runtimeRecord.runChecks.reason, /opencode worker runner/u);
      assert.deepEqual(runtimeRecord.capabilities.tools, ["read", "write", "edit"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("a Pi qualification is not reused by an OpenCode run", async () => {
    const project = await makeProject();
    const U = "UNKNOWN";
    // A Pi-era identity: same model and limits, Pi version present, no runner field.
    const piIdentity = {
      model: { provider: "oc", id: "exact-model", quantization: U, server: { id: U, version: U } },
      worker: {
        profileDigest: U,
        limits: { timeoutMs: 5000, maxToolCalls: 8, firstWriteMs: U },
        settings: { sandbox: "test-runtime", effectiveMaxTokens: U, effectiveReasoning: U, effectiveThinkingControl: U, effectiveThinkingReason: U, effectiveThinkingField: U, effectiveThinkingBudgetValue: U, effectiveCompat: U, endpointFingerprint: U },
      },
      pi: { version: "1.4.0" },
      runChecks: { declared: false, available: false, budget: 12, unavailableReason: U, provenance: { source: "worker.runtime.json", unavailableReason: U } },
      environment: { runtime: U, runtimeVersion: U, platform: U, arch: U },
    };
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(join(fixtureRoot, "record-qualified.json")), qualification: { status: "qualified", mode: "warn", identity: piIdentity } });
      const runtimeRecord = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(runtimeRecord.qualification.status, "unqualified");
      assert.ok(runtimeRecord.qualification.changedFields.includes("runner.type"), JSON.stringify(runtimeRecord.qualification.changedFields));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
