import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { benchmarkFixtureDigest } from '../src/benchmark-runner.mjs';
import { parseBenchmarkChallenge, parseBenchmarkSuite } from '../src/benchmark-schema.mjs';
import { parseChecksManifest } from '../src/checks-manifest.mjs';
import { parseContextManifest } from '../src/context-compiler.mjs';
import { sha256 } from '../src/fs-utils.mjs';

const execFileAsync = promisify(execFile);
const SUITE_ROOT = fileURLToPath(new URL('../bench/write-tests-suite/', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function allFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `suite contains symlink ${relativePath}`);
    if (info.isDirectory()) files.push(...await allFiles(path, relativePath));
    else if (info.isFile()) files.push(relativePath);
    else assert.fail(`suite contains unsupported entry ${relativePath}`);
  }
  return files;
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function runTestCandidate(sourcePath, testPath) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tinysdd-write-tests-'));
  try {
    const sourceRoot = join(root, 'src');
    const testRoot = join(root, 'tests');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(testRoot, { recursive: true });
    await cp(sourcePath, join(sourceRoot, basename(sourcePath)));
    await cp(testPath, join(testRoot, 'contract.test.mjs'));
    try {
      const output = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', 'tests/contract.test.mjs'], {
        cwd: root,
        env: childEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
      });
      return { status: 0, output: `${output.stdout}${output.stderr}` };
    } catch (error) {
      return {
        status: typeof error.code === 'number' ? error.code : 1,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function witnessById(challenge, id) {
  const witness = challenge.witnesses.find((entry) => entry.id === id);
  assert.ok(witness, `${challenge.id} has no witness ${id}`);
  return witness;
}

test('write-tests suite manifests, resources, and audit map are complete and isolated', async () => {
  const suiteText = await readFile(join(SUITE_ROOT, 'suite.json'), 'utf8');
  const suite = parseBenchmarkSuite(suiteText);
  assert.equal(suite.id, 'write-tests-v1');
  assert.equal(suite.challenges.length, 5);
  const audit = await readJson(join(SUITE_ROOT, 'challenge-audit.json'));
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.suiteId, suite.id);
  assert.equal(audit.phase, 'phase-2');
  assert.equal(audit.challenges.length, suite.challenges.length);

  const auditById = new Map(audit.challenges.map((entry) => [entry.id, entry]));
  const seenIds = new Set();
  for (const challengeRef of suite.challenges) {
    assert.equal(await sha256(await readFile(join(SUITE_ROOT, challengeRef.path))), challengeRef.sha256, challengeRef.path);
    const challenge = parseBenchmarkChallenge(await readFile(join(SUITE_ROOT, challengeRef.path), 'utf8'));
    assert.equal(challenge.role, 'write-tests');
    assert.equal(challenge.packet.allowedPaths.length, 1);
    assert.match(challenge.packet.allowedPaths[0], /^tests\/contract\.test\.mjs$/u);
    assert.equal(challenge.packet.protectedPaths.includes(challenge.packet.allowedPaths[0]), false);
    assert.equal(seenIds.has(challenge.id), false);
    seenIds.add(challenge.id);

    const auditChallenge = auditById.get(challenge.id);
    assert.ok(auditChallenge, `missing audit entry for ${challenge.id}`);
    assert.equal(auditChallenge.wrongSources.length >= 3, true, `${challenge.id} must declare at least three mutants`);
    const referenceTestPath = join(SUITE_ROOT, auditChallenge.referenceTest.path);
    assert.equal(await sha256(await readFile(referenceTestPath)), auditChallenge.referenceTest.sha256, auditChallenge.referenceTest.path);
    assert.equal(auditChallenge.witnesses.length >= 3, true);
    const witnessIds = new Set(auditChallenge.witnesses.map((witness) => witness.id));
    const killedWitnesses = new Set();
    for (const mutant of auditChallenge.wrongSources) {
      const mutantPath = join(SUITE_ROOT, mutant.path);
      assert.equal(await sha256(await readFile(mutantPath)), mutant.sha256, mutant.path);
      assert.equal(relative(SUITE_ROOT, mutantPath).startsWith('fixtures/'), false);
      assert.equal(mutant.kills.length, 1);
      assert.equal(witnessIds.has(mutant.kills[0]), true);
      killedWitnesses.add(mutant.kills[0]);
      assert.ok(witnessById(auditChallenge, mutant.kills[0]).testName.length > 0);
    }
    assert.deepEqual(killedWitnesses, witnessIds, `${challenge.id} leaves a named witness without a mutant`);

    const fixtureRoot = join(SUITE_ROOT, challenge.fixture.path);
    assert.equal((await benchmarkFixtureDigest(fixtureRoot)).sha256, challenge.fixture.sha256, challenge.id);
    const packetRefs = [challenge.packet.brief, challenge.packet.context, challenge.packet.checks];
    for (const ref of packetRefs) assert.equal(await sha256(await readFile(join(SUITE_ROOT, ref.path))), ref.sha256, ref.path);
    const context = parseContextManifest(await readFile(join(SUITE_ROOT, challenge.packet.context.path), 'utf8'));
    assert.equal(context.resources.length, 1, `${challenge.id} must expose its import interface`);
    assert.equal(context.resources[0].path.startsWith('src/'), true);
    parseChecksManifest(await readFile(join(SUITE_ROOT, challenge.packet.checks.path), 'utf8'));
    for (const ref of [challenge.verifier.visible, challenge.verifier.heldOut]) {
      assert.equal(await sha256(await readFile(join(SUITE_ROOT, ref.path))), ref.sha256, ref.path);
      const manifest = parseChecksManifest(await readFile(join(SUITE_ROOT, ref.path), 'utf8'));
      assert.ok(manifest.checks.length >= 1);
      assert.equal(manifest.checks[0].argv[0], 'node');
      assert.equal(manifest.checks[0].argv[1], 'verifier/write-tests-verifier.mjs');
      assert.equal(manifest.checks[0].argv[2], ref === challenge.verifier.visible ? 'reference' : 'mutant');
      if (ref === challenge.verifier.visible) {
        assert.equal(manifest.checks.length, 1);
        assert.equal(manifest.checks[0].argv[3], challenge.id);
      } else {
        assert.equal(manifest.checks.length, auditChallenge.wrongSources.length);
        assert.deepEqual(new Set(manifest.checks.map((check) => check.id)), new Set(auditChallenge.wrongSources.map((mutant) => `mutant-${mutant.id}`)));
        for (const check of manifest.checks) {
          assert.equal(check.argv[3], challenge.id);
          assert.equal(check.argv[4].startsWith(`candidates/${challenge.id}/`), true);
          assert.equal(typeof check.argv[5], 'string');
        }
      }
    }
    assert.doesNotMatch(JSON.stringify(challenge), /candidate|mutant|wrong/u);
  }

  assert.equal(seenIds.size, 5);
  const fixtureFiles = await allFiles(join(SUITE_ROOT, 'fixtures'));
  assert.equal(fixtureFiles.some((path) => path.includes('candidate') || path.includes('verifier')), false);
});

test('reference tests pass and every declared mutant kills its named witness', async () => {
  const audit = await readJson(join(SUITE_ROOT, 'challenge-audit.json'));
  for (const challenge of audit.challenges) {
    const challengeManifest = await readJson(join(SUITE_ROOT, `challenges/${challenge.id}.json`));
    const moduleName = basename(challengeManifest.packet.protectedPaths.find((path) => path.startsWith('src/')));
    const referenceSource = join(SUITE_ROOT, challengeManifest.fixture.path, 'src', moduleName);
    const referenceTest = join(SUITE_ROOT, challenge.referenceTest.path);
    const reference = await runTestCandidate(referenceSource, referenceTest);
    assert.equal(reference.status, 0, `${challenge.id} reference failed:\n${reference.output}`);
    assert.match(reference.output, /# fail 0\b/u, challenge.id);
    assert.match(reference.output, new RegExp(`# pass ${challenge.witnesses.length}\\b`, 'u'), challenge.id);

    for (const mutant of challenge.wrongSources) {
      const result = await runTestCandidate(join(SUITE_ROOT, mutant.path), referenceTest);
      assert.notEqual(result.status, 0, `${challenge.id}/${mutant.id} was not killed`);
      const witness = witnessById(challenge, mutant.kills[0]);
      const witnessFailure = result.output.split('\n').find((line) => line.startsWith('not ok ') && line.includes(witness.testName));
      assert.ok(witnessFailure, `${challenge.id}/${mutant.id} did not fail named witness`);
      assert.match(result.output, /# fail [1-9]\d*\b/u, `${challenge.id}/${mutant.id} did not report a substantive failed test`);
    }
  }
});
