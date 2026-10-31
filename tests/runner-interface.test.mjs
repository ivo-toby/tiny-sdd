import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigDocument } from '../src/config.mjs';
import { buildMacosSandboxProfile } from '../src/macos-sandbox.mjs';
import { preflightPiWorker, preparePiEnvironment, validatePiWorker } from '../src/pi-environment.mjs';
import { WORKER_TYPES, registeredRunners, workerRunner } from '../src/runners/index.mjs';
import { piBubblewrapInvocation, piRunner, piSeatbeltInvocation } from '../src/runners/pi.mjs';
import { openCodeRunner } from '../src/runners/opencode.mjs';
import { buildBubblewrapArgs, runWorker } from '../src/worker.mjs';

// Captured from buildBubblewrapArgs and buildMacosSandboxProfile on main before
// the runner interface existed; the wrappers must still produce these bytes.
const MAIN_BUBBLEWRAP_ARGS = ["--die-with-parent","--unshare-user","--unshare-pid","--unshare-net","--dev","/dev","--tmpfs","/tmp","--tmpfs","/home","--dir","/etc","--ro-bind","/usr","/usr","--ro-bind","/bin","/bin","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64","--ro-bind-try","/etc/localtime","/etc/localtime","--dir","/opt","--ro-bind","/opt/pi-node","/opt/node","--dir","/work","--bind","/tmp/candidate","/work","--dir","/pi-state","--bind","/tmp/state","/pi-state","--chdir","/work","--dir","/opt/tinysdd","--ro-bind","/tmp/f.mjs","/opt/tinysdd/inference-forward.mjs","--ro-bind","/tmp/sock","/opt/tinysdd/inference","--dir","/tinysdd","--bind","/tmp/req","/tinysdd/requests","--ro-bind","/tmp/res","/tinysdd/responses","--ro-bind","/tmp/run-checks.mjs","/opt/tinysdd/run-checks.mjs","--dir","/opt/tinysdd/compaction","--ro-bind","/tmp/bundle","/opt/tinysdd/compaction","--setenv","HOME","/home","--setenv","PI_CODING_AGENT_DIR","/pi-state","--setenv","PATH","/opt/node/bin:/usr/bin:/bin","--setenv","TINYSDD_COMPACTION_ANCHOR","/opt/tinysdd/compaction/anchor.json","/opt/node/bin/node","/opt/tinysdd/inference-forward.mjs","41434","/opt/tinysdd/inference/relay.sock","/opt/node/bin/pi","--offline","@/pi-state/task-prompt.txt"];
const MAIN_SEATBELT_PROFILE = "(version 1)\n(deny default)\n(allow process-exec (literal \"/opt/node/bin/node\"))\n(allow sysctl-read (sysctl-name-prefix \"hw.\") (sysctl-name \"kern.ostype\") (sysctl-name \"kern.osrelease\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.hostname\") (sysctl-name \"kern.version\"))\n(allow file-read-metadata (literal \"/System\") (literal \"/usr\") (literal \"/opt/node/lib/node_modules\") (literal \"/opt/node/lib\") (literal \"/opt/node\") (literal \"/opt\") (literal \"/private/tmp\") (literal \"/private\") (literal \"/opt/node/bin\"))\n(allow file-read* (subpath \"/System/Library\") (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/opt/node/lib/node_modules/pi\") (subpath \"/private/tmp/bundle\") (literal \"/\") (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\") (literal \"/private/etc/hosts\") (literal \"/private/etc/localtime\") (literal \"/opt/node/bin/node\"))\n(allow file-read* file-write* (subpath \"/private/tmp/candidate\"))\n(allow file-read* file-write* (subpath \"/private/tmp/pi-state\"))\n(deny file-write-unlink (literal \"/private/tmp/candidate\"))\n(deny file-write-unlink (literal \"/private/tmp/pi-state\"))\n(deny file-read* file-write* (subpath \"/Users/operator/project\") (subpath \"/Users/operator/.pi/agent\"))\n(allow network-outbound (remote ip \"localhost:54321\"))\n";

test('the registry maps worker.type "pi" and "opencode" to their runners and nothing else', () => {
  assert.deepEqual(WORKER_TYPES, ['pi', 'opencode']);
  assert.deepEqual(registeredRunners().map((runner) => runner.type), WORKER_TYPES);
  assert.equal(workerRunner('pi'), piRunner);
  assert.equal(workerRunner('opencode'), openCodeRunner);
  for (const type of ['other', 'constructor', '__proto__', '', undefined, null]) assert.equal(workerRunner(type), null);
});

test('the Pi runner exposes the existing Pi functions unchanged', () => {
  for (const name of ['validateWorker', 'preflight', 'executableCandidate', 'identify', 'prepareEnvironment', 'sessionHostPath', 'buildInvocation', 'inferenceTarget', 'routeInference', 'responseTokenLimit', 'parseEvents']) {
    assert.equal(typeof piRunner[name], 'function', name);
  }
  assert.equal(piRunner.validateWorker, validatePiWorker);
  assert.equal(piRunner.preflight, preflightPiWorker);
  assert.equal(piRunner.prepareEnvironment, preparePiEnvironment);
  assert.ok(Object.isFrozen(piRunner));
});

