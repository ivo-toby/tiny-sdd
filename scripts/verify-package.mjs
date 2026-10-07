#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
  ]);
  for (const key of allowed) {
    if (typeof source?.[key] === 'string') environment[key] = source[key];
  }
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

export async function verifyPackage({ artifact, projectRoot = process.cwd(), version, sourceEnv = process.env, npm = 'npm', node = process.execPath } = {}) {
  if (artifact !== undefined && (typeof artifact !== 'string' || artifact.length === 0)) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', '--package must be a nonempty path');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `invalid --version: ${version}`);
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-package-verify-'));
  const prefix = join(root, 'prefix');
  const environment = cleanNpmEnvironment(sourceEnv, root);
  environment.HOME = join(root, 'home');
  environment.PATH = `${join(prefix, 'bin')}:${environment.PATH ?? ''}`;
  const packageRoot = join(prefix, 'lib', 'node_modules', 'tinysdd');
  try {
    let packagePath;
    if (artifact) packagePath = resolve(artifact);
    else {
      const packDestination = join(root, 'package');
      await mkdir(packDestination, { recursive: true });
      const pack = await run(npm, ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', packDestination], { cwd: resolve(projectRoot), env: environment });
      let records;
      try {
        records = JSON.parse(pack.stdout);
      } catch {
        throw verificationError('PACKAGE_VERIFY_PACK_INVALID', 'npm pack did not return JSON metadata');
      }
      if (!Array.isArray(records) || records.length !== 1 || typeof records[0]?.filename !== 'string') {
        throw verificationError('PACKAGE_VERIFY_PACK_INVALID', 'npm pack did not return exactly one artifact');
      }
      packagePath = join(packDestination, records[0].filename);
    }
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
      'skills/tinysdd/assets/constitution/templates/constitution.md',
      'skills/tinysdd/assets/harness/claude/tinysdd-frontier/templates/change.json',
      'skills/tinysdd/assets/harness/claude/tinysdd-frontier/templates/context.json',
      'skills/tinysdd/assets/harness/claude/tinysdd-frontier/templates/slice.json',
      'skills/tinysdd/assets/harness/claude/tinysdd-frontier/references/phase-workflow.md',
      'prompts/worker.md',
      'profiles/qwen36-titan.json',
      'docs/quickstart.md',
      'docs/setup.md',
      'src/setup.mjs',
    ];
    for (const resource of resources) await readFile(join(packageRoot, resource));
    await run(node, ['-e', `import(${JSON.stringify(join(packageRoot, 'src/setup.mjs'))}).then((m) => { if (m.CLI_VERSION !== ${JSON.stringify(version)}) process.exit(2); })`], { env: environment });
    const project = join(root, 'smoke-project');
    await mkdir(project, { recursive: true });
    const init = await run(executable, ['--json', '--project', project, 'init', '--worker', 'smoke', '--provider', 'offline', '--model', 'smoke/model'], { env: environment });
    const initResult = JSON.parse(init.stdout);
    if (initResult.ok !== true) throw verificationError('PACKAGE_VERIFY_INIT_FAILED', 'installed CLI init did not report success');
    await readFile(join(project, '.tinysdd', 'config.json'));
    return { artifact: artifact ? packagePath : null, filename: basename(packagePath), version, resources: resources.length, initialized: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--package' || argument === '--project' || argument === '--version') {
      const value = argv[++index];
      if (!value) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `${argument} requires a value`);
      result[argument.slice(2)] = value;
    } else if (argument === '--json') result.json = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', `unknown argument: ${argument}`);
  }
  if (!result.help && (!result.version || (!result.package && !result.project))) throw verificationError('PACKAGE_VERIFY_ARGUMENT_INVALID', '--version and either --package or --project are required');
  return result;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('usage: verify-package.mjs (--package PATH | --project PATH) --version X.Y.Z [--json]\n');
    return;
  }
  const result = await verifyPackage({ artifact: options.package, projectRoot: options.project, version: options.version });
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
