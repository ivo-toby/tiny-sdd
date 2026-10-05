import { lstat } from 'node:fs/promises';

import {
  appendDecisionRecords,
} from '../src/semantic-policy.mjs';
import {
  assertDecisionLogPath,
  parseDecisionQuestions,
  parseSavedProviderMetadata,
  replaySavedPredictions,
  validateDecisionObservationBatch,
  validateDecisionReplayReport,
} from '../src/decision-providers.mjs';
import {
  atomicWriteJson,
  canonicalProjectRoot,
  publicError,
  readProjectFile,
  resolveProjectPath,
  tinyError,
} from '../src/fs-utils.mjs';
import {
  parseDecisionDataset,
  parseDecisionPredictions,
  validateDecisionDatasetEvidence,
} from '../src/decision-dataset.mjs';

function usageError(message) {
  return tinyError('INVALID_ARGUMENT', message);
}

function parseArgs(argv) {
  const options = {
    json: false,
    project: '.',
    dataset: undefined,
    predictions: undefined,
    providers: undefined,
    questions: undefined,
    output: undefined,
    logTask: undefined,
    mode: 'shadow',
  };
  const supplied = new Set();
  const valueFlags = new Set([
    '--project', '--dataset', '--predictions', '--providers', '--provider-metadata', '--questions',
    '--output', '--log-task', '--task-id', '--mode',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw usageError(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`${argument} requires a value`);
    const key = argument === '--providers' || argument === '--provider-metadata'
      ? 'providers'
      : argument === '--task-id' || argument === '--log-task'
        ? 'logTask'
        : argument.slice(2);
    if (supplied.has(key)) throw usageError(`${argument} was supplied more than once`);
    supplied.add(key);
    options[key] = value;
    index += 1;
  }
  if (options.dataset === undefined) throw usageError('--dataset is required');
  if (options.predictions === undefined) throw usageError('--predictions is required');
  if (!['off', 'shadow', 'enforce'].includes(options.mode)) throw usageError('--mode must be off, shadow, or enforce');
  if (options.mode === 'enforce') throw tinyError('DECISION_PROVIDER_UNSUPPORTED', 'enforce is not available in the offline shadow foundation');
  return options;
}

async function inputText(projectRoot, projectRelative, label) {
  const resolved = await resolveProjectPath(projectRoot, projectRelative, { field: `${label} path`, allowMissing: false });
  return {
    path: resolved.relativePath,
    text: await readProjectFile(projectRoot, resolved.relativePath, { field: `${label} path` }),
  };
}

async function newOutputPath(projectRoot, outputPath, inputPaths) {
  const resolved = await resolveProjectPath(projectRoot, outputPath, { field: 'output path', allowMissing: true });
  if (inputPaths.has(resolved.relativePath)) throw usageError('output path must differ from every input and validated evidence path');
  try {
    await lstat(resolved.absolutePath);
    throw usageError('output path already exists; refusing to overwrite');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

async function run(argv) {
  const options = parseArgs(argv);
  const projectRoot = await canonicalProjectRoot(options.project);
  const datasetInput = await inputText(projectRoot, options.dataset, 'dataset');
  const dataset = parseDecisionDataset(datasetInput.text);
  const evidence = await validateDecisionDatasetEvidence(projectRoot, dataset);
  const predictionInput = await inputText(projectRoot, options.predictions, 'predictions');
  const predictions = parseDecisionPredictions(predictionInput.text);
  const providerInput = options.providers === undefined ? undefined : await inputText(projectRoot, options.providers, 'provider metadata');
  const providerMetadata = providerInput === undefined ? undefined : parseSavedProviderMetadata(providerInput.text);
  const questionInput = options.questions === undefined ? undefined : await inputText(projectRoot, options.questions, 'question metadata');
  const questions = questionInput === undefined ? undefined : parseDecisionQuestions(questionInput.text);
  const inputPaths = new Set([
    datasetInput.path,
    predictionInput.path,
    providerInput?.path,
    questionInput?.path,
    ...evidence.verified.map((ref) => ref.path),
  ].filter(Boolean));
  const report = validateDecisionReplayReport(replaySavedPredictions({
    dataset,
    predictions,
    providerMetadata,
    questions,
    mode: options.mode,
    minimumProviders: 2,
  }));
  const output = options.output === undefined ? undefined : await newOutputPath(projectRoot, options.output, inputPaths);
  const log = options.logTask === undefined ? undefined : await assertDecisionLogPath(projectRoot, options.logTask);
  const records = validateDecisionObservationBatch(report.records);
  if (output !== undefined) await atomicWriteJson(output.absolutePath, report);
  if (log !== undefined) await appendDecisionRecords(projectRoot, options.logTask, records);
  return {
    ok: true,
    report,
    verifiedEvidence: evidence.verified.length,
    ...(output === undefined ? {} : { output: output.relativePath }),
    ...(log === undefined ? {} : { loggedTask: options.logTask, loggedRecords: records.length }),
  };
}

try {
  const result = await run(process.argv.slice(2));
  for (const warning of result.report.warnings) process.stderr.write(`WARNING: ${warning}\n`);
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    const shadow = result.report.records.filter((record) => record.effectiveMode === 'shadow').length;
    const off = result.report.records.length - shadow;
    process.stdout.write(`Observed ${shadow} shadow records and ${off} off records for ${result.report.providers.length} providers.\n`);
    if (result.output !== undefined) process.stdout.write(`Report: ${result.output}\n`);
    if (result.loggedTask !== undefined) process.stdout.write(`Ledger: ${result.loggedTask}\n`);
  }
} catch (error) {
  const result = { ok: false, error: publicError(error) };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stderr.write(`ERROR [${result.error.code}] ${result.error.message}\n`);
  process.exitCode = 1;
}
