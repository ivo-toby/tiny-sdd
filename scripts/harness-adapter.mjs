#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { beginHarnessCapture, finalizeHarnessCapture } from '../src/harness-adapter.mjs';

const usageText = 'usage: harness-adapter.mjs begin --bundle <directory> --harness <claude-code|pi> --model <id> [--candidate-parent <directory>] [--project <path>] [--json]\n'
  + '       harness-adapter.mjs finalize --run <run-id> --completed <true|false> [--claim <text>] [--project <path>] [--json]';

function usage(message, { json = false } = {}) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(`${usageText}\n`);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: message ?? 'invalid arguments' } })}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd(), json: argv.includes('--json') };
  const valueFlags = new Set(['--project', '--bundle', '--harness', '--model', '--candidate-parent', '--run', '--completed', '--claim']);
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!command && ['begin', 'finalize'].includes(argument)) command = argument;
    else if (argument === '--json') continue;
    else if (argument === '--help' || argument === '-h') return { help: true, json: result.json };
    else if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return usage(`${argument} requires a value`, { json: result.json });
      const key = {
        '--project': 'projectRoot',
        '--bundle': 'bundleDir',
        '--harness': 'harness',
        '--model': 'model',
        '--candidate-parent': 'candidateParent',
        '--run': 'runId',
        '--completed': 'completed',
        '--claim': 'callerClaims',
      }[argument];
      result[key] = value;
      index += 1;
    } else return usage(`unknown argument: ${argument}`, { json: result.json });
  }
  if (!command) return usage('begin or finalize is required', { json: result.json });
  if (command === 'begin') {
    for (const [name, value] of [['--bundle', result.bundleDir], ['--harness', result.harness], ['--model', result.model]]) {
      if (typeof value !== 'string' || value.length === 0) return usage(`${name} is required for begin`, { json: result.json });
    }
  } else {
    if (typeof result.runId !== 'string' || result.runId.length === 0) return usage('--run is required for finalize', { json: result.json });
    if (!['true', 'false'].includes(result.completed)) return usage('--completed true or false is required for finalize', { json: result.json });
    result.completed = result.completed === 'true';
  }
  return { command, ...result };
}

const options = parseArgs(process.argv.slice(2));
if (options?.help) {
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, usage: usageText })}\n`);
  else process.stdout.write(`${usageText}\n`);
} else if (options) {
  try {
    const data = options.command === 'begin'
      ? await beginHarnessCapture(options)
      : await finalizeHarnessCapture(options);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    const result = { ok: false, error: publicError(error) };
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stderr.write(`${JSON.stringify(result.error)}\n`);
    process.exitCode = 1;
  }
}
