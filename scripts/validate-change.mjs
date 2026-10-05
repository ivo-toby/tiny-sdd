#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { buildRegistrationPlan } from '../src/change-format.mjs';

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write('usage: validate-change.mjs --change <path> [--project <path>] [--ready] [--json]\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--ready' || argument === '--export-ready') result.requireReady = true;
    else if (argument === '--project') result.projectRoot = argv[++index];
    else if (argument === '--change') result.changePath = argv[++index];
    else if (argument === '--help' || argument === '-h') return { help: true };
    else return usage(`unknown argument: ${argument}`);
  }
  if (!result.changePath) return usage('--change is required');
  if (typeof result.projectRoot !== 'string' || typeof result.changePath !== 'string') return usage('option values must be provided');
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options?.help) {
  process.stdout.write('usage: validate-change.mjs --change <path> [--project <path>] [--ready] [--json]\n');
} else if (options) {
  try {
    const plan = await buildRegistrationPlan(options);
    const output = {
      schemaVersion: 1,
      changeId: plan.changeId,
      readiness: plan.readiness,
      warnings: plan.warnings,
      metrics: plan.metrics,
      registrationPlan: plan.registrationPlan,
      preparationIdentity: plan.preparationIdentity,
      runtimeScope: plan.runtimeScope,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
