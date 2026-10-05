#!/usr/bin/env node

import { publicError, tinyError } from '../src/fs-utils.mjs';
import {
  prepareResearchPacket,
  validateResearchSelection,
} from '../src/research-packet.mjs';

const VALUE_FLAGS = new Set([
  '--project',
  '--proposal',
  '--proposal-path',
  '--out',
  '--output',
  '--packet',
  '--packet-dir',
  '--selection',
  '--selection-path',
  '--selection-text',
  '--budget',
  '--budget-bytes',
  '--max-files',
  '--max-source-bytes',
  '--max-map-bytes',
  '--max-proposal-bytes',
  '--max-file-bytes',
  '--max-prompt-bytes',
  '--gold',
  '--gold-path',
  '--gold-text',
]);

function usageText() {
  return [
    'usage:',
    '  research.mjs prepare --project <directory> --proposal <path> --out <directory>',
    '    --max-files <n> --max-source-bytes <n> --max-map-bytes <n> --budget-bytes <n>',
    '  research.mjs validate --project <directory> --packet <directory> --selection <path> --out <directory> --budget-bytes <n>',
    '',
    'Optional prepare limits: --max-proposal-bytes, --max-file-bytes, --max-prompt-bytes.',
    'Optional validate input: --gold <path> (or --gold-text <json>).',
    'Use --json to make the success/error envelope explicit; output is JSON by default.',
  ].join('\n');
}

function usageError(message) {
  return tinyError('RESEARCH_INVALID_ARGUMENT', message);
}

function parseArgs(argv) {
  const options = { json: false };
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (command === undefined && !argument.startsWith('--')) {
      command = argument;
      continue;
    }
    const equals = argument.indexOf('=');
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (!VALUE_FLAGS.has(flag)) throw usageError(`unknown option: ${argument}`);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    const value = inline === undefined ? argv[++index] : inline;
    if (typeof value !== 'string' || value.length === 0 || (inline === undefined && value.startsWith('--'))) {
      throw usageError(`${flag} requires a value`);
    }
    options[flag.slice(2).replaceAll('-', '')] = value;
  }
  if (command === undefined) throw usageError('a prepare or validate command is required');
  if (!['prepare', 'packet', 'validate', 'selection'].includes(command)) throw usageError(`unknown command: ${command}`);
  return { command: command === 'packet' ? 'prepare' : command === 'selection' ? 'validate' : command, options };
}

function value(options, ...names) {
  return names.map((name) => options[name]).find((candidate) => candidate !== undefined);
}

function required(options, names, flag) {
  const result = value(options, ...names);
  if (typeof result !== 'string' || result.length === 0) throw usageError(`${flag} is required`);
  return result;
}

function numberValue(options, names) {
  const raw = value(options, ...names);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw usageError(`${names[0]} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw usageError(`${names[0]} must be a positive safe integer`);
  return parsed;
}

function prepareOptions(options) {
  const projectRoot = required(options, ['project'], '--project');
  const proposalPath = required(options, ['proposal', 'proposalpath'], '--proposal');
  const outputDir = required(options, ['out', 'output'], '--out');
  const budgets = {
    maxFiles: numberValue(options, ['maxfiles']),
    maxSourceBytes: numberValue(options, ['maxsourcebytes']),
    maxMapBytes: numberValue(options, ['maxmapbytes']),
    maxCompiledContextBytes: numberValue(options, ['budgetbytes', 'budget']),
  };
  for (const [name, budget] of Object.entries(budgets)) {
    if (budget === undefined) throw usageError(`--${name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  for (const [name, flag] of [
    ['maxProposalBytes', ['maxproposalbytes']],
    ['maxFileBytes', ['maxfilebytes']],
    ['maxPromptBytes', ['maxpromptbytes']],
  ]) {
    const parsed = numberValue(options, flag);
    if (parsed !== undefined) budgets[name] = parsed;
  }
  return { projectRoot, proposalPath, outputDir, budgets };
}

function validateOptions(options) {
  const projectRoot = required(options, ['project'], '--project');
  const packetDir = required(options, ['packet', 'packetdir'], '--packet');
  const outputDir = required(options, ['out', 'output'], '--out');
  const budgetBytes = numberValue(options, ['budgetbytes', 'budget']);
  if (budgetBytes === undefined) throw usageError('--budget-bytes is required');
  const selectionPath = value(options, 'selection', 'selectionpath');
  const selectionText = value(options, 'selectiontext');
  if (selectionPath === undefined && selectionText === undefined) throw usageError('--selection or --selection-text is required');
  if (selectionPath !== undefined && selectionText !== undefined) throw usageError('--selection and --selection-text cannot both be supplied');
  const goldPath = value(options, 'gold', 'goldpath');
  const goldText = value(options, 'goldtext');
  if (goldPath !== undefined && goldText !== undefined) throw usageError('--gold and --gold-text cannot both be supplied');
  return {
    projectRoot,
    packetDir,
    outputDir,
    budgetBytes,
    ...(selectionPath === undefined ? { selectionText } : { selectionPath }),
    ...(goldPath === undefined && goldText === undefined ? {} : goldPath === undefined ? { goldText } : { goldPath }),
  };
}

function warningsFor(result) {
  const warnings = [];
  if (result?.map?.mode === 'filesystem-fallback') {
    warnings.push(`repository map used filesystem fallback: ${result.packet?.repositoryMap?.fallbackReason ?? 'git file listing unavailable'}`);
  }
  if (result?.report?.gold?.status === 'not_supplied') {
    warnings.push('no caller-supplied gold manifest; precision and recall are UNKNOWN');
  }
  return warnings;
}

async function run(command, options) {
  if (command === 'prepare') return prepareResearchPacket(prepareOptions(options));
  return validateResearchSelection(validateOptions(options));
}

const parsed = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    const reported = publicError(error);
    process.stderr.write(`${JSON.stringify(reported)}\n${usageText()}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: reported })}\n`);
    process.exitCode = 2;
    return null;
  }
})();

if (parsed?.help) {
  process.stdout.write(`${usageText()}\n`);
} else if (parsed) {
  try {
    const result = await run(parsed.command, parsed.options);
    for (const warning of warningsFor(result)) process.stderr.write(`WARNING: ${warning}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, command: parsed.command, error: publicError(error) })}\n`);
    process.exitCode = 1;
  }
}
