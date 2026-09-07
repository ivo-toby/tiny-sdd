#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat, mkdir, open, readFile, readdir, writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPERIMENT = dirname(fileURLToPath(import.meta.url));
const INNER = join(EXPERIMENT, 'verify-inner.mjs');
const BWRAP = '/usr/bin/bwrap';
const DEFAULT_NODE_DIR = '/home/ivo/.local/share/mise/installs/node/24.15.0';
const CLEAN_PATH = '/usr/bin:/bin';
const OVERALL_TIMEOUT_MS = 120_000;
const usage = 'Usage: node verify.mjs <absolute-workspace> <absolute-new-output-dir> <0|1|2|3|4>';

const fail = (message) => { throw new Error(message); };
const info = (error) => error ? {
  name: error.name,
  message: error.message,
  ...(error.code ? { code: error.code } : {}),
} : null;

function within(base, path) {
  const fromBase = relative(base, path);
  return fromBase !== '' && !fromBase.startsWith('..') && !isAbsolute(fromBase);
}

function absoluteSetting(name, fallback) {
  const value = process.env[name] || fallback;
  if (!isAbsolute(value)) fail(`${name} must be absolute`);
  return resolve(value);
}

async function realDirectory(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory: ${path}`);
  return path;
}

async function regularFile(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file: ${path}`);
  return path;
}

async function noSymlinkTree(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) fail(`${label} contains a symlink: ${path}`);
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await noSymlinkTree(join(path, entry), label);
  } else if (!stat.isFile()) fail(`${label} contains an unsupported entry: ${path}`);
}

async function digest(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function fileRecords(root, label) {
  await noSymlinkTree(root, label);
  const files = [];
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else files.push(path);
  }
  await visit(root);
  return Promise.all(files.map(async (path) => ({ path: relative(root, path).split('\\').join('/'), ...(await digest(path)) })));
}

async function inputRecords(workspace, checks, probes) {
  const roots = [
    ['src', join(workspace, 'src')],
    ['tests', join(workspace, 'tests')],
  ];
  const configNames = (await readdir(workspace)).filter((name) => name.startsWith('package') && name.endsWith('.json'))
    .concat(['tsconfig.json', 'vitest.config.ts']);
  const records = [];
  for (const [name, root] of roots) {
    for (const record of await fileRecords(root, name)) records.push({ ...record, path: `${name}/${record.path}` });
  }
  for (const name of [...new Set(configNames)].sort()) {
    const path = join(workspace, name);
    await regularFile(path, `Workspace config ${name}`);
    records.push({ path: name, ...(await digest(path)) });
  }
  const external = {};
  if (checks) external.checks = await fileRecords(checks, 'Checks');
  if (probes) external.probes = await fileRecords(probes, 'Probes');
  return { workspace: records.sort((a, b) => a.path.localeCompare(b.path)), external };
}

function sameRecords(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addMount(args, source, destination, writable = false) {
  args.push(writable ? '--bind' : '--ro-bind', source, destination);
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* already ended */ }
    }
  }
}

async function runBwrap(args, output) {
  const stdoutPath = join(output, 'verifier.stdout.txt');
  const stderrPath = join(output, 'verifier.stderr.txt');
  const stdoutFile = await open(stdoutPath, 'wx', 0o600);
  const stderrFile = await open(stderrPath, 'wx', 0o600);
  const startedAt = Date.now();
  let timedOut = false;
  let spawnError = null;
  let timer;
  let killTimer;
  let child;
  let outcome;
  try {
    outcome = await new Promise((finish) => {
      let settled = false;
      const done = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        finish({ exitCode, signal });
      };
      try {
        child = spawn(BWRAP, args, {
          cwd: output,
          env: { PATH: CLEAN_PATH },
          shell: false,
          detached: true,
          stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
        });
      } catch (error) {
        spawnError = info(error);
        done(null, null);
        return;
      }
      child.once('error', (error) => { spawnError = info(error); });
      child.once('close', (exitCode, signal) => done(exitCode, signal));
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 1_000);
      }, OVERALL_TIMEOUT_MS);
    });
  } finally {
    await stdoutFile.close();
    await stderrFile.close();
  }
  return {
    executable: BWRAP,
    argv: [BWRAP, ...args],
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    spawnError,
    elapsedMs: Date.now() - startedAt,
    stdout: stdoutPath,
    stderr: stderrPath,
    stdoutBytes: (await readFile(stdoutPath)).byteLength,
    stderrBytes: (await readFile(stderrPath)).byteLength,
  };
}

