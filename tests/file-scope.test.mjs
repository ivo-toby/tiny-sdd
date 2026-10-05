import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFileScopeChange, detectCaseInsensitive, detectFilesystemAliases } from '../src/file-scope.mjs';

const file = { kind: 'file', sha256: 'a'.repeat(64), size: 1 };

test('ordinary created and modified files are eligible while extras remain visible', () => {
  assert.equal(classifyFileScopeChange({ path: 'src/extra.mjs', change: 'created', before: null, after: file }), null);
  assert.equal(classifyFileScopeChange({ path: 'src/extra.mjs', change: 'modified', before: file, after: { ...file, sha256: 'b'.repeat(64) } }), null);
});

test('protected, preparation and dependency boundaries include ancestor and descendant collisions', () => {
  for (const [options, path] of [
    [{ protectedPaths: ['specs/future.md'] }, 'specs/future.md/child.mjs'],
    [{ preparationPaths: ['specs/future.md'] }, 'specs/future.md'],
    [{ dependencyMounts: ['vendor/dependency'] }, 'vendor'],
    [{ dependencyMounts: ['vendor/dependency'] }, 'vendor/dependency/extra.mjs'],
  ]) {
    const violation = classifyFileScopeChange({ path, change: 'created', before: null, after: file }, options);
    assert.match(violation.reason, /protected|preparation|dependency/u, path);
  }
});

test('internal, secret, deletion, type and noncanonical candidates are refused', () => {
  for (const path of ['.git/config', 'src/.git/config', 'node_modules/x.mjs', 'src/node_modules/x.mjs', '.env', 'src/credentials.json', 'src\\.env']) {
    assert.ok(classifyFileScopeChange({ path, change: 'created', before: null, after: file }), path);
  }
  assert.ok(classifyFileScopeChange({ path: 'src/a.mjs', change: 'deleted', before: file, after: null }));
  assert.ok(classifyFileScopeChange({ path: 'src/a.mjs', change: 'type_changed', before: { kind: 'directory' }, after: file }));
  assert.ok(classifyFileScopeChange({ path: 'src/../a.mjs', change: 'created', before: null, after: file }));
});

test('protected aliases follow the observed filesystem case behavior', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-file-scope-'));
  try {
    const caseInsensitive = await detectCaseInsensitive(root);
    assert.ok(caseInsensitive === null || typeof caseInsensitive === 'boolean');
    assert.equal(Boolean(classifyFileScopeChange({ path: 'Specs/Future.md', change: 'created', before: null, after: file }, { protectedPaths: ['specs/future.md'], caseInsensitive: true })), true);
    assert.equal(classifyFileScopeChange({ path: 'Specs/Future.md', change: 'created', before: null, after: file }, { protectedPaths: ['specs/future.md'], caseInsensitive: false }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected Unicode aliases follow the observed filesystem normalization', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-file-scope-unicode-'));
  try {
    const aliases = await detectFilesystemAliases(root);
    assert.ok(aliases.unicodeInsensitive === null || typeof aliases.unicodeInsensitive === 'boolean');
    const nfc = 'specs/caf\u00e9.md';
    const nfd = nfc.normalize('NFD');
    assert.equal(Boolean(classifyFileScopeChange({ path: nfd, change: 'created', before: null, after: file }, { preparationPaths: [nfc], unicodeInsensitive: true })), true);
    assert.equal(classifyFileScopeChange({ path: nfd, change: 'created', before: null, after: file }, { preparationPaths: [nfc], unicodeInsensitive: false }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires only the alias modes used by a spelling difference', () => {
  const casePath = 'Specs/Future.md';
  const caseBoundary = 'specs/future.md';
  assert.ok(classifyFileScopeChange({ path: casePath, change: 'created', before: null, after: file }, {
    protectedPaths: [caseBoundary], caseInsensitive: true, unicodeInsensitive: false,
  }));
  assert.equal(classifyFileScopeChange({ path: casePath, change: 'created', before: null, after: file }, {
    protectedPaths: [caseBoundary], caseInsensitive: false, unicodeInsensitive: true,
  }), null);
  const nfc = 'specs/caf\u00e9.md';
  const nfd = nfc.normalize('NFD');
  assert.ok(classifyFileScopeChange({ path: nfd, change: 'created', before: null, after: file }, {
    preparationPaths: [nfc], caseInsensitive: false, unicodeInsensitive: true,
  }));
  assert.equal(classifyFileScopeChange({ path: nfd, change: 'created', before: null, after: file }, {
    preparationPaths: [nfc], caseInsensitive: true, unicodeInsensitive: false,
  }), null);
});

test('uses source-directory alias evidence for combined case and Unicode differences', () => {
  const filesystemAliases = {
    caseInsensitive: false,
    unicodeInsensitive: false,
    directoryModes: {
      '': { caseInsensitive: false, unicodeInsensitive: false },
      specs: { caseInsensitive: true, unicodeInsensitive: true },
      other: { caseInsensitive: false, unicodeInsensitive: false },
    },
  };
  const reserved = 'specs/Caf\u00e9.md';
  const combinedAlias = 'specs/cafe\u0301.MD';
  assert.equal(Boolean(classifyFileScopeChange({ path: combinedAlias, change: 'created', before: null, after: file }, {
    preparationPaths: [reserved],
    filesystemAliases,
  })), true);
  assert.equal(classifyFileScopeChange({ path: 'other/cafe\u0301.MD', change: 'created', before: null, after: file }, {
    preparationPaths: ['other/Caf\u00e9.md'],
    filesystemAliases,
  }), null);
});

test('refuses alias classification when source-directory evidence cannot be read', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-file-scope-error-'));
  const filePath = join(root, 'file');
  try {
    await writeFile(filePath, 'fixture\n');
    await assert.rejects(detectFilesystemAliases(filePath), (error) => error?.code === 'FILESYSTEM_ALIAS_PROBE_UNAVAILABLE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
