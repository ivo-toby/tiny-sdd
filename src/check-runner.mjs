// Host-side runner for one declared check (docs/worker-runtime-next.md 3.1).
//
// The code a check runs is model-written plus project dependencies, so it runs
// in its own bubblewrap sandbox: no network, no inherited environment, no
// capabilities, a scratch copy of the candidate and resource limits. It never
// runs as root: a root caller drops to an unprivileged uid with setpriv first
// (the kernel does not apply RLIMIT_NPROC to root), and without setpriv the
// runner refuses to run. Nothing here is verification or acceptance evidence.
import { accessSync, constants as fsConstants, createWriteStream, statSync } from 'node:fs';
import { lchown, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { TinySDDError, isPlainObject, normalizeProjectRelative, tinyError } from './fs-utils.mjs';

const MIB = 1024 * 1024;

export const CHECK_LIMIT_DEFAULTS = Object.freeze({
  addressSpaceBytes: 8 * 1024 * MIB,
  // Extra tasks (processes and threads) the check may create, on top of what its
  // uid already runs: RLIMIT_NPROC counts every task of the uid on the host.
  maxProcesses: 512,
  fileSizeBytes: 256 * MIB,
  // The candidate must fit, and /work inside the sandbox is a tmpfs of this
  // size. Like /tmp and /dev/shm it is RAM-backed, and RLIMIT_AS does not cover
  // it, so up to scratchBytes + 2 * tmpfsBytes of memory can be used per check.
  scratchBytes: 512 * MIB,
  tmpfsBytes: 256 * MIB,
  storedOutputBytes: MIB,
  returnedTailBytes: 16 * 1024,
});

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const KILL_GRACE_MS = 2000;
const HEAD_BYTES = 1024;
const BWRAP_DEFAULTS = ['/usr/bin/bwrap', '/bin/bwrap'];
const PRLIMIT_DEFAULTS = ['/usr/bin/prlimit'];
const SETPRIV_DEFAULTS = ['/usr/bin/setpriv', '/bin/setpriv'];
const OPTION_KEYS = ['candidateDir', 'check', 'dependencyMounts', 'nodeRoot', 'limits', 'runAs', 'bwrapPath', 'prlimitPath', 'setprivPath', 'tempRoot'];
// nobody and nogroup: the uid a root caller drops to unless runAs says otherwise.
const DEFAULT_DROP_ID = 65534;
const MAX_ID = 4294967294;
// bwrap adds PWD itself when --chdir is used and it cannot be unset.
const SANDBOX_ENV = Object.freeze(['PATH', 'HOME', 'CI', 'LANG', 'PWD']);
// The candidate is bound read-only at /input and copied into the /work tmpfs
// here, so what the check writes is bounded by the tmpfs size. The script is
// fixed text: the check's argv reaches the shell only as "$@", never as script.
// cp -a keeps the modes (the exec bit) and works for an unprivileged uid; its
// own errors are folded into the one setup message.
// There is no cd: bwrap --chdir /work already set the directory, and a cd would
// add OLDPWD to the check's environment.
const SETUP_PREFIX = 'tinysdd-setup: ';
const SETUP_FAILURE_EXIT = 125;
const COPY_AND_EXEC = `err=$(cp -a /input/. /work/ 2>&1) || { printf '${SETUP_PREFIX}copying the candidate into the sandbox failed: %s\\n' "$err" >&2; exit ${SETUP_FAILURE_EXIT}; }; exec "$@"`;
// bwrap 0.8 and later can stop the check from creating nested user namespaces.
// It is probed once per bwrap, and an older or unwilling bwrap just runs without it.
const USERNS_PROBE_ARGS = ['--unshare-all', '--unshare-user', '--disable-userns', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--', '/bin/true'];
const usernsProbes = new Map();

function invalid(message, details = undefined) {
  return tinyError('CHECK_INVALID', message, details);
}

function unavailable(message, details = undefined) {
  return tinyError('CHECK_RUNNER_UNAVAILABLE', message, details);
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking through the bounded list; there is no PATH lookup.
    }
  }
  return null;
}

// A caller with root's identity or privileges drops to an unprivileged uid
// before the sandbox; an unprivileged caller cannot switch users and runs as itself.
function isPrivileged() {
  return process.getuid() === 0 || process.geteuid() === 0;
}

