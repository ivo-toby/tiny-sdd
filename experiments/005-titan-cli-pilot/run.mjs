import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const FIXTURE_ROOT = join(SCRIPT_DIR, "fixture");
const RUN_ROOT = join(REPO_ROOT, "experiments", "runs", "005-titan-cli-pilot");
const CLI = join(REPO_ROOT, "bin", "tinysdd.mjs");
const PROMPT = join(REPO_ROOT, "prompts", "worker.md");
const PROFILE = join(REPO_ROOT, "profiles", "qwen36-titan.json");
const CHECK = join(SCRIPT_DIR, "checks", "store.test.mjs");
const VERIFY = join(SCRIPT_DIR, "verify.mjs");
const PROTOCOL = join(SCRIPT_DIR, "protocol.md");
const RUNNER = join(SCRIPT_DIR, "run.mjs");
const CLI_SOURCES = [
  "package.json",
  "bin/tinysdd.mjs",
  "src/config.mjs",
  "src/controller.mjs",
  "src/fs-utils.mjs",
  "src/pi-environment.mjs",
  "src/worker.mjs",
];
const PROJECT_INPUTS = [
  "task.md",
  "src/store.mjs",
  "test/base.test.mjs",
  "test/batch.test.mjs",
  "review.md",
  ".tinysdd/config.json",
  ".tinysdd/config.local.json",
];
const LIMITS = Object.freeze({ timeoutMs: 300000, maxToolCalls: 40 });
const PARTICIPANTS = Object.freeze({
  qwen: Object.freeze({
    provider: "titan",
    model: "titan/llamacpp/qwen3.6-35b-a3b-256k",
    profile: "profiles/qwen36-titan.json",
  }),
  gemma: Object.freeze({
    provider: "titan",
    model: "titan/llamacpp/gemma4-26b-a4b-256k",
  }),
  north: Object.freeze({
    provider: "titan",
    model: "titan/llamacpp/north-mini-code-384k",
  }),
});
const APPROVAL_BY = "primary acting under actual user-delegated benchmark authority";
const APPROVAL_REASON = "The user delegated the primary to prepare this bounded pilot task; this controller approval is setup attribution, not model acceptance.";
const REVISION_POLICY = Object.freeze({
  maxRevisions: 1,
  automaticExecute: false,
  eligibility: "completed successful worker capture with verified retained candidate and matching after-snapshot",
  ineligibleOutcomes: ["failed", "timeout", "tool_limit", "output_limit", "runner_or_upstream_failure"],
});

function fail(message) {
  throw new Error(message);
}

function inside(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith("/"));
}

function repoRelative(path) {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

async function assertNoSymlink(path, label) {
  const absolute = resolve(path);
  const parsed = absolute.split(sep);
  let current = parsed[0] === "" ? sep : parsed[0];
  for (const part of parsed.slice(parsed[0] === "" ? 1 : 1)) {
    if (!part) continue;
    current = current === sep ? join(current, part) : join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${current}`);
  }
}

async function digestFile(path, label, { allowMissing = false } = {}) {
  await assertNoSymlink(path, label);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { path: repoRelative(path), exists: false };
    throw error;
  }
  if (!info.isFile()) fail(`${label} is not a regular file: ${path}`);
  const content = await readFile(path);
  return {
    path: repoRelative(path),
    exists: true,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function digestTree(root, label) {
  await assertNoSymlink(root, label);
  const files = {};
  async function visit(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(child);
      if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${rel}`);
      if (info.isDirectory()) {
        await visit(child, rel);
      } else if (info.isFile()) {
        const content = await readFile(child);
        files[rel] = {
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      } else {
        fail(`${label} contains an unsupported filesystem entry: ${rel}`);
      }
    }
  }
  await visit(root, "");
  return { root: repoRelative(root), files };
}

async function digestOptionalTree(root, label) {
  await assertNoSymlink(root, label);
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) fail(`${label} is not a directory: ${root}`);
  } catch (error) {
    if (error?.code === "ENOENT") return { root: repoRelative(root), exists: false };
    throw error;
  }
  return { exists: true, ...(await digestTree(root, label)) };
}

