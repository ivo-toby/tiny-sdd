import { lstat, open } from 'node:fs/promises';
import { compileContext, contextSizeMetrics, MAX_COMPILED_CONTEXT_BYTES, parseContextManifest } from './context-compiler.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import {
  assertExactKeys,
  assertPlainObject,
  canonicalProjectRoot,
  digestJson,
  normalizeProjectRelative,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_ARTIFACT_FILE_BYTES = 512 * 1024;
export const MAX_CHANGE_SLICES = 64;
export const MAX_CHANGE_DELTAS = 64;
export const MAX_INTEGRATION_ENTRIES = 256;
export const MAX_CRITERION_ENTRIES = 256;
export const MAX_RETAINED_OUTPUT_BYTES = 32 * 1024 * 1024;
export const RUNTIME_SCOPE = Object.freeze({ mode: 'legacy-allowlist', extraOrdinaryFiles: false, followUpIssue: 82 });

// Keep these exclusions aligned with the worker copy boundary. Artifact
// validation must reject the names before it opens a referenced file.
const PROJECT_SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/iu;
const PROJECT_SECRET_DIR = /^(?:\.aws|\.azure|\.gcloud|\.ssh|secrets?|credentials?)$/iu;

const SLUG = /^[a-z0-9][a-z0-9_-]*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set(['add', 'modify', 'remove']);
const CHANGE_KEYS = ['schemaVersion', 'id', 'proposal', 'design', 'specDeltas', 'slices', 'budget', 'featureTests', 'featureChecks', 'integration'];
const DELTA_KEYS = ['schemaVersion', 'spec', 'baseSha256', 'changes'];
const DELTA_CHANGE_KEYS = ['operation', 'id', 'text'];
const SLICE_KEYS = ['schemaVersion', 'id', 'brief', 'context', 'checks', 'implementationFiles', 'sliceTests', 'protect', 'interfaces', 'dependsOn', 'budget', 'openDecisions', 'testReview'];
const BUDGET_KEYS = ['maxImplementationFiles', 'maxSliceTestFiles', 'maxCompiledContextBytes'];
const INTEGRATION_KEYS = ['id', 'requirementIds', 'entrypoints', 'wiringSlice', 'testPaths', 'checkIds'];
const REVIEW_KEYS = ['schemaVersion', 'workflow', 'criteria'];
const CRITERION_KEYS = ['id', 'requirementIds', 'question', 'interfaces', 'testPaths'];

function invalid(message, details) {
  throw tinyError('ARTIFACT_FORMAT_INVALID', message, details);
}

function notReady(message, details) {
  throw tinyError('CHANGE_NOT_READY', message, details);
}

function nonemptyText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${label} must be nonempty text`);
  return value;
}

function slug(value, label) {
  if (typeof value !== 'string' || !SLUG.test(value)) invalid(`${label} must match /^[a-z0-9][a-z0-9_-]*$/`);
  return value;
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid(`${label} must be a SHA-256 digest`);
  return value;
}

function safePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`);
  return value;
}

function path(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/')) {
    invalid(`${label} must be a project-relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) invalid(`${label} contains traversal or an empty path component`);
  try {
    const normalized = normalizeProjectRelative(value, label);
    if (normalized !== value) invalid(`${label} is not normalized`);
    assertArtifactPathAllowed(normalized, label);
    return normalized;
  } catch (error) {
    if (error?.code === 'ARTIFACT_CREDENTIAL_PATH') throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function isCredentialPath(value) {
  const parts = value.split('/');
  return parts.some((part, index) => PROJECT_SECRET_NAME.test(part) || (index < parts.length - 1 && PROJECT_SECRET_DIR.test(part)));
}

export function assertArtifactPathAllowed(value, label = 'artifact path') {
  if (isCredentialPath(value)) {
    throw tinyError('ARTIFACT_CREDENTIAL_PATH', `${label} names a credential or secret path: ${value}`, { path: value });
  }
  return value;
}

function uniquePaths(value, label, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(`${label} must be a${nonempty ? ' nonempty' : ''} array`);
  const result = value.map((item, index) => path(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate paths`);
  return result;
}

