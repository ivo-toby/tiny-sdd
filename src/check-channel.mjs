import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { checkRunnerAvailable, runCheck } from './check-runner.mjs';

const MAX_REQUESTS = 64;
const MAX_REQUEST_BYTES = 1024;
const REQUEST_NAME = /^[a-f0-9]{64}\.json$/u;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const errorResult = (code, message) => ({ error: { code, message } });
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
};

const MAX_IDENTITY_ENTRIES = 20000;
const MAX_IDENTITY_BYTES = 512 * 1024 * 1024;

async function fingerprintDirectory(source) {
  const records = [];
  let bytes = 0;
  let entryCount = 0;
  async function visit(current, prefix = '') {
    // `readdir` is intentionally avoided here: the channel already uses
    // directory handles for its candidate snapshot, and sorted names make the
    // identity independent of filesystem enumeration order.
    const entries = [];
    for await (const entry of await opendir(current)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (++entryCount > MAX_IDENTITY_ENTRIES) throw new Error('dependency mount exceeds the identity entry limit');
      if (info.isDirectory()) {
        records.push({ path, kind: 'directory', mode: info.mode & 0o7777 });
        await visit(absolute, path);
      } else if (info.isFile()) {
        const input = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await input.stat();
          if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('dependency mount changed while fingerprinting');
          const hash = createHash('sha256');
          const buffer = Buffer.alloc(64 * 1024);
          let position = 0;
          while (true) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            position += bytesRead;
            bytes += bytesRead;
            if (bytes > MAX_IDENTITY_BYTES) throw new Error('dependency mount exceeds the identity byte limit');
            hash.update(buffer.subarray(0, bytesRead));
          }
          records.push({ path, kind: 'file', mode: info.mode & 0o7777, bytes: opened.size, sha256: hash.digest('hex') });
        } finally {
          await input.close();
        }
      } else if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolvedTarget = resolve(dirname(absolute), target);
        if (!inside(source, resolvedTarget)) throw new Error(`dependency mount symlink escapes its source: ${path}`);
        records.push({ path, kind: 'symlink', target });
      } else {
        throw new Error(`dependency mount contains an unsupported entry: ${path}`);
      }
    }
  }
  await visit(source);
  const serialized = JSON.stringify(records);
  return {
    algorithm: 'sha256-tree-v1',
    sha256: digest(serialized),
    entries: entryCount,
    bytes,
  };
}

async function readRequest(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REQUEST_BYTES) throw new Error('request must be a bounded regular file');
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REQUEST_BYTES) throw new Error('request is too large');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'checkId')) throw new Error('request may only contain checkId');
    if (value.checkId !== undefined && typeof value.checkId !== 'string') throw new Error('checkId must be a string');
    return value;
  } finally { await handle.close(); }
}

async function freezeCandidate(source, destination, excluded, allowedPaths, signal, deadline) {
  let bytes = 0;
  let files = 0;
  const allowedDigests = Object.fromEntries(allowedPaths.map((path) => [path, null]));
  async function visit(relative = '', directoryPath = source) {
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : join(source, relative);
      if (process.platform !== 'linux' && await realpath(anchored) !== anchored) throw new Error('check input resolves through a symlink');
      await mkdir(join(destination, relative), { recursive: true, mode: 0o700 });
      for await (const entry of await opendir(anchored)) {
        if (signal.aborted || Date.now() >= deadline) throw Object.assign(new Error('check snapshot cancelled'), { code: 'CHECK_DEADLINE' });
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded.some((mount) => path === mount || path.startsWith(`${mount}/`))) continue;
        if (++files > 20000) throw new Error('check input exceeds file limit');
        const from = join(anchored, entry.name);
        const info = await lstat(from);
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(path, from);
        else if (info.isFile()) {
          const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const output = await open(join(destination, path), 'wx', info.mode & 0o777);
          try {
            const opened = await input.stat();
            if (!opened.isFile() || info.ino !== opened.ino || info.dev !== opened.dev || bytes + opened.size > 512 * 1024 * 1024) throw new Error('check input changed or exceeds copy limit');
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(64 * 1024);
            let position = 0;
            while (true) {
              if (signal.aborted || Date.now() >= deadline) throw Object.assign(new Error('check snapshot cancelled'), { code: 'CHECK_DEADLINE' });
              const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
              if (!bytesRead) break;
              position += bytesRead;
              bytes += bytesRead;
              if (bytes > 512 * 1024 * 1024) throw new Error('check input exceeds copy limit');
              const data = buffer.subarray(0, bytesRead);
              hash.update(data);
              await output.writeFile(data);
            }
            if (Object.hasOwn(allowedDigests, path)) allowedDigests[path] = hash.digest('hex');
          } finally { await input.close(); await output.close(); }
        } else throw new Error('check input contains a symlink or special file');
      }
    } finally { await directory.close(); }
  }
  await visit();
  return allowedDigests;
}

