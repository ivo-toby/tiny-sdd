import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { copyIntegrationTree } from './feature-integration.mjs';
import { lstat, open, opendir } from 'node:fs/promises';
import {
  assertInternalPath, canonicalProjectRoot, digestJson, ensureDirectory,
  normalizeProjectRelative, readProjectFile, resolveProjectPath, sha256,
  stableStringify, tinyError, withExclusiveLock,
} from './fs-utils.mjs';
import { resolveConfig } from './config.mjs';
import { validateTestReviewPolicy } from './phase-gates.mjs';
import { resolveTaskPacket } from './controller.mjs';
import {
  appendSliceTestReviewEvents, captureSliceTestReviewEnvelope,
  createSliceTestReviewEvent, readSliceTestReviewEvents,
  validateSliceTestReviewEnvelope, verifyRetainedSliceTestLineage, SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES,
} from './slice-test-review.mjs';
import {
  assessSliceTestWithJev, buildSliceTestJudgeRequest, validateJevDecisionProviderConfig,
} from './jev-decision-provider.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import { parseDecisionDataset } from './decision-dataset.mjs';
import { runCheck } from './check-runner.mjs';

export const SLICE_TEST_REVIEW_TEST_ENV = 'TINYSDD_SLICE_TEST_REVIEW_TEST';
const UNKNOWN = 'UNKNOWN';
const DIGEST = /^[a-f0-9]{64}$/u;
const DIRECTORY = ['.tinysdd', 'runs', 'slice-test-review'];

function fail(code, message) { throw tinyError(code, message); }

function actor(id, role) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(id)) fail('TEST_REVIEW_IDENTITY_REQUIRED', 'a bounded actor identity is required');
  return { id, role };
}

export function activeTestReviewPolicy(value) {
  let policy;
  try { policy = validateTestReviewPolicy(value); }
  catch { fail('TEST_REVIEW_POLICY_MISSING', 'configure explicit slice-test review thresholds, limit and routes'); }
  if (policy.negativeThreshold === undefined) fail('TEST_REVIEW_POLICY_MISSING', 'active slice-test review requires an explicit negativeThreshold');
  if (policy.uncertainRoute !== 'escalation') fail('TEST_REVIEW_POLICY_INVALID', 'uncertain slice-test assessments must route to the strong model');
  return policy;
}

export function classifySliceTestObservations(envelope, observations, policyValue) {
  const policy = activeTestReviewPolicy(policyValue);
  const criteria = envelope.criteria;
  if (!Array.isArray(observations) || observations.length !== criteria.length) fail('TEST_REVIEW_ASSESSMENT_INVALID', 'assessment must answer every approved criterion exactly once');
  const seen = new Set();
  const judgments = criteria.map((criterion) => {
    const matches = observations.filter((item) => item.criterionId === criterion.id);
    if (matches.length !== 1 || seen.has(criterion.id)) fail('TEST_REVIEW_ASSESSMENT_INVALID', 'assessment criterion identities are invalid');
    seen.add(criterion.id);
    const item = matches[0];
    const probability = item.probability;
    if (item.criterionType !== criterion.type || item.question !== envelope.questions[criterion.id].instruction
      || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      fail('TEST_REVIEW_ASSESSMENT_INVALID', 'assessment does not match the approved questions and probability contract');
    }
    const verdict = probability >= policy.positiveThreshold ? 'positive'
      : probability < policy.negativeThreshold ? 'negative' : 'uncertain';
    return { criterionId: criterion.id, probability, verdict };
  });
  return {
    verdict: judgments.every((item) => item.verdict === 'positive') ? 'positive'
      : judgments.some((item) => item.verdict === 'negative') ? 'negative' : 'uncertain',
    judgments,
  };
}

async function readBounded(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) fail('TEST_REVIEW_ARTIFACT_INVALID', 'review artifact must be a bounded, unaliased regular file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) fail('TEST_REVIEW_ARTIFACT_INVALID', 'review artifact changed while being opened');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail('TEST_REVIEW_ARTIFACT_INVALID', 'review artifact exceeds its byte limit');
    return bytes;
  } finally { await handle.close(); }
}

async function dependencyTreeDigest(directory) {
  const entries = [];
  let bytes = 0;
  async function visit(current, prefix = '') {
    for await (const entry of await opendir(current)) {
      if (entries.length >= 20_000) fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency tree exceeds its entry limit');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency tree contains a symlink');
      if (info.isDirectory()) {
        entries.push({ path, kind: 'directory', mode: (info.mode & 0o7777) | 0o700 | 0o0555 });
        await visit(absolute, path);
      } else if (info.isFile() && info.nlink === 1) {
        const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== info.ino || opened.dev !== info.dev) fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency file changed while opening');
          const hash = createHash('sha256');
          let length = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            length += chunk.length; bytes += chunk.length;
            if (bytes > 512 * 1024 * 1024) fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency tree exceeds its byte limit');
            hash.update(chunk);
          }
          const after = await handle.stat();
          if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency file changed during hashing');
          entries.push({ path, kind: 'file', mode: (opened.mode & 0o7777) | 0o400 | 0o0444, bytes: length, sha256: hash.digest('hex') });
        } finally { await handle.close(); }
      } else fail('TEST_REVIEW_ARTIFACT_INVALID', 'dependency input is not a regular file or directory');
    }
  }
  await visit(directory);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return digestJson(entries);
}

