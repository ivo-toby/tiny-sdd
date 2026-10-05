import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { compileContext, parseContextManifest } from './context-compiler.mjs';
import { resolveTaskPacket } from './controller.mjs';
import {
  assertNoSymlinkPath,
  canonicalProjectRoot,
  digestJson,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import {
  MAX_ARTIFACT_FILE_BYTES,
  MAX_RETAINED_OUTPUT_BYTES,
  RUNTIME_SCOPE,
  assertArtifactPathAllowed,
  validateChange,
} from './change-format.mjs';

export const SLICE_BUNDLE_SCHEMA_VERSION = 1;

function invalid(message, details) {
  throw tinyError('SLICE_BUNDLE_INVALID', message, details);
}

function outputError(message, details) {
  throw tinyError('BUNDLE_OUTPUT_COLLISION', message, details);
}

function record(path, bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  return { path, bytes: content.byteLength, sha256: sha256(content), content };
}

function assertUtf8Text(content, projectPath, label) {
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    throw tinyError('ARTIFACT_UTF8_BOM', `${label} must not contain a UTF-8 BOM: ${projectPath}`, { path: projectPath });
  }
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw tinyError('ARTIFACT_UTF8_INVALID', `${label} is not valid UTF-8: ${projectPath}`, { path: projectPath });
  }
}