function locateBinaries({ bwrapPath, prlimitPath, setprivPath } = {}) {
  if (process.platform !== 'linux') return { reason: `the check runner requires Linux (this is ${process.platform})` };
  const bwrapCandidates = bwrapPath === undefined ? BWRAP_DEFAULTS : [bwrapPath];
  const bwrap = findExecutable(bwrapCandidates);
  if (!bwrap) return { reason: `bubblewrap is not an executable file (tried ${bwrapCandidates.join(', ')})` };
  const prlimitCandidates = prlimitPath === undefined ? PRLIMIT_DEFAULTS : [prlimitPath];
  const prlimit = findExecutable(prlimitCandidates);
  if (!prlimit) return { reason: `prlimit is not an executable file (tried ${prlimitCandidates.join(', ')})` };
  if (!isPrivileged()) return { bwrap, prlimit, setpriv: null };
  const setprivCandidates = setprivPath === undefined ? SETPRIV_DEFAULTS : [setprivPath];
  const setpriv = findExecutable(setprivCandidates);
  if (!setpriv) {
    return { reason: `the check runner will not run checks as root without dropping to an unprivileged user, and setpriv is unavailable (tried ${setprivCandidates.join(', ')})` };
  }
  return { bwrap, prlimit, setpriv };
}

export function checkRunnerAvailable(options = {}) {
  const found = locateBinaries(options);
  return found.reason ? { available: false, reason: found.reason } : { available: true, reason: null };
}

function projectRelative(input, field) {
  let normalized;
  try {
    normalized = normalizeProjectRelative(input, field);
  } catch (error) {
    throw invalid(error.message, { field });
  }
  if (normalized !== input) throw invalid(`${field} must be a normalized project-relative path`, { field });
  return normalized;
}

function parseLimits(overrides) {
  const limits = { ...CHECK_LIMIT_DEFAULTS };
  if (overrides === undefined) return limits;
  if (!isPlainObject(overrides)) throw invalid('limits must be an object');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(CHECK_LIMIT_DEFAULTS, key)) throw invalid(`limits contains unknown key: ${key}`);
    if (!Number.isSafeInteger(value) || value < 1) throw invalid(`limits.${key} must be a positive integer`);
    limits[key] = value;
  }
  return limits;
}

function parseMounts(dependencyMounts) {
  if (dependencyMounts === undefined) return [];
  if (!Array.isArray(dependencyMounts)) throw invalid('dependencyMounts must be an array');
  const mounts = dependencyMounts.map((mount, index) => {
    const label = `dependencyMounts[${index}]`;
    if (!isPlainObject(mount)) throw invalid(`${label} must be an object`);
    for (const key of Object.keys(mount)) {
      if (key !== 'source' && key !== 'target') throw invalid(`${label} contains unknown key: ${key}`);
    }
    if (typeof mount.source !== 'string') throw invalid(`${label}.source must be an absolute path`);
    return { source: mount.source, target: projectRelative(mount.target, `${label}.target`) };
  });
  for (const [index, mount] of mounts.entries()) {
    for (const other of mounts.slice(index + 1)) {
      if (mount.target === other.target) throw invalid(`dependency mount target is declared twice: ${mount.target}`);
      if (mount.target.startsWith(`${other.target}/`) || other.target.startsWith(`${mount.target}/`)) {
        throw invalid(`dependency mount targets must not nest: ${mount.target}, ${other.target}`);
      }
    }
  }
  return mounts;
}

function parseRunAs(runAs) {
  if (runAs !== undefined) {
    if (!isPlainObject(runAs)) throw invalid('runAs must be an object with uid and gid');
    for (const key of Object.keys(runAs)) {
      if (key !== 'uid' && key !== 'gid') throw invalid(`runAs contains unknown key: ${key}`);
    }
    for (const key of ['uid', 'gid']) {
      if (!Number.isSafeInteger(runAs[key]) || runAs[key] < 1 || runAs[key] > MAX_ID) {
        throw invalid(`runAs.${key} must be an integer from 1 to ${MAX_ID}: a check never runs as root`);
      }
    }
  }
  if (isPrivileged()) return { uid: runAs?.uid ?? DEFAULT_DROP_ID, gid: runAs?.gid ?? DEFAULT_DROP_ID, drop: true };
  const own = { uid: process.getuid(), gid: process.getgid() };
  if (runAs !== undefined && (runAs.uid !== own.uid || runAs.gid !== own.gid)) {
    throw invalid(`runAs must be absent or the current uid and gid (${own.uid}:${own.gid}); an unprivileged process cannot switch users`);
  }
  return { ...own, drop: false };
}

