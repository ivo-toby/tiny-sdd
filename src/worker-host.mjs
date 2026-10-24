import { constants as fsConstants } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";

export class WorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "WorkerError";
    if (options.code !== undefined) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function fail(message) {
  throw new WorkerError(message);
}

export async function executablePath(candidate, label) {
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

export async function existingAbsoluteDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory`);
  const canonical = await realpath(path);
  if (canonical !== path) fail(`${label} resolves through a symlink`);
  return canonical;
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