function uniqueSlugs(value, label, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(`${label} must be a${nonempty ? ' nonempty' : ''} array`);
  const result = value.map((item, index) => slug(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate ids`);
  return result;
}

function parseBudget(value, label, { nullable = false } = {}) {
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', label);
  assertExactKeys(value, BUDGET_KEYS, 'ARTIFACT_FORMAT_INVALID', label);
  return Object.fromEntries(BUDGET_KEYS.map((key) => {
    const item = value[key];
    if (nullable && item === null) return [key, null];
    return [key, safePositiveInteger(item, `${label}.${key}`)];
  }));
}

function parseReview(value) {
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', 'slice test review contract');
  assertExactKeys(value, REVIEW_KEYS, 'ARTIFACT_FORMAT_INVALID', 'slice test review contract');
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) invalid('slice test review contract schemaVersion must be 1');
  if (value.workflow !== 'slice-tests') invalid('slice test review contract workflow must be slice-tests');
  if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > MAX_CRITERION_ENTRIES) {
    invalid(`slice test review contract criteria must contain between 1 and ${MAX_CRITERION_ENTRIES} items`);
  }
  const ids = new Set();
  const criteria = value.criteria.map((criterion, index) => {
    const label = `slice test review criterion ${index + 1}`;
    assertPlainObject(criterion, 'ARTIFACT_FORMAT_INVALID', label);
    assertExactKeys(criterion, CRITERION_KEYS, 'ARTIFACT_FORMAT_INVALID', label);
    const id = slug(criterion.id, `${label}.id`);
    if (ids.has(id)) invalid(`slice test review criteria contains duplicate id: ${id}`);
    ids.add(id);
    const requirementIds = uniqueSlugs(criterion.requirementIds, `${label}.requirementIds`, { nonempty: true });
    const interfaces = uniquePaths(criterion.interfaces, `${label}.interfaces`, { nonempty: true });
    const testPaths = uniquePaths(criterion.testPaths, `${label}.testPaths`, { nonempty: true });
    return { id, requirementIds, question: nonemptyText(criterion.question, `${label}.question`), interfaces, testPaths };
  });
  return { schemaVersion: 1, workflow: 'slice-tests', criteria };
}

function parseIntegration(value, index) {
  const label = `integration ${index + 1}`;
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', label);
  assertExactKeys(value, INTEGRATION_KEYS, 'ARTIFACT_FORMAT_INVALID', label);
  return {
    id: slug(value.id, `${label}.id`),
    requirementIds: uniqueSlugs(value.requirementIds, `${label}.requirementIds`, { nonempty: true }),
    entrypoints: uniquePaths(value.entrypoints, `${label}.entrypoints`, { nonempty: true }),
    wiringSlice: slug(value.wiringSlice, `${label}.wiringSlice`),
    testPaths: uniquePaths(value.testPaths, `${label}.testPaths`, { nonempty: true }),
    checkIds: uniqueSlugs(value.checkIds, `${label}.checkIds`, { nonempty: true }),
  };
}

export function parseChangeDocument(text) {
  if (typeof text !== 'string') invalid('change descriptor must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`change descriptor is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', 'change descriptor');
  assertExactKeys(value, CHANGE_KEYS, 'ARTIFACT_FORMAT_INVALID', 'change descriptor');
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) invalid('change descriptor schemaVersion must be 1');
  const integration = Array.isArray(value.integration) && value.integration.length > 0 && value.integration.length <= MAX_INTEGRATION_ENTRIES
    ? value.integration.map(parseIntegration)
    : invalid(`change integration must contain between 1 and ${MAX_INTEGRATION_ENTRIES} items`);
  const integrationIds = new Set(integration.map((item) => item.id));
  if (integrationIds.size !== integration.length) invalid('change integration contains duplicate ids');
  return {
    schemaVersion: 1,
    id: slug(value.id, 'change.id'),
    proposal: path(value.proposal, 'change.proposal'),
    design: path(value.design, 'change.design'),
    specDeltas: uniquePaths(value.specDeltas, 'change.specDeltas', { nonempty: true }),
    slices: uniquePaths(value.slices, 'change.slices', { nonempty: true }),
    budget: parseBudget(value.budget, 'change.budget'),
    featureTests: uniquePaths(value.featureTests, 'change.featureTests', { nonempty: true }),
    featureChecks: path(value.featureChecks, 'change.featureChecks'),
    integration,
  };
}

export function parseDeltaDocument(text) {
  if (typeof text !== 'string') invalid('delta descriptor must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`delta descriptor is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', 'delta descriptor');
  assertExactKeys(value, DELTA_KEYS, 'ARTIFACT_FORMAT_INVALID', 'delta descriptor');
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) invalid('delta descriptor schemaVersion must be 1');
  const changes = value.changes;
  if (!Array.isArray(changes) || changes.length === 0) invalid('delta changes must be a nonempty array');
  const ids = new Set();
  const parsedChanges = changes.map((item, index) => {
    const label = `delta change ${index + 1}`;
    assertPlainObject(item, 'ARTIFACT_FORMAT_INVALID', label);
    assertExactKeys(item, DELTA_CHANGE_KEYS, 'ARTIFACT_FORMAT_INVALID', label);
    if (!OPERATIONS.has(item.operation)) invalid(`${label}.operation must be add, modify, or remove`);
    const id = slug(item.id, `${label}.id`);
    if (ids.has(id)) invalid(`delta changes contains duplicate requirement id: ${id}`);
    ids.add(id);
    if (item.operation === 'remove') {
      if (Object.hasOwn(item, 'text')) invalid(`${label}.text must be absent for remove`);
      return { operation: item.operation, id };
    }
    return { operation: item.operation, id, text: nonemptyText(item.text, `${label}.text`) };
  });
  return {
    schemaVersion: 1,
    spec: path(value.spec, 'delta.spec'),
    baseSha256: digest(value.baseSha256, 'delta.baseSha256', { nullable: true }),
    changes: parsedChanges,
  };
}