function parseCheck(check, mounts) {
  if (!isPlainObject(check)) throw invalid('check must be an object');
  const { id, argv, timeoutMs } = check;
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) throw invalid('check.id must be a nonempty string');
  if (!Array.isArray(argv) || argv.length === 0) throw invalid('check.argv must be a nonempty array of strings');
  argv.forEach((arg, index) => {
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')) {
      throw invalid(`check.argv[${index}] must be a nonempty string without NUL`);
    }
  });
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalid(`check.timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return { id, argv: [...argv], timeoutMs, executable: sandboxExecutable(argv[0], mounts) };
}

function sandboxExecutable(argv0, mounts) {
  if (argv0 === 'node') return '/opt/node/bin/node';
  const path = projectRelative(argv0, 'check.argv[0]');
  if (!mounts.some((mount) => path.startsWith(`${mount.target}/`))) {
    throw invalid('check.argv[0] must be node or a path inside a declared dependency mount', { field: 'check.argv[0]' });
  }
  return `/work/${path}`;
}

function parseRequest(options) {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw invalid(`runCheck options contain unknown key: ${key}`);
  }
  for (const key of ['bwrapPath', 'prlimitPath', 'setprivPath', 'tempRoot', 'nodeRoot']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') throw invalid(`${key} must be a string`);
  }
  if (typeof options.candidateDir !== 'string') throw invalid('candidateDir must be an absolute path');
  const mounts = parseMounts(options.dependencyMounts);
  return {
    candidateDir: options.candidateDir,
    check: parseCheck(options.check, mounts),
    mounts,
    nodeRoot: options.nodeRoot ?? dirname(dirname(process.execPath)),
    limits: parseLimits(options.limits),
    runAs: parseRunAs(options.runAs),
  };
}

// Paths are compared with their realpath so a symlinked parent cannot point a
// mount or the copy somewhere the caller did not name.
async function assertRealDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw invalid(`${label} must be an absolute path`);
  }
  let info;
  let canonical;
  try {
    info = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw invalid(`${label} is not a readable directory: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalid(`${label} must be a real directory: ${path}`);
  if (canonical !== path) throw invalid(`${label} resolves through a symlink: ${path}`);
}

async function resolveTempRoot(requested) {
  const chosen = requested ?? [process.env.TINYSDD_TMPDIR, process.env.TMPDIR].find((value) => typeof value === 'string' && value.length > 0) ?? '/tmp';
  let canonical;
  try {
    canonical = await realpath(chosen);
    if (!(await lstat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw invalid(`temporary directory is not usable: ${chosen}`);
  }
  return canonical;
}

// tmpfs charges whole pages, so a candidate only fits the /work tmpfs if its
// files are counted that way.
function pageFootprint(bytes) {
  return Math.ceil(bytes / 4096) * 4096;
}

async function copyRegularFile(from, to, info, budget, label) {
  let input;
  try {
    // O_NOFOLLOW and O_NONBLOCK close the window between lstat and open in
    // which an entry could become a symlink or a FIFO.
    input = await open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    throw invalid(`candidateDir file cannot be copied: ${label} (${error.code ?? 'unreadable'})`);
  }
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw invalid(`candidateDir changed while it was being copied: ${label}`);
    }
    const refuse = () => invalid(`candidateDir exceeds the scratch limit of ${budget.limit} bytes`, { limit: budget.limit });
    if (budget.used + pageFootprint(opened.size) > budget.limit) throw refuse();
    let copied = 0;
    await pipeline(
      input.createReadStream(),
      async function* countBytes(source) {
        for await (const chunk of source) {
          copied += chunk.length;
          if (budget.used + pageFootprint(copied) > budget.limit) throw refuse();
          yield chunk;
        }
      },
      // Owner read is forced: after a root caller's chown the dropped uid reads it as owner.
      createWriteStream(to, { flags: 'wx', mode: (opened.mode & 0o777) | 0o400 }),
    );
    budget.used += pageFootprint(copied);
  } finally {
    await input.close().catch(() => {});
  }
}