async function assertDependencyFreshness(root, evidence) {
  for (const mount of evidence?.dependencies ?? []) {
    const source = (await resolveProjectPath(root, mount.source, { allowMissing: false })).absolutePath;
    const retained = await assertInternalPath(root, mount.retainedPath.split('/'), { allowMissing: false, requireDirectory: true });
    if (await dependencyTreeDigest(source) !== mount.sha256 || await dependencyTreeDigest(retained) !== mount.sha256) fail('TEST_REVIEW_INPUT_STALE', 'independently checked dependencies changed');
  }
}

async function inputPath(root, digest) {
  if (!DIGEST.test(digest)) fail('TEST_REVIEW_ARTIFACT_INVALID', 'review input digest is invalid');
  return assertInternalPath(root, [...DIRECTORY, 'inputs', `${digest}.json`], { allowMissing: true });
}

async function retainInput(root, envelope) {
  const value = validateSliceTestReviewEnvelope(envelope);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES) fail('TEST_REVIEW_ARTIFACT_INVALID', 'assessment input exceeds its byte limit');
  const directory = await assertInternalPath(root, [...DIRECTORY, 'inputs'], { allowMissing: true, requireDirectory: true });
  await ensureDirectory(directory);
  const path = await inputPath(root, value.envelopeDigest);
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (!(await readBounded(path, SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES)).equals(bytes)) fail('TEST_REVIEW_ARTIFACT_INVALID', 'retained input publication conflicts');
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function loadInput(root, event) {
  const bytes = await readBounded(await inputPath(root, event.envelopeDigest), SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES);
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { fail('TEST_REVIEW_ARTIFACT_INVALID', 'retained input is malformed'); }
  const envelope = validateSliceTestReviewEnvelope(parsed);
  if (envelope.envelopeDigest !== event.envelopeDigest || envelope.inputDigest !== event.inputDigest) fail('TEST_REVIEW_INPUT_MISMATCH', 'retained input differs from its event');
  return envelope;
}

async function locked(root, callback) {
  const path = await assertInternalPath(root, [...DIRECTORY, 'workflow.lock'], { allowMissing: true });
  return withExclusiveLock(path, callback);
}

function reviewUsage(value) {
  if (value === undefined || value === UNKNOWN) return UNKNOWN;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['inputTokens', 'outputTokens', 'totalTokens', 'latencyMs'].includes(key))) fail('TEST_REVIEW_USAGE_INVALID', 'review usage accepts measured tokens and latency only');
  const result = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'latencyMs']) {
    const number = value[key] ?? UNKNOWN;
    if (number !== UNKNOWN && (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || (key !== 'latencyMs' && !Number.isSafeInteger(number)))) fail('TEST_REVIEW_USAGE_INVALID', 'review measurements must be nonnegative finite observations');
    result[key] = number;
  }
  return result;
}

function budgetRoute(policy, revision) { return revision < policy.revisionLimit ? 'revision' : 'escalation'; }

function assessmentRoute(verdict, policy, revision) {
  if (verdict === 'positive') return 'independent-review';
  if (verdict === 'negative') return budgetRoute(policy, revision);
  if (verdict === 'uncertain') return 'escalation';
  return policy.unavailableRoute === 'revision' ? budgetRoute(policy, revision) : policy.unavailableRoute;
}

