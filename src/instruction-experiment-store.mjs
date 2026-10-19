import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { assertNoSymlinkPath, digestJson, normalizeProjectRelative, publicError, sha256 } from './fs-utils.mjs';
import { parseChecksManifest } from './checks-manifest.mjs';
import { parseBenchmarkChallenge, parseBenchmarkSuite } from './benchmark-schema.mjs';
import { benchmarkFixtureDigest, inspectBenchmarkIdentity, runBenchmark } from './benchmark-runner.mjs';
import { inspectEffectiveModelSettings, assertEffectiveModelSettingsConfirmed } from './effective-model-settings.mjs';
import { readQualificationEvidence } from './qualification-reader.mjs';
import {
  analyzeInstructionObservations, instructionId, instructionInteger, instructionObject, instructionRef,
  instructionRuntimeIdentity, instructionSchedule, instructionString, invalidInstruction,
  reportInstructionPairs, summarizeInstructionCase, validateInstructionCriteria, validateInstructionPartitions,
} from './instruction-experiments.mjs';

const U = 'UNKNOWN';
const MAX_BYTES = 4 * 1024 * 1024;
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const same = (left, right) => digestJson(left) === digestJson(right);

function localPath(root, path) {
  return join(root, normalizeProjectRelative(path, 'instruction artifact', { tinysddArtifactPrefix: '.tinysdd/' }));
}

async function readResource(root, path, expected) {
  const target = localPath(root, path);
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false });
  const info = await lstat(target);
  if (!info.isFile() || info.size > MAX_BYTES) invalidInstruction('instruction resource must be a regular file no larger than 4 MiB');
  const bytes = await readFile(target);
  const hash = sha256(bytes);
  if (expected !== undefined && expected !== hash) invalidInstruction(`instruction resource digest changed: ${path}`);
  return { path, sha256: hash, text: bytes.toString('utf8') };
}

