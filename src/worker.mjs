import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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
import { digestJson, stableStringify as fsStableStringify } from "./fs-utils.mjs";
import { DEFAULT_RUNTIME_SCOPE, classifyFileScopeChange, detectFilesystemAliases, observedPathError, preparationPaths } from "./file-scope.mjs";
import {
  COMPACTION_ANCHOR_ENV,
  compactionIdentity,
  normalizeCompactionProfile,
  writeCompactionBundle,
} from "./compaction-runtime.mjs";
import { createApprovedPacketAnchor, stableStringify as compactionStableStringify } from "./deterministic-compaction.mjs";

const MAX_RAW_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_USER_PROMPT_BYTES = 128 * 1024;
const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;
const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const MAX_CLAIM_BYTES = 128 * 1024;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const SAFE_TASK_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_RUN_ID = /^worker-[0-9A-Za-z-]+$/u;
const CONTROLLER_TASKS_PREFIX = ".tinysdd/tasks/";
const CONTROLLER_REVIEWS_PREFIX = ".tinysdd/reviews/";
const PROJECT_SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const PROJECT_SECRET_DIR = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;
const PRODUCT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WORKER_GUIDANCE = `You are a TinySDD implementation worker. Use only the supplied read, write and edit tools in the disposable workspace. Do not execute commands, tests, package managers, shells, network clients or services. Implement exactly the approved task packet, preserve unrelated behavior and assertions, and hand back changed paths plus unrun verification notes. A model completion is not acceptance or test evidence.`;
const UNKNOWN = "UNKNOWN";

