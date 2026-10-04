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

export function buildMacosSandboxProfile({ workspace, stateDir, sourceRoot, sourceAgentDir, compactionBundle, nodeExecutable, piExecutable, piRoot, inferencePort }) {
  const paths = [workspace, stateDir, sourceRoot, sourceAgentDir, compactionBundle, nodeExecutable, piExecutable, piRoot].filter(Boolean);
  for (const path of paths) pathString(path);
  if (!inside(piRoot, piExecutable)) throw new Error("Pi executable must be inside its installed package");
  const readable = [...SYSTEM_READ_ROOTS, piRoot, ...(compactionBundle ? [compactionBundle] : [])];
  const writable = [workspace, stateDir];
  const privateRoots = [sourceRoot, sourceAgentDir];
  for (const privateRoot of privateRoots) {
    for (const granted of [...readable, ...writable, nodeExecutable]) {
      if (inside(granted, privateRoot) || inside(privateRoot, granted)) {
        throw new Error("Seatbelt runtime and temporary paths must not overlap the source project or original Pi state");
      }
    }
  }
  if (inside(workspace, stateDir) || inside(stateDir, workspace)) throw new Error("Seatbelt candidate and Pi state must be separate directories");
  if (!Number.isInteger(inferencePort) || inferencePort < 1 || inferencePort > 65535) throw new Error("Seatbelt requires a valid inference relay port");
  const ancestors = new Set();
  for (const path of [...readable, ...writable, nodeExecutable]) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${pathString(nodeExecutable)}))`,
    // Kernel process queries can expose another process's credentials.
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))',
    // Node resolves its installed entry point one parent directory at a time.
    `(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    `(allow file-read* ${readable.map((path) => `(subpath ${pathString(path)})`).join(" ")} ${[...SYSTEM_READ_FILES, nodeExecutable].map((path) => `(literal ${pathString(path)})`).join(" ")})`,
    ...writable.map((path) => `(allow file-read* file-write* (subpath ${pathString(path)}))`),
    ...writable.map((path) => `(deny file-write-unlink (literal ${pathString(path)}))`),
    `(deny file-read* file-write* ${privateRoots.map((path) => `(subpath ${pathString(path)})`).join(" ")})`,
    `(allow network-outbound (remote ip "localhost:${inferencePort}"))`,
    "",
  ].join("\n");
}
