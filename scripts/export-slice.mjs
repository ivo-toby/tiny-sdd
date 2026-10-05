#!/usr/bin/env node

import { publicError } from '../src/fs-utils.mjs';
import { exportSliceBundle } from '../src/slice-bundle.mjs';

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write('usage: export-slice.mjs --change <path> --slice <id> --out <directory> [--project <path>] [--json]\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--project') result.projectRoot = argv[++index];
    else if (argument === '--change') result.changePath = argv[++index];
    else if (argument === '--slice' || argument === '--task') result.sliceId = argv[++index];
    else if (argument === '--out') result.outputDir = argv[++index];
    else if (argument === '--help' || argument === '-h') return { help: true };
    else return usage(`unknown argument: ${argument}`);
  }
  for (const [name, value] of [['--change', result.changePath], ['--slice', result.sliceId], ['--out', result.outputDir]]) {
    if (typeof value !== 'string' || value.length === 0) return usage(`${name} is required`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options?.help) {
  process.stdout.write('usage: export-slice.mjs --change <path> --slice <id> --out <directory> [--project <path>] [--json]\n');
} else if (options) {
  try {
    const result = await exportSliceBundle(options);
    const output = {
      schemaVersion: result.schemaVersion,
      outputDir: result.outputDir,
      manifestPath: result.manifestPath,
      totalBytes: result.totalBytes,
      files: result.files,
      runtimeScope: result.manifest.runtimeScope,
      identity: result.manifest.identity,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
