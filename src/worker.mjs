import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_LIMIT,
  MAX_TIMEOUT_MS,
  MAX_TOOL_LIMIT,
  PI_DEFAULT_MAX_TOKENS,
  PiEnvironmentError,
  preparePiEnvironment,
  validatePiWorker,
} from "./pi-environment.mjs";
import { checkRunnerAvailable } from "./check-runner.mjs";
import { parseChecksManifest } from "./checks-manifest.mjs";
import { createCheckChannel } from "./check-channel.mjs";
import { compileContext, contextSizeMetrics } from "./context-compiler.mjs";
import { buildMacosSandboxProfile } from "./macos-sandbox.mjs";
import { relayPiProvider, startInferenceRelay } from "./inference-relay.mjs";

const MAX_RAW_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_USER_PROMPT_BYTES = 128 * 1024;
const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;
const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const MAX_CLAIM_BYTES = 128 * 1024;
const SAFE_TASK_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_RUN_ID = /^worker-[0-9A-Za-z-]+$/u;
const CONTROLLER_TASKS_PREFIX = ".tinysdd/tasks/";
const CONTROLLER_REVIEWS_PREFIX = ".tinysdd/reviews/";
const PROJECT_SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const PROJECT_SECRET_DIR = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;
const PRODUCT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WORKER_GUIDANCE = `You are a TinySDD implementation worker. Use only the supplied read, write and edit tools in the disposable workspace. Do not execute commands, tests, package managers, shells, network clients or services. Implement exactly the approved task packet, preserve unrelated behavior and assertions, and hand back changed paths plus unrun verification notes. A model completion is not acceptance or test evidence.`;

export class WorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "WorkerError";
  }
}

function fail(message) {
  throw new WorkerError(message);
}

function slash(path) {
  return path.split(sep).join("/");
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
}

function projectRelative(value, label, controllerArtifactPrefix = null) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty project-relative path`);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) fail(`${label} must use a relative POSIX path`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail(`${label} contains traversal or empty path components`);
  const normalized = parts.join("/");
  if (parts[0] === ".git") fail(`${label} may not address controller state`);
  if (
    parts[0] === ".tinysdd"
    && (typeof controllerArtifactPrefix !== "string" || !normalized.startsWith(controllerArtifactPrefix) || normalized.length === controllerArtifactPrefix.length)
  ) fail(`${label} may not address controller state`);
  return normalized;
}

function isControllerArtifactPath(path) {
  return typeof path === "string" && (path.startsWith(CONTROLLER_TASKS_PREFIX) || path.startsWith(CONTROLLER_REVIEWS_PREFIX));
}

function selectedPath(pathValue, label) {
  const path = projectRelative(pathValue, label);
  if (path === "AGENTS.md" || path.endsWith("/AGENTS.md")) return path;
  return path;
}

async function ensureRoot(root) {
  if (typeof root !== "string" || root.length === 0) fail("projectRoot is required");
  const absolute = resolve(root);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    fail(`projectRoot is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("projectRoot must be a real directory, not a symlink");
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail("projectRoot resolves through a symlink");
  return { absolute, canonical };
}

async function temporaryRoot() {
  // macOS's system temp directory normally traverses /var -> /private/var.
  const requested = process.env.TINYSDD_TMPDIR ?? (process.platform === "darwin" ? await realpath(process.env.TMPDIR ?? "/tmp") : process.env.TMPDIR ?? "/tmp");
  if (typeof requested !== "string" || requested.length === 0) fail("TINYSDD_TMPDIR must name an existing directory");
  const absolute = resolve(requested);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    fail(`TinySDD temporary directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("TINYSDD_TMPDIR must be a real directory, not a symlink");
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail("TINYSDD_TMPDIR resolves through a symlink");
  return absolute;
}

async function ensureProjectPath(root, relPath, { allowMissing = false, regular = false, controllerArtifactPrefix = null } = {}) {
  const safe = projectRelative(relPath, "project path", controllerArtifactPrefix);
  const target = resolve(root, ...safe.split("/"));
  if (!isInside(root, target)) fail(`Project path escapes projectRoot: ${safe}`);
  const pieces = safe.split("/");
  let current = root;
  for (let index = 0; index < pieces.length; index += 1) {
    current = join(current, pieces[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return { path: target, rel: safe, exists: false };
      fail(`Cannot inspect project path ${safe}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (info.isSymbolicLink()) fail(`Symlinked project path is not allowed: ${safe}`);
    if (index < pieces.length - 1 && !info.isDirectory()) fail(`Project path parent is not a directory: ${safe}`);
  }
  const canonical = await realpath(target);
  if (!isInside(root, canonical)) fail(`Project path escapes projectRoot: ${safe}`);
  if (regular && !(await lstat(target)).isFile()) fail(`Project resource is not a regular file: ${safe}`);
  return { path: target, rel: safe, exists: true };
}

function excludedName(name, directory) {
  if (name === ".git" || name === ".tinysdd" || name === "node_modules") return true;
  if (directory && PROJECT_SECRET_DIR.test(name)) return true;
  return PROJECT_SECRET_NAME.test(name);
}

function gitEnvironment() {
  // Repository discovery must depend only on the project directory, never on
  // an inherited GIT_DIR/GIT_WORK_TREE that points somewhere else.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

async function gitCopyList(sourceRoot) {
  const child = spawn("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: sourceRoot, env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_GIT_LIST_BYTES) chunks.push(chunk);
    else overflow = true;
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 1024) stderr += chunk.toString("utf8").slice(0, 1024 - stderr.length);
  });
  const termination = await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish({ code: null, error: "git ls-files timed out" });
    }, 30_000);
    timer.unref?.();
    child.once("error", (error) => finish({ code: null, error: error?.code === "ENOENT" ? "git is unavailable" : (error instanceof Error ? error.message : String(error)) }));
    child.once("close", (code) => finish({ code, error: null }));
  });
  if (termination.error) return { paths: null, reason: termination.error };
  if (termination.code !== 0) return { paths: null, reason: stderr.trim().split("\n")[0] || `git ls-files exited ${termination.code}` };
  if (overflow) fail("git ls-files output exceeds the bounded worker copy list");
  const listed = Buffer.concat(chunks).toString("utf8").split("\0").filter((path) => path.length > 0);
  // Unmerged index entries are listed once per stage.
  return { paths: [...new Set(listed)].sort(), reason: null };
}

/**
 * Copy the worker's view of a source tree.
 *
 * A live project inside a Git work tree is copied from `git ls-files --cached
 * --others --exclude-standard`, so gitignored runtime state never reaches the
 * worker while new untracked source does.  Everything else (no Git, Git
 * unavailable, or an immutable baseline snapshot) uses the recursive walk.
 */