async function history(root, id) {
  const all = await readSliceTestReviewEvents(root);
  const events = all.filter((event) => event.workflow !== undefined && event.identity.taskId === id);
  let prior = null;
  for (const event of events) {
    const workflow = event.workflow;
    const eventPath = await assertInternalPath(root, [...DIRECTORY, 'records', `${event.eventId}.json`], { allowMissing: false });
    const retainedEvent = JSON.parse(await readBounded(eventPath, 256 * 1024));
    if (stableStringify(retainedEvent) !== stableStringify(event)) fail('TEST_REVIEW_HISTORY_INVALID', 'immutable event differs from its ledger observation');
    if (workflow.revision > workflow.policy.revisionLimit) fail('TEST_REVIEW_HISTORY_INVALID', 'retained revision exceeds its configured cap');
    if (workflow.previousEventId !== (prior?.eventId ?? null)) fail('TEST_REVIEW_HISTORY_INVALID', 'workflow predecessor chain is inconsistent');
    if (workflow.revision < (prior?.workflow.revision ?? 0) || workflow.revision > (prior?.workflow.revision ?? 0) + 1) fail('TEST_REVIEW_HISTORY_INVALID', 'workflow revision budget is inconsistent');
    const sameInput = prior?.inputDigest === event.inputDigest && prior?.envelopeDigest === event.envelopeDigest;
    const completion = ['initial-assessment', 'revision-assessment', 'provider-failure'].includes(event.eventType);
    if (!prior && (event.eventType !== 'assessment-started' || workflow.revision !== 0)) fail('TEST_REVIEW_HISTORY_INVALID', 'workflow must start with an initial assessment');
    if (prior) {
      const expectedRevision = prior.workflow.revision + (event.eventType === 'revision-dispatched' || (event.eventType === 'assessment-started' && prior.route === 'revision') ? 1 : 0);
      if (workflow.revision !== expectedRevision) fail('TEST_REVIEW_HISTORY_INVALID', 'workflow revision increment is invalid');
      if (event.eventType === 'assessment-started' && !['revision', 'assessment-required'].includes(prior.route)) fail('TEST_REVIEW_HISTORY_INVALID', 'assessment started from an invalid route');
      if (completion && (prior.eventType !== 'assessment-started' || workflow.assessmentEventId !== prior.eventId || !sameInput)) fail('TEST_REVIEW_HISTORY_INVALID', 'assessment completion does not bind its invocation');
      if (event.eventType === 'operator-revision' && (prior.eventType !== 'strong-review' || prior.route !== 'operator-acceptance' || event.route !== budgetRoute(workflow.policy, workflow.revision) || workflow.revisionBase !== 'applied-project' || !sameInput)) fail('TEST_REVIEW_HISTORY_INVALID', 'operator revision lacks an accepted applied candidate');
      if (event.eventType === 'revision-dispatched' && prior.route !== 'revision') fail('TEST_REVIEW_HISTORY_INVALID', 'revision dispatch did not follow a revision request');
      if (event.eventType === 'revision-candidate' && (prior.eventType !== 'revision-dispatched' || !sameInput)) fail('TEST_REVIEW_HISTORY_INVALID', 'revision completion does not bind its dispatch');
      if (['independent-checks', 'strong-review', 'revision-dispatched'].includes(event.eventType) && !sameInput) fail('TEST_REVIEW_HISTORY_INVALID', 'review transition changed candidate bytes');
      if (['independent-checks', 'strong-review'].includes(event.eventType) && !['independent-review', 'escalation'].includes(prior.route)) fail('TEST_REVIEW_HISTORY_INVALID', 'review followed an invalid route');
      if (event.eventType !== 'assessment-started' && (workflow.policyDigest !== prior.workflow.policyDigest || stableStringify(workflow.implementer) !== stableStringify(prior.workflow.implementer) || stableStringify(workflow.producer) !== stableStringify(prior.workflow.producer))) fail('TEST_REVIEW_HISTORY_INVALID', 'attempt attribution changed during a transition');
    }
    const envelope = await loadInput(root, event);
    if (event.eventType === 'initial-assessment' || event.eventType === 'revision-assessment') {
      const classified = classifySliceTestObservations(envelope, event.assessment.observations, workflow.policy);
      if (classified.verdict !== event.assessment.verdict || stableStringify(classified.judgments) !== stableStringify(workflow.criterionVerdicts)
        || event.route !== assessmentRoute(classified.verdict, workflow.policy, workflow.revision)) fail('TEST_REVIEW_HISTORY_INVALID', 'retained assessment policy interpretation is inconsistent');
    }
    if (['independent-checks', 'strong-review'].includes(event.eventType)) {
      const parent = events.filter((candidate) => candidate.sequence < event.sequence && ['initial-assessment', 'revision-assessment', 'provider-failure'].includes(candidate.eventType)).at(-1);
      if (!parent || parent.eventId !== workflow.assessmentEventId || parent.inputDigest !== event.inputDigest || parent.envelopeDigest !== event.envelopeDigest) fail('TEST_REVIEW_HISTORY_INVALID', 'review does not identify its exact completed assessment');
    }
    if (event.eventType === 'independent-checks') {
      const evidence = workflow.checkEvidence;
      const manifestArtifact = envelope.artifacts.find((item) => item.path === evidence?.manifestPath && item.sha256 === envelope.approval.checksDigest);
      const checks = manifestArtifact ? parseChecksManifest(Buffer.from(manifestArtifact.contentBase64, 'base64').toString('utf8')).checks : [];
      if (!evidence || evidence.inputDigest !== event.inputDigest || !['invoked', 'synthetic'].includes(evidence.source) || !Array.isArray(evidence.results)) fail('TEST_REVIEW_HISTORY_INVALID', 'independent check identity is invalid');
      const passed = evidence.results.length === checks.length && checks.length > 0 && evidence.results.every((item, index) => item.id === checks[index].id && stableStringify(item.argv) === stableStringify(checks[index].argv) && item.exitCode === 0 && item.signal === null && item.timedOut === false && item.passed === true);
      if (evidence.passed && !passed) fail('TEST_REVIEW_HISTORY_INVALID', 'passing checks do not match the declared commands');
    }
    if (event.eventType === 'strong-review') {
      reviewUsage(workflow.reviewUsage);
      if (event.review?.verdict === 'accepted' && (prior?.eventType !== 'independent-checks' || prior.workflow.checkEvidence?.passed !== true || stableStringify(prior.workflow.checkEvidence) !== stableStringify(workflow.checkEvidence))) fail('TEST_REVIEW_HISTORY_INVALID', 'accepting strong review lacks passing independent checks');
      if (event.review === UNKNOWN || !['accepted', 'rejected'].includes(event.review.verdict) || event.review.inputDigest !== event.inputDigest
        || event.review.strength !== 'strong' || !event.review.attested
        || [workflow.implementer.id, workflow.producer.id].includes(event.review.reviewer.id)
        || !['caller-declared', 'synthetic'].includes(workflow.reviewProvenance)) fail('TEST_REVIEW_HISTORY_INVALID', 'retained review attribution is invalid');
      const expectedRoute = event.review.verdict === 'accepted' ? 'operator-acceptance' : budgetRoute(workflow.policy, workflow.revision);
      if (event.route !== expectedRoute) fail('TEST_REVIEW_HISTORY_INVALID', 'retained strong-review route is inconsistent');
    }
    prior = event;
  }
  return { all, events, last: prior };
}