async function main(argv) {
  if (argv.length !== 3 || !argv.every((value, index) => index === 2 || isAbsolute(value))) fail(usage);
  const stage = Number(argv[2]);
  if (!Number.isInteger(stage) || stage < 0 || stage > 4) fail('Stage must be 0 through 4');
  const workspace = resolve(argv[0]);
  const output = resolve(argv[1]);
  await realDirectory(workspace, 'Workspace');
  const outputRelative = relative(workspace, output);
  const outputInWorkspace = within(workspace, output);
  if (outputInWorkspace && !(outputRelative === '.verification' || outputRelative.startsWith('.verification/'))) {
    fail('Output inside workspace must be under .verification');
  }
  if (within(workspace, output) && (within(join(workspace, 'src'), output)
    || within(join(workspace, 'tests'), output))) fail('Output overlaps source or tests');
  const outputParent = dirname(output);
  try { await realDirectory(outputParent, 'Output parent'); }
  catch (error) {
    if (error?.code !== 'ENOENT' || outputParent !== join(workspace, '.verification')) throw error;
    await mkdir(outputParent, { recursive: false, mode: 0o700 });
  }
  try { await lstat(output); fail(`Refusing existing output directory: ${output}`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }

  const dependencies = absoluteSetting('TINYSDD_DEPENDENCIES_DIR', join(workspace, 'node_modules'));
  const nodeDir = absoluteSetting('TINYSDD_NODE_DIR', DEFAULT_NODE_DIR);
  await regularFile(join(workspace, 'package.json'), 'Workspace package.json');
  await realDirectory(dependencies, 'Dependencies');
  await realDirectory(nodeDir, 'Node installation');
  await regularFile(join(nodeDir, 'bin', 'node'), 'Node executable');
  await regularFile(INNER, 'Verifier inner script');

  const checks = stage > 0
    ? absoluteSetting('TINYSDD_CHECKS_DIR', join(EXPERIMENT, 'checks')) : null;
  if (checks) {
    await realDirectory(checks, 'Checks');
    const names = stage >= 3 ? ['jobs.test.mjs', 'factories.test.mjs', 'http.test.mjs']
      : stage === 2 ? ['jobs.test.mjs', 'factories.test.mjs'] : ['jobs.test.mjs'];
    for (const name of names) await regularFile(join(checks, name), `Check ${name}`);
    if (within(checks, output)) fail('Output overlaps checks');
  }
  const probes = process.env.TINYSDD_PROBE_DIR
    ? absoluteSetting('TINYSDD_PROBE_DIR', process.env.TINYSDD_PROBE_DIR) : null;
  if (probes) {
    await realDirectory(probes, 'Probes');
    await regularFile(join(probes, 'jobs-reference.mjs'), 'Jobs reference probe');
    await regularFile(join(probes, 'http-reference.mjs'), 'HTTP reference probe');
    await noSymlinkTree(probes, 'Probes');
    if (within(probes, output)) fail('Output overlaps probes');
  }
  if (within(dependencies, output) || within(nodeDir, output)) fail('Output overlaps mounted dependency input');

  const before = await inputRecords(workspace, checks, probes);
  await mkdir(output, { recursive: false, mode: 0o700 });

  const args = [
    '--unshare-user', '--unshare-net', '--unshare-pid', '--die-with-parent',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin', '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/work', '--dir', '/home/sandbox',
  ];
  addMount(args, join(workspace, 'src'), '/work/src');
  addMount(args, join(workspace, 'tests'), '/work/tests');
  addMount(args, dependencies, '/work/node_modules');
  for (const cache of ['.vite', '.vite-temp', '.cache']) {
    try {
      const stat = await lstat(join(dependencies, cache));
      if (stat.isDirectory() && !stat.isSymbolicLink()) args.push('--tmpfs', `/work/node_modules/${cache}`);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const packageNames = (await readdir(workspace)).filter((name) => name.startsWith('package') && name.endsWith('.json'));
  for (const name of [...new Set(packageNames)].sort()) addMount(args, join(workspace, name), `/work/${name}`);
  addMount(args, join(workspace, 'tsconfig.json'), '/work/tsconfig.json');
  addMount(args, join(workspace, 'vitest.config.ts'), '/work/vitest.config.ts');
  // Keep node:test oracles outside Vitest's recursive project discovery.
  if (checks) {
    addMount(args, checks, '/checks');
    addMount(args, dependencies, '/node_modules');
  }
  if (probes) addMount(args, probes, '/probes');
  addMount(args, INNER, '/verify-inner.mjs');
  addMount(args, output, '/evidence', true);
  args.push(
    '--ro-bind', nodeDir, '/opt/node', '--chdir', '/work', '--clearenv',
    '--setenv', 'HOME', '/home/sandbox', '--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin',
    '--setenv', 'NODE_ENV', 'test', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'NPM_CONFIG_CACHE', '/tmp/npm-cache', '--setenv', 'NPM_CONFIG_UPDATE_NOTIFIER', 'false',
    '--setenv', 'NPM_CONFIG_FUND', 'false', '--setenv', 'NPM_CONFIG_AUDIT', 'false',
    '--setenv', 'TINYSDD_CANDIDATE_DIR', '/work/dist', '--setenv', 'TINYSDD_BASELINE_DIR', '/work/dist',
    '--setenv', 'TINYSDD_DEPENDENCIES_DIR', '/work/node_modules', '--setenv', 'TINYSDD_NODE_DIR', '/opt/node',
  );
  if (checks) args.push('--setenv', 'TINYSDD_CHECKS_DIR', '/checks');
  if (probes) args.push('--setenv', 'TINYSDD_PROBE_DIR', '/probes');
  if (process.env.TINYSDD_PROBE_MUTANT) args.push('--setenv', 'TINYSDD_PROBE_MUTANT', process.env.TINYSDD_PROBE_MUTANT);
  args.push('/opt/node/bin/node', '/verify-inner.mjs', String(stage));

  const sandbox = await runBwrap(args, output);
  let inner = null;
  let innerError = null;
  try { inner = JSON.parse(await readFile(join(output, 'inner-result.json'), 'utf8')); }
  catch (error) { innerError = info(error); }
  let after;
  let afterError = null;
  try { after = await inputRecords(workspace, checks, probes); }
  catch (error) { afterError = info(error); after = null; }
  const preserved = after !== null && sameRecords(before, after);
  const overallPass = sandbox.exitCode === 0 && sandbox.signal === null && !sandbox.timedOut
    && !sandbox.spawnError && inner?.overallPass === true && preserved;
  const result = {
    schemaVersion: 1,
    kind: 'podcast-async-verification',
    workspace,
    output,
    stage,
    node: { launcher: process.execPath, launcherVersion: process.version, sandbox: join('/opt/node', 'bin/node') },
    inputs: {
      dependencies,
      nodeDir,
      checks,
      probes,
      before,
      after,
      afterError,
      preserved,
    },
    limits: { overallTimeoutMs: OVERALL_TIMEOUT_MS },
    bwrap: { executable: BWRAP, argv: [BWRAP, ...args], launcherEnv: { PATH: CLEAN_PATH } },
    sandbox,
    inner: inner ?? { error: innerError },
    pass: { sandbox: sandbox.exitCode === 0 && sandbox.signal === null && !sandbox.timedOut && !sandbox.spawnError, inner: inner?.overallPass === true, inputsPreserved: preserved, overall: overallPass },
  };
  await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, stage, pass: result.pass, sandbox: { exitCode: sandbox.exitCode, signal: sandbox.signal, timedOut: sandbox.timedOut } }));
  if (!overallPass) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  console.error(usage);
  process.exitCode = 1;
});