async function copyDirectory(from, to, budget, prefix = '') {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const label = `${prefix}${entry.name}`;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    const info = await lstat(source);
    if (info.isDirectory()) {
      // Owner rwx is forced so the copy can be filled and later removed.
      await mkdir(target, { mode: (info.mode & 0o777) | 0o700 });
      await copyDirectory(source, target, budget, `${label}/`);
    } else if (info.isFile()) {
      await copyRegularFile(source, target, info, budget, label);
    } else {
      const kind = info.isSymbolicLink() ? 'symlink' : 'special file';
      throw invalid(`candidateDir contains a ${kind}; only regular files and directories are copied: ${label}`, { path: label });
    }
  }
}

// The sandbox runs as the target uid, which has to read the host copy. The
// scratch directory stays 0700, so nobody else can.
async function giveToUser(path, uid, gid) {
  await lchown(path, uid, gid);
  if (!(await lstat(path)).isDirectory()) return;
  for (const entry of await readdir(path)) await giveToUser(join(path, entry), uid, gid);
}

function copyFailure(error) {
  if (error instanceof TinySDDError) return error;
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return unavailable(`scratch space ran out while copying candidateDir (${error.code})`);
  return invalid(`candidateDir could not be copied: ${error?.code ?? error?.message}`);
}

// A dependency mount is read-only, so the candidate cannot also have something
// at the target: copying into it would fail inside the sandbox, and a file or
// directory there would otherwise be hidden by the mount.
async function assertMountPointsFree(input, mounts) {
  for (const { target } of mounts) {
    const segments = target.split('/');
    let current = input;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
      if (index === segments.length - 1) throw invalid(`dependency mount target already exists in candidateDir: ${target}`, { target });
      if (!info.isDirectory()) throw invalid(`dependency mount target is below a file in candidateDir: ${target}`, { target });
    }
  }
}

// RLIMIT_NPROC counts every task of the real uid on the host, threads
// included, not only the sandbox's. A fixed limit would stop a busy account
// from starting the sandbox at all, so the limit is this baseline plus the
// extra tasks the check may create. The uid counted is the one the check runs
// as, which is not the caller's when a root caller drops privileges.
async function countUserTasks(uid) {
  let entries;
  try {
    entries = await readdir('/proc');
  } catch (error) {
    throw unavailable(`cannot count the uid's tasks to set the process limit: ${error.code ?? error.message}`);
  }
  let tasks = 0;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let status;
    try {
      status = await readFile(`/proc/${entry}/status`, 'utf8');
    } catch {
      continue; // The process exited during the scan.
    }
    if (Number(/^Uid:\t(\d+)/mu.exec(status)?.[1]) === uid) tasks += Number(/^Threads:\t(\d+)/mu.exec(status)?.[1] ?? 1);
  }
  return tasks;
}

// The setpriv drop that comes before everything else when the caller is root.
// An unprivileged bwrap behaves differently from a privileged one, so the
// probe below goes through the same drop as the real run.
function launcher(binaries, runAs) {
  if (!runAs.drop) return { command: null, prefix: [] };
  return {
    command: binaries.setpriv,
    prefix: [`--reuid=${runAs.uid}`, `--regid=${runAs.gid}`, '--clear-groups', '--no-new-privs', '--'],
  };
}

function nestedUserNamespaces(binaries, runAs) {
  const key = [binaries.setpriv, binaries.bwrap, runAs.drop ? `${runAs.uid}:${runAs.gid}` : 'self'].join('\0');
  if (!usernsProbes.has(key)) {
    const { command, prefix } = launcher(binaries, runAs);
    usernsProbes.set(key, new Promise((resolve) => {
      const args = [...prefix, ...(command ? [binaries.bwrap] : []), ...USERNS_PROBE_ARGS];
      execFile(command ?? binaries.bwrap, args, { env: {}, timeout: 10000 }, (error) => resolve(error ? 'allowed' : 'disabled'));
    }));
  }
  return usernsProbes.get(key);
}