async function append(root, state, envelope, value) {
  const event = createSliceTestReviewEvent({
    sequence: state.all.length + 1,
    identity: envelope.identity, inputDigest: envelope.inputDigest, envelopeDigest: envelope.envelopeDigest,
    assessment: { status: 'missing', verdict: UNKNOWN, observations: [] },
    provenance: envelope.provenance,
    ...value,
    workflow: { ...value.workflow, previousEventId: state.last?.eventId ?? null },
  });
  await retainInput(root, envelope);
  const directory = await assertInternalPath(root, [...DIRECTORY, 'records'], { allowMissing: true, requireDirectory: true });
  await ensureDirectory(directory);
  const path = await assertInternalPath(root, [...DIRECTORY, 'records', `${event.eventId}.json`], { allowMissing: true });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
  await appendSliceTestReviewEvents(root, [event]);
  state.all.push(event); state.events.push(event); state.last = event;
  return event;
}

async function currentPolicy(root) {
  return activeTestReviewPolicy((await resolveConfig(root)).config.testReview);
}

async function capture(root, { id, run, change, revision, capturedAt, applied = false }) {
  const packet = await resolveTaskPacket(root, id, { reviewRunId: applied ? run : undefined });
  const descriptorPath = (await resolveProjectPath(root, change, { allowMissing: false })).absolutePath;
  const descriptor = JSON.parse(await readBounded(descriptorPath, 512 * 1024));
  return captureSliceTestReviewEnvelope({ projectRoot: root, packet, runId: run, changePath: change,
    featureId: descriptor.id, sliceId: id, revision, capturedAt, reviewRunId: applied ? run : undefined });
}

async function freshInput(root, event, { applied = false } = {}) {
  const envelope = await loadInput(root, event);
  const fresh = await capture(root, { id: event.identity.taskId, run: event.identity.runId,
    change: event.workflow.changePath, revision: envelope.identity.revision, capturedAt: envelope.capturedAt, applied });
  if (fresh.inputDigest !== envelope.inputDigest || fresh.envelopeDigest !== envelope.envelopeDigest) fail('TEST_REVIEW_INPUT_STALE', 'assessment inputs have changed');
  if (digestJson(await currentPolicy(root)) !== event.workflow.policyDigest) fail('TEST_REVIEW_POLICY_STALE', 'test-review policy changed after assessment');
  return envelope;
}

function activeWorkflow(envelope, policy, implementer, producer, revision) {
  return { schemaVersion: 1, policy, policyDigest: digestJson(policy), implementer, producer, revision };
}

async function checkParent(root, run, expected) {
  const path = await assertInternalPath(root, ['.tinysdd', 'runs', run, 'result.json'], { allowMissing: false });
  const result = JSON.parse(await readBounded(path, SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES));
  if (result.baseRun?.id !== expected) fail('TEST_REVIEW_REVISION_LINEAGE', 'a test revision must build on the last assessed candidate');
}

