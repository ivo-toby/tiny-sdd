import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assignSplit,
  buildManifest,
  mapExamples,
  prepareWorkspace,
} from '../bench/polyglot/lib/dataset.mjs';

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'tinysdd-polyglot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
}

function exerciseFiles(language, name, extra = {}) {
  const dir = `${language}/exercises/practice/${name}`;
  return {
    [`${dir}/.meta/config.json`]: JSON.stringify({
      files: {
        solution: [`${name}.py`],
        test: [`${name}_test.py`],
        example: ['.meta/example.py'],
      },
    }),
    [`${dir}/.meta/example.py`]: `# reference for ${name}\n`,
    [`${dir}/.meta/secret.txt`]: 'reference only\n',
    [`${dir}/.docs/instructions.md`]: `Do ${name}.\n`,
    [`${dir}/${name}.py`]: '# stub\n',
    [`${dir}/${name}_test.py`]: '# tests\n',
    ...extra,
  };
}

test('assignSplit is independent of input order', () => {
  const ids = ['python/a', 'python/b', 'python/c', 'go/x', 'go/y', 'rust/r1', 'rust/r2', 'rust/r3'];
  const forward = assignSplit(ids);
  const reversed = assignSplit([...ids].reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(Object.keys(forward).sort(), [...ids].sort());
});

test('assignSplit puts ceil(n/2) discovery exercises in each language', () => {
  const ids = [];
  for (const language of ['cpp', 'go', 'java', 'javascript', 'python', 'rust']) {
    for (let i = 0; i < 7 + ids.length % 3; i++) ids.push(`${language}/ex-${i}`);
  }
  const split = assignSplit(ids);
  for (const language of ['cpp', 'go', 'java', 'javascript', 'python', 'rust']) {
    const own = ids.filter((id) => id.startsWith(`${language}/`));
    const discovery = own.filter((id) => split[id] === 'discovery');
    assert.equal(discovery.length, Math.ceil(own.length / 2), language);
    assert.equal(own.length - discovery.length, Math.floor(own.length / 2), language);
  }
});

test('assignSplit rejects duplicate ids', () => {
  assert.throws(() => assignSplit(['python/a', 'python/a']), { code: 'DUPLICATE_ID' });
});

test('prepareWorkspace copies the exercise without .meta or .docs', async (t) => {
  const root = await fixtureRoot(t);
  await writeTree(root, {
    'python/exercises/practice/affine/affine.py': 'stub\n',
    'python/exercises/practice/affine/affine_test.py': 'tests\n',
    'python/exercises/practice/affine/src/helper.py': 'helper\n',
    'python/exercises/practice/affine/.meta/example.py': 'reference\n',
    'python/exercises/practice/affine/.docs/instructions.md': 'text\n',
  });
  const exercise = {
    id: 'python/affine',
    dir: 'python/exercises/practice/affine',
    solutionFiles: ['affine.py'],
    testFiles: ['affine_test.py'],
  };
  const dest = join(root, 'work');
  await prepareWorkspace({ checkoutDir: root, exercise, destDir: dest });
  assert.equal(await readFile(join(dest, 'affine.py'), 'utf8'), 'stub\n');
  assert.equal(await readFile(join(dest, 'affine_test.py'), 'utf8'), 'tests\n');
  assert.equal(await readFile(join(dest, 'src', 'helper.py'), 'utf8'), 'helper\n');
  await assert.rejects(readFile(join(dest, '.meta', 'example.py')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dest, '.docs', 'instructions.md')), { code: 'ENOENT' });
});

test('prepareWorkspace overlays solution files only', async (t) => {
  const root = await fixtureRoot(t);
  await writeTree(root, exerciseFiles('python', 'affine'));
  const exercise = {
    id: 'python/affine',
    dir: 'python/exercises/practice/affine',
    solutionFiles: ['affine.py'],
    testFiles: ['affine_test.py'],
  };
  const dest = join(root, 'work');
  const result = await prepareWorkspace({
    checkoutDir: root,
    exercise,
    destDir: dest,
    overlay: { 'affine.py': 'def solve():\n    return 1\n' },
  });
  assert.deepEqual(result.overlaid, ['affine.py']);
  assert.equal(await readFile(join(dest, 'affine.py'), 'utf8'), 'def solve():\n    return 1\n');
  assert.equal(await readFile(join(dest, 'affine_test.py'), 'utf8'), '# tests\n');
});

