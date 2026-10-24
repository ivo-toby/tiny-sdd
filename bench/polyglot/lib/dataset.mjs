import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative, sep } from 'node:path';

export const LANGUAGES = ['cpp', 'go', 'java', 'javascript', 'python', 'rust'];
export const SOURCE_REPO = 'https://github.com/Aider-AI/polyglot-benchmark';

export class DatasetError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DatasetError';
    this.code = code;
    this.details = details;
  }
}

const hashId = (id) => createHash('sha256').update(id).digest('hex');
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Within each language, the first ceil(n/2) ids by sha256(id) are discovery,
// the rest holdout. Independent of input order.
export function assignSplit(ids) {
  const seen = new Set();
  const perLanguage = new Map();
  for (const id of ids) {
    if (seen.has(id)) throw new DatasetError('DUPLICATE_ID', `duplicate exercise id ${id}`);
    seen.add(id);
    const language = id.split('/')[0];
    if (!perLanguage.has(language)) perLanguage.set(language, []);
    perLanguage.get(language).push(id);
  }
  const split = {};
  for (const list of perLanguage.values()) {
    const sorted = list
      .map((id) => ({ id, h: hashId(id) }))
      .sort((a, b) => byString(a.h, b.h));
    const discoveryCount = Math.ceil(sorted.length / 2);
    sorted.forEach(({ id }, i) => {
      split[id] = i < discoveryCount ? 'discovery' : 'holdout';
    });
  }
  return split;
}

function gitHead(checkoutDir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', checkoutDir, 'rev-parse', 'HEAD'], (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExercise(checkoutDir, language, name) {
  const dir = `${language}/exercises/practice/${name}`;
  const abs = join(checkoutDir, dir);
  const config = JSON.parse(await readFile(join(abs, '.meta', 'config.json'), 'utf8'));
  const files = config.files ?? {};
  const solutionFiles = files.solution ?? [];
  const testFiles = files.test ?? [];
  const exampleFiles = files.example ?? [];
  if (solutionFiles.length === 0 || testFiles.length === 0) {
    throw new DatasetError('BAD_CONFIG', `${dir} lists no solution or test files`);
  }
  for (const rel of [...solutionFiles, ...testFiles]) {
    if ((await readOptional(join(abs, rel))) === null) {
      throw new DatasetError('MISSING_FILE', `${dir}/${rel} is listed in config but missing`);
    }
  }
  const instructionsMd = await readOptional(join(abs, '.docs', 'instructions.md'));
  if (instructionsMd === null) {
    throw new DatasetError('MISSING_FILE', `${dir}/.docs/instructions.md is missing`);
  }
  const append = await readOptional(join(abs, '.docs', 'instructions.append.md'));
  const instructions = append === null ? instructionsMd : `${instructionsMd}\n\n${append}`;
  return {
    id: `${language}/${name}`,
    language,
    dir,
    solutionFiles,
    testFiles,
    exampleFiles,
    instructions,
  };
}

export async function buildManifest({ checkoutDir, languages = LANGUAGES }) {
  const exercises = [];
  for (const language of languages) {
    const practice = join(checkoutDir, language, 'exercises', 'practice');
    const names = (await readdir(practice, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byString);
    for (const name of names) {
      exercises.push(await readExercise(checkoutDir, language, name));
    }
  }
  exercises.sort((a, b) => byString(a.id, b.id));
  const split = assignSplit(exercises.map((e) => e.id));
  for (const exercise of exercises) exercise.split = split[exercise.id];
  return {
    schemaVersion: 1,
    source: { repo: SOURCE_REPO, commit: await gitHead(checkoutDir) },
    exercises,
  };
}

// Pairs each solution file with the reference example file it is copied from.
// Pass 1 matches by basename; pass 2 matches the remaining files of one
// extension when exactly one solution and one example are left. Anything else
// is reported, not guessed.
export function mapExamples(solutionFiles, exampleFiles) {
  const notes = [];
  const pairs = [];
  const usedSolution = new Set();
  const usedExample = new Set();
  const pair = (solution, example) => {
    pairs.push({ solution, example });
    usedSolution.add(solution);
    usedExample.add(example);
  };
  for (const solution of solutionFiles) {
    const matches = exampleFiles.filter(
      (example) => !usedExample.has(example) && basename(example) === basename(solution),
    );
    if (matches.length === 1) pair(solution, matches[0]);
    else if (matches.length > 1) notes.push(`several examples named ${basename(solution)}`);
  }
  for (const solution of solutionFiles) {
    if (usedSolution.has(solution)) continue;
    const ext = extname(solution);
    const solutionCandidates = solutionFiles.filter(
      (s) => !usedSolution.has(s) && extname(s) === ext,
    );
    const exampleCandidates = exampleFiles.filter(
      (e) => !usedExample.has(e) && extname(e) === ext,
    );
    if (solutionCandidates.length === 1 && exampleCandidates.length === 1) {
      pair(solution, exampleCandidates[0]);
    }
  }
  return {
    pairs,
    unmappedSolution: solutionFiles.filter((s) => !usedSolution.has(s)),
    unusedExamples: exampleFiles.filter((e) => !usedExample.has(e)),
    notes,
  };
}

function validateOverlay(exercise, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    const normalized = posix.normalize(key);
    if (
      normalized !== key ||
      key.startsWith('/') ||
      key.startsWith('..') ||
      !exercise.solutionFiles.includes(key)
    ) {
      throw new DatasetError(
        'OVERLAY_PATH_NOT_SOLUTION',
        `overlay path ${key} is not a solution file of ${exercise.id}`,
        { allowed: exercise.solutionFiles },
      );
    }
    if (typeof value !== 'string') {
      throw new DatasetError('OVERLAY_NOT_TEXT', `overlay value for ${key} must be a string`);
    }
  }
}

// Copies the exercise into destDir without .meta/ (reference solution) and
// .docs/ (instructions are passed inline), then writes overlay over solution files.
export async function prepareWorkspace({ checkoutDir, exercise, destDir, overlay = {} }) {
  validateOverlay(exercise, overlay);
  const source = join(checkoutDir, exercise.dir);
  await mkdir(destDir, { recursive: true });
  await cp(source, destDir, {
    recursive: true,
    filter: (path) => {
      const top = relative(source, path).split(sep)[0];
      return top !== '.meta' && top !== '.docs';
    },
  });
  for (const [key, value] of Object.entries(overlay)) {
    const target = join(destDir, key);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  return { workDir: destDir, overlaid: Object.keys(overlay) };
}

export async function readReferenceFiles(checkoutDir, exercise) {
  const mapping = mapExamples(exercise.solutionFiles, exercise.exampleFiles);
  const overlay = {};
  for (const { solution, example } of mapping.pairs) {
    overlay[solution] = await readFile(join(checkoutDir, exercise.dir, example), 'utf8');
  }
  return { overlay, mapping };
}