export async function assessSliceTests(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const policy = await currentPolicy(root);
  const implementer = actor(options.implementer, 'implementation-model');
  const producer = actor(options.producer, 'test-assessor');
  if (producer.id === implementer.id) fail('TEST_REVIEW_NOT_INDEPENDENT', 'assessment producer must differ from the implementer');
  const config = validateJevDecisionProviderConfig(options.providerConfig);
  if (config.fetch !== undefined && process.env[SLICE_TEST_REVIEW_TEST_ENV] !== '1') fail('TEST_REVIEW_TEST_RUNTIME', 'injected transports are restricted to explicit offline tests');
  const change = normalizeProjectRelative(options.change, 'change descriptor');
  return locked(root, async () => {
    const state = await history(root, options.id);
    let revision = 0;
    if (state.last) {
      if (!['revision', 'assessment-required'].includes(state.last.route)) fail('TEST_REVIEW_ROUTE_BLOCKED', 'complete the outstanding strong review or inspect the retained failure before another assessment');
      revision = state.last.workflow.revision + (state.last.route === 'revision' ? 1 : 0);
      if (revision > policy.revisionLimit) fail('TEST_REVIEW_BUDGET_EXHAUSTED', 'the configured test-revision limit is exhausted');
      const expected = state.last.workflow.candidateRunId;
      if (expected !== undefined && options.run !== expected) fail('TEST_REVIEW_REVISION_LINEAGE', 'assessment must use the retained revision candidate');
      if (state.last.workflow.revisionBase === 'applied-project') {
        const previous = await loadInput(root, state.last);
        for (const artifact of previous.artifacts) {
          const path = await assertInternalPath(root, ['.tinysdd', 'runs', options.run, 'workspace-before', ...artifact.path.split('/')], { allowMissing: false });
          if (sha256(await readBounded(path, SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES)) !== artifact.sha256) fail('TEST_REVIEW_REVISION_LINEAGE', 'project revision did not start from the assessed applied candidate');
        }
      } else await checkParent(root, options.run, state.last.identity.runId);
    }
    const envelope = await capture(root, { ...options, change, revision });
    const workflow = { ...activeWorkflow(envelope, policy, implementer, producer, revision), changePath: change };
    const assessment = { taskId: options.id, criteria: envelope.criteria, checks: [],
      requirements: envelope.requirements, interfaces: envelope.interfaces, integration: envelope.integration,
      artifacts: envelope.artifacts, inputSha256: envelope.inputDigest, lineage: envelope.identity };
    const request = buildSliceTestJudgeRequest(assessment);
    const requestBytes = JSON.stringify({ model: config.model, state: request.state, questions: request.questions });
    const provider = { id: config.id, configSha256: config.configSha256, model: { id: config.model, version: UNKNOWN }, availability: { status: 'unknown', available: UNKNOWN } };
    const requestIdentity = { sha256: sha256(requestBytes), bytes: Buffer.byteLength(requestBytes), questionSha256: digestJson(request.questions) };
    const source = config.fetch === undefined ? 'invoked' : 'synthetic';
    const started = await append(root, state, envelope, { eventType: 'assessment-started', route: 'assessment-pending',
      assessment: { status: 'missing', verdict: UNKNOWN, observations: [], provider, request: requestIdentity },
      workflow: { ...workflow, measurementSource: source } });
    let response;
    try {
      response = await assessSliceTestWithJev({ config, credential: options.credential, assessment });
      await freshInput(root, started);
    } catch (error) {
      const malformed = ['JEV_DECISION_BAD_RESPONSE', 'JEV_DECISION_REQUEST_TOO_LARGE'].includes(error?.code);
      const stale = typeof error?.code === 'string' && (error.code.startsWith('TEST_REVIEW_') || error.code.startsWith('SLICE_TEST_REVIEW_'));
      const route = stale ? 'escalation' : assessmentRoute('unavailable', policy, revision);
      return append(root, state, envelope, { eventType: 'provider-failure', route,
        assessment: { status: malformed ? 'malformed' : stale ? 'failed' : 'unavailable', verdict: UNKNOWN, observations: [], provider: { ...provider, availability: { status: 'unavailable', available: false } }, request: requestIdentity, reason: stale ? 'assessment input became stale' : 'provider could not produce a complete valid assessment' },
        reason: stale ? 'Retained candidate requires strong review or operator inspection.' : 'No valid assessment; no approval was granted.',
        workflow: { ...workflow, measurementSource: source, assessmentEventId: started.eventId } });
    }
    const classified = classifySliceTestObservations(envelope, response.observations, policy);
    const synthetic = config.fetch !== undefined;
    return append(root, state, envelope, {
      eventType: revision === 0 ? 'initial-assessment' : 'revision-assessment',
      route: assessmentRoute(classified.verdict, policy, revision),
      assessment: { status: 'observed', verdict: classified.verdict, observations: response.observations,
        provider: response.provider, request: { ...response.request, questionSha256: response.questionSha256 }, measurements: response.measurements },
      provenance: synthetic ? { source: 'synthetic', replayed: false, capture: 'injected-offline-provider' } : envelope.provenance,
      workflow: { ...workflow, assessmentEventId: started.eventId, criterionVerdicts: classified.judgments, measurementSource: synthetic ? 'synthetic' : 'invoked' },
    });
  });
}

export async function sliceTestReviewStatus(projectRoot, { id } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const state = await history(root, id);
  return { active: state.last !== null, taskId: id, lastEvent: state.last,
    route: state.last?.route ?? 'assessment-required', revision: state.last?.workflow.revision ?? 0,
    eventCount: state.events.length, approved: false };
}

