import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startInferenceForwarder } from '../src/inference-forward.mjs';
import { startInferenceRelay } from '../src/inference-relay.mjs';

const LAUNCHER = fileURLToPath(new URL('../src/inference-forward.mjs', import.meta.url));

async function scratch() {
  return mkdtemp(join(await realpath(tmpdir()), 'tinysdd-forward-test-'));
}

// Answers each connection after the client half-closes, like a relay that
// reads the whole request before responding.
async function unixReplyServer(socketPath) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => socket.end(`reply:${text}`));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return server;
}

function exchange(port, message) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    let text = '';
    socket.on('connect', () => socket.end(message));
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runLauncher(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('the forwarder pipes loopback TCP connections to the relay socket, half-close included', async () => {
  const root = await scratch();
  const server = await unixReplyServer(join(root, 'relay.sock'));
  const forwarder = await startInferenceForwarder({ port: 0, socketPath: join(root, 'relay.sock') });
  try {
    assert.equal(await exchange(forwarder.port, 'first'), 'reply:first');
    assert.equal(await exchange(forwarder.port, 'second'), 'reply:second');
  } finally {
    await forwarder.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('the forwarder drops a connection when the relay socket is unavailable', async () => {
  const root = await scratch();
  const forwarder = await startInferenceForwarder({ port: 0, socketPath: join(root, 'missing.sock') });
  try {
    // Reset or clean close are both fine; no data may arrive.
    const text = await exchange(forwarder.port, 'lost').catch((error) => (error.code === 'ECONNRESET' ? '' : Promise.reject(error)));
    assert.equal(text, '');
  } finally {
    await forwarder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the launcher starts the forwarder before Pi and passes Pi stdout and exit status through', async () => {
  const root = await scratch();
  const socketPath = join(root, 'relay.sock');
  const server = await unixReplyServer(socketPath);
  try {
    const port = await freePort();
    const pi = join(root, 'pi.mjs');
    await writeFile(pi, `import { connect } from 'node:net';
const socket = connect({ port: ${port}, host: '127.0.0.1', allowHalfOpen: true });
let text = '';
socket.on('connect', () => socket.end('from-pi'));
socket.on('data', (chunk) => { text += chunk; });
socket.on('close', () => { console.log(JSON.stringify({ type: 'probe', text, argv: process.argv.slice(2) })); process.exit(7); });
`);
    const result = await runLauncher([String(port), socketPath, process.execPath, pi, '--mode', 'json']);
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), { type: 'probe', text: 'reply:from-pi', argv: ['--mode', 'json'] });
    assert.equal(result.stderr, '');

    await writeFile(pi, "process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n");
    const killed = await runLauncher([String(port), socketPath, process.execPath, pi]);
    assert.equal(killed.signal, 'SIGTERM');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('the launcher refuses malformed arguments without starting Pi', async () => {
  const root = await scratch();
  try {
    const marker = join(root, 'started');
    const pi = join(root, 'pi.mjs');
    await writeFile(pi, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`);
    for (const args of [['0', '/relay.sock', process.execPath, pi], ['80x', '/relay.sock', process.execPath, pi], ['41434', 'relay.sock', process.execPath, pi], ['41434', '/relay.sock', 'node', pi]]) {
      const result = await runLauncher(args);
      assert.equal(result.code, 125, args.join(' '));
      assert.match(result.stderr, /tinysdd inference launcher: invalid/u);
    }
    await assert.rejects(realpath(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the relay can listen on a Unix socket only, keeping credentials on the host', async () => {
  const root = await scratch();
  const calls = [];
  const upstream = createHttpServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const model = { id: 'exact-model' };
  const provider = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: '$TINYSDD_PI_SECRET_0', models: [model] };
  const socketPath = join(root, 'relay.sock');
  const relay = await startInferenceRelay({ provider, model, env: { TINYSDD_PI_SECRET_0: 'synthetic-key' }, sourceEnv: {}, socketPath });
  const post = (authorization) => new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/chat/completions', method: 'POST', headers: { authorization } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'exact-model', messages: [] }));
  });
  try {
    assert.equal(relay.socketPath, socketPath);
    assert.equal(relay.port, undefined);
    assert.equal(relay.baseUrl, undefined);
    assert.equal((await post('Bearer wrong')).status, 401);
    assert.deepEqual(await post(`Bearer ${relay.token}`), { status: 200, text: '{"ok":true}' });
    assert.deepEqual(calls, [{ url: '/v1/chat/completions', authorization: 'Bearer synthetic-key' }]);
  } finally {
    await relay.close();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('the relay refuses an unsupported API and names it', async () => {
  const model = { id: 'exact-model' };
  await assert.rejects(
    startInferenceRelay({ provider: { api: 'anthropic-messages', baseUrl: 'https://inference.example/v1', models: [model] }, model, env: {}, sourceEnv: {}, socketPath: '/nonexistent/relay.sock' }),
    /require the openai-completions inference API; the selected model uses "anthropic-messages"/u,
  );
});
