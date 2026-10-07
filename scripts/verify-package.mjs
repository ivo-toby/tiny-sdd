#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCallback);

export class PackageVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageVerificationError';
    this.code = code;
  }
}

function verificationError(code, message) {
  return new PackageVerificationError(code, message);
}

export function cleanNpmEnvironment(source = process.env, root) {
  const environment = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const normalized = key.toUpperCase();
    if (normalized === 'NODE_AUTH_TOKEN' || normalized === 'NPM_TOKEN' || normalized.startsWith('NPM_CONFIG_') || normalized.endsWith('_AUTH') || normalized.includes('PASSWORD')) continue;
    environment[key] = value;
  }
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  delete environment.NPM_CONFIG_USERCONFIG;
  delete environment.NPM_CONFIG_GLOBALCONFIG;
  delete environment.NPM_CONFIG_CACHE;
  environment.npm_config_userconfig = join(root, 'user.npmrc');
  environment.npm_config_globalconfig = join(root, 'global.npmrc');
  environment.npm_config_cache = join(root, 'npm-cache');
  return environment;
}

async function run(command, args, options) {
  try {
    return await execFile(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 });
  } catch (cause) {
    const output = [cause?.stdout, cause?.stderr].filter(Boolean).join('\n');
    throw verificationError('PACKAGE_VERIFY_COMMAND_FAILED', `${command} ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
  }
}

export async function verifyPackage({ artifact, version, sourceEnv = process.env, npm = 'npm', node = process.execPath } = {}) {
  if (typeof artifact !== 'string' || artifact.length === 0) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', '--package is required');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `invalid --version: ${version}`);
  const packagePath = resolve(artifact);
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-package-verify-'));
  const prefix = join(root, 'prefix');
  const environment = cleanNpmEnvironment(sourceEnv, root);
  environment.HOME = join(root, 'home');
  environment.PATH = `${join(prefix, 'bin')}:${environment.PATH ?? ''}`;
  const packageRoot = join(prefix, 'lib', 'node_modules', 'tinysdd');
  try {
    await run(npm, [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      packagePath,
    ], { env: environment });
    const executable = join(prefix, 'bin', 'tinysdd');
    const versionResult = await run(executable, ['--version'], { env: environment });
    if (versionResult.stdout.trim() !== version) {
      throw verificationError('PACKAGE_VERIFY_VERSION_MISMATCH', `installed tinysdd reported ${versionResult.stdout.trim()}, expected ${version}`);
    }
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (packageJson.name !== 'tinysdd' || packageJson.version !== version) {
      throw verificationError('PACKAGE_VERIFY_METADATA_MISMATCH', `installed package is ${packageJson.name}@${packageJson.version}`);
    }
    const resources = [
      'skills/tinysdd/SKILL.md',
      'skills/tinysdd/references/cli-workflow.md',
      'skills/tinysdd/assets/setup/SKILL.md',
      'skills/tinysdd/assets/setup/references/setup-workflow.md',
      'docs/quickstart.md',
      'src/setup.mjs',
    ];
    for (const resource of resources) await readFile(join(packageRoot, resource));
    await run(node, ['-e', `import(${JSON.stringify(join(packageRoot, 'src/setup.mjs'))}).then((m) => { if (m.CLI_VERSION !== ${JSON.stringify(version)}) process.exit(2); })`], { env: environment });
    return { artifact: packagePath, filename: basename(packagePath), version, resources: resources.length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--package' || argument === '--version') {
      const value = argv[++index];
      if (!value) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `${argument} requires a value`);
      result[argument.slice(2)] = value;
    } else if (argument === '--json') result.json = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `unknown argument: ${argument}`);
  }
  if (!result.help && (!result.package || !result.version)) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', '--package and --version are required');
  return result;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('usage: verify-package.mjs --package PATH --version X.Y.Z [--json]\n');
    return;
  }
  const result = await verifyPackage({ artifact: options.package, version: options.version });
  process.stdout.write(`${options.json ? JSON.stringify(result) : `verified ${result.filename}: tinysdd ${result.version}, CLI and ${result.resources} packaged resources`}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: cause?.code ?? 'PACKAGE_VERIFY_FAILED', message: cause instanceof Error ? cause.message : String(cause) } })}\n`);
    process.exitCode = 1;
  }
}