export async function checkSliceTests(projectRoot, { id, eventId, runner = runCheck } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  if (runner !== runCheck && process.env[SLICE_TEST_REVIEW_TEST_ENV] !== '1') fail('TEST_REVIEW_TEST_RUNTIME', 'injected runners are restricted to explicit offline tests');
  return locked(root, async () => {
    const state = await history(root, id);
    const last = state.last;
    if (!last || last.eventId !== eventId || !['independent-review', 'escalation'].includes(last.route)) fail('TEST_REVIEW_ROUTE_BLOCKED', 'checks must bind the current assessment awaiting strong review');
    const envelope = await freshInput(root, last);
    const packet = await resolveTaskPacket(root, id);
    if (!packet.checks) fail('TEST_REVIEW_CHECKS_MISSING', 'independent slice checks must be declared');
    const manifest = parseChecksManifest(packet.checks.text);
    const candidateDir = await assertInternalPath(root, ['.tinysdd', 'runs', last.identity.runId, 'workspace-after'], { allowMissing: false, requireDirectory: true });
    const dependencyMounts = [];
    const dependencyEvidence = [];
    const checkRoot = await assertInternalPath(root, [...DIRECTORY, 'checks', randomUUID()], { allowMissing: true });
    await ensureDirectory(checkRoot);
    for (const [index, mount] of manifest.dependencyMounts.entries()) {
      const source = (await resolveProjectPath(root, mount, { allowMissing: false })).absolutePath;
      const retained = join(checkRoot, `mount-${index}`);
      const copied = await copyIntegrationTree(source, retained, { identityAlgorithm: 'sha256-dependency-tree-v1', mountReadable: true });
      dependencyEvidence.push({ source: mount, target: mount, retainedPath: retained.slice(root.length + 1), sha256: copied.identity.sha256 });
      dependencyMounts.push({ source: retained, target: mount });
    }
    const results = [];
    let failure = false;
    try {
      for (const check of manifest.checks) {
        const result = await runner({ candidateDir, check, dependencyMounts });
        const passed = result?.exitCode === 0 && result.signal === null && result.timedOut === false;
        const output = typeof result?.output?.text === 'string' ? result.output.text.slice(0, Math.floor(64 * 1024 / manifest.checks.length)) : '';
        results.push({ id: check.id, argv: check.argv, exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
          timedOut: result?.timedOut === true, signal: typeof result?.signal === 'string' ? result.signal : null,
          passed, output: output.length ? output : UNKNOWN, outputTruncated: result?.output?.truncated === true || output.length !== (result?.output?.text?.length ?? 0),
          durationMs: typeof result?.durationMs === 'number' && Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : UNKNOWN });
        if (!passed) failure = true;
      }
      await freshInput(root, last);
      for (const [index, mount] of manifest.dependencyMounts.entries()) {
        const source = (await resolveProjectPath(root, mount, { allowMissing: false })).absolutePath;
        const fresh = await copyIntegrationTree(source, join(checkRoot, `comparison-${index}`), { identityAlgorithm: 'sha256-dependency-tree-v1', mountReadable: true });
        if (fresh.identity.sha256 !== dependencyEvidence[index].sha256) failure = true;
      }
    } catch { failure = true; }
    const checkEvidence = { inputDigest: envelope.inputDigest, manifestPath: packet.checks.path, source: runner === runCheck ? 'invoked' : 'synthetic', results, dependencies: dependencyEvidence,
      passed: !failure && results.length === manifest.checks.length };
    return append(root, state, envelope, { eventType: 'independent-checks', assessment: last.assessment,
      route: checkEvidence.passed ? last.route : budgetRoute(last.workflow.policy, last.workflow.revision),
      workflow: { ...last.workflow, assessmentEventId: ['initial-assessment', 'revision-assessment', 'provider-failure'].includes(last.eventType) ? last.eventId : last.workflow.assessmentEventId, checkEvidence } });
  });
}

export async function reviewSliceTests(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const reviewer = actor(options.reviewer, 'strong-reviewer');
  if (!['accepted', 'rejected'].includes(options.verdict)) fail('TEST_REVIEW_INVALID', 'strong review verdict must be accepted or rejected');
  if (options.strength !== 'strong' || options.attested !== true) fail('TEST_REVIEW_IDENTITY_REQUIRED', 'strong review requires explicit strength and independence attestation');
  return locked(root, async () => {
    const state = await history(root, options.id);
    const last = state.last;
    if (!last || last.eventId !== options.eventId || !['independent-review', 'escalation'].includes(last.route)) fail('TEST_REVIEW_ROUTE_BLOCKED', 'strong review must bind the current assessment or check event');
    if ([last.workflow.implementer.id, last.workflow.producer.id].includes(reviewer.id)) fail('TEST_REVIEW_NOT_INDEPENDENT', 'strong reviewer must differ from both implementer and assessment producer');
    if (state.events.some((event) => event.eventType === 'strong-review' && event.inputDigest === last.inputDigest && event.envelopeDigest === last.envelopeDigest)) fail('TEST_REVIEW_ALREADY_REVIEWED', 'this assessment already has a retained strong review');
    const envelope = await freshInput(root, last);
    if (options.inputDigest !== envelope.inputDigest) fail('TEST_REVIEW_INPUT_MISMATCH', 'strong reviewer must explicitly identify the identical assessed bytes');
    if (options.verdict === 'accepted' && (last.eventType !== 'independent-checks' || last.workflow.checkEvidence?.passed !== true)) fail('TEST_REVIEW_CHECKS_REQUIRED', 'accepting strong review requires retained passing independent checks');
    const evidencePath = normalizeProjectRelative(options.evidence, 'strong-review evidence', { tinysddArtifactPrefix: '.tinysdd/reviews/' });
    const path = (await resolveProjectPath(root, evidencePath, { allowMissing: false, tinysddArtifactPrefix: '.tinysdd/reviews/' })).absolutePath;
    const bytes = await readBounded(path, 64 * 1024);
    if (bytes.toString('utf8').trim().length === 0) fail('TEST_REVIEW_INVALID', 'strong-review evidence must be nonempty');
    const reviewEvidence = { path: evidencePath, sha256: sha256(bytes), bytes: bytes.length, contentBase64: bytes.toString('base64') };
    await freshInput(root, last);
    return append(root, state, envelope, { eventType: 'strong-review', assessment: last.assessment,
      review: { reviewer, strength: 'strong', attested: true, verdict: options.verdict, inputDigest: envelope.inputDigest },
      route: options.verdict === 'accepted' ? 'operator-acceptance' : budgetRoute(last.workflow.policy, last.workflow.revision),
      workflow: { ...last.workflow, assessmentEventId: ['initial-assessment', 'revision-assessment', 'provider-failure'].includes(last.eventType) ? last.eventId : last.workflow.assessmentEventId, reviewEvidence, reviewProvenance: 'caller-declared', reviewUsage: reviewUsage(options.reviewUsage) } });
  });
}