export async function copyProjectTree(sourceRoot, destinationRoot, { useGit = true, maxFiles = MAX_COPY_FILES, maxBytes = MAX_COPY_BYTES } = {}) {
  const counters = { files: 0, bytes: 0 };
  const copied = new Set();
  const count = (size) => {
    counters.files += 1;
    counters.bytes += size;
    if (counters.files > maxFiles || counters.bytes > maxBytes) fail("Project copy exceeds bounded worker input size");
  };
  async function visit(source, destination, relativePath) {
    const entries = await readdir(source, { withFileTypes: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (excludedName(entry.name, entry.isDirectory())) continue;
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) fail(`Source contains a symlink; refusing to copy ${rel}`);
      if (info.isDirectory()) {
        await visit(sourcePath, destinationPath, rel);
        continue;
      }
      if (!info.isFile()) fail(`Source contains unsupported filesystem entry: ${rel}`);
      count(info.size);
      await copyFile(sourcePath, destinationPath);
      copied.add(rel);
    }
  }
  const listing = useGit ? await gitCopyList(sourceRoot) : { paths: null, reason: "immutable baseline snapshot" };
  if (!listing.paths) {
    await visit(sourceRoot, destinationRoot, "");
    return { mode: "walk", fallbackReason: listing.reason, files: counters.files, bytes: counters.bytes, missingSkipped: 0, copied };
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const checkedDirectories = new Set();
  let missingSkipped = 0;
  for (const listed of listing.paths) {
    // Apply the walk's name exclusions (.git, .tinysdd, node_modules, secret
    // names) before path validation: a committed or unignored .tinysdd/ is
    // normal and must be skipped, not rejected as controller state.
    const listedParts = listed.split("/");
    if (listedParts.some((part, index) => excludedName(part, index < listedParts.length - 1))) continue;
    const rel = projectRelative(listed, "git-listed path");
    const parts = rel.split("/");
    let parentMissing = false;
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (checkedDirectories.has(directory)) continue;
      let info;
      try {
        info = await lstat(join(sourceRoot, ...parts.slice(0, index)));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        parentMissing = true;
        break;
      }
      if (info.isSymbolicLink()) fail(`Source contains a symlink; refusing to copy ${directory}`);
      if (!info.isDirectory()) fail(`Source contains unsupported filesystem entry: ${directory}`);
      checkedDirectories.add(directory);
    }
    const sourcePath = join(sourceRoot, ...parts);
    let info = null;
    if (!parentMissing) {
      try {
        info = await lstat(sourcePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!info) {
      // Tracked but deleted in the working tree (not yet staged).
      missingSkipped += 1;
      continue;
    }
    if (info.isSymbolicLink()) fail(`Source contains a symlink; refusing to copy ${rel}`);
    const destinationPath = join(destinationRoot, ...parts);
    if (info.isDirectory()) {
      // A gitlink (submodule) is listed as a directory; copy its working tree
      // with the walk rules rather than dropping source the task may need.
      await visit(sourcePath, destinationPath, rel);
      continue;
    }
    if (!info.isFile()) fail(`Source contains unsupported filesystem entry: ${rel}`);
    count(info.size);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, destinationPath);
    copied.add(rel);
  }
  if (copied.size === 0) fail("git ls-files listed no copyable files under projectRoot; refusing an empty worker workspace (is the project directory gitignored by an enclosing repository?)");
  return { mode: "git-ls-files", fallbackReason: null, files: counters.files, bytes: counters.bytes, missingSkipped, copied };
}

async function assertCopiedInputs(sourceRoot, copy, allowedPaths, protectedPaths, compiledContext) {
  for (const path of protectedPaths) {
    if (!copy.copied.has(path)) fail(`Protected path is not part of the worker copy (missing, gitignored or excluded): ${path}`);
  }
  for (const resource of compiledContext?.resources ?? []) {
    if (!copy.copied.has(resource.path)) fail(`Context resource is not part of the worker copy (gitignored or excluded): ${resource.path}`);
  }
  for (const path of allowedPaths) {
    if (copy.copied.has(path)) continue;
    let info;
    try {
      info = await lstat(join(sourceRoot, ...path.split("/")));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    // An existing allowed file missing from the copy would come back as a
    // "created" file and produce a patch that cannot apply to the project.
    if (info.isFile()) fail(`Allowed path exists but is not part of the worker copy (gitignored or excluded): ${path}`);
  }
}

async function resolveRevisionBase(projectRoot, baseRunId, allowedPaths, taskId) {
  if (baseRunId === undefined || baseRunId === null) return null;
  if (typeof baseRunId !== "string" || !SAFE_RUN_ID.test(baseRunId)) fail("baseRunId must name a TinySDD worker run");
  const allowed = new Set(allowedPaths);
  const seen = new Set();
  const chain = [];
  let currentId = baseRunId;
  while (currentId) {
    if (seen.has(currentId)) fail("base run lineage contains a cycle");
    seen.add(currentId);
    if (seen.size > 32) fail("base run lineage exceeds the supported depth");
    const runDirectory = resolve(projectRoot, ".tinysdd", "runs", currentId);
    if (!isInside(projectRoot, runDirectory)) fail("baseRunId escapes projectRoot");
    const resultPath = join(runDirectory, "result.json");
    let result;
    try {
      const directoryInfo = await lstat(runDirectory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) fail("base run directory is not a real directory");
      const resultInfo = await lstat(resultPath);
      if (resultInfo.isSymbolicLink() || !resultInfo.isFile()) fail("base run result is not a regular file");
      result = JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      fail(`Cannot load base run ${currentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result?.outcome !== "completed" || !Array.isArray(result?.changedPaths) || !Array.isArray(result?.scopeViolations) || result.scopeViolations.length > 0) {
      fail("base run must be a completed, scope-clean TinySDD worker result");
    }
    if (result.taskId !== undefined && result.taskId !== taskId) fail("base run lineage belongs to a different task");
    const paths = result.changedPaths.map((change) => {
      if (!change || typeof change.path !== "string" || !["created", "modified"].includes(change.change)) fail("base run contains an unsupported change");
      const path = projectRelative(change.path, "base run changed path");
      if (!allowed.has(path)) fail("base run changed a path outside this task allowlist");
      return path;
    });
    if (paths.length === 0) fail("base run has no reusable source changes");
    chain.unshift({ id: currentId, candidateRoot: join(runDirectory, "workspace-after"), paths: [...new Set(paths)].sort() });
    const parentId = result?.baseRun?.id;
    if (parentId === undefined || parentId === null) break;
    if (typeof parentId !== "string" || !SAFE_RUN_ID.test(parentId)) fail("base run lineage has an invalid parent");
    currentId = parentId;
  }
  const paths = [...new Set(chain.flatMap((entry) => entry.paths))].sort();
  return { id: baseRunId, chain, paths };
}

async function resolveFrozenBaseline(projectRoot, baselineRunId, taskId) {
  if (baselineRunId === undefined || baselineRunId === null) return null;
  if (typeof baselineRunId !== "string" || !SAFE_RUN_ID.test(baselineRunId)) fail("baselineRunId must name a TinySDD worker run");
  const runDirectory = resolve(projectRoot, ".tinysdd", "runs", baselineRunId);
  if (!isInside(projectRoot, runDirectory)) fail("baselineRunId escapes projectRoot");
  const resultPath = join(runDirectory, "result.json");
  const workspace = join(runDirectory, "workspace-before");
  try {
    const runInfo = await lstat(runDirectory);
    const resultInfo = await lstat(resultPath);
    const workspaceInfo = await lstat(workspace);
    if (runInfo.isSymbolicLink() || !runInfo.isDirectory()) fail("baseline run directory is not a real directory");
    if (resultInfo.isSymbolicLink() || !resultInfo.isFile()) fail("baseline run result is not a regular file");
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) fail("baseline run workspace-before is not a real directory");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result?.taskId !== taskId) fail("baseline run belongs to a different task");
    const canonical = await realpath(workspace);
    if (!isInside(runDirectory, canonical)) fail("baseline run workspace escapes its artifact directory");
    let runtime = null;
    try {
      const runtimePath = join(runDirectory, "runtime.json");
      const runtimeInfo = await lstat(runtimePath);
      if (!runtimeInfo.isSymbolicLink() && runtimeInfo.isFile()) runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    } catch {
      // Older artifacts have no runtime identity. Replays record that as
      // unknown instead of treating the dependency configuration as equal.
    }
    return { id: baselineRunId, root: canonical, runtime };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    fail(`Cannot load baseline run ${baselineRunId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function overlayRevisionBase(base, workspace) {
  if (!base) return;
  for (const ancestor of base.chain) {
    for (const path of ancestor.paths) {
      const source = join(ancestor.candidateRoot, ...path.split("/"));
      const destination = join(workspace, ...path.split("/"));
      let info;
      try {
        info = await lstat(source);
      } catch (error) {
        fail(`Base run is missing changed file ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (info.isSymbolicLink() || !info.isFile()) fail(`Base run changed path is not a regular file: ${path}`);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
  }
}

async function copyRegularTree(sourceRoot, destinationRoot) {
  async function visit(source, destination) {
    const entries = await readdir(source, { withFileTypes: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) fail(`Disposable workspace unexpectedly contains a symlink: ${entry.name}`);
      if (info.isDirectory()) await visit(sourcePath, destinationPath);
      else if (info.isFile()) await copyFile(sourcePath, destinationPath);
      else fail(`Disposable workspace contains unsupported entry: ${entry.name}`);
    }
  }
  await visit(sourceRoot, destinationRoot);
}

async function copySnapshotTree(sourceRoot, destinationRoot) {
  async function visit(source, destination) {
    const entries = await readdir(source, { withFileTypes: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(sourcePath, destinationPath);
      else if (info.isFile()) await copyFile(sourcePath, destinationPath);
    }
  }
  await visit(sourceRoot, destinationRoot);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function snapshotTree(root) {
  const output = {};
  async function visit(current, relativePath) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        output[rel] = { kind: "symlink", sha256: null, size: null };
      } else if (info.isDirectory()) {
        await visit(path, rel);
      } else if (info.isFile()) {
        output[rel] = { kind: "file", sha256: await hashFile(path), size: info.size };
      } else {
        output[rel] = { kind: "other", sha256: null, size: null };
      }
    }
  }
  await visit(root, "");
  return output;
}

function changedFiles(before, after) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((path) => {
    const oldValue = before[path];
    const newValue = after[path];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
    let change = "modified";
    if (!oldValue) change = "created";
    else if (!newValue) change = "deleted";
    else if (oldValue.kind !== newValue.kind) change = "type_changed";
    return [{ path, change, before: oldValue ?? null, after: newValue ?? null }];
  });
}

async function readTextResource(projectRoot, pathValue, label, options = {}) {
  const resource = await ensureProjectPath(projectRoot, pathValue, { regular: true, ...options });
  const info = await stat(resource.path);
  if (info.size > MAX_RESOURCE_BYTES) fail(`${label} exceeds the bounded resource size: ${resource.rel}`);
  const text = await readFile(resource.path, "utf8");
  return { path: resource.rel, text, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}

async function findApplicableAgents(projectRoot, relevantPaths) {
  const paths = new Set(["AGENTS.md"]);
  for (const relativePath of relevantPaths) {
    const pieces = relativePath.split("/");
    for (let count = 1; count < pieces.length; count += 1) paths.add(`${pieces.slice(0, count).join("/")}/AGENTS.md`);
  }
  const resources = [];
  for (const path of [...paths].sort()) {
    try {
      resources.push(await readTextResource(projectRoot, path, "AGENTS.md"));
    } catch (error) {
      if (error?.code === "ENOENT" || /Cannot inspect project path/.test(String(error?.message))) continue;
      if (error instanceof WorkerError && /Cannot inspect project path/.test(error.message)) continue;
      // Missing optional instructions are fine; symlinked instructions are not.
      if (error?.cause?.code === "ENOENT") continue;
      throw error;
    }
  }
  return resources;
}

function validateProfile(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Worker profile must be an object");
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || value.id.length === 0) fail("Worker profile requires schemaVersion 1 and id");
  if (value.instructions !== undefined && typeof value.instructions !== "string") fail("Worker profile.instructions must be a string");
  if (value.runtime !== undefined) {
    if (!value.runtime || typeof value.runtime !== "object" || Array.isArray(value.runtime)) fail("Worker profile.runtime must be an object");
    const allowed = new Set(["thinking", "reasoning", "compat", "thinkingBudgets"]);
    for (const key of Object.keys(value.runtime)) if (!allowed.has(key)) fail(`Worker profile.runtime.${key} is unsupported`);
    if (value.runtime.thinking !== undefined && !["off", "minimal", "low", "medium", "high"].includes(value.runtime.thinking)) fail("Worker profile.runtime.thinking is invalid");
    if (value.runtime.reasoning !== undefined && typeof value.runtime.reasoning !== "boolean") fail("Worker profile.runtime.reasoning must be boolean");
    if (value.runtime.compat !== undefined) {
      if (!value.runtime.compat || typeof value.runtime.compat !== "object" || Array.isArray(value.runtime.compat)) fail("Worker profile.runtime.compat must be an object");
      for (const key of Object.keys(value.runtime.compat)) if (!["thinkingFormat", "supportsDeveloperRole", "thinkingTokenBudgetField"].includes(key)) fail(`Worker profile.runtime.compat.${key} is unsupported`);
    }
    if (value.runtime.thinkingBudgets !== undefined) {
      const budgets = value.runtime.thinkingBudgets;
      if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) fail("Worker profile.runtime.thinkingBudgets must be an object");
      for (const [level, tokens] of Object.entries(budgets)) {
        if (!["minimal", "low", "medium", "high"].includes(level)) fail(`Worker profile.runtime.thinkingBudgets.${level} is unsupported`);
        if (!Number.isInteger(tokens) || tokens <= 0) fail(`Worker profile.runtime.thinkingBudgets.${level} must be a positive integer`);
      }
    }
  }
  for (const key of ["evidence", "limitations"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string"))) fail(`Worker profile.${key} must be an array of strings`);
  }
  return structuredClone(value);
}

async function resolveProfile(projectRoot, worker, profile) {
  const source = profile ?? worker.profile;
  if (source === undefined || source === null) return { value: null, resource: null };
  if (typeof source === "string") {
    const resource = await readTextResource(projectRoot, selectedPath(source, "worker profile"), "worker profile");
    let value;
    try {
      value = JSON.parse(resource.text);
    } catch (error) {
      fail(`Worker profile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { value: validateProfile(value), resource };
  }
  return { value: validateProfile(source), resource: null };
}

function normalizePacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) fail("A resolved task packet is required");
  const taskId = packet.taskId ?? packet.id;
  if (typeof taskId !== "string" || !SAFE_TASK_ID.test(taskId)) fail("packet.taskId must use lowercase letters, digits, hyphens or underscores");
  let briefText = packet.briefText;
  let briefPath = packet.briefPath;
  let briefSha256 = packet.briefSha256;
  if (briefText === undefined && typeof packet.brief === "string") briefText = packet.brief;
  if (packet.brief && typeof packet.brief === "object") {
    briefText ??= packet.brief.text;
    briefPath ??= packet.brief.path;
    briefSha256 ??= packet.brief.sha256;
  }
  if (briefText !== undefined && (typeof briefText !== "string" || briefText.trim().length === 0)) fail("packet brief text must be nonempty");
  if (briefSha256 !== undefined && (typeof briefSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(briefSha256))) fail("packet brief sha256 must be a SHA-256 digest");
  const allowedPaths = packet.allowedPaths ?? packet.allow;
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) fail("packet.allowedPaths must list at least one exact path");
  if (allowedPaths.some((path) => typeof path !== "string")) fail("packet.allowedPaths must contain strings");
  const normalizedAllowed = allowedPaths.map((path) => projectRelative(path, "packet allowed path"));
  const protectedPaths = packet.protectedPaths === undefined ? [] : packet.protectedPaths;
  if (!Array.isArray(protectedPaths) || protectedPaths.some((path) => typeof path !== "string")) fail("packet.protectedPaths must be an array of strings");
  const normalizedProtected = protectedPaths.map((path) => projectRelative(path, "packet protected path"));
  if (new Set(normalizedProtected).size !== normalizedProtected.length) fail("packet.protectedPaths must not contain duplicates");
  if (normalizedProtected.some((path) => normalizedAllowed.includes(path))) fail("packet.protectedPaths must not overlap packet.allowedPaths");
  const dependencies = packet.dependencies === undefined ? [] : packet.dependencies;
  if (!Array.isArray(dependencies)) fail("packet.dependencies must be an array");
  let review = null;
  if (packet.review !== undefined && packet.review !== null) {
    if (!packet.review || typeof packet.review !== "object" || Array.isArray(packet.review)) fail("packet.review must be an object");
    if (packet.review.verdict !== "revision") fail("packet.review must be a revision for worker feedback");
    if (typeof packet.review.by !== "string" || packet.review.by.trim().length === 0) fail("packet.review.by is required");
    const evidence = packet.review.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail("packet.review.evidence is required");
    if (evidence.text !== undefined && typeof evidence.text !== "string") fail("packet.review.evidence.text must be a string");
    const evidencePath = evidence.path === undefined ? undefined : projectRelative(evidence.path, "packet review evidence path", CONTROLLER_REVIEWS_PREFIX);
    if (evidence.text === undefined && evidence.path === undefined) fail("packet.review.evidence needs text or path");
    if (evidence.sha256 !== undefined && (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.sha256))) fail("packet.review.evidence.sha256 must be a SHA-256 digest");
    review = { verdict: "revision", by: packet.review.by, evidence: { ...evidence, ...(evidencePath ? { path: evidencePath } : {}) } };
  }
  let context = null;
  if (packet.context !== undefined && packet.context !== null) {
    if (!packet.context || typeof packet.context !== "object" || Array.isArray(packet.context)) fail("packet.context must be an object");
    const { path, text, sha256, compiledSha256 } = packet.context;
    if (typeof text !== "string") fail("packet.context.text must be a string");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) fail("packet.context.sha256 must be a SHA-256 digest");
    if (compiledSha256 !== undefined && (typeof compiledSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(compiledSha256))) fail("packet.context.compiledSha256 must be a SHA-256 digest");
    context = {
      path: projectRelative(path, "packet context path", CONTROLLER_TASKS_PREFIX),
      text,
      sha256,
      ...(compiledSha256 === undefined ? {} : { compiledSha256 }),
    };
  }
  let checks = null;
  if (packet.checks !== undefined && packet.checks !== null) {
    if (!packet.checks || typeof packet.checks !== "object" || Array.isArray(packet.checks)) fail("packet.checks must be an object");
    const { path, text, sha256 } = packet.checks;
    if (typeof text !== "string") fail("packet.checks.text must be a string");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) fail("packet.checks.sha256 must be a SHA-256 digest");
    if (createHash("sha256").update(text).digest("hex") !== sha256) fail("packet checks digest does not match supplied text");
    checks = { path: projectRelative(path, "packet checks path", CONTROLLER_TASKS_PREFIX), text, sha256 };
  }
  return {
    taskId,
    briefText,
    briefPath: briefPath === undefined ? undefined : projectRelative(briefPath, "packet brief path", CONTROLLER_TASKS_PREFIX),
    briefSha256,
    allowedPaths: normalizedAllowed,
    protectedPaths: normalizedProtected,
    dependencies,
    approval: packet.approval ?? null,
    review,
    context,
    checks,
  };
}

function validateResourceList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be an array of paths`);
  return value.map((path) => selectedPath(path, label));
}

async function optionalProductPrompt() {
  const path = join(PRODUCT_ROOT, "prompts", "worker.md");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.size > MAX_RESOURCE_BYTES) fail("Built-in worker prompt exceeds the bounded resource size");
    const text = await readFile(path, "utf8");
    return { path: "prompts/worker.md", text, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function formatContext(resource) {
  return `\n--- ${resource.path} (sha256:${resource.sha256}) ---\n${resource.text}`;
}

function buildPrompt({ packet, profile, review, compiledContext, agents, skills, instructions, builtInPrompt }) {
  const systemSections = [builtInPrompt?.text || DEFAULT_WORKER_GUIDANCE];
  systemSections.push(`\n\n## TinySDD worker contract\nYou are operating in a disposable candidate workspace. Read, write and edit only. Do not run commands, tests, shells, package managers, network clients or services. Do not inspect outside the workspace or invent missing requirements. Implement only this approved packet and preserve unrelated files and assertions. The caller performs all verification separately; report checks as unrun unless the packet itself supplies observed evidence.\n\nAllowed exact paths (scope is reported by the caller, not permission to edit others):\n${packet.allowedPaths.map((path) => `- ${path}`).join("\n")}`);
  if (packet.protectedPaths.length > 0) systemSections.push(`\n\n## Protected contract files (read-only)\nRead these files; never write, edit, create, delete or rename them. A change is reported as a scope violation.\n${packet.protectedPaths.map((path) => `- ${path}`).join("\n")}`);
  if (profile?.instructions) systemSections.push(`\n\n## Model profile guidance\n${profile.instructions}`);
  if (compiledContext) systemSections.push(`\n\n## Compiled-context operating rule\nThe caller has supplied a bounded implementation context with approved facts and exact source excerpts. Treat it as the authoritative working set for the cited contracts and acceptance assertions. Do not re-read cited source files or the source specification merely to rediscover injected facts. Read uncited code only when needed for the allowed edit, or when a concrete contradiction requires escalation. Start by planning the allowed-file edit.`);
  if (review) systemSections.push(`\n\n## Caller revision constraints\nThis is a bounded revision under the existing task approval. Do not broaden the task or reinterpret the contract. Address only the named review evidence; report any contradiction instead of inventing a requirement. Reviewer: ${review.by}\n${formatContext(review.evidence)}`);
  for (const resource of agents) systemSections.push(formatContext(resource));
  for (const resource of skills) systemSections.push(formatContext(resource));
  for (const resource of instructions) systemSections.push(formatContext(resource));
  const contextSection = compiledContext ? `\n\n${compiledContext.rendered}` : "";
  const user = `Task ID: ${packet.taskId}\nDependencies: ${JSON.stringify(packet.dependencies)}${contextSection}\n\n## Approved task packet\n${packet.briefText}`;
  const system = systemSections.join("\n");
  if (Buffer.byteLength(system) > MAX_PROMPT_BYTES || Buffer.byteLength(user) > MAX_USER_PROMPT_BYTES) fail("Worker prompt exceeds bounded input size");
  return { system, user, rendered: `${system}\n\n## User task\n${user}` };
}

async function executablePath(candidate, label) {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) fail(`${label} must be an absolute executable path`);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolved = await realpath(candidate);
  const resolvedInfo = await lstat(resolved);
  if (!resolvedInfo.isFile()) fail(`${label} does not resolve to a regular file`);
  if (!(resolvedInfo.mode & fsConstants.X_OK)) fail(`${label} is not executable`);
  // Pi is commonly a symlink to its installed bundle.  It is safe to resolve
  // for validation while preserving the lexical install root for bwrap.
  return { path: candidate, resolved, wasSymlink: info.isSymbolicLink() };
}

async function findDefaultExecutable(name, candidates) {
  for (const candidate of candidates) {
    try {
      return await executablePath(candidate, name);
    } catch {
      // Continue through the bounded list; no PATH command lookup or fallback
      // model/runtime selection is performed.
    }
  }
  fail(`${name} is unavailable; Linux bubblewrap and the installed Pi executable are required`);
}

async function chooseRuntime(runtime) {
  if (runtime?.test === true) {
    if (process.env.TINYSDD_WORKER_TEST !== "1") fail("Worker test runtime is disabled outside the test harness");
    const pi = await executablePath(runtime.piExecutable, "test Pi executable");
    return { test: true, pi, bwrap: null, sourceAgentDir: runtime.sourceAgentDir, sourceEnv: runtime.sourceEnv };
  }
  if (process.platform === "darwin") {
    const sandboxExec = await executablePath(runtime?.sandboxExecExecutable ?? "/usr/bin/sandbox-exec", "macOS sandbox-exec");
    const pi = await executablePath(runtime?.piExecutable ?? join(dirname(process.execPath), "pi"), "Pi executable");
    const node = await executablePath(process.execPath, "Node executable");
    return { test: false, sandbox: "seatbelt", pi, node, sandboxExec, bwrap: null, sourceAgentDir: undefined, sourceEnv: undefined };
  }
  if (process.platform !== "linux") fail("Pi workers require Linux bubblewrap or macOS sandbox-exec; refusing an unsandboxed run");
  const bwrapCandidates = runtime?.bwrapExecutable ? [runtime.bwrapExecutable] : ["/usr/bin/bwrap", "/bin/bwrap"];
  const bwrap = await findDefaultExecutable("bubblewrap", bwrapCandidates);
  const defaultPi = runtime?.piExecutable || join(dirname(process.execPath), "pi");
  const pi = await executablePath(defaultPi, "Pi executable");
  return { test: false, pi, bwrap, sourceAgentDir: undefined, sourceEnv: undefined };
}

async function existingAbsoluteDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory`);
  const canonical = await realpath(path);
  if (canonical !== path) fail(`${label} resolves through a symlink`);
  return canonical;
}

async function piPackageInfo(pi) {
  let current = dirname(pi.resolved);
  for (let count = 0; count < 8; count += 1) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (typeof packageJson.name === "string" && typeof packageJson.version === "string") return { version: packageJson.version, root: current };
    } catch {
      // Continue toward the bounded install root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { version: null, root: null };
}

function probeCheckRunner(runtimeChoice, runtime) {
  if (runtimeChoice.test) {
    if (typeof runtime?.checkRunner === "function") return { available: true, reason: null, testInjected: true };
    const availability = checkRunnerAvailable();
    return availability.available
      ? { available: false, reason: "test runtime did not provide a check runner", testInjected: false }
      : { ...availability, testInjected: false };
  }
  return { ...checkRunnerAvailable(), testInjected: false };
}

function compareRunChecks(baseline, current) {
  if (!baseline) return { status: "not_applicable" };
  const previous = baseline.runtime?.runChecks;
  if (!previous || typeof previous !== "object") {
    return { status: "unknown", reason: "baseline runtime has no runChecks identity" };
  }
  if (typeof previous.declared !== "boolean" || typeof previous.available !== "boolean") {
    return { status: "unknown", reason: "baseline runChecks availability is unknown" };
  }
  for (const key of ["declared", "available"]) {
    if (previous[key] !== current[key]) return { status: "different", reason: `baseline runChecks.${key} differs` };
  }
  if (!current.available) return { status: "identical" };
  if (!Number.isInteger(previous.maxCheckRuns) || typeof previous.runner !== "string") {
    return { status: "unknown", reason: "baseline check-run budget or runner identity is unavailable" };
  }
  if (previous.maxCheckRuns !== current.maxCheckRuns || previous.runner !== current.runner) {
    return { status: "different", reason: "baseline runChecks configuration differs" };
  }
  if (!previous.dependencyIdentity || !current.dependencyIdentity) {
    return { status: "unknown", reason: "baseline dependency identity is unavailable" };
  }
  if (typeof previous.dependencyIdentity.algorithm !== "string" || typeof previous.dependencyIdentity.provenance !== "string") {
    return { status: "unknown", reason: "baseline dependency identity provenance is unavailable" };
  }
  if (previous.dependencyIdentity.algorithm !== current.dependencyIdentity.algorithm || previous.dependencyIdentity.provenance !== current.dependencyIdentity.provenance) {
    return { status: "different", reason: "baseline dependency identity provenance differs" };
  }
  return previous.dependencyIdentity.sha256 === current.dependencyIdentity.sha256
    ? { status: "identical" }
    : { status: "different", reason: "dependency mount content differs" };
}

function runChecksMetadata({ declared, availability, maxCheckRuns, checkChannel, baseline }) {
  const current = {
    declared,
    available: declared && availability.available,
    ...(declared && !availability.available ? { reason: availability.reason } : {}),
    ...(declared && availability.available ? { maxCheckRuns, runner: availability.testInjected ? "test-injected" : "linux-bubblewrap" } : {}),
    ...(checkChannel ? { dependencyIdentity: checkChannel.dependencyIdentity } : {}),
  };
  if (baseline) current.baselineComparison = compareRunChecks(baseline, current);
  return current;
}

function buildPiArgs({ provider, model, sessionPath, thinking, systemPromptPath, userPrompt, checkExtension }) {
  const args = [
    "--offline",
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--tools",
    checkExtension ? "read,write,edit,run_checks" : "read,write,edit",
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking,
    "--session",
    sessionPath,
    "--append-system-prompt",
    systemPromptPath,
  ];
  if (checkExtension) args.push("-e", checkExtension);
  args.push(userPrompt);
  return args;
}

function buildBubblewrapArgs({ workspace, stateDir, nodeRoot, piArgs, piLexicalPath, env, checkChannel }) {
  const requiredMounts = ["/usr", "/bin", "/lib", "/lib64"];
  const args = ["--die-with-parent", "--unshare-user", "--unshare-pid", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/etc"];
  for (const mount of requiredMounts) args.push("--ro-bind", mount, mount);
  // Keep networking usable for the configured inference proxy without exposing
  // the host's entire /etc tree.  There is intentionally no /proc mount:
  // worker read tools must not be able to inspect process environments.
  for (const path of [
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/services",
    "/etc/localtime",
    "/etc/ssl/certs",
    "/etc/ca-certificates",
  ]) args.push("--ro-bind-try", path, path);
  args.push("--dir", "/opt", "--ro-bind", nodeRoot, "/opt/node", "--dir", "/work", "--bind", workspace, "/work", "--dir", "/pi-state", "--bind", stateDir, "/pi-state", "--chdir", "/work");
  if (checkChannel) args.push("--dir", "/tinysdd", "--bind", checkChannel.requests, "/tinysdd/requests", "--ro-bind", checkChannel.responses, "/tinysdd/responses", "--dir", "/opt/tinysdd", "--ro-bind", checkChannel.extension, "/opt/tinysdd/run-checks.mjs");
  // No --unshare-net: model inference must reach the configured proxy.  The
  // only writable mounts are the disposable candidate and temporary Pi state.
  args.push("--setenv", "HOME", "/home", "--setenv", "PI_CODING_AGENT_DIR", "/pi-state", "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin");
  args.push(piLexicalPath, ...piArgs);
  return args;
}

const WRITE_TOOLS = new Set(["write", "edit"]);

function parseEvents(text) {
  const assistant = [];
  const turnEnds = [];
  let toolCalls = 0;
  let writeCalls = 0;
  const toolCallsByName = {};
  const readPaths = [];
  const compactions = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      const name = typeof event.toolName === "string" ? event.toolName : "unknown";
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
      if (WRITE_TOOLS.has(name)) writeCalls += 1;
      if (name === "read" && typeof event.args?.path === "string") readPaths.push(event.args.path);
    }
    if (event.type === "compaction_end") {
      const summary = typeof event.result?.summary === "string" ? event.result.summary : null;
      compactions.push({
        reason: event.reason ?? null,
        aborted: event.aborted === true,
        tokensBefore: Number.isFinite(event.result?.tokensBefore) ? event.result.tokensBefore : null,
        estimatedTokensAfter: Number.isFinite(event.result?.estimatedTokensAfter) ? event.result.estimatedTokensAfter : null,
        summarySha256: summary === null ? null : createHash("sha256").update(summary).digest("hex"),
        summaryBytes: summary === null ? null : Buffer.byteLength(summary),
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : null,
      });
    }
    if (event.type === "message_end" && event.message?.role === "assistant") assistant.push(event.message);
    else if (event.type === "turn_end" && event.message?.role === "assistant") turnEnds.push(event.message);
    if (event.type === "toolCall" || event.type === "tool_call") toolCalls += 1;
  }
  const authoritative = assistant.length > 0 ? assistant : turnEnds;
  const finalMessage = authoritative.at(-1) ?? null;
  const textParts = [];
  for (const message of authoritative) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === "text" && typeof part.text === "string") textParts.push(part.text);
  }
  // Sum of per-response usage. Input is re-counted on every response because
  // each request resends the context; it is not unique prompt tokens.
  const cumulativeUsage = { assistantMessages: authoritative.length, input: 0, output: 0, reasoning: null, totalTokens: 0 };
  for (const message of authoritative) {
    const usage = message.usage ?? {};
    for (const key of ["input", "output", "totalTokens"]) if (Number.isFinite(usage[key])) cumulativeUsage[key] += usage[key];
    if (Number.isFinite(usage.reasoning)) cumulativeUsage.reasoning = (cumulativeUsage.reasoning ?? 0) + usage.reasoning;
  }
  let claims = textParts.join("\n\n");
  let truncated = false;
  if (Buffer.byteLength(claims) > MAX_CLAIM_BYTES) {
    claims = claims.slice(0, MAX_CLAIM_BYTES);
    truncated = true;
  }
  const stopReason = finalMessage?.stopReason ?? finalMessage?.rawStopReason ?? null;
  const errorMessage = finalMessage?.errorMessage ?? finalMessage?.error?.message ?? null;
  return { assistant: authoritative, finalMessage, stopReason, errorMessage, usage: finalMessage?.usage ?? null, toolCalls, writeCalls, toolCallsByName, readPaths, compactions, cumulativeUsage, claims, claimsTruncated: truncated };
}

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The child already exited.
    }
  }
}

async function captureProcess({ command, args, cwd, env, stdoutPath, stderrPath, timeoutMs, maxToolCalls, firstWriteMs = null, direct, pipeOutput = false, signal, checkChannel }) {
  const stdoutHandle = await (await import("node:fs/promises")).open(stdoutPath, "w");
  const stderrHandle = await (await import("node:fs/promises")).open(stderrPath, "w");
  const startedAt = Date.now();
  checkChannel?.start(timeoutMs);
  let child;
  let spawnError = null;
  let forcedOutcome = null;
  let pollBusy = false;
  let pollTimer;
  let timeoutTimer;
  let killTimer;
  let latest = { bytes: 0, toolCalls: 0 };
  let firstWriteAtMs = null;
  let closed = false;
  let stopRequested = false;
  let stoppedBeforeSpawn = false;
  const outputPipes = [];
  const stop = (reason) => {
    if (forcedOutcome) return;
    forcedOutcome = reason;
    checkChannel?.cancel();
    killProcessGroup(child?.pid, "SIGTERM");
    killTimer = setTimeout(() => killProcessGroup(child?.pid, "SIGKILL"), 250);
    killTimer.unref?.();
  };
  const onAbort = () => {
    stopRequested = true;
    stop("stopped");
  };
  if (signal?.aborted) {
    // Stopped before Pi started: spawn nothing, but still finalize the run.
    stopRequested = true;
    stoppedBeforeSpawn = true;
    checkChannel?.cancel();
    forcedOutcome = "stopped";
  } else {
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", pipeOutput ? "pipe" : stdoutHandle.fd, pipeOutput ? "pipe" : stderrHandle.fd],
      });
      if (pipeOutput) {
        for (const [stream, handle] of [[child.stdout, stdoutHandle], [child.stderr, stderrHandle]]) {
          outputPipes.push(pipeline(stream, async (chunks) => {
            for await (const chunk of chunks) await handle.writeFile(chunk);
          }).catch(() => {
            spawnError ??= "Cannot retain sandboxed Pi output";
            killProcessGroup(child.pid, "SIGTERM");
          }));
        }
      }
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  const closePromise = new Promise((resolvePromise) => {
    if (!child) return resolvePromise({ code: null, signal: null });
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const poll = async () => {
    if (pollBusy || !child) return;
    pollBusy = true;
    try {
      try { checkChannel?.poll(); } catch { stop("failed"); }
      const [outInfo, errInfo] = await Promise.all([stat(stdoutPath), stat(stderrPath)]);
      latest.bytes = outInfo.size + errInfo.size;
      if (latest.bytes > MAX_RAW_OUTPUT_BYTES) stop("raw_output_limit");
      const text = await readFile(stdoutPath, "utf8");
      const parsedNow = parseEvents(text);
      latest.toolCalls = parsedNow.toolCalls;
      if (latest.toolCalls >= maxToolCalls) stop("tool_limit");
      // Poll-granular (100 ms): when the first write/edit start was seen.
      if (firstWriteAtMs === null && parsedNow.writeCalls > 0) firstWriteAtMs = Date.now() - startedAt;
      // A worker that ended on its own is classified from its own stop reason.
      if (!closed && firstWriteMs !== null && firstWriteAtMs === null && Date.now() - startedAt >= firstWriteMs) stop("no_progress");
    } catch {
      // The files remain authoritative after process close; transient stat
      // failures are classified from the final capture below.
    } finally {
      pollBusy = false;
    }
  };
  if (child) {
    pollTimer = setInterval(() => void poll(), 100);
    pollTimer.unref?.();
    timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
    timeoutTimer.unref?.();
  }
  const termination = await closePromise;
  await Promise.all(outputPipes);
  closed = true;
  signal?.removeEventListener("abort", onAbort);
  if (pollTimer) clearInterval(pollTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (killTimer) clearTimeout(killTimer);
  checkChannel?.cancel();
  await poll();
  await checkChannel?.drain();
  await stdoutHandle.close();
  await stderrHandle.close();
  const stdout = await readFile(stdoutPath, "utf8");
  const stderr = await readFile(stderrPath, "utf8");
  const parsed = parseEvents(stdout);
  const bytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  const reason = forcedOutcome || (bytes > MAX_RAW_OUTPUT_BYTES ? "raw_output_limit" : parsed.toolCalls >= maxToolCalls ? "tool_limit" : null);
  return {
    stdout,
    stderr,
    parsed,
    processTermination: {
      exitCode: termination.code,
      signal: termination.signal,
      spawnError,
      elapsedMs: Date.now() - startedAt,
      directTestRuntime: direct === true,
      stopRequested,
      ...(stoppedBeforeSpawn ? { stoppedBeforeSpawn } : {}),
    },
    firstWriteAtMs,
    forcedOutcome: reason,
    rawBytes: bytes,
  };
}

async function runGitDiff(beforeRoot, afterRoot, patchPath, cwd) {
  const beforeArg = cwd ? relative(cwd, beforeRoot) : beforeRoot;
  const afterArg = cwd ? relative(cwd, afterRoot) : afterRoot;
  const child = spawn("git", ["diff", "--no-index", "--binary", "--no-color", "--no-prefix", "--", beforeArg, afterArg], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  const collect = (stream, isOut) => new Promise((resolvePromise) => {
    stream.on("data", (chunk) => {
      if (!isOut || overflow) return;
      bytes += chunk.length;
      if (bytes <= MAX_PATCH_BYTES) chunks.push(chunk);
      else overflow = true;
    });
    stream.on("end", resolvePromise);
  });
  const stdoutDone = collect(child.stdout, true);
  const stderrDone = collect(child.stderr, false);
  const termination = await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish({ code: null, signal: "SIGKILL", timedOut: true });
    }, 10_000);
    timer.unref?.();
    child.once("error", (error) => finish({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
  await Promise.all([stdoutDone, stderrDone]);
  const text = overflow ? "" : Buffer.concat(chunks).toString("utf8");
  await writeFile(patchPath, text, { mode: 0o600 });
  return { available: !overflow && !termination.error && !termination.timedOut && (termination.code === 0 || termination.code === 1), portable: true, exitCode: termination.code, signal: termination.signal, error: termination.error ?? null, truncated: overflow };
}

async function runGitApplyCheck(patchPath, cwd) {
  const patchInfo = await stat(patchPath);
  if (patchInfo.size === 0) return { checked: true, pass: true, empty: true, exitCode: 0, signal: null, diagnostic: null };
  const child = spawn("git", ["apply", "--check", "--", patchPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr) < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - Buffer.byteLength(stderr));
  });
  child.stdout.resume();
  const termination = await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish({ code: null, signal: "SIGKILL", error: "git apply check timed out" });
    }, 10_000);
    timer.unref?.();
    child.once("error", (error) => finish({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
  return { checked: true, pass: termination.code === 0 && !termination.error, exitCode: termination.code, signal: termination.signal, diagnostic: termination.code === 0 ? null : (termination.error ?? stderr.trim().slice(0, 1024)) };
}

async function createArtifactDir(projectRoot, runId) {
  const control = join(projectRoot, ".tinysdd");
  const runs = join(control, "runs");
  for (const path of [control, runs]) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(`Worker artifact path is not a real directory: ${path}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
  }
  const dir = join(runs, runId);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function classifyOutcome(capture) {
  if (capture.forcedOutcome) return capture.forcedOutcome;
  if (capture.parsed.stopReason === "length" || capture.parsed.stopReason === "max_tokens") return "response_token_limit";
  if (capture.parsed.stopReason === "error" || capture.parsed.errorMessage) return "failed";
  if (capture.processTermination.spawnError || capture.processTermination.exitCode !== 0) return "failed";
  if (["stop", "completed", "end_turn"].includes(capture.parsed.stopReason)) return "completed";
  return "failed";
}

function outcomeLimitDetails(outcome, capture, metadata, limits) {
  if (outcome === "response_token_limit") {
    const usage = capture.parsed.usage ?? {};
    return {
      maxTokens: metadata.maxTokens ?? PI_DEFAULT_MAX_TOKENS,
      maxTokensSource: metadata.maxTokens === null ? "pi-default" : "model",
      outputTokens: Number.isFinite(usage.output) ? usage.output : null,
      reasoningTokens: Number.isFinite(usage.reasoning) ? usage.reasoning : null,
    };
  }
  if (outcome === "raw_output_limit") return { maxRawOutputBytes: MAX_RAW_OUTPUT_BYTES, rawOutputBytes: capture.rawBytes };
  if (outcome === "tool_limit") return { maxToolCalls: limits.maxToolCalls, toolCalls: capture.parsed.toolCalls };
  if (outcome === "timeout") return { timeoutMs: limits.timeoutMs, elapsedMs: capture.processTermination.elapsedMs };
  if (outcome === "no_progress") return { firstWriteMs: limits.firstWriteMs, elapsedMs: capture.processTermination.elapsedMs, toolCalls: capture.parsed.toolCalls };
  if (outcome === "stopped") return { elapsedMs: capture.processTermination.elapsedMs, toolCalls: capture.parsed.toolCalls };
  return null;
}

function workspaceRelativeRead(path, workspace) {
  for (const prefix of [`${workspace}/`, "/work/"]) if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path.replace(/^(?:\.\/)+/u, "");
}

// Reads are measured, not blocked: the worker contract asks the model not to
// re-read cited excerpts, and this makes compliance visible per run.
function readObservations(readPaths, workspace, compiledContext) {
  const counts = {};
  for (const path of readPaths) {
    const rel = workspaceRelativeRead(path, workspace);
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
  const cited = new Set((compiledContext?.resources ?? []).map((resource) => resource.path));
  const citedRereads = Object.entries(counts).filter(([path]) => cited.has(path)).reduce((sum, [, count]) => sum + count, 0);
  const repeatedReads = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1));
  return { reads: readPaths.length, citedRereads, repeatedReads };
}

