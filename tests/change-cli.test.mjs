import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

import { addTask, approveTask, initProject } from '../src/controller.mjs';
import { validateChange } from '../src/change-format.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/tinysdd.mjs', import.meta.url));
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, 'examples', 'artifact-format');
const CANONICAL_TMP = await realpath(tmpdir());
const CHANGE_PATH = 'examples/artifact-format/changes/broker-recut/change.json';

async function project() {
  const root = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-change-cli-'));
  await cp(FIXTURE, join(root, 'examples', 'artifact-format'), { recursive: true });
  await initProject(root);
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function invoke(projectRoot, ...args) {
  try {
    const result = await exec(process.execPath, [cli, '--json', '--project', projectRoot, ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function parseSingleJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

async function registerFirstSlice(root) {
  const validated = await validateChange(root, CHANGE_PATH);
  const plan = validated.registrationPlan[0];
  const tasks = join(root, '.tinysdd', 'tasks');
  await mkdir(tasks, { recursive: true });
  const slice = validated.slices.find((item) => item.value.id === plan.id);
  const briefPath = '.tinysdd/tasks/' + plan.id + '.md';
  const contextPath = '.tinysdd/tasks/' + plan.id + '.context.json';
  const checksPath = '.tinysdd/tasks/' + plan.id + '.checks.json';
  await writeFile(join(root, briefPath), slice.brief.text);
  await writeFile(join(root, contextPath), slice.context.text);
  await writeFile(join(root, checksPath), slice.checks.text);
  await addTask(root, {
    id: plan.id,
    feature: plan.feature,
    brief: briefPath,
    context: contextPath,
    checks: checksPath,
    allow: plan.allow,
    protect: plan.protect,
    preparation: plan.preparation,
    dependsOn: plan.dependsOn,
  });
  await approveTask(root, { id: plan.id, by: 'fixture-operator', reason: 'offline change CLI test approval' });
  return { plan };
}

test('change validate prints the read-only registration plan as one JSON object', async () => {
  const root = await project();
  try {
    const result = await invoke(root, 'change', 'validate', '--change', CHANGE_PATH);
    assert.equal(result.status, 0);
    const envelope = parseSingleJson(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.schemaVersion, 1);
    assert.equal(envelope.data.changeId, 'broker-recut');
    assert.equal(envelope.data.readiness.ready, true);
    assert.ok(Array.isArray(envelope.data.registrationPlan));
    assert.equal(envelope.data.registrationPlan.length, 6);
    assert.ok(envelope.data.runtimeScope.mode);

    const missing = await invoke(root, 'change', 'validate');
    assert.equal(missing.status, 1);
    assert.equal(parseSingleJson(missing).error.code, 'INVALID_ARGUMENT');
    const unknown = await invoke(root, 'change', 'bogus');
    assert.equal(unknown.status, 1);
    assert.match(parseSingleJson(unknown).error.message, /change requires validate or export/u);
  } finally {
    await cleanup(root);
  }
});

test('change validate --ready fails closed on a not-ready change', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'examples/artifact-format/changes/broker-recut/slices/s2/brief.md'), '# draft slice\n');
    const result = await invoke(root, 'change', 'validate', '--change', CHANGE_PATH, '--ready');
    assert.equal(result.status, 1);
    const envelope = parseSingleJson(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'CHANGE_NOT_READY');
  } finally {
    await cleanup(root);
  }
});

test('change export writes the approved slice bundle without touching controller state', async () => {
  const root = await project();
  const outputParent = await mkdtemp(join(CANONICAL_TMP, 'tinysdd-change-cli-output-'));
  try {
    const { plan } = await registerFirstSlice(root);
    const beforeState = await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8');
    const output = join(outputParent, 'slice');
    const result = await invoke(root, 'change', 'export', '--change', CHANGE_PATH, '--slice', plan.id, '--out', output);
    assert.equal(result.status, 0);
    const envelope = parseSingleJson(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.schemaVersion, 1);
    assert.equal(envelope.data.outputDir, output);
    assert.equal(envelope.data.manifestPath, join(output, 'bundle.json'));
    assert.ok(envelope.data.files.includes('bundle.json'));
    assert.ok(envelope.data.files.includes('packet.json'));
    assert.deepEqual(envelope.data.runtimeScope, { mode: 'ordinary-create-modify', ordinaryCreateModify: true, deletions: false });
    const manifest = JSON.parse(await readFile(join(output, 'bundle.json'), 'utf8'));
    assert.equal(manifest.sliceId, plan.id);
    assert.equal(await readFile(join(root, '.tinysdd', 'runs', 'controller.json'), 'utf8'), beforeState);

    const collision = await invoke(root, 'change', 'export', '--change', CHANGE_PATH, '--slice', plan.id, '--out', output);
    assert.equal(collision.status, 1);
    assert.equal(parseSingleJson(collision).error.code, 'BUNDLE_OUTPUT_COLLISION');
    const unknownSlice = await invoke(root, 'change', 'export', '--change', CHANGE_PATH, '--slice', 'nope', '--out', join(outputParent, 'other'));
    assert.equal(unknownSlice.status, 1);
    assert.equal(parseSingleJson(unknownSlice).error.code, 'SLICE_NOT_FOUND');
  } finally {
    await cleanup(root);
    await cleanup(outputParent);
  }
});

test('change validate human mode prints warnings and readiness issues with distinct prefixes', async () => {
  const root = await project();
  try {
    const slicePath = join(root, 'examples/artifact-format/changes/broker-recut/slices/s2/slice.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf8'));
    slice.implementationFiles = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'];
    await writeFile(slicePath, `${JSON.stringify(slice, null, 2)}\n`);
    await writeFile(join(root, 'examples/artifact-format/changes/broker-recut/slices/s2/brief.md'), '# draft slice\n');
    const result = await exec(process.execPath, [cli, '--project', root, 'change', 'validate', '--change', CHANGE_PATH], {
      env: { ...process.env, TYPESAFE_API_KEY: 'stub' },
    });
    assert.match(result.stdout, /Change broker-recut: not ready/u);
    assert.match(result.stderr, /Warning: slice broker-s2 expects 4 implementation files/u);
    assert.match(result.stderr, /Not ready: /u);
    assert.doesNotMatch(result.stderr, /Warning: .*not ready|Warning: change broker-recut is not export-ready/u);

    const flagValue = await invoke(root, 'change', 'validate', '--change', CHANGE_PATH, '--ready=false');
    assert.equal(flagValue.status, 1);
    assert.equal(parseSingleJson(flagValue).error.code, 'INVALID_ARGUMENT');
    assert.match(parseSingleJson(flagValue).error.message, /--ready does not take a value/u);
  } finally {
    await cleanup(root);
  }
});

test('npm pack --dry-run --json lists the packaged change entrypoints', async () => {
  let pack;
  try {
    pack = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: REPO });
  } catch (error) {
    pack = error;
  }
  const records = JSON.parse(pack.stdout);
  assert.equal(records.length, 1);
  const paths = new Set(records[0].files.map((file) => file.path));
  assert.ok(paths.has('bin/tinysdd.mjs'), 'bin/tinysdd.mjs must be packaged');
  for (const dependency of ['src/change-format.mjs', 'src/slice-bundle.mjs']) {
    assert.ok(paths.has(dependency), `${dependency} must be packaged so change validate/export resolve after install`);
  }
  const helpSource = await readFile(join(REPO, 'src', 'cli-help.mjs'), 'utf8');
  for (const usageLine of ['change validate --change PATH', 'change export --change PATH']) {
    assert.ok(helpSource.includes(usageLine), `packaged CLI must advertise ${usageLine}`);
  }
  assert.ok(paths.has('src/cli-help.mjs'), 'src/cli-help.mjs must be packaged so help resolves after install');
});