async function readBoundedBytes(projectRoot, projectPath, { allowMissing = false, label = projectPath, text = false } = {}) {
  assertArtifactPathAllowed(projectPath, label);
  const artifactPrefixes = ['.tinysdd/tasks/', '.tinysdd/runs/', '.tinysdd/reviews/'];
  const tinysddArtifactPrefix = artifactPrefixes.find((prefix) => projectPath.startsWith(prefix));
  const resolved = await resolveProjectPath(projectRoot, projectPath, {
    allowMissing,
    ...(tinysddArtifactPrefix ? { tinysddArtifactPrefix } : {}),
  });
  let info;
  try {
    info = await lstat(resolved.absolutePath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw tinyError('INVALID_FILE', `${label} must be a regular file: ${projectPath}`);
  if (info.size > MAX_ARTIFACT_FILE_BYTES) {
    throw tinyError('ARTIFACT_READ_LIMIT', `${projectPath} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte ordinary-file limit`, { path: projectPath, bytes: info.size, limit: MAX_ARTIFACT_FILE_BYTES });
  }
  const handle = await open(resolved.absolutePath, 'r');
  const content = Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < content.length) {
      const read = await handle.read(content, bytesRead, content.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytesRead > MAX_ARTIFACT_FILE_BYTES) {
    throw tinyError('ARTIFACT_READ_LIMIT', `${projectPath} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte ordinary-file limit`, { path: projectPath, bytes: bytesRead, limit: MAX_ARTIFACT_FILE_BYTES });
  }
  const bounded = content.subarray(0, bytesRead);
  if (text) assertUtf8Text(bounded, projectPath, label);
  const result = record(projectPath, bounded);
  if (text) result.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bounded);
  return result;
}

function reserveRetainedBytes(budget, bytes, label) {
  if (budget.bytes + bytes > MAX_RETAINED_OUTPUT_BYTES) {
    throw tinyError('BUNDLE_SIZE_LIMIT', `retained bundle exceeds ${MAX_RETAINED_OUTPUT_BYTES} bytes while reading ${label}`, { bytes: budget.bytes + bytes, limit: MAX_RETAINED_OUTPUT_BYTES, path: label });
  }
  budget.bytes += bytes;
}

async function boundedSnapshot(projectRoot, paths, expectedOutputs, budget) {
  const expected = new Set(expectedOutputs);
  const result = [];
  const baselines = new Map();
  for (const projectPath of [...new Set(paths)]) {
    const observed = await readBoundedBytes(projectRoot, projectPath, { allowMissing: true, label: `checkout reference ${projectPath}` });
    if (!observed) {
      if (!expected.has(projectPath)) {
        throw tinyError('CHECKOUT_REFERENCE_MISSING', `protected or context source is missing: ${projectPath}`, { path: projectPath });
      }
      result.push({ path: projectPath, exists: false });
      continue;
    }
    result.push({ path: projectPath, exists: true, bytes: observed.bytes, sha256: observed.sha256 });
    if (expected.has(projectPath)) {
      reserveRetainedBytes(budget, observed.bytes, projectPath);
      baselines.set(projectPath, observed);
    }
  }
  return { snapshot: result, baselines };
}

function inside(root, target) {
  const escaped = relative(resolve(root), resolve(target));
  return escaped === '' || (escaped !== '..' && !escaped.startsWith(`..${'/'}`) && !isAbsolute(escaped));
}

async function assertNewOutputDirectory(projectRoot, outputDir) {
  if (typeof outputDir !== 'string' || outputDir.length === 0) invalid('output directory is required');
  const absolute = resolve(outputDir);
  if (inside(projectRoot, absolute)) {
    outputError('bundle output must be outside the source project', { outputDir: absolute });
  }
  await assertNoSymlinkPath(dirname(absolute), { allowMissing: true, requireDirectory: false });
  try {
    const info = await lstat(absolute);
    if (info) outputError(`bundle output already exists: ${absolute}`, { outputDir: absolute });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function addOutput(outputs, relativePath, content, budget, { reserved = false } = {}) {
  if (outputs.has(relativePath)) outputError(`bundle output path collides: ${relativePath}`, { path: relativePath });
  const value = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (!reserved) reserveRetainedBytes(budget, value.byteLength, relativePath);
  outputs.set(relativePath, value);
}

function replaceOutput(outputs, relativePath, content, budget) {
  const previous = outputs.get(relativePath);
  if (!previous) outputError(`bundle output path is missing: ${relativePath}`, { path: relativePath });
  const value = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  budget.bytes -= previous.byteLength;
  try {
    reserveRetainedBytes(budget, value.byteLength, relativePath);
  } catch (error) {
    budget.bytes += previous.byteLength;
    throw error;
  }
  outputs.set(relativePath, value);
}

function comparePacketShape(packet, plan) {
  const expected = {
    brief: plan.brief,
    context: plan.context,
    checks: plan.checks,
    allow: plan.allow,
    protect: plan.protect,
    dependsOn: plan.dependsOn,
  };
  const actual = {
    brief: packet.brief?.path,
    context: packet.context?.path,
    checks: packet.checks?.path,
    allow: packet.allowedPaths,
    protect: packet.protectedPaths ?? [],
    dependsOn: (packet.dependencies ?? []).map((dependency) => dependency.id),
  };
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw tinyError('TASK_DESCRIPTOR_MISMATCH', `registered task ${packet.taskId} does not match the format plan`, { expected, actual });
  }
}

function parseControllerState(file) {
  if (!file) return { schemaVersion: 1, tasks: {} };
  let state;
  try {
    state = JSON.parse(file.text);
  } catch (error) {
    throw tinyError('STATE_MALFORMED', `controller state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) {
    throw tinyError('STATE_MALFORMED', 'controller state has an invalid shape');
  }
  return state;
}

async function readBoundedControllerState(projectRoot) {
  const file = await readBoundedBytes(projectRoot, '.tinysdd/runs/controller.json', {
    allowMissing: true,
    label: 'controller state',
    text: true,
  });
  return parseControllerState(file);
}

function taskPath(task, field, taskId, { optional = false } = {}) {
  const value = task[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw tinyError('STATE_MALFORMED', `task ${taskId} has an invalid ${field} path`);
  }
  return value;
}

async function preflightRegisteredTask(projectRoot, task, tasks, seen = new Set()) {
  const taskId = task?.id;
  if (!task || typeof task !== 'object' || typeof taskId !== 'string') {
    throw tinyError('STATE_MALFORMED', 'registered task has an invalid shape');
  }
  if (seen.has(taskId)) throw tinyError('STATE_MALFORMED', `dependency cycle reaches ${taskId}`);
  const nextSeen = new Set(seen).add(taskId);
  const brief = taskPath(task, 'brief', taskId);
  const context = taskPath(task, 'context', taskId, { optional: true });
  const checks = taskPath(task, 'checks', taskId, { optional: true });
  await readBoundedBytes(projectRoot, brief, { allowMissing: true, label: 'registered task brief', text: true });
  const contextFile = context === undefined
    ? null
    : await readBoundedBytes(projectRoot, context, { allowMissing: true, label: 'registered task context', text: true });
  if (checks !== undefined) await readBoundedBytes(projectRoot, checks, { allowMissing: true, label: 'registered task checks', text: true });
  for (const field of ['allow', 'protect']) {
    if (task[field] !== undefined && !Array.isArray(task[field])) {
      throw tinyError('STATE_MALFORMED', `task ${taskId} has an invalid ${field} list`);
    }
    for (const path of task[field] ?? []) {
      if (typeof path !== 'string') throw tinyError('STATE_MALFORMED', `task ${taskId} has an invalid ${field} path`);
      await readBoundedBytes(projectRoot, path, { allowMissing: true, label: `registered task ${field} ${path}` });
    }
  }
  let manifest = null;
  if (contextFile) {
    try {
      manifest = parseContextManifest(contextFile.text);
    } catch {
      manifest = null;
    }
    for (const resource of manifest?.resources ?? []) {
      await readBoundedBytes(projectRoot, resource.path, { allowMissing: true, label: `registered context resource ${resource.path}` });
    }
  }
  if (task.applied !== undefined) {
    if (!task.applied || typeof task.applied.rootRunId !== 'string' || !Array.isArray(task.applied.files)) {
      throw tinyError('STATE_MALFORMED', `task ${taskId} has an invalid applied record`);
    }
    const pinned = new Set(task.applied.files.filter((file) => file?.status === 'written' && typeof file.path === 'string').map((file) => file.path));
    for (const resource of manifest?.resources ?? []) {
      if (!pinned.has(resource.path)) continue;
      const runPath = `.tinysdd/runs/${task.applied.rootRunId}/workspace-before/${resource.path}`;
      await readBoundedBytes(projectRoot, runPath, { allowMissing: true, label: `registered pinned context resource ${resource.path}` });
    }
  }
  if (task.review?.evidence !== undefined) {
    const evidence = taskPath(task.review, 'evidence', `${taskId} review`);
    await readBoundedBytes(projectRoot, evidence, { allowMissing: true, label: 'registered review evidence', text: true });
  }
  if (!Array.isArray(task.dependsOn)) throw tinyError('STATE_MALFORMED', `task ${taskId} has an invalid dependency list`);
  for (const dependency of task.dependsOn) {
    if (typeof dependency !== 'string' || !Object.hasOwn(tasks, dependency)) {
      throw tinyError('STATE_MALFORMED', `missing dependency task: ${dependency}`);
    }
    await preflightRegisteredTask(projectRoot, tasks[dependency], tasks, nextSeen);
  }
}

const SHARED_READINESS_CODES = new Set([
  'FEATURE_TEST_NOT_CHECKED',
  'FEATURE_TEST_NOT_COVERED',
  'INTEGRATION_TEST_NOT_CHECKED',
  'ENTRYPOINT_NOT_CITED',
]);

function assertSelectedSliceReady(result, slice) {
  const issues = result.readiness.issues.filter((issue) => SHARED_READINESS_CODES.has(issue.code) || issue.details?.sliceId === slice.value.id);
  if (issues.length > 0) {
    throw tinyError('CHANGE_NOT_READY', `slice ${slice.value.id} is not export-ready`, { sliceId: slice.value.id, issues });
  }
  if (slice.value.openDecisions.length > 0) {
    throw tinyError('CHANGE_NOT_READY', `slice ${slice.value.id} has open decisions`, { sliceId: slice.value.id, openDecisions: [...slice.value.openDecisions] });
  }
}

function baselineRelative(projectPath) {
  return `baselines/${projectPath}`;
}

function preparationRelative(projectPath) {
  return `preparation/${projectPath}`;
}

function buildManifest({ change, slice, packet, plan, result, context, contextBinding, checkoutSnapshot, baselineRefs, retainedRefs, outputRefs }) {
  const briefRecord = record(packet.brief.path, packet.brief.text);
  const checksRecord = packet.checks ? record(packet.checks.path, packet.checks.text) : null;
  const identity = {
    schemaVersion: 1,
    changeId: change.id,
    sliceId: slice.value.id,
    descriptorSetSha256: result.preparationIdentity.descriptorSetSha256,
    testReviewContractSha256: result.preparationIdentity.testReviewContractSha256,
    currentApprovalDigest: packet.approval.approvalDigest,
    approvalDigest: packet.approval.approvalDigest,
    brief: { path: briefRecord.path, bytes: briefRecord.bytes, sha256: briefRecord.sha256 },
    context: context === null ? null : {
      path: packet.context.path,
      manifestSha256: packet.context.sha256,
      compiledSha256: context.sha256,
      compiledBytes: context.bytes,
      approvalContextDigest: packet.approval.contextDigest ?? null,
      approvalContextBinding: contextBinding,
      approvalComparison: contextBinding === 'legacy' ? 'approval.contextDigest=compiled.legacySha256' : contextBinding === 'current' ? 'approval.contextDigest=compiled.sha256' : 'none',
      legacySha256: context.legacySha256,
      sourceDigests: context.resources.map((resource) => ({ path: resource.path, sha256: resource.sourceSha256, bytes: resource.sourceBytes })),
    },
    checks: checksRecord ? { path: checksRecord.path, bytes: checksRecord.bytes, sha256: checksRecord.sha256 } : null,
  };
  return {
    schemaVersion: SLICE_BUNDLE_SCHEMA_VERSION,
    bundleType: 'tinysdd-slice',
    generatedBy: 'tiny-sdd',
    changeId: change.id,
    sliceId: slice.value.id,
    taskId: packet.taskId,
    runtimeScope: { ...RUNTIME_SCOPE },
    identity,
    descriptorSet: result.preparationIdentity,
    preparation: {
      brief: {
        path: packet.brief.path,
        testReviewContractSha256: result.preparationIdentity.testReviewContractSha256,
      },
      testReview: slice.value.testReview,
      resolvedBudget: { ...slice.resolvedBudget },
      advisoryCounts: {
        implementationFiles: slice.value.implementationFiles.length,
        sliceTests: slice.value.sliceTests.length,
      },
      expectedOutputs: {
        implementationFiles: [...slice.value.implementationFiles],
        sliceTests: [...slice.value.sliceTests],
      },
      featureTests: [...change.featureTests],
      integration: change.integration.filter((item) => item.wiringSlice === slice.value.id || item.testPaths.some((testPath) => change.featureTests.includes(testPath))),
      descriptors: result.preparationIdentity.descriptorFiles,
    },
    packet: {
      path: 'packet.json',
      sha256: sha256(jsonBytes(packet)),
      approval: { ...packet.approval },
      dependencies: packet.dependencies ?? [],
    },
    checkoutSnapshot,
    citedSourceSnapshots: result.sourceSnapshots,
    retainedBaselines: baselineRefs,
    retainedFiles: retainedRefs,
    files: outputRefs,
    identityDigest: digestJson(identity),
  };
}

/**
 * Export a validated, currently approved task packet and bounded preparation
 * bytes for a foreign harness. This function only reads the source checkout
 * and writes an exclusive new directory outside it; it never executes checks
 * or changes controller state.
 */
export async function exportSliceBundle(projectRootOrOptions, changePathArgument, sliceIdArgument, outputDirArgument, optionsArgument = {}) {
  const options = typeof projectRootOrOptions === 'object' && projectRootOrOptions !== null
    ? projectRootOrOptions
    : { projectRoot: projectRootOrOptions, changePath: changePathArgument, sliceId: sliceIdArgument, outputDir: outputDirArgument, ...optionsArgument };
  const root = await canonicalProjectRoot(options.projectRoot);
  const outputDir = await assertNewOutputDirectory(root, options.outputDir ?? options.out);
  const result = await validateChange({ projectRoot: root, changePath: options.changePath });
  const sliceId = options.sliceId ?? options.taskId;
  const slice = result.slices.find((item) => item.value.id === sliceId);
  if (!slice) throw tinyError('SLICE_NOT_FOUND', `unknown slice in change: ${sliceId}`);
  assertSelectedSliceReady(result, slice);
  const plan = result.registrationPlan.find((item) => item.id === slice.value.id);
  const state = await readBoundedControllerState(root);
  const registeredTask = Object.hasOwn(state.tasks, slice.value.id) ? state.tasks[slice.value.id] : undefined;
  if (!registeredTask) throw tinyError('TASK_NOT_FOUND', `unknown task: ${slice.value.id}`);
  if (registeredTask.feature !== result.change.id) {
    throw tinyError('TASK_FEATURE_MISMATCH', `task ${slice.value.id} is not registered in feature ${result.change.id}`);
  }
  await preflightRegisteredTask(root, registeredTask, state.tasks);
  const packet = await resolveTaskPacket(root, slice.value.id);
  comparePacketShape(packet, plan);
  if (packet.brief.text !== slice.brief.text) {
    throw tinyError('TASK_DESCRIPTOR_MISMATCH', `registered task ${slice.value.id} brief bytes differ from the validated slice brief`, { path: packet.brief.path });
  }
  if (packet.context.text !== slice.context.text) {
    throw tinyError('TASK_DESCRIPTOR_MISMATCH', `registered task ${slice.value.id} context bytes differ from the validated slice context`, { path: packet.context.path });
  }
  if (packet.checks.text !== slice.checks.text) {
    throw tinyError('TASK_DESCRIPTOR_MISMATCH', `registered task ${slice.value.id} checks bytes differ from the validated slice checks`, { path: packet.checks.path });
  }

  let compiled = null;
  let contextBinding = 'none';
  if (packet.context) {
    compiled = await compileContext(root, { path: packet.context.path, text: packet.context.text, sha256: packet.context.sha256 }, {
      readSource: async (sourcePath) => {
        const source = await readBoundedBytes(root, sourcePath, { allowMissing: false, label: `context resource ${sourcePath}` });
        if (source.content.length >= 3 && source.content[0] === 0xef && source.content[1] === 0xbb && source.content[2] === 0xbf) {
          throw tinyError('ARTIFACT_UTF8_BOM', `context source must not contain a UTF-8 BOM: ${sourcePath}`, { path: sourcePath });
        }
        try {
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.content);
        } catch {
          throw tinyError('ARTIFACT_UTF8_INVALID', `context source is not valid UTF-8: ${sourcePath}`, { path: sourcePath });
        }
      },
    });
    if (compiled.bytes > slice.resolvedBudget.maxCompiledContextBytes) {
      throw tinyError('CONTEXT_BUDGET_EXCEEDED', `registered task ${slice.value.id} compiled context exceeds its resolved budget`, {
        sliceId: slice.value.id,
        path: packet.context.path,
        bytes: compiled.bytes,
        limit: slice.resolvedBudget.maxCompiledContextBytes,
      });
    }
    if (packet.context.compiledSha256 !== compiled.sha256) {
      throw tinyError('STALE_CONTEXT', `task packet compiled context is not current: ${packet.context.path}`, { packet: packet.context.compiledSha256, current: compiled.sha256 });
    }
    if (packet.approval.contextDigest === compiled.sha256) contextBinding = 'current';
    else if (packet.approval.contextDigest === compiled.legacySha256) contextBinding = 'legacy';
    else throw tinyError('STALE_APPROVAL', `task approval context digest matches neither current nor legacy compiled context`, { approved: packet.approval.contextDigest, current: compiled.sha256, legacy: compiled.legacySha256 });
  } else if ((packet.approval.contextDigest ?? null) !== null) {
    throw tinyError('STALE_APPROVAL', 'task approval has a context digest but the packet has no context');
  }

  const outputPaths = [...plan.allow];
  const protectedPaths = [...plan.protect];
  const contextPaths = compiled?.resources.map((resource) => resource.path) ?? [];
  const references = [...new Set([...outputPaths, ...protectedPaths, ...contextPaths])];
  const retention = { bytes: 0 };
  const { snapshot: checkoutSnapshot, baselines } = await boundedSnapshot(root, references, outputPaths, retention);

  const outputs = new Map();
  addOutput(outputs, 'packet.json', jsonBytes(packet), retention);
  addOutput(outputs, 'brief.md', Buffer.from(packet.brief.text), retention);
  if (compiled) addOutput(outputs, 'compiled-context.md', Buffer.from(compiled.rendered), retention);
  addOutput(outputs, 'checks.json', Buffer.from(packet.checks.text), retention);
  const baselineRefs = [];
  for (const [projectPath, baseline] of baselines) {
    const bundlePath = baselineRelative(projectPath);
    addOutput(outputs, bundlePath, baseline.content, retention, { reserved: true });
    baselineRefs.push({ path: projectPath, bundlePath, bytes: baseline.bytes, sha256: baseline.sha256 });
  }
  baselineRefs.sort((a, b) => a.path.localeCompare(b.path));

  for (const descriptor of result.preparationIdentity.descriptorFiles) {
    const file = result.files.get(descriptor.path);
    if (!file) throw tinyError('PREPARATION_MISSING', `descriptor bytes were not retained: ${descriptor.path}`);
    const content = Buffer.from(file.text);
    if (content.byteLength !== descriptor.bytes || sha256(content) !== descriptor.sha256) {
      throw tinyError('PREPARATION_STALE', `descriptor bytes changed during export: ${descriptor.path}`, { path: descriptor.path, expected: descriptor.sha256, actual: sha256(content) });
    }
    addOutput(outputs, preparationRelative(file.path), content, retention);
  }

  const retainedRefs = [...outputs.entries()].map(([bundlePath, content]) => ({ path: bundlePath, bytes: content.byteLength, sha256: sha256(content) }));
  const manifestWithoutFiles = buildManifest({ change: result.change, slice, packet, plan, result, context: compiled, contextBinding, checkoutSnapshot, baselineRefs, retainedRefs, outputRefs: retainedRefs });
  const manifestBytes = jsonBytes(manifestWithoutFiles);
  addOutput(outputs, 'bundle.json', manifestBytes, retention);
  const outputRefs = [...outputs.entries()]
    .filter(([bundlePath]) => bundlePath !== 'bundle.json')
    .map(([bundlePath, content]) => ({ path: bundlePath, bytes: content.byteLength, sha256: sha256(content) }));
  const manifest = buildManifest({ change: result.change, slice, packet, plan, result, context: compiled, contextBinding, checkoutSnapshot, baselineRefs, retainedRefs: outputRefs, outputRefs });
  const finalManifestBytes = jsonBytes(manifest);
  replaceOutput(outputs, 'bundle.json', finalManifestBytes, retention);

  await assertNoSymlinkPath(dirname(outputDir), { allowMissing: true, requireDirectory: false });
  try {
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') outputError(`bundle output already exists: ${outputDir}`, { outputDir });
    throw error;
  }
  try {
    for (const [bundlePath, content] of outputs) {
      const target = resolve(outputDir, ...bundlePath.split('/'));
      const escaped = relative(outputDir, target);
      if (escaped === '..' || escaped.startsWith(`..${'/'}`) || isAbsolute(escaped)) outputError(`bundle output escapes its directory: ${bundlePath}`);
      await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    // The output directory is intentionally left for inspection if a write
    // fails. No source project files have been touched.
    throw error;
  }
  return {
    schemaVersion: SLICE_BUNDLE_SCHEMA_VERSION,
    outputDir,
    manifestPath: resolve(outputDir, 'bundle.json'),
    manifest,
    totalBytes: retention.bytes,
    files: [...outputs.keys()],
  };
}

export const exportSlice = exportSliceBundle;
export const createSliceBundle = exportSliceBundle;
export { boundedSnapshot };