function sameResourceStat(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function verifyResource(root, path, expected) {
  const target = localPath(root, path);
  await assertNoSymlinkPath(target, { allowMissing: false, requireDirectory: false });
  const initial = await lstat(target, { bigint: true });
  if (!initial.isFile()) invalidInstruction('instruction resource must be a regular file');
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameResourceStat(initial, opened)) invalidInstruction(`instruction resource changed while verifying: ${path}`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0n;
    while (position < opened.size) {
      const remaining = opened.size - position;
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) invalidInstruction(`instruction resource changed while verifying: ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    if (position !== opened.size) invalidInstruction(`instruction resource changed while verifying: ${path}`);
    const current = await handle.stat({ bigint: true });
    const finalPath = await lstat(target, { bigint: true });
    if (!sameResourceStat(opened, current) || !sameResourceStat(current, finalPath)) {
      invalidInstruction(`instruction resource changed while verifying: ${path}`);
    }
    const sha256 = hash.digest('hex');
    if (expected !== undefined && expected !== sha256) invalidInstruction(`instruction resource digest changed: ${path}`);
    return { path, sha256 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readInstructionJson(projectRoot, path) {
  const resource = await readResource(projectRoot, path);
  return { value: JSON.parse(resource.text), ref: { path: resource.path, sha256: resource.sha256 } };
}

async function writeNew(root, path, value) {
  const target = localPath(root, path);
  await assertNoSymlinkPath(dirname(target), { allowMissing: true, requireDirectory: false });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(dirname(target), { allowMissing: false, requireDirectory: true });
  const bytes = jsonBytes(value);
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha256(bytes) };
}

async function suiteRoster(projectRoot, suitePath) {
  const resource = await readResource(projectRoot, suitePath);
  const suite = parseBenchmarkSuite(resource.text);
  const root = dirname(localPath(projectRoot, suitePath));
  const challenges = [];
  for (const ref of suite.challenges) {
    const item = await readResource(root, ref.path, ref.sha256);
    challenges.push(parseBenchmarkChallenge(item.text));
  }
  if (new Set(challenges.map(({ id }) => id)).size !== challenges.length) invalidInstruction('duplicate suite challenge');
  return { root, suite, challenges, ref: { path: suitePath, sha256: resource.sha256 } };
}

function validatePreparation(value, label = 'preparation') {
  if (value === U) return U;
  instructionObject(value, ['model', 'usage', 'evidence'], label);
  instructionString(value.model, `${label}.model`);
  if (value.usage !== U) {
    instructionObject(value.usage, ['inputTokens', 'outputTokens', 'reasoningTokens', 'elapsedMs'], `${label}.usage`);
    for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens', 'elapsedMs']) {
      if (value.usage[field] !== U) instructionInteger(value.usage[field], `${label}.usage.${field}`);
    }
  }
  if (value.evidence !== U) instructionRef(value.evidence, `${label}.evidence`);
  return structuredClone(value);
}

async function publicArtifact(root, invocationRoot, ref, kind) {
  if (!ref || ref === U) return null;
  const resource = await readResource(invocationRoot, ref.path, ref.sha256);
  return { kind, source: { path: relative(root, localPath(invocationRoot, ref.path)), sha256: resource.sha256 }, text: resource.text };
}

export async function analyzeInstructionEvidence({ projectRoot, request, output }) {
  instructionObject(request, ['suite', 'results', 'partitions', 'proposals', 'preparation', 'exposureAttestation'], 'analysis request');
  instructionString(request.exposureAttestation, 'exposureAttestation');
  const roster = await suiteRoster(projectRoot, request.suite);
  const partitions = validateInstructionPartitions(request.partitions, roster.challenges.map(({ id }) => id));
  if (!Array.isArray(request.results) || request.results.length === 0 || !Array.isArray(request.proposals)) invalidInstruction('analysis requires results and proposals arrays');
  const observations = [];
  for (const resultPath of request.results) {
    const evidence = await readQualificationEvidence({ projectRoot, results: [resultPath], suitePath: request.suite });
    const invocationRoot = dirname(localPath(projectRoot, evidence.invocations[0].path));
    for (const entry of evidence.observations) {
      if (partitions.find(({ challengeId }) => challengeId === entry.caseResult.challenge.id)?.partition !== 'discovery') continue;
      const result = entry.caseResult;
      const publicArtifacts = [];
      for (const kind of ['prompt', 'patch']) {
        const expectedPath = `cases/${result.attemptId}/${kind === 'prompt' ? 'worker-prompt.txt' : 'patch.diff'}`;
        if (result.artifacts[kind] && result.artifacts[kind] !== U && result.artifacts[kind].path !== expectedPath) invalidInstruction('public artifact is outside the benchmark runner allowlist');
        const artifact = await publicArtifact(projectRoot, invocationRoot, result.artifacts[kind], kind);
        if (artifact) publicArtifacts.push(artifact);
      }
      for (const [index, check] of result.verifier.visible.entries()) {
        if (check.output.ref === U || check.output.sha256 === U) continue;
        if (check.output.ref !== `cases/${result.attemptId}/verifier-output-visible-${index}.txt`) invalidInstruction('visible output is outside the benchmark runner allowlist');
        const artifact = await publicArtifact(projectRoot, invocationRoot, { path: check.output.ref, sha256: check.output.sha256 }, 'visible-verifier-output');
        if (artifact) publicArtifacts.push(artifact);
      }
      observations.push({ ...entry, publicArtifacts });
    }
  }
  const report = {
    ...analyzeInstructionObservations({ observations, partitions, proposals: request.proposals, preparation: validatePreparation(request.preparation) }),
    suite: roster.ref, exposureAttestation: request.exposureAttestation,
  };
  const ref = await writeNew(projectRoot, output, report);
  return { analysis: report, ref };
}

async function validateIntegrationChecks(value, roster) {
  const mapping = value ?? {};
  instructionObject(mapping, roster.challenges.map(({ id }) => id), 'integrationChecks');
  for (const [id, checks] of Object.entries(mapping)) {
    if (!Array.isArray(checks) || checks.length === 0) invalidInstruction('integrationChecks entries must be nonempty arrays');
    const challenge = roster.challenges.find((entry) => entry.id === id);
    const seen = new Set();
    for (const check of checks) {
      instructionObject(check, ['visibility', 'checkId'], 'integration check');
      if (!['visible', 'heldOut'].includes(check.visibility)) invalidInstruction('integration check visibility must be visible or heldOut');
      const key = `${check.visibility}/${check.checkId}`;
      if (seen.has(key)) invalidInstruction('duplicate integration check');
      seen.add(key);
      const ref = challenge.verifier[check.visibility];
      const manifest = parseChecksManifest((await readResource(roster.root, ref.path, ref.sha256)).text);
      if (!manifest.checks.some(({ id: checkId }) => checkId === check.checkId)) invalidInstruction('integration check is not in the frozen verifier roster');
    }
  }
  return mapping;
}

async function freezeSuite(sourceRoot, destination) {
  const tree = await benchmarkFixtureDigest(sourceRoot);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of tree.entries) {
    const target = localPath(destination, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(localPath(sourceRoot, entry.path), target);
  }
  const copied = await benchmarkFixtureDigest(destination);
  if (tree.sha256 !== copied.sha256) invalidInstruction('suite changed while freezing experiment');
  return tree;
}

export async function planInstructionExperiment({ projectRoot, request, output, worker, profile, runtime, verifier, checkRunnerOptions, entryKind }) {
  instructionObject(request, ['id', 'analysis', 'proposalId', 'repetitions', 'criteria', 'confounds', 'preparation', 'exposureAttestation', 'integrationChecks'], 'experiment request');
  instructionId(request.id, 'experiment id');
  instructionRef(request.analysis, 'analysis');
  instructionString(request.exposureAttestation, 'exposureAttestation');
  const analysisResource = await readResource(projectRoot, request.analysis.path, request.analysis.sha256);
  const analysis = JSON.parse(analysisResource.text);
  if (analysis.schemaVersion !== 1 || analysis.kind !== 'instruction-analysis') invalidInstruction('expected a retained instruction analysis');
  const proposal = analysis.proposals.find(({ id }) => id === request.proposalId);
  if (!proposal || proposal.status !== 'proposed') invalidInstruction('experiment requires a supported proposed hypothesis');
  const group = analysis.groups.find(({ configDigest, role }) => configDigest === proposal.configDigest && role === proposal.role);
  if (!group) invalidInstruction('proposal configuration is missing');
  const criteria = validateInstructionCriteria(request.criteria);
  const schedule = instructionSchedule(request.repetitions);
  if (!Array.isArray(request.confounds)) invalidInstruction('confounds must be an explicit array');
  request.confounds.forEach((entry) => instructionString(entry, 'confound'));
  const roster = await suiteRoster(projectRoot, analysis.suite.path);
  if (roster.ref.sha256 !== analysis.suite.sha256) invalidInstruction('analysis suite changed');
  const partitions = validateInstructionPartitions(analysis.partitions, roster.challenges.map(({ id }) => id));
  if (roster.challenges.some(({ role }) => role !== proposal.role)) invalidInstruction('one instruction experiment must use one benchmark role');
  const integrationChecks = await validateIntegrationChecks(request.integrationChecks, roster);
  const options = { worker, profile, runtime, checkRunnerOptions, verifierMode: verifier ? 'test-injection' : 'runCheck' };
  const baseline = await inspectBenchmarkIdentity({ ...options, projectRoot, suiteRoot: roster.root, suitePath: relative(roster.root, localPath(projectRoot, analysis.suite.path)) });
  if (baseline.configDigest !== proposal.configDigest) invalidInstruction('current baseline configuration differs from the proposal evidence');
  if (!baseline.profile || (baseline.profile.instructions ?? '') !== proposal.before) invalidInstruction('proposal.before must exactly match the current profile instructions; select an explicit baseline profile');
  const profiles = { A: baseline.profile, B: { ...baseline.profile, instructions: proposal.after } };
  const effectiveModelSettings = {};
  if (runtime?.test !== true || entryKind !== undefined) {
    for (const arm of ['A', 'B']) {
      effectiveModelSettings[arm] = await inspectEffectiveModelSettings({ worker, profile: profiles[arm],
        sourceAgentDir: runtime?.sourceAgentDir, sourceEnv: runtime?.sourceEnv, entryKind });
    }
  }
  const root = localPath(projectRoot, output);
  await assertNoSymlinkPath(root, { allowMissing: true, requireDirectory: false });
  const sourceRelative = relative(roster.root, root);
  if (!sourceRelative.startsWith('../')) invalidInstruction('experiment output must be outside its source suite');
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const suiteTree = await freezeSuite(roster.root, join(root, 'suite'));
  const profileRefs = {};
  const configurations = {};
  for (const arm of ['A', 'B']) {
    profileRefs[arm] = await writeNew(root, `profiles/${arm}.json`, profiles[arm]);
    configurations[arm] = await inspectBenchmarkIdentity({ ...options, projectRoot: join(root, 'suite'), suiteRoot: join(root, 'suite'), suitePath: relative(roster.root, localPath(projectRoot, analysis.suite.path)), profile: profiles[arm] });
  }
  if (!same(instructionRuntimeIdentity(configurations.A.identity), instructionRuntimeIdentity(configurations.B.identity))) invalidInstruction('A/B differ outside profile instructions');
  if (!same(baseline.identity, configurations.A.identity)) invalidInstruction('freezing the suite changed the baseline configuration');
  const analysisRef = await writeNew(root, 'analysis.json', analysis);
  const plan = { schemaVersion: 1, kind: 'instruction-experiment-plan', id: request.id, analysis: analysisRef, proposalId: proposal.id,
    suitePath: `suite/${relative(roster.root, localPath(projectRoot, analysis.suite.path))}`, suiteTree, profiles: profileRefs,
    configurations: Object.fromEntries(['A', 'B'].map((arm) => [arm, { identity: configurations[arm].identity, configDigest: configurations[arm].configDigest }])),
    ...(Object.keys(effectiveModelSettings).length ? { effectiveModelSettings } : {}),
    partitions, integrationChecks, repetitions: request.repetitions, schedule, criteria, confounds: request.confounds,
    preparation: validatePreparation(request.preparation), exposureAttestation: request.exposureAttestation, synthetic: runtime?.test === true };
  const ref = await writeNew(root, 'plan.json', plan);
  return { directory: root, plan, ref: { path: `${output}/${ref.path}`, sha256: ref.sha256 } };
}

async function readPlan(projectRoot, path) {
  const resource = await readInstructionJson(projectRoot, path);
  const plan = resource.value;
  instructionObject(plan, ['schemaVersion', 'kind', 'id', 'analysis', 'proposalId', 'suitePath', 'suiteTree', 'profiles', 'configurations', 'partitions', 'repetitions', 'schedule', 'criteria', 'confounds', 'preparation', 'exposureAttestation', 'synthetic', 'integrationChecks', 'effectiveModelSettings'], 'plan');
  if (plan.schemaVersion !== 1 || plan.kind !== 'instruction-experiment-plan' || typeof plan.synthetic !== 'boolean') invalidInstruction('invalid experiment plan');
  instructionId(plan.id, 'plan.id');
  if (!same(instructionSchedule(plan.repetitions), plan.schedule)) invalidInstruction('experiment order changed');
  validateInstructionCriteria(plan.criteria);
  const root = dirname(localPath(projectRoot, path));
  const roster = await suiteRoster(root, plan.suitePath);
  validateInstructionPartitions(plan.partitions, roster.challenges.map(({ id }) => id));
  await validateIntegrationChecks(plan.integrationChecks, roster);
  const tree = await benchmarkFixtureDigest(roster.root);
  if (!same(tree, plan.suiteTree)) invalidInstruction('frozen suite bytes changed');
  const analysisResource = await readResource(root, plan.analysis.path, plan.analysis.sha256);
  const analysis = JSON.parse(analysisResource.text);
  const proposal = analysis.proposals.find(({ id }) => id === plan.proposalId);
  if (!proposal || proposal.status !== 'proposed' || !same(analysis.partitions, plan.partitions)) invalidInstruction('plan no longer matches discovery analysis');
  const profiles = {};
  for (const arm of ['A', 'B']) {
    const ref = instructionRef(plan.profiles[arm], `profiles.${arm}`);
    profiles[arm] = JSON.parse((await readResource(root, ref.path, ref.sha256)).text);
    if (digestJson(profiles[arm]) !== plan.configurations[arm].identity.worker.profileDigest) invalidInstruction('profile does not match frozen identity');
  }
  if ((profiles.A.instructions ?? '') !== proposal.before || profiles.B.instructions !== proposal.after
    || !same({ ...profiles.A, instructions: null }, { ...profiles.B, instructions: null })) invalidInstruction('variants must differ only in the declared instructions');
  if (!same(instructionRuntimeIdentity(plan.configurations.A.identity), instructionRuntimeIdentity(plan.configurations.B.identity))) invalidInstruction('frozen configurations differ outside profile');
  return { root, plan, profiles, roster, ref: resource.ref };
}

export async function runInstructionExperiment({ projectRoot, planPath, worker, runtime, verifier, checkRunnerOptions, confirmation }) {
  const loaded = await readPlan(projectRoot, planPath);
  const { root, plan, profiles, roster } = loaded;
  if (plan.synthetic !== (runtime?.test === true)) invalidInstruction('synthetic and live experiment runtimes cannot be interchanged');
  const effectiveModelSettings = {};
  if (runtime?.test !== true || plan.effectiveModelSettings !== undefined || confirmation !== undefined) {
    if (!plan.effectiveModelSettings?.A || !plan.effectiveModelSettings?.B) invalidInstruction('plan lacks effective settings for both arms; create a new plan with an explicit entryKind');
    if (confirmation !== undefined) instructionObject(confirmation, ['A', 'B'], 'confirmation');
    for (const arm of ['A', 'B']) {
      const frozen = plan.effectiveModelSettings[arm];
      assertEffectiveModelSettingsConfirmed(frozen, confirmation?.[arm]);
      const current = await inspectEffectiveModelSettings({ worker, profile: profiles[arm],
        sourceAgentDir: runtime?.sourceAgentDir, sourceEnv: runtime?.sourceEnv,
        entryKind: confirmation[arm].entryKind ?? frozen.settings.entryKind });
      assertEffectiveModelSettingsConfirmed(current, confirmation[arm]);
      effectiveModelSettings[arm] = current;
    }
  }
  await mkdir(join(root, 'run'), { mode: 0o700 });
  await writeNew(root, 'run/start.json', { plan: { path: 'plan.json', sha256: loaded.ref.sha256 }, startedAt: new Date().toISOString(),
    ...(Object.keys(effectiveModelSettings).length ? { effectiveModelSettings, confirmation } : {}) });
  const slots = [];
  let stopped = false;
  for (const [index, slot] of plan.schedule.entries()) {
    const name = `${slot.repetition}-${slot.arm}`;
    if (stopped) {
      slots.push(await writeNew(root, `run/${name}.json`, { ...slot, status: 'not_run', reason: 'frozen input or runtime drift stopped execution' }));
      continue;
    }
    try {
      const refreshed = await readPlan(projectRoot, planPath);
      if (refreshed.ref.sha256 !== loaded.ref.sha256) invalidInstruction('plan changed during execution');
      const config = await inspectBenchmarkIdentity({ projectRoot: roster.root, suiteRoot: roster.root, suitePath: relative(roster.root, localPath(root, plan.suitePath)), worker, profile: profiles[slot.arm], runtime, checkRunnerOptions, verifierMode: verifier ? 'test-injection' : 'runCheck' });
      if (!same(config.identity, plan.configurations[slot.arm].identity)) invalidInstruction('runtime configuration changed since planning');
      const result = await runBenchmark({ projectRoot, registerEvidence: false, suiteRoot: roster.root, suitePath: relative(roster.root, localPath(root, plan.suitePath)), repeat: 1, worker, profile: profiles[slot.arm], runtime, verifier, checkRunnerOptions,
        settingsConfirmation: effectiveModelSettings[slot.arm] ? { ...confirmation[slot.arm], entryKind: effectiveModelSettings[slot.arm].settings.entryKind } : undefined,
        outputRoot: join(root, 'run', name), invocationId: `${plan.id}-${name.toLowerCase()}` });
      if (!same(result.config.identity, config.identity)) invalidInstruction('runtime changed while starting invocation');
      slots.push(await writeNew(root, `run/${name}.json`, { ...slot, index, status: 'recorded', invocation: { path: `run/${name}/invocation.json`, sha256: result.invocationRef.sha256 } }));
    } catch (error) {
      slots.push(await writeNew(root, `run/${name}.json`, { ...slot, index, status: 'failed', error: publicError(error) }));
      stopped = true;
    }
  }
  const complete = await writeNew(root, 'run/complete.json', { planSha256: loaded.ref.sha256, slots, completedAt: new Date().toISOString() });
  return { directory: root, complete, stopped };
}

export async function readInstructionReport({ projectRoot, planPath, output, review = U }) {
  const { root, plan, ref } = await readPlan(projectRoot, planPath);
  const start = await readInstructionJson(root, 'run/start.json');
  if (start.value.plan.sha256 !== ref.sha256) invalidInstruction('run belongs to different plan bytes');
  let complete;
  try { complete = (await readInstructionJson(root, 'run/complete.json')).value; }
  catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'PATH_NOT_FOUND') throw error; }
  if (complete) {
    if (complete.planSha256 !== ref.sha256 || !Array.isArray(complete.slots) || complete.slots.length !== plan.schedule.length) invalidInstruction('completion manifest does not match the plan');
    for (const slotRef of complete.slots) await readResource(root, slotRef.path, slotRef.sha256);
    const paths = complete.slots.map(({ path }) => path);
    if (new Set(paths).size !== paths.length || plan.schedule.some((slot) => !paths.includes(`run/${slot.repetition}-${slot.arm}.json`))) invalidInstruction('completion manifest slot roster changed');
  }
  const outcomes = [];
  const slots = [];
  const usedInvocations = new Set();
  for (const [index, slot] of plan.schedule.entries()) {
    let record;
    try { record = await readInstructionJson(root, `run/${slot.repetition}-${slot.arm}.json`); }
    catch (error) { if (error?.code === 'ENOENT' || error?.code === 'PATH_NOT_FOUND') { slots.push({ ...slot, status: 'not_run' }); continue; } throw error; }
    const entry = record.value;
    if (entry.arm !== slot.arm || entry.repetition !== slot.repetition || (entry.index !== undefined && entry.index !== index)) invalidInstruction('retained slot does not match counterbalanced order');
    slots.push({ ...entry, source: record.ref });
    if (entry.status !== 'recorded') continue;
    await readResource(root, entry.invocation.path, entry.invocation.sha256);
    const evidence = await readQualificationEvidence({ projectRoot: root, suitePath: plan.suitePath, results: [entry.invocation.path] });
    if (usedInvocations.has(evidence.invocations[0].invocationId)) invalidInstruction('invocation reused in multiple experiment slots');
    usedInvocations.add(evidence.invocations[0].invocationId);
    if (evidence.roster.invocations[0].repeat !== 1 || !same(evidence.configIdentity, plan.configurations[slot.arm].identity)) invalidInstruction('retained invocation does not match planned arm');
    const invocationRoot = dirname(localPath(root, entry.invocation.path));
    for (const observation of evidence.observations) {
      for (const artifact of Object.values(observation.caseResult.artifacts)) {
        if (artifact !== U) await verifyResource(invocationRoot, artifact.path, artifact.sha256);
      }
      for (const check of [...observation.caseResult.verifier.visible, ...observation.caseResult.verifier.heldOut]) {
        if (check.output.ref !== U && check.output.sha256 !== U) await verifyResource(invocationRoot, check.output.ref, check.output.sha256);
      }
      outcomes.push({ ...summarizeInstructionCase(observation.caseResult, plan.integrationChecks[observation.caseResult.challenge.id]), ...slot, source: observation.source });
    }
  }
  const report = { ...reportInstructionPairs({ plan, outcomes, preparation: plan.preparation, review: validatePreparation(review, 'review') }), plan: { path: planPath, sha256: ref.sha256 }, slots,
    missingConfiguration: plan.configurations.A.identity.missing };
  if (output) return { report, ref: await writeNew(projectRoot, output, report) };
  return { report };
}

export async function createInstructionProfile({ projectRoot, request, output }) {
  instructionObject(request, ['id', 'version', 'plan', 'arm', 'review', 'previous'], 'profile request');
  instructionId(request.id, 'profile id');
  instructionInteger(request.version, 'profile version', 1);
  instructionRef(request.plan, 'profile plan');
  if (!['A', 'B'].includes(request.arm)) invalidInstruction('select profile arm A or B explicitly');
  instructionObject(request.review, ['by', 'reason', 'evidence'], 'profile review');
  instructionString(request.review.by, 'review.by');
  instructionString(request.review.reason, 'review.reason');
  instructionRef(request.review.evidence, 'review.evidence');
  await readResource(projectRoot, request.review.evidence.path, request.review.evidence.sha256);
  await readResource(projectRoot, request.plan.path, request.plan.sha256);
  const { root, plan, profiles } = await readPlan(projectRoot, request.plan.path);
  let report = U;
  let started = false;
  try { await readResource(root, 'run/start.json'); started = true; }
  catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'PATH_NOT_FOUND') throw error; }
  if (started) report = (await readInstructionReport({ projectRoot, planPath: request.plan.path })).report;
  if (request.previous !== null) {
    instructionRef(request.previous, 'previous profile');
    const previous = JSON.parse((await readResource(projectRoot, request.previous.path, request.previous.sha256)).text);
    if (previous.kind !== 'preparation-instruction-profile' || previous.id !== request.id || previous.version + 1 !== request.version) invalidInstruction('previous profile must be the preceding version of this id');
  } else if (request.version !== 1) invalidInstruction('profile versions after 1 require a previous profile');
  const profile = { schemaVersion: 1, kind: 'preparation-instruction-profile', id: request.id, version: request.version,
    state: report === U ? 'proposed' : report.state, synthetic: plan.synthetic, selectedArm: request.arm, instructions: profiles[request.arm].instructions ?? '',
    targetConfigDigest: plan.configurations.A.configDigest, targetConfigIdentity: plan.configurations.A.identity,
    runtimeProfile: profiles[request.arm], provenance: { plan: request.plan, analysis: { path: relative(projectRoot, localPath(root, plan.analysis.path)), sha256: plan.analysis.sha256 }, report },
    review: request.review, previous: request.previous,
    selection: 'Explicit path and digest only; never automatically installed, selected, or promoted. Roll back by selecting previous or baseline A.' };
  return { profile, ref: await writeNew(projectRoot, output, profile) };
}