async function assertAcceptable(root, { id, run, applied = false }) {
  const state = await history(root, id);
  const last = state.last;
  if (!last || last.eventType !== 'strong-review' || last.route !== 'operator-acceptance' || last.identity.runId !== run) fail('TEST_REVIEW_REQUIRED', 'this candidate requires independent strong slice-test review before application or acceptance');
  if (last.workflow.checkEvidence?.source === 'synthetic' && process.env[SLICE_TEST_REVIEW_TEST_ENV] !== '1') fail('TEST_REVIEW_SYNTHETIC', 'synthetic checks do not establish real candidate verification');
  const envelope = await freshInput(root, last, { applied });
  await assertDependencyFreshness(root, last.workflow.checkEvidence);
  const retained = last.workflow.reviewEvidence;
  if (!retained || sha256(Buffer.from(retained.contentBase64, 'base64')) !== retained.sha256) fail('TEST_REVIEW_INPUT_STALE', 'strong-review evidence is not retained');
  const evidence = await readProjectFile(root, retained.path, { tinysddArtifactPrefix: '.tinysdd/reviews/', encoding: null });
  if (sha256(evidence) !== retained.sha256) fail('TEST_REVIEW_INPUT_STALE', 'strong-review evidence changed');
  if (applied) {
    for (const artifact of envelope.artifacts) {
      const bytes = await readProjectFile(root, artifact.path, { encoding: null, tinysddArtifactPrefix: '.tinysdd/tasks/' });
      if (sha256(bytes) !== artifact.sha256) fail('TEST_REVIEW_INPUT_STALE', 'applied project differs from the exact strong-reviewed candidate');
    }
  }
  return { eventId: last.eventId, inputDigest: envelope.inputDigest, policyDigest: last.workflow.policyDigest };
}

export async function withSliceTestApplyGate(projectRoot, options, callback) {
  const root = await canonicalProjectRoot(projectRoot);
  if ((await resolveConfig(root)).config.testReview === undefined) return callback();
  return locked(root, async () => { await assertAcceptable(root, options); return callback(); });
}

export async function assertSliceTestAcceptance(projectRoot, options) {
  if ((await resolveConfig(projectRoot)).config.testReview === undefined) return null;
  return locked(projectRoot, () => assertAcceptable(projectRoot, { ...options, applied: true }));
}

export async function withSliceTestWorkerGate(projectRoot, options, callback) {
  const root = await canonicalProjectRoot(projectRoot);
  if ((await resolveConfig(root)).config.testReview === undefined || options.baselineRunId) return callback();
  const policy = await currentPolicy(root);
  return locked(root, async () => {
    const state = await history(root, options.taskId);
    const last = state.last;
    if (!last) return callback();
    if (last.route !== 'revision' || last.workflow.revision >= policy.revisionLimit) fail('TEST_REVIEW_ROUTE_BLOCKED', 'worker execution is blocked pending strong review or operator inspection');
    const fromProject = last.workflow.revisionBase === 'applied-project';
    if (fromProject ? options.baseRunId !== undefined : options.baseRunId !== last.identity.runId) fail('TEST_REVIEW_REVISION_LINEAGE', 'worker revision must use its retained candidate base');
    const envelope = fromProject ? await loadInput(root, last) : await freshInput(root, last);
    if (fromProject) {
      await verifyRetainedSliceTestLineage(root, envelope);
      if (digestJson(policy) !== last.workflow.policyDigest) fail('TEST_REVIEW_POLICY_STALE', 'revision policy changed');
      for (const artifact of envelope.artifacts) {
        if (sha256(await readProjectFile(root, artifact.path, { encoding: null, tinysddArtifactPrefix: '.tinysdd/tasks/' })) !== artifact.sha256) fail('TEST_REVIEW_INPUT_STALE', 'applied candidate changed before its requested revision');
      }
    }
    const revision = last.workflow.revision + 1;
    const text = JSON.stringify({ inputDigest: last.inputDigest, verdict: last.assessment.verdict, criteria: envelope.criteria, judgments: last.workflow.criterionVerdicts ?? [], requirements: envelope.requirements, strongReview: last.workflow.reviewEvidence ?? UNKNOWN });
    const feedback = { verdict: 'revision', by: last.workflow.producer.id, evidence: { text, sha256: sha256(text) } };
    const dispatched = await append(root, state, envelope, { eventType: 'revision-dispatched', route: 'dispatch-pending', assessment: last.assessment, workflow: { ...last.workflow, revision } });
    let result;
    try { result = await callback(feedback); }
    catch (error) {
      await append(root, state, envelope, { eventType: 'revision-candidate', route: 'escalation', assessment: last.assessment,
        reason: 'Revision did not return a complete candidate; the reserved revision remains spent.', workflow: dispatched.workflow });
      throw error;
    }
    const complete = result?.outcome === 'completed' && typeof result?.runId === 'string';
    await append(root, state, envelope, { eventType: 'revision-candidate', route: complete ? 'assessment-required' : 'escalation', assessment: last.assessment,
      reason: complete ? 'Revision candidate requires a fresh assessment.' : 'Incomplete revision requires strong escalation.',
      workflow: { ...dispatched.workflow, ...(complete ? { candidateRunId: result.runId } : {}) } });
    return result;
  });
}