async function resolveBrief(projectRoot, packet) {
  if (packet.briefText !== undefined) {
    const sha256 = createHash("sha256").update(packet.briefText).digest("hex");
    if (packet.briefSha256 && packet.briefSha256 !== sha256) fail("packet brief digest does not match supplied text");
    return {
      text: packet.briefText,
      resource: { path: packet.briefPath ?? "<resolved-brief>", text: packet.briefText, sha256, bytes: Buffer.byteLength(packet.briefText) },
    };
  }
  if (!packet.briefPath) fail("packet must include resolved brief text or a project-relative brief path");
  const resource = await readTextResource(projectRoot, packet.briefPath, "packet brief", { controllerArtifactPrefix: CONTROLLER_TASKS_PREFIX });
  if (packet.briefSha256 && packet.briefSha256 !== resource.sha256) fail("packet brief digest does not match source file");
  return { text: resource.text, resource };
}

async function resolveReview(projectRoot, review) {
  if (!review) return null;
  let evidence;
  if (review.evidence.text !== undefined) {
    evidence = {
      path: review.evidence.path ?? "<inline-review-evidence>",
      text: review.evidence.text,
      sha256: createHash("sha256").update(review.evidence.text).digest("hex"),
      bytes: Buffer.byteLength(review.evidence.text),
    };
  } else {
    evidence = await readTextResource(projectRoot, review.evidence.path, "packet review evidence", { controllerArtifactPrefix: CONTROLLER_REVIEWS_PREFIX });
  }
  if (review.evidence.sha256 && review.evidence.sha256 !== evidence.sha256) fail("packet review evidence digest does not match supplied text");
  if (evidence.bytes > MAX_RESOURCE_BYTES) fail("packet review evidence exceeds the bounded resource size");
  return { ...review, evidence };
}

