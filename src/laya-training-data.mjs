import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  assertNoSymlinkPath,
  canonicalProjectRoot,
  digestJson,
  readProjectFile,
  resolveProjectPath,
  sha256,
  tinyError,
} from './fs-utils.mjs';
import {
  FAILURE_TRIAGE_LABELS,
  decisionCaseInputDigest,
  decisionDatasetDigest,
  parseDecisionDataset,
  validateDecisionDataset,
  validateDecisionDatasetEvidence,
} from './decision-dataset.mjs';

export const LAYA_TRAINING_MANIFEST_SCHEMA_VERSION = 1;
export const LAYA_TRAINING_QUESTION_ID = 'failure-triage';
export const LAYA_CONSUMER_REPOSITORY = 'NandhaKishorM/laya';
export const LAYA_CONSUMER_REVISION = '8a6e1328cce2460a0e5aa348ad465bb1b5821cd2';
export const LAYA_TRAIN_SOURCE_URL = `https://github.com/${LAYA_CONSUMER_REPOSITORY}/blob/${LAYA_CONSUMER_REVISION}/laya/train.py`;
export const LAYA_FINETUNE_GUIDE_URL = `https://github.com/${LAYA_CONSUMER_REPOSITORY}/blob/${LAYA_CONSUMER_REVISION}/docs/finetune.md`;

const PARTITIONS = Object.freeze(['train', 'validation', 'test']);
const MAX_QUESTION_BYTES = 128 * 1024;
const MAX_QUESTION_DEPTH = 8;
const MAX_QUESTION_ARRAY_LENGTH = 128;
const MAX_QUESTION_OBJECT_KEYS = 128;
const MAX_QUESTION_STRING_LENGTH = 128 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function dataInvalid(message, details = undefined) {
  throw tinyError('LAYA_TRAINING_DATA_INVALID', message, details);
}

function outputInvalid(message, details = undefined) {
  throw tinyError('LAYA_TRAINING_OUTPUT_INVALID', message, details);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) dataInvalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) dataInvalid(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) dataInvalid(`${label} contains unknown key: ${key}`);
  }
}

function boundedQuestionValue(value, label, depth = 0, seen = new Set()) {
  if (depth > MAX_QUESTION_DEPTH) dataInvalid(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_QUESTION_STRING_LENGTH) dataInvalid(`${label} exceeds maximum string length`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) dataInvalid(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value !== 'object') dataInvalid(`${label} contains an unsupported value`);
  if (seen.has(value)) dataInvalid(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_QUESTION_ARRAY_LENGTH) dataInvalid(`${label} contains too many entries`);
    const result = value.map((entry, index) => boundedQuestionValue(entry, `${label}[${index}]`, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) dataInvalid(`${label} must contain plain objects`);
  const entries = Object.entries(value);
  if (entries.length > MAX_QUESTION_OBJECT_KEYS) dataInvalid(`${label} contains too many keys`);
  const result = {};
  for (const [key, entry] of entries) {
    if (UNSAFE_KEYS.has(key)) dataInvalid(`${label}.${key} is not allowed`);
    Object.defineProperty(result, key, {
      value: boundedQuestionValue(entry, `${label}.${key}`, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return result;
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0;

  function whitespace() {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
  }

  function stringToken() {
    const start = index;
    if (text[index] !== '"') throw new Error('expected JSON string');
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') return JSON.parse(text.slice(start, index));
    }
    throw new Error('unterminated JSON string');
  }

  function value() {
    whitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ':') throw new Error('expected JSON object colon');
        index += 1;
        value();
        whitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('expected JSON object comma');
        index += 1;
      }
      throw new Error('unterminated JSON object');
    }
    if (character === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('expected JSON array comma');
        index += 1;
      }
      throw new Error('unterminated JSON array');
    }
    if (character === '"') {
      stringToken();
      return;
    }
    while (index < text.length && !/[\s,\]}]/u.test(text[index])) index += 1;
    if (index === 0) throw new Error('expected JSON value');
  }

  value();
  whitespace();
  if (index !== text.length) throw new Error('unexpected JSON content');
}

