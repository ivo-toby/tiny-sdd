import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { sha256 } from '../src/fs-utils.mjs';
import {
  decisionCaseInputDigest,
  decisionDatasetDigest,
  validateDecisionDataset,
} from '../src/decision-dataset.mjs';
import {
  LAYA_CONSUMER_REVISION,
  LAYA_TRAINING_QUESTION_ID,
  buildLayaTrainingRows,
  exportLayaTrainingData,
  parseLayaChoiceQuestion,
  validateLayaChoiceQuestion,
} from '../src/laya-training-data.mjs';

const exec = promisify(execFile);
const canonicalTmpdir = await realpath(tmpdir());
const scriptPath = new URL('../scripts/export-laya-training-data.mjs', import.meta.url);

const question = {
  type: 'choice',
  instructions: 'Classify the failed check log.',
  criteria: {
    environment: 'The failure is caused by the execution environment.',
    'missing-context': 'The worker lacks required context.',
    'fixable-from-log': 'The failure is fixable from the log.',
    unknown: 'The log is insufficient to classify the failure.',
  },
};

function source(path, text) {
  return { kind: 'run-log', refs: [{ path, sha256: sha256(text) }] };
}

function caseValue({
  id,
  partition,
  decisionPoint = 'failure-triage',
  synthetic = false,
  label = 'fixable-from-log',
  checkLog = `AssertionError: ${id}`,
  sourcePath = `evidence/${id}.log`,
  sourceText = `source for ${id}\n`,
}) {
  return {
    id,
    decisionPoint,
    synthetic,
    source: source(sourcePath, sourceText),
    observation: { checkLog },
    expected: { label, reviewedBy: 'operator', reviewedAt: '2026-10-04T10:00:00.000Z' },
    split: {
      partition,
      sourceGroup: `source-${id}`,
      featureGroup: `feature-${id}`,
      runLineageGroup: `lineage-${id}`,
    },
  };
}

function datasetWithAllPartitions(extra = []) {
  return {
    schemaVersion: 1,
    id: 'laya-fixture',
    version: '1',
    cases: [
      caseValue({ id: 'case-test', partition: 'test', label: 'environment' }),
      caseValue({ id: 'case-train', partition: 'train', label: 'missing-context' }),
      caseValue({ id: 'case-validation', partition: 'validation', label: 'unknown' }),
      ...extra,
    ],
  };
}