function runtimeMetadata(prepared, runtime, pi, bwrap, worker, profile, piVersion, runChecks) {
  return {
    schemaVersion: 1,
    adapter: "pi",
    sandbox: runtime.test ? "test-runtime" : runtime.sandbox ?? "bubblewrap",
    sandboxRequired: true,
    provider: worker.provider,
    model: worker.model,
    piExecutable: runtime.test ? "test-harness" : pi.path,
    piVersion,
    bubblewrap: bwrap?.path ?? null,
    ...(runtime.sandbox === "seatbelt" ? { sandboxExec: runtime.sandboxExec.path } : {}),
    // `thinking` is the requested level; effectiveThinkingControl says whether
    // Pi will actually send a thinking parameter for it (talon run 2 recorded
    // "off" while no toggle was sent and the model thought anyway).
    thinking: profile?.runtime?.thinking ?? "off",
    effectiveThinkingControl: prepared.metadata.preflight.thinking.control,
    effectiveThinkingReason: prepared.metadata.preflight.thinking.reason,
    effectiveMaxTokens: prepared.metadata.preflight.maxTokens.value,
    maxTokensSource: prepared.metadata.preflight.maxTokens.source,
    thinkingTokenBudgetField: prepared.metadata.preflight.thinkingTokenBudgetField,
    effectiveThinkingBudget: prepared.metadata.preflight.thinkingBudget,
    preflight: { basis: prepared.metadata.preflight.basis, warnings: prepared.metadata.preflight.warnings },
    reasoningRequested: profile?.runtime?.reasoning ?? null,
    rawReasoning: prepared.metadata.rawReasoning,
    effectiveReasoning: prepared.metadata.effectiveReasoning,
    rawProviderCompat: prepared.metadata.rawProviderCompat,
    rawModelCompat: prepared.metadata.rawModelCompat,
    rawCompat: prepared.metadata.rawCompat,
    effectiveCompat: prepared.metadata.effectiveCompat,
    profileId: prepared.metadata.profileId,
    runChecks,
    capabilities: {
      tools: ["read", "write", "edit", ...(runChecks?.available ? ["run_checks"] : [])],
      extensions: runChecks?.available ? ["run-checks.mjs"] : false,
      globalSkills: false,
      contextFiles: false,
      generatedCodeExecution: false,
      inferenceNetwork: true,
    },
    limits: prepared.metadata ? { timeoutMs: prepared.metadata.timeoutMs, maxToolCalls: prepared.metadata.maxToolCalls, maxCheckRuns: prepared.metadata.maxCheckRuns, firstWriteMs: prepared.metadata.firstWriteMs, maxRawOutputBytes: MAX_RAW_OUTPUT_BYTES } : null,
    accounting: {
      maxToolCallsIncludesRunChecks: true,
      firstWriteMsIncludesRunChecks: false,
      maxCheckRunsPerExecutedCheck: true,
      allChecksChargesEachCheck: true,
      checkTimeCountsTowardTimeoutMs: true,
    },
    credentialEnvironmentNames: prepared.metadata.credentialEnvironmentNames,
    generatedCredentialReferenceCount: prepared.metadata.generatedCredentialReferenceCount,
  };
}

