import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createApprovedPacketAnchor, compactDeterministically } from '../src/deterministic-compaction.mjs';
import {
  COMPACTION_ANCHOR_ENV,
  compactionIdentity,
  loadCompactionAnchor,
  normalizeCompactionProfile,
  piCompactionSettings,
  resolveCompactionSettings,
  writeCompactionBundle,
  writeCompactionAnchor,
} from '../src/compaction-runtime.mjs';
import { piRuntimePreflight } from '../src/pi-environment.mjs';
import { resolveConfig, validateConfigDocument } from '../src/config.mjs';
import { digestJson } from '../src/fs-utils.mjs';
import { buildMacosSandboxProfile } from '../src/macos-sandbox.mjs';
import { buildBubblewrapArgs, retainSessionArtifact } from '../src/worker.mjs';
import { buildSessionContext } from './pi100-session-projection.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'tinysdd-compaction-runtime-'));
const execFileAsync = promisify(execFile);

function fakePi() {
  const handlers = new Map();
  return { handlers, on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
}

test('profile compaction is opt-in and config validation retains the setting', () => {
  assert.deepEqual(normalizeCompactionProfile(undefined), { enabled: false });
  assert.throws(() => normalizeCompactionProfile({ compaction: null }), /must be an object/u);
  assert.deepEqual(normalizeCompactionProfile({ compaction: { enabled: true, reserveTokens: 512 } }), { enabled: true, reserveTokens: 512 });
  const enabled = validateConfigDocument({
    schemaVersion: 1,
    workers: {},
  });
  assert.deepEqual(enabled, { schemaVersion: 1, workers: {} });
});

test('project profile opt-in is resolved and changes the effective profile data', async () => {
  const root = await temp();
  try {
    await mkdir(join(root, '.tinysdd'), { recursive: true });
    await writeFile(join(root, '.tinysdd', 'config.json'), JSON.stringify({ schemaVersion: 1, defaultWorker: 'pi', workers: { pi: { type: 'pi', provider: 'p', model: 'm', profile: 'profile.json' } } }));
    await writeFile(join(root, 'profile.json'), JSON.stringify({ schemaVersion: 1, id: 'compact', runtime: { compaction: { enabled: true, reserveTokens: 512 } } }));
    const resolved = await resolveConfig(root);
    assert.deepEqual(resolved.profile.runtime.compaction, { enabled: true, reserveTokens: 512 });
    assert.notEqual(
      digestJson({ schemaVersion: 1, id: 'compact' }),
      digestJson({ schemaVersion: 1, id: 'compact', runtime: { compaction: { enabled: true, reserveTokens: 512 } } }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preflight derives a safe reserve and refuses a smaller configured reserve', () => {
  const implicit = piRuntimePreflight({ api: 'openai-completions', model: { id: 'm', maxTokens: 256 }, compaction: { enabled: true } });
  assert.deepEqual(implicit.errors, []);
  assert.deepEqual(implicit.compaction, { enabled: true, reserveTokens: 256, profile: { enabled: true } });
  assert.deepEqual(resolveCompactionSettings({ compaction: { enabled: true } }, 256), implicit.compaction);
  assert.deepEqual(piCompactionSettings(implicit.compaction), { enabled: true, reserveTokens: 256 });
  const refused = piRuntimePreflight({ api: 'openai-completions', model: { id: 'm', maxTokens: 256 }, compaction: { enabled: true, reserveTokens: 128 } });
  assert.match(refused.errors.join('\n'), /reserveTokens 128 must be at least effective maxTokens 256/u);
  assert.deepEqual(compactionIdentity({ enabled: false }), { enabled: false, mode: 'off', reserveTokens: null, keepRecentTokens: null, extensionVersion: null, anchorId: null, anchorSha256: null, anchorBytes: null });
});

test('anchor artifact is frozen, read-only and loaded by the Pi factory with no options', async () => {
  const root = await temp();
  const previous = process.env[COMPACTION_ANCHOR_ENV];
  try {
    const anchor = createApprovedPacketAnchor({ id: 'bundle-packet', text: '\ufeff approved\r\nKeep é exactly.\t\n' });
    const artifact = await writeCompactionAnchor(join(root, 'anchor.json'), anchor);
    assert.equal((await stat(artifact.path)).mode & 0o777, 0o400);
    const loaded = await loadCompactionAnchor(artifact.path);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(loaded.text, anchor.text);
    const bundle = await writeCompactionBundle(join(root, 'bundle'), anchor);
    process.env[COMPACTION_ANCHOR_ENV] = bundle.anchorPath;
    const extension = await import(`${pathToFileURL(bundle.entryPath).href}?factory-test=${Date.now()}`);
    const pi = fakePi();
    extension.default(pi);
    const response = await pi.handlers.get('session_before_compact')({
      preparation: {
        firstKeptEntryId: 'keep-1',
        tokensBefore: 10,
        messagesToSummarize: [{ role: 'user', content: 'old' }],
        turnPrefixMessages: [],
      },
      signal: new AbortController().signal,
    });
    assert.equal(response.cancel, undefined);
    assert.equal(response.compaction.summary.includes(anchor.text), true);
  } finally {
    if (previous === undefined) delete process.env[COMPACTION_ANCHOR_ENV];
    else process.env[COMPACTION_ANCHOR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('retained session file rebuild uses Pi 1.0 projection semantics and preserves packet bytes', async () => {
  const root = await temp();
  try {
    const packetText = '\ufeff packet\r\nconstraint: Keep é and spacing.\t\n';
    const anchor = createApprovedPacketAnchor({ id: 'retained-packet', text: packetText });
    const result = compactDeterministically({
      firstKeptEntryId: 'keep-1',
      tokensBefore: 99,
      messagesToSummarize: [{ role: 'user', content: 'approved packet source' }],
      turnPrefixMessages: [],
    }, { approvedPacketAnchor: anchor });
    const entries = [
      { type: 'session', version: 3, id: 'session-1', parentId: null },
      { type: 'message', id: 'old-1', parentId: null, message: { role: 'user', content: 'old' } },
      { type: 'message', id: 'keep-1', parentId: 'old-1', message: { role: 'assistant', content: [{ type: 'text', text: 'kept' }] } },
      { type: 'compaction', id: 'compact-1', parentId: 'keep-1', summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore, details: result.details, fromHook: true },
      { type: 'message', id: 'new-1', parentId: 'compact-1', message: { role: 'assistant', content: [{ type: 'text', text: 'new turn' }] } },
    ];
    const sessionPath = join(root, 'session.jsonl');
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const retained = (await readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const rebuilt = buildSessionContext(retained);
    const summary = rebuilt.messages.find((message) => message.role === 'compactionSummary');
    assert.ok(summary);
    assert.equal(Buffer.from(summary.summary, 'utf8').includes(Buffer.from(packetText, 'utf8')), true);
    assert.equal(rebuilt.messages.at(-1).content[0].text, 'new turn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained Pi session files preserve the anchor across ordinary, split and repeated compactions', async () => {
  const root = await temp();
  try {
    const packetText = '  HOST\r\né\té\n';
    let previousSummary;
    const entries = [
      { id: 'old', parentId: null, type: 'message', message: { role: 'user', content: 'old' } },
      { id: 'keep-1', parentId: 'old', type: 'message', message: { role: 'user', content: 'kept-1' } },
    ];
    const sessionPath = join(root, 'retained-session.jsonl');
    for (let index = 1; index <= 3; index += 1) {
      const preparation = {
        firstKeptEntryId: `keep-${index}`,
        tokensBefore: 99,
        messagesToSummarize: [{ role: 'user', content: `history-${index}` }],
        turnPrefixMessages: index === 2 ? [{ role: 'assistant', content: [{ type: 'text', text: 'split prefix' }] }] : [],
        isSplitTurn: index === 2,
        previousSummary,
      };
      const result = compactDeterministically(preparation, { approvedPacketAnchor: { id: 'retained', text: packetText } });
      assert.equal(result.cancel, undefined);
      entries.push({ id: `compact-${index}`, parentId: entries.at(-1).id, type: 'compaction', summary: result.summary, tokensBefore: result.tokensBefore, firstKeptEntryId: result.firstKeptEntryId, timestamp: '2026-10-04T10:00:00Z', fromHook: true, details: result.details });
      await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      const retained = (await readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const context = buildSessionContext(retained);
      const summaries = context.messages.filter((message) => message.role === 'compactionSummary');
      assert.equal(summaries.length, 1);
      assert.equal(Buffer.from(summaries[0].summary, 'utf8').includes(Buffer.from(packetText, 'utf8')), true);
      assert.equal(context.messages.some((message) => message.role === 'user' && message.content === `kept-${index}`), true);
      previousSummary = result.summary;
      entries.push({ id: `keep-${index + 1}`, parentId: entries.at(-1).id, type: 'message', message: { role: 'user', content: `kept-${index + 1}` } });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained session reader refuses FIFOs without blocking and bounds regular reads', { skip: process.platform === 'win32' }, async () => {
  const root = await temp();
  try {
    const fifo = join(root, 'session.pipe');
    await execFileAsync('mkfifo', [fifo]);
    const started = performance.now();
    const refused = await retainSessionArtifact(fifo, join(root, 'fifo.out'));
    assert.equal(refused.available, false);
    assert.equal(refused.reason, 'not_regular');
    assert.ok(performance.now() - started < 500);

    const regular = join(root, 'session.jsonl');
    await writeFile(regular, 'x'.repeat(512 * 1024));
    const retained = await retainSessionArtifact(regular, join(root, 'regular.out'));
    assert.equal(retained.available, true);
    assert.equal(retained.bytes, 512 * 1024);

    const oversized = join(root, 'oversized');
    const oversizedHandle = await open(oversized, 'wx');
    await oversizedHandle.truncate(17 * 1024 * 1024);
    await oversizedHandle.close();
    const refusedOversize = await retainSessionArtifact(oversized, join(root, 'oversized.out'));
    assert.equal(refusedOversize.available, false);
    assert.equal(refusedOversize.reason, 'oversize');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Seatbelt exposes the staged anchor to trusted extension code without granting it writes', () => {
  const profile = buildMacosSandboxProfile({
    workspace: '/private/tmp/candidate',
    stateDir: '/private/tmp/pi-state',
    sourceRoot: '/Users/operator/project',
    sourceAgentDir: '/Users/operator/.pi/agent',
    compactionBundle: '/private/tmp/compaction-bundle',
    nodeExecutable: '/opt/node/bin/node',
    piExecutable: '/opt/node/lib/node_modules/pi/dist/cli.js',
    piRoot: '/opt/node/lib/node_modules/pi',
    inferencePort: 54321,
  });
  assert.match(profile, /\(allow file-read\*[^\n]*\(subpath "\/private\/tmp\/compaction-bundle"\)/u);
  assert.doesNotMatch(profile, /file-write\*[^\n]*compaction-bundle/u);
});

test('bubblewrap mounts the compaction bundle with or without run_checks', () => {
  const bundle = { directory: '/private/tmp/compaction-bundle' };
  const common = { workspace: '/private/tmp/candidate', stateDir: '/private/tmp/pi-state', nodeRoot: '/opt/node', piArgs: [], piLexicalPath: '/opt/node/bin/pi', env: {} };
  const withoutChecks = buildBubblewrapArgs({ ...common, compactionBundle: bundle });
  const withChecks = buildBubblewrapArgs({
    ...common,
    checkChannel: { requests: '/private/tmp/requests', responses: '/private/tmp/responses', extension: '/private/tmp/run-checks.mjs' },
    compactionBundle: bundle,
  });
  for (const args of [withoutChecks, withChecks]) {
    const bundleIndex = args.indexOf('--ro-bind', args.indexOf('/opt/tinysdd/compaction'));
    assert.deepEqual(args.slice(bundleIndex, bundleIndex + 3), ['--ro-bind', bundle.directory, '/opt/tinysdd/compaction']);
    const anchorIndex = args.indexOf(COMPACTION_ANCHOR_ENV);
    assert.deepEqual(args.slice(anchorIndex - 1, anchorIndex + 2), ['--setenv', COMPACTION_ANCHOR_ENV, '/opt/tinysdd/compaction/anchor.json']);
  }
  assert.equal(withoutChecks.includes('/tinysdd/requests'), false);
  assert.equal(withChecks.includes('/tinysdd/requests'), true);
});
