import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateProfileDocument } from './config.mjs';
import { digestJson, tinyError } from './fs-utils.mjs';
import { REGISTRY_MANIFEST, findProfileById, isProfileId, profileLocations, profilesIn, tinysddConfigDir } from './model-registry.mjs';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

// The newest whole-suite baseline card is the headline; candidate cards are
// holdout-only and describe instructions the profile does not carry.
function headline(profile) {
  const cards = (profile.benchmarks ?? []).filter((card) => card.variant === 'baseline' && card.split === 'all');
  if (cards.length === 0) return null;
  const card = [...cards].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  return {
    suite: card.suite,
    date: card.date,
    exercises: card.exercises,
    ...(card.validExercises === undefined ? {} : { validExercises: card.validExercises }),
    pass1: card.pass1,
    pass2: card.pass2,
    ...(card.minutesPerTask === undefined ? {} : { minutesPerTask: card.minutesPerTask }),
  };
}

function summary(profile) {
  return {
    id: profile.id,
    status: profile.status ?? null,
    route: profile.model?.route ?? null,
    family: profile.model?.family ?? null,
    quantization: profile.model?.quantization ?? null,
    contextWindow: profile.model?.contextWindow ?? null,
    parallel: profile.model?.parallel ?? null,
    maxTokens: profile.responseBudget?.maxTokens ?? null,
    timeoutMs: profile.limits?.timeoutMs ?? null,
    thinking: profile.runtime?.thinking ?? null,
    benchmarks: profile.benchmarks?.length ?? 0,
    headline: headline(profile),
  };
}

export async function readRegistryInfo(env = process.env) {
  const dir = join(tinysddConfigDir(env), 'registry');
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return { dir, installed: false, version: null };
  } catch {
    return { dir, installed: false, version: null };
  }
  try {
    const manifest = JSON.parse(await readFile(join(dir, REGISTRY_MANIFEST), 'utf8'));
    return { dir, installed: true, version: typeof manifest.version === 'string' ? manifest.version : null };
  } catch {
    return { dir, installed: true, version: null };
  }
}

// Every profile TinySDD can select by id, most specific location first. An id
// found twice with the same content is listed once; with different content it
// is listed per file and marked as a conflict, because selecting it fails.
export async function listProfiles(projectRoot, { env = process.env } = {}) {
  const byId = new Map();
  const invalid = [];
  for (const { location, dir } of profileLocations(projectRoot, env)) {
    for (const entry of await profilesIn(dir)) {
      if (entry.value === null) {
        invalid.push({ location, path: entry.path, error: 'malformed JSON' });
        continue;
      }
      let profile;
      try {
        profile = validateProfileDocument(entry.value, entry.path);
      } catch (error) {
        invalid.push({ location, path: entry.path, error: error.message });
        continue;
      }
      const digest = digestJson(entry.value);
      if (!byId.has(profile.id)) byId.set(profile.id, []);
      const copies = byId.get(profile.id);
      const same = copies.find((copy) => copy.digest === digest);
      if (same) same.locations.push(location);
      else copies.push({ digest, profile, location, path: entry.path, locations: [location] });
    }
  }
  const profiles = [];
  for (const copies of byId.values()) {
    for (const copy of copies) {
      profiles.push({ ...summary(copy.profile), location: copy.location, locations: copy.locations, path: copy.path, conflict: copies.length > 1 });
    }
  }
  profiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { profiles, invalid };
}

// Profiles measured on exactly this route that can be selected without error.
export async function profilesForRoute(projectRoot, route, { env = process.env } = {}) {
  const { profiles } = await listProfiles(projectRoot, { env });
  return profiles.filter((profile) => profile.route === route && !profile.conflict);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
}

export function defaultProfileId(route) {
  return `${slug(route).replace(/\.json$/u, '')}-local-v1`;
}

function positiveInteger(value, name) {
  if (value === undefined || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || (typeof value === 'string' && !/^\d+$/u.test(value))) {
    throw tinyError('INVALID_ARGUMENT', `${name} must be a positive integer`);
  }
  return number;
}

// Builds a configuration-only profile (no instructions) and validates it with
// the same rules as every other profile.
export function buildLocalProfile(answers) {
  const route = typeof answers.route === 'string' ? answers.route.trim() : '';
  if (!route) throw tinyError('INVALID_ARGUMENT', 'route is required: the worker model id this profile is for');
  const id = answers.id ? String(answers.id) : defaultProfileId(route);
  if (!isProfileId(id)) throw tinyError('INVALID_ARGUMENT', `invalid profile id: ${id} (use lowercase letters, digits, dot, dash and underscore)`);
  if (answers.thinking !== undefined && answers.thinking !== '' && !THINKING_LEVELS.includes(answers.thinking)) {
    throw tinyError('INVALID_ARGUMENT', `thinking must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  const model = { route };
  for (const key of ['family', 'quantization']) if (answers[key]) model[key] = String(answers[key]);
  if (answers.server) model.server = { id: String(answers.server) };
  const contextWindow = positiveInteger(answers.contextWindow, 'context window');
  const parallel = positiveInteger(answers.parallel, 'parallel');
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (parallel !== undefined) model.parallel = parallel;
  const profile = { schemaVersion: 1, id, status: 'proposed', model };
  if (answers.thinking) profile.runtime = { thinking: answers.thinking };
  const maxTokens = positiveInteger(answers.maxTokens, 'max tokens');
  if (maxTokens !== undefined) profile.responseBudget = { maxTokens };
  const timeoutMs = positiveInteger(answers.timeoutMs, 'timeout');
  if (timeoutMs !== undefined) profile.limits = { timeoutMs };
  profile.instructions = '';
  profile.evidence = [];
  profile.limitations = ['Created with tinysdd profiles new; not benchmarked.'];
  validateProfileDocument(profile, `new profile ${id}`);
  return profile;
}

// Writes the profile to the user's profile directory. An id that already
// exists anywhere TinySDD looks is refused, so a lookup never becomes ambiguous.
export async function writeLocalProfile(projectRoot, profile, { env = process.env } = {}) {
  try {
    const found = await findProfileById(projectRoot, profile.id, { env });
    throw tinyError('PROFILE_EXISTS', `profile ${profile.id} already exists: ${found.path}; choose another id`);
  } catch (error) {
    if (error.code !== 'PROFILE_NOT_FOUND') throw error;
  }
  const dir = join(tinysddConfigDir(env), 'profiles');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${profile.id}.json`);
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return { path, profile };
}

export { THINKING_LEVELS };