/**
 * Execute one approved TinySDD packet through the Pi worker adapter.
 *
 * The optional `runtime` member is test-only and is rejected unless the test
 * harness explicitly enables it.  Production callers use the four documented
 * arguments and therefore require Linux bubblewrap or macOS Seatbelt.
 */
export async function runWorker({ projectRoot, packet, worker, profile, runtime, baseRunId, baselineRunId, signal } = {}) {
  const { absolute: sourceRoot } = await ensureRoot(projectRoot);
  const tempRoot = await temporaryRoot();
  const normalizedPacket = normalizePacket(packet);
  const limits = validatePiWorker(worker);
  const selectedAllowed = normalizedPacket.allowedPaths.map((path) => projectRelative(path, "packet allowed path"));
  const revisionBase = await resolveRevisionBase(sourceRoot, baseRunId, selectedAllowed, normalizedPacket.taskId);
  const frozenBaseline = await resolveFrozenBaseline(sourceRoot, baselineRunId, normalizedPacket.taskId);
  if (revisionBase && frozenBaseline) fail("baseRunId and baselineRunId cannot be combined");
  const executionSource = frozenBaseline?.root ?? sourceRoot;
  const resolvedProfile = await resolveProfile(sourceRoot, worker, profile);
  const runtimeChoice = await chooseRuntime(runtime);
  const checksDeclared = normalizedPacket.checks !== null;
  const checkAvailability = checksDeclared ? probeCheckRunner(runtimeChoice, runtime) : { available: false, reason: null, testInjected: false };
  const checkManifest = checkAvailability.available ? parseChecksManifest(normalizedPacket.checks.text) : null;
  const brief = await resolveBrief(sourceRoot, normalizedPacket);
  const review = await resolveReview(sourceRoot, normalizedPacket.review);
  let compiledContext;
  let matchedContextDigest;
  try {
    compiledContext = await compileContext(executionSource, normalizedPacket.context);
    const approvedDigest = normalizedPacket.context?.compiledSha256;
    if (approvedDigest) {
      // A replay of an approval recorded before the whole-file source digests
      // left the compiled text carries the legacy digest.
      matchedContextDigest = ["sha256", "legacySha256"].find((field) => compiledContext?.[field] === approvedDigest);
      if (!matchedContextDigest) fail("Context compiler rejected packet: selected source no longer matches the approved context digest");
    }
  } catch (error) {
    fail(`Context compiler rejected packet: ${error?.message ?? String(error)}`);
  }
  const skillPaths = validateResourceList(worker.skills, "worker.skills");
  const instructionPaths = validateResourceList(worker.instructions, "worker.instructions");
  const agents = await findApplicableAgents(executionSource, [
    ...selectedAllowed,
    ...skillPaths,
    ...instructionPaths,
    ...(brief.resource?.path?.startsWith("<") ? [] : [brief.resource?.path].filter((path) => path && !isControllerArtifactPath(path))),
    ...(review?.evidence.path?.startsWith("<") ? [] : [review?.evidence.path].filter((path) => path && !isControllerArtifactPath(path))),
  ]);
  const skills = [];
  for (const path of skillPaths) skills.push(await readTextResource(sourceRoot, path, "worker skill"));
  const instructions = [];
  for (const path of instructionPaths) instructions.push(await readTextResource(sourceRoot, path, "worker instruction"));
  const builtInPrompt = await optionalProductPrompt();
  const prompt = buildPrompt({ packet: { ...normalizedPacket, briefText: brief.text }, profile: resolvedProfile.value, review, compiledContext, agents, skills, instructions, builtInPrompt });
  const inlineProfileResource = resolvedProfile.resource || (resolvedProfile.value ? { path: "<inline-profile>", text: JSON.stringify(resolvedProfile.value) } : null);
  const contextResources = [brief.resource, inlineProfileResource, builtInPrompt, review?.evidence, ...agents, ...skills, ...instructions].filter(Boolean).map(({ text, ...digest }) => ({ ...digest, sha256: digest.sha256 ?? createHash("sha256").update(text).digest("hex"), bytes: digest.bytes ?? Buffer.byteLength(text) }));
  const prepared = await preparePiEnvironment({ worker, profile: resolvedProfile.value, sourceAgentDir: runtimeChoice.sourceAgentDir, sourceEnv: runtimeChoice.sourceEnv });

  const runId = `worker-${new Date().toISOString().replace(/[:.]/gu, "-")}-${Math.random().toString(16).slice(2, 10)}`;
  let artifactDir;
  let workspace;
  let baseline;
  let inferenceRelay;
  let checkChannel;
  try {
    artifactDir = await createArtifactDir(sourceRoot, runId);
    workspace = await mkdtemp(join(tempRoot, "tinysdd-worker-"));
    baseline = await mkdtemp(join(tempRoot, "tinysdd-worker-before-"));
  const beforeArtifact = join(artifactDir, "workspace-before");
  const afterArtifact = join(artifactDir, "workspace-after");
  let before;
  let after;
  let capture;
  let patchInfo;
  let result;
    const workspaceCopy = await copyProjectTree(executionSource, workspace, { useGit: !frozenBaseline });
    await assertCopiedInputs(executionSource, workspaceCopy, selectedAllowed, normalizedPacket.protectedPaths, compiledContext);
    await overlayRevisionBase(revisionBase, workspace);
    await copyRegularTree(workspace, baseline);
    before = await snapshotTree(workspace);
    await copyRegularTree(workspace, beforeArtifact);
    await writeJson(join(artifactDir, "packet.json"), normalizedPacket);
    await writeFile(join(artifactDir, "prompt.txt"), prompt.rendered, { mode: 0o600 });
    if (compiledContext) await writeFile(join(artifactDir, "compiled-context.md"), compiledContext.rendered, { mode: 0o600 });
    if (checkManifest) {
      checkChannel = await createCheckChannel({ manifest: checkManifest, sourceRoot, workspace, artifactDir, tempRoot, allowedPaths: selectedAllowed, maxCheckRuns: limits.maxCheckRuns, nodeRoot: dirname(dirname(process.execPath)), ...(runtimeChoice.test && runtime?.checkRunner ? { runner: runtime.checkRunner } : {}) });
    }
    const piPackage = await piPackageInfo(runtimeChoice.pi);
    const piVersion = piPackage.version;
    const runChecks = runChecksMetadata({ declared: checksDeclared, availability: checkAvailability, maxCheckRuns: limits.maxCheckRuns, checkChannel, baseline: frozenBaseline });
    await writeJson(join(artifactDir, "runtime.json"), runtimeMetadata(prepared, runtimeChoice, runtimeChoice.pi, runtimeChoice.bwrap, worker, resolvedProfile.value, piVersion, runChecks));
    await writeJson(join(artifactDir, "context.json"), {
      schemaVersion: 1,
      resources: contextResources,
      ...(compiledContext ? {
        compiledContext: {
          manifest: compiledContext.manifest,
          facts: compiledContext.facts,
          resources: compiledContext.resources,
          sha256: compiledContext.sha256,
          ...(matchedContextDigest ? { matchedDigest: matchedContextDigest } : {}),
          bytes: compiledContext.bytes,
        },
      } : {}),
    });
    await writeJson(join(artifactDir, "before-snapshot.json"), before);
    if (revisionBase) await writeJson(join(artifactDir, "base-run.json"), {
      id: revisionBase.id,
      paths: revisionBase.paths,
      chain: revisionBase.chain.map(({ id, paths }) => ({ id, paths })),
    });
    if (frozenBaseline) await writeJson(join(artifactDir, "baseline-run.json"), { id: frozenBaseline.id });
    const systemPromptPath = join(prepared.stateDir, "system-prompt.txt");
    await writeFile(systemPromptPath, prompt.system, { mode: 0o600 });

    const thinking = resolvedProfile.value?.runtime?.thinking ?? "off";
    const nativePaths = runtimeChoice.test || runtimeChoice.sandbox === "seatbelt";
    const promptStateDir = runtimeChoice.sandbox === "seatbelt" ? await realpath(prepared.stateDir) : prepared.stateDir;
    const sessionPath = nativePaths ? join(promptStateDir, "session.jsonl") : "/pi-state/session.jsonl";
    const userPromptPath = join(prepared.stateDir, "task-prompt.txt");
    await writeFile(userPromptPath, prompt.user, { mode: 0o600 });
    const promptArgumentPath = nativePaths ? join(promptStateDir, "task-prompt.txt") : "/pi-state/task-prompt.txt";
    const appendPromptPath = nativePaths ? join(promptStateDir, "system-prompt.txt") : "/pi-state/system-prompt.txt";
    const checkExtension = checkChannel ? (nativePaths ? checkChannel.extension : "/opt/tinysdd/run-checks.mjs") : null;
    const piArgs = buildPiArgs({ checkExtension, provider: worker.provider, model: worker.model, sessionPath, thinking, systemPromptPath: appendPromptPath, userPrompt: promptArgumentPath.startsWith("/") ? `@${promptArgumentPath}` : prompt.user });
    let command;
    let args;
    let childEnv;
    if (runtimeChoice.test) {
      command = runtimeChoice.pi.path;
      args = piArgs;
      childEnv = { ...prepared.env, HOME: prepared.env.HOME, PATH: process.env.PATH || "/usr/bin:/bin", TINYSDD_TEST_WORKSPACE: workspace };
      for (const [key, value] of Object.entries(runtime?.testEnv ?? {})) {
        if (!key.startsWith("TINYSDD_TEST_")) fail("Test runtime may only add TINYSDD_TEST_* environment values");
        childEnv[key] = String(value);
      }
    } else if (runtimeChoice.sandbox === "seatbelt") {
      if (!piPackage.root) fail("Cannot identify the installed Pi package for the macOS sandbox");
      const stateDir = await realpath(prepared.stateDir);
      const sourceAgentDir = await realpath(dirname(prepared.sourceModelsPath));
      const models = JSON.parse(await readFile(join(stateDir, "models.json"), "utf8"));
      const provider = models.providers[worker.provider];
      let sandboxProfile;
      try {
        inferenceRelay = await startInferenceRelay({ provider, model: provider.models[0], env: prepared.env });
        sandboxProfile = buildMacosSandboxProfile({ workspace, stateDir, sourceRoot, sourceAgentDir, nodeExecutable: runtimeChoice.node.resolved, piExecutable: runtimeChoice.pi.resolved, piRoot: piPackage.root, inferencePort: inferenceRelay.port });
      } catch (error) {
        fail(`Cannot prepare macOS sandbox: ${error instanceof Error ? error.message : String(error)}`);
      }
      const sandboxPath = join(artifactDir, "sandbox.sb");
      await writeFile(sandboxPath, sandboxProfile, { mode: 0o600 });
      await mkdir(join(stateDir, "home"), { mode: 0o700 });
      await mkdir(join(stateDir, "tmp"), { mode: 0o700 });
      await writeJson(join(stateDir, "models.json"), { providers: { [worker.provider]: relayPiProvider(provider, provider.models[0], inferenceRelay.baseUrl) } });
      command = runtimeChoice.sandboxExec.path;
      args = ["-f", sandboxPath, runtimeChoice.node.resolved, runtimeChoice.pi.resolved, ...piArgs];
      childEnv = { HOME: join(stateDir, "home"), TMPDIR: join(stateDir, "tmp"), PATH: dirname(runtimeChoice.node.resolved), PI_CODING_AGENT_DIR: stateDir, TINYSDD_WORKSPACE: workspace, TINYSDD_INFERENCE_TOKEN: inferenceRelay.token };
      await writeJson(join(artifactDir, "runtime.json"), { ...runtimeMetadata(prepared, runtimeChoice, runtimeChoice.pi, runtimeChoice.bwrap, worker, resolvedProfile.value, piVersion, runChecks), generatedCredentialReferenceCount: 0, sandboxProfile: sandboxPath, inferenceDestination: `localhost:${inferenceRelay.port}` });
    } else {
      const nodeRoot = dirname(dirname(runtimeChoice.pi.path));
      await existingAbsoluteDirectory(nodeRoot, "Pi installation root");
      command = runtimeChoice.bwrap.path;
      childEnv = { ...prepared.env, HOME: "/home", PATH: "/opt/node/bin:/usr/bin:/bin", PI_CODING_AGENT_DIR: "/pi-state", TINYSDD_WORKSPACE: "/work" };
      args = buildBubblewrapArgs({ workspace, stateDir: prepared.stateDir, nodeRoot, piArgs, piLexicalPath: "/opt/node/bin/pi", env: childEnv, checkChannel });
    }
    if (checkChannel) {
      childEnv.TINYSDD_CHECK_CHANNEL = nativePaths ? checkChannel.root : "/tinysdd";
      childEnv.TINYSDD_CHECK_DEADLINE = String(Date.now() + limits.timeoutMs);
    }
    capture = await captureProcess({ checkChannel, command, args, cwd: nativePaths ? workspace : sourceRoot, env: childEnv, stdoutPath: join(artifactDir, "stdout.jsonl"), stderrPath: join(artifactDir, "stderr.txt"), timeoutMs: limits.timeoutMs, maxToolCalls: limits.maxToolCalls, firstWriteMs: limits.firstWriteMs, direct: runtimeChoice.test, pipeOutput: runtimeChoice.sandbox === "seatbelt" || (runtimeChoice.test && runtime?.pipeOutput === true), signal });
    if (inferenceRelay) await inferenceRelay.close();
    inferenceRelay = null;
    after = await snapshotTree(workspace);
    await copySnapshotTree(workspace, afterArtifact);
    await writeJson(join(artifactDir, "after-snapshot.json"), after);
    const changes = changedFiles(before, after);
    patchInfo = await runGitDiff(beforeArtifact, afterArtifact, join(artifactDir, "patch.diff"), artifactDir);
    if (patchInfo.available) patchInfo.applyCheck = await runGitApplyCheck(join(artifactDir, "patch.diff"), baseline);
    const allowedSet = new Set(selectedAllowed);
    const protectedSet = new Set(normalizedPacket.protectedPaths);
    const scopeViolations = changes.filter((change) => !allowedSet.has(slash(change.path))).map((change) => ({ path: slash(change.path), change: change.change, reason: protectedSet.has(slash(change.path)) ? "protected contract file" : "changed path is outside packet.allowedPaths" }));
    const outcome = classifyOutcome(capture);
    const limitDetails = outcomeLimitDetails(outcome, capture, prepared.metadata, limits);
    const touchedAllowedPaths = new Set(changes.filter((change) => allowedSet.has(slash(change.path))).map((change) => slash(change.path)));
    result = {
      schemaVersion: 1,
      runId,
      taskId: normalizedPacket.taskId,
      runChecks,
      ...(revisionBase ? {
        baseRun: {
          id: revisionBase.id,
          paths: revisionBase.paths,
          ...(revisionBase.chain.length > 1 ? { chain: revisionBase.chain.map(({ id, paths }) => ({ id, paths })) } : {}),
        },
      } : {}),
      ...(frozenBaseline ? { baselineRun: { id: frozenBaseline.id } } : {}),
      ...(checkChannel ? { workerObservedChecks: { source: "worker run_checks", acceptanceEvidence: false, runs: checkChannel.runs } } : {}),
      taskShape: { allowedFiles: selectedAllowed.length, ...contextSizeMetrics(compiledContext) },
      workspaceCopy: { mode: workspaceCopy.mode, ...(workspaceCopy.fallbackReason ? { fallbackReason: workspaceCopy.fallbackReason } : {}), files: workspaceCopy.files, bytes: workspaceCopy.bytes, missingSkipped: workspaceCopy.missingSkipped },
      outcome,
      ...(outcome !== "completed" ? {
        candidateState: {
          allowedPaths: selectedAllowed.length,
          allowedPathsTouched: touchedAllowedPaths.size,
          untouchedPaths: selectedAllowed.filter((path) => !touchedAllowedPaths.has(path)).sort(),
        },
      } : {}),
      model: { provider: worker.provider, id: worker.model },
      observed: {
        processTermination: capture.processTermination,
        assistantTermination: { observed: Boolean(capture.parsed.finalMessage), stopReason: capture.parsed.stopReason, errorMessage: capture.parsed.errorMessage },
        usage: capture.parsed.usage,
        usageScope: "final-assistant-message",
        cumulativeUsage: capture.parsed.cumulativeUsage,
        toolCalls: capture.parsed.toolCalls,
        toolCallsByName: capture.parsed.toolCallsByName,
        writeCalls: capture.parsed.writeCalls,
        firstWriteAtMs: capture.firstWriteAtMs,
        ...readObservations(capture.parsed.readPaths, workspace, compiledContext),
        compactions: capture.parsed.compactions,
        rawOutputBytes: capture.rawBytes,
      },
      ...(limitDetails ? { limitDetails } : {}),
      changedPaths: changes,
      scopeViolations,
      artifactPaths: {
        directory: artifactDir,
        packet: join(artifactDir, "packet.json"),
        prompt: join(artifactDir, "prompt.txt"),
        runtime: join(artifactDir, "runtime.json"),
        ...(checkChannel ? { checks: checkChannel.logPath } : {}),
        context: join(artifactDir, "context.json"),
        ...(compiledContext ? { compiledContext: join(artifactDir, "compiled-context.md") } : {}),
        beforeSnapshot: join(artifactDir, "before-snapshot.json"),
        afterSnapshot: join(artifactDir, "after-snapshot.json"),
        stdout: join(artifactDir, "stdout.jsonl"),
        stderr: join(artifactDir, "stderr.txt"),
        patch: join(artifactDir, "patch.diff"),
        workspaceBefore: beforeArtifact,
        workspaceAfter: afterArtifact,
        candidate: afterArtifact,
      },
      patch: patchInfo,
      modelClaims: { observed: Boolean(capture.parsed.claims), source: "unverified assistant text in raw Pi events", unverified: true, text: capture.parsed.claims, truncated: capture.parsed.claimsTruncated },
      warnings: ["Raw Pi events may contain source code. Worker output is not acceptance or verification evidence.", ...(runChecks.declared && !runChecks.available ? [`run_checks unavailable: ${runChecks.reason}`] : []), ...prepared.metadata.preflight.warnings.map((warning) => `Preflight: ${warning}`), ...(capture.parsed.compactions.some((entry) => !entry.aborted && entry.summarySha256) ? ["Pi compacted the worker context: later turns saw a model-written summary instead of earlier messages, possibly including the approved packet."] : []), ...(runtimeChoice.test ? ["Test runtime bypassed the OS sandbox; production execution remains fail-closed."] : []), ...(patchInfo.available ? [] : ["git diff --no-index did not produce a complete patch artifact."]), ...(patchInfo.applyCheck && !patchInfo.applyCheck.pass ? ["git apply --check did not validate the portable patch against the frozen candidate snapshot."] : [])],
    };
    await writeJson(join(artifactDir, "result.json"), result);
    return result;
  } finally {
    if (inferenceRelay) await inferenceRelay.close().catch(() => {});
    if (checkChannel) await checkChannel.cleanup().catch(() => {});
    await prepared.cleanup().catch(() => {});
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    if (baseline) await rm(baseline, { recursive: true, force: true }).catch(() => {});
  }
}

export const workerLimits = Object.freeze({ DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TOOL_LIMIT, MAX_TOOL_LIMIT, MAX_RAW_OUTPUT_BYTES });
