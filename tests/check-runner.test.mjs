import { afterEach, after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CHECK_LIMIT_DEFAULTS, checkRunnerAvailable, runCheck } from '../src/check-runner.mjs';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

// The runner needs Linux, bwrap and prlimit. A host that has the binaries but
// forbids user namespaces is skipped too, instead of failing every test.
async function skipReason() {
  const availability = checkRunnerAvailable();
  if (!availability.available) return `check runner unavailable: ${availability.reason}`;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-check-probe-'));
  try {
    await runCheck({ candidateDir: root, check: { id: 'probe', argv: ['node', '-e', '0'], timeoutMs: 30000 } });
    return false;
  } catch (error) {
    if (error?.code === 'CHECK_RUNNER_UNAVAILABLE') return `check sandbox cannot start here: ${error.message} ${error.details?.output ?? ''}`.trim();
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SKIP = await skipReason();

const PASSING_TEST = "import test from 'node:test';\ntest('adds', () => { if (1 + 1 !== 2) throw new Error('math'); });\n";
const VALID_CHECK = { id: 'c1', argv: ['node', '--test', 't.test.mjs'], timeoutMs: 30000 };
const FAILING_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails on purpose', () => { assert.equal(1 + 1, 3, 'two plus one is three'); });\n";

describe('check runner', { skip: SKIP }, () => {
  let fixtures;
  let scratchRoot;
  let counter = 0;

  before(async () => {
    fixtures = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-check-runner-'));
    scratchRoot = join(fixtures, 'scratch');
    await mkdir(scratchRoot);
  });

  after(async () => {
    await rm(fixtures, { recursive: true, force: true });
  });

  // Every run, successful or refused, must remove its scratch copy.
  afterEach(async () => {
    assert.deepEqual(await readdir(scratchRoot), [], 'scratch directories were left behind');
  });

  // files: path -> content, or { content, mode }.
  async function makeDir(files = {}) {
    counter += 1;
    const root = join(fixtures, `fixture-${counter}`);
    await mkdir(root);
    for (const [path, entry] of Object.entries(files)) {
      const { content, mode } = typeof entry === 'string' ? { content: entry } : entry;
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      if (mode !== undefined) await chmod(target, mode);
    }
    return root;
  }

  async function stubExecutable(script) {
    counter += 1;
    const path = join(fixtures, `stub-${counter}.sh`);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }

  function run(candidateDir, check, extra = {}) {
    return runCheck({
      candidateDir,
      check: { id: 'c1', argv: ['node', '--test', 't.test.mjs'], timeoutMs: 30000, ...check },
      tempRoot: scratchRoot,
      ...extra,
    });
  }

  async function snapshot(root, prefix = '') {
    const files = {};
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        files[`${path}/`] = null;
        Object.assign(files, await snapshot(join(root, entry.name), `${path}/`));
      } else {
        files[path] = await readFile(join(root, entry.name), 'utf8');
      }
    }
    return files;
  }

  // Total size of the regular files below a directory, tolerant of entries that vanish.
  async function treeBytes(root) {
    let total = 0;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) total += await treeBytes(path);
      else total += await stat(path).then((info) => info.size, () => 0);
    }
    return total;
  }

  async function processesMatching(token) {
    const found = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if ((await readFile(`/proc/${entry}/cmdline`, 'utf8')).includes(token)) found.push(entry);
      } catch {
        // The process exited while it was being listed.
      }
    }
    return found;
  }

  test('a passing node:test file exits 0 and reports the sandbox it ran in', async () => {
    const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
    const result = await run(candidate, {});
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.id, 'c1');
    assert.deepEqual(result.argv, ['node', '--test', 't.test.mjs']);
    assert.match(result.output.text, /# pass 1/u);
    assert.equal(result.output.truncated, false);
    assert.equal(result.output.storedBytes, result.output.totalBytes);
    assert.equal(result.output.tail, result.output.text);
    assert.deepEqual(result.limits, CHECK_LIMIT_DEFAULTS);
    assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
    assert.equal(CHECK_LIMIT_DEFAULTS.scratchBytes, 512 * MIB);
    assert.equal(CHECK_LIMIT_DEFAULTS.maxProcesses, 512);
    assert.deepEqual(result.sandbox, {
      bwrap: result.sandbox.bwrap,
      prlimit: result.sandbox.prlimit,
      network: 'none',
      env: ['PATH', 'HOME', 'CI', 'LANG', 'PWD'],
      processBaseline: result.sandbox.processBaseline,
      processLimitEnforced: process.getuid() !== 0,
      nestedUserNamespaces: result.sandbox.nestedUserNamespaces,
    });
    assert.ok(Number.isInteger(result.sandbox.processBaseline) && result.sandbox.processBaseline >= 1);
    assert.ok(['disabled', 'allowed'].includes(result.sandbox.nestedUserNamespaces));
  });

  test('a failing test exits non-zero and its failure text is in the tail', async () => {
    const candidate = await makeDir({ 't.test.mjs': FAILING_TEST });
    const result = await run(candidate, {});
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.output.tail, /fails on purpose/u);
    assert.match(result.output.tail, /two plus one is three/u);
  });

  test('stdout and stderr both land in the combined output', async () => {
    const candidate = await makeDir({ 'both.mjs': "console.log('to-stdout'); console.error('to-stderr'); process.exit(4);\n" });
    const result = await run(candidate, { argv: ['node', 'both.mjs'] });
    assert.equal(result.exitCode, 4);
    assert.match(result.output.text, /to-stdout/u);
    assert.match(result.output.text, /to-stderr/u);
  });

  test('the sandbox has no network: a listener on the host sees no connection', async () => {
    let connections = 0;
    const server = createServer((request, response) => response.end('reached'));
    server.on('connection', () => { connections += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      const candidate = await makeDir({
        'net.mjs': [
          "import { writeFileSync } from 'node:fs';",
          'try {',
          '  const response = await fetch(process.argv[2]);',
          "  writeFileSync('/work/reached.txt', String(response.status));",
          "  console.log('REACHED', response.status);",
          '} catch (error) {',
          "  console.log('fetch failed', error.cause?.code ?? error.message);",
          '  process.exit(7);',
          '}',
          '',
        ].join('\n'),
      });
      const result = await run(candidate, { argv: ['node', 'net.mjs', url] });
      assert.equal(result.exitCode, 7);
      assert.match(result.output.text, /fetch failed/u);
      assert.doesNotMatch(result.output.text, /REACHED/u);
      assert.equal(connections, 0);

      // The listener is reachable from the host, so zero connections above is the sandbox's doing.
      const response = await fetch(url);
      assert.equal(await response.text(), 'reached');
      assert.equal(connections, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('the sandbox inherits no environment from the host', async () => {
    const previous = process.env.TINYSDD_SECRET_PROBE;
    process.env.TINYSDD_SECRET_PROBE = 'x';
    try {
      const candidate = await makeDir({ 'env.mjs': 'console.log(JSON.stringify(process.env));\n' });
      const result = await run(candidate, { argv: ['node', 'env.mjs'] });
      assert.equal(result.exitCode, 0);
      const environment = JSON.parse(result.output.text.trim());
      assert.equal(environment.TINYSDD_SECRET_PROBE, undefined);
      assert.doesNotMatch(result.output.text, /TINYSDD_SECRET_PROBE/u);
      // The four documented values, plus the PWD that bwrap adds for --chdir.
      assert.deepEqual(environment, {
        CI: '1',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        PATH: '/opt/node/bin:/usr/bin:/bin',
        PWD: '/work',
      });
      assert.deepEqual(Object.keys(environment).sort(), [...result.sandbox.env].sort());
    } finally {
      if (previous === undefined) delete process.env.TINYSDD_SECRET_PROBE;
      else process.env.TINYSDD_SECRET_PROBE = previous;
    }
  });

  test('the sandbox holds no capabilities and cannot see host processes', async () => {
    const candidate = await makeDir({
      'caps.mjs': [
        "import { readFileSync, readdirSync } from 'node:fs';",
        "const status = readFileSync('/proc/self/status', 'utf8');",
        "console.log(status.split('\\n').filter((line) => /^Cap(Eff|Prm|Bnd)/.test(line)).join('|'));",
        "console.log('pids', readdirSync('/proc').filter((name) => /^\\d+$/.test(name)).length);",
        '',
      ].join('\n'),
    });
    const result = await run(candidate, { argv: ['node', 'caps.mjs'] });
    assert.equal(result.exitCode, 0);
    assert.match(result.output.text, /CapPrm:\t0+\|CapEff:\t0+\|CapBnd:\t0+/u);
    // bwrap's init and the check itself; the host's processes are not visible.
    const visible = Number(/pids (\d+)/u.exec(result.output.text)[1]);
    assert.ok(visible >= 1 && visible <= 3, `${visible} processes visible`);
  });

  test('dependency mounts are read-only and the mount source is untouched', async () => {
    const dependencies = await makeDir({ 'pkg/index.js': 'module.exports = 42;\n' });
    const before = await snapshot(dependencies);
    const candidate = await makeDir({
      'write.mjs': [
        "import { writeFileSync } from 'node:fs';",
        'try {',
        "  writeFileSync('/work/node_modules/pkg/x', '1');",
        "  console.log('WROTE');",
        '} catch (error) {',
        "  console.log('write failed', error.code);",
        '  process.exit(5);',
        '}',
        '',
      ].join('\n'),
      'overwrite.mjs': [
        "import { writeFileSync, rmSync } from 'node:fs';",
        "const outcomes = [];",
        "for (const action of [() => writeFileSync('/work/node_modules/pkg/index.js', 'changed'), () => rmSync('/work/node_modules/pkg/index.js')]) {",
        "  try { action(); outcomes.push('done'); } catch (error) { outcomes.push(error.code); }",
        '}',
        'console.log(outcomes.join(","));',
        '',
      ].join('\n'),
    });
    const mounts = [{ source: dependencies, target: 'node_modules' }];

    const created = await run(candidate, { argv: ['node', 'write.mjs'] }, { dependencyMounts: mounts });
    assert.equal(created.exitCode, 5);
    assert.match(created.output.text, /write failed EROFS/u);
    assert.doesNotMatch(created.output.text, /WROTE/u);

    const changed = await run(candidate, { argv: ['node', 'overwrite.mjs'] }, { dependencyMounts: mounts });
    assert.equal(changed.output.text.trim(), 'EROFS,EROFS');

    assert.deepEqual(await snapshot(dependencies), before);
  });

  test('an executable inside a dependency mount runs, and the mounted package resolves', async () => {
    const dependencies = await makeDir({
      '.bin/tool': { content: '#!/usr/bin/env node\nconsole.log("tool ran", process.argv.slice(2).join(","), "pkg", require("pkg"));\n', mode: 0o755 },
      'pkg/index.js': 'module.exports = 42;\n',
    });
    const candidate = await makeDir({});
    const result = await run(candidate, { argv: ['node_modules/.bin/tool', 'a', 'b'] }, { dependencyMounts: [{ source: dependencies, target: 'node_modules' }] });
    assert.equal(result.exitCode, 0, result.output.text);
    assert.equal(result.output.text.trim(), 'tool ran a,b pkg 42');
  });

  test('a nested mount target is created inside the scratch copy', async () => {
    const dependencies = await makeDir({ 'pkg/index.js': 'module.exports = 7;\n' });
    const candidate = await makeDir({ 'packages/a/src.mjs': "import { createRequire } from 'node:module';\nconsole.log(createRequire(import.meta.url)('pkg'));\n" });
    const result = await run(candidate, { argv: ['node', 'packages/a/src.mjs'] }, { dependencyMounts: [{ source: dependencies, target: 'packages/a/node_modules' }] });
    assert.equal(result.exitCode, 0, result.output.text);
    assert.equal(result.output.text.trim(), '7');
  });

  test('the candidate is copied faithfully, and the source is never modified', async () => {
    const files = {
      'data.txt': 'original\n',
      'sub/keep.txt': 'keep\n',
      'deep/er/file.txt': 'deep\n',
      'exec.sh': { content: '#!/bin/sh\n', mode: 0o755 },
      'mutate.mjs': [
        "import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';",
        "if (existsSync('/work/new.txt')) { console.log('DIRTY'); process.exit(3); }",
        "mkdirSync('/work/emptydir', { recursive: true });",
        "console.log('copy', readFileSync('/work/deep/er/file.txt', 'utf8').trim(), statSync('/work/exec.sh').mode & 0o100);",
        "writeFileSync('/work/data.txt', 'changed');",
        "writeFileSync('/work/new.txt', 'new');",
        "rmSync('/work/sub', { recursive: true });",
        "console.log('now', readFileSync('/work/data.txt', 'utf8'));",
        '',
      ].join('\n'),
    };
    const candidate = await makeDir(files);
    await mkdir(join(candidate, 'empty'));
    const before = await snapshot(candidate);
    const modeBefore = (await stat(join(candidate, 'exec.sh'))).mode;

    const first = await run(candidate, { argv: ['node', 'mutate.mjs'] });
    assert.equal(first.exitCode, 0, first.output.text);
    assert.match(first.output.text, /copy deep 64/u);
    assert.match(first.output.text, /now changed/u);
    assert.deepEqual(await snapshot(candidate), before);
    assert.equal((await stat(join(candidate, 'exec.sh'))).mode, modeBefore);

    // A second run starts from a fresh copy, not from what the first one left.
    const second = await run(candidate, { argv: ['node', 'mutate.mjs'] });
    assert.equal(second.exitCode, 0, second.output.text);
    assert.doesNotMatch(second.output.text, /DIRTY/u);
    assert.deepEqual(await snapshot(candidate), before);
  });

  test('the host copy is mounted read-only at /input and /work is a separate tmpfs', async () => {
    const candidate = await makeDir({
      't.test.mjs': PASSING_TEST,
      'probe.mjs': [
        "import { readFileSync, writeFileSync, readdirSync } from 'node:fs';",
        'const outcomes = [];',
        "for (const action of [() => writeFileSync('/input/new.txt', 'x'), () => writeFileSync('/input/t.test.mjs', 'x')]) {",
        "  try { action(); outcomes.push('wrote'); } catch (error) { outcomes.push(error.code); }",
        '}',
        "console.log(outcomes.join(','), readFileSync('/input/t.test.mjs', 'utf8') === readFileSync('/work/t.test.mjs', 'utf8'));",
        "writeFileSync('/work/t.test.mjs', 'changed in /work');",
        "console.log(readFileSync('/input/t.test.mjs', 'utf8').startsWith('import test'), readdirSync('/work').includes('probe.mjs'));",
        '',
      ].join('\n'),
    });
    const result = await run(candidate, { argv: ['node', 'probe.mjs'] });
    assert.equal(result.exitCode, 0, result.output.text);
    assert.equal(result.output.text, 'EROFS,EROFS true\ntrue true\n');
  });

  test('/work is size-limited while the check runs, and the host copy never grows', async () => {
    const script = [
      "import { writeFileSync } from 'node:fs';",
      'const chunk = Buffer.alloc(64 * 1024 * 1024, 1);',
      'let written = 0;',
      "let code = 'no error';",
      'for (let index = 0; index < 4; index += 1) {',
      '  try {',
      '    writeFileSync(`/work/big${index}`, chunk);',
      '    written += 64;',
      '  } catch (error) {',
      '    code = error.code;',
      '    break;',
      '  }',
      '}',
      'console.log(`written ${written} ${code}`);',
      '',
    ].join('\n');
    const candidate = await makeDir({ 'fill.mjs': script });
    let largest = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        largest = Math.max(largest, await treeBytes(scratchRoot));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    let result;
    try {
      result = await run(candidate, { argv: ['node', 'fill.mjs'] }, { limits: { scratchBytes: 128 * MIB, fileSizeBytes: 128 * MIB } });
    } finally {
      sampling = false;
      await sampler;
    }
    assert.equal(result.exitCode, 0, result.output.text);
    // 64 MiB fit next to the candidate; the next file runs out of space in the tmpfs.
    assert.match(result.output.text, /written 64 ENOSPC/u);
    // What the host holds is the copy of the candidate and nothing the check wrote.
    assert.ok(largest > 0, 'the sampler never saw the host copy');
    assert.ok(largest <= Buffer.byteLength(script), `the host scratch grew to ${largest} bytes`);
  });

  test('a timeout kills the process group and the sandbox, and reports timedOut', async () => {
    const token = `tinysdd-leak-${process.pid}-${Date.now()}`;
    const candidate = await makeDir({
      'loop.mjs': [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[2]], { stdio: 'ignore' });",
        "console.log('spawned');",
        'for (;;) {}',
        '',
      ].join('\n'),
    });
    const started = Date.now();
    const result = await run(candidate, { argv: ['node', 'loop.mjs', token], timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 5000, `returned after ${elapsed} ms`);
    assert.ok(result.exitCode === null || result.signal !== null);
    assert.equal(result.signal, 'SIGKILL');
    assert.match(result.output.text, /spawned/u);

    // Neither the busy loop nor its child may outlive the call.
    let remaining = await processesMatching(token);
    for (let attempt = 0; attempt < 30 && remaining.length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = await processesMatching(token);
    }
    assert.deepEqual(remaining, []);
  });

  test('the address-space limit stops a runaway allocation without a timeout', async () => {
    const candidate = await makeDir({
      'alloc.mjs': [
        'const kept = [];',
        'let mib = 0;',
        'for (;;) {',
        // allocUnsafe only reserves address space, so the host's memory stays free.
        '  kept.push(Buffer.allocUnsafe(256 * 1024 * 1024));',
        '  mib += 256;',
        '  console.log(`allocated ${mib}`);',
        '}',
        '',
      ].join('\n'),
    });
    const result = await run(candidate, { argv: ['node', 'alloc.mjs'], timeoutMs: 60000 }, { limits: { addressSpaceBytes: 3 * 1024 * MIB } });
    assert.equal(result.timedOut, false);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.limits.addressSpaceBytes, 3 * 1024 * MIB);
    // Node started and allocated, and stopped short of the limit.
    const allocated = [...result.output.text.matchAll(/allocated (\d+)/gu)].map((match) => Number(match[1]));
    assert.ok(allocated.length > 0, result.output.text);
    assert.ok(Math.max(...allocated) < 3 * 1024, `allocated ${Math.max(...allocated)} MiB`);
  });

  test('memory-backed mounts are size-limited and /dev is read-only', async () => {
    const candidate = await makeDir({
      'fill.mjs': [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        'const chunk = Buffer.alloc(1024 * 1024, 1);',
        "for (const directory of ['/tmp', '/dev/shm']) {",
        '  let written = 0;',
        '  let code = \'no error\';',
        '  try {',
        '    for (let index = 0; index < 16; index += 1) {',
        "      appendFileSync(`${directory}/fill`, chunk);",
        '      written += 1;',
        '    }',
        '  } catch (error) {',
        '    code = error.code;',
        '  }',
        '  console.log(directory, code, written);',
        '}',
        'try {',
        "  writeFileSync('/dev/new-file', 'x');",
        "  console.log('/dev wrote');",
        '} catch (error) {',
        "  console.log('/dev', error.code);",
        '}',
        '',
      ].join('\n'),
    });
    const result = await run(candidate, { argv: ['node', 'fill.mjs'] }, { limits: { tmpfsBytes: 4 * MIB } });
    assert.equal(result.exitCode, 0, result.output.text);
    assert.match(result.output.text, /^\/tmp ENOSPC 4$/mu);
    assert.match(result.output.text, /^\/dev\/shm ENOSPC 4$/mu);
    assert.match(result.output.text, /^\/dev EROFS$/mu);
  });

  test('the process limit stops a spawn loop', { skip: process.getuid?.() === 0 ? 'RLIMIT_NPROC is not enforced for root' : false }, async () => {
    const candidate = await makeDir({
      'spawn.mjs': [
        "import { spawn } from 'node:child_process';",
        'const children = [];',
        'let failure = null;',
        'for (let index = 0; index < 400 && !failure; index += 1) {',
        "  const child = spawn('/usr/bin/sleep', ['5'], { stdio: 'ignore' });",
        "  child.on('error', (error) => { failure = error; });",
        '  children.push(child);',
        '  await new Promise((resolve) => setTimeout(resolve, 10));',
        '}',
        'await new Promise((resolve) => setTimeout(resolve, 200));',
        "for (const child of children) child.kill('SIGKILL');",
        "console.log('spawned', children.length, failure?.code ?? 'no failure');",
        'process.exit(failure ? 6 : 0);',
        '',
      ].join('\n'),
    });
    // maxProcesses is what the check may add; the runner puts the uid's current
    // task count under it, so this works however busy the account already is.
    const result = await run(candidate, { argv: ['node', 'spawn.mjs'] }, { limits: { maxProcesses: 150 } });
    assert.equal(result.exitCode, 6, result.output.text);
    assert.match(result.output.text, /spawned \d+ EAGAIN/u);
    assert.equal(result.sandbox.processLimitEnforced, true);
    const spawned = Number(/spawned (\d+)/u.exec(result.output.text)[1]);
    assert.ok(spawned > 50 && spawned <= 150, `${spawned} children were spawned`);
  });

  test('a uid that already runs more than maxProcesses tasks can still start a check', { skip: process.getuid?.() === 0 ? 'RLIMIT_NPROC is not enforced for root' : false }, async () => {
    // A fixed limit of 512 would make bwrap fail to start here, which is what a
    // busy desktop account looks like.
    const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
    const sleepers = Array.from({ length: 520 }, () => spawn('/usr/bin/sleep', ['60'], { stdio: 'ignore' }));
    try {
      await Promise.all(sleepers.map((sleeper) => new Promise((resolve) => sleeper.once('spawn', resolve))));
      const result = await run(candidate, {});
      assert.equal(result.exitCode, 0, result.output.text);
      assert.ok(result.sandbox.processBaseline > 512, `baseline ${result.sandbox.processBaseline}`);
    } finally {
      for (const sleeper of sleepers) sleeper.kill('SIGKILL');
    }
  });

  test('the process limit is the uid task count plus maxProcesses, and root is reported as unenforced', async () => {
    const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
    const dump = join(fixtures, `nproc-${counter}.txt`);
    const prlimitPath = await stubExecutable(`printf '%s\\n' "$@" > '${dump}'`);
    const limitOf = async (limits) => {
      const result = await run(candidate, {}, { prlimitPath, limits });
      const nproc = (await readFile(dump, 'utf8')).split('\n').find((line) => line.startsWith('--nproc='));
      return { result, nproc: Number(nproc.slice('--nproc='.length)) };
    };

    const quiet = await limitOf({ maxProcesses: 100 });
    assert.equal(quiet.nproc, quiet.result.sandbox.processBaseline + 100);
    assert.equal(quiet.result.limits.maxProcesses, 100);
    assert.equal(quiet.result.sandbox.processLimitEnforced, process.getuid() !== 0);

    // Other tasks of the same uid, started by the test, raise the baseline.
    const sleepers = Array.from({ length: 40 }, () => spawn('/usr/bin/sleep', ['30'], { stdio: 'ignore' }));
    try {
      const busy = await limitOf({ maxProcesses: 100 });
      assert.equal(busy.nproc, busy.result.sandbox.processBaseline + 100);
      assert.ok(busy.result.sandbox.processBaseline >= quiet.result.sandbox.processBaseline + 30, `${quiet.result.sandbox.processBaseline} -> ${busy.result.sandbox.processBaseline}`);
    } finally {
      for (const sleeper of sleepers) sleeper.kill('SIGKILL');
    }
  });

  test('output is capped: the last stored bytes and a tail with an omission marker', async () => {
    const candidate = await makeDir({
      'big.mjs': [
        "const block = `${'x'.repeat(63)}\\n`.repeat(1024);",
        'for (let index = 0; index < 48; index += 1) process.stdout.write(block);',
        "process.stdout.write('LAST LINE\\n');",
        '',
      ].join('\n'),
    });
    const result = await run(candidate, { argv: ['node', 'big.mjs'] });
    assert.equal(result.exitCode, 0);
    const total = 3 * MIB + 'LAST LINE\n'.length;
    assert.equal(result.output.totalBytes, total);
    assert.equal(result.output.truncated, true);
    assert.equal(result.output.storedBytes, MIB);
    assert.equal(Buffer.byteLength(result.output.text), MIB);
    assert.ok(result.output.text.endsWith('LAST LINE\n'));
    const marker = `[... ${total - 16 * 1024} earlier bytes omitted ...]\n`;
    assert.ok(result.output.tail.startsWith(marker), result.output.tail.slice(0, 80));
    assert.ok(result.output.tail.endsWith('LAST LINE\n'));
    assert.equal(Buffer.byteLength(result.output.tail), Buffer.byteLength(marker) + 16 * 1024);
  });

  test('output limits are overridable and multibyte characters are not split', async () => {
    const candidate = await makeDir({ 'utf.mjs': "process.stdout.write('é'.repeat(100) + '\\n');\n" });
    const result = await run(candidate, { argv: ['node', 'utf.mjs'] }, { limits: { storedOutputBytes: 51, returnedTailBytes: 21 } });
    assert.equal(result.output.totalBytes, 201);
    assert.equal(result.output.truncated, true);
    assert.doesNotMatch(result.output.text, /\uFFFD/u);
    assert.doesNotMatch(result.output.tail, /\uFFFD/u);
    assert.ok(result.output.storedBytes <= 51);
    assert.match(result.output.tail, /^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]\n(é)+\n$/u);
  });

  describe('validation refuses before anything runs', () => {
    // The stub stands in for bwrap and records any invocation: a refusal must
    // leave no marker, and no scratch directory (checked after every test).
    async function assertRefused(message, build) {
      counter += 1;
      const marker = join(fixtures, `invoked-${counter}`);
      const bwrapPath = await stubExecutable(`touch '${marker}'`);
      const options = await build();
      await assert.rejects(runCheck({ tempRoot: scratchRoot, bwrapPath, ...options }), (error) => {
        assert.equal(error.code, 'CHECK_INVALID', error.message);
        assert.match(error.message, message);
        return true;
      });
      await assert.rejects(stat(marker), { code: 'ENOENT' });
    }

    async function withCandidate(overrides = {}) {
      const dependencies = await makeDir({ '.bin/tool': { content: '#!/bin/sh\n', mode: 0o755 } });
      return {
        candidateDir: await makeDir({ 't.test.mjs': PASSING_TEST }),
        check: VALID_CHECK,
        dependencyMounts: [{ source: dependencies, target: 'node_modules' }],
        ...overrides,
      };
    }

    const checkCases = [
      ['a string argv', /argv must be a nonempty array/u, { argv: 'node --test t.test.mjs' }],
      ['an empty argv', /argv must be a nonempty array/u, { argv: [] }],
      ['a non-string argv element', /argv\[1\]/u, { argv: ['node', 3] }],
      ['an empty argv element', /argv\[1\]/u, { argv: ['node', ''] }],
      ['a NUL in argv', /argv\[1\].*NUL/u, { argv: ['node', 'a\0b'] }],
      ['argv[0] outside the mounts', /declared dependency mount/u, { argv: ['scripts/run.sh'] }],
      ['argv[0] a bare command', /declared dependency mount/u, { argv: ['sh', '-c', 'true'] }],
      ['argv[0] absolute', /argv\[0\].*project-relative/u, { argv: ['/usr/bin/env', 'node'] }],
      ['argv[0] with ..', /argv\[0\].*parent/u, { argv: ['node_modules/../t.test.mjs'] }],
      ['argv[0] in .git', /argv\[0\].*\.git/u, { argv: ['node_modules/.git/hook'] }],
      ['argv[0] in .tinysdd', /argv\[0\].*\.tinysdd/u, { argv: ['node_modules/.tinysdd/x'] }],
      ['argv[0] not normalized', /normalized/u, { argv: ['./node_modules/.bin/tool'] }],
      ['argv[0] naming the mount itself', /declared dependency mount/u, { argv: ['node_modules'] }],
      ['a missing id', /check\.id/u, { id: undefined }],
      ['a timeout below 1000 ms', /timeoutMs/u, { timeoutMs: 999 }],
      ['a timeout above 600000 ms', /timeoutMs/u, { timeoutMs: 600001 }],
      ['a fractional timeout', /timeoutMs/u, { timeoutMs: 1500.5 }],
      ['a string timeout', /timeoutMs/u, { timeoutMs: '1500' }],
    ];
    for (const [name, message, override] of checkCases) {
      test(name, () => assertRefused(message, () => withCandidate({ check: { ...VALID_CHECK, ...override } })));
    }

    test('check that is not an object', () => assertRefused(/check must be an object/u, () => withCandidate({ check: 'node' })));

    test('an unknown option, which would otherwise silently drop a mount', () => assertRefused(/unknown key: dependencyMount/u, async () => ({ ...(await withCandidate()), dependencyMount: [] })));

    test('an unknown limit and a non-positive limit', async () => {
      await assertRefused(/unknown key: addressSpaceByte/u, async () => withCandidate({ limits: { addressSpaceByte: 1 } }));
      await assertRefused(/limits\.maxProcesses/u, async () => withCandidate({ limits: { maxProcesses: 0 } }));
      await assertRefused(/limits\.scratchBytes/u, async () => withCandidate({ limits: { scratchBytes: 1.5 } }));
    });

    test('a symlink inside candidateDir', () => assertRefused(/symlink/u, async () => {
      const options = await withCandidate();
      await symlink('/etc/passwd', join(options.candidateDir, 'link'));
      return options;
    }));

    test('a symlink nested in a subdirectory of candidateDir', () => assertRefused(/subdir\/link/u, async () => {
      const options = await withCandidate();
      await mkdir(join(options.candidateDir, 'subdir'));
      await symlink('t.test.mjs', join(options.candidateDir, 'subdir', 'link'));
      return options;
    }));

    test('a special file inside candidateDir', () => assertRefused(/special file/u, async () => {
      const options = await withCandidate();
      await execFileAsync('mkfifo', [join(options.candidateDir, 'pipe')]);
      return options;
    }));

    test('a symlinked candidateDir', () => assertRefused(/candidateDir/u, async () => {
      const options = await withCandidate();
      const link = join(fixtures, `link-${counter}`);
      await symlink(options.candidateDir, link);
      return { ...options, candidateDir: link };
    }));

    test('a candidateDir below a symlinked parent', () => assertRefused(/symlink/u, async () => {
      const options = await withCandidate();
      const parent = join(fixtures, `parent-link-${counter}`);
      await symlink(dirname(options.candidateDir), parent);
      return { ...options, candidateDir: join(parent, options.candidateDir.split('/').pop()) };
    }));

    test('a relative or missing candidateDir', async () => {
      await assertRefused(/absolute/u, async () => withCandidate({ candidateDir: 'relative/dir' }));
      await assertRefused(/not a readable directory/u, async () => withCandidate({ candidateDir: join(fixtures, 'does-not-exist') }));
    });

    test('a candidateDir that exceeds the scratch limit while copying', () => assertRefused(/scratch limit/u, async () => {
      // t.test.mjs takes one page and each .bin two, so the second .bin is over three pages.
      const options = await withCandidate({ limits: { scratchBytes: 3 * 4096 } });
      await writeFile(join(options.candidateDir, 'a.bin'), Buffer.alloc(5000));
      await writeFile(join(options.candidateDir, 'b.bin'), Buffer.alloc(5000));
      return options;
    }));

    test('duplicate and nested mount targets', async () => {
      const first = await makeDir({});
      const second = await makeDir({});
      await assertRefused(/declared twice/u, async () => withCandidate({ dependencyMounts: [{ source: first, target: 'node_modules' }, { source: second, target: 'node_modules' }] }));
      await assertRefused(/must not nest/u, async () => withCandidate({ dependencyMounts: [{ source: first, target: 'node_modules' }, { source: second, target: 'node_modules/inner' }] }));
    });

    test('mount targets that are not clean project-relative paths', async () => {
      const source = await makeDir({});
      for (const target of ['../escape', '/abs', 'a/../b', '.git', 'x/.tinysdd', './node_modules', '']) {
        await assertRefused(/target/u, async () => withCandidate({ dependencyMounts: [{ source, target }] }));
      }
    });

    test('mount sources that are symlinks, relative or missing', async () => {
      const real = await makeDir({});
      const link = join(fixtures, `mount-link-${counter}`);
      await symlink(real, link);
      await assertRefused(/dependency mount source/u, async () => withCandidate({ dependencyMounts: [{ source: link, target: 'node_modules' }] }));
      await assertRefused(/absolute/u, async () => withCandidate({ dependencyMounts: [{ source: 'node_modules', target: 'node_modules' }] }));
      await assertRefused(/not a readable directory/u, async () => withCandidate({ dependencyMounts: [{ source: join(fixtures, 'missing'), target: 'node_modules' }] }));
      await assertRefused(/unknown key: mode/u, async () => withCandidate({ dependencyMounts: [{ source: real, target: 'node_modules', mode: 'rw' }] }));
    });

    // The mount is read-only, so the copy of the candidate cannot be merged
    // into it: anything at the target is refused, a directory included.
    test('a mount target that already exists in candidateDir as a file', () => assertRefused(/already exists in candidateDir: node_modules/u, async () => {
      const options = await withCandidate();
      await writeFile(join(options.candidateDir, 'node_modules'), 'a file, not a directory\n');
      return options;
    }));

    test('a mount target that already exists in candidateDir as a directory', () => assertRefused(/already exists in candidateDir: node_modules/u, async () => {
      const options = await withCandidate();
      await mkdir(join(options.candidateDir, 'node_modules'));
      return options;
    }));

    test('a mount target below a file in candidateDir', () => assertRefused(/below a file in candidateDir/u, async () => {
      const options = await withCandidate();
      await writeFile(join(options.candidateDir, 'packages'), 'a file\n');
      return { ...options, dependencyMounts: [{ source: options.dependencyMounts[0].source, target: 'packages/a/node_modules' }] };
    }));

    test('a candidateDir whose files would not fit the tmpfs once rounded up to pages', () => assertRefused(/scratch limit/u, async () => {
      // 20 one-byte files are 20 bytes, but a tmpfs charges a 4 KiB page for each.
      const options = await withCandidate({ limits: { scratchBytes: 16 * 1024 } });
      for (let index = 0; index < 20; index += 1) await writeFile(join(options.candidateDir, `f${index}.txt`), 'x');
      return options;
    }));

    test('a nodeRoot that is a symlink or has no bin/node', async () => {
      const empty = await makeDir({});
      const link = join(fixtures, `node-link-${counter}`);
      await symlink(dirname(dirname(process.execPath)), link);
      await assertRefused(/nodeRoot/u, async () => ({ ...(await withCandidate()), nodeRoot: link }));
      await assertRefused(/no executable bin\/node/u, async () => ({ ...(await withCandidate()), nodeRoot: empty }));
    });

    test('a tempRoot inside candidateDir, which the copy would recurse into', () => assertRefused(/tempRoot/u, async () => {
      const options = await withCandidate();
      await mkdir(join(options.candidateDir, 'tmp'));
      return { ...options, tempRoot: join(options.candidateDir, 'tmp') };
    }));
  });

  describe('runner availability and sandbox failures', () => {
    test('a missing bwrap or prlimit is CHECK_RUNNER_UNAVAILABLE', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      await assert.rejects(run(candidate, {}, { bwrapPath: '/nonexistent/bwrap' }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
      await assert.rejects(run(candidate, {}, { prlimitPath: '/nonexistent/prlimit' }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
      const notExecutable = join(candidate, 't.test.mjs');
      await assert.rejects(run(candidate, {}, { bwrapPath: notExecutable }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
      await assert.rejects(run(candidate, {}, { bwrapPath: 'bwrap' }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
    });

    test('checkRunnerAvailable says why it is unavailable', async () => {
      assert.deepEqual(checkRunnerAvailable(), { available: true, reason: null });
      const missing = checkRunnerAvailable({ bwrapPath: '/nonexistent/bwrap' });
      assert.equal(missing.available, false);
      assert.match(missing.reason, /bubblewrap.*\/nonexistent\/bwrap/u);
      const noPrlimit = checkRunnerAvailable({ prlimitPath: '/nonexistent/prlimit' });
      assert.equal(noPrlimit.available, false);
      assert.match(noPrlimit.reason, /prlimit.*\/nonexistent\/prlimit/u);
      const directory = checkRunnerAvailable({ bwrapPath: fixtures });
      assert.equal(directory.available, false);
    });

    test('the runner is unavailable off Linux', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const availability = checkRunnerAvailable();
        assert.equal(availability.available, false);
        assert.match(availability.reason, /requires Linux/u);
        await assert.rejects(run(candidate, {}), { code: 'CHECK_RUNNER_UNAVAILABLE' });
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    test('a sandbox that cannot be built is CHECK_RUNNER_UNAVAILABLE, not a failed check', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const bwrapPath = await stubExecutable("echo 'bwrap: No permissions to create new namespace' >&2\nexit 1");
      await assert.rejects(run(candidate, {}, { bwrapPath }), (error) => {
        assert.equal(error.code, 'CHECK_RUNNER_UNAVAILABLE');
        assert.match(error.details.output, /No permissions to create new namespace/u);
        return true;
      });
      const prlimitPath = await stubExecutable("echo 'prlimit: failed to set the AS resource limit: Operation not permitted' >&2\nexit 1");
      await assert.rejects(run(candidate, {}, { prlimitPath }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
    });

    test('a check command that does not exist is a failed check, not a setup failure', async () => {
      const dependencies = await makeDir({ 'pkg/index.js': 'module.exports = 1;\n' });
      const candidate = await makeDir({});
      const result = await run(candidate, { argv: ['node_modules/.bin/missing'] }, { dependencyMounts: [{ source: dependencies, target: 'node_modules' }] });
      assert.equal(result.exitCode, 127);
      assert.match(result.output.text, /node_modules\/\.bin\/missing: not found/u);
    });

    test('a wrapper copy failure (exit 125 with the tinysdd-setup prefix) is a setup failure', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const message = 'tinysdd-setup: copying the candidate into the sandbox failed: cp: error writing /work/x: No space left on device';
      const failing = await stubExecutable(`echo '${message}' >&2\nexit 125`);
      await assert.rejects(run(candidate, {}, { bwrapPath: failing }), (error) => {
        assert.equal(error.code, 'CHECK_RUNNER_UNAVAILABLE');
        assert.match(error.details.output, /No space left on device/u);
        return true;
      });
      // The same text from a check that exited differently is just that check's output.
      const other = await stubExecutable(`echo '${message}' >&2\nexit 1`);
      const result = await run(candidate, {}, { bwrapPath: other });
      assert.equal(result.exitCode, 1);
      assert.match(result.output.text, /^tinysdd-setup: /u);
    });

    test('a bwrap that cannot even run /bin/sh is a setup failure', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const bwrapPath = await stubExecutable("echo 'bwrap: execvp /bin/sh: No such file or directory' >&2\nexit 1");
      await assert.rejects(run(candidate, {}, { bwrapPath }), { code: 'CHECK_RUNNER_UNAVAILABLE' });
    });

    test('nested user namespaces are disabled where bwrap can, and an older bwrap still runs the check', async () => {
      const candidate = await makeDir({
        'userns.mjs': [
          "import { spawnSync } from 'node:child_process';",
          "const outcome = spawnSync('unshare', ['-U', 'true'], { encoding: 'utf8' });",
          "console.log('nested', outcome.error ? outcome.error.code : outcome.status);",
          '',
        ].join('\n'),
      });
      const real = await run(candidate, { argv: ['node', 'userns.mjs'] });
      assert.equal(real.exitCode, 0, real.output.text);
      assert.ok(['disabled', 'allowed'].includes(real.sandbox.nestedUserNamespaces));
      if (real.sandbox.nestedUserNamespaces === 'disabled') assert.doesNotMatch(real.output.text, /nested 0\n/u);

      // A bwrap without the option rejects the probe and the run is built without it.
      const dump = join(fixtures, `older-${counter}.txt`);
      const prlimitPath = await stubExecutable(`printf '%s\\n' "$@" > '${dump}'`);
      const older = await stubExecutable("case \"$*\" in *--disable-userns*) echo 'bwrap: Unknown option --disable-userns' >&2; exit 1;; esac\nexit 0");
      const result = await run(candidate, {}, { bwrapPath: older, prlimitPath });
      assert.equal(result.exitCode, 0);
      assert.equal(result.sandbox.nestedUserNamespaces, 'allowed');
      const args = (await readFile(dump, 'utf8')).split('\n');
      assert.ok(!args.includes('--disable-userns'));
      assert.ok(!args.includes('--unshare-user'));
      assert.ok(args.includes('--unshare-all'));
    });

    test('the sandbox command is built as documented and spawned without the host environment', async () => {
      const dependencies = await makeDir({});
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const dump = join(fixtures, `args-${counter}.txt`);
      const environmentDump = join(fixtures, `env-${counter}.txt`);
      const prlimitPath = await stubExecutable(`printf '%s\\n' "$@" > '${dump}'\n/usr/bin/env > '${environmentDump}'`);
      const previous = process.env.TINYSDD_SECRET_PROBE;
      process.env.TINYSDD_SECRET_PROBE = 'x';
      let sandbox;
      try {
        const result = await run(candidate, {}, { prlimitPath, dependencyMounts: [{ source: dependencies, target: 'node_modules' }] });
        assert.equal(result.exitCode, 0);
        sandbox = result.sandbox;
      } finally {
        if (previous === undefined) delete process.env.TINYSDD_SECRET_PROBE;
        else process.env.TINYSDD_SECRET_PROBE = previous;
      }
      const args = (await readFile(dump, 'utf8')).split('\n').slice(0, -1);
      assert.deepEqual(args.slice(0, 5), [`--as=${8 * 1024 * MIB}`, `--nproc=${sandbox.processBaseline + 512}`, `--fsize=${256 * MIB}`, '--', '/usr/bin/bwrap']);
      const bwrapArgs = args.slice(5);
      for (const flag of ['--clearenv', '--die-with-parent', '--unshare-all', '--new-session']) assert.ok(bwrapArgs.includes(flag), flag);
      assert.ok(!bwrapArgs.includes('--share-net'));
      const sequence = (...items) => bwrapArgs.some((_, index) => items.every((item, offset) => bwrapArgs[index + offset] === item));
      assert.ok(sequence('--cap-drop', 'ALL'));
      assert.equal(sequence('--unshare-user', '--disable-userns'), sandbox.nestedUserNamespaces === 'disabled');
      assert.ok(sequence('--ro-bind', dirname(dirname(process.execPath)), '/opt/node'));
      assert.ok(sequence('--ro-bind', dependencies, '/work/node_modules'));
      assert.ok(sequence('--unshare-all', '--new-session'));
      assert.ok(sequence('--setenv', 'HOME', '/tmp'));
      assert.ok(sequence('--size', String(256 * MIB), '--tmpfs', '/tmp'));
      // The host copy is bound read-only at /input; /work is a tmpfs of scratchBytes.
      const input = bwrapArgs.indexOf('--ro-bind', bwrapArgs.indexOf('--remount-ro'));
      assert.ok(bwrapArgs[input + 1].startsWith(`${scratchRoot}/tinysdd-check-`) && bwrapArgs[input + 1].endsWith('/input'));
      assert.equal(bwrapArgs[input + 2], '/input');
      assert.ok(sequence('--size', String(512 * MIB), '--tmpfs', '/work'));
      assert.ok(!bwrapArgs.includes('--bind'), 'nothing writable is bound from the host');
      assert.ok(bwrapArgs.indexOf('/work') < bwrapArgs.indexOf(dependencies), 'the dependency mounts go on top of the /work tmpfs');
      // The wrapper is fixed text and the argv follows it as separate arguments.
      const wrapper = bwrapArgs.lastIndexOf('--') + 1;
      assert.deepEqual(bwrapArgs.slice(wrapper, wrapper + 2), ['/bin/sh', '-c']);
      assert.match(bwrapArgs[wrapper + 2], /^err=\$\(cp -a \/input\/\. \/work\/ 2>&1\) \|\| \{ printf 'tinysdd-setup: /u);
      assert.doesNotMatch(bwrapArgs[wrapper + 2], /node|t\.test\.mjs|--test/u);
      assert.deepEqual(bwrapArgs.slice(wrapper + 3), ['tinysdd-check', '/opt/node/bin/node', '--test', 't.test.mjs']);
      assert.doesNotMatch(await readFile(environmentDump, 'utf8'), /TINYSDD_SECRET_PROBE|^HOME=|^NODE_/mu);
    });

    test('tempRoot defaults to TINYSDD_TMPDIR, then TMPDIR', async () => {
      const candidate = await makeDir({ 't.test.mjs': PASSING_TEST });
      const dump = join(fixtures, `tmp-${counter}.txt`);
      const prlimitPath = await stubExecutable(`printf '%s\\n' "$@" > '${dump}'`);
      const saved = { TINYSDD_TMPDIR: process.env.TINYSDD_TMPDIR, TMPDIR: process.env.TMPDIR };
      try {
        process.env.TINYSDD_TMPDIR = scratchRoot;
        process.env.TMPDIR = fixtures;
        await runCheck({ candidateDir: candidate, check: VALID_CHECK, prlimitPath });
        assert.ok((await readFile(dump, 'utf8')).includes(`${scratchRoot}/tinysdd-check-`));

        delete process.env.TINYSDD_TMPDIR;
        process.env.TMPDIR = scratchRoot;
        await runCheck({ candidateDir: candidate, check: VALID_CHECK, prlimitPath });
        assert.ok((await readFile(dump, 'utf8')).includes(`${scratchRoot}/tinysdd-check-`));
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

  });
});
