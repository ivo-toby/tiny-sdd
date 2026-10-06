#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { archiveChange } from '../src/living-spec.mjs';

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write('usage: archive-change.mjs --change <path> [--draft <path>] [--archive <path>] [--project <path>] [--json]\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--project') result.projectRoot = argv[++index];
    else if (argument === '--change') result.changePath = argv[++index];
    else if (argument === '--draft' || argument === '--merge-draft') result.draftPath = argv[++index];
    else if (argument === '--archive') result.archivePath = argv[++index];
    else if (argument === '--help' || argument === '-h') return { help: true };
    else return usage(`unknown argument: ${argument}`);
  }
  if (typeof result.changePath !== 'string' || result.changePath.length === 0) return usage('--change is required');
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options?.help) {
  process.stdout.write('usage: archive-change.mjs --change <path> [--draft <path>] [--archive <path>] [--project <path>] [--json]\n');
} else if (options) {
  try {
    const result = await archiveChange(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.alreadyArchived ? 'archive already exists' : 'archived change'}: ${result.changeId} -> ${result.archivePath}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