export async function createCheckChannel({ manifest, sourceRoot, workspace, artifactDir, tempRoot, allowedPaths, maxCheckRuns, runner = runCheck, nodeRoot }) {
  for (const [index, target] of manifest.dependencyMounts.entries()) {
    for (const other of manifest.dependencyMounts.slice(index + 1)) {
      if (overlaps(target, other)) throw new Error(`dependency mount targets must not overlap: ${target}, ${other}`);
    }
  }
  const mounts = [];
  for (const target of manifest.dependencyMounts) {
    if (allowedPaths.some((path) => overlaps(target, path))) throw new Error(`dependency mount overlaps an allowed path: ${target}`);
    const source = join(sourceRoot, target);
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(source) !== source) throw new Error(`dependency mount must be a real directory: ${target}`);
    mounts.push({ source, target });
  }
  const mountIdentities = [];
  for (const mount of mounts) {
    const tree = await fingerprintDirectory(mount.source);
    mountIdentities.push({ target: mount.target, source: mount.source, ...tree });
  }
  const dependencyIdentity = {
    algorithm: 'sha256-mounts-v1',
    provenance: 'live-source-root',
    mounts: mountIdentities,
    sha256: digest(JSON.stringify(mountIdentities.map(({ target, algorithm, sha256, entries, bytes }) => ({ target, algorithm, sha256, entries, bytes })))),
  };
  const root = await mkdtemp(join(tempRoot, 'tinysdd-channel-'));
  const requests = join(root, 'requests');
  const responses = join(root, 'responses');
  await mkdir(requests, { mode: 0o700 });
  await mkdir(responses, { mode: 0o700 });
  const extension = join(root, 'run-checks.mjs');
  await copyFile(new URL('./run-checks-extension.mjs', import.meta.url), extension);
  const identities = await Promise.all([requests, responses].map((path) => lstat(path)));
  const logPath = join(artifactDir, 'checks.jsonl');
  await writeFile(logPath, '', { mode: 0o600 });
  const seen = new Map();
  const replayed = new Set();
  const runs = [];
  const abort = new AbortController();
  let queue = Promise.resolve();
  let busy = false;
  let closed = false;
  let deadline = 0;
  let count = 0;
  let failure = null;
  async function log(record) {
    const line = `${JSON.stringify(record)}\n`;
    await writeFile(logPath, line, { flag: 'a', mode: 0o600 });
    runs.push(record);
  }
  async function respond(name, response) {
    const temporary = join(responses, `${name}.tmp`);
    await writeFile(temporary, JSON.stringify(response), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(responses, name));
  }
  async function handle(name) {
    const correlationId = name.slice(0, -5);
    const requestedAt = new Date().toISOString();
    let request;
    try { request = await readRequest(join(requests, name)); }
    catch { const response = errorResult('CHECK_REQUEST_INVALID', 'malformed check request'); await log({ correlationId, requestedAt, ...response }); await respond(name, response); return; }
    const checks = request.checkId === undefined ? manifest.checks : manifest.checks.filter((check) => check.id === request.checkId);
    if (!checks.length) { const response = errorResult('CHECK_UNKNOWN_ID', 'check id is not declared'); await log({ correlationId, requestedAt, checkId: request.checkId, ...response }); await respond(name, response); return; }
    const results = [];
    let error;
    for (const declaration of checks) {
      let record = { correlationId, requestedAt, checkId: declaration.id, argvSha256: digest(JSON.stringify(declaration.argv)) };
      const remaining = deadline - Date.now();
      if (count >= maxCheckRuns || remaining < 1000 || abort.signal.aborted) {
        error = errorResult(count >= maxCheckRuns ? 'CHECK_BUDGET_EXHAUSTED' : 'CHECK_DEADLINE', count >= maxCheckRuns ? 'check run budget exhausted' : 'worker deadline or cancellation prevents a check');
        await log({ ...record, ...error });
        break;
      }
      count += 1;
      let scratch;
      try {
        if (runner === runCheck) {
          const availability = checkRunnerAvailable();
          if (!availability.available) throw Object.assign(new Error(availability.reason), { code: 'CHECK_RUNNER_UNAVAILABLE' });
        }
        scratch = await mkdtemp(join(tempRoot, 'tinysdd-check-input-'));
        record.allowedFileDigests = await freezeCandidate(workspace, scratch, manifest.dependencyMounts, allowedPaths, abort.signal, deadline);
        const timeoutMs = Math.min(declaration.timeoutMs, deadline - Date.now());
        if (timeoutMs < 1000 || abort.signal.aborted) throw Object.assign(new Error('worker deadline prevents execution'), { code: 'CHECK_DEADLINE' });
        const result = await runner({ candidateDir: scratch, check: { id: declaration.id, argv: declaration.argv, timeoutMs }, dependencyMounts: mounts, nodeRoot, tempRoot, signal: abort.signal });
        const outputPath = join(artifactDir, `check-${count}.txt`);
        await writeFile(outputPath, result.output.text, { mode: 0o600 });
        record = { ...record, run: count, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs, outputPath, outputSha256: digest(result.output.text), tailSha256: digest(result.output.tail), outcome: result.timedOut ? 'timed_out' : result.signal ? 'cancelled' : result.exitCode === 0 ? 'passed' : 'failed', outputBytes: result.output.totalBytes, truncated: result.output.truncated };
        results.push({ checkId: declaration.id, run: count, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs, tail: result.output.tail, truncated: result.output.totalBytes > Buffer.byteLength(result.output.tail) });
      } catch (caught) {
        error = errorResult(caught.code ?? 'CHECK_INVALID', String(caught.message).slice(0, 512));
        record = { ...record, run: count, ...error };
      } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
      await log(record);
      if (error) break;
    }
    await respond(name, { results, runs: count, maxCheckRuns, ...(error ?? {}) });
  }
  async function scan() {
    for (const [index, path] of [requests, responses].entries()) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== identities[index].ino || info.dev !== identities[index].dev) throw new Error('check channel directory replaced');
    }
    let entries = 0;
    for await (const entry of await opendir(requests)) {
      if (++entries > MAX_REQUESTS * 2) throw new Error('too many outstanding check requests');
      if (entry.name.endsWith('.tmp')) {
        const info = await lstat(join(requests, entry.name)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REQUEST_BYTES) throw new Error('invalid temporary check request');
        continue;
      }
      const info = await lstat(join(requests, entry.name)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (seen.has(entry.name)) {
        if (seen.get(entry.name) !== identity && !replayed.has(entry.name)) {
          replayed.add(entry.name);
          await log({ correlationId: REQUEST_NAME.test(entry.name) ? entry.name.slice(0, -5) : null, error: { code: 'CHECK_REQUEST_REPLAY', message: 'request id already handled' } });
        }
        continue;
      }
      if (seen.size >= MAX_REQUESTS) throw new Error('check request limit exceeded');
      seen.set(entry.name, identity);
      if (!REQUEST_NAME.test(entry.name)) { await log({ error: { code: 'CHECK_REQUEST_INVALID', message: 'invalid request filename' } }); continue; }
      if (closed) break;
      await handle(entry.name);
    }
  }
  return {
    root, requests, responses, extension, logPath, runs,
    mounts, dependencyIdentity,
    start(timeoutMs) { deadline = Date.now() + timeoutMs; },
    poll() {
      if (failure) throw failure;
      if (busy || closed) return;
      busy = true;
      queue = scan().catch(async (error) => { failure = error; abort.abort(); await log({ error: { code: 'CHECK_CHANNEL_FAILED', message: String(error.message).slice(0, 512) } }); }).finally(() => { busy = false; });
    },
    cancel() { closed = true; abort.abort(); },
    async drain() { closed = true; abort.abort(); await queue; },
    async cleanup() { closed = true; abort.abort(); await queue; await rm(root, { recursive: true, force: true }); },
  };
}
