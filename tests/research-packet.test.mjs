import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  prepareResearchPacket,
  validateResearchSelection,
} from '../src/research-packet.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const canonicalTmpdir = await realpath(tmpdir());
const BUDGETS = Object.freeze({
  maxFiles: 20,
  maxSourceBytes: 64 * 1024,
  maxMapBytes: 64 * 1024,
  maxCompiledContextBytes: 96 * 1024,
});

async function makeProject({ bom = false } = {}) {
  const root = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-packet-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.tinysdd', 'runs'), { recursive: true });
  await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'proposal.md'), 'Research the source boundary.\n');
  const source = Buffer.from('export const value = 1;\nexport function read() { return value; }\n');
  await writeFile(join(root, 'src', 'module.mjs'), bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]) : source);
  await writeFile(join(root, '.env'), 'TOKEN=must-not-enter-packet\n');
  await writeFile(join(root, 'secrets', 'token.txt'), 'must-not-enter-packet\n');
  return root;
}

function selection(path = 'src/module.mjs', startLine = 1, endLine = 1) {
  return {
    schemaVersion: 1,
    facts: [],
    resources: [{ path, startLine, endLine, purpose: 'selection hint' }],
  };
}

async function prepare(root, outputDir) {
  return prepareResearchPacket({
    projectRoot: root,
    proposalPath: 'proposal.md',
    outputDir,
    budgets: BUDGETS,
  });
}

test('prepares deterministic bounded packets and excludes internal and secret paths', async () => {
  const root = await makeProject();
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-packet-out-'));
  try {
    const first = await prepare(root, join(temporary, 'first'));
    const second = await prepare(root, join(temporary, 'second'));
    assert.equal(first.packetSha256, second.packetSha256);
    assert.deepEqual(await readFile(first.packetPath), await readFile(second.packetPath));
    const packet = first.packet;
    assert.equal(packet.repositoryMap.mode, 'filesystem-fallback');
    assert.deepEqual(packet.repositoryMap.files.map(({ path }) => path), ['src/module.mjs']);
    assert.equal(packet.proposal.bytes, Buffer.byteLength('Research the source boundary.\n'));
    assert.equal(packet.sources[0].sha256, sha256(await readFile(join(root, 'src', 'module.mjs'))));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('does not charge the proposal against the eligible file limit', async () => {
  const root = await makeProject();
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-proposal-limit-'));
  try {
    const packet = await prepareResearchPacket({
      projectRoot: root,
      proposalPath: 'proposal.md',
      outputDir: join(temporary, 'packet'),
      budgets: { ...BUDGETS, maxFiles: 1 },
    });
    assert.equal(packet.map.fileCount, 1);
    assert.deepEqual(packet.packet.repositoryMap.files.map(({ path }) => path), ['src/module.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('validates a selection into a draft with verbatim source digests and UNKNOWN gold', async () => {
  const root = await makeProject({ bom: true });
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-selection-out-'));
  try {
    const packet = await prepare(root, join(temporary, 'packet'));
    const result = await validateResearchSelection({
      projectRoot: root,
      packetDir: packet.outputDir,
      selection: selection(),
      budgetBytes: BUDGETS.maxCompiledContextBytes,
      outputDir: join(temporary, 'result'),
    });
    const source = await readFile(join(root, 'src', 'module.mjs'));
    assert.equal(result.report.status, 'draft_unapproved');
    assert.equal(result.report.approval, 'unapproved');
    assert.equal(result.report.selection.facts, 0);
    assert.equal(result.report.gold.status, 'not_supplied');
    assert.equal(result.report.gold.precision, 'UNKNOWN');
    assert.equal(result.report.gold.recall, 'UNKNOWN');
    assert.equal(result.report.compiled.resources[0].sourceSha256, sha256(source));
    assert.match(await readFile(result.compiledContextPath, 'utf8'), /export const value = 1;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('refuses facts, unknown citations, proposal drift, source drift, and retained-source substitution', async () => {
  const root = await makeProject();
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-rejections-'));
  try {
    const packet = await prepare(root, join(temporary, 'packet'));
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: { ...selection(), facts: ['invented fact'] }, budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'facts') }),
      { code: 'RESEARCH_SELECTION_FACTS_FORBIDDEN' },
    );
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: selection('src/missing.mjs'), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'unknown') }),
      { code: 'RESEARCH_CITATION_UNKNOWN' },
    );
    await writeFile(join(root, 'proposal.md'), 'Proposal changed.\n');
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'proposal-drift') }),
      { code: 'RESEARCH_PROPOSAL_STALE' },
    );
    await writeFile(join(root, 'proposal.md'), 'Research the source boundary.\n');
    await writeFile(join(root, 'src', 'module.mjs'), 'export const value = 2;\nexport function read() { return value; }\n');
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'source-drift') }),
      { code: 'RESEARCH_SOURCE_STALE' },
    );
    const retained = join(packet.outputDir, 'sources', 'src', 'module.mjs');
    await writeFile(retained, 'substituted\n');
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'retained-drift') }),
      { code: 'RESEARCH_PACKET_STALE' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('refuses excluded proposal paths and preserves existing or overlapping outputs', async () => {
  const root = await makeProject();
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-output-'));
  try {
    await assert.rejects(
      prepareResearchPacket({ projectRoot: root, proposalPath: '.env', outputDir: join(temporary, 'secret-proposal'), budgets: BUDGETS }),
      { code: 'RESEARCH_INVALID_PATH' },
    );
    const packet = await prepare(root, join(temporary, 'packet'));
    await assert.rejects(
      prepare(root, join(temporary, 'packet')),
      { code: 'RESEARCH_OUTPUT_EXISTS' },
    );
    assert.equal(await readFile(join(packet.outputDir, 'proposal.txt'), 'utf8'), 'Research the source boundary.\n');
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: packet.outputDir, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(packet.outputDir, 'nested') }),
      { code: 'RESEARCH_PATH_OVERLAP' },
    );
    const insidePacket = join(root, 'inside-packet');
    await cp(packet.outputDir, insidePacket, { recursive: true });
    await assert.rejects(
      validateResearchSelection({ projectRoot: root, packetDir: insidePacket, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'inside-result') }),
      { code: 'RESEARCH_PATH_OVERLAP' },
    );
    const rootName = root.split('/').pop();
    const caseAlias = join(root, '..', rootName[0].toUpperCase() + rootName.slice(1), 'inside-packet');
    try {
      if (await realpath(caseAlias) === insidePacket && caseAlias !== insidePacket) {
        await assert.rejects(
          validateResearchSelection({ projectRoot: root, packetDir: caseAlias, selection: selection(), budgetBytes: BUDGETS.maxCompiledContextBytes, outputDir: join(temporary, 'case-alias-result') }),
          { code: 'RESEARCH_PATH_OVERLAP' },
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await assert.rejects(
      prepare(root, join(root, 'new-packet')),
      { code: 'RESEARCH_PATH_OVERLAP' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bounds fallback discovery before exceeding the caller file limit', async () => {
  const root = await makeProject();
  const temporary = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-file-limit-'));
  const output = join(temporary, 'packet');
  try {
    await writeFile(join(root, 'src', 'second.mjs'), 'export const second = 2;\n');
    await assert.rejects(
      prepareResearchPacket({
        projectRoot: root,
        proposalPath: 'proposal.md',
        outputDir: output,
        budgets: { ...BUDGETS, maxFiles: 1 },
      }),
      { code: 'RESEARCH_BUDGET_EXCEEDED' },
    );
    await assert.rejects(readFile(join(output, 'packet.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});
