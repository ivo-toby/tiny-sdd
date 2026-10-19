import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { featuresFor } from './features.mjs';
import { mcnemar, rate, summarize } from './stats.mjs';

const REFERENCE_PROFILES = ['baseline', 'baseline-rerun'];

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function signedPct(value) {
  if (value === null) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}pp`;
}

function pValue(value) {
  return value < 0.001 ? '<0.001' : value.toFixed(3);
}

function markdownTable(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pairKey(result) {
  return `${result.exercise}|${result.split}|${result.repeat}`;
}

// Pairs candidate and reference results on (exercise, split, repeat).
function comparePair(results, model, candidate, reference) {
  const refByKey = new Map();
  const candByKey = new Map();
  for (const result of results) {
    if (result.model !== model) continue;
    if (result.profile === reference) refByKey.set(pairKey(result), result);
    if (result.profile === candidate) candByKey.set(pairKey(result), result);
  }
  const pairs = [];
  for (const [key, cand] of candByKey) {
    const ref = refByKey.get(key);
    if (ref) pairs.push({ x: Boolean(ref.pass2), y: Boolean(cand.pass2) });
  }
  const n = pairs.length;
  const refPasses = pairs.filter((pair) => pair.x).length;
  const candPasses = pairs.filter((pair) => pair.y).length;
  const test = mcnemar(pairs);
  return {
    model,
    candidate,
    reference,
    n,
    candidatePass2: rate(candPasses, n),
    referencePass2: rate(refPasses, n),
    delta: n > 0 ? (candPasses - refPasses) / n : null,
    b: test.b,
    c: test.c,
    p: test.p,
  };
}

export function buildReport(results) {
  const overview = summarize(results, { groupBy: ['model', 'profile'] });
  const perLanguage = summarize(results, { groupBy: ['model', 'profile', 'language'] });

  const featureCounts = new Map();
  for (const result of results) {
    const scope = `${result.model}\u0000${result.profile}`;
    if (!featureCounts.has(scope)) featureCounts.set(scope, new Map());
    const counts = featureCounts.get(scope);
    for (const feature of featuresFor(result)) counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }

  const comparisons = [];
  const models = [...new Set(results.map((result) => result.model))].sort();
  for (const model of models) {
    const profiles = [...new Set(results.filter((r) => r.model === model).map((r) => r.profile))].sort();
    const candidates = profiles.filter((profile) => !REFERENCE_PROFILES.includes(profile));
    for (const candidate of candidates) {
      for (const reference of REFERENCE_PROFILES) {
        if (!profiles.includes(reference)) continue;
        const row = comparePair(results, model, candidate, reference);
        if (row.n > 0) comparisons.push(row);
      }
    }
  }

  const sections = ['# Polyglot benchmark report', ''];
  sections.push(`Results: ${results.length}`, '');

  sections.push('## Overview', '');
  sections.push(markdownTable(
    ['model', 'profile', 'n', 'pass@1', 'pass@2'],
    overview.map((g) => [g.group.model, g.group.profile, g.n, pct(g.pass1Rate), pct(g.pass2Rate)]),
  ), '');

  sections.push('## Pass@2 per language', '');
  sections.push(markdownTable(
    ['model', 'profile', 'language', 'n', 'pass@2'],
    perLanguage.map((g) => [g.group.model, g.group.profile, g.group.language, g.n, pct(g.pass2Rate)]),
  ), '');

  sections.push('## Feature counts', '');
  const featureRows = [];
  for (const [scope, counts] of [...featureCounts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [model, profile] = scope.split('\u0000');
    for (const [feature, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      featureRows.push([model, profile, feature, count]);
    }
  }
  sections.push(featureRows.length
    ? markdownTable(['model', 'profile', 'feature', 'count'], featureRows)
    : '_No features recorded._', '');

  sections.push('## Candidate vs baseline (paired on exercise, split, repeat)', '');
  sections.push(comparisons.length
    ? markdownTable(
      ['model', 'candidate', 'reference', 'n', 'candidate pass@2', 'reference pass@2', 'delta pass@2', 'b', 'c', 'McNemar p'],
      comparisons.map((row) => [
        row.model, row.candidate, row.reference, row.n,
        pct(row.candidatePass2), pct(row.referencePass2), signedPct(row.delta),
        row.b, row.c, pValue(row.p),
      ]),
    )
    : '_No paired candidate results._', '');

  const csvLines = ['model,profile,scope,language,n,pass1,pass2,pass1_rate,pass2_rate'];
  for (const g of overview) {
    csvLines.push([g.group.model, g.group.profile, 'all', 'all', g.n, g.pass1, g.pass2, g.pass1Rate ?? '', g.pass2Rate ?? ''].map(csvCell).join(','));
  }
  for (const g of perLanguage) {
    csvLines.push([g.group.model, g.group.profile, 'language', g.group.language, g.n, g.pass1, g.pass2, g.pass1Rate ?? '', g.pass2Rate ?? ''].map(csvCell).join(','));
  }

  return { markdown: `${sections.join('\n')}\n`, csv: `${csvLines.join('\n')}\n` };
}

async function readJsonl(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

export async function report({ runDir }) {
  const results = await readJsonl(join(runDir, 'results.jsonl'));
  const { markdown, csv } = buildReport(results);
  const reportPath = join(runDir, 'report.md');
  const csvPath = join(runDir, 'report.csv');
  await writeFile(reportPath, markdown);
  await writeFile(csvPath, csv);
  return { reportPath, csvPath, results: results.length };
}
