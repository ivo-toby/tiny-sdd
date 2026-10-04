#!/usr/bin/env node

import { atomicWriteJson, canonicalProjectRoot, publicError, readProjectFile, resolveProjectPath } from '../src/fs-utils.mjs';
import {
  parseDecisionDataset,
  parseDecisionPredictions,
  validateDecisionDatasetEvidence,
} from '../src/decision-dataset.mjs';
import { evaluateDecisions, parseDecisionMetricsConfig } from '../src/decision-evaluation.mjs';

function usageError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function parseArgs(argv) {
  const options = { json: false, project: '.', dataset: undefined, predictions: undefined, metrics: undefined, output: undefined };
  const valueFlags = new Set(['--project', '--dataset', '--predictions', '--metrics', '--output']);
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
  if (options.predictions === undefined) throw usageError('--predictions is required');
  return options;
}

async function inputText(projectRoot, projectRelative, label) {
  const resolved = await resolveProjectPath(projectRoot, projectRelative, { field: `${label} path`, allowMissing: false });
  return { path: resolved.relativePath, text: await readProjectFile(projectRoot, resolved.relativePath, { field: `${label} path` }) };
}

async function run(argv) {
  const options = parseArgs(argv);
  const projectRoot = await canonicalProjectRoot(options.project);
  const datasetInput = await inputText(projectRoot, options.dataset, 'dataset');
  const dataset = parseDecisionDataset(datasetInput.text);
  await validateDecisionDatasetEvidence(projectRoot, dataset);
  const predictionInput = await inputText(projectRoot, options.predictions, 'predictions');
  const predictions = parseDecisionPredictions(predictionInput.text);
  let metrics;
  let metricsPath;
  if (options.metrics !== undefined) {
    const metricInput = await inputText(projectRoot, options.metrics, 'metrics');
    metrics = parseDecisionMetricsConfig(metricInput.text);
    metricsPath = metricInput.path;
  }
  const report = evaluateDecisions({ dataset, predictions, metrics });
  let output;
  if (options.output !== undefined) {
    const resolved = await resolveProjectPath(projectRoot, options.output, { field: 'output path', allowMissing: true });
    const inputPaths = new Set([datasetInput.path, predictionInput.path, metricsPath].filter(Boolean));
    if (inputPaths.has(resolved.relativePath)) throw usageError('output path must differ from an input path');
    await atomicWriteJson(resolved.absolutePath, report);
    output = resolved.relativePath;
  }
  return { ok: true, report, ...(output === undefined ? {} : { output }) };
}

try {
  const result = await run(process.argv.slice(2));
  if (result.report.warnings.length > 0) {
    for (const warning of result.report.warnings) process.stderr.write(`WARNING: ${warning}\n`);
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    const totalPredictions = result.report.providers.reduce((sum, provider) => sum + provider.predictions, 0);
    process.stdout.write(`Evaluated ${totalPredictions} saved predictions across ${result.report.dataset.counts.totalCases} cases.\n`);
    if (result.output !== undefined) process.stdout.write(`Report: ${result.output}\n`);
  }
} catch (error) {
  const result = { ok: false, error: publicError(error) };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stderr.write(`ERROR [${result.error.code}] ${result.error.message}\n`);
  process.exitCode = 1;
}
