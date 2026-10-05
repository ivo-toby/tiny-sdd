import { open, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  assertExactKeys,
  assertNoSymlinkPath,
  assertPlainObject,
  canonicalProjectRoot,
  normalizeProjectRelative,
  publicError,
  resolveProjectPath,
  sha256,
  stableStringify,
  tinyError,
} from './fs-utils.mjs';
import { isInternalPath, isSecretPath } from './file-scope.mjs';
import {
  compileContext,
  contextSizeMetrics,
  MAX_COMPILED_CONTEXT_BYTES,
  MAX_CONTEXT_SOURCE_BYTES,
  parseContextManifest,
} from './context-compiler.mjs';
import { scoreResearchSelection } from './research-scoring.mjs';

export const RESEARCH_PACKET_SCHEMA_VERSION = 1;
export const RESEARCH_MAP_SCHEMA_VERSION = 1;
export const RESEARCH_REPORT_SCHEMA_VERSION = 1;
export const MAX_RESEARCH_FILES = 20_000;
export const MAX_RESEARCH_SOURCE_BYTES = 512 * 1024 * 1024;
export const MAX_RESEARCH_MAP_BYTES = 16 * 1024 * 1024;
export const MAX_RESEARCH_PROPOSAL_BYTES = 128 * 1024;
export const MAX_RESEARCH_PROMPT_BYTES = 16 * 1024 * 1024;