function sandboxArguments({ binaries, nodeRoot, input, mounts, limits, check, processLimit, nestedUserns }) {
  const tmpfsSize = String(limits.tmpfsBytes);
  return [
    `--as=${limits.addressSpaceBytes}`,
    `--nproc=${processLimit}`,
    `--fsize=${limits.fileSizeBytes}`,
    '--',
    binaries.bwrap,
    '--clearenv',
    '--die-with-parent', '--unshare-all', '--new-session',
    ...(nestedUserns === 'disabled' ? ['--unshare-user', '--disable-userns'] : []),
    // The check never runs as root, so bwrap is unprivileged and already drops
    // its capabilities; stating it keeps that true if it were ever not.
    '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--dir', '/opt', '--ro-bind', nodeRoot, '/opt/node',
    '--proc', '/proc', '--dev', '/dev',
    '--size', tmpfsSize, '--tmpfs', '/tmp',
    '--size', tmpfsSize, '--tmpfs', '/dev/shm',
    '--remount-ro', '/dev',
    '--ro-bind', input, '/input',
    '--size', String(limits.scratchBytes), '--tmpfs', '/work',
    ...mounts.flatMap((mount) => ['--ro-bind', mount.source, `/work/${mount.target}`]),
    '--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'CI', '1', '--setenv', 'LANG', 'C.UTF-8',
    '--chdir', '/work',
    '--', '/bin/sh', '-c', COPY_AND_EXEC, 'tinysdd-check', check.executable, ...check.argv.slice(1),
  ];
}

// Keeps the last `limit` bytes: a failing run ends with its summary.
class OutputCapture {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.stored = 0;
    this.total = 0;
    this.head = Buffer.alloc(0);
  }

  push(chunk) {
    this.total += chunk.length;
    if (this.head.length < HEAD_BYTES) this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES - this.head.length)]);
    this.chunks.push(chunk);
    this.stored += chunk.length;
    while (this.chunks.length > 1 && this.stored - this.chunks[0].length >= this.limit) this.stored -= this.chunks.shift().length;
  }

  finish() {
    const all = Buffer.concat(this.chunks);
    return all.length > this.limit ? keepLast(all, this.limit) : all;
  }
}

