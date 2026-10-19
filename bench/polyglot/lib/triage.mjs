import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const TRIAGE_THRESHOLD = 0.7;
const STATE_LIMIT = 4000;

export const TRIAGE_QUESTIONS = {
  signature: {
    instruction: "Does the test output show the implementation's function/class names or signatures do not match what the tests call?",
    criteria: {
      true: 'The test output shows calls to names or signatures that the implementation does not provide.',
      false: 'Names and signatures in the test output match what the implementation provides.',
    },
  },
  edge_case: {
    instruction: 'Do the failing tests check an edge case or error condition that the instructions mention?',
    criteria: {
      true: 'A failing test checks an edge case or error condition that the instructions mention.',
      false: 'The failing tests do not check an edge case or error condition named in the instructions.',
    },
  },
  incomplete: {
    instruction: 'Does the solution leave parts unimplemented (stubs, TODO, placeholder returns)?',
    criteria: {
      true: 'The solution contains stubs, TODOs or placeholder returns.',
      false: 'The solution has no stubs, TODOs or placeholder returns.',
    },
  },
  misread: {
    instruction: 'Does the failure show the implementation solves a different problem than the instructions describe?',
    criteria: {
      true: 'The implementation solves a different problem than the instructions describe.',
      false: 'The implementation solves the problem the instructions describe.',
    },
  },
  env: {
    instruction: 'Does the failure come from build or tooling problems rather than the solution logic?',
    criteria: {
      true: 'The failure comes from build or tooling problems.',
      false: 'The failure comes from the solution logic.',
    },
  },
};

export function triageLabel(answer) {
  return typeof answer?.noul === 'number' && answer.noul >= TRIAGE_THRESHOLD;
}

function headOf(text, limit) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function tailOf(text, limit) {
  return text.length > limit ? text.slice(text.length - limit) : text;
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

async function retainedSolution(caseDir, files) {
  const parts = [];
  for (const file of files) {
    const text = await readText(join(caseDir, 'solution', file));
    if (text !== null) parts.push(`// ${file}\n${text}`);
  }
  return parts.join('\n');
}

function buildBody(state) {
  const questions = Object.fromEntries(Object.entries(TRIAGE_QUESTIONS).map(([id, question]) => [
    id,
    { type: 'noul', instruction: question.instruction, criteria: question.criteria },
  ]));
  return { model: JEV_MODEL, state, questions };
}

// Failure triage through Jev. One POST per failed result, all questions batched.
// Never throws on Jev problems: missing key, HTTP or network errors are recorded
// as { unavailable: true, reason } and the run continues.
export async function triage({
  runDir,
  model,
  profile,
  split = 'discovery',
  manifest,
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  const root = resolve(runDir);
  const dataRoot = dirname(dirname(root));
  const benchManifest = manifest ?? await readJson(join(dataRoot, 'manifest.json'));
  if (!benchManifest) throw new Error('manifest.json not found; pass manifest explicitly');
  const exercises = new Map(benchManifest.exercises.map((exercise) => [exercise.id, exercise]));

  const results = await readJsonl(join(root, 'results.jsonl'));
  const failures = results.filter((result) => result.model === model
    && result.profile === profile
    && result.split === split
    && !result.pass2);
  const triageDir = join(root, 'triage');
  const summary = { failures: failures.length, called: 0, unavailable: 0, skipped: 0 };

  for (const result of failures) {
    const outPath = join(triageDir, `${result.id}.json`);
    const existing = await readJson(outPath);
    if (existing && !existing.unavailable) {
      summary.skipped += 1;
      continue;
    }
    await mkdir(triageDir, { recursive: true });

    const apiKey = env.JEV_API_KEY;
    if (!apiKey) {
      await writeFile(outPath, `${JSON.stringify({ unavailable: true, reason: 'missing JEV_API_KEY' }, null, 2)}\n`);
      summary.unavailable += 1;
      continue;
    }

    const attempt = result.attempts.at(-1);
    const exercise = exercises.get(result.exercise);
    const caseDir = join(root, 'cases', result.id, `attempt-${attempt.n}`);
    const state = {
      instructions: headOf(exercise?.instructions ?? '', STATE_LIMIT),
      testOutput: tailOf(attempt.test?.outputTail ?? '', STATE_LIMIT),
      solutionExcerpt: headOf(await retainedSolution(caseDir, exercise?.solutionFiles ?? []), STATE_LIMIT),
    };

    summary.called += 1;
    let record;
    try {
      const response = await fetchImpl(JEV_API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildBody(state)),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        record = { unavailable: true, reason: `HTTP ${response.status}: ${headOf(detail, 200)}` };
      } else {
        const json = await response.json();
        const answers = Object.fromEntries(Object.keys(TRIAGE_QUESTIONS).map((id) => [
          id,
          { type: 'noul', noul: typeof json.answers?.[id]?.noul === 'number' ? json.answers[id].noul : null },
        ]));
        record = { answers, modelVersion: json.model ?? null };
      }
    } catch (error) {
      record = { unavailable: true, reason: `network: ${error.message}` };
    }
    if (record.unavailable) summary.unavailable += 1;
    await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  return summary;
}