const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;
const MAX_FALLBACK_ENTRIES = 100_000;
const MAX_HINTS_PER_FILE = 256;
const MAX_HINT_LINES = 160;
const READ_CHUNK_BYTES = 64 * 1024;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const SYMBOL_PATTERN = /^\s*(?:(?:export|default)\s+)*(?:(?:async)\s+)?(?:function|class|interface|type|enum|def)\s+([A-Za-z_$][\w$]*)/u;
const DECLARATION_PATTERN = /^\s*(?:(?:export|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/u;
const HEADING_PATTERN = /^\s*(#{1,6})\s+(.+?)\s*$/u;

function researchError(code, message, details = undefined) {
  return tinyError(code, message, details);
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${'/'}`) && !isAbsolute(path));
}

function assertOutside(root, candidate, label) {
  if (isInside(root, candidate)) throw researchError('RESEARCH_PATH_OVERLAP', `${label} must be outside the project root`);
}

function requireSafeInteger(value, label, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw researchError('RESEARCH_INVALID_BUDGET', `${label} must be a positive safe integer at most ${maximum}`);
  }
  return value;
}

function budgetValue(input, names, label, { maximum = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  const value = names.map((name) => input?.[name]).find((candidate) => candidate !== undefined);
  if (value === undefined && optional) return undefined;
  return requireSafeInteger(value, label, { maximum });
}

function normalizeBudgets(input, { requireCompiled = true } = {}) {
  const budgets = input?.budgets ?? input?.budget ?? input;
  if (budgets === null || typeof budgets !== 'object' || Array.isArray(budgets)) {
    throw researchError('RESEARCH_INVALID_BUDGET', 'explicit research budgets are required');
  }
  const result = {
    maxFiles: budgetValue(budgets, ['maxFiles', 'files'], 'maxFiles', { maximum: MAX_RESEARCH_FILES }),
    maxSourceBytes: budgetValue(budgets, ['maxSourceBytes', 'sourceBytes', 'maxTotalSourceBytes'], 'maxSourceBytes', { maximum: MAX_RESEARCH_SOURCE_BYTES }),
    maxMapBytes: budgetValue(budgets, ['maxMapBytes', 'mapBytes'], 'maxMapBytes', { maximum: MAX_RESEARCH_MAP_BYTES }),
    maxProposalBytes: budgetValue(budgets, ['maxProposalBytes', 'proposalBytes'], 'maxProposalBytes', { maximum: MAX_RESEARCH_PROPOSAL_BYTES, optional: true }) ?? MAX_RESEARCH_PROPOSAL_BYTES,
    maxFileBytes: budgetValue(budgets, ['maxFileBytes', 'fileBytes'], 'maxFileBytes', { maximum: MAX_CONTEXT_SOURCE_BYTES, optional: true }) ?? MAX_CONTEXT_SOURCE_BYTES,
    maxPromptBytes: budgetValue(budgets, ['maxPromptBytes', 'promptBytes'], 'maxPromptBytes', { maximum: MAX_RESEARCH_PROMPT_BYTES, optional: true }) ?? MAX_RESEARCH_PROMPT_BYTES,
  };
  const compiled = budgetValue(budgets, ['maxCompiledContextBytes', 'compiledContextBytes', 'budgetBytes', 'contextBytes'], 'maxCompiledContextBytes', { maximum: MAX_COMPILED_CONTEXT_BYTES, optional: !requireCompiled });
  if (compiled !== undefined) result.maxCompiledContextBytes = compiled;
  return result;
}

function normalizeProjectPathForResearch(value, label) {
  try {
    return normalizeProjectRelative(value, label);
  } catch (error) {
    throw researchError('RESEARCH_INVALID_PATH', error.message, error.details);
  }
}

function canonicalResearchPath(value, label) {
  const normalized = normalizeProjectPathForResearch(value, label);
  if (normalized !== value) throw researchError('RESEARCH_INVALID_PATH', `${label} must use its canonical project-relative spelling`);
  return normalized;
}

function excludedName(name, directory) {
  if (isInternalPath(name)) return true;
  return isSecretPath(directory ? `${name}/entry` : name);
}

function excludedPath(path) {
  return isInternalPath(path) || isSecretPath(path);
}

function gitEnvironment() {
  // Git discovery must be tied to cwd; inherited GIT_DIR/GIT_WORK_TREE can
  // otherwise redirect a packet to a different repository.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

async function runGitList(projectRoot) {
  const child = spawn('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: projectRoot,
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_GIT_LIST_BYTES) chunks.push(chunk);
    else overflow = true;
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length);
  });
  const termination = await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({ code: null, reason: 'git ls-files timed out' });
    }, 30_000);
    timer.unref?.();
    child.once('error', (error) => finish({ code: null, reason: error?.code === 'ENOENT' ? 'git is unavailable' : (error instanceof Error ? error.message : String(error)) }));
    child.once('close', (code) => finish({ code, reason: null }));
  });
  if (termination.reason) return { paths: null, reason: termination.reason };
  if (termination.code !== 0) return { paths: null, reason: stderr.trim().split('\n')[0] || `git ls-files exited ${termination.code}` };
  if (overflow) throw researchError('RESEARCH_MAP_LIMIT', `git file list exceeds ${MAX_GIT_LIST_BYTES} bytes`);
  const listed = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
  return { paths: [...new Set(listed)].sort(), reason: null };
}

async function fallbackWalk(projectRoot, maxFiles, excludedPaths = new Set()) {
  const paths = [];
  let entriesSeen = 0;
  async function visit(current, relativeDirectory) {
    const entries = await readdir(current, { withFileTypes: true });
    entriesSeen += entries.length;
    if (entriesSeen > MAX_FALLBACK_ENTRIES) throw researchError('RESEARCH_MAP_LIMIT', `filesystem fallback exceeds ${MAX_FALLBACK_ENTRIES} entries`);
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (excludedName(entry.name, entry.isDirectory())) continue;
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (excludedPath(path) || excludedPaths.has(path)) continue;
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute, path);
      } else if (info.isFile()) {
        paths.push(path);
        if (paths.length > maxFiles) throw researchError('RESEARCH_BUDGET_EXCEEDED', `repository map exceeds ${maxFiles} files`, { files: paths.length, limit: maxFiles });
      }
    }
  }
  await visit(projectRoot, '');
  return paths.sort();
}

async function discoverPaths(projectRoot, maxFiles, excludedPaths = new Set()) {
  const git = await runGitList(projectRoot);
  if (git.paths !== null) {
    return { mode: 'git-ls-files', fallbackReason: null, paths: git.paths };
  }
  return {
    mode: 'filesystem-fallback',
    fallbackReason: git.reason,
    paths: await fallbackWalk(projectRoot, maxFiles, excludedPaths),
  };
}

async function readBoundedFile(absolutePath, maxBytes, label) {
  const resolved = resolve(absolutePath);
  await assertNoSymlinkPath(resolved, { allowMissing: false });
  let pathInfo = await lstat(resolved);
  if (!pathInfo.isFile()) throw researchError('RESEARCH_INVALID_FILE', `${label} is not a regular file`);
  if (pathInfo.size > maxBytes) {
    throw researchError('RESEARCH_BUDGET_EXCEEDED', `${label} exceeds ${maxBytes} bytes`, { bytes: pathInfo.size, limit: maxBytes });
  }
  let canonicalResolved;
  try {
    canonicalResolved = await realpath(resolved);
  } catch (error) {
    throw researchError('RESEARCH_FILE_READ_FAILED', `could not resolve ${label}`, { cause: error?.code });
  }
  await assertNoSymlinkPath(resolved, { allowMissing: false });
  let handle;
  try {
    handle = await open(canonicalResolved, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw researchError('RESEARCH_FILE_READ_FAILED', `could not open ${label}`, { cause: error?.code });
  }
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size > maxBytes) {
      throw researchError('RESEARCH_BUDGET_EXCEEDED', `${label} exceeds ${maxBytes} bytes`, { bytes: openedInfo.size, limit: maxBytes });
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - total + 1));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maxBytes) {
        throw researchError('RESEARCH_BUDGET_EXCEEDED', `${label} exceeds ${maxBytes} bytes`, { bytes: total, limit: maxBytes });
      }
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const closedInfo = await handle.stat();
    await assertNoSymlinkPath(resolved, { allowMissing: false });
    let finalCanonical;
    try {
      finalCanonical = await realpath(resolved);
    } catch (error) {
      throw researchError('RESEARCH_SOURCE_CHANGED', `${label} changed while it was read`, { cause: error?.code });
    }
    pathInfo = await lstat(resolved);
    if (!pathInfo.isFile() || finalCanonical !== canonicalResolved || openedInfo.dev !== closedInfo.dev || openedInfo.ino !== closedInfo.ino || openedInfo.size !== closedInfo.size || pathInfo.dev !== openedInfo.dev || pathInfo.ino !== openedInfo.ino || pathInfo.size !== openedInfo.size) {
      throw researchError('RESEARCH_SOURCE_CHANGED', `${label} changed while it was read`);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error?.code?.startsWith?.('RESEARCH_')) throw error;
    throw researchError('RESEARCH_FILE_READ_FAILED', `could not read ${label}`, { cause: error?.code });
  } finally {
    await handle.close().catch(() => {});
  }
}

function decodeText(bytes, label) {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/u);
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function lexicalHints(text) {
  const lines = text.split(/\r?\n/u);
  if (text.endsWith('\n')) lines.pop();
  const starts = [];
  for (let index = 0; index < lines.length && starts.length < MAX_HINTS_PER_FILE; index += 1) {
    const line = lines[index];
    const symbol = line.match(SYMBOL_PATTERN);
    const declaration = line.match(DECLARATION_PATTERN);
    const heading = line.match(HEADING_PATTERN);
    if (symbol) starts.push({ kind: 'symbol', name: symbol[1], startLine: index + 1 });
    else if (declaration) starts.push({ kind: 'declaration', name: declaration[1], startLine: index + 1 });
    else if (heading) starts.push({ kind: 'heading', name: heading[2], startLine: index + 1 });
  }
  return starts.map((hint, index) => ({
    ...hint,
    endLine: Math.min(lines.length, hint.startLine + MAX_HINT_LINES - 1, (starts[index + 1]?.startLine ?? lines.length + 1) - 1),
  }));
}

function mapCore(map) {
  const { sha256: ignored, ...core } = map;
  return core;
}

function mapDigest(map) {
  return sha256(stableStringify(mapCore(map)));
}

function packetText(packet) {
  return `${stableStringify(packet)}\n`;
}

function jsonText(value) {
  return `${stableStringify(value)}\n`;
}

function retainedPath(path) {
  return `sources/${path}`;
}

async function outputLocation(outputDir, projectRoot, inputPaths = []) {
  if (typeof outputDir !== 'string' || outputDir.length === 0) throw researchError('RESEARCH_OUTPUT_REQUIRED', 'outputDir is required');
  const output = resolve(outputDir);
  await assertNoSymlinkPath(output, { allowMissing: true });
  const comparableOutput = await canonicalizeExistingAncestor(output);
  assertOutside(projectRoot, comparableOutput, 'output directory');
  for (const input of inputPaths) {
    if (!input) continue;
    const comparableInput = await canonicalizeExistingAncestor(resolve(input));
    if (isInside(comparableInput, comparableOutput) || isInside(comparableOutput, comparableInput)) throw researchError('RESEARCH_PATH_OVERLAP', 'output directory overlaps an input directory');
  }
  try {
    const info = await lstat(output);
    if (info) throw researchError('RESEARCH_OUTPUT_EXISTS', `output directory already exists: ${output}`);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'PATH_NOT_FOUND') return output;
    throw error;
  }
  return output;
}

async function canonicalizeExistingAncestor(target) {
  const resolved = resolve(target);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'PATH_NOT_FOUND') throw error;
      const parent = dirname(current);
      if (parent === current) return resolved;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

async function writeFreshDirectory(output, files) {
  const parent = dirname(output);
  await assertNoSymlinkPath(parent, { allowMissing: true, requireDirectory: false });
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkPath(parent, { allowMissing: false, requireDirectory: true });
  let owned = false;
  let suspicious = false;
  let reservedCanonical;
  let ownerIdentity;
  try {
    try {
      await mkdir(output, { recursive: false, mode: 0o700 });
      owned = true;
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') throw researchError('RESEARCH_OUTPUT_EXISTS', `output directory already exists: ${output}`);
      throw researchError('RESEARCH_OUTPUT_WRITE_FAILED', `could not reserve output directory: ${output}`, { cause: error?.code });
    }
    await assertNoSymlinkPath(output, { allowMissing: false, requireDirectory: true });
    reservedCanonical = await realpath(output);
    ownerIdentity = await lstat(output);
    for (const [relativePath, content] of files) {
      await assertNoSymlinkPath(output, { allowMissing: false, requireDirectory: true });
      const currentCanonical = await realpath(output);
      const currentIdentity = await lstat(output);
      if (currentCanonical !== reservedCanonical || currentIdentity.dev !== ownerIdentity.dev || currentIdentity.ino !== ownerIdentity.ino) throw researchError('RESEARCH_OUTPUT_CHANGED', `output directory changed while it was being written: ${output}`);
      const target = resolve(reservedCanonical, ...relativePath.split('/'));
      if (!isInside(reservedCanonical, target)) throw researchError('RESEARCH_INVALID_OUTPUT', `output file escapes output directory: ${relativePath}`);
      await assertNoSymlinkPath(target, { allowMissing: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
      await assertNoSymlinkPath(output, { allowMissing: false, requireDirectory: true });
      const afterCanonical = await realpath(output);
      const afterIdentity = await lstat(output);
      if (afterCanonical !== reservedCanonical || afterIdentity.dev !== ownerIdentity.dev || afterIdentity.ino !== ownerIdentity.ino) throw researchError('RESEARCH_OUTPUT_CHANGED', `output directory changed while it was being written: ${output}`);
    }
    await assertNoSymlinkPath(output, { allowMissing: false, requireDirectory: true });
    const finalCanonical = await realpath(output);
    const finalIdentity = await lstat(output);
    if (finalCanonical !== reservedCanonical || finalIdentity.dev !== ownerIdentity.dev || finalIdentity.ino !== ownerIdentity.ino) throw researchError('RESEARCH_OUTPUT_CHANGED', `output directory changed before publication: ${output}`);
  } catch (error) {
    suspicious = error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY' || error?.code === 'RESEARCH_OUTPUT_EXISTS' || error?.code === 'RESEARCH_OUTPUT_CHANGED';
    if (owned && !suspicious && ownerIdentity !== undefined) {
      const currentIdentity = await lstat(output).catch(() => null);
      if (currentIdentity?.dev === ownerIdentity.dev && currentIdentity?.ino === ownerIdentity.ino) await rm(output, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
  return output;
}

async function proposalInput(projectRoot, options, budgets) {
  const proposalPath = options.proposalPath ?? options.proposal?.path;
  if (typeof proposalPath !== 'string' || proposalPath.length === 0) throw researchError('RESEARCH_PROPOSAL_REQUIRED', 'proposalPath is required');
  const relativePath = normalizeProjectPathForResearch(proposalPath, 'proposal path');
  if (excludedPath(relativePath)) throw researchError('RESEARCH_INVALID_PATH', 'proposal path is excluded from research inputs');
  const resolved = await resolveProjectPath(projectRoot, relativePath, { field: 'proposal path', allowMissing: false });
  const bytes = await readBoundedFile(resolved.absolutePath, budgets.maxProposalBytes, `proposal ${relativePath}`);
  if (bytes.length === 0) throw researchError('RESEARCH_PROPOSAL_INVALID', 'proposal must not be empty');
  const text = decodeText(bytes, `proposal ${relativePath}`);
  if (text === null) throw researchError('RESEARCH_PROPOSAL_INVALID', 'proposal must be valid UTF-8');
  return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes), bytesValue: bytes, text, retainedPath: 'proposal.txt' };
}

function mapFileEntry(path, bytes, text) {
  const binary = text === null || bytes.includes(0);
  return {
    path,
    kind: binary ? 'binary' : 'text',
    bytes: bytes.length,
    sha256: sha256(bytes),
    lineCount: binary ? null : lineCount(text),
    hints: binary ? [] : lexicalHints(text),
    retainedPath: retainedPath(path),
  };
}

function selectionPrompt(proposal, repositoryMap) {
  return [
    'TinySDD local research selection request',
    '',
    'Select source citations only. Return one JSON object with exactly schemaVersion, facts, and resources.',
    'Set facts to an empty array. Each resource must contain path, startLine, endLine, and a short purpose describing why the verbatim range is useful.',
    'Use only paths and line ranges present in the repository map. Do not summarize, infer facts, or include source excerpts in your response.',
    '',
    `Proposal: ${proposal.path} (sha256:${proposal.sha256})`,
    proposal.text,
    '',
    'Repository map (lexical symbol hints are not verified semantic facts):',
    stableStringify(repositoryMap),
    '',
    'Response schema:',
    '{"schemaVersion":1,"facts":[],"resources":[{"path":"src/example.mjs","startLine":1,"endLine":10,"purpose":"selection hint"}]}',
    '',
  ].join('\n');
}

function validatePacketShape(packet) {
  assertPlainObject(packet, 'RESEARCH_PACKET_INVALID', 'research packet');
  assertExactKeys(packet, ['schemaVersion', 'kind', 'projectRoot', 'proposal', 'budgets', 'repositoryMap', 'sources', 'selectionPrompt'], 'RESEARCH_PACKET_INVALID', 'research packet');
  if (packet.schemaVersion !== RESEARCH_PACKET_SCHEMA_VERSION || packet.kind !== 'research-packet') throw researchError('RESEARCH_PACKET_INVALID', 'unsupported research packet schema');
  if (typeof packet.projectRoot !== 'string' || packet.projectRoot.length === 0) throw researchError('RESEARCH_PACKET_INVALID', 'research packet projectRoot is required');
  assertPlainObject(packet.proposal, 'RESEARCH_PACKET_INVALID', 'research packet proposal');
  assertExactKeys(packet.proposal, ['path', 'bytes', 'sha256', 'retainedPath'], 'RESEARCH_PACKET_INVALID', 'research packet proposal');
  canonicalResearchPath(packet.proposal.path, 'research packet proposal path');
  if (excludedPath(packet.proposal.path)) throw researchError('RESEARCH_PACKET_INVALID', 'research packet proposal path is excluded');
  requireSafeInteger(packet.proposal.bytes, 'research packet proposal bytes', { maximum: MAX_RESEARCH_PROPOSAL_BYTES });
  if (!/^[a-f0-9]{64}$/u.test(packet.proposal.sha256) || packet.proposal.retainedPath !== 'proposal.txt') throw researchError('RESEARCH_PACKET_INVALID', 'research packet proposal identity is invalid');
  assertPlainObject(packet.budgets, 'RESEARCH_PACKET_INVALID', 'research packet budgets');
  assertExactKeys(packet.budgets, ['maxFiles', 'maxSourceBytes', 'maxMapBytes', 'maxProposalBytes', 'maxFileBytes', 'maxPromptBytes', 'maxCompiledContextBytes'], 'RESEARCH_PACKET_INVALID', 'research packet budgets');
  const budgets = normalizeBudgets(packet.budgets);
  assertPlainObject(packet.repositoryMap, 'RESEARCH_PACKET_INVALID', 'research packet repositoryMap');
  assertExactKeys(packet.repositoryMap, ['schemaVersion', 'mode', 'fallbackReason', 'files', 'fileCount', 'sourceBytes', 'sha256'], 'RESEARCH_PACKET_INVALID', 'research packet repositoryMap');
  if (packet.repositoryMap.schemaVersion !== RESEARCH_MAP_SCHEMA_VERSION || !['git-ls-files', 'filesystem-fallback'].includes(packet.repositoryMap.mode)) throw researchError('RESEARCH_PACKET_INVALID', 'research packet repository map schema is invalid');
  if (packet.repositoryMap.fallbackReason !== null && typeof packet.repositoryMap.fallbackReason !== 'string') throw researchError('RESEARCH_PACKET_INVALID', 'research packet fallbackReason is invalid');
  if (!Array.isArray(packet.repositoryMap.files) || packet.repositoryMap.files.length > budgets.maxFiles || packet.repositoryMap.fileCount !== packet.repositoryMap.files.length) throw researchError('RESEARCH_PACKET_INVALID', 'research packet map file count exceeds its budget');
  if (!/^[a-f0-9]{64}$/u.test(packet.repositoryMap.sha256) || mapDigest(packet.repositoryMap) !== packet.repositoryMap.sha256) throw researchError('RESEARCH_PACKET_INVALID', 'research packet repository map digest does not match');
  if (!Array.isArray(packet.sources) || packet.sources.length !== packet.repositoryMap.files.length) throw researchError('RESEARCH_PACKET_INVALID', 'research packet source identities do not match its map');
  const mapPaths = new Set();
  let previousPath = '';
  let sourceBytes = 0;
  for (const [index, file] of packet.repositoryMap.files.entries()) {
    assertPlainObject(file, 'RESEARCH_PACKET_INVALID', `research packet map file ${index + 1}`);
    assertExactKeys(file, ['path', 'kind', 'bytes', 'sha256', 'lineCount', 'hints', 'retainedPath'], 'RESEARCH_PACKET_INVALID', `research packet map file ${index + 1}`);
    const path = canonicalResearchPath(file.path, `research packet map file ${index + 1} path`);
    if (path === packet.proposal.path || excludedPath(path)) throw researchError('RESEARCH_PACKET_INVALID', `research packet map path is excluded: ${path}`);
    if (index > 0 && path.localeCompare(previousPath, 'en') <= 0) throw researchError('RESEARCH_PACKET_INVALID', 'research packet map paths must be unique and sorted');
    previousPath = path;
    if (mapPaths.has(path)) throw researchError('RESEARCH_PACKET_INVALID', `research packet map repeats ${path}`);
    mapPaths.add(path);
    if (!['text', 'binary'].includes(file.kind) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > budgets.maxFileBytes || !/^[a-f0-9]{64}$/u.test(file.sha256) || file.retainedPath !== retainedPath(path)) throw researchError('RESEARCH_PACKET_INVALID', `research packet map identity is invalid: ${path}`);
    if (file.kind === 'text' && (!Number.isSafeInteger(file.lineCount) || file.lineCount < 0) || file.kind === 'binary' && file.lineCount !== null) throw researchError('RESEARCH_PACKET_INVALID', `research packet line count is invalid: ${path}`);
    if (!Array.isArray(file.hints) || file.hints.length > MAX_HINTS_PER_FILE) throw researchError('RESEARCH_PACKET_INVALID', `research packet hints are invalid: ${path}`);
    if (file.kind === 'binary' && file.hints.length !== 0) throw researchError('RESEARCH_PACKET_INVALID', `research packet binary file has lexical hints: ${path}`);
    let previousStart = 0;
    for (const [hintIndex, hint] of file.hints.entries()) {
      assertPlainObject(hint, 'RESEARCH_PACKET_INVALID', `research packet hint ${index + 1}.${hintIndex + 1}`);
      assertExactKeys(hint, ['kind', 'name', 'startLine', 'endLine'], 'RESEARCH_PACKET_INVALID', `research packet hint ${index + 1}.${hintIndex + 1}`);
      if (!['symbol', 'declaration', 'heading'].includes(hint.kind) || typeof hint.name !== 'string' || hint.name.length === 0 || !Number.isSafeInteger(hint.startLine) || hint.startLine < 1 || !Number.isSafeInteger(hint.endLine) || hint.endLine < hint.startLine || hint.endLine > (file.lineCount ?? 0) || hint.startLine < previousStart) {
        throw researchError('RESEARCH_PACKET_INVALID', `research packet hint is invalid: ${path}`);
      }
      previousStart = hint.startLine;
    }
    sourceBytes += file.bytes;
  }
  if (packet.repositoryMap.sourceBytes !== sourceBytes || sourceBytes > budgets.maxSourceBytes) throw researchError('RESEARCH_PACKET_INVALID', 'research packet source byte count exceeds its budget');
  for (const [index, source] of packet.sources.entries()) {
    assertPlainObject(source, 'RESEARCH_PACKET_INVALID', `research packet source ${index + 1}`);
    assertExactKeys(source, ['path', 'kind', 'bytes', 'sha256', 'lineCount', 'retainedPath'], 'RESEARCH_PACKET_INVALID', `research packet source ${index + 1}`);
    const expected = packet.repositoryMap.files[index];
    if (stableStringify(source) !== stableStringify({ path: expected.path, kind: expected.kind, bytes: expected.bytes, sha256: expected.sha256, lineCount: expected.lineCount, retainedPath: expected.retainedPath })) throw researchError('RESEARCH_PACKET_INVALID', `research packet source identity differs from map: ${index + 1}`);
  }
  assertPlainObject(packet.selectionPrompt, 'RESEARCH_PACKET_INVALID', 'research packet selectionPrompt');
  assertExactKeys(packet.selectionPrompt, ['retainedPath', 'bytes', 'sha256'], 'RESEARCH_PACKET_INVALID', 'research packet selectionPrompt');
  if (packet.selectionPrompt.retainedPath !== 'prompt.txt' || !Number.isSafeInteger(packet.selectionPrompt.bytes) || packet.selectionPrompt.bytes < 1 || packet.selectionPrompt.bytes > budgets.maxPromptBytes || !/^[a-f0-9]{64}$/u.test(packet.selectionPrompt.sha256)) throw researchError('RESEARCH_PACKET_INVALID', 'research packet selection prompt identity is invalid');
  return { packet, budgets };
}

async function readPacketDirectory(packetDir) {
  if (typeof packetDir !== 'string' || packetDir.length === 0) throw researchError('RESEARCH_PACKET_REQUIRED', 'packetDir is required');
  const requestedDirectory = resolve(packetDir);
  await assertNoSymlinkPath(requestedDirectory, { allowMissing: false, requireDirectory: true });
  let directory;
  try {
    directory = await realpath(requestedDirectory);
  } catch (error) {
    throw researchError('RESEARCH_PACKET_READ_FAILED', `could not resolve research packet: ${packetDir}`, { cause: error?.code });
  }
  await assertNoSymlinkPath(directory, { allowMissing: false, requireDirectory: true });
  const packetFile = resolve(directory, 'packet.json');
  const packetBytes = await readBoundedFile(packetFile, MAX_RESEARCH_MAP_BYTES, 'packet.json');
  let packet;
  try { packet = JSON.parse(packetBytes.toString('utf8')); } catch (error) { throw researchError('RESEARCH_PACKET_INVALID', `packet.json is not valid JSON: ${error.message}`); }
  validatePacketShape(packet);
  const proposalBytes = await readBoundedFile(resolve(directory, packet.proposal.retainedPath), packet.proposal.bytes, 'retained proposal');
  const promptBytes = await readBoundedFile(resolve(directory, packet.selectionPrompt.retainedPath), packet.selectionPrompt.bytes, 'selection prompt');
  if (proposalBytes.length !== packet.proposal.bytes || sha256(proposalBytes) !== packet.proposal.sha256) throw researchError('RESEARCH_PACKET_STALE', 'retained proposal identity does not match packet');
  if (promptBytes.length !== packet.selectionPrompt.bytes || sha256(promptBytes) !== packet.selectionPrompt.sha256) throw researchError('RESEARCH_PACKET_STALE', 'selection prompt identity does not match packet');
  const proposalText = decodeText(proposalBytes, 'retained proposal');
  if (proposalText === null) throw researchError('RESEARCH_PACKET_STALE', 'retained proposal is no longer valid UTF-8');
  const expectedPrompt = Buffer.from(selectionPrompt({ path: packet.proposal.path, sha256: packet.proposal.sha256, text: proposalText }, packet.repositoryMap));
  if (!expectedPrompt.equals(promptBytes)) throw researchError('RESEARCH_PACKET_STALE', 'retained selection prompt does not match the packet proposal and repository map');
  const sources = new Map();
  for (const [index, file] of packet.sources.entries()) {
    const bytes = await readBoundedFile(resolve(directory, file.retainedPath), file.bytes, `retained source ${file.path}`);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw researchError('RESEARCH_PACKET_STALE', `retained source identity does not match packet: ${file.path}`);
    const text = decodeText(bytes, file.path);
    const mapFile = packet.repositoryMap.files[index];
    const expected = mapFileEntry(mapFile.path, bytes, text);
    if (stableStringify(expected) !== stableStringify(mapFile)) throw researchError('RESEARCH_PACKET_STALE', `retained source metadata does not match packet: ${file.path}`);
    sources.set(file.path, { ...file, data: bytes, text: file.kind === 'text' ? text : null });
  }
  return { directory, packetFile, packet, packetBytes, proposalBytes, promptBytes, proposalText, sources };
}

function selectionInput(options) {
  if (typeof options.selectionText === 'string') return { path: options.selectionPath ?? 'selection.context.json', bytes: Buffer.from(options.selectionText) };
  if (typeof options.selection === 'string') return { path: options.selectionPath ?? 'selection.context.json', bytes: Buffer.from(options.selection) };
  if (options.selection && typeof options.selection === 'object') {
    const text = stableStringify(options.selection);
    return { path: options.selectionPath ?? 'selection.context.json', bytes: Buffer.from(`${text}\n`) };
  }
  if (typeof options.selectionPath !== 'string' || options.selectionPath.length === 0) throw researchError('RESEARCH_SELECTION_REQUIRED', 'selectionPath or selectionText is required');
  return { path: resolve(options.selectionPath), bytes: null };
}

async function readSelection(options, budgets) {
  const input = selectionInput(options);
  if (input.bytes === null) input.bytes = await readBoundedFile(input.path, MAX_RESEARCH_MAP_BYTES, 'selection manifest');
  if (input.bytes.length > MAX_RESEARCH_MAP_BYTES) throw researchError('RESEARCH_SELECTION_LIMIT', `selection manifest exceeds ${MAX_RESEARCH_MAP_BYTES} bytes`);
  let manifest;
  try { manifest = parseContextManifest(input.bytes.toString('utf8')); } catch (error) { throw error; }
  if (manifest.facts.length > 0) throw researchError('RESEARCH_SELECTION_FACTS_FORBIDDEN', 'research selection must contain an empty facts array');
  if (budgets.maxCompiledContextBytes < 1) throw researchError('RESEARCH_INVALID_BUDGET', 'maxCompiledContextBytes is required');
  return { path: input.path, bytes: input.bytes, text: input.bytes.toString('utf8'), sha256: sha256(input.bytes), manifest };
}

async function currentIdentity(projectRoot, source) {
  const relativePath = normalizeProjectPathForResearch(source.path, `selected source path ${source.path}`);
  const resolved = await resolveProjectPath(projectRoot, relativePath, { field: `selected source path ${source.path}`, allowMissing: false });
  const bytes = await readBoundedFile(resolved.absolutePath, source.bytes, `selected source ${source.path}`);
  const text = source.kind === 'text' ? decodeText(bytes, source.path) : null;
  if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) throw researchError('RESEARCH_SOURCE_STALE', `selected source changed since packet preparation: ${source.path}`, { expected: { bytes: source.bytes, sha256: source.sha256 }, actual: { bytes: bytes.length, sha256: sha256(bytes) } });
  if (source.kind === 'text' && text === null) throw researchError('RESEARCH_SOURCE_INVALID', `selected source is no longer valid UTF-8: ${source.path}`);
  return { bytes, text, path: relativePath, sha256: source.sha256, bytesLength: bytes.length };
}

function sourceReadForPacket(sources, current) {
  return async (path) => {
    const source = sources.get(path);
    if (!source) throw researchError('RESEARCH_CITATION_UNKNOWN', `selection cites a path absent from the packet: ${path}`);
    if (source.kind !== 'text' || source.text === null) throw researchError('RESEARCH_CITATION_BINARY', `selection cites a non-text source: ${path}`);
    if (!current.has(path)) {
      const identity = await currentIdentity(current.projectRoot, source);
      current.set(path, identity);
    }
    return source.text;
  };
}

function citedSources(manifest, sources) {
  const paths = [...new Set(manifest.resources.map((resource) => resource.path))];
  return paths.map((path) => {
    const source = sources.get(path);
    if (!source) throw researchError('RESEARCH_CITATION_UNKNOWN', `selection cites a path absent from the packet: ${path}`);
    return source;
  });
}

function goldInput(options) {
  if (options.goldManifest !== undefined) return options.goldManifest;
  if (options.goldText !== undefined) return options.goldText;
  if (options.goldPath !== undefined) return options.goldPath;
  return undefined;
}

async function readGold(options) {
  const value = goldInput(options);
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (value.trim().startsWith('{') || value.trim().startsWith('['))) return { path: 'gold.context.json', text: value, sha256: sha256(value) };
  if (value && typeof value === 'object' && typeof value.text === 'string') return { path: value.path ?? 'gold.context.json', text: value.text, sha256: value.sha256 ?? sha256(value.text) };
  if (value && typeof value === 'object') {
    const text = `${stableStringify(value)}\n`;
    return { path: 'gold.context.json', text, sha256: sha256(text) };
  }
  if (typeof value !== 'string') throw researchError('RESEARCH_GOLD_INVALID', 'gold manifest must be text, an object, or a path');
  const bytes = await readBoundedFile(resolve(value), MAX_RESEARCH_MAP_BYTES, 'gold manifest');
  return { path: resolve(value), text: bytes.toString('utf8'), sha256: sha256(bytes) };
}

function selectionBudget(options) {
  const value = options.budgetBytes ?? options.callerBudgetBytes ?? options.budget;
  return requireSafeInteger(value, 'budgetBytes', { maximum: MAX_COMPILED_CONTEXT_BYTES });
}

export async function prepareResearchPacket(options = {}) {
  const projectRoot = await canonicalProjectRoot(options.projectRoot ?? options.project ?? process.cwd());
  const budgets = normalizeBudgets(options, { requireCompiled: true });
  const proposal = await proposalInput(projectRoot, options, budgets);
  const discovered = await discoverPaths(projectRoot, budgets.maxFiles, new Set([proposal.path]));
  const files = [];
  const contents = new Map();
  let sourceBytes = 0;
  for (const rawPath of discovered.paths) {
    let path;
    path = canonicalResearchPath(rawPath, 'repository map path');
    if (path === proposal.path || excludedPath(path)) continue;
    if (files.length >= budgets.maxFiles) throw researchError('RESEARCH_BUDGET_EXCEEDED', `repository map exceeds ${budgets.maxFiles} files`, { files: files.length + 1, limit: budgets.maxFiles });
    const resolved = await resolveProjectPath(projectRoot, path, { field: 'repository map path', allowMissing: false });
    const info = await lstat(resolved.absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) continue;
    const remaining = budgets.maxSourceBytes - sourceBytes;
    if (remaining < 0) throw researchError('RESEARCH_BUDGET_EXCEEDED', `repository sources exceed ${budgets.maxSourceBytes} bytes`, { bytes: sourceBytes, limit: budgets.maxSourceBytes });
    const bytes = await readBoundedFile(resolved.absolutePath, Math.min(budgets.maxFileBytes, remaining), `repository source ${path}`);
    sourceBytes += bytes.length;
    if (sourceBytes > budgets.maxSourceBytes) throw researchError('RESEARCH_BUDGET_EXCEEDED', `repository sources exceed ${budgets.maxSourceBytes} bytes`, { bytes: sourceBytes, limit: budgets.maxSourceBytes });
    const text = decodeText(bytes, path);
    const entry = mapFileEntry(path, bytes, text);
    files.push(entry);
    contents.set(path, bytes);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const repositoryMapBase = {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    mode: discovered.mode,
    fallbackReason: discovered.fallbackReason,
    files,
    fileCount: files.length,
    sourceBytes,
  };
  const repositoryMap = { ...repositoryMapBase, sha256: mapDigest(repositoryMapBase) };
  const mapBytes = Buffer.byteLength(stableStringify(repositoryMap));
  if (mapBytes > budgets.maxMapBytes) throw researchError('RESEARCH_BUDGET_EXCEEDED', `repository map exceeds ${budgets.maxMapBytes} bytes`, { bytes: mapBytes, limit: budgets.maxMapBytes });
  if (files.length === 0) throw researchError('RESEARCH_EMPTY_MAP', 'repository map contains no eligible files');
  const sources = files.map(({ path, kind, bytes, sha256: digest, lineCount: lines, retainedPath: retained }) => ({ path, kind, bytes, sha256: digest, lineCount: lines, retainedPath: retained }));
  const prompt = selectionPrompt(proposal, repositoryMap);
  const promptBytes = Buffer.from(prompt);
  if (promptBytes.length > budgets.maxPromptBytes) throw researchError('RESEARCH_BUDGET_EXCEEDED', `selection prompt exceeds ${budgets.maxPromptBytes} bytes`, { bytes: promptBytes.length, limit: budgets.maxPromptBytes });
  const packet = {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    kind: 'research-packet',
    projectRoot,
    proposal: { path: proposal.path, bytes: proposal.bytes, sha256: proposal.sha256, retainedPath: proposal.retainedPath },
    budgets,
    repositoryMap,
    sources,
    selectionPrompt: { retainedPath: 'prompt.txt', bytes: promptBytes.length, sha256: sha256(promptBytes) },
  };
  const packetBytes = Buffer.from(packetText(packet));
  if (packetBytes.length > MAX_RESEARCH_MAP_BYTES) throw researchError('RESEARCH_BUDGET_EXCEEDED', `research packet exceeds ${MAX_RESEARCH_MAP_BYTES} bytes`, { bytes: packetBytes.length, limit: MAX_RESEARCH_MAP_BYTES });
  const output = await outputLocation(options.outputDir ?? options.out, projectRoot);
  const outputFiles = [
    ['packet.json', packetBytes],
    ['proposal.txt', proposal.bytesValue],
    ['prompt.txt', promptBytes],
  ];
  for (const source of sources) outputFiles.push([source.retainedPath, contents.get(source.path)]);
  await writeFreshDirectory(output, outputFiles);
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    outputDir: output,
    packetPath: join(output, 'packet.json'),
    packetSha256: sha256(packetBytes),
    packet,
    map: { mode: repositoryMap.mode, fileCount: repositoryMap.fileCount, sourceBytes: repositoryMap.sourceBytes, sha256: repositoryMap.sha256 },
    prompt: packet.selectionPrompt,
  };
}

export async function validateResearchSelection(options = {}) {
  const projectRoot = await canonicalProjectRoot(options.projectRoot ?? options.project ?? process.cwd());
  const packetData = await readPacketDirectory(options.packetDir ?? options.packet);
  if (packetData.packet.projectRoot !== projectRoot) throw researchError('RESEARCH_PROJECT_MISMATCH', 'packet projectRoot does not match the selected project');
  assertOutside(projectRoot, packetData.directory, 'packet directory');
  const proposalResolved = await resolveProjectPath(projectRoot, packetData.packet.proposal.path, { field: 'research proposal path', allowMissing: false });
  let currentProposal;
  try {
    currentProposal = await readBoundedFile(proposalResolved.absolutePath, packetData.packet.proposal.bytes, 'current research proposal');
  } catch (error) {
    if (error?.code === 'RESEARCH_BUDGET_EXCEEDED' || error?.code === 'RESEARCH_INVALID_FILE' || error?.code === 'RESEARCH_FILE_READ_FAILED') {
      throw researchError('RESEARCH_PROPOSAL_STALE', 'current research proposal no longer matches the prepared packet', { path: packetData.packet.proposal.path });
    }
    throw error;
  }
  if (currentProposal.length !== packetData.packet.proposal.bytes || sha256(currentProposal) !== packetData.packet.proposal.sha256) {
    throw researchError('RESEARCH_PROPOSAL_STALE', 'current research proposal no longer matches the prepared packet', { path: packetData.packet.proposal.path });
  }
  const callerBudgetBytes = selectionBudget(options);
  const budgets = normalizeBudgets({ ...packetData.packet.budgets, maxCompiledContextBytes: callerBudgetBytes }, { requireCompiled: true });
  const selection = await readSelection(options, budgets);
  const cited = citedSources(selection.manifest, packetData.sources);
  const current = new Map();
  current.projectRoot = projectRoot;
  for (const source of cited) {
    const identity = await currentIdentity(projectRoot, source);
    current.set(source.path, identity);
  }
  const readSource = sourceReadForPacket(packetData.sources, current);
  const contextPacket = { path: selection.path, text: selection.text, sha256: selection.sha256 };
  const compiled = await compileContext(projectRoot, contextPacket, { readSource });
  if (compiled.bytes > callerBudgetBytes) throw researchError('RESEARCH_BUDGET_EXCEEDED', `compiled context exceeds caller budget ${callerBudgetBytes} bytes`, { bytes: compiled.bytes, limit: callerBudgetBytes });
  const gold = await readGold(options);
  let score;
  if (gold !== undefined) {
    score = await scoreResearchSelection({
      projectRoot,
      goldManifest: gold,
      candidateManifest: contextPacket,
      budgetBytes: selectionBudget(options),
      readSource,
    });
    if (score.status === 'refused' || score.status === 'invalid') throw researchError('RESEARCH_GOLD_INVALID', 'gold manifest failed deterministic scoring validation', { score });
  }
  const report = {
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    kind: 'research-validation-report',
    status: 'draft_unapproved',
    approval: 'unapproved',
    projectRoot,
    packet: {
      path: packetData.packetFile,
      sha256: sha256(packetData.packetBytes),
      schemaVersion: packetData.packet.schemaVersion,
      mapSha256: packetData.packet.repositoryMap.sha256,
    },
    selection: {
      path: selection.path,
      bytes: selection.bytes.length,
      sha256: selection.sha256,
      facts: selection.manifest.facts.length,
      resources: selection.manifest.resources.length,
    },
    budget: {
      callerBytes: selectionBudget(options),
      compilerMaxBytes: MAX_COMPILED_CONTEXT_BYTES,
      compiledBytes: compiled.bytes,
      status: 'within',
    },
    compiled: {
      sha256: compiled.sha256,
      legacySha256: compiled.legacySha256,
      bytes: compiled.bytes,
      metrics: contextSizeMetrics(compiled),
      manifest: compiled.manifest,
      resources: compiled.resources,
    },
    sources: cited.map((source) => ({ path: source.path, bytes: source.bytes, sha256: source.sha256, lineCount: source.lineCount, retainedPath: source.retainedPath, currentSha256: current.get(source.path).sha256, currentBytes: current.get(source.path).bytesLength })),
    semantics: {
      selectionOnly: true,
      factsStatus: 'empty',
      purposes: 'model-authored-selection-hints',
      excerpts: 'verbatim-compiler-output',
    },
    gold: score === undefined
      ? { status: 'not_supplied', provenance: 'caller-supplied', precision: 'UNKNOWN', recall: 'UNKNOWN' }
      : { status: 'scored', provenance: 'caller-supplied', humanReviewed: 'UNKNOWN', calibration: 'UNKNOWN', score },
  };
  const inputPaths = [packetData.directory];
  if (typeof options.selectionPath === 'string') inputPaths.push(resolve(options.selectionPath));
  if (typeof options.goldPath === 'string') inputPaths.push(resolve(options.goldPath));
  const output = await outputLocation(options.outputDir ?? options.out, projectRoot, inputPaths);
  const reportBytes = Buffer.from(jsonText(report));
  const draftBytes = selection.bytes;
  const compiledBytes = Buffer.from(compiled.rendered);
  await writeFreshDirectory(output, [
    ['draft.context.json', draftBytes],
    ['compiled-context.md', compiledBytes],
    ['report.json', reportBytes],
  ]);
  return {
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    outputDir: output,
    draftManifestPath: join(output, 'draft.context.json'),
    compiledContextPath: join(output, 'compiled-context.md'),
    reportPath: join(output, 'report.json'),
    draftManifestSha256: sha256(draftBytes),
    compiledContextSha256: sha256(compiledBytes),
    reportSha256: sha256(reportBytes),
    report,
  };
}

export const prepareResearch = prepareResearchPacket;
export const buildResearchPacket = prepareResearchPacket;
export const validateResearch = validateResearchSelection;
export const validateResearchPacket = validateResearchSelection;
export { publicError };