export function parseSliceDocument(text) {
  if (typeof text !== 'string') invalid('slice descriptor must be JSON text');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`slice descriptor is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, 'ARTIFACT_FORMAT_INVALID', 'slice descriptor');
  assertExactKeys(value, SLICE_KEYS, 'ARTIFACT_FORMAT_INVALID', 'slice descriptor');
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) invalid('slice descriptor schemaVersion must be 1');
  const implementationFiles = uniquePaths(value.implementationFiles, 'slice.implementationFiles', { nonempty: true });
  const sliceTests = uniquePaths(value.sliceTests, 'slice.sliceTests', { nonempty: true });
  if (implementationFiles.some((item) => sliceTests.includes(item))) {
    invalid('slice.implementationFiles and slice.sliceTests must be disjoint');
  }
  return {
    schemaVersion: 1,
    id: slug(value.id, 'slice.id'),
    brief: path(value.brief, 'slice.brief'),
    context: path(value.context, 'slice.context'),
    checks: path(value.checks, 'slice.checks'),
    implementationFiles,
    sliceTests,
    protect: uniquePaths(value.protect, 'slice.protect'),
    interfaces: uniquePaths(value.interfaces, 'slice.interfaces', { nonempty: true }),
    dependsOn: uniqueSlugs(value.dependsOn, 'slice.dependsOn'),
    budget: parseBudget(value.budget, 'slice.budget', { nullable: true }),
    openDecisions: (() => {
      if (!Array.isArray(value.openDecisions)) invalid('slice.openDecisions must be an array');
      return value.openDecisions.map((item, index) => nonemptyText(item, `slice.openDecisions[${index}]`));
    })(),
    testReview: parseReview(value.testReview),
  };
}

function sectionBodies(text, heading) {
  const lines = text.split(/\n/u);
  const headings = [];
  let offset = 0;
  let fenced = false;
  for (const line of lines) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^\s*```/u.test(trimmed)) {
      fenced = !fenced;
    } else if (!fenced) {
      const match = /^## ([^#].*?)\s*$/u.exec(trimmed);
      if (match) headings.push({ heading: match[1], start: offset, end: offset + line.length + 1 });
    }
    offset += line.length + 1;
  }
  return headings
    .filter((item) => item.heading === heading)
    .map((item) => {
      const next = headings.find((candidate) => candidate.start >= item.end);
      return text.slice(item.end, next?.start ?? text.length);
    });
}

