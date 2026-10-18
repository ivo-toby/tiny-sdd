#!/usr/bin/env node
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { analyzeInstructionEvidence, createInstructionProfile, planInstructionExperiment, readInstructionReport, runInstructionExperiment } from '../src/instruction-experiment-store.mjs';
import { analysisRequest, criteria, discoveryRun, instructionFixture, jsonFile } from '../tests/helpers/instruction-experiment-fixture.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--out') {
  process.stderr.write('Usage: node scripts/run-instruction-example.mjs --out NEW_DIRECTORY\n');
  process.exitCode = 1;
} else {
  const requested = resolve(process.argv[3]);
  const parent = await realpath(dirname(requested));
  const root = join(parent, requested.slice(dirname(requested).length + 1));
  await mkdir(root, { mode: 0o700 });
  process.env.TINYSDD_WORKER_TEST = '1';
  const fixture = await instructionFixture(root);
  const discovery = await discoveryRun(fixture);
  const analysisInput = analysisRequest(discovery.observations, discovery.result.config.configDigest);
  await jsonFile(root, 'analysis-request.json', analysisInput);
  const analysis = await analyzeInstructionEvidence({ projectRoot: root, request: analysisInput, output: 'analysis.json' });
  const planInput = { id: 'synthetic-caller-pilot', analysis: analysis.ref, proposalId: 'wire-callers', repetitions: 2, criteria,
    integrationChecks: { greeting: [{ visibility: 'heldOut', checkId: 'integration' }], checkout: [{ visibility: 'heldOut', checkId: 'integration' }] },
    preparation: { model: 'synthetic-analyst', usage: 'UNKNOWN', evidence: 'UNKNOWN' },
    confounds: ['Deterministic fake worker responds to a specific instruction phrase; this is not an inference model.', 'Two tasks and two repetitions exercise the contract, not generalization or statistical significance.'],
    exposureAttestation: 'The discovery export contains no control prompts, patches, answers or hidden verifier logs. Fixture author knows both tasks; no real model effectiveness claim.' };
  await jsonFile(root, 'plan-request.json', planInput);
  const planned = await planInstructionExperiment({ ...fixture, projectRoot: root, request: planInput, output: 'experiment' });
  await runInstructionExperiment({ ...fixture, projectRoot: root, planPath: planned.ref.path });
  const { report, ref: reportRef } = await readInstructionReport({ projectRoot: root, planPath: planned.ref.path, output: 'report.json' });
  const reviewRef = await jsonFile(root, 'review.json', { reviewer: 'synthetic-example', outcome: 'Harness contract demonstrated; no live model claim or promotion.' });
  const profileInput = { id: 'synthetic-caller-guidance', version: 1, plan: planned.ref, arm: 'B', review: { by: 'synthetic-example', reason: 'Retain an explicitly synthetic example profile; never use it as evidence of model effectiveness.', evidence: reviewRef }, previous: null };
  await jsonFile(root, 'profile-request.json', profileInput);
  await createInstructionProfile({ projectRoot: root, request: profileInput, output: 'profile-v1.json' });
  await writeFile(join(root, 'README.md'), '# Synthetic instruction experiment\n\nThis directory retains all runner artifacts. The fake worker creates an unwired helper under A and wires the caller under B. Independent Node subprocesses execute both visible and held-out checks on separate greeting and checkout fixtures.\n\nRead analysis.json, experiment/plan.json, report.json and profile-v1.json. Do not feed control results back into instruction generation. This is harness evidence only, not real-model effectiveness or feature acceptance.\n');
  process.stdout.write(`${JSON.stringify({ synthetic: true, directory: root, report: reportRef, state: report.state, discovery: report.partitions.discovery, control: report.partitions.control }, null, 2)}\n`);
}