async function copyTree(source, destination, label) {
  await assertNoSymlink(source, label);
  async function visit(current, target, prefix) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = join(current, entry.name);
      const targetPath = join(target, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${rel}`);
      if (info.isDirectory()) {
        await visit(sourcePath, targetPath, rel);
      } else if (info.isFile()) {
        await copyFile(sourcePath, targetPath);
      } else {
        fail(`${label} contains an unsupported filesystem entry: ${rel}`);
      }
    }
  }
  await visit(source, destination, "");
}

async function writeJson(path, value, { exclusive = false } = {}) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: exclusive ? "wx" : "w",
  });
}

async function writeText(path, value, { exclusive = false } = {}) {
  await writeFile(path, value, { mode: 0o600, flag: exclusive ? "wx" : "w" });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function collectFrozenInputs(participant) {
  const selectedProfile = participant === "qwen";
  const cli = {};
  for (const path of CLI_SOURCES) cli[path] = await digestFile(join(REPO_ROOT, path), `CLI source ${path}`);
  return {
    schemaVersion: 1,
    task: await digestFile(join(FIXTURE_ROOT, "task.md"), "pilot task brief"),
    check: await digestFile(CHECK, "held-out check"),
    fixture: await digestTree(FIXTURE_ROOT, "pilot fixture"),
    prompt: await digestFile(PROMPT, "worker prompt"),
    profile: selectedProfile
      ? await digestFile(PROFILE, "qwen worker profile")
      : { path: "profiles/qwen36-titan.json", selected: false, exists: false },
    protocol: await digestFile(PROTOCOL, "pilot protocol"),
    verify: await digestFile(VERIFY, "credential-free verifier"),
    runner: await digestFile(RUNNER, "pilot runner"),
    cli,
  };
}

function frozenSourceFiles(frozen) {
  const files = [
    ...CLI_SOURCES.map((path) => ({ source: join(REPO_ROOT, path), relative: path })),
    { source: PROMPT, relative: "prompts/worker.md" },
    { source: PROFILE, relative: "profiles/qwen36-titan.json" },
    { source: PROTOCOL, relative: "experiments/005-titan-cli-pilot/protocol.md" },
    { source: CHECK, relative: "experiments/005-titan-cli-pilot/checks/store.test.mjs" },
    { source: VERIFY, relative: "experiments/005-titan-cli-pilot/verify.mjs" },
    { source: RUNNER, relative: "experiments/005-titan-cli-pilot/run.mjs" },
  ];
  for (const path of Object.keys(frozen.fixture.files)) {
    files.push({ source: join(FIXTURE_ROOT, path), relative: `experiments/005-titan-cli-pilot/fixture/${path}` });
  }
  return files;
}

async function retainFrozenInputs(runDir, frozen) {
  const root = join(runDir, "frozen", "repository");
  const files = [];
  for (const entry of frozenSourceFiles(frozen)) {
    await assertNoSymlink(entry.source, `frozen source ${entry.relative}`);
    const destination = join(root, entry.relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(entry.source, destination);
    const sourceInfo = await digestFile(entry.source, `frozen source ${entry.relative}`);
    const copyInfo = await digestFile(destination, `frozen copy ${entry.relative}`);
    if (sourceInfo.sha256 !== copyInfo.sha256 || sourceInfo.bytes !== copyInfo.bytes) {
      fail(`frozen copy does not match source: ${entry.relative}`);
    }
    files.push({
      source: entry.relative,
      copy: relative(runDir, destination).split(sep).join("/"),
      bytes: sourceInfo.bytes,
      sha256: sourceInfo.sha256,
    });
  }
  const result = { schemaVersion: 1, root: "frozen/repository", files };
  await writeJson(join(runDir, "frozen", "manifest.json"), result, { exclusive: true });
  return result;
}

async function verifyFrozenCopies(runDir, copies) {
  if (!copies || copies.schemaVersion !== 1 || !Array.isArray(copies.files) || copies.files.length === 0) {
    return ["retained frozen copies are missing"];
  }
  const mismatches = [];
  for (const entry of copies.files) {
    if (typeof entry.copy !== "string" || !inside(runDir, join(runDir, entry.copy))) {
      mismatches.push(`invalid retained copy path: ${entry.source ?? "unknown"}`);
      continue;
    }
    try {
      const actual = await digestFile(join(runDir, entry.copy), `retained frozen copy ${entry.source}`);
      if (!actual.exists || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
        mismatches.push(`retained frozen copy changed: ${entry.source}`);
      }
    } catch (error) {
      mismatches.push(`retained frozen copy unavailable: ${entry.source} (${error.message})`);
    }
  }
  return mismatches;
}

async function collectProjectInputs(project, participant) {
  const output = {};
  for (const path of PROJECT_INPUTS) {
    output[path] = await digestFile(join(project, ...path.split("/")), `prepared project input ${path}`, { allowMissing: true });
  }
  if (participant === "qwen") {
    output["profiles/qwen36-titan.json"] = await digestFile(
      join(project, "profiles", "qwen36-titan.json"),
      "copied qwen profile",
    );
  }
  output.profiles = await digestOptionalTree(join(project, "profiles"), "prepared project profiles");
  return output;
}

async function captureProcess(args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      spawnError = { name: error.name, code: error.code, message: error.message };
    });
    child.once("close", (exitCode, signal) => resolvePromise({
      argv: [process.execPath, ...args],
      cwd,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
      signal,
      spawnError,
    }));
  });
}

async function runCli(args) {
  const result = await captureProcess([CLI, ...args], REPO_ROOT);
  let envelope = null;
  let parseError = null;
  if (result.stdout.trim()) {
    try {
      envelope = JSON.parse(result.stdout);
    } catch (error) {
      parseError = { name: error.name, message: error.message };
    }
  }
  return { ...result, envelope, parseError };
}

async function recordCommand(runDir, number, result) {
  const prefix = join(runDir, "controller", `command-${String(number).padStart(2, "0")}`);
  await mkdir(dirname(prefix), { recursive: true, mode: 0o700 });
  await writeJson(`${prefix}.json`, {
    argv: result.argv,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    parseError: result.parseError,
    envelope: result.envelope,
  }, { exclusive: true });
  await writeText(`${prefix}.stdout`, result.stdout, { exclusive: true });
  await writeText(`${prefix}.stderr`, result.stderr, { exclusive: true });
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    parseError: result.parseError,
    envelope: result.envelope,
    stdout: repoRelative(`${prefix}.stdout`),
    stderr: repoRelative(`${prefix}.stderr`),
  };
}

function requireSuccessfulCommand(result, label) {
  if (result.spawnError || result.exitCode !== 0 || result.envelope?.ok === false) {
    fail(`${label} failed (exit ${result.exitCode ?? "spawn"})`);
  }
  if (result.envelope && result.envelope.ok !== true) fail(`${label} returned no successful JSON envelope`);
}

function participantConfig(participant) {
  const model = PARTICIPANTS[participant];
  return {
    defaultWorker: participant,
    workers: {
      [participant]: {
        type: "pi",
        provider: model.provider,
        model: model.model,
        ...(model.profile ? { profile: model.profile } : {}),
        limits: { ...LIMITS },
      },
    },
  };
}

async function initializeController(runDir, project, participant, commands, { reviewText = null } = {}) {
  let command = await runCli(["--version"]);
  const version = command.stdout.trim();
  commands.push(await recordCommand(runDir, commands.length + 1, command));
  if (command.exitCode !== 0) fail("product CLI version command failed");

  command = await runCli([
    "--json", "--project", project, "init",
    "--worker", participant,
    "--provider", PARTICIPANTS[participant].provider,
    "--model", PARTICIPANTS[participant].model,
  ]);
  commands.push(await recordCommand(runDir, commands.length + 1, command));
  requireSuccessfulCommand(command, "controller init");

  await writeJson(join(project, ".tinysdd", "config.local.json"), participantConfig(participant), { exclusive: true });

  command = await runCli(["--json", "--project", project, "config", "validate", "--worker", participant]);
  commands.push(await recordCommand(runDir, commands.length + 1, command));
  requireSuccessfulCommand(command, "config validation");

  command = await runCli([
    "--json", "--project", project, "task", "add",
    "--id", "batch-store",
    "--brief", "task.md",
    "--allow", "src/store.mjs,test/batch.test.mjs",
  ]);
  commands.push(await recordCommand(runDir, commands.length + 1, command));
  requireSuccessfulCommand(command, "controller task add");

  command = await runCli([
    "--json", "--project", project, "task", "approve",
    "--id", "batch-store",
    "--by", APPROVAL_BY,
    "--reason", APPROVAL_REASON,
  ]);
  commands.push(await recordCommand(runDir, commands.length + 1, command));
  requireSuccessfulCommand(command, "controller task approve");

  if (reviewText !== null) {
    command = await runCli([
      "--json", "--project", project, "task", "review",
      "--id", "batch-store",
      "--verdict", "revision",
      "--evidence", "review.md",
      "--by", APPROVAL_BY,
    ]);
    commands.push(await recordCommand(runDir, commands.length + 1, command));
    requireSuccessfulCommand(command, "controller task review revision");

    command = await runCli(["--json", "--project", project, "task", "packet", "--id", "batch-store"]);
    commands.push(await recordCommand(runDir, commands.length + 1, command));
    requireSuccessfulCommand(command, "controller revision packet");
    const review = command.envelope?.data?.review;
    const evidence = review?.evidence;
    if (review?.verdict !== "revision") fail("revision packet has an unexpected review verdict");
    if (evidence?.text !== reviewText) fail("revision packet did not retain exact feedback text");
  }
  return { version };
}

async function prepare(participant) {
  if (!Object.hasOwn(PARTICIPANTS, participant)) fail(`participant must be qwen, gemma, or north: ${participant}`);
  const frozen = await collectFrozenInputs(participant);
  await mkdir(RUN_ROOT, { recursive: true, mode: 0o700 });
  const runDir = await mkdtemp(join(RUN_ROOT, `${participant}-`));
  const project = join(runDir, "project");
  const commands = [];
  try {
    await copyTree(FIXTURE_ROOT, project, "pilot fixture");
    if (participant === "qwen") {
      await mkdir(join(project, "profiles"), { recursive: true, mode: 0o700 });
      await copyFile(PROFILE, join(project, "profiles", "qwen36-titan.json"));
    }
    const frozenCopies = await retainFrozenInputs(runDir, frozen);
    await writeJson(join(runDir, "prepare-inputs.json"), { inputs: frozen, copies: frozenCopies }, { exclusive: true });
    const { version } = await initializeController(runDir, project, participant, commands);

    const currentFrozen = await collectFrozenInputs(participant);
    if (!sameJson(frozen, currentFrozen)) fail("frozen pilot inputs changed while preparing the run");
    const projectInputs = await collectProjectInputs(project, participant);
    const manifest = {
      schemaVersion: 1,
      kind: "titan-cli-pilot-run",
      participant,
      model: { ...PARTICIPANTS[participant] },
      limits: { ...LIMITS },
      taskId: "batch-store",
      allowedPaths: ["src/store.mjs", "test/batch.test.mjs"],
      brief: "task.md",
      approval: { by: APPROVAL_BY, reason: APPROVAL_REASON },
      revisionPolicy: { ...REVISION_POLICY, ineligibleOutcomes: [...REVISION_POLICY.ineligibleOutcomes] },
      product: {
        root: ".",
        cli: repoRelative(CLI),
        version,
        commands: "controller/",
      },
      project: "project",
      frozen: { inputs: frozen, projectInputs, copies: frozenCopies },
      preparedAt: new Date().toISOString(),
      attempts: [],
    };
    await writeJson(join(runDir, "controller-commands.json"), commands, { exclusive: true });
    await writeJson(join(runDir, "manifest.json"), manifest, { exclusive: true });
    return { ok: true, command: "prepare", participant, run: repoRelative(runDir), project: repoRelative(project), version };
  } catch (error) {
    await writeJson(join(runDir, "prepare-error.json"), {
      error: { name: error.name, message: error.message },
      commands,
      run: repoRelative(runDir),
    }, { exclusive: true }).catch(() => {});
    throw error;
  }
}

async function readFeedback(pathValue, sourceProject) {
  if (typeof pathValue !== "string" || pathValue.length === 0) fail("FEEDBACK_FILE is required");
  const path = resolve(pathValue);
  await assertNoSymlink(path, "feedback file");
  const info = await lstat(path);
  if (!info.isFile()) fail("feedback file must be a regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    fail("feedback file must be owned by the invoking primary user");
  }
  if (inside(sourceProject, path)) fail("feedback file may not be inside the source run project or candidate");
  if (info.size === 0 || info.size > 512 * 1024) fail("feedback file must be nonempty and at most 512 KiB");
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  if (text.trim().length === 0) fail("feedback file must contain non-whitespace text");
  return {
    source: path,
    text,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function assertPortableCandidate(root) {
  await assertNoSymlink(root, "worker candidate");
  async function visit(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if ([".git", ".tinysdd", "node_modules"].includes(entry.name)) {
        fail(`worker candidate contains controller or dependency state: ${prefix ? `${prefix}/` : ""}${entry.name}`);
      }
      const path = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) fail(`worker candidate contains a symlink: ${rel}`);
      if (info.isDirectory()) await visit(path, rel);
      else if (!info.isFile()) fail(`worker candidate contains an unsupported entry: ${rel}`);
    }
  }
  await visit(root, "");
}

async function verifyCandidateSnapshot(candidate, snapshotPath) {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const actual = await digestTree(candidate, "worker candidate");
  const expectedFiles = {};
  for (const [path, entry] of Object.entries(snapshot)) {
    if (entry?.kind !== "file") fail(`worker result snapshot contains a non-file candidate entry: ${path}`);
    expectedFiles[path] = { bytes: entry.size, sha256: entry.sha256 };
  }
  const expectedPaths = Object.keys(expectedFiles).sort();
  const actualPaths = Object.keys(actual.files).sort();
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    fail("worker candidate does not match its retained after-snapshot");
  }
  for (const path of expectedPaths) {
    if (!sameJson(expectedFiles[path], actual.files[path])) fail("worker candidate does not match its retained after-snapshot");
  }
}

async function loadFirstCandidate(parent, project) {
  const attemptRoot = join(parent.runDir, "attempts");
  let entries;
  try {
    entries = await readdir(attemptRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail("source run has no worker attempts");
    throw error;
  }
  const attemptEntries = entries
    .filter((entry) => entry.isDirectory() && /^attempt-\d{3}$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  let attempt;
  let record;
  for (const entry of attemptEntries) {
    try {
      const candidateRecord = await readJson(join(attemptRoot, entry.name, "attempt.json"));
      if (candidateRecord.status === "observed") {
        attempt = entry;
        record = candidateRecord;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!attempt) fail("source run has no retained worker attempt");
  const attemptDir = join(attemptRoot, attempt.name);
  if (record.status !== "observed" || record.workerOutcome !== "completed") {
    fail("source run's first worker attempt was not a completed successful capture; timeout, upstream, or runner failures are retained but ineligible for revision");
  }
  const captured = await readJson(join(attemptDir, "cli-envelope.json"));
  const envelope = captured.envelope;
  if (captured.spawnError || captured.parseError || envelope?.ok !== true) {
    fail("source run has a runner/upstream failure rather than a successful worker result; it is retained but ineligible for revision");
  }
  const artifactPaths = envelope.data?.artifactPaths;
  if (!artifactPaths || typeof artifactPaths.candidate !== "string" || typeof artifactPaths.directory !== "string" || typeof artifactPaths.afterSnapshot !== "string") {
    fail("source worker result does not report a candidate and after-snapshot path");
  }
  const runsRoot = join(project, ".tinysdd", "runs");
  const artifactDir = resolve(artifactPaths.directory);
  const candidate = resolve(artifactPaths.candidate);
  const afterSnapshot = resolve(artifactPaths.afterSnapshot);
  if (!inside(runsRoot, artifactDir) || !inside(artifactDir, candidate) || !inside(artifactDir, afterSnapshot)) {
    fail("source worker candidate paths are outside the retained project artifact directory");
  }
  await assertNoSymlink(artifactDir, "source worker artifact directory");
  await assertPortableCandidate(candidate);
  const candidateInfo = await lstat(candidate);
  if (!candidateInfo.isDirectory()) fail("source worker candidate is not a directory");
  await verifyCandidateSnapshot(candidate, afterSnapshot);
  for (const required of ["task.md", "src/store.mjs", "test/base.test.mjs"]) {
    const info = await lstat(join(candidate, ...required.split("/"))).catch(() => null);
    if (!info?.isFile()) fail(`source worker candidate is missing required file: ${required}`);
  }
  return { attempt: Number(attempt.name.slice("attempt-".length)), candidate, envelope };
}

async function findRevisionChild(parentRun) {
  const parentRelative = repoRelative(parentRun);
  let entries = [];
  try {
    entries = await readdir(RUN_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const child = join(RUN_ROOT, entry.name);
    await assertNoSymlink(child, "revision run");
    if (resolve(child) === resolve(parentRun)) continue;
    try {
      const manifest = await readJson(join(child, "manifest.json"));
      if (manifest.lineage?.parentRun === parentRelative || manifest.revisionOf === parentRelative) return child;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        const failure = await readJson(join(child, "revise-error.json"));
        if (failure.parentRun === parentRelative) return child;
      } catch (failureError) {
        if (failureError?.code !== "ENOENT") throw failureError;
      }
    }
  }
  return null;
}

async function revise(parentValue, feedbackValue) {
  const parent = await openRun(parentValue);
  if (parent.manifest.lineage?.revisionNumber >= 1 || parent.manifest.revisionOf) {
    fail("only one revision is supported; a revision run cannot be revised again");
  }
  if (await findRevisionChild(parent.runDir)) fail("the source run already has a revision child");

  const currentInputs = await collectFrozenInputs(parent.manifest.participant);
  if (!sameJson(parent.manifest.frozen.inputs, currentInputs)) fail("source run frozen inputs changed; refusing a mixed-source revision");
  const currentProjectInputs = await collectProjectInputs(parent.project, parent.manifest.participant);
  if (!sameJson(parent.manifest.frozen.projectInputs, currentProjectInputs)) fail("source run project inputs changed; refusing a revision");
  const copyIssues = await verifyFrozenCopies(parent.runDir, parent.manifest.frozen.copies);
  if (copyIssues.length > 0) fail(`source run frozen copies are not intact: ${copyIssues.join("; ")}`);

  const feedback = await readFeedback(feedbackValue, parent.project);
  const sourceCandidate = await loadFirstCandidate(parent, parent.project);
  const frozen = currentInputs;
  await mkdir(RUN_ROOT, { recursive: true, mode: 0o700 });
  const runDir = await mkdtemp(join(RUN_ROOT, `${parent.manifest.participant}-revision-`));
  const project = join(runDir, "project");
  const commands = [];
  try {
    await copyTree(sourceCandidate.candidate, project, "retained worker candidate");
    const reviewPath = join(project, "review.md");
    try {
      await lstat(reviewPath);
      fail("retained worker candidate already contains review.md; refusing to overwrite model output");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await copyFile(feedback.source, reviewPath);
    const frozenCopies = await retainFrozenInputs(runDir, frozen);
    await writeJson(join(runDir, "prepare-inputs.json"), { inputs: frozen, copies: frozenCopies }, { exclusive: true });
    const { version } = await initializeController(runDir, project, parent.manifest.participant, commands, { reviewText: feedback.text });
    const afterInputs = await collectFrozenInputs(parent.manifest.participant);
    if (!sameJson(frozen, afterInputs)) fail("frozen pilot inputs changed while preparing the revision");
    const projectInputs = await collectProjectInputs(project, parent.manifest.participant);
    const manifest = {
      schemaVersion: 1,
      kind: "titan-cli-pilot-run",
      participant: parent.manifest.participant,
      model: { ...PARTICIPANTS[parent.manifest.participant] },
      limits: { ...LIMITS },
      taskId: "batch-store",
      allowedPaths: ["src/store.mjs", "test/batch.test.mjs"],
      brief: "task.md",
      approval: { by: APPROVAL_BY, reason: APPROVAL_REASON },
      revisionPolicy: { ...REVISION_POLICY, ineligibleOutcomes: [...REVISION_POLICY.ineligibleOutcomes] },
      review: {
        verdict: "revision",
        by: APPROVAL_BY,
        evidence: "review.md",
        source: repoRelative(feedback.source),
        bytes: feedback.bytes,
        sha256: feedback.sha256,
      },
      lineage: {
        parentRun: repoRelative(parent.runDir),
        parentAttempt: sourceCandidate.attempt,
        sourceCandidate: relative(parent.runDir, sourceCandidate.candidate).split(sep).join("/"),
        revisionNumber: 1,
      },
      product: {
        root: ".",
        cli: repoRelative(CLI),
        version,
        commands: "controller/",
      },
      project: "project",
      frozen: { inputs: frozen, projectInputs, copies: frozenCopies },
      preparedAt: new Date().toISOString(),
      attempts: [],
    };
    await writeJson(join(runDir, "controller-commands.json"), commands, { exclusive: true });
    await writeJson(join(runDir, "manifest.json"), manifest, { exclusive: true });
    return {
      ok: true,
      command: "revise",
      run: repoRelative(runDir),
      project: repoRelative(project),
      parentRun: repoRelative(parent.runDir),
      parentAttempt: sourceCandidate.attempt,
      revisionNumber: 1,
      version,
    };
  } catch (error) {
    await writeJson(join(runDir, "revise-error.json"), {
      error: { name: error.name, message: error.message },
      parentRun: repoRelative(parent.runDir),
      sourceCandidate: relative(parent.runDir, sourceCandidate.candidate).split(sep).join("/"),
      commands,
    }, { exclusive: true }).catch(() => {});
    throw error;
  }
}

async function openRun(value) {
  if (typeof value !== "string" || value.length === 0) fail("RUN is required");
  const runDir = resolve(value);
  await assertNoSymlink(runDir, "run path");
  if (!inside(RUN_ROOT, runDir) || resolve(runDir) === resolve(RUN_ROOT)) fail("RUN must be a child of the experiment run directory");
  const rootReal = await realpath(RUN_ROOT);
  const runReal = await realpath(runDir);
  if (!inside(rootReal, runReal) || runReal === rootReal) fail("RUN resolves outside the experiment run directory");
  const manifest = await readJson(join(runReal, "manifest.json"));
  if (manifest.kind !== "titan-cli-pilot-run" || manifest.schemaVersion !== 1) fail("RUN manifest is not a supported pilot run");
  if (!Object.hasOwn(PARTICIPANTS, manifest.participant)) fail("RUN manifest has an unknown participant");
  const project = join(runReal, "project");
  await assertNoSymlink(project, "run project");
  return { runDir: runReal, manifest, project };
}

async function nextAttempt(runDir) {
  const root = join(runDir, "attempts");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await readdir(root, { withFileTypes: true });
  const numbers = entries
    .filter((entry) => entry.isDirectory() && /^attempt-\d{3}$/u.test(entry.name))
    .map((entry) => Number(entry.name.slice("attempt-".length)));
  const number = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  const attemptDir = join(root, `attempt-${String(number).padStart(3, "0")}`);
  await mkdir(attemptDir, { recursive: false, mode: 0o700 });
  return { number, attemptDir };
}

function mismatch(expected, actual, label) {
  return sameJson(expected, actual) ? [] : [label];
}

async function actualPromptDigest(project, envelope) {
  const prompt = envelope?.data?.artifactPaths?.prompt;
  if (typeof prompt !== "string") return { status: "not-reported" };
  const path = resolve(prompt);
  if (!inside(project, path)) return { status: "rejected", reason: "reported prompt is outside the run project" };
  try {
    return { status: "observed", ...(await digestFile(path, "worker prompt artifact")) };
  } catch (error) {
    return { status: "unreadable", reason: error.message };
  }
}

async function execute(runValue) {
  const { runDir, manifest, project } = await openRun(runValue);
  const { number, attemptDir } = await nextAttempt(runDir);
  const expectedInputs = manifest.frozen.inputs;
  const expectedProjectInputs = manifest.frozen.projectInputs;
  const retainedCopyMismatches = await verifyFrozenCopies(runDir, manifest.frozen.copies);
  const beforeInputs = await collectFrozenInputs(manifest.participant);
  const beforeProjectInputs = await collectProjectInputs(project, manifest.participant);
  const preflight = {
    checkedAt: new Date().toISOString(),
    expectedInputs,
    actualInputs: beforeInputs,
    expectedProjectInputs,
    actualProjectInputs: beforeProjectInputs,
    retainedCopyMismatches,
  };
  await writeJson(join(attemptDir, "preflight.json"), preflight, { exclusive: true });
  const preflightMismatches = [
    ...mismatch(expectedInputs, beforeInputs, "frozen source inputs changed"),
    ...mismatch(expectedProjectInputs, beforeProjectInputs, "prepared project inputs changed"),
    ...retainedCopyMismatches,
  ];
  if (preflightMismatches.length > 0) {
    const refused = { number, status: "refused", reasons: preflightMismatches, noModelCall: true };
    await writeJson(join(attemptDir, "attempt.json"), refused, { exclusive: true });
    await writeJson(join(runDir, "manifest.json"), {
      ...manifest,
      attempts: [...(manifest.attempts ?? []), { number, status: "refused", reasons: preflightMismatches }],
      updatedAt: new Date().toISOString(),
    });
    fail(`execute refused: ${preflightMismatches.join("; ")}`);
  }

  const startedAt = new Date().toISOString();
  const startedMillis = Date.now();
  const command = await runCli([
    "--json", "--project", project, "worker", "run",
    "--task", "batch-store", "--worker", manifest.participant,
  ]);
  const finishedAt = new Date().toISOString();
  const wallTimeMs = Date.now() - startedMillis;
  await writeText(join(attemptDir, "cli.stdout"), command.stdout, { exclusive: true });
  await writeText(join(attemptDir, "cli.stderr"), command.stderr, { exclusive: true });
  await writeJson(join(attemptDir, "cli-envelope.json"), {
    argv: command.argv,
    cwd: command.cwd,
    exitCode: command.exitCode,
    signal: command.signal,
    spawnError: command.spawnError,
    parseError: command.parseError,
    envelope: command.envelope,
  }, { exclusive: true });
  const afterInputs = await collectFrozenInputs(manifest.participant);
  const afterProjectInputs = await collectProjectInputs(project, manifest.participant);
  const afterRetainedCopyMismatches = await verifyFrozenCopies(runDir, manifest.frozen.copies);
  const prompt = await actualPromptDigest(project, command.envelope);
  const hashMismatches = [
    ...mismatch(expectedInputs, afterInputs, "frozen source inputs changed after worker run"),
    ...mismatch(expectedProjectInputs, afterProjectInputs, "prepared project inputs changed after worker run"),
    ...afterRetainedCopyMismatches,
  ];
  const summary = {
    number,
    status: "observed",
    startedAt,
    finishedAt,
    wallTimeMs,
    command: command.argv,
    exitCode: command.exitCode,
    signal: command.signal,
    spawnError: command.spawnError,
    parseError: command.parseError,
    cliOk: command.envelope?.ok === true,
    workerOutcome: command.envelope?.data?.outcome ?? null,
    changedPaths: command.envelope?.data?.changedPaths ?? [],
    scopeViolations: command.envelope?.data?.scopeViolations ?? [],
    prompt,
    postRunHashMismatches: hashMismatches,
    artifacts: {
      stdout: `attempts/attempt-${String(number).padStart(3, "0")}/cli.stdout`,
      stderr: `attempts/attempt-${String(number).padStart(3, "0")}/cli.stderr`,
      envelope: `attempts/attempt-${String(number).padStart(3, "0")}/cli-envelope.json`,
    },
    acceptance: "not recorded by runner",
    verification: "not run by runner",
  };
  await writeJson(join(attemptDir, "postflight.json"), {
    actualInputs: afterInputs,
    actualProjectInputs: afterProjectInputs,
    retainedCopyMismatches: afterRetainedCopyMismatches,
    prompt,
    hashMismatches,
  }, { exclusive: true });
  await writeJson(join(attemptDir, "attempt.json"), summary, { exclusive: true });
  await writeJson(join(runDir, "manifest.json"), {
    ...manifest,
    attempts: [...(manifest.attempts ?? []), summary],
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, command: "execute", run: repoRelative(runDir), attempt: number, ...summary };
}

async function inspect(runValue) {
  const { runDir, manifest, project } = await openRun(runValue);
  const attemptRoot = join(runDir, "attempts");
  let entries = [];
  try {
    entries = await readdir(attemptRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const attempts = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^attempt-\d{3}$/u.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const record = await readJson(join(attemptRoot, entry.name, "attempt.json"));
      attempts.push({
        number: record.number,
        status: record.status,
        cliOk: record.cliOk ?? null,
        exitCode: record.exitCode ?? null,
        workerOutcome: record.workerOutcome ?? null,
        changedPaths: record.changedPaths ?? [],
        scopeViolations: record.scopeViolations ?? [],
        postRunHashMismatches: record.postRunHashMismatches ?? record.reasons ?? [],
      });
    } catch (error) {
      attempts.push({ number: Number(entry.name.slice("attempt-".length)), status: "incomplete", error: error.message });
    }
  }
  const currentInputs = await collectFrozenInputs(manifest.participant);
  const currentProjectInputs = await collectProjectInputs(project, manifest.participant);
  const retainedCopyMismatches = await verifyFrozenCopies(runDir, manifest.frozen.copies);
  return {
    ok: true,
    command: "inspect",
    run: repoRelative(runDir),
    participant: manifest.participant,
    model: manifest.model,
    limits: manifest.limits,
    taskId: manifest.taskId,
    allowedPaths: manifest.allowedPaths,
    revisionPolicy: manifest.revisionPolicy ?? REVISION_POLICY,
    productVersion: manifest.product.version,
    immutableInputsUnchanged: sameJson(manifest.frozen.inputs, currentInputs),
    projectInputsUnchanged: sameJson(manifest.frozen.projectInputs, currentProjectInputs),
    retainedFrozenCopiesUnchanged: retainedCopyMismatches.length === 0,
    retainedFrozenCopyIssues: retainedCopyMismatches,
    attempts,
    acceptance: "not recorded by runner",
    verification: "not run by runner",
  };
}

function usage() {
  return "Usage: node experiments/005-titan-cli-pilot/run.mjs prepare PARTICIPANT | execute RUN | revise RUN FEEDBACK_FILE | inspect RUN";
}

export { prepare, execute, revise, inspect };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value, extra] = process.argv.slice(2);
  try {
    if (command === "prepare" && value) {
      process.stdout.write(`${JSON.stringify(await prepare(value), null, 2)}\n`);
    } else if (command === "execute" && value) {
      process.stdout.write(`${JSON.stringify(await execute(value), null, 2)}\n`);
    } else if (command === "revise" && value && extra) {
      process.stdout.write(`${JSON.stringify(await revise(value, extra), null, 2)}\n`);
    } else if (command === "inspect" && value) {
      process.stdout.write(`${JSON.stringify(await inspect(value), null, 2)}\n`);
    } else {
      fail(usage());
    }
  } catch (error) {
    process.stderr.write(`run.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