function parseSingleJsonBlock(body, label) {
  const blocks = [...body.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gu)];
  if (blocks.length !== 1) invalid(`${label} must contain exactly one JSON code block`);
  try {
    return JSON.parse(blocks[0][1]);
  } catch (error) {
    invalid(`${label} JSON block is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseApprovedBriefSections(text) {
  if (typeof text !== 'string') invalid('slice brief must be text');
  const reviewBodies = sectionBodies(text, 'Slice test review contract');
  const requirementsBodies = sectionBodies(text, 'Approved slice requirements');
  if (reviewBodies.length !== 1) invalid(reviewBodies.length === 0 ? 'slice brief is missing ## Slice test review contract' : 'slice brief must contain exactly one ## Slice test review contract section');
  if (requirementsBodies.length !== 1) invalid(requirementsBodies.length === 0 ? 'slice brief is missing ## Approved slice requirements' : 'slice brief must contain exactly one ## Approved slice requirements section');
  const testReview = parseReview(parseSingleJsonBlock(reviewBodies[0], 'slice test review contract'));
  const requirements = parseSingleJsonBlock(requirementsBodies[0], 'approved slice requirements');
  if (!Array.isArray(requirements)) invalid('approved slice requirements must be a JSON array');
  return { testReview, requirements };
}

function assertSubset(values, allowed, label) {
  const permitted = new Set(allowed);
  const invalidValues = values.filter((value) => !permitted.has(value));
  if (invalidValues.length > 0) invalid(`${label} contains undeclared values: ${invalidValues.join(', ')}`);
}

function mapSet(values) {
  return new Set(values);
}

function record(filePath, text) {
  const bytes = Buffer.byteLength(text);
  return { path: filePath, text, bytes, sha256: sha256(text) };
}

async function readBounded(projectRoot, projectPath, { allowMissing = false, label = projectPath } = {}) {
  const normalized = path(projectPath, label);
  assertArtifactPathAllowed(normalized, label);
  const resolved = await resolveProjectPath(projectRoot, normalized, { allowMissing });
  let info;
  try {
    info = await lstat(resolved.absolutePath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw tinyError('INVALID_FILE', `${label} must be a regular file: ${normalized}`);
  if (info.size > MAX_ARTIFACT_FILE_BYTES) {
    throw tinyError('ARTIFACT_READ_LIMIT', `${normalized} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte ordinary-file limit`, { path: normalized, bytes: info.size, limit: MAX_ARTIFACT_FILE_BYTES });
  }
  const handle = await open(resolved.absolutePath, 'r');
  const buffer = Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytesRead > MAX_ARTIFACT_FILE_BYTES) {
    throw tinyError('ARTIFACT_READ_LIMIT', `${normalized} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte ordinary-file limit`, { path: normalized, bytes: bytesRead, limit: MAX_ARTIFACT_FILE_BYTES });
  }
  const raw = buffer.subarray(0, bytesRead);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw tinyError('ARTIFACT_UTF8_BOM', `ordinary text input must not contain a UTF-8 BOM: ${normalized}`, { path: normalized });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw tinyError('ARTIFACT_UTF8_INVALID', `ordinary text input is not valid UTF-8: ${normalized}`, { path: normalized });
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_ARTIFACT_FILE_BYTES) {
    throw tinyError('ARTIFACT_READ_LIMIT', `${normalized} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte ordinary-file limit`, { path: normalized, bytes, limit: MAX_ARTIFACT_FILE_BYTES });
  }
  return record(normalized, text);
}

async function sourceExists(projectRoot, projectPath, label, { allowMissing = false } = {}) {
  const file = await readBounded(projectRoot, projectPath, { allowMissing, label });
  return file;
}

function addRead(files, file) {
  if (file && !files.has(file.path)) files.set(file.path, file);
}

function addSnapshot(snapshots, file) {
  if (file && !snapshots.has(file.path)) {
    snapshots.set(file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
}

function specRequirements(deltas) {
  const all = new Map();
  for (const { descriptor, value } of deltas) {
    for (const change of value.changes) {
      if (all.has(change.id)) invalid(`requirement id is repeated across deltas: ${change.id}`);
      all.set(change.id, {
        spec: value.spec,
        baseSha256: value.baseSha256,
        operation: change.operation,
        id: change.id,
        ...(change.operation === 'remove' ? {} : { text: change.text }),
        deltaPath: descriptor,
      });
    }
  }
  return all;
}

function requirementForBrief(requirement) {
  const { deltaPath, ...entry } = requirement;
  return entry;
}

function topologicalSlices(slices) {
  const byId = new Map(slices.map((item) => [item.value.id, item]));
  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  for (const { value } of slices) {
    for (const dependency of value.dependsOn) {
      if (!byId.has(dependency)) invalid(`slice ${value.id} depends on unknown slice: ${dependency}`);
      if (dependency === value.id) invalid(`slice ${value.id} cannot depend on itself`);
      indegree.set(value.id, indegree.get(value.id) + 1);
      dependents.get(dependency).push(value.id);
    }
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(byId.get(id));
    for (const dependent of dependents.get(id).sort()) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== slices.length) invalid('slice graph contains a dependency cycle');
  return order;
}

function pathCollision(left, right) {
  return left === right;
}

function sectionRequirementRecords(brief, expectedReview, requirements, requirementMap, label) {
  const issues = [];
  let parsed;
  try {
    parsed = parseApprovedBriefSections(brief.text);
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return { issues, parsed: null };
  }
  if (stableStringify(parsed.testReview) !== stableStringify(expectedReview)) {
    issues.push(`${label}: approved slice test review contract does not match slice descriptor`);
  }
  const expectedEntries = requirements.map(requirementForBrief);
  if (stableStringify(parsed.requirements) !== stableStringify(expectedEntries)) {
    issues.push(`${label}: approved slice requirements do not match referenced deltas`);
  }
  const seen = new Set();
  for (const entry of parsed.requirements) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    if (seen.has(entry.id)) issues.push(`${label}: approved slice requirements repeat ${entry.id}`);
    seen.add(entry.id);
    if (!requirementMap.has(entry.id)) issues.push(`${label}: approved slice requirement is not declared: ${entry.id}`);
  }
  return { issues, parsed };
}

function createPreparationIdentity(files, descriptorPaths, reviewContracts) {
  const descriptors = descriptorPaths.map((item) => files.get(item)).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
  const descriptorRefs = descriptors.map(({ path: itemPath, bytes, sha256: fileSha256 }) => ({ path: itemPath, bytes, sha256: fileSha256 }));
  const testReviewContractSha256 = digestJson(reviewContracts.map(({ sliceId, contract }) => ({ sliceId, contract })).sort((a, b) => a.sliceId.localeCompare(b.sliceId)));
  return {
    descriptorSetSha256: digestJson(descriptorRefs),
    descriptorFiles: descriptorRefs,
    testReviewContractSha256,
  };
}

function resolveSliceBudget(changeBudget, sliceBudget) {
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, sliceBudget[key] ?? changeBudget[key]]));
}

function makeReadinessIssue(code, message, details = undefined) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

/**
 * Validate a change descriptor and build a read-only registration plan.
 *
 * The result contains normalized descriptor values and bounded source records
 * so callers can export the same preparation identity without rereading large
 * untrusted inputs. No controller state is read or modified here.
 */
export async function validateChange(projectRootOrOptions, changePathArgument, optionsArgument = {}) {
  const options = typeof projectRootOrOptions === 'object' && projectRootOrOptions !== null
    ? projectRootOrOptions
    : { projectRoot: projectRootOrOptions, changePath: changePathArgument, ...optionsArgument };
  const root = await canonicalProjectRoot(options.projectRoot);
  const changePath = path(options.changePath, 'changePath');
  const changeFile = await readBounded(root, changePath, { label: 'change descriptor' });
  const change = parseChangeDocument(changeFile.text);
  const files = new Map();
  const sourceSnapshots = new Map();
  addRead(files, changeFile);
  const proposalFile = await readBounded(root, change.proposal, { label: 'change.proposal' });
  const designFile = await readBounded(root, change.design, { label: 'change.design' });
  addRead(files, proposalFile);
  addRead(files, designFile);
  const featureChecksFile = await readBounded(root, change.featureChecks, { label: 'change.featureChecks' });
  addRead(files, featureChecksFile);
  const featureChecks = parseChecksManifest(featureChecksFile.text);
  const featureCheckIds = featureChecks.checks.map((check) => check.id);

  if (change.specDeltas.length > MAX_CHANGE_DELTAS) invalid(`change references more than ${MAX_CHANGE_DELTAS} delta descriptors`);
  if (change.slices.length > MAX_CHANGE_SLICES) invalid(`change references more than ${MAX_CHANGE_SLICES} slice descriptors`);
  if (change.integration.length > MAX_INTEGRATION_ENTRIES) invalid(`change contains more than ${MAX_INTEGRATION_ENTRIES} integration obligations`);

  const featureTests = [];
  for (const testPath of change.featureTests) {
    const testFile = await sourceExists(root, testPath, `change.featureTests ${testPath}`);
    featureTests.push(testFile);
    addSnapshot(sourceSnapshots, testFile);
  }
  const featureTestPaths = change.featureTests;
  const featureTestCheckIds = new Set(featureTestPaths.flatMap((testPath) => featureChecks.checks.filter((check) => check.argv.includes(testPath)).map((check) => check.id)));
  const readinessIssues = [];
  for (const testPath of featureTestPaths) {
    if (!featureChecks.checks.some((check) => check.argv.includes(testPath))) {
      readinessIssues.push(makeReadinessIssue('FEATURE_TEST_NOT_CHECKED', `feature test is not a literal operand of a feature check: ${testPath}`));
    }
  }

  const deltas = [];
  for (const deltaPath of change.specDeltas) {
    const file = await readBounded(root, deltaPath, { label: `delta descriptor ${deltaPath}` });
    const value = parseDeltaDocument(file.text);
    addRead(files, file);
    const spec = await sourceExists(root, value.spec, `delta spec ${value.spec}`, { allowMissing: value.baseSha256 === null });
    if (value.baseSha256 === null) {
      if (spec) invalid(`new delta spec must not already exist: ${value.spec}`);
    } else {
      if (!spec) invalid(`delta base spec is missing: ${value.spec}`);
      if (spec.sha256 !== value.baseSha256) {
        throw tinyError('SPEC_BASE_STALE', `delta base digest does not match ${value.spec}`, { path: value.spec, expected: value.baseSha256, actual: spec.sha256 });
      }
      addSnapshot(sourceSnapshots, spec);
    }
    deltas.push({ descriptor: deltaPath, file, value, spec });
  }
  const requirementMap = specRequirements(deltas);

  const slices = [];
  const sliceIds = new Set();
  const reviewContracts = [];
  let criterionCount = 0;
  for (const slicePath of change.slices) {
    const descriptorFile = await readBounded(root, slicePath, { label: `slice descriptor ${slicePath}` });
    const value = parseSliceDocument(descriptorFile.text);
    if (sliceIds.has(value.id)) invalid(`slice id is repeated: ${value.id}`);
    sliceIds.add(value.id);
    addRead(files, descriptorFile);
    const brief = await readBounded(root, value.brief, { label: `slice ${value.id} brief` });
    const context = await readBounded(root, value.context, { label: `slice ${value.id} context` });
    const checks = await readBounded(root, value.checks, { label: `slice ${value.id} checks` });
    addRead(files, brief);
    addRead(files, context);
    addRead(files, checks);
    const parsedChecks = parseChecksManifest(checks.text);
    if (parsedChecks.checks.length !== 1) {
      invalid(`slice ${value.id} checks must declare exactly one check`);
    }
    const sliceCheck = parsedChecks.checks[0];
    for (const testPath of value.sliceTests) {
      if (!sliceCheck.argv.includes(testPath)) {
        readinessIssues.push(makeReadinessIssue('SLICE_TEST_NOT_CHECKED', `slice test is not a literal operand of slice ${value.id}'s check: ${testPath}`, { sliceId: value.id, path: testPath }));
      }
    }
    const contextManifest = parseContextManifest(context.text);
    for (const resource of contextManifest.resources) {
      assertArtifactPathAllowed(resource.path, `slice ${value.id} context resource`);
    }
    const compiled = await compileContext(root, { path: value.context, text: context.text, sha256: context.sha256 }, {
      readSource: async (resourcePath) => {
        const source = await readBounded(root, resourcePath, { label: `context resource ${resourcePath}` });
        addSnapshot(sourceSnapshots, source);
        return source.text;
      },
    });
    const metrics = contextSizeMetrics(compiled);
    const resolvedBudget = resolveSliceBudget(change.budget, value.budget);
    if (metrics.compiledContextBytes > resolvedBudget.maxCompiledContextBytes) {
      throw tinyError('CONTEXT_BUDGET_EXCEEDED', `slice ${value.id} compiled context exceeds its explicit context budget`, { sliceId: value.id, bytes: metrics.compiledContextBytes, limit: resolvedBudget.maxCompiledContextBytes });
    }
    if (metrics.compiledContextBytes > MAX_COMPILED_CONTEXT_BYTES) {
      throw tinyError('CONTEXT_BUDGET_EXCEEDED', `slice ${value.id} compiled context exceeds ${MAX_COMPILED_CONTEXT_BYTES} bytes`, { sliceId: value.id, bytes: metrics.compiledContextBytes, limit: MAX_COMPILED_CONTEXT_BYTES });
    }
    criterionCount += value.testReview.criteria.length;
    reviewContracts.push({ sliceId: value.id, contract: value.testReview });
    const requirements = [];
    const referencedRequirements = new Set(value.testReview.criteria.flatMap((criterion) => criterion.requirementIds));
    for (const requirementId of referencedRequirements) {
      const requirement = requirementMap.get(requirementId);
      if (!requirement) {
        readinessIssues.push(makeReadinessIssue('REQUIREMENT_NOT_FOUND', `slice ${value.id} references unknown requirement: ${requirementId}`, { sliceId: value.id, requirementId }));
      } else requirements.push(requirement);
    }
    for (const criterion of value.testReview.criteria) {
      assertSubset(criterion.interfaces, value.interfaces, `slice ${value.id} test review interfaces`);
      assertSubset(criterion.testPaths, value.sliceTests, `slice ${value.id} test review paths`);
    }
    const coveredTests = new Set(value.testReview.criteria.flatMap((criterion) => criterion.testPaths));
    for (const testPath of value.sliceTests) {
      if (!coveredTests.has(testPath)) readinessIssues.push(makeReadinessIssue('SLICE_TEST_NOT_REVIEWED', `slice test is not covered by a test-review criterion: ${testPath}`, { sliceId: value.id, path: testPath }));
    }
    const sectionCheck = sectionRequirementRecords(brief, value.testReview, requirements, requirementMap, `slice ${value.id} brief`);
    readinessIssues.push(...sectionCheck.issues.map((message) => makeReadinessIssue('APPROVED_BRIEF_MISMATCH', message, { sliceId: value.id })));
    const contextPaths = new Set(contextManifest.resources.map((resource) => resource.path));
    for (const interfacePath of value.interfaces) {
      const interfaceFile = await sourceExists(root, interfacePath, `slice ${value.id} interface ${interfacePath}`);
      addSnapshot(sourceSnapshots, interfaceFile);
      if (!contextPaths.has(interfacePath)) {
        readinessIssues.push(makeReadinessIssue('INTERFACE_NOT_CITED', `slice ${value.id} interface is not cited by an exact context excerpt: ${interfacePath}`, { sliceId: value.id, path: interfacePath }));
      }
    }
    slices.push({ descriptor: slicePath, descriptorFile, value, brief, context, checks, parsedChecks, contextManifest, compiled, metrics, resolvedBudget });
  }
  if (criterionCount > MAX_CRITERION_ENTRIES) invalid(`change contains more than ${MAX_CRITERION_ENTRIES} test-review criteria`);

  const slicesInOrder = topologicalSlices(slices);
  const sliceById = new Map(slices.map((item) => [item.value.id, item]));
  const preparationPaths = new Set([
    changePath,
    change.proposal,
    change.design,
    change.featureChecks,
    ...change.specDeltas,
    ...change.slices,
    ...change.featureTests,
    ...deltas.map((item) => item.value.spec),
    ...slices.flatMap((item) => [item.value.brief, item.value.context, item.value.checks, ...item.value.protect]),
  ]);
  for (const slice of slices) {
    const outputs = [...slice.value.implementationFiles, ...slice.value.sliceTests];
    const localProtect = [...new Set([...change.featureTests, ...slice.value.protect])];
    for (const output of outputs) {
      if (preparationPaths.has(output)) {
        throw tinyError('OUTPUT_PREPARATION_OVERLAP', `slice ${slice.value.id} expected output overlaps a preparation input: ${output}`, { sliceId: slice.value.id, path: output });
      }
      if (localProtect.includes(output)) {
        throw tinyError('OUTPUT_PROTECTED', `slice ${slice.value.id} expected output is protected: ${output}`, { sliceId: slice.value.id, path: output });
      }
      const existing = await sourceExists(root, output, `slice ${slice.value.id} expected output ${output}`, { allowMissing: true });
      if (existing) addSnapshot(sourceSnapshots, existing);
    }
    for (const protectedPath of localProtect) {
      const protectedFile = await sourceExists(root, protectedPath, `slice ${slice.value.id} protected path ${protectedPath}`);
      addSnapshot(sourceSnapshots, protectedFile);
    }
  }
  const expectedOwners = new Map();
  const ownershipWarnings = [];
  for (const slice of slices) {
    for (const output of [...slice.value.implementationFiles, ...slice.value.sliceTests]) {
      const owner = expectedOwners.get(output);
      if (owner && owner !== slice.value.id) {
        ownershipWarnings.push({ code: 'EXPECTED_OUTPUT_OWNERSHIP_OVERLAP', message: `expected output ${output} is listed by slices ${owner} and ${slice.value.id}`, details: { path: output, slices: [owner, slice.value.id] } });
      } else expectedOwners.set(output, slice.value.id);
    }
  }
  for (const slice of slices) {
    for (const other of slices) {
      if (other.value.id === slice.value.id) continue;
      for (const protectedPath of [...change.featureTests, ...other.value.protect]) {
        for (const output of [...slice.value.implementationFiles, ...slice.value.sliceTests]) {
          if (pathCollision(output, protectedPath)) {
            throw tinyError('OUTPUT_PROTECTED', `expected output ${output} overlaps slice ${other.value.id}'s protected path`, { path: output, sliceId: slice.value.id, protectedBy: other.value.id });
          }
        }
      }
    }
  }

  const integrationIds = new Set();
  const coveredFeatureTests = new Set();
  for (const integration of change.integration) {
    if (integrationIds.has(integration.id)) invalid(`integration id is repeated: ${integration.id}`);
    integrationIds.add(integration.id);
    assertSubset(integration.requirementIds, [...requirementMap.keys()], `integration ${integration.id} requirements`);
    assertSubset(integration.testPaths, change.featureTests, `integration ${integration.id} tests`);
    assertSubset(integration.checkIds, featureCheckIds, `integration ${integration.id} checks`);
    const referencedChecks = integration.checkIds.map((checkId) => featureChecks.checks.find((item) => item.id === checkId));
    for (const testPath of integration.testPaths) {
      if (!referencedChecks.some((check) => check.argv.includes(testPath))) {
        readinessIssues.push(makeReadinessIssue('INTEGRATION_TEST_NOT_CHECKED', `integration ${integration.id} test is not named by any referenced check: ${testPath}`));
      }
    }
    const wiring = sliceById.get(integration.wiringSlice);
    if (!wiring) invalid(`integration ${integration.id} names unknown wiring slice: ${integration.wiringSlice}`);
    const wiringInterfaces = new Set(wiring.value.interfaces);
    for (const entrypoint of integration.entrypoints) {
      const entrypointFile = await sourceExists(root, entrypoint, `integration ${integration.id} entrypoint ${entrypoint}`);
      addSnapshot(sourceSnapshots, entrypointFile);
      if (!wiringInterfaces.has(entrypoint)) {
        readinessIssues.push(makeReadinessIssue('ENTRYPOINT_NOT_CITED', `integration ${integration.id} entrypoint is not cited by wiring slice ${integration.wiringSlice}: ${entrypoint}`));
      }
    }
    integration.testPaths.forEach((item) => coveredFeatureTests.add(item));
  }
  for (const testPath of change.featureTests) {
    if (!coveredFeatureTests.has(testPath)) readinessIssues.push(makeReadinessIssue('FEATURE_TEST_NOT_COVERED', `feature test is not covered by an integration obligation: ${testPath}`));
  }

  const descriptorPaths = [changePath, change.proposal, change.design, change.featureChecks, ...change.specDeltas, ...change.slices];
  const preparationIdentity = createPreparationIdentity(files, descriptorPaths, reviewContracts);
  const registrationPlan = slicesInOrder.map((slice) => {
    const allow = [...new Set([...slice.value.implementationFiles, ...slice.value.sliceTests])].sort();
    const protect = [...new Set([...change.featureTests, ...slice.value.protect])].sort();
    const taskPath = (suffix) => '.tinysdd/tasks/' + slice.value.id + suffix;
    return {
      id: slice.value.id,
      feature: change.id,
      brief: taskPath('.md'),
      context: taskPath('.context.json'),
      checks: taskPath('.checks.json'),
      allow,
      protect,
      dependsOn: [...slice.value.dependsOn].sort(),
    };
  });
  const warnings = [...ownershipWarnings];
  for (const slice of slices) {
    if (slice.value.implementationFiles.length > slice.resolvedBudget.maxImplementationFiles) warnings.push({ code: 'IMPLEMENTATION_SIZING_EXCEEDED', message: `slice ${slice.value.id} expects ${slice.value.implementationFiles.length} implementation files, above advisory budget ${slice.resolvedBudget.maxImplementationFiles}`, details: { sliceId: slice.value.id, count: slice.value.implementationFiles.length, limit: slice.resolvedBudget.maxImplementationFiles } });
    if (slice.value.sliceTests.length > slice.resolvedBudget.maxSliceTestFiles) warnings.push({ code: 'SLICE_TEST_SIZING_EXCEEDED', message: `slice ${slice.value.id} expects ${slice.value.sliceTests.length} slice-test files, above advisory budget ${slice.resolvedBudget.maxSliceTestFiles}`, details: { sliceId: slice.value.id, count: slice.value.sliceTests.length, limit: slice.resolvedBudget.maxSliceTestFiles } });
  }
  if (readinessIssues.some((issue) => issue.code === 'FEATURE_TEST_NOT_CHECKED')) {
    // These are preparation integrity errors, rather than optional review prose.
    notReady('one or more declared tests are not named by the required check argv', { issues: readinessIssues });
  }
  const result = {
    schemaVersion: 1,
    projectRoot: root,
    changePath,
    change,
    deltas,
    slices,
    slicesInOrder,
    featureChecks: { ...featureChecksFile, parsed: featureChecks },
    featureTestCheckIds: [...featureTestCheckIds].sort(),
    preparationPaths: [...preparationPaths].sort(),
    preparationIdentity,
    registrationPlan,
    plan: registrationPlan,
    runtimeScope: { ...RUNTIME_SCOPE },
    resolvedBudgets: Object.fromEntries(slices.map((slice) => [slice.value.id, { ...slice.resolvedBudget }])),
    metrics: {
      deltaCount: deltas.length,
      sliceCount: slices.length,
      integrationCount: change.integration.length,
      criterionCount,
      implementationFileCounts: Object.fromEntries(slices.map((slice) => [slice.value.id, slice.value.implementationFiles.length])),
      sliceTestFileCounts: Object.fromEntries(slices.map((slice) => [slice.value.id, slice.value.sliceTests.length])),
      context: Object.fromEntries(slices.map((slice) => [slice.value.id, slice.metrics])),
    },
    warnings,
    readiness: { ready: readinessIssues.length === 0, issues: readinessIssues },
    files,
    sourceSnapshots: [...sourceSnapshots.values()].sort((left, right) => left.path.localeCompare(right.path)),
    requirementMap,
  };
  if (options.requireReady || options.ready) {
    if (!result.readiness.ready) notReady(`change ${change.id} is not export-ready`, { issues: result.readiness.issues });
    if (slices.some((slice) => slice.value.openDecisions.length > 0)) notReady(`change ${change.id} has open slice decisions`);
  }
  return result;
}

export async function buildRegistrationPlan(projectRootOrOptions, changePathArgument, optionsArgument = {}) {
  const result = await validateChange(projectRootOrOptions, changePathArgument, optionsArgument);
  return {
    schemaVersion: 1,
    changeId: result.change.id,
    plan: result.registrationPlan,
    registrationPlan: result.registrationPlan,
    warnings: result.warnings,
    metrics: result.metrics,
    preparationIdentity: result.preparationIdentity,
    runtimeScope: { ...result.runtimeScope },
    readiness: result.readiness,
  };
}

export const validateArtifactChange = validateChange;
export const loadChange = validateChange;
export const parseChange = parseChangeDocument;
export const parseDelta = parseDeltaDocument;
export const parseSlice = parseSliceDocument;
export { readBounded, path as normalizeArtifactPath, requirementForBrief };
