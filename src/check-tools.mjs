// Host tools a check may run besides node (#220). Only git is provided: the
// runner resolves it from the controller's PATH at check time and grants its
// real installation read-only, so a test that runs git sees the same git as the
// host. When the host has a git the sandbox cannot provide, the check does not
// run (CHECK_TOOL_UNAVAILABLE): a test that guards on git must never pass in the
// sandbox only because git was missing there.
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { tinyError } from './fs-utils.mjs';

const PROBE_TIMEOUT_MS = 10000;
// Locations bubblewrap binds into the Linux check sandbox (src/check-runner.mjs).
const LINUX_BOUND_ROOTS = ['/usr/', '/bin/'];
const DARWIN_SYSTEM_IMAGES = ['/System/', '/usr/lib/'];
// With DYLD_PRINT_SEARCHING, dyld reports each library it loads from disk by
// the path it opened, which may run through symlinks (Homebrew's opt/ links).
const DYLD_IMAGE = /^dyld\[\d+\]:\s+found: dylib-from-disk: "(\/.+)"$/u;
const XCRUN = '/usr/bin/xcrun';

function toolUnavailable(message, details = undefined) {
  return tinyError('CHECK_TOOL_UNAVAILABLE', message, details);
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, searchPath) {
  for (const entry of (searchPath ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function run(command, args, { env, signal }) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { env, signal, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout, stderr, error });
    });
  });
}

// The probe never reads the user's git configuration: HOME points nowhere and
// the system file is skipped, as it is inside the sandbox.
function probeEnvironment(platform) {
  return { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', ...(platform === 'darwin' ? { DYLD_PRINT_SEARCHING: '1' } : {}) };
}

// /usr/bin/git on macOS is the xcrun shim, which needs the developer directory
// selection the sandbox cannot read. The git it would start is used instead.
// Without developer tools the shim fails on the host too, so there is no git.
async function darwinShimTarget(signal) {
  const found = await run(XCRUN, ['--find', 'git'], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, signal });
  const path = found.ok ? found.stdout.trim() : '';
  if (!isAbsolute(path) || !isExecutableFile(path)) return null;
  const real = await realpath(path);
  return real === '/usr/bin/git' ? null : real;
}

/**
 * Resolve the host's git for one check run, or null when the host has none.
 * `gitPath` (tests and callers that pin a binary) replaces the PATH lookup;
 * null turns git off.
 */
export async function resolveCheckGit({ platform = process.platform, gitPath, searchPath = process.env.PATH, signal } = {}) {
  if (gitPath === null) return null;
  const found = gitPath === undefined ? findOnPath('git', searchPath) : (isExecutableFile(gitPath) ? gitPath : null);
  if (found === null) {
    if (gitPath !== undefined) throw toolUnavailable(`gitPath is not an executable file: ${gitPath}`, { tool: 'git' });
    return null;
  }
  let executable = await realpath(found);
  if (platform === 'darwin' && executable === '/usr/bin/git') {
    executable = await darwinShimTarget(signal);
    if (executable === null) return null;
  }
  if (platform === 'linux' && !LINUX_BOUND_ROOTS.some((root) => executable.startsWith(root))) {
    throw toolUnavailable(`git resolves to ${executable}, outside /usr and /bin, which is all the Linux check sandbox binds; put a git from /usr or /bin first on PATH`, { tool: 'git', path: executable });
  }
  const probe = await run(executable, ['--exec-path'], { env: probeEnvironment(platform), signal });
  const execOutput = probe.stdout.trim();
  if (!probe.ok || !isAbsolute(execOutput)) {
    throw toolUnavailable(`git at ${executable} does not run on this host, so the check sandbox cannot provide it`, { tool: 'git', path: executable });
  }
  const execPath = await realpath(execOutput).catch(() => {
    throw toolUnavailable(`git at ${executable} names an exec path that does not exist: ${execOutput}`, { tool: 'git', path: executable });
  });
  const libraries = [];
  if (platform === 'darwin') {
    for (const line of probe.stderr.split('\n')) {
      const image = DYLD_IMAGE.exec(line)?.[1];
      if (image === undefined || DARWIN_SYSTEM_IMAGES.some((root) => image.startsWith(root))) continue;
      const real = await realpath(image).catch(() => null);
      if (real === null) continue;
      // dyld opens the path it was given, so both it and its target are granted.
      for (const path of [image, real]) if (!libraries.includes(path)) libraries.push(path);
    }
  }
  if (platform === 'linux' && !LINUX_BOUND_ROOTS.some((root) => execPath.startsWith(root))) {
    throw toolUnavailable(`git's exec path ${execPath} is outside /usr and /bin, which is all the Linux check sandbox binds`, { tool: 'git', path: executable });
  }
  // git starts its helpers and finds its templates (share/git-core, next to
  // libexec) by the exec path it reports, which may run through a symlink.
  const execPaths = unique([execOutput, execPath]);
  const readable = [];
  for (const share of unique(execPaths.map((path) => join(dirname(dirname(path)), 'share', 'git-core')))) {
    const real = await realpath(share).catch(() => null);
    if (real !== null && statSync(real).isDirectory()) readable.push(...unique([share, real]).filter((path) => !readable.includes(path)));
  }
  return { executable, binDir: dirname(executable), execPaths, libraries, readable };
}

function unique(values) {
  return [...new Set(values)];
}

// Set whenever git is provided: the system gitconfig (Homebrew's names a
// credential helper) stays out, and HOME is the scratch home, so no global
// configuration is read either.
export const GIT_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1' });