async function fixture({ dataset = datasetWithAllPartitions(), questionValue = question } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-laya-training-'));
  await mkdir(join(root, 'evidence'), { recursive: true });
  for (const item of dataset.cases) {
    const ref = item.source.refs[0];
    await writeFile(join(root, ref.path), item.id === 'changed' ? 'changed source\n' : `source for ${item.id}\n`);
  }
  await writeFile(join(root, 'data.json'), `${JSON.stringify(dataset)}\n`);
  await writeFile(join(root, 'question.json'), `${JSON.stringify(questionValue)}\n`);
  return { root, dataset, questionValue };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test('builds label-blind Laya rows with one-hot targets and explicit exclusions', () => {
  const dataset = datasetWithAllPartitions([
    caseValue({ id: 'case-synthetic', partition: 'train', synthetic: true }),
    caseValue({ id: 'case-other', partition: 'train', decisionPoint: 'research-relevance', label: 'yes' }),
    caseValue({ id: 'case-empty', partition: 'train', checkLog: '   ' }),
  ]);
  const built = buildLayaTrainingRows(dataset, question);
  assert.deepEqual(built.counts, {
    inputCases: 6,
    realCases: 5,
    syntheticCases: 1,
    realFailureTriageCases: 4,
    retainedCases: 3,
    excludedCases: 3,
    exclusions: { synthetic: 1, otherDecisionPoint: 1, missingCheckLog: 1 },
  });
  const row = built.rows.test[0];
  assert.deepEqual(Object.keys(row), ['state', 'questions', 'gold']);
  assert.deepEqual(row.state, { checkLog: 'AssertionError: case-test' });
  assert.equal(row.state.expected, undefined);
  assert.equal(row.state.reviewedBy, undefined);
  assert.deepEqual(row.questions[LAYA_TRAINING_QUESTION_ID], question);
  assert.deepEqual(row.gold[LAYA_TRAINING_QUESTION_ID].probabilities, {
    environment: 1,
    'missing-context': 0,
    'fixable-from-log': 0,
    unknown: 0,
  });
});

test('preserves supplied choice order while keeping the exact four-label set', () => {
  const reversed = {
    type: 'choice',
    instructions: 'Classify.',
    criteria: {
      unknown: 'u',
      'fixable-from-log': 'f',
      'missing-context': 'm',
      environment: 'e',
    },
  };
  const normalized = validateLayaChoiceQuestion(reversed);
  assert.deepEqual(Object.keys(normalized.criteria), ['unknown', 'fixable-from-log', 'missing-context', 'environment']);
  const row = buildLayaTrainingRows(datasetWithAllPartitions([{ ...caseValue({ id: 'case-extra', partition: 'train' }) }]), reversed).rows.train[0];
  assert.deepEqual(Object.keys(row.gold[LAYA_TRAINING_QUESTION_ID].probabilities), Object.keys(reversed.criteria));
  assert.throws(() => validateLayaChoiceQuestion({ ...question, criteria: { ...question.criteria, extra: 'x' } }), { code: 'LAYA_TRAINING_DATA_INVALID' });
  assert.throws(() => validateLayaChoiceQuestion({ ...question, criteria: { environment: 'e' } }), { code: 'LAYA_TRAINING_DATA_INVALID' });
});

test('accepts nonempty structured and finite numeric instructions supported by Laya', () => {
  for (const instructions of [['one'], { prompt: 'one' }, 0, 1.5]) {
    assert.doesNotThrow(() => validateLayaChoiceQuestion({ ...question, instructions }));
  }
});

test('refuses empty structured instructions before writing and preserves inputs', async () => {
  const inputPaths = [
    'data.json',
    'question.json',
    'evidence/case-test.log',
    'evidence/case-train.log',
    'evidence/case-validation.log',
  ];
  for (const instructions of [{}, []]) {
    const { root } = await fixture({ questionValue: { ...question, instructions } });
    try {
      const before = await Promise.all(inputPaths.map((path) => readFile(join(root, path))));
      assert.throws(() => validateLayaChoiceQuestion({ ...question, instructions }), { code: 'LAYA_TRAINING_DATA_INVALID' });
      await assert.rejects(
        exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'library-output' }),
        { code: 'LAYA_TRAINING_DATA_INVALID' },
      );
      assert.deepEqual(await Promise.all(inputPaths.map((path) => readFile(join(root, path)))), before);
      await assert.rejects(lstat(join(root, 'library-output')), { code: 'ENOENT' });

      await assert.rejects(
        exec(process.execPath, [scriptPath.pathname, '--project', root, '--dataset', 'data.json', '--question', 'question.json', '--output', 'cli-output', '--json'], { cwd: root }),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stderr, '');
          const lines = error.stdout.trim().split('\n');
          assert.equal(lines.length, 1);
          const result = JSON.parse(lines[0]);
          assert.equal(result.ok, false);
          assert.equal(result.error.code, 'LAYA_TRAINING_DATA_INVALID');
          return true;
        },
      );
      assert.deepEqual(await Promise.all(inputPaths.map((path) => readFile(join(root, path)))), before);
      await assert.rejects(lstat(join(root, 'cli-output')), { code: 'ENOENT' });
    } finally {
      await cleanup(root);
    }
  }
});

test('rejects duplicate JSON question keys, unsafe keys, and oversized input', () => {
  const duplicate = '{"type":"choice","instructions":"x","criteria":{"environment":"a","environment":"b","missing-context":"m","fixable-from-log":"f","unknown":"u"}}';
  assert.throws(() => parseLayaChoiceQuestion(duplicate), { code: 'LAYA_TRAINING_DATA_INVALID' });
  const unsafe = '{"type":"choice","instructions":"x","criteria":{"environment":"e","missing-context":"m","fixable-from-log":"f","unknown":"u","__proto__":"x"}}';
  assert.throws(() => parseLayaChoiceQuestion(unsafe), { code: 'LAYA_TRAINING_DATA_INVALID' });
  assert.throws(() => parseLayaChoiceQuestion(`{"type":"choice","instructions":"${'x'.repeat(512 * 1024)}","criteria":{}}`), { code: 'LAYA_TRAINING_DATA_INVALID' });
});

test('refuses a malformed real failure-triage observation instead of dropping it', () => {
  const malformed = datasetWithAllPartitions([{ ...caseValue({ id: 'malformed', partition: 'train' }), observation: { checkLog: 42 } }]);
  assert.throws(() => buildLayaTrainingRows(malformed, question), { code: 'LAYA_TRAINING_DATA_INVALID' });
});

test('refuses split leakage and empty required partitions from the #32 contract', () => {
  const leaked = datasetWithAllPartitions();
  leaked.cases[1].split.featureGroup = leaked.cases[0].split.featureGroup;
  assert.throws(() => buildLayaTrainingRows(leaked, question), { code: 'DECISION_DATASET_INVALID' });
  const missingValidation = datasetWithAllPartitions().cases.filter((item) => item.split.partition !== 'validation');
  assert.throws(() => buildLayaTrainingRows({ schemaVersion: 1, id: 'missing-validation', version: '1', cases: missingValidation }, question), { code: 'LAYA_TRAINING_DATA_INVALID' });
});

