import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigDocument } from "../src/config.mjs";
import {
  OPENCODE_CHECK_PERMISSION,
  OPENCODE_ENV_NAMES,
  OPENCODE_PERMISSIONS,
  OPENCODE_VERSION,
  buildOpenCodeConfig,
  openCodeArguments,
} from "../src/opencode-environment.mjs";
import { buildMacosSandboxProfile } from "../src/macos-sandbox.mjs";
import { openCodeBubblewrapInvocation, openCodeRunner, openCodeSeatbeltInvocation, parseEvents } from "../src/runners/opencode.mjs";
import { piBubblewrapInvocation } from "../src/runners/pi.mjs";
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
if (process.env.TINYSDD_TEST_ACTION === "checks") {
  await runPlugin();
} else {
  process.stdout.write(readFileSync(process.env.TINYSDD_TEST_EVENTS, "utf8"));
}

// Loads the plugin the generated config names, as OpenCode 2.1.4 does for a
// configured local directory, and runs one model step that starts a slow write
// and then a check concurrently, as OpenCode's step runner does.
async function runPlugin() {
  const { pathToFileURL } = await import("node:url");
  const { setTimeout: delay } = await import("node:timers/promises");
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const hooks = { "execute.before": [], "execute.after": [] };
  const tools = new Map();
  const registration = { dispose: async () => {} };
  const plugin = (await import(pathToFileURL(join(config.plugins[0], "index.js")).href)).default;
  await plugin.setup({ tool: {
    hook: async (name, callback) => { hooks[name].push(callback); return registration; },
    transform: async (edit) => { edit({ add: (tool) => tools.set(tool.name, tool) }); return registration; },
  } });
  const tool = tools.get("run_checks");
  const emit = (event) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: "ses_1", ...event }) + "\\n");
  const call = async (name, id, input, run, { beforeDelayMs = 0 } = {}) => {
    const base = { tool: name, id, messageID: "msg_1", input };
    // A forked call can reach its execute.before hook later than a call streamed after it.
    await delay(beforeDelayMs);
    for (const hook of hooks["execute.before"]) await hook(base);
    let result;
    let error;
    try { result = await run(); } catch (caught) { error = caught; }
    for (const hook of hooks["execute.after"]) await hook({ ...base, ...(error ? { status: "error", error } : { status: "completed", result }) });
    const state = error ? { status: "error", input, error: error.message } : { status: "completed", input, output: result.content[0].text };
    emit({ type: "tool_use", part: { type: "tool", messageID: "msg_1", id, tool: name, state } });
  };
  emit({ type: "step_start", part: { messageID: "msg_1", type: "step-start" } });
  const write = call("write", "call_write", { path: "src/allowed.txt" }, async () => {
    await delay(300);
    writeFileSync(join(process.cwd(), "src", "allowed.txt"), "after\\n");
    return { content: [{ type: "text", text: "Wrote src/allowed.txt" }] };
  }, { beforeDelayMs: 40 });
  await delay(10);
  const check = call("run_checks", "call_check", {}, () => tool.execute({}, { id: "call_check", messageID: "msg_1", signal: new AbortController().signal }));
  await Promise.all([write, check]);
  emit({ type: "text", part: { type: "text", text: "Checked." } });
  emit({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
  if (process.env.TINYSDD_TEST_TOOLS) writeFileSync(process.env.TINYSDD_TEST_TOOLS, JSON.stringify({ names: [...tools.keys()], options: tool.options, input: tool.input, hooks: Object.fromEntries(Object.entries(hooks).map(([name, list]) => [name, list.length])) }));
}
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

function runtime(record, { action = "allowed", executable = fakeOpenCode, sourceEnv = { OPENCODE_TEST_KEY: "synthetic-key-value" }, extra = {}, testEnv = {} } = {}) {
  return {
    test: true,
    opencodeExecutable: executable,
    sourceEnv,
    testEnv: { TINYSDD_TEST_ACTION: action, TINYSDD_TEST_RECORD: record, TINYSDD_TEST_EVENTS: fixturePath, ...testEnv },
    ...extra,
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
      assert.equal(prepared.metadata.generatedCredentialReferenceCount, 1);
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

  test("ignores a User-Agent header with a warning and refuses any other header without echoing its value", async () => {
    const withHeaders = (headers) => {
      const path = join(fixtureRoot, `headers-${Math.random().toString(16).slice(2)}.json`);
      return writeFile(path, JSON.stringify({ provider: { oc: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "{env:OPENCODE_TEST_KEY}", headers }, models: { "exact-model": {} } } } })).then(() => path);
    };
    const agent = await withHeaders({ "user-agent": "tinysdd-test/1" });
    const preflight = await openCodeRunner.preflight({ worker: worker({ opencodeConfig: agent }), sourceEnv: { OPENCODE_TEST_KEY: "x" } });
    assert.deepEqual(preflight.errors, []);
    assert.ok(preflight.warnings.some((line) => /provider header user-agent is ignored/u.test(line)));
    const prepared = await openCodeRunner.prepareEnvironment({ worker: worker({ opencodeConfig: agent }), sourceEnv: { OPENCODE_TEST_KEY: "x" } });
    await prepared.cleanup();

    const tenant = await withHeaders({ "X-Tenant": "secret-tenant-value" });
    await assert.rejects(openCodeRunner.prepareEnvironment({ worker: worker({ opencodeConfig: tenant }), sourceEnv: { OPENCODE_TEST_KEY: "x" } }), (error) => {
      assert.match(error.message, /header X-Tenant/u);
      assert.match(error.message, /options\.apiKey/u);
      assert.match(error.message, /\{env:NAME\}/u);
      assert.equal(error.message.includes("secret-tenant-value"), false, "header values are never echoed");
      return true;
    });
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

describe("OpenCode provider lookup", () => {
  test("a relative opencodeConfig is refused even without the project config", async () => {
    await assert.rejects(openCodeRunner.preflight({ worker: worker({ opencodeConfig: "opencode.json" }) }), /an absolute path/u);
  });

  test("a provider or model id that names an inherited property does not resolve", async () => {
    const path = join(fixtureRoot, "proto.json");
    await writeFile(path, JSON.stringify({ provider: { oc: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1" }, models: { "exact-model": {} } } } }));
    await assert.rejects(openCodeRunner.preflight({ worker: worker({ opencodeConfig: path, model: "__proto__" }) }), /does not define model __proto__/u);
    await assert.rejects(openCodeRunner.preflight({ worker: worker({ opencodeConfig: path, model: "constructor" }) }), /does not define model constructor/u);
    await assert.rejects(openCodeRunner.preflight({ worker: worker({ opencodeConfig: path, provider: "constructor" }) }), /has no provider constructor/u);
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

  test("bubblewrap mounts the run_checks plugin directory read-only beside the check channel", () => {
    const invocation = openCodeBubblewrapInvocation({ nodeRoot: "/usr", binaryPath: "/home/worker/.opencode/bin/opencode", stateDir: "/tmp/state", args: ["run"], env: {} });
    const args = buildBubblewrapArgs({
      workspace: "/tmp/candidate",
      invocation,
      checkChannel: { requests: "/tmp/channel/requests", responses: "/tmp/channel/responses", extension: "/tmp/channel/run-checks-plugin", extensionTarget: "/opt/tinysdd/run-checks-plugin" },
      inference: { forwarder: "/tmp/forwarder.mjs", socketDir: "/tmp/socket", socketName: "relay.sock" },
    });
    const pairs = args.map((arg, index) => [arg, args[index + 1], args[index + 2]]);
    assert.ok(pairs.some(([flag, source, target]) => flag === "--ro-bind" && source === "/tmp/channel/run-checks-plugin" && target === "/opt/tinysdd/run-checks-plugin"));
    assert.ok(pairs.some(([flag, source, target]) => flag === "--bind" && source === "/tmp/channel/requests" && target === "/tinysdd/requests"));
    assert.ok(pairs.some(([flag, source, target]) => flag === "--ro-bind" && source === "/tmp/channel/responses" && target === "/tinysdd/responses"));
    assert.equal(args.includes("/opt/tinysdd/run-checks.mjs"), false);
  });

  test("the generated config names the check plugin only when one is given and refuses a relative one", () => {
    const base = { providerId: "oc", modelId: "m", baseUrl: "http://127.0.0.1:1", apiKey: "t" };
    assert.equal(buildOpenCodeConfig(base).plugins, undefined);
    const config = buildOpenCodeConfig({ ...base, checkPlugin: "/opt/tinysdd/run-checks-plugin" });
    assert.deepEqual(config.plugins, ["/opt/tinysdd/run-checks-plugin"]);
    assert.deepEqual(config.permissions, [...OPENCODE_PERMISSIONS, OPENCODE_CHECK_PERMISSION].map((rule) => ({ ...rule })));
    assert.throws(() => buildOpenCodeConfig({ ...base, checkPlugin: "run-checks-plugin" }), /absolute directory/u);
  });

  test("only the OpenCode sandbox gets a fresh procfs; Pi's bubblewrap args still have none", () => {
    const inference = { forwarder: "/tmp/forwarder.mjs", socketDir: "/tmp/socket", socketName: "relay.sock" };
    const opencode = buildBubblewrapArgs({
      workspace: "/tmp/tinysdd-workspace-x",
      invocation: openCodeBubblewrapInvocation({ nodeRoot: "/usr", binaryPath: "/home/worker/.opencode/bin/opencode", stateDir: "/tmp/state-x", args: ["run"], env: { HOME: "/opencode-state/home" } }),
      inference,
    });
    const pi = buildBubblewrapArgs({
      workspace: "/tmp/tinysdd-workspace-x",
      invocation: piBubblewrapInvocation({ nodeRoot: "/usr", stateDir: "/tmp/state-x", args: ["--print"] }),
      inference,
    });
    const procAt = opencode.indexOf("--proc");
    assert.ok(procAt >= 0, "OpenCode sandbox needs a procfs");
    assert.equal(opencode[procAt + 1], "/proc");
    assert.equal(pi.includes("--proc"), false, "Pi keeps no /proc mount");
    assert.equal(pi.includes("/proc"), false);
  });

  test("Seatbelt denies the macOS managed configuration locations", () => {
    const profile = buildMacosSandboxProfile({
      workspace: "/private/tmp/tinysdd-workspace-x",
      sourceRoot: "/private/tmp/tinysdd-source-x",
      compactionBundle: undefined,
      inferencePort: 41434,
      invocation: openCodeSeatbeltInvocation({ stateDir: "/private/tmp/tinysdd-opencode-state-x", binaryPath: "/Users/worker/.opencode/bin/opencode" }),
      checkChannel: null,
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

  test("declared checks give an OpenCode worker the run_checks plugin, and a check waits for the write it was batched with", async () => {
    const project = await makeProject();
    const checkText = JSON.stringify({ schemaVersion: 1, dependencyMounts: [], checks: [{ id: "first", argv: ["node", "-e", "0"], timeoutMs: 1000 }] });
    const checks = { path: ".tinysdd/tasks/checks.json", text: checkText, sha256: createHash("sha256").update(checkText).digest("hex") };
    const record = join(fixtureRoot, "record-checks.json");
    const toolsRecord = join(fixtureRoot, "record-check-tools.json");
    const seenByCheck = [];
    const checkRunner = async ({ candidateDir }) => {
      const text = await readFile(join(candidateDir, "src", "allowed.txt"), "utf8");
      seenByCheck.push(text);
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: { text, tail: text, totalBytes: Buffer.byteLength(text), truncated: false } };
    };
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(["src/allowed.txt"], { checks }), worker: worker(), runtime: runtime(record, { action: "checks", extra: { checkRunner }, testEnv: { TINYSDD_TEST_TOOLS: toolsRecord } }) });
      assert.equal(result.outcome, "completed");
      assert.deepEqual(seenByCheck, ["after\n"], "the check ran before the write it was batched with finished");
      const runtimeRecord = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.equal(runtimeRecord.runChecks.declared, true);
      assert.equal(runtimeRecord.runChecks.available, true);
      assert.equal(runtimeRecord.runChecks.runner, "test-injected");
      assert.deepEqual(runtimeRecord.capabilities.tools, ["read", "write", "edit", "run_checks"]);
      assert.deepEqual(runtimeRecord.capabilities.extensions, ["run-checks-plugin"]);
      // Tool-call accounting includes run_checks, as Pi's does.
      assert.equal(result.observed.toolCalls, 2);
      assert.deepEqual(result.observed.toolCallsByName, { write: 1, run_checks: 1 });
      assert.equal(runtimeRecord.accounting.maxToolCallsIncludesRunChecks, true);
      // The worker-observed records are the same as for Pi.
      assert.equal(result.workerObservedChecks.acceptanceEvidence, false);
      assert.equal(result.workerObservedChecks.runs.length, 1);
      assert.equal(result.workerObservedChecks.runs[0].outcome, "passed");
      const logged = (await readFile(result.artifactPaths.checks, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(logged.map((entry) => entry.checkId), ["first"]);

      const seen = JSON.parse(await readFile(record, "utf8"));
      const config = JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.plugins.length, 1);
      assert.match(config.plugins[0], /\/tinysdd-channel-[^/]+\/run-checks-plugin$/u);
      assert.ok(seen.env.TINYSDD_CHECK_CHANNEL && Number.isFinite(Number(seen.env.TINYSDD_CHECK_DEADLINE)));
      assert.deepEqual(config.permissions.at(-1), OPENCODE_CHECK_PERMISSION);
      // The run record names the ruleset and plugin OpenCode actually got.
      assert.deepEqual(runtimeRecord.runnerFacts.permissions, config.permissions);
      assert.deepEqual(runtimeRecord.runnerFacts.plugins, ["run-checks-plugin"]);
      assert.equal(effectFor("run_checks", config.permissions), "allow");
      for (const action of ["shell", "bash", "execute", "webfetch", "external_directory", "subagent"]) assert.equal(effectFor(action, config.permissions), "deny", action);
      const tools = JSON.parse(await readFile(toolsRecord, "utf8"));
      assert.deepEqual(tools.names, ["run_checks"]);
      assert.deepEqual(tools.options, { codemode: false });
      assert.deepEqual(tools.input, { type: "object", properties: { checkId: { type: "string" } }, additionalProperties: false });
      assert.deepEqual(tools.hooks, { "execute.before": 1, "execute.after": 1 });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("an OpenCode run without declared checks names no plugin and keeps the base permissions", async () => {
    const project = await makeProject();
    const record = join(fixtureRoot, "record-no-checks.json");
    try {
      const result = await runWorker({ projectRoot: project, packet: packet(), worker: worker(), runtime: runtime(record) });
      const config = JSON.parse(JSON.parse(await readFile(record, "utf8")).env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.plugins, undefined);
      assert.deepEqual(config.permissions, OPENCODE_PERMISSIONS.map((rule) => ({ ...rule })));
      const runtimeRecord = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
      assert.deepEqual(runtimeRecord.runnerFacts.permissions, config.permissions);
      assert.deepEqual(runtimeRecord.runnerFacts.plugins, []);
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