test('prepareWorkspace rejects overlay paths that are not solution files', async (t) => {
  const root = await fixtureRoot(t);
  await writeTree(root, exerciseFiles('python', 'affine'));
  const exercise = {
    id: 'python/affine',
    dir: 'python/exercises/practice/affine',
    solutionFiles: ['affine.py'],
    testFiles: ['affine_test.py'],
  };
  const attempts = [
    { 'affine_test.py': 'rewritten tests' },
    { '.meta/example.py': 'reference' },
    { '../escape.py': 'x' },
    { '/etc/passwd': 'x' },
    { 'other.py': 'x' },
  ];
  for (const overlay of attempts) {
    await assert.rejects(
      prepareWorkspace({ checkoutDir: root, exercise, destDir: join(root, 'work-bad'), overlay }),
      { code: 'OVERLAY_PATH_NOT_SOLUTION' },
      JSON.stringify(overlay),
    );
  }
  await assert.rejects(
    prepareWorkspace({
      checkoutDir: root,
      exercise,
      destDir: join(root, 'work-bad2'),
      overlay: { 'affine.py': 42 },
    }),
    { code: 'OVERLAY_NOT_TEXT' },
  );
});

test('buildManifest lists exercises with files, instructions and a stratified split', async (t) => {
  const root = await fixtureRoot(t);
  await writeTree(root, {
    ...exerciseFiles('python', 'affine'),
    ...exerciseFiles('python', 'bob'),
    ...exerciseFiles('python', 'cat', {
      'python/exercises/practice/cat/.docs/instructions.append.md': 'Extra.\n',
    }),
  });
  const manifest = await buildManifest({ checkoutDir: root, languages: ['python'] });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source.commit, null, 'fixture is not a git checkout');
  assert.deepEqual(manifest.exercises.map((e) => e.id), [
    'python/affine',
    'python/bob',
    'python/cat',
  ]);
  const cat = manifest.exercises[2];
  assert.equal(cat.instructions, 'Do cat.\n\n\nExtra.\n');
  assert.deepEqual(cat.solutionFiles, ['cat.py']);
  assert.deepEqual(cat.testFiles, ['cat_test.py']);
  assert.deepEqual(cat.exampleFiles, ['.meta/example.py']);
  assert.equal(cat.dir, 'python/exercises/practice/cat');
  const discovery = manifest.exercises.filter((e) => e.split === 'discovery');
  assert.equal(discovery.length, 2);
});

test('mapExamples matches by basename, then by unique extension', () => {
  assert.deepEqual(
    mapExamples(['yacht.cpp', 'yacht.h'], ['.meta/example.cpp', '.meta/example.h']).pairs,
    [
      { solution: 'yacht.cpp', example: '.meta/example.cpp' },
      { solution: 'yacht.h', example: '.meta/example.h' },
    ],
  );
  const js = mapExamples(['zipper.js'], ['.meta/proof.ci.js']);
  assert.deepEqual(js.pairs, [{ solution: 'zipper.js', example: '.meta/proof.ci.js' }]);
  const rust = mapExamples(['src/lib.rs', 'Cargo.toml'], ['.meta/example.rs']);
  assert.deepEqual(rust.pairs, [{ solution: 'src/lib.rs', example: '.meta/example.rs' }]);
  assert.deepEqual(rust.unmappedSolution, ['Cargo.toml']);
});

test('mapExamples reports examples that have no solution counterpart', () => {
  const mapping = mapExamples(
    ['src/main/java/Poker.java'],
    [
      '.meta/src/reference/java/Card.java',
      '.meta/src/reference/java/Hand.java',
      '.meta/src/reference/java/Poker.java',
    ],
  );
  assert.deepEqual(mapping.pairs, [
    { solution: 'src/main/java/Poker.java', example: '.meta/src/reference/java/Poker.java' },
  ]);
  assert.deepEqual(mapping.unusedExamples, [
    '.meta/src/reference/java/Card.java',
    '.meta/src/reference/java/Hand.java',
  ]);
});
