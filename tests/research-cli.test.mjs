import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const canonicalTmpdir = await realpath(tmpdir());
const cli = fileURLToPath(new URL('../scripts/research.mjs', import.meta.url));

test('research CLI keeps JSON stdout and fallback budget behavior from a third cwd', async () => {
  const fixture = await mkdtemp(join(canonicalTmpdir, 'tinysdd-research-cli-'));
  const project = join(fixture, 'project with spaces');
  const cwd = join(fixture, 'caller cwd with spaces');
  try {
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(cwd);
    await writeFile(join(project, 'proposal.md'), 'Select one source.\n');
    await writeFile(join(project, 'src', 'entry.mjs'), 'export const entry = true;\n');
    const output = join(fixture, 'packet output');
    const sourceBefore = await readFile(join(project, 'src', 'entry.mjs'));
    const result = await execute(process.execPath, [
      cli,
      '--json',
      'prepare',
      '--project',
      project,
      '--proposal',
      'proposal.md',
      '--out',
      output,
      '--max-files',
      '1',
      '--max-source-bytes',
      '4096',
      '--max-map-bytes',
      '4096',
      '--budget-bytes',
      '4096',
    ], { cwd, maxBuffer: 1024 * 1024 });
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.packet.repositoryMap.fileCount, 1);
    assert.match(result.stderr, /filesystem fallback/u);

    const selection = join(cwd, 'selection.json');
    const manifest = JSON.stringify({ schemaVersion: 1, facts: [], resources: [{ path: 'src/entry.mjs', startLine: 1, endLine: 1, purpose: 'selection hint' }] });
    await writeFile(selection, manifest);
    const draftOutput = join(fixture, 'draft output');
    const draft = await execute(process.execPath, [
      cli,
      '--json',
      'validate',
      '--project',
      project,
      '--packet',
      output,
      '--selection',
      selection,
      '--out',
      draftOutput,
      '--budget-bytes',
      '4096',
    ], { cwd, maxBuffer: 1024 * 1024 });
    assert.equal(draft.stdout.trim().split('\n').length, 1);
    const draftValue = JSON.parse(draft.stdout);
    assert.equal(draftValue.ok, true);
    assert.equal(draftValue.report.status, 'draft_unapproved');
    assert.equal(draftValue.report.gold.precision, 'UNKNOWN');
    const exactBudget = String(draftValue.report.budget.compiledBytes);
    const exactOutput = join(fixture, 'exact output');
    const exact = await execute(process.execPath, [
      cli,
      '--json',
      'validate',
      '--project',
      project,
      '--packet',
      output,
      '--selection',
      selection,
      '--out',
      exactOutput,
      '--budget-bytes',
      exactBudget,
    ], { cwd, maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(exact.stdout).ok, true);

    await assert.rejects(
      execute(process.execPath, [
        cli,
        '--json',
        'validate',
        '--project',
        project,
        '--packet',
        output,
        '--selection',
        selection,
        '--out',
        join(fixture, 'under output'),
        '--budget-bytes',
        String(Number(exactBudget) - 1),
      ], { cwd, maxBuffer: 1024 * 1024 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout.trim().split('\n').length, 1);
        assert.equal(JSON.parse(error.stdout).error.code, 'RESEARCH_BUDGET_EXCEEDED');
        return true;
      },
    );
    assert.deepEqual(await readFile(join(project, 'src', 'entry.mjs')), sourceBefore);

    await assert.rejects(
      execute(process.execPath, [cli, '--json', 'prepare', '--unknown'], { cwd, maxBuffer: 1024 * 1024 }),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(error.stdout.trim().split('\n').length, 1);
        const parsed = JSON.parse(error.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.error.code, 'RESEARCH_INVALID_ARGUMENT');
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