export function validateLayaChoiceQuestion(value) {
  const question = plainObject(value, 'Laya question');
  exactKeys(question, ['type', 'instructions', 'criteria'], 'Laya question');
  if (question.type !== 'choice') dataInvalid('Laya question.type must be choice');
  if (!Object.hasOwn(question, 'instructions')) dataInvalid('Laya question.instructions is required');
  const instructions = boundedQuestionValue(question.instructions, 'Laya question.instructions');
  if (typeof instructions === 'string' && instructions.trim().length === 0) dataInvalid('Laya question.instructions must be nonempty');
  if (instructions === null || typeof instructions === 'boolean') dataInvalid('Laya question.instructions must be a Laya-supported value');

  const criteria = plainObject(question.criteria, 'Laya question.criteria');
  const keys = Object.keys(criteria);
  if (keys.length !== FAILURE_TRIAGE_LABELS.length || !FAILURE_TRIAGE_LABELS.every((label) => keys.includes(label))) {
    dataInvalid('Laya question.criteria keys must exactly match the four failure-triage labels', {
      expected: [...FAILURE_TRIAGE_LABELS],
      actual: keys,
    });
  }
  const normalizedCriteria = {};
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) dataInvalid(`Laya question.criteria.${key} is not allowed`);
    Object.defineProperty(normalizedCriteria, key, {
      value: boundedQuestionValue(criteria[key], `Laya question.criteria.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { type: 'choice', instructions, criteria: normalizedCriteria };
}

export function parseLayaChoiceQuestion(text) {
  if (typeof text !== 'string') dataInvalid('Laya question must be JSON text');
  if (Buffer.byteLength(text) > MAX_QUESTION_BYTES) dataInvalid(`Laya question exceeds ${MAX_QUESTION_BYTES} bytes`);
  try {
    assertNoDuplicateJsonKeys(text);
  } catch (error) {
    dataInvalid(`Laya question JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    dataInvalid(`Laya question is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateLayaChoiceQuestion(value);
}

function layaRow(item, question) {
  const probabilities = {};
  for (const label of Object.keys(question.criteria)) probabilities[label] = item.expected.label === label ? 1 : 0;
  return {
    state: { checkLog: item.observation.checkLog },
    questions: { [LAYA_TRAINING_QUESTION_ID]: question },
    gold: { [LAYA_TRAINING_QUESTION_ID]: { probabilities } },
  };
}

function caseSplit(item) {
  return {
    partition: item.split.partition,
    sourceGroup: item.split.sourceGroup,
    featureGroup: item.split.featureGroup,
    runLineageGroup: item.split.runLineageGroup,
  };
}

export function buildLayaTrainingRows(dataset, question) {
  const normalizedDataset = validateDecisionDataset(dataset);
  const normalizedQuestion = validateLayaChoiceQuestion(question);
  const retained = [];
  const counts = {
    inputCases: normalizedDataset.cases.length,
    realCases: normalizedDataset.cases.filter((item) => !item.synthetic).length,
    syntheticCases: normalizedDataset.cases.filter((item) => item.synthetic).length,
    realFailureTriageCases: normalizedDataset.cases.filter((item) => !item.synthetic && item.decisionPoint === 'failure-triage').length,
    retainedCases: 0,
    excludedCases: 0,
    exclusions: {
      synthetic: 0,
      otherDecisionPoint: 0,
      missingCheckLog: 0,
    },
  };

  for (const item of normalizedDataset.cases) {
    if (item.synthetic) {
      counts.exclusions.synthetic += 1;
      continue;
    }
    if (item.decisionPoint !== 'failure-triage') {
      counts.exclusions.otherDecisionPoint += 1;
      continue;
    }
    if (item.observation === null || typeof item.observation !== 'object' || Array.isArray(item.observation)) {
      dataInvalid(`case ${item.id} observation must be an object for failure-triage export`);
    }
    if (!Object.hasOwn(item.observation, 'checkLog')) {
      counts.exclusions.missingCheckLog += 1;
      continue;
    }
    if (typeof item.observation.checkLog !== 'string') {
      dataInvalid(`case ${item.id} observation.checkLog must be a string`);
    }
    if (item.observation.checkLog.trim().length === 0) {
      counts.exclusions.missingCheckLog += 1;
      continue;
    }
    retained.push(item);
  }

  retained.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  counts.retainedCases = retained.length;
  counts.excludedCases = counts.inputCases - counts.retainedCases;
  if (retained.length === 0) dataInvalid('no real human-reviewed failure-triage cases with a nonempty checkLog remain');
  const partitionCounts = Object.fromEntries(PARTITIONS.map((partition) => [partition, 0]));
  for (const item of retained) partitionCounts[item.split.partition] += 1;
  for (const partition of PARTITIONS) {
    if (partitionCounts[partition] === 0) dataInvalid(`retained cases must include a nonempty ${partition} partition`, { partitionCounts });
  }

  return {
    dataset: normalizedDataset,
    question: normalizedQuestion,
    rows: Object.fromEntries(PARTITIONS.map((partition) => [
      partition,
      retained.filter((item) => item.split.partition === partition).map((item) => layaRow(item, normalizedQuestion)),
    ])),
    cases: retained.map((item) => ({
      id: item.id,
      inputSha256: decisionCaseInputDigest(item),
      split: caseSplit(item),
    })),
    counts,
  };
}

async function inputFile(projectRoot, projectRelative, label) {
  const resolved = await resolveProjectPath(projectRoot, projectRelative, { field: `${label} path`, allowMissing: false });
  const info = await lstat(resolved.absolutePath);
  if (!info.isFile()) dataInvalid(`${label} path must be a regular file: ${resolved.relativePath}`);
  const text = await readProjectFile(projectRoot, resolved.relativePath, { field: `${label} path` });
  return {
    path: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    text,
    sha256: sha256(text),
  };
}

function outputPathOverlapsInput(outputAbsolute, inputAbsolute) {
  const output = resolve(outputAbsolute);
  const input = resolve(inputAbsolute);
  return output === input || output.startsWith(`${input}/`) || input.startsWith(`${output}/`);
}

async function validateOutputPath(projectRoot, outputPath, protectedPaths) {
  const resolved = await resolveProjectPath(projectRoot, outputPath, { field: 'output path', allowMissing: true });
  for (const protectedPath of protectedPaths) {
    if (outputPathOverlapsInput(resolved.absolutePath, protectedPath.absolutePath)) {
      outputInvalid('output directory overlaps a validated input path', {
        output: resolved.relativePath,
        input: protectedPath.path,
      });
    }
  }
  try {
    await lstat(resolved.absolutePath);
    outputInvalid('output directory already exists; refusing to overwrite', { output: resolved.relativePath });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

async function createNewOutputDirectory(absolutePath) {
  const parent = dirname(absolutePath);
  await assertNoSymlinkPath(parent, { allowMissing: true, requireDirectory: false });
  await mkdir(parent, { recursive: true, mode: 0o755 });
  await assertNoSymlinkPath(parent, { allowMissing: false, requireDirectory: true });
  try {
    await mkdir(absolutePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') outputInvalid('output directory appeared after validation; refusing to overwrite');
    throw error;
  }
  await assertNoSymlinkPath(absolutePath, { allowMissing: false, requireDirectory: true });
}

async function writeNewFile(path, content) {
  try {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') outputInvalid(`output file already exists; refusing to overwrite: ${path}`);
    throw error;
  }
}

function jsonLines(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function fileRecord(path, text, cases) {
  return {
    path,
    ...(cases === undefined ? {} : { cases }),
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  };
}

export async function exportLayaTrainingData({
  projectRoot = '.',
  datasetPath,
  questionPath,
  question = undefined,
  outputPath,
} = {}) {
  if (typeof datasetPath !== 'string' || datasetPath.length === 0) dataInvalid('datasetPath is required');
  if (typeof outputPath !== 'string' || outputPath.length === 0) outputInvalid('outputPath is required');
  if (questionPath !== undefined && question !== undefined) dataInvalid('supply questionPath or question, not both');
  if (questionPath === undefined && question === undefined) dataInvalid('an explicit Laya choice question is required');

  const root = await canonicalProjectRoot(projectRoot);
  const datasetInput = await inputFile(root, datasetPath, 'dataset');
  const dataset = parseDecisionDataset(datasetInput.text);
  const questionInput = questionPath === undefined ? null : await inputFile(root, questionPath, 'question');
  const normalizedQuestion = questionInput === null
    ? validateLayaChoiceQuestion(question)
    : parseLayaChoiceQuestion(questionInput.text);
  const evidence = await validateDecisionDatasetEvidence(root, dataset);
  const protectedPaths = [
    { path: datasetInput.path, absolutePath: datasetInput.absolutePath },
    ...(questionInput === null ? [] : [{ path: questionInput.path, absolutePath: questionInput.absolutePath }]),
  ];
  for (const reference of evidence.verified) {
    const resolved = await resolveProjectPath(root, reference.path, {
      field: 'evidence path',
      allowMissing: false,
      tinysddArtifactPrefix: '.tinysdd/bench/',
    });
    protectedPaths.push({ path: reference.path, absolutePath: resolved.absolutePath });
  }
  const output = await validateOutputPath(root, outputPath, protectedPaths);
  const built = buildLayaTrainingRows(dataset, normalizedQuestion);
  const partitionFiles = {};
  for (const partition of PARTITIONS) {
    const text = jsonLines(built.rows[partition]);
    partitionFiles[partition] = fileRecord(`${partition}.jsonl`, text, built.rows[partition].length);
  }
  const manifest = {
    schemaVersion: LAYA_TRAINING_MANIFEST_SCHEMA_VERSION,
    format: 'tinysdd-laya-training-data',
    dataset: {
      id: built.dataset.id,
      version: built.dataset.version,
      path: datasetInput.path,
      fileSha256: datasetInput.sha256,
      normalizedSha256: decisionDatasetDigest(built.dataset),
    },
    question: {
      id: LAYA_TRAINING_QUESTION_ID,
      ...(questionInput === null ? {} : { path: questionInput.path, fileSha256: questionInput.sha256 }),
      normalizedSha256: sha256(JSON.stringify(built.question)),
    },
    consumer: {
      repository: LAYA_CONSUMER_REPOSITORY,
      revision: LAYA_CONSUMER_REVISION,
      trainSource: LAYA_TRAIN_SOURCE_URL,
      finetuneGuide: LAYA_FINETUNE_GUIDE_URL,
    },
    partitions: partitionFiles,
    counts: built.counts,
    cases: built.cases,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestFile = fileRecord('manifest.json', manifestText, undefined);

  await createNewOutputDirectory(output.absolutePath);
  for (const partition of PARTITIONS) {
    await writeNewFile(resolve(output.absolutePath, `${partition}.jsonl`), jsonLines(built.rows[partition]));
  }
  await writeNewFile(resolve(output.absolutePath, 'manifest.json'), manifestText);

  return {
    ok: true,
    output: output.relativePath,
    manifest,
    manifestFile,
    files: partitionFiles,
  };
}
