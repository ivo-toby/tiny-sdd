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

/**
 * Build a Seatbelt profile around a runner's executable, program and read, write and private roots.
 * `checkChannel` is the run_checks channel: the runner loads its extension and reads responses,
 * and may only write requests.
 */
export function buildMacosSandboxProfile({ workspace, sourceRoot, compactionBundle, checkChannel, inferencePort, invocation }) {
  const { executable, program } = invocation;
  const channelReadable = checkChannel ? [checkChannel.extension, checkChannel.responses] : [];
  const channelWritable = checkChannel ? [checkChannel.requests] : [];
  const paths = [workspace, ...invocation.writable, sourceRoot, ...invocation.private, compactionBundle, ...channelReadable, ...channelWritable, executable, program.path, ...invocation.readable].filter(Boolean);
  for (const path of paths) pathString(path);
  if (!invocation.readable.some((root) => inside(root, program.path))) throw new Error(`${program.label} must be inside its installed package`);
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
  for (const state of [...invocation.writable, ...channelReadable, ...channelWritable]) {
    if (inside(workspace, state) || inside(state, workspace)) throw new Error("Seatbelt candidate, Pi state and check channel must be separate directories");
  }
  if (!Number.isInteger(inferencePort) || inferencePort < 1 || inferencePort > 65535) throw new Error("Seatbelt requires a valid inference relay port");
  const ancestors = new Set();
  for (const path of [...readable, ...writable, executable]) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${pathString(executable)}))`,
    // Kernel process queries can expose another process's credentials.
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))',
    // Node resolves its installed entry point one parent directory at a time.
    `(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    `(allow file-read* ${readable.map((path) => `(subpath ${pathString(path)})`).join(" ")} ${[...SYSTEM_READ_FILES, executable].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${pathString(path)}))`),
    ...writable.map((path) => `(deny file-write-unlink (literal ${pathString(path)}))`),
    `(deny file-read* file-write* ${privateRoots.map((path) => `(subpath ${pathString(path)})`).join(" ")})`,
    `(allow network-outbound (remote ip "localhost:${inferencePort}"))`,
    "",
  ].join("\n");
}

// Seatbelt profile for one check run (src/check-runner.mjs): no network, a
// scrubbed spawn environment, the Node executable and dependency mounts
// read-only, and only the scratch work directory plus its home and tmp
// directories writable. `work` holds the host-made copy of the candidate with
// symlinks to the dependency mount sources, so writes outside it are denied.
// Like the Linux runner's /usr and /bin binds, /bin and /usr/bin stay
// executable so shebangs (`#!/usr/bin/env node`), /bin/sh and
// child_process.exec keep working; network stays denied by (deny default).
// Only the Node executable is granted, not its installation root, which is
// /usr/local with the macOS installer. Signals may reach any process in the
// same sandbox: the check's process-group watchdog and test runners that stop
// their own children need that, and nothing outside the sandbox is reachable.
// `docker` (feature acceptance only, never run_checks) grants a unix-socket
// connect to each listed socket path (the declared path and the places it
// resolves to) and TCP to loopback, where Docker publishes container ports,
// plus the user lookup testcontainers needs. Nothing else on the network is
// allowed.
export function buildSeatbeltCheckProfile({ work, home, tmp, nodeExecutable, mounts = [], docker = null }) {
  const writable = [work, home, tmp];
  const writableFiles = ["/dev/null"];
  const readable = [...SYSTEM_READ_ROOTS, "/bin", "/usr/bin", ...mounts.map((mount) => mount.source)];
  const executables = ["/bin", "/usr/bin", work, ...mounts.map((mount) => mount.source)];
  for (const path of [...writable, ...readable, ...executables, nodeExecutable]) pathString(path);
  for (const writablePath of writable) {
    if (writablePath === tmp) continue;
    for (const granted of [...readable, ...executables, nodeExecutable]) {
      // work is executable and writable at once: the check runs scripts from it.
      if (granted === writablePath) continue;
      if (inside(granted, writablePath) || inside(writablePath, granted)) {
        throw new Error("Seatbelt check scratch paths must not overlap the read-only roots");
      }
    }
  }
  const sockets = docker === null ? [] : docker.sockets;
  if (docker !== null && (!Array.isArray(sockets) || sockets.length === 0)) throw new Error("Seatbelt Docker access needs at least one socket path");
  for (const socket of sockets) pathString(socket);
  const ancestors = new Set(["/"]);
  for (const path of [...writable, ...readable, ...executables, nodeExecutable, ...sockets]) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  }
  const node = `(literal ${pathString(nodeExecutable)})`;
  const dockerRules = sockets.length === 0 ? [] : [
    `(allow file-read-metadata ${sockets.map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    `(allow network-outbound ${sockets.map((path) => `(remote unix-socket (path-literal ${pathString(path)}))`).join(" ")})`,
    '(allow network-outbound (remote ip "localhost:*"))',
    // getpwuid (os.userInfo, which testcontainers calls before starting Ryuk)
    // asks Open Directory over this service.
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  ];
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${executables.map((path) => `(subpath ${pathString(path)})`).join(" ")} ${node})`,
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))',
    `(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    `(allow file-read* ${readable.map((path) => `(subpath ${pathString(path)})`).join(" ")} ${node} ${[...SYSTEM_READ_FILES, ...writableFiles].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${pathString(path)}))`),
    ...writableFiles.map((path) => `(allow file-read* file-write* (literal ${pathString(path)}))`),
    ...writable.map((path) => `(deny file-write-unlink (literal ${pathString(path)}))`),
    ...dockerRules,
    "",
  ].join("\n");
}