export class WorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "WorkerError";
    if (options.code !== undefined) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
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
  // macOS and Linux temp roots may traverse host aliases before the worker creates scratch.
  const override = process.env.TINYSDD_TMPDIR;
  const ambient = process.env.TMPDIR ?? "/tmp";
  const requestedValue = override ?? ambient;
  if (typeof requestedValue !== "string" || requestedValue.length === 0) fail("TINYSDD_TMPDIR must name an existing directory");
  let requested = requestedValue;
  if (override === undefined && (process.platform === "darwin" || process.platform === "linux")) {
    try {
      requested = await realpath(requestedValue);
    } catch (error) {
      fail(`TinySDD temporary directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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

async function assertCopiedInputs(sourceRoot, copy, allowedPaths, protectedPaths, preparation, compiledContext) {
  for (const path of protectedPaths) {
    if (!copy.copied.has(path)) fail(`Protected path is not part of the worker copy (missing, gitignored or excluded): ${path}`);
  }
  for (const resource of compiledContext?.resources ?? []) {
    if (!copy.copied.has(resource.path)) fail(`Context resource is not part of the worker copy (gitignored or excluded): ${resource.path}`);
  }
  for (const entry of preparation) {
    if (entry.exists === false) continue;
    if (copy.copied.has(entry.path)) continue;
    let info;
    try {
      info = await lstat(join(sourceRoot, ...entry.path.split("/")));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    if (info.isFile()) fail(`Preparation path is not part of the worker copy (gitignored or excluded): ${entry.path}`);
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

function normalizePreparation(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("packet.preparation must be an array");
  const seen = new Set();
  return value.map((entry) => {
    if (typeof entry === "string") entry = { path: entry };
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string") fail("packet.preparation entries must contain a path");
    const path = projectRelative(entry.path, "packet preparation path", CONTROLLER_TASKS_PREFIX);
    if (seen.has(path)) fail("packet.preparation must not contain duplicate paths");
    seen.add(path);
    if (entry.exists !== undefined && typeof entry.exists !== "boolean") fail("packet.preparation.exists must be boolean");
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256))) fail("packet.preparation.sha256 must be a SHA-256 digest");
    if (entry.bytes !== undefined && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) fail("packet.preparation.bytes must be a nonnegative safe integer");
    return { path, ...(entry.exists === undefined ? {} : { exists: entry.exists }), ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }), ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRuntimeScope(value) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) fail("packet.runtimeScope must be an object");
  const scope = value ?? DEFAULT_RUNTIME_SCOPE;
  if (scope.mode !== DEFAULT_RUNTIME_SCOPE.mode || scope.ordinaryCreateModify !== true || scope.deletions !== false) {
    fail("packet.runtimeScope must use the ordinary-create-modify default");
  }
  return { ...DEFAULT_RUNTIME_SCOPE };
}

function taskInputPaths(packet) {
  return [packet.briefPath, packet.context?.path, packet.checks?.path].filter((path) => typeof path === "string");
}

async function assertPreparationIdentity(projectRoot, preparation) {
  for (const entry of preparation) {
    const resource = await ensureProjectPath(projectRoot, entry.path, {
      allowMissing: true,
      controllerArtifactPrefix: entry.path.startsWith('.tinysdd/') ? '.tinysdd/tasks/' : null,
    });
    if (!resource.exists) {
      if (entry.exists === true) fail(`Preparation path is missing: ${entry.path}`);
      continue;
    }
    const info = await lstat(resource.path);
    if (!info.isFile()) fail(`Preparation path is not a regular file: ${entry.path}`);
    if (entry.exists === false) fail(`Preparation absence is no longer current: ${entry.path}`);
    if (entry.sha256 !== undefined && entry.sha256 !== await hashFile(resource.path)) fail(`Preparation path changed since approval: ${entry.path}`);
    if (entry.bytes !== undefined && entry.bytes !== info.size) fail(`Preparation path size changed since approval: ${entry.path}`);
  }
}

async function readOptionalRuntime(runDirectory) {
  try {
    const runtimePath = join(runDirectory, "runtime.json");
    const runtimeInfo = await lstat(runtimePath);
    if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isFile() || runtimeInfo.size > MAX_RESOURCE_BYTES) return null;
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    return runtime && typeof runtime === "object" && !Array.isArray(runtime) ? runtime : null;
  } catch {
    return null;
  }
}

async function readRetainedSnapshot(runDirectory, name) {
  const path = join(runDirectory, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    fail(`base run is missing retained ${name}: ${error?.code === "ENOENT" ? "file not found" : "cannot read file"}`);
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_COPY_BYTES) fail(`base run ${name} is not a bounded regular file`);
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`base run ${name} is malformed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > MAX_COPY_FILES) fail(`base run ${name} is not a bounded snapshot object`);
  return value;
}

async function resolveRevisionBase(projectRoot, baseRunId, allowedPaths, taskId, { protectedPaths = [], inputPaths = [], preparation = [], dependencyMounts = [], caseInsensitive = null, unicodeInsensitive = null, filesystemAliases = null } = {}) {
  if (baseRunId === undefined || baseRunId === null) return null;
  if (typeof baseRunId !== "string" || !SAFE_RUN_ID.test(baseRunId)) fail("baseRunId must name a TinySDD worker run");
  const preparationSet = new Set(preparationPaths(preparation));
  const seen = new Set();
  const chain = [];
  let immediateRuntime = null;
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
    if (result.taskId !== taskId) fail("base run lineage belongs to a different task");
    if (currentId === baseRunId) immediateRuntime = await readOptionalRuntime(runDirectory);
    const beforeWorkspace = join(runDirectory, "workspace-before");
    const afterWorkspace = join(runDirectory, "workspace-after");
    const beforeInfo = await lstat(beforeWorkspace).catch((error) => error?.code === "ENOENT" ? null : (() => { throw error; })());
    const afterInfo = await lstat(afterWorkspace).catch((error) => error?.code === "ENOENT" ? null : (() => { throw error; })());
    if (!beforeInfo?.isDirectory() || beforeInfo.isSymbolicLink() || !afterInfo?.isDirectory() || afterInfo.isSymbolicLink()) fail("base run lacks retained before/after workspace evidence");
    const beforeSnapshot = await snapshotTree(beforeWorkspace);
    const afterSnapshot = await snapshotTree(afterWorkspace);
    if (fsStableStringify(await readRetainedSnapshot(runDirectory, "before-snapshot.json")) !== fsStableStringify(beforeSnapshot)
      || fsStableStringify(await readRetainedSnapshot(runDirectory, "after-snapshot.json")) !== fsStableStringify(afterSnapshot)) {
      fail("base run retained snapshots do not match its workspace evidence");
    }
    const changes = changedFiles(beforeSnapshot, afterSnapshot);
    const retainedShape = changes.map(({ path, change }) => ({ path, change })).sort((left, right) => left.path.localeCompare(right.path));
    const claimedShape = result.changedPaths.map(({ path, change }) => ({ path, change })).sort((left, right) => left.path.localeCompare(right.path));
    if (fsStableStringify(retainedShape) !== fsStableStringify(claimedShape)) fail("base run changedPaths do not match retained workspace evidence");
    const retainedIdentity = [...changes].sort((left, right) => left.path.localeCompare(right.path));
    const claimedIdentity = [...result.changedPaths].sort((left, right) => left.path.localeCompare(right.path));
    if (fsStableStringify(retainedIdentity) !== fsStableStringify(claimedIdentity)) fail("base run changed path identities do not match retained workspace evidence");
    if (!result.fileScope || result.fileScope.mode !== "ordinary-create-modify" || result.fileScope.ordinaryCreateModify !== true || result.fileScope.deletions !== false || !Array.isArray(result.fileScope.actualPaths)) fail("base run lacks complete file-scope evidence");
    if (result.fileScope.actualPaths.some((path) => typeof path !== "string" || observedPathError(path)) || new Set(result.fileScope.actualPaths).size !== result.fileScope.actualPaths.length) fail("base run file-scope paths are not a unique canonical inventory");
    if (fsStableStringify(result.fileScope.actualPaths.slice().sort()) !== fsStableStringify(changes.map(({ path }) => path).sort())) fail("base run file-scope paths do not match retained workspace evidence");
    const paths = changes.map((change) => {
      if (!change || typeof change.path !== "string" || !["created", "modified"].includes(change.change)) fail("base run contains an unsupported change");
      const path = projectRelative(change.path, "base run changed path");
      const violation = classifyFileScopeChange({ ...change, path }, { protectedPaths, inputPaths, preparationPaths: [...preparationSet], dependencyMounts, caseInsensitive, unicodeInsensitive, filesystemAliases });
      if (violation) fail(`base run contains an ineligible change: ${path} (${violation.reason})`);
      if (change.after?.kind !== "file") fail(`base run changed path is not a regular file: ${path}`);
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
  return { id: baseRunId, chain, paths, runtime: immediateRuntime };
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
    const runtime = await readOptionalRuntime(runDirectory);
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

async function hashFile(path, maxBytes = Number.POSITIVE_INFINITY) {
  return (await hashFileBounded(path, maxBytes)).sha256;
}

async function hashFileBounded(path, maxBytes = Number.POSITIVE_INFINITY, expectedInfo = null) {
  const hash = createHash("sha256");
  let handle;
  let bytes = 0;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || (expectedInfo && (opened.ino !== expectedInfo.ino || opened.dev !== expectedInfo.dev))) {
      throw new WorkerError("file changed or is not a regular file");
    }
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw new WorkerError("file exceeds the bounded hash size");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function retainSessionArtifact(sourcePath, destinationPath) {
  let handle;
  try {
    handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return { available: false, reason: "not_regular" };
    if (info.size > MAX_SESSION_BYTES) return { available: false, reason: "oversize", bytes: info.size, limit: MAX_SESSION_BYTES };
    const buffer = Buffer.allocUnsafe(MAX_SESSION_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_SESSION_BYTES) return { available: false, reason: "oversize", bytes: bytesRead, limit: MAX_SESSION_BYTES };
    const bytes = buffer.subarray(0, bytesRead);
    await writeFile(destinationPath, bytes, { mode: 0o600, flag: "wx" });
    return { available: true, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, reason: "not_written" };
    if (error?.code === "ELOOP") return { available: false, reason: "symlink" };
    if (error?.code === "EFBIG") return { available: false, reason: "oversize", limit: MAX_SESSION_BYTES };
    return { available: false, reason: "read_failed" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function snapshotTree(root) {
  const output = Object.create(null);
  let entriesSeen = 0;
  let bytesSeen = 0;
  async function visit(current, relativePath) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (++entriesSeen > MAX_COPY_FILES) fail("Worker snapshot exceeds the entry limit");
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        output[rel] = { kind: "symlink", sha256: null, size: null };
      } else if (info.isDirectory()) {
        output[rel] = { kind: "directory", sha256: null, size: null };
        await visit(path, rel);
      } else if (info.isFile()) {
        if (info.size > MAX_COPY_BYTES || bytesSeen > MAX_COPY_BYTES - info.size) fail("Worker snapshot exceeds the byte limit");
        const hashed = await hashFileBounded(path, MAX_COPY_BYTES - bytesSeen, info);
        bytesSeen += hashed.bytes;
        output[rel] = { kind: "file", sha256: hashed.sha256, size: hashed.bytes };
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
  const beforeDescendants = new Set();
  const afterDescendants = new Set();
  for (const path of Object.keys(before)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) beforeDescendants.add(parts.slice(0, index).join("/"));
  }
  for (const path of Object.keys(after)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) afterDescendants.add(parts.slice(0, index).join("/"));
  }
  return paths.flatMap((path) => {
    const oldValue = before[path];
    const newValue = after[path];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
    // Directory entries are retained so replacing an empty directory with a
    // file is a type change. Directory creation/removal used as scaffolding
    // for changed files is not itself an applicable file change.
    if (!oldValue && newValue?.kind === "directory" && afterDescendants.has(path)) return [];
    if (!newValue && oldValue?.kind === "directory" && beforeDescendants.has(path)) return [];
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
    const allowed = new Set(["thinking", "reasoning", "compat", "thinkingBudgets", "compaction"]);
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
    if (value.runtime.compaction !== undefined) {
      try {
        normalizeCompactionProfile(value.runtime);
      } catch (error) {
        fail(error?.message ?? "Worker profile.runtime.compaction is invalid");
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
  const preparation = normalizePreparation(packet.preparation);
  const runtimeScope = normalizeRuntimeScope(packet.runtimeScope);
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
    runtimeScope,
    allowedPaths: normalizedAllowed,
    protectedPaths: normalizedProtected,
    ...(preparation.length > 0 ? { preparation } : {}),
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

function buildPrompt({ packet, profile, review, compiledContext, agents, skills, instructions, builtInPrompt, checkAvailability, checkManifest }) {
  const systemSections = [builtInPrompt?.text || DEFAULT_WORKER_GUIDANCE];
  const runChecksAvailable = checkAvailability?.available === true && checkManifest !== null && checkManifest !== undefined;
  const contract = runChecksAvailable
    ? "You are operating in a disposable candidate workspace. Read, write and edit only, plus the named `run_checks` host tool for the declared checks. Do not run commands, shells, package managers, network clients or services, or use any other execution tool. Do not inspect outside the workspace or invent missing requirements. Implement only this approved packet and preserve unrelated files and assertions. Ordinary project file creation and modification is permitted by default when it stays within the protected boundaries below. Do not delete files or replace filesystem types. After each written or edited allowed file, call `run_checks`; do the same after each other ordinary file edit, fix reported failures within the approved scope, and do not simulate checks in reasoning. Stop and report when the declared check budget is exhausted or the next fix needs missing information or permission. Tool output is worker-observed host-check evidence, never operator verification or acceptance. In the final handoff, name observed checks separately from checks still unrun."
    : "You are operating in a disposable candidate workspace. Read, write and edit only. Do not run commands, tests, shells, package managers, network clients or services. Do not inspect outside the workspace or invent missing requirements. Implement only this approved packet and preserve unrelated files and assertions. Ordinary project file creation and modification is permitted by default when it stays within the protected boundaries below. Do not delete files or replace filesystem types. The caller performs all verification separately; report checks as unrun unless the packet itself supplies observed evidence.";
  systemSections.push(`\n\n## TinySDD worker contract\n${contract}\n\nRuntime file scope (fixed): ${packet.runtimeScope.mode}; ordinaryCreateModify=${packet.runtimeScope.ordinaryCreateModify}; deletions=${packet.runtimeScope.deletions}.\nExpected paths (advisory context only):\n${packet.allowedPaths.map((path) => `- ${path}`).join("\n")}`);
  if (packet.protectedPaths.length > 0) systemSections.push(`\n\n## Protected contract files (read-only)\nRead these files; never write, edit, create, delete or rename them. A change is reported as a scope violation.\n${packet.protectedPaths.map((path) => `- ${path}`).join("\n")}`);
  if ((packet.preparation ?? []).length > 0) systemSections.push(`\n\n## Immutable preparation inputs (read-only)\nDo not create, write, edit, delete or rename these approved preparation paths. A change is reported as a scope violation.\n${packet.preparation.map((entry) => `- ${entry.path}${entry.exists === false ? " (approved absent)" : ""}`).join("\n")}`);
  if (runChecksAvailable && (checkManifest?.dependencyMounts ?? []).length > 0) systemSections.push(`\n\n## Dependency mounts (read-only)\nDo not create, write, edit, delete or rename files under these declared dependency mounts. A change is reported as a scope violation.\n${checkManifest.dependencyMounts.map((path) => `- ${path}`).join("\n")}`);
  if (profile?.instructions) systemSections.push(`\n\n## Model profile guidance\n${profile.instructions}`);
  if (compiledContext) {
    const planning = runChecksAvailable ? "" : " Start by planning the allowed-file edit.";
    systemSections.push(`\n\n## Compiled-context operating rule\nThe caller has supplied a bounded implementation context with approved facts and exact source excerpts. Treat it as the authoritative working set for the cited contracts and acceptance assertions. Do not re-read cited source files or the source specification merely to rediscover injected facts. Read uncited code only when needed for the allowed edit, or when a concrete contradiction requires escalation.${planning}`);
  }
  if (review) systemSections.push(`\n\n## Caller revision constraints\nThis is a bounded revision under the existing task approval. Do not broaden the task or reinterpret the contract. Address only the named review evidence; report any contradiction instead of inventing a requirement. Reviewer: ${review.by}\n${formatContext(review.evidence)}`);
  for (const resource of agents) systemSections.push(formatContext(resource));
  for (const resource of skills) systemSections.push(formatContext(resource));
  for (const resource of instructions) systemSections.push(formatContext(resource));
  const contextSection = compiledContext ? `\n\n${compiledContext.rendered}` : "";
  const user = `Task ID: ${packet.taskId}\nDependencies: ${JSON.stringify(packet.dependencies)}\nRuntime file scope: ${JSON.stringify(packet.runtimeScope)}${contextSection}\n\n## Approved task packet\n${packet.briefText}`;
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

function qualificationRuntimeFacts({ prepared, worker, profile, runtimeChoice, limits, runChecks, piVersion }) {
  const preflight = prepared.metadata.preflight;
  const profileDigest = profile === undefined || profile === null ? UNKNOWN : digestJson(profile);
  const modelMetadata = worker.modelMetadata && typeof worker.modelMetadata === "object" && !Array.isArray(worker.modelMetadata)
    ? worker.modelMetadata
    : {};
  const sandbox = runtimeChoice.test
    ? "test-runtime"
    : runtimeChoice.sandbox ?? (process.platform === "darwin" ? "seatbelt" : "bubblewrap");
  return {
    model: {
      provider: prepared.metadata.provider ?? UNKNOWN,
      id: prepared.metadata.model ?? UNKNOWN,
      quantization: modelMetadata.quantization ?? UNKNOWN,
      server: modelMetadata.server ?? { id: UNKNOWN, version: UNKNOWN },
    },
    worker: {
      profileDigest,
      limits: {
        timeoutMs: limits.timeoutMs,
        maxToolCalls: limits.maxToolCalls,
        firstWriteMs: limits.firstWriteMs,
      },
      settings: {
        sandbox,
        effectiveMaxTokens: preflight.maxTokens.value,
        effectiveReasoning: prepared.metadata.effectiveReasoning ?? UNKNOWN,
        effectiveThinkingControl: preflight.thinking.control ?? UNKNOWN,
        effectiveThinkingReason: preflight.thinking.reason ?? UNKNOWN,
        effectiveThinkingField: preflight.thinkingTokenBudgetField ?? UNKNOWN,
        effectiveThinkingBudgetValue: preflight.thinkingBudget?.tokens ?? UNKNOWN,
        effectiveCompat: prepared.metadata.effectiveCompat ?? UNKNOWN,
        endpointFingerprint: preflight.endpointFingerprint ?? UNKNOWN,
      },
    },
    pi: { version: piVersion ?? UNKNOWN },
    runChecks: {
      declared: runChecks.declared,
      available: runChecks.available,
      budget: runChecks.maxCheckRuns ?? limits.maxCheckRuns,
      unavailableReason: runChecks.reason ?? UNKNOWN,
      provenance: { source: "worker.runtime.json", unavailableReason: runChecks.reason ?? UNKNOWN },
    },
    environment: {
      runtime: process.release?.name ?? UNKNOWN,
      runtimeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function qualificationRuntimeMismatches(qualification, actual) {
  if (qualification?.status !== "qualified" || !qualification.identity || typeof qualification.identity !== "object") return [];
  const expected = qualification.identity;
  const comparisons = [
    ["model.provider", expected.model?.provider, actual.model.provider],
    ["model.id", expected.model?.id, actual.model.id],
    ["model.quantization", expected.model?.quantization, actual.model.quantization],
    ["model.server.id", expected.model?.server?.id, actual.model.server.id],
    ["model.server.version", expected.model?.server?.version, actual.model.server.version],
    ["worker.profileDigest", expected.worker?.profileDigest, actual.worker.profileDigest],
    ["worker.limits.timeoutMs", expected.worker?.limits?.timeoutMs, actual.worker.limits.timeoutMs],
    ["worker.limits.maxToolCalls", expected.worker?.limits?.maxToolCalls, actual.worker.limits.maxToolCalls],
    ["worker.limits.firstWriteMs", expected.worker?.limits?.firstWriteMs, actual.worker.limits.firstWriteMs],
    ["worker.settings.sandbox", expected.worker?.settings?.sandbox, actual.worker.settings.sandbox],
    ["worker.settings.effectiveMaxTokens", expected.worker?.settings?.effectiveMaxTokens, actual.worker.settings.effectiveMaxTokens],
    ["worker.settings.effectiveReasoning", expected.worker?.settings?.effectiveReasoning, actual.worker.settings.effectiveReasoning],
    ["worker.settings.effectiveThinkingControl", expected.worker?.settings?.effectiveThinkingControl, actual.worker.settings.effectiveThinkingControl],
    ["worker.settings.effectiveThinkingReason", expected.worker?.settings?.effectiveThinkingReason, actual.worker.settings.effectiveThinkingReason],
    ["worker.settings.effectiveThinkingField", expected.worker?.settings?.effectiveThinkingField, actual.worker.settings.effectiveThinkingField],
    ["worker.settings.effectiveThinkingBudgetValue", expected.worker?.settings?.effectiveThinkingBudgetValue, actual.worker.settings.effectiveThinkingBudgetValue],
    ["worker.settings.effectiveCompat", expected.worker?.settings?.effectiveCompat, actual.worker.settings.effectiveCompat],
    ["worker.settings.endpointFingerprint", expected.worker?.settings?.endpointFingerprint, actual.worker.settings.endpointFingerprint],
    ["pi.version", expected.pi?.version, actual.pi.version],
    ["runChecks.declared", expected.runChecks?.declared, actual.runChecks.declared],
    ["runChecks.available", expected.runChecks?.available, actual.runChecks.available],
    ["runChecks.budget", expected.runChecks?.budget, actual.runChecks.budget],
    ["runChecks.unavailableReason", expected.runChecks?.unavailableReason, actual.runChecks.unavailableReason],
    ["runChecks.provenance.source", expected.runChecks?.provenance?.source, actual.runChecks.provenance.source],
    ["runChecks.provenance.unavailableReason", expected.runChecks?.provenance?.unavailableReason, actual.runChecks.provenance.unavailableReason],
    ["environment.runtime", expected.environment?.runtime, actual.environment.runtime],
    ["environment.runtimeVersion", expected.environment?.runtimeVersion, actual.environment.runtimeVersion],
    ["environment.platform", expected.environment?.platform, actual.environment.platform],
    ["environment.arch", expected.environment?.arch, actual.environment.arch],
  ];
  return comparisons
    .filter(([, expectedValue, actualValue]) => expectedValue !== UNKNOWN && fsStableStringify(expectedValue) !== fsStableStringify(actualValue))
    .map(([field]) => field);
}

function invalidatedQualification(qualification, changedFields) {
  const fields = [...new Set(changedFields)].sort();
  const warning = `qualification unqualified: qualification invalidated by config change [qualification_invalidated_by_config] (changed: ${fields.join(", ")})`;
  return {
    ...qualification,
    status: "unqualified",
    reason: "qualification_invalidated_by_config",
    changedFields: fields,
    warnings: [warning],
  };
}

function buildPiArgs({ provider, model, sessionPath, thinking, systemPromptPath, userPrompt, checkExtension, compactionExtension }) {
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
  for (const extension of [checkExtension, compactionExtension].filter(Boolean)) args.push("-e", extension);
  args.push(userPrompt);
  return args;
}

export function buildBubblewrapArgs({ workspace, stateDir, nodeRoot, piArgs, piLexicalPath, env, checkChannel, compactionBundle }) {
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
  if (compactionBundle && !checkChannel) args.push("--dir", "/opt/tinysdd");
  if (compactionBundle) args.push("--dir", "/opt/tinysdd/compaction", "--ro-bind", compactionBundle.directory, "/opt/tinysdd/compaction");
  // No --unshare-net: model inference must reach the configured proxy.  The
  // only writable mounts are the disposable candidate and temporary Pi state.
  args.push("--setenv", "HOME", "/home", "--setenv", "PI_CODING_AGENT_DIR", "/pi-state", "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin");
  if (compactionBundle) args.push("--setenv", COMPACTION_ANCHOR_ENV, "/opt/tinysdd/compaction/anchor.json");
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
      const details = event.result?.details && typeof event.result.details === "object" ? event.result.details : null;
      const detailsSerialized = details === null ? null : compactionStableStringify(details);
      compactions.push({
        reason: event.reason ?? null,
        aborted: event.aborted === true,
        tokensBefore: Number.isFinite(event.result?.tokensBefore) ? event.result.tokensBefore : null,
        estimatedTokensAfter: Number.isFinite(event.result?.estimatedTokensAfter) ? event.result.estimatedTokensAfter : null,
        summarySha256: summary === null ? null : createHash("sha256").update(summary).digest("hex"),
        summaryBytes: summary === null ? null : Buffer.byteLength(summary),
        detailsSha256: detailsSerialized === null ? null : createHash("sha256").update(detailsSerialized).digest("hex"),
        detailsBytes: detailsSerialized === null ? null : Buffer.byteLength(detailsSerialized),
        details,
        deterministic: details?.strategy === "deterministic",
        fromHook: event.result?.fromHook === true || details?.strategy === "deterministic",
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

function runtimeMetadata(prepared, runtime, pi, bwrap, worker, profile, piVersion, runChecks, compaction, qualification) {
  const qualificationValue = qualification === undefined ? undefined : {
    recordDigest: qualification.recordDigest ?? null,
    path: qualification.path ?? null,
    status: qualification.status ?? "unknown",
    mode: qualification.mode ?? "warn",
    reason: qualification.reason ?? null,
    changedFields: Array.isArray(qualification.changedFields) ? [...qualification.changedFields] : [],
    warnings: Array.isArray(qualification.warnings) ? [...qualification.warnings] : [],
  };
  const extensions = [
    ...(runChecks?.available ? ["run-checks.mjs"] : []),
    ...(compaction?.enabled ? ["compaction-extension.mjs"] : []),
  ];
  return {
    schemaVersion: 1,
    adapter: "pi",
    runtimeScope: { ...DEFAULT_RUNTIME_SCOPE },
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
    endpointFingerprint: prepared.metadata.preflight.endpointFingerprint ?? "UNKNOWN",
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
      extensions: extensions.length > 0 ? extensions : false,
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
    ...(qualificationValue === undefined ? {} : { qualification: qualificationValue, warnings: qualificationValue.warnings }),
    compaction,
  };
}

/**
 * Execute one approved TinySDD packet through the Pi worker adapter.
 *
 * The optional `runtime` member is test-only and is rejected unless the test
 * harness explicitly enables it.  Production callers use the four documented
 * arguments and therefore require Linux bubblewrap or macOS Seatbelt.
 */
export async function runWorker({ projectRoot, packet, worker, profile, runtime, baseRunId, baselineRunId, signal, qualification } = {}) {
  const { absolute: sourceRoot } = await ensureRoot(projectRoot);
  const tempRoot = await temporaryRoot();
  const normalizedPacket = normalizePacket(packet);
  await assertPreparationIdentity(projectRoot, normalizedPacket.preparation ?? []);
  const filesystemAliases = await detectFilesystemAliases(sourceRoot);
  const { caseInsensitive, unicodeInsensitive } = filesystemAliases;
  const inputPaths = taskInputPaths(normalizedPacket);
  const limits = validatePiWorker(worker);
  const selectedAllowed = normalizedPacket.allowedPaths.map((path) => projectRelative(path, "packet allowed path"));
  const frozenBaseline = await resolveFrozenBaseline(sourceRoot, baselineRunId, normalizedPacket.taskId);
  const executionSource = frozenBaseline?.root ?? sourceRoot;
  const resolvedProfile = await resolveProfile(sourceRoot, worker, profile);
  const runtimeChoice = await chooseRuntime(runtime);
  const checksDeclared = normalizedPacket.checks !== null;
  const checkAvailability = checksDeclared ? probeCheckRunner(runtimeChoice, runtime) : { available: false, reason: null, testInjected: false };
  // The manifest defines immutable dependency mounts even when this host
  // cannot execute the declared checker.
  const checkManifest = checksDeclared ? parseChecksManifest(normalizedPacket.checks.text) : null;
  const revisionBase = await resolveRevisionBase(sourceRoot, baseRunId, selectedAllowed, normalizedPacket.taskId, {
    protectedPaths: normalizedPacket.protectedPaths,
    inputPaths,
    preparation: normalizedPacket.preparation ?? [],
    dependencyMounts: checkManifest?.dependencyMounts ?? [],
    caseInsensitive,
    unicodeInsensitive,
    filesystemAliases,
  });
  if (revisionBase && frozenBaseline) fail("baseRunId and baselineRunId cannot be combined");
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
  const prompt = buildPrompt({ packet: { ...normalizedPacket, briefText: brief.text }, profile: resolvedProfile.value, review, compiledContext, agents, skills, instructions, builtInPrompt, checkAvailability, checkManifest });
  const inlineProfileResource = resolvedProfile.resource || (resolvedProfile.value ? { path: "<inline-profile>", text: JSON.stringify(resolvedProfile.value) } : null);
  const contextResources = [brief.resource, inlineProfileResource, builtInPrompt, review?.evidence, ...agents, ...skills, ...instructions].filter(Boolean).map(({ text, ...digest }) => ({ ...digest, sha256: digest.sha256 ?? createHash("sha256").update(text).digest("hex"), bytes: digest.bytes ?? Buffer.byteLength(text) }));
  const prepared = await preparePiEnvironment({ worker, profile: resolvedProfile.value, sourceAgentDir: runtimeChoice.sourceAgentDir, sourceEnv: runtimeChoice.sourceEnv });

  let piPackage;
  let piVersion;
  let effectiveQualification = qualification;
  try {
    piPackage = await piPackageInfo(runtimeChoice.pi);
    piVersion = runtimeChoice.test ? "test-harness" : piPackage.version;
    const preparedRunChecks = runChecksMetadata({ declared: checksDeclared, availability: checkAvailability, maxCheckRuns: limits.maxCheckRuns, checkChannel: null, baseline: null });
    const qualificationMismatches = qualificationRuntimeMismatches(
      qualification,
      qualificationRuntimeFacts({ prepared, worker, profile: resolvedProfile.value, runtimeChoice, limits, runChecks: preparedRunChecks, piVersion }),
    );
    if (qualificationMismatches.length > 0) {
      const invalidated = invalidatedQualification(qualification, qualificationMismatches);
      if (qualification?.mode === "enforce") {
        throw new WorkerError("worker qualification no longer matches the prepared runtime", {
          code: "MODEL_NOT_QUALIFIED",
          details: { qualification: invalidated },
        });
      }
      effectiveQualification = invalidated;
    }
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }

  const runId = `worker-${new Date().toISOString().replace(/[:.]/gu, "-")}-${Math.random().toString(16).slice(2, 10)}`;
  let artifactDir;
  let workspace;
  let baseline;
  let inferenceRelay;
  let checkChannel;
  let compactionStage;
  let compactionBundle;
  let compactionAnchor;
  let compaction;
  let runtimeRecord;
  let sessionHostPath;
  let retainedSession;
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
    await assertCopiedInputs(executionSource, workspaceCopy, selectedAllowed, normalizedPacket.protectedPaths, normalizedPacket.preparation ?? [], compiledContext);
    await overlayRevisionBase(revisionBase, workspace);
    await copyRegularTree(workspace, baseline);
    before = await snapshotTree(workspace);
    await copyRegularTree(workspace, beforeArtifact);
    await writeJson(join(artifactDir, "packet.json"), normalizedPacket);
    await writeFile(join(artifactDir, "prompt.txt"), prompt.rendered, { mode: 0o600 });
    if (compiledContext) await writeFile(join(artifactDir, "compiled-context.md"), compiledContext.rendered, { mode: 0o600 });
    if (checkManifest && checkAvailability.available) {
      checkChannel = await createCheckChannel({ manifest: checkManifest, sourceRoot, workspace, artifactDir, tempRoot, allowedPaths: selectedAllowed, maxCheckRuns: limits.maxCheckRuns, nodeRoot: dirname(dirname(process.execPath)), ...(runtimeChoice.test && runtime?.checkRunner ? { runner: runtime.checkRunner } : {}) });
    }
    const runChecks = runChecksMetadata({ declared: checksDeclared, availability: checkAvailability, maxCheckRuns: limits.maxCheckRuns, checkChannel, baseline: frozenBaseline ?? revisionBase });
    if (prepared.metadata.compaction?.enabled) {
      // The user prompt is the approved packet that Pi places in compactable history.
      // It is anchored before the extension enters either OS sandbox.
      compactionAnchor = createApprovedPacketAnchor({ id: normalizedPacket.taskId, text: prompt.user });
      compactionStage = await mkdtemp(join(tempRoot, "tinysdd-compaction-"));
      compactionBundle = await writeCompactionBundle(compactionStage, compactionAnchor);
    }
    compaction = compactionIdentity(prepared.metadata.compaction, compactionAnchor);
    runtimeRecord = runtimeMetadata(prepared, runtimeChoice, runtimeChoice.pi, runtimeChoice.bwrap, worker, resolvedProfile.value, piVersion, runChecks, compaction, effectiveQualification);
    await writeJson(join(artifactDir, "runtime.json"), runtimeRecord);
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
    sessionHostPath = join(prepared.stateDir, "session.jsonl");
    const userPromptPath = join(prepared.stateDir, "task-prompt.txt");
    await writeFile(userPromptPath, prompt.user, { mode: 0o600 });
    const promptArgumentPath = nativePaths ? join(promptStateDir, "task-prompt.txt") : "/pi-state/task-prompt.txt";
    const appendPromptPath = nativePaths ? join(promptStateDir, "system-prompt.txt") : "/pi-state/system-prompt.txt";
    const checkExtension = checkChannel ? (nativePaths ? checkChannel.extension : "/opt/tinysdd/run-checks.mjs") : null;
    const compactionExtension = compactionBundle ? (nativePaths ? compactionBundle.entryPath : "/opt/tinysdd/compaction/entry.mjs") : null;
    const piArgs = buildPiArgs({ checkExtension, compactionExtension, provider: worker.provider, model: worker.model, sessionPath, thinking, systemPromptPath: appendPromptPath, userPrompt: promptArgumentPath.startsWith("/") ? `@${promptArgumentPath}` : prompt.user });
    let command;
    let args;
    let childEnv;
    if (runtimeChoice.test) {
      command = runtimeChoice.pi.path;
      args = piArgs;
      childEnv = { ...prepared.env, HOME: prepared.env.HOME, PATH: process.env.PATH || "/usr/bin:/bin", TINYSDD_TEST_WORKSPACE: workspace };
      if (compactionBundle) childEnv[COMPACTION_ANCHOR_ENV] = compactionBundle.anchorPath;
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
        sandboxProfile = buildMacosSandboxProfile({ workspace, stateDir, sourceRoot, sourceAgentDir, compactionBundle: compactionBundle?.directory, nodeExecutable: runtimeChoice.node.resolved, piExecutable: runtimeChoice.pi.resolved, piRoot: piPackage.root, inferencePort: inferenceRelay.port });
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
      if (compactionBundle) childEnv[COMPACTION_ANCHOR_ENV] = compactionBundle.anchorPath;
      runtimeRecord = { ...runtimeRecord, generatedCredentialReferenceCount: 0, sandboxProfile: sandboxPath, inferenceDestination: `localhost:${inferenceRelay.port}` };
      await writeJson(join(artifactDir, "runtime.json"), runtimeRecord);
    } else {
      const nodeRoot = dirname(dirname(runtimeChoice.pi.path));
      await existingAbsoluteDirectory(nodeRoot, "Pi installation root");
      command = runtimeChoice.bwrap.path;
      childEnv = { ...prepared.env, HOME: "/home", PATH: "/opt/node/bin:/usr/bin:/bin", PI_CODING_AGENT_DIR: "/pi-state", TINYSDD_WORKSPACE: "/work" };
      args = buildBubblewrapArgs({ workspace, stateDir: prepared.stateDir, nodeRoot, piArgs, piLexicalPath: "/opt/node/bin/pi", env: childEnv, checkChannel, compactionBundle });
    }
    if (checkChannel) {
      childEnv.TINYSDD_CHECK_CHANNEL = nativePaths ? checkChannel.root : "/tinysdd";
      childEnv.TINYSDD_CHECK_DEADLINE = String(Date.now() + limits.timeoutMs);
    }
    capture = await captureProcess({ checkChannel, command, args, cwd: nativePaths ? workspace : sourceRoot, env: childEnv, stdoutPath: join(artifactDir, "stdout.jsonl"), stderrPath: join(artifactDir, "stderr.txt"), timeoutMs: limits.timeoutMs, maxToolCalls: limits.maxToolCalls, firstWriteMs: limits.firstWriteMs, direct: runtimeChoice.test, pipeOutput: runtimeChoice.sandbox === "seatbelt" || (runtimeChoice.test && runtime?.pipeOutput === true), signal });
    if (inferenceRelay) await inferenceRelay.close();
    inferenceRelay = null;
    if (compactionBundle) {
      retainedSession = await retainSessionArtifact(sessionHostPath, join(artifactDir, "session.jsonl"));
      runtimeRecord = {
        ...runtimeRecord,
        session: {
          available: retainedSession.available,
          bytes: retainedSession.bytes ?? null,
          sha256: retainedSession.sha256 ?? null,
          reason: retainedSession.reason ?? null,
        },
      };
      await writeJson(join(artifactDir, "runtime.json"), runtimeRecord);
    }
    after = await snapshotTree(workspace);
    await copySnapshotTree(workspace, afterArtifact);
    if (compactionBundle) await copyRegularTree(compactionBundle.directory, join(artifactDir, "compaction"));
    await writeJson(join(artifactDir, "after-snapshot.json"), after);
    const changes = changedFiles(before, after);
    patchInfo = await runGitDiff(beforeArtifact, afterArtifact, join(artifactDir, "patch.diff"), artifactDir);
    if (patchInfo.available) patchInfo.applyCheck = await runGitApplyCheck(join(artifactDir, "patch.diff"), baseline);
    const allowedSet = new Set(selectedAllowed);
    const actualChanges = changes.map((change) => ({ ...change, path: slash(change.path) }));
    const scopeViolations = actualChanges.map((change) => classifyFileScopeChange(change, {
      protectedPaths: normalizedPacket.protectedPaths,
      inputPaths,
      preparationPaths: preparationPaths(normalizedPacket.preparation ?? []),
      dependencyMounts: checkManifest?.dependencyMounts ?? [],
      caseInsensitive,
      unicodeInsensitive,
      filesystemAliases,
    })).filter(Boolean);
    const outcome = classifyOutcome(capture);
    const limitDetails = outcomeLimitDetails(outcome, capture, prepared.metadata, limits);
    const touchedAllowedPaths = new Set(actualChanges.filter((change) => allowedSet.has(change.path)).map((change) => change.path));
    const actualPaths = actualChanges.map((change) => change.path);
    const extraPaths = actualPaths.filter((path) => !allowedSet.has(path));
    result = {
      schemaVersion: 1,
      runId,
      taskId: normalizedPacket.taskId,
      runtimeScope: { ...normalizedPacket.runtimeScope },
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
      fileScope: {
        mode: "ordinary-create-modify",
        plannedPaths: [...selectedAllowed],
        actualPaths: [...new Set(actualPaths)].sort(),
        extraPaths: [...new Set(extraPaths)].sort(),
        ordinaryCreateModify: true,
        deletions: false,
      },
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
        ...(retainedSession ? {
          session: {
            available: retainedSession.available,
            bytes: retainedSession.bytes ?? null,
            sha256: retainedSession.sha256 ?? null,
            reason: retainedSession.reason ?? null,
          },
        } : {}),
        rawOutputBytes: capture.rawBytes,
      },
      ...(limitDetails ? { limitDetails } : {}),
      changedPaths: actualChanges,
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
        ...(compactionBundle ? { compaction: join(artifactDir, "compaction") } : {}),
        ...(retainedSession?.available ? { session: join(artifactDir, "session.jsonl") } : {}),
        workspaceBefore: beforeArtifact,
        workspaceAfter: afterArtifact,
        candidate: afterArtifact,
      },
      patch: patchInfo,
      modelClaims: { observed: Boolean(capture.parsed.claims), source: "unverified assistant text in raw Pi events", unverified: true, text: capture.parsed.claims, truncated: capture.parsed.claimsTruncated },
      warnings: ["Raw Pi events may contain source code. Worker output is not acceptance or verification evidence.", ...(effectiveQualification?.warnings ?? []), ...(runChecks.declared && !runChecks.available ? [`run_checks unavailable: ${runChecks.reason}`] : []), ...prepared.metadata.preflight.warnings.map((warning) => `Preflight: ${warning}`), ...(capture.parsed.compactions.some((entry) => !entry.aborted && entry.summarySha256 && !entry.deterministic) ? ["Pi compacted the worker context with a model-written summary; inspect packet retention before relying on later turns."] : []), ...(runtimeChoice.test ? ["Test runtime bypassed the OS sandbox; production execution remains fail-closed."] : []), ...(patchInfo.available ? [] : ["git diff --no-index did not produce a complete patch artifact."]), ...(patchInfo.applyCheck && !patchInfo.applyCheck.pass ? ["git apply --check did not validate the portable patch against the frozen candidate snapshot."] : [])],
      ...(effectiveQualification === undefined ? {} : { qualification: runtimeMetadata(prepared, runtimeChoice, runtimeChoice.pi, runtimeChoice.bwrap, worker, resolvedProfile.value, piVersion, runChecks, compaction, effectiveQualification).qualification }),
    };
    await writeJson(join(artifactDir, "result.json"), result);
    return result;
  } finally {
    if (inferenceRelay) await inferenceRelay.close().catch(() => {});
    if (checkChannel) await checkChannel.cleanup().catch(() => {});
    if (compactionBundle && !retainedSession && sessionHostPath && artifactDir) {
      retainedSession = await retainSessionArtifact(sessionHostPath, join(artifactDir, "session.jsonl"));
      if (runtimeRecord) {
        await writeJson(join(artifactDir, "runtime.json"), {
          ...runtimeRecord,
          session: {
            available: retainedSession.available,
            bytes: retainedSession.bytes ?? null,
            sha256: retainedSession.sha256 ?? null,
            reason: retainedSession.reason ?? null,
          },
        }).catch(() => {});
      }
    }
    await prepared.cleanup().catch(() => {});
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    if (baseline) await rm(baseline, { recursive: true, force: true }).catch(() => {});
    if (compactionStage) await rm(compactionStage, { recursive: true, force: true }).catch(() => {});
  }
}

export const workerLimits = Object.freeze({ DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TOOL_LIMIT, MAX_TOOL_LIMIT, MAX_RAW_OUTPUT_BYTES });
