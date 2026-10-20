import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { featuresFor } from './features.mjs';
import { triageLabel } from './triage.mjs';

const INSTRUCTIONS_LIMIT = 3000;
const DIFF_LIMIT = 4000;
const TEST_OUTPUT_LIMIT = 3000;
const DIFF_CONTEXT = 2;
const MAX_DP_CELLS = 4_000_000;

function tailOf(text, limit) {
  return text.length > limit ? `[...trimmed]\n${text.slice(text.length - limit)}` : text;
}

function headOf(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n[...trimmed]` : text;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson(path) {
  const text = await readText(path);
  return text === null ? null : JSON.parse(text);
}

async function readJsonl(path) {
  const text = await readText(path);
  if (text === null) return [];
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// Simple LCS line diff. Returns hunks with DIFF_CONTEXT lines of context, no dependencies.
export function lineDiff(oldText, newText, { context = DIFF_CONTEXT } = {}) {
  const a = oldText === null ? [] : oldText.split('\n');
  const b = newText === null ? [] : newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push([' ', a[i]]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DP_CELLS) {
    for (const line of midA) ops.push(['-', line]);
    for (const line of midB) ops.push(['+', line]);
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([' ', midA[i]]);
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        ops.push(['-', midA[i]]);
        i += 1;
      } else {
        ops.push(['+', midB[j]]);
        j += 1;
      }
    }
    while (i < n) ops.push(['-', midA[i++]]);
    while (j < m) ops.push(['+', midB[j++]]);
  }
  for (let k = endA; k < a.length; k += 1) ops.push([' ', a[k]]);

  const keep = new Array(ops.length).fill(false);
  ops.forEach(([sign], index) => {
    if (sign === ' ') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = true;
  });
  const lines = [];
  let previousKept = -2;
  ops.forEach(([sign, line], index) => {
    if (!keep[index]) return;
    if (index !== previousKept + 1 && lines.length > 0) lines.push('@@');
    lines.push(`${sign}${line}`);
    previousKept = index;
  });
  return lines.join('\n');
}

function fenced(text) {
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}\n${text}\n${fence}`;
}

async function solutionDiff(checkoutDir, exercise, retainedDir) {
  const parts = [];
  for (const file of exercise.solutionFiles) {
    if (file.split(/[\\/]/).includes('.meta') || file.split(/[\\/]/).includes('.docs')) {
      throw new Error(`refusing to export reference path: ${file}`);
    }
    const stub = await readText(join(checkoutDir, exercise.dir, file));
    const retained = await readText(join(retainedDir, file));
    const body = lineDiff(stub, retained);
    if (body) parts.push(`--- a/${file}\n+++ b/${file}\n${body}`);
  }
  return headOf(parts.join('\n'), DIFF_LIMIT);
}

export async function exportFailures({
  runDir,
  model,
  profile = 'baseline',
  split = 'discovery',
  out = join(runDir, 'export'),
  manifest,
  checkoutDir,
  metric = 'pass1',
}) {
  if (!['pass1', 'pass2'].includes(metric)) throw new Error('metric must be pass1 or pass2');
  if (split !== 'discovery') throw new Error('export covers discovery exercises only');
  const root = resolve(runDir);
  const dataRoot = dirname(dirname(root));
  const benchManifest = manifest ?? await readJson(join(dataRoot, 'manifest.json'));
  if (!benchManifest) throw new Error('manifest.json not found; pass manifest explicitly');
  const checkout = checkoutDir ?? join(dataRoot, 'polyglot-benchmark');
  const exercises = new Map(benchManifest.exercises
    .filter((exercise) => exercise.split === 'discovery')
    .map((exercise) => [exercise.id, exercise]));

  const results = await readJsonl(join(root, 'results.jsonl'));
  const failures = results
    .filter((result) => result.model === model && result.profile === profile && result.split === split && !result[metric])
    .filter((result) => exercises.has(result.exercise))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const items = [];
  for (const result of failures) {
    const exercise = exercises.get(result.exercise);
    // For pass@1 the first attempt is what an instruction must fix, even if the revision recovered.
    const attempt = metric === 'pass1' ? result.attempts[0] : result.attempts.at(-1);
    const retainedDir = join(root, 'cases', result.id, `attempt-${attempt.n}`, 'solution');
    const triageRecord = await readJson(join(root, 'triage', `${result.id}.json`));
    const labels = triageRecord?.answers
      ? Object.fromEntries(Object.entries(triageRecord.answers).map(([id, answer]) => [id, { noul: answer?.noul ?? null, label: triageLabel(answer) }]))
      : null;
    items.push({
      id: result.id,
      exercise: result.exercise,
      language: result.language,
      repeat: result.repeat,
      shownAttempt: attempt.n,
      recoveredOnAttempt2: metric === 'pass1' ? Boolean(result.pass2) : false,
      features: featuresFor(result),
      instructions: headOf(exercise.instructions ?? '', INSTRUCTIONS_LIMIT),
      diff: await solutionDiff(checkout, exercise, retainedDir),
      testOutput: tailOf(attempt.test?.outputTail ?? '', TEST_OUTPUT_LIMIT),
      triage: labels,
    });
  }

  const lines = [`# Failures: ${model} / ${profile} (${split}, ${metric})`, '', `Count: ${items.length}`, metric === 'pass1' ? 'Each item shows the first attempt (what failed before any test feedback).' : 'Each item shows the last attempt.', ''];
  for (const item of items) {
    lines.push(`## ${item.id}`, '');
    lines.push(`- exercise: ${item.exercise}`, `- language: ${item.language}`, `- repeat: ${item.repeat}`, `- shown attempt: ${item.shownAttempt}${item.recoveredOnAttempt2 ? ' (attempt 2 passed after seeing the test output)' : ''}`);
    lines.push(`- features: ${item.features.join(', ') || 'none'}`);
    if (item.triage) {
      const labelled = Object.entries(item.triage).filter(([, value]) => value.label).map(([id]) => id);
      lines.push(`- jev labels: ${labelled.join(', ') || 'none'}`);
    }
    lines.push('', '### Instructions', '', fenced(item.instructions), '');
    lines.push('### Solution diff vs stub', '', item.diff ? fenced(item.diff) : '_No changes._', '');
    lines.push('### Test output (tail)', '', fenced(item.testOutput), '');
  }

  await mkdir(out, { recursive: true });
  const markdownPath = join(out, 'failures.md');
  const jsonPath = join(out, 'failures.json');
  await writeFile(markdownPath, `${lines.join('\n')}\n`);
  await writeFile(jsonPath, `${JSON.stringify({ model, profile, split, metric, items }, null, 2)}\n`);
  return { count: items.length, markdownPath, jsonPath };
}
