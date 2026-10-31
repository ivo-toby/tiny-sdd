import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SYSTEM_READ_ROOTS = ["/System/Library", "/usr/lib", "/usr/share"];
const SYSTEM_READ_FILES = ["/", "/dev/null", "/dev/random", "/dev/urandom", "/private/etc/hosts", "/private/etc/localtime"];

function pathString(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error("Seatbelt paths must be normalized absolute paths without control characters");
  }
  return JSON.stringify(value);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Process queries that can expose another process's credentials (kern.proc.*,
// kern.procargs2) stay denied; these are the plain host facts Node reads.
const SYSCTL_READ = '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))';

function ancestorsOf(paths) {
  const ancestors = new Set();
  for (const path of paths) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  }
  return [...ancestors];
}

/**
 * Build a Seatbelt profile around a runner's executable, program and read, write and private roots.
 * `checkChannel` (requests, responses, extension) is the run_checks channel: the worker may write
 * requests and read responses and the check tool, nothing else of it.
 */
export function buildMacosSandboxProfile({ workspace, sourceRoot, compactionBundle, inferencePort, invocation, checkChannel = null }) {
  const { executable, program } = invocation;
  const channelReadable = checkChannel ? [checkChannel.responses, checkChannel.extension] : [];
  const channelWritable = checkChannel ? [checkChannel.requests] : [];
  const paths = [workspace, ...invocation.writable, sourceRoot, ...invocation.private, compactionBundle, executable, program.path, ...invocation.readable, ...channelReadable, ...channelWritable].filter(Boolean);
  for (const path of paths) pathString(path);
  if (!invocation.readable.some((root) => inside(root, program.path))) throw new Error(`${program.label} must be inside its installed package`);
  for (const path of [...channelReadable, ...channelWritable]) {
    if (inside(workspace, path) || inside(path, workspace)) throw new Error("Seatbelt check channel and candidate must be separate directories");
  }
  const readable = [...SYSTEM_READ_ROOTS, ...invocation.readable, ...(compactionBundle ? [compactionBundle] : []), ...channelReadable];
  const writable = [workspace, ...invocation.writable, ...channelWritable];
  const privateRoots = [sourceRoot, ...invocation.private];
  for (const privateRoot of privateRoots) {
    for (const granted of [...readable, ...writable, executable]) {
      if (inside(granted, privateRoot) || inside(privateRoot, granted)) {
        throw new Error("Seatbelt runtime and temporary paths must not overlap the source project or original Pi state");
      }
    }
  }
  for (const state of invocation.writable) {
    if (inside(workspace, state) || inside(state, workspace)) throw new Error("Seatbelt candidate and Pi state must be separate directories");
  }
  if (!Number.isInteger(inferencePort) || inferencePort < 1 || inferencePort > 65535) throw new Error("Seatbelt requires a valid inference relay port");
  const ancestors = ancestorsOf([...readable, ...writable, executable]);
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${pathString(executable)}))`,
    SYSCTL_READ,
    // Node resolves its installed entry point one parent directory at a time.
    `(allow file-read-metadata ${ancestors.map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    `(allow file-read* ${readable.map((path) => `(subpath ${pathString(path)})`).join(" ")} ${[...SYSTEM_READ_FILES, executable].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${pathString(path)}))`),
    ...writable.map((path) => `(deny file-write-unlink (literal ${pathString(path)}))`),
    `(deny file-read* file-write* ${privateRoots.map((path) => `(subpath ${pathString(path)})`).join(" ")})`,
    `(allow network-outbound (remote ip "localhost:${inferencePort}"))`,
    "",
  ].join("\n");
}

// /bin/sh on macOS is a shim that execs the shell /private/var/select/sh names;
// /private/etc/localtime points into the timezone database.
const CHECK_EXEC_ROOTS = ["/bin", "/usr/bin"];
const CHECK_READ_ROOTS = ["/private/var/db/timezone"];
const CHECK_READ_FILES = ["/private/var/select/sh"];

/**
 * The Seatbelt profile for one declared check. Everything is denied except: reading the
 * system, the shells, the Node installation and the dependency mount sources; reading and
 * writing the check's scratch directory and /dev/null; starting processes from those
 * places; and signalling processes in the same sandbox. There is no network rule, so the
 * check has no network, and nothing grants the source project, home or the worker state.
 */
export function buildMacosCheckProfile({ scratch, nodeRoot, dependencySources = [] }) {
  for (const path of [scratch, nodeRoot, ...dependencySources]) pathString(path);
  for (const path of [nodeRoot, ...dependencySources]) {
    if (inside(scratch, path) || inside(path, scratch)) throw new Error("check scratch directory must not overlap the Node installation or a dependency mount");
  }
  const readOnly = [...SYSTEM_READ_ROOTS, ...CHECK_EXEC_ROOTS, ...CHECK_READ_ROOTS, nodeRoot, ...dependencySources];
  const executable = [...CHECK_EXEC_ROOTS, nodeRoot, ...dependencySources, scratch];
  const subpaths = (paths) => paths.map((path) => `(subpath ${pathString(path)})`).join(" ");
  const literals = (paths) => paths.map((path) => `(literal ${pathString(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec* ${subpaths(executable)})`,
    "(allow signal (target same-sandbox))",
    SYSCTL_READ,
    `(allow file-read-metadata ${literals(ancestorsOf([...readOnly, scratch]))})`,
    `(allow file-read* ${subpaths(readOnly)} ${literals([...SYSTEM_READ_FILES, ...CHECK_READ_FILES])})`,
    `(allow file-read* file-write* (subpath ${pathString(scratch)}) (literal "/dev/null"))`,
    "",
  ].join("\n");
}