export async function sliceTestAcceptanceFreshness(projectRoot, task) {
  const proof = task.review?.sliceTestReview;
  if (!proof) return true;
  const state = await history(projectRoot, task.id);
  const last = state.last;
  if (!last || last.eventType !== 'strong-review' || last.route !== 'operator-acceptance'
    || last.eventId !== proof.eventId || last.inputDigest !== proof.inputDigest
    || last.workflow.policyDigest !== proof.policyDigest || last.identity.runId !== task.applied?.runId
    || digestJson(await currentPolicy(projectRoot)) !== proof.policyDigest) return false;
  if (last.workflow.checkEvidence?.source === 'synthetic' && process.env[SLICE_TEST_REVIEW_TEST_ENV] !== '1') return false;
  const envelope = await loadInput(projectRoot, last);
  await assertDependencyFreshness(projectRoot, last.workflow.checkEvidence);
  await verifyRetainedSliceTestLineage(projectRoot, envelope);
  const evidence = last.workflow.reviewEvidence;
  if (!evidence || sha256(Buffer.from(evidence.contentBase64, 'base64')) !== evidence.sha256) return false;
  if (sha256(await readProjectFile(projectRoot, evidence.path, { encoding: null, tinysddArtifactPrefix: '.tinysdd/reviews/' })) !== evidence.sha256) return false;
  for (const artifact of envelope.artifacts) {
    if (sha256(await readProjectFile(projectRoot, artifact.path, { encoding: null, tinysddArtifactPrefix: '.tinysdd/tasks/' })) !== artifact.sha256) return false;
  }
  return true;
}

export async function exportSliceTestReviewDataset(projectRoot, { feature, partition } = {}) {
  if (!['train', 'validation', 'test'].includes(partition)) fail('TEST_REVIEW_PARTITION_REQUIRED', 'choose an explicit dataset partition for entire feature/lineage groups');
  const root = await canonicalProjectRoot(projectRoot);
  const all = await readSliceTestReviewEvents(root);
  const taskIds = [...new Set(all.filter((event) => event.workflow && (feature === undefined || event.identity.featureId === feature)).map((event) => event.identity.taskId))];
  const cases = [];
  for (const id of taskIds) {
    const state = await history(root, id);
    for (const review of state.events.filter((event) => event.eventType === 'strong-review')) {
      const assessment = state.events.find((event) => event.eventId === review.workflow.assessmentEventId);
      if (!assessment || !['initial-assessment', 'revision-assessment'].includes(assessment.eventType)) continue;
      const envelope = await loadInput(root, assessment);
      const refs = [];
      for (const event of [assessment, review]) {
        const path = `.tinysdd/runs/slice-test-review/records/${event.eventId}.json`;
        const bytes = await readBounded(await assertInternalPath(root, path.split('/'), { allowMissing: false }), 4 * 1024 * 1024);
        if (stableStringify(JSON.parse(bytes)) !== stableStringify(event)) fail('TEST_REVIEW_HISTORY_INVALID', 'dataset evidence differs from retained ledger');
        refs.push({ path, sha256: sha256(bytes) });
      }
      const envelopePath = `.tinysdd/runs/slice-test-review/inputs/${envelope.envelopeDigest}.json`;
      const envelopeBytes = await readBounded(await inputPath(root, envelope.envelopeDigest), SLICE_TEST_REVIEW_MAX_ENVELOPE_BYTES);
      refs.push({ path: envelopePath, sha256: sha256(envelopeBytes) });
      cases.push({ id: `review-${sha256(assessment.eventId).slice(0, 32)}`, decisionPoint: 'slice-test-review',
        synthetic: assessment.workflow.measurementSource !== 'invoked' || review.workflow.checkEvidence?.source !== 'invoked',
        source: { kind: 'slice-test-review', refs },
        observation: { identity: assessment.identity, inputDigest: assessment.inputDigest, criteria: envelope.criteria, questions: envelope.questions, requirements: envelope.requirements, interfaces: envelope.interfaces, integration: envelope.integration, artifacts: envelope.artifacts },
        expected: { label: review.review.verdict === 'accepted', reviewedBy: review.review.reviewer.id, reviewedAt: review.timestamp,
          evidence: [refs[1]], note: 'Whole-slice reference assessment; not individual criterion labels or infallible ground truth.' },
        split: { partition, sourceGroup: `source-${sha256(assessment.identity.featureId + ':' + assessment.identity.lineageId).slice(0, 32)}`,
          featureGroup: `feature-${sha256(assessment.identity.featureId).slice(0, 32)}`, runLineageGroup: `lineage-${sha256(assessment.identity.lineageId).slice(0, 32)}` } });
    }
  }
  if (!cases.length) fail('TEST_REVIEW_DATASET_EMPTY', 'no independently reviewed assessments are available');
  return parseDecisionDataset(JSON.stringify({ schemaVersion: 1, id: 'slice-test-review', version: '1', cases }));
}

export async function recordSliceTestOperatorRevision(projectRoot, { id, run } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  if ((await resolveConfig(root)).config.testReview === undefined || !run) return;
  return locked(root, async () => {
    const state = await history(root, id);
    if (!state.last || state.last.route !== 'operator-acceptance') return;
    await assertAcceptable(root, { id, run, applied: true });
    const envelope = await loadInput(root, state.last);
    return append(root, state, envelope, { eventType: 'operator-revision', assessment: state.last.assessment,
      route: budgetRoute(state.last.workflow.policy, state.last.workflow.revision),
      reason: 'Operator requested revision of the applied project; retained budget remains in force.',
      workflow: { ...state.last.workflow, revisionBase: 'applied-project' } });
  });
}
