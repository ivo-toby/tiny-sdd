import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const canonicalTmpdir = await realpath(tmpdir());

async function invoke(...args) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function invokeJson(...args) {
  const result = await invoke('--json', ...args);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  return { status: result.status, parsed: JSON.parse(lines[0]), stderr: result.stderr };
}

test('top-level help is grouped by phase, shows the normal flow and fits on one screen', async () => {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-cli-help-top-'));
  try {
    const result = await invoke('--project', root, '--help');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.split('\n').length <= 80, `top-level help should fit on one screen, got ${result.stdout.split('\n').length} lines`);
    assert.match(result.stdout, /Normal flow: setup → init → task add → task approve → worker start → worker status → task review/u);
    for (const group of ['Setup', 'Tasks', 'Worker', 'Bench', 'Usage', 'Slice tests', 'Phases']) {
      assert.match(result.stdout, new RegExp(`^${group} \\(`, 'mu'), `missing group ${group}`);
    }
    assert.match(result.stdout, /task add\s+Register a bounded slice/u);
    assert.match(result.stdout, /worker start\s+Start a detached worker launch/u);
    // Grouped one-liners, not the raw usage signatures.
    assert.doesNotMatch(result.stdout, /--wait-ms N\]/u);
    await assert.rejects(readFile(join(root, '.tinysdd', 'config.json')));
    const json = await invokeJson('--project', root, '--help');
    assert.equal(json.status, 0);
    assert.equal(json.parsed.ok, true);
    assert.equal(json.parsed.data.help, result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a subcommand has its own help with usage, flag defaults and an example', async () => {
  for (const [args, usage] of [
    [['worker', 'stop'], /worker stop --id LAUNCH_ID \[--wait-ms N\]/u],
    [['task', 'add'], /task add --id ID --brief PATH --allow FILE\[,FILE\]/u],
    [['bench', 'run'], /bench run --worker NAME/u],
    [['bench', 'qualification', 'show'], /bench qualification show --record PATH/u],
  ]) {
    const viaFlag = await invoke(...args, '--help');
    assert.equal(viaFlag.status, 0, viaFlag.stderr);
    assert.match(viaFlag.stdout, new RegExp(`^Usage: tinysdd .*${usage.source}`, 'u'));
    assert.match(viaFlag.stdout, /^Flags:$/mu);
    assert.match(viaFlag.stdout, /^Example: /mu);
    const viaHelp = await invoke('help', ...args);
    assert.equal(viaHelp.status, 0, viaHelp.stderr);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
  }
  const stop = await invoke('worker', 'stop', '--help');
  assert.match(stop.stdout, /--wait-ms N\s+wait for the result, 0-600000, default 30000/u);
  const stopJson = await invokeJson('--json', 'help', 'worker', 'stop');
  assert.equal(stopJson.parsed.ok, true);
  assert.match(stopJson.parsed.data.help, /worker stop --id LAUNCH_ID/u);
});

test('a command with subcommands lists them and points at per-subcommand help', async () => {
  const result = await invoke('help', 'task');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^tinysdd task <subcommand> \[flags\]$/mu);
  assert.match(result.stdout, /^  add\s+/mu);
  assert.match(result.stdout, /^  supersede\s+/mu);
  assert.match(result.stdout, /tinysdd task <subcommand> --help/u);
  assert.doesNotMatch(result.stdout, /Usage: tinysdd \[--json\] \[--project PATH\] task add/u);
});

test('an unknown command prints the closest command\'s usage, not the whole list', async () => {
  const result = await invoke('wroker', 'start');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ERROR \[UNKNOWN_COMMAND\] unknown command: wroker\. Did you mean `worker`\?/u);
  assert.match(result.stderr, /tinysdd worker <subcommand> \[flags\]/u);
  assert.doesNotMatch(result.stderr, /Normal flow:/u);
  const json = await invokeJson('--json', 'wroker');
  assert.equal(json.status, 1);
  assert.equal(json.parsed.ok, false);
  assert.equal(json.parsed.error.code, 'UNKNOWN_COMMAND');
  assert.match(json.parsed.error.message, /unknown command: wroker/u);
});

test('an unknown subcommand or flag prints that command\'s usage, not the whole list', async () => {
  const badSub = await invoke('worker', 'stat');
  assert.equal(badSub.status, 1);
  assert.match(badSub.stderr, /worker requires run, start, status, stop, or settings\./u);
  assert.match(badSub.stderr, /tinysdd worker <subcommand> \[flags\]/u);
  assert.doesNotMatch(badSub.stderr, /Normal flow:/u);

  const badFlag = await invoke('task', 'add', '--id', 'one', '--nope', 'x');
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /unknown option: --nope/u);
  assert.match(badFlag.stderr, /Usage: tinysdd \[--json\] \[--project PATH\] task add --id ID/u);
  assert.doesNotMatch(badFlag.stderr, /Normal flow:/u);

  const missingValue = await invoke('worker', 'stop', '--id');
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--id requires a value/u);
  assert.match(missingValue.stderr, /worker stop --id LAUNCH_ID/u);
});
