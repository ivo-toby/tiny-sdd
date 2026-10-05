#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { exportLayaTrainingData } from '../src/laya-training-data.mjs';

function usageError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function parseArgs(argv) {
  const options = {
    json: false,
    project: '.',
    dataset: undefined,
    question: undefined,
    output: undefined,
  };
  const valueFlags = new Set(['--project', '--dataset', '--question', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw usageError(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (options.dataset === undefined) throw usageError('--dataset is required');
  if (options.question === undefined) throw usageError('--question is required');
  if (options.output === undefined) throw usageError('--output is required');
  return options;
}

async function run(argv) {
  const options = parseArgs(argv);
  return exportLayaTrainingData({
    projectRoot: options.project,
    datasetPath: options.dataset,
    questionPath: options.question,
    outputPath: options.output,
  });
}

const json = process.argv.includes('--json');
try {
  const result = await run(process.argv.slice(2));
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`Exported ${result.manifest.counts.retainedCases} Laya training rows.\n`);
    process.stdout.write(`Output: ${result.output}\n`);
  }
} catch (error) {
  const result = { ok: false, error: publicError(error) };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stderr.write(`ERROR [${result.error.code}] ${result.error.message}\n`);
  process.exitCode = 1;
}
