#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { beginHarnessCapture, finalizeHarnessCapture } from '../src/harness-adapter.mjs';

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write('usage: harness-adapter.mjs begin --bundle <directory> --harness <claude-code|pi> --model <id> [--candidate-parent <directory>] [--project <path>] [--json]\n');
  process.stderr.write('       harness-adapter.mjs finalize --run <run-id> --completed <true|false> [--claim <text>] [--project <path>] [--json]\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd(), json: false };
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!command && ['begin', 'finalize'].includes(argument)) command = argument;
    else if (argument === '--json') result.json = true;
    else if (argument === '--project') result.projectRoot = argv[++index];
    else if (argument === '--bundle') result.bundleDir = argv[++index];
    else if (argument === '--harness') result.harness = argv[++index];
    else if (argument === '--model') result.model = argv[++index];
    else if (argument === '--candidate-parent') result.candidateParent = argv[++index];
    else if (argument === '--run') result.runId = argv[++index];
    else if (argument === '--completed') result.completed = argv[++index];
    else if (argument === '--claim') result.callerClaims = argv[++index];
    else if (argument === '--help' || argument === '-h') return { help: true };
    else return usage(`unknown argument: ${argument}`);
  }
  if (!command) return usage('begin or finalize is required');
  if (command === 'begin') {
    for (const [name, value] of [['--bundle', result.bundleDir], ['--harness', result.harness], ['--model', result.model]]) {
      if (typeof value !== 'string' || value.length === 0) return usage(`${name} is required for begin`);
    }
  } else {
    if (typeof result.runId !== 'string' || result.runId.length === 0) return usage('--run is required for finalize');
    if (!['true', 'false'].includes(result.completed)) return usage('--completed true or false is required for finalize');
    result.completed = result.completed === 'true';
  }
  return { command, ...result };
}

const options = parseArgs(process.argv.slice(2));
if (options?.help) {
  process.stdout.write('usage: harness-adapter.mjs begin|finalize ...\n');
} else if (options) {
  try {
    const data = options.command === 'begin'
      ? await beginHarnessCapture(options)
      : await finalizeHarnessCapture(options);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}