test('exports deterministic partitions and a provenance manifest without evidence payloads', async () => {
  const { root, dataset } = await fixture();
  try {
    const inputBefore = await Promise.all([
      readFile(join(root, 'data.json')),
      readFile(join(root, 'question.json')),
      readFile(join(root, 'evidence/case-train.log')),
    ]);
    const first = await exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out-one' });
    const second = await exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out-two' });
    for (const filename of ['train.jsonl', 'validation.jsonl', 'test.jsonl', 'manifest.json']) {
      const left = await readFile(join(root, 'out-one', filename), 'utf8');
      const right = await readFile(join(root, 'out-two', filename), 'utf8');
      assert.equal(left, right, filename);
    }
    const manifest = JSON.parse(await readFile(join(root, 'out-one', 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.consumer.revision, LAYA_CONSUMER_REVISION);
    assert.equal(manifest.dataset.normalizedSha256, decisionDatasetDigest(validateDecisionDataset(dataset)));
    assert.equal(manifest.counts.retainedCases, 3);
    assert.deepEqual(manifest.cases.map((item) => item.id), ['case-test', 'case-train', 'case-validation']);
    assert.deepEqual(manifest.cases[0].split, dataset.cases[0].split);
    assert.equal(manifest.cases[0].inputSha256, decisionCaseInputDigest(validateDecisionDataset(dataset).cases[0]));
    assert.equal(JSON.stringify(manifest).includes('reviewedBy'), false);
    assert.equal(JSON.stringify(manifest).includes('AssertionError'), false);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.manifestFile.sha256, sha256(await readFile(join(root, 'out-one', 'manifest.json'))));
    assert.deepEqual(await Promise.all([
      readFile(join(root, 'data.json')),
      readFile(join(root, 'question.json')),
      readFile(join(root, 'evidence/case-train.log')),
    ]), inputBefore);

    const changedDataset = structuredClone(dataset);
    changedDataset.cases.find((item) => item.id === 'case-train').observation.checkLog = 'changed input log';
    await writeFile(join(root, 'data.json'), `${JSON.stringify(changedDataset)}\n`);
    await exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out-three' });
    const changedManifest = JSON.parse(await readFile(join(root, 'out-three', 'manifest.json'), 'utf8'));
    const originalCase = manifest.cases.find((item) => item.id === 'case-train');
    const changedCase = changedManifest.cases.find((item) => item.id === 'case-train');
    assert.notEqual(changedCase.inputSha256, originalCase.inputSha256);
  } finally {
    await cleanup(root);
  }
});

test('validates evidence and input digests before any output write', async () => {
  const { root } = await fixture();
  try {
    await writeFile(join(root, 'evidence/case-train.log'), 'tampered\n');
    await assert.rejects(
      exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out' }),
      { code: 'DECISION_EVIDENCE_INVALID' },
    );
    await assert.rejects(lstat(join(root, 'out')), { code: 'ENOENT' });
  } finally {
    await cleanup(root);
  }
});

test('refuses output overwrite, traversal, symlinked question, and input collisions', async () => {
  const { root } = await fixture();
  try {
    await exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out' });
    await assert.rejects(
      exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: 'out' }),
      { code: 'LAYA_TRAINING_OUTPUT_INVALID' },
    );
    await assert.rejects(
      exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question.json', outputPath: '../outside' }),
      { code: 'INVALID_PATH' },
    );
    await assert.rejects(
      exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'data.json', outputPath: 'out-two' }),
      { code: 'LAYA_TRAINING_DATA_INVALID' },
    );
    await symlink(join(root, 'question.json'), join(root, 'question-link.json'));
    await assert.rejects(
      exportLayaTrainingData({ projectRoot: root, datasetPath: 'data.json', questionPath: 'question-link.json', outputPath: 'out-three' }),
      { code: 'SYMLINK_PATH' },
    );
  } finally {
    await cleanup(root);
  }
});

test('CLI --json emits one result object and preserves stdout discipline', async () => {
  const { root } = await fixture();
  try {
    const result = await exec(process.execPath, [scriptPath.pathname, '--project', root, '--dataset', 'data.json', '--question', 'question.json', '--output', 'out', '--json'], { cwd: root });
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.manifest.counts.retainedCases, 3);
  } finally {
    await cleanup(root);
  }
});
