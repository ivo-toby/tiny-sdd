import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePi } from './capture-pi.mjs';

const testRoot = await mkdtemp(join(tmpdir(), 'tinysdd-capture-pi-'));
let runNumber = 0;

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function outputDir() {
  runNumber += 1;
  return join(testRoot, `run-${runNumber}`);
}

function nodeRun(script, extraArgs = [], options = {}) {
  return {
    executable: process.execPath,
    args: ['-e', script, '--', ...extraArgs],
    cwd: testRoot,
    ...options,
  };
}

test('captures successful JSON events, stderr, usage, and sanitized argv', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {} }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } }) + '\\n');",
    "process.stderr.write('synthetic stderr\\n');",
  ].join('');
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script, ['--api-key', 'secret-value', '--label', 'safe']),
    outputDir: output,
  });

  assert.equal(result.stopReason, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.counts.toolExecutionStarts, 1);
  assert.equal(result.counts.assistantMessageEnds, 1);
  assert.equal(result.counts.toolCalls, 1);
  assert.equal(result.counts.assistantMessages, 1);
  assert.deepEqual(result.tokenUsage, {
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    observed: 14,
    totalTokens: 14,
    known: true,
    unknown: false,
    missing: false,
    assistantMessagesWithUsage: 1,
  });
  assert.deepEqual(result.command.args.slice(-4), [
    '--api-key',
    '<redacted>',
    '--label',
    'safe',
  ]);
  const saved = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  assert.deepEqual(saved, result);
  assert.equal(
    await readFile(join(output, 'stdout.jsonl'), 'utf8'),
    [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {} },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  assert.equal(await readFile(join(output, 'stderr.txt'), 'utf8'), 'synthetic stderr\n');
  assert.equal(JSON.stringify(saved).includes('secret-value'), false);
  assert.equal('env' in saved, false);
});

test('retains failure output and reports a nonzero child exit', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: 'error' } }) + '\\n');",
    "process.stderr.write('failure details\\n');",
    'process.exitCode = 7;',
  ].join('');
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script),
    outputDir: output,
  });

  assert.equal(result.stopReason, 'nonzero');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.counts.assistantMessageEnds, 1);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(await readFile(join(output, 'stderr.txt'), 'utf8'), 'failure details\n');
});

test('records an executable spawn failure without omitting artifacts', async () => {
  const output = await outputDir();
  const result = await capturePi({
    executable: join(testRoot, 'does-not-exist'),
    args: [],
    outputDir: output,
  });

  assert.equal(result.stopReason, 'spawn_error');
  assert.equal(result.spawnError.code, 'ENOENT');
  assert.equal(await readFile(join(output, 'stdout.jsonl'), 'utf8'), '');
  assert.equal(await readFile(join(output, 'stderr.txt'), 'utf8'), '');
  assert.ok(await readFile(join(output, 'result.json'), 'utf8'));
});

test('terminates a child process group at the wall timeout', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
    "process.on('SIGTERM', () => {});",
    'setTimeout(() => {}, 60_000);',
  ].join('');
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script),
    outputDir: output,
    timeoutMs: 50,
  });

  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.exitCode, null);
  assert.ok(result.signal === 'SIGTERM' || result.signal === 'SIGKILL');
  assert.equal(result.counts.toolCalls, 0);
});

test('keeps valid events while reporting malformed LF-delimited records', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1' }) + '\\n');",
    "process.stdout.write('{not-json}\\n');",
    "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }) + '\\n');",
  ].join('');
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script),
    outputDir: output,
  });

  assert.equal(result.stopReason, 'completed');
  assert.equal(result.counts.toolExecutionStarts, 1);
  assert.equal(result.counts.assistantMessageEnds, 1);
  assert.equal(result.tokenUsage.known, false);
  assert.equal(result.tokenUsage.missing, true);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].line, 2);
  assert.match(result.parseErrors[0].message, /JSON/);
  assert.equal(await readFile(join(output, 'stdout.jsonl'), 'utf8'), [
    JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1' }),
    '{not-json}',
    JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
    '',
  ].join('\n'));
});

test('passes argv literally without shell interpretation', async () => {
  const marker = join(testRoot, 'must-not-exist');
  const values = [
    `; touch ${marker}`,
    `$(touch ${marker})`,
    '&&',
    'space value',
    '*',
  ];
  const script = "process.stdout.write(JSON.stringify({ type: 'argv', argv: process.argv.slice(1) }) + '\\n');";
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script, values),
    outputDir: output,
  });
  const event = JSON.parse((await readFile(join(output, 'stdout.jsonl'), 'utf8')).trim());

  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(event.argv, values);
  assert.deepEqual(result.command.args.slice(-values.length), values);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('stops on the observed token limit and records overshoot', async () => {
  const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 };
  const script = [
    `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: ${JSON.stringify(usage)} } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: ${JSON.stringify(usage)} } }) + '\\n');`,
    'setTimeout(() => {}, 60_000);',
  ].join('');
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script),
    outputDir: output,
    maxObservedTokens: 3,
  });

  assert.equal(result.stopReason, 'token_limit');
  assert.equal(result.tokenUsage.observed >= 3, true);
  assert.equal(result.limits.observedTokensOvershoot, result.tokenUsage.observed - 3);
});

test('records a token-limit observation from a short-lived child', async () => {
  const usage = { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 };
  const script = `process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: ${JSON.stringify(usage)} } }) + '\\n');`;
  const output = await outputDir();
  const result = await capturePi({
    ...nodeRun(script),
    outputDir: output,
    maxObservedTokens: 3,
  });

  // Regular-file output can be visible before the short-lived child emits
  // close, so capture may complete naturally or stop it at the limit.
  assert.equal(result.stopReason, 'token_limit');
  assert.deepEqual(result.tokenUsage, {
    ...usage,
    observed: 3,
    totalTokens: 3,
    known: true,
    unknown: false,
    missing: false,
    assistantMessagesWithUsage: 1,
  });
  assert.equal(result.limits.observedTokensOvershoot, 0);
  assert.ok(
    (result.exitCode === 0 && result.signal === null)
      || (result.exitCode === null && result.signal === 'SIGTERM'),
    `unexpected short-lived child status: ${result.exitCode}/${result.signal}`,
  );
});

test('refuses an existing non-empty output directory', async () => {
  const output = join(testRoot, 'occupied');
  await mkdir(output);
  const sentinel = join(output, 'sentinel.txt');
  await writeFile(sentinel, 'keep me\n');

  await assert.rejects(
    capturePi({
      ...nodeRun(''),
      outputDir: output,
    }),
    /outputDir must be empty/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me\n');
  assert.deepEqual(await readdir(output), ['sentinel.txt']);
});