// Cutting inside a UTF-8 sequence would start the text with replacement
// characters, so the cut moves forward to the next character boundary.
function keepLast(buffer, bytes) {
  let start = buffer.length - bytes;
  const end = Math.min(buffer.length, start + 3);
  while (start < end && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

function summarizeOutput(capture, limits) {
  const stored = capture.finish();
  const tailBytes = stored.length > limits.returnedTailBytes ? keepLast(stored, limits.returnedTailBytes) : stored;
  const omitted = capture.total - tailBytes.length;
  return {
    totalBytes: capture.total,
    storedBytes: stored.length,
    truncated: capture.total > stored.length,
    text: stored.toString('utf8'),
    tail: `${omitted > 0 ? `[... ${omitted} earlier bytes omitted ...]\n` : ''}${tailBytes.toString('utf8')}`,
  };
}

function runSandbox({ command, args, timeoutMs, capture }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let settled = false;
    let timedOut = false;
    let killTimer;
    let graceTimer;
    let child;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      callback();
    };
    try {
      // env: {} so prlimit and bwrap inherit nothing from the host, and
      // detached so the whole group can be killed on timeout.
      child = spawn(command, args, { env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(unavailable(`could not start the check sandbox: ${error.message}`, { code: error.code }));
      return;
    }
    child.on('error', (error) => finish(() => reject(unavailable(`could not start the check sandbox: ${error.message}`, { code: error.code }))));
    child.stdout.on('data', (chunk) => capture.push(chunk));
    child.stderr.on('data', (chunk) => capture.push(chunk));
    child.on('close', (exitCode, signal) => finish(() => {
      resolve({ exitCode, signal, timedOut, durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) });
    }));
    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // --die-with-parent and the PID namespace take the sandbox down with
      // bwrap. If something still holds the pipes open, stop waiting for them.
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

// setpriv, prlimit and bwrap report their own failures as "setpriv: ...",
// "prlimit: ..." or "bwrap: ...", and the wrapper script reports a failed copy
// as "tinysdd-setup: ..." with exit 125. Any of them means the sandbox was never
// fully built and the check did not run. A check that cannot be executed is not
// one of these: the shell reports that as exit 127 and it stays a failing check.
function sandboxSetupFailure(run, head) {
  if (run.timedOut || run.exitCode === 0 || run.signal) return null;
  const text = head.toString('utf8');
  if (text.startsWith(SETUP_PREFIX)) return run.exitCode === SETUP_FAILURE_EXIT ? text : null;
  return ['bwrap: ', 'prlimit: ', 'setpriv: '].some((prefix) => text.startsWith(prefix)) ? text : null;
}

// The check only ever writes inside the sandbox, and the host copy is bound
// read-only, so a plain recursive remove is enough: the copy's directories are
// created owner-writable.
async function removeScratch(scratch) {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

export async function runCheck(options) {
  if (!isPlainObject(options)) throw invalid('runCheck options must be an object');
  const request = parseRequest(options);
  const binaries = locateBinaries(options);
  if (binaries.reason) throw unavailable(binaries.reason);

  await assertRealDirectory(request.candidateDir, 'candidateDir');
  for (const mount of request.mounts) await assertRealDirectory(mount.source, `dependency mount source for ${mount.target}`);
  await assertRealDirectory(request.nodeRoot, 'nodeRoot');
  try {
    accessSync(join(request.nodeRoot, 'bin', 'node'), fsConstants.X_OK);
  } catch {
    throw invalid(`nodeRoot has no executable bin/node: ${request.nodeRoot}`);
  }
  const tempRoot = await resolveTempRoot(options.tempRoot);
  if (tempRoot === request.candidateDir || tempRoot.startsWith(`${request.candidateDir}/`)) {
    throw invalid('tempRoot must not be inside candidateDir');
  }

  let scratch;
  try {
    scratch = await mkdtemp(join(tempRoot, 'tinysdd-check-'));
  } catch (error) {
    throw unavailable(`could not create a scratch directory in ${tempRoot}: ${error.code ?? error.message}`);
  }
  try {
    const input = join(scratch, 'input');
    await mkdir(input, { mode: 0o700 });
    await copyDirectory(request.candidateDir, input, { used: 0, limit: request.limits.scratchBytes }).catch((error) => {
      throw copyFailure(error);
    });
    await assertMountPointsFree(input, request.mounts);

    const { runAs } = request;
    if (runAs.drop) await giveToUser(scratch, runAs.uid, runAs.gid);

    // Measured right before the spawn, so the baseline is as current as it can be.
    const processBaseline = await countUserTasks(runAs.uid);
    const nestedUserns = await nestedUserNamespaces(binaries, runAs);
    const capture = new OutputCapture(request.limits.storedOutputBytes);
    const { command: dropCommand, prefix: dropPrefix } = launcher(binaries, runAs);
    const sandboxArgs = sandboxArguments({
      binaries,
      nodeRoot: request.nodeRoot,
      input,
      mounts: request.mounts,
      limits: request.limits,
      check: request.check,
      processLimit: processBaseline + request.limits.maxProcesses,
      nestedUserns,
    });
    const run = await runSandbox({
      command: dropCommand ?? binaries.prlimit,
      args: dropCommand ? [...dropPrefix, binaries.prlimit, ...sandboxArgs] : sandboxArgs,
      timeoutMs: request.check.timeoutMs,
      capture,
    });
    const setupFailure = sandboxSetupFailure(run, capture.head);
    if (setupFailure) throw unavailable('the check sandbox could not be created; the check did not run', { output: setupFailure });

    return {
      id: request.check.id,
      argv: request.check.argv,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      output: summarizeOutput(capture, request.limits),
      limits: request.limits,
      sandbox: {
        bwrap: binaries.bwrap,
        prlimit: binaries.prlimit,
        network: 'none',
        env: [...SANDBOX_ENV],
        setpriv: binaries.setpriv,
        runAs: { uid: runAs.uid, gid: runAs.gid },
        processBaseline,
        nestedUserNamespaces: nestedUserns,
      },
    };
  } finally {
    await removeScratch(scratch);
  }
}