test('an unknown worker.type stays UNSUPPORTED_WORKER with the same message', () => {
  assert.throws(
    () => validateConfigDocument({ schemaVersion: 1, workers: { local: { type: 'unregistered', provider: 'p', model: 'm' } } }),
    (error) => error.code === 'UNSUPPORTED_WORKER' && error.message === 'config.workers.local.type must be "pi" or "opencode"',
  );
});

test('runWorker refuses an unregistered worker.type before touching the project', async () => {
  await assert.rejects(
    runWorker({ projectRoot: process.cwd(), packet: { schemaVersion: 1, taskId: 'task', briefText: 'x', allowedPaths: ['a.txt'] }, worker: { type: 'unregistered', provider: 'p', model: 'm' } }),
    (error) => error.name === 'WorkerError' && error.code === 'UNSUPPORTED_WORKER' && error.message === 'Unsupported worker adapter: unregistered',
  );
});

test('bubblewrap wraps the Pi invocation into the same argv as before the interface', () => {
  const args = buildBubblewrapArgs({
    workspace: '/tmp/candidate',
    invocation: piBubblewrapInvocation({ nodeRoot: '/opt/pi-node', stateDir: '/tmp/state', args: ['--offline', '@/pi-state/task-prompt.txt'] }),
    checkChannel: { requests: '/tmp/req', responses: '/tmp/res', extension: '/tmp/run-checks.mjs' },
    compactionBundle: { directory: '/tmp/bundle' },
    inference: { forwarder: '/tmp/f.mjs', socketDir: '/tmp/sock', socketName: 'relay.sock', port: 41434 },
  });
  assert.deepEqual(args, MAIN_BUBBLEWRAP_ARGS);
});

test('Seatbelt wraps the Pi invocation into the same profile as before the interface', () => {
  const profile = buildMacosSandboxProfile({
    workspace: '/private/tmp/candidate',
    sourceRoot: '/Users/operator/project',
    compactionBundle: '/private/tmp/bundle',
    inferencePort: 54321,
    invocation: piSeatbeltInvocation({
      stateDir: '/private/tmp/pi-state',
      sourceAgentDir: '/Users/operator/.pi/agent',
      nodeExecutable: '/opt/node/bin/node',
      piExecutable: '/opt/node/lib/node_modules/pi/dist/cli.js',
      piRoot: '/opt/node/lib/node_modules/pi',
    }),
  });
  assert.equal(profile, MAIN_SEATBELT_PROFILE);
});

test('the Pi event parser yields the normalized run record captureProcess enforces limits from', () => {
  const events = [
    { type: 'tool_execution_start', toolName: 'read', args: { path: '/work/src/a.txt' } },
    { type: 'tool_execution_start', toolName: 'edit', args: { path: '/work/src/a.txt' } },
    { type: 'tool_execution_start', toolName: 'run_checks', args: {} },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 2, totalTokens: 12 }, content: [{ type: 'text', text: 'done' }] } },
  ].map((event) => JSON.stringify(event)).join('\n');
  const parsed = piRunner.parseEvents(`${events}\nnot json\n`);
  assert.equal(parsed.toolCalls, 3);
  assert.equal(parsed.writeCalls, 1);
  assert.deepEqual(parsed.toolCallsByName, { read: 1, edit: 1, run_checks: 1 });
  assert.deepEqual(parsed.readPaths, ['/work/src/a.txt']);
  assert.equal(parsed.stopReason, 'stop');
  assert.equal(parsed.claims, 'done');
  assert.deepEqual(parsed.cumulativeUsage, { assistantMessages: 1, input: 10, output: 2, reasoning: null, totalTokens: 12 });
});

test('the Pi runner keeps its executable defaults and response token limit source', () => {
  assert.deepEqual(piRunner.executableCandidate({ runtime: { piExecutable: '/x/pi' }, test: true }), { path: '/x/pi', label: 'test Pi executable' });
  assert.equal(piRunner.executableCandidate({ runtime: { piExecutable: '' }, test: false, platform: 'linux' }).label, 'Pi executable');
  assert.notEqual(piRunner.executableCandidate({ runtime: { piExecutable: '' }, test: false, platform: 'linux' }).path, '');
  assert.equal(piRunner.executableCandidate({ runtime: { piExecutable: '' }, test: false, platform: 'darwin' }).path, '');
  assert.deepEqual(piRunner.responseTokenLimit({ maxTokens: null }), { maxTokens: 16384, maxTokensSource: 'pi-default' });
  assert.deepEqual(piRunner.responseTokenLimit({ maxTokens: 512 }), { maxTokens: 512, maxTokensSource: 'model' });
});

test('the Pi runner reads the tool loadout Pi 1.4.0 announces before the first turn (#197)', () => {
  // Shape observed from a real Pi 1.4.0 --mode json run: system message_start/message_end carry toolsAdded.
  const system = { role: 'system', content: '', sections: {}, toolsAdded: [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }, { name: 'edit', description: 'e' }] };
  const stream = [
    { type: 'session', version: 3, id: 's' },
    { type: 'message_start', message: system },
    { type: 'message_end', message: system },
    { type: 'message_end', message: { role: 'system', toolsAdded: [{ name: 'run_checks' }] } },
  ].map((event) => JSON.stringify(event)).join('\n');
  assert.deepEqual(piRunner.parseEvents(stream).toolLoadout, ['read', 'write', 'edit']);
  assert.equal(piRunner.parseEvents('{"type":"session"}\n').toolLoadout, null);
});
