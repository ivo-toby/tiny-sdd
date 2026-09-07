import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const rawCandidateDir = process.env.TINYSDD_CANDIDATE_DIR;
if (typeof rawCandidateDir !== 'string' || !isAbsolute(rawCandidateDir)) {
  throw new Error('TINYSDD_CANDIDATE_DIR must be an absolute path to compiled candidate modules');
}

const candidateDir = resolve(rawCandidateDir);
const candidateInfo = await lstat(candidateDir);
if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
  throw new Error('TINYSDD_CANDIDATE_DIR must name a real compiled candidate directory');
}

async function importCandidateModule(relativePath, requiredExports) {
  const modulePath = resolve(candidateDir, relativePath);
  if (relative(candidateDir, modulePath) !== relativePath) {
    throw new Error(`candidate module escaped candidate directory: ${relativePath}`);
  }
  const moduleInfo = await lstat(modulePath);
  if (moduleInfo.isSymbolicLink() || !moduleInfo.isFile()) {
    throw new Error(`candidate module must be a regular file: ${relativePath}`);
  }
  const moduleUrl = pathToFileURL(modulePath).href;
  const module = await import(moduleUrl);
  for (const exportName of requiredExports) {
    if (typeof module[exportName] !== 'function') {
      throw new Error(`${relativePath} must export ${exportName}`);
    }
  }
  return module;
}

const { createApp } = await importCandidateModule('server/create-app.js', ['createApp']);
const { createMcpServer } = await importCandidateModule('server/create-mcp-server.js', ['createMcpServer']);
const { createJobManager } = await importCandidateModule('jobs/job-manager.js', ['createJobManager']);

const PUBLIC_URL = 'http://podcast-public.example.test';
const CHECK_TIMEOUT_MS = 30_000;

function generationInput(outputFilename = 'episode.mp3') {
  return {
    type: 'single',
    hosts: [{ name: 'Alex', voice: 'Charon' }],
    segments: [{ text: 'A short fixture script.' }],
    outputFilename,
  };
}

function publishInput(outputFilename = 'episode.mp3') {
  return {
    outputFilename,
    episodeTitle: 'Fixture episode',
    episodeDescription: 'A fixture description.',
  };
}

function createServerDependencies({ publish } = {}) {
  const jobs = createJobManager();
  const generate = async (input) => ({
    success: true,
    outputPath: `/fixture/${input.outputFilename}`,
    durationSeconds: 12.5,
  });
  return {
    jobs,
    generate,
    publicUrl: PUBLIC_URL,
    ...(publish ? { publish } : {}),
  };
}

async function listenApp(app) {
  const server = createHttpServer(app);
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('ephemeral HTTP server did not expose a numeric address');
  }
  return {
    server,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function withClient(mcpUrl, callback) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const client = new Client({ name: 'tinysdd-factory-check', version: '1.0.0' });
  try {
    await bounded(client.connect(transport), 'MCP client connect');
    return await bounded(callback(client), 'MCP factory check');
  } finally {
    await bounded(client.close(), 'MCP client close').catch(() => {});
    await bounded(transport.close(), 'MCP transport close').catch(() => {});
  }
}

async function bounded(promise, label, milliseconds = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms watchdog`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function httpFetch(url, init, label) {
  return bounded(fetch(url, init), `${label} HTTP request`);
}

async function callTool(mcpUrl, name, args) {
  return withClient(mcpUrl, (client) => client.callTool({ name, arguments: args }));
}

function assertTextOnly(result, expected, { isError = false } = {}) {
  assert.equal(result.content?.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  assert.equal('structuredContent' in result, false);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  if (isError) assert.equal(result.isError, true);
  else assert.notEqual(result.isError, true);
}

async function newApp({ outputDir, publish } = {}) {
  const dependencies = createServerDependencies({ publish });
  const app = createApp({
    outputDir,
    createServer: () => createMcpServer(dependencies),
  });
  return { ...await listenApp(app), dependencies };
}

test('factory app preserves health, private static output, malformed JSON, oversized JSON, and GET /mcp 405', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'tinysdd-podcast-factory-'));
  let running;
  try {
    await writeFile(join(outputDir, 'fixture.bin'), Buffer.from('private-fixture-bytes'));
    running = await newApp({ outputDir });

    const healthResponse = await httpFetch(
      `${running.mcpUrl.replace(/\/mcp$/, '')}/health`,
      undefined,
      'health',
    );
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      status: 'ok',
      service: 'mcp-podcast-generator',
      version: '1.0.0',
    });

    const staticResponse = await httpFetch(
      `${running.mcpUrl.replace(/\/mcp$/, '')}/output/fixture.bin`,
      undefined,
      'static fixture',
    );
    assert.equal(staticResponse.status, 200);
    assert.deepEqual(Buffer.from(await staticResponse.arrayBuffer()), Buffer.from('private-fixture-bytes'));

    const malformedResponse = await httpFetch(running.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0",',
    }, 'malformed JSON');
    assert.equal(malformedResponse.status, 400);
    const malformedBody = await malformedResponse.json();
    assert.equal(malformedBody.error, 'Invalid JSON body');

    const oversizedBody = JSON.stringify({ oversized: 'x'.repeat(10 * 1024 * 1024) });
    const oversizedResponse = await httpFetch(running.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedBody,
    }, 'oversized JSON');
    assert.equal(oversizedResponse.status, 413);
    const oversizedResult = await oversizedResponse.json();
    assert.equal(oversizedResult.error, 'Request body too large (limit: 10mb)');

    const getResponse = await httpFetch(running.mcpUrl, undefined, 'GET /mcp');
    assert.equal(getResponse.status, 405);
    assert.deepEqual(await getResponse.json(), {
      error: 'Method Not Allowed',
      message: 'MCP endpoint requires POST with JSON-RPC body. See README for usage.',
    });
  } finally {
    if (running) await closeServer(running.server);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('publish registration remains conditional and its success/error responses stay text-only', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'tinysdd-podcast-publish-'));
  const servers = [];
  try {
    const absent = await newApp({ outputDir });
    servers.push(absent);
    const absentTools = await withClient(absent.mcpUrl, (client) => client.listTools());
    assert.equal(absentTools.tools.some((tool) => tool.name === 'generate_podcast'), true);
    assert.equal(absentTools.tools.some((tool) => tool.name === 'publish_podcast'), false);

    const publishResult = {
      success: true,
      marker: 'factory-publish-success',
    };
    const success = await newApp({
      outputDir,
      publish: async () => publishResult,
    });
    servers.push(success);
    const successResult = await callTool(success.mcpUrl, 'publish_podcast', publishInput());
    assertTextOnly(successResult, publishResult);

    const failure = await newApp({
      outputDir,
      publish: async () => {
        throw new Error('factory-publish-sentinel');
      },
    });
    servers.push(failure);
    const failureResult = await callTool(failure.mcpUrl, 'publish_podcast', publishInput('failure.mp3'));
    assertTextOnly(failureResult, {
      success: false,
      error: 'factory-publish-sentinel',
    }, { isError: true });
  } finally {
    for (const running of servers) await closeServer(running.server);
    await rm(outputDir, { recursive: true, force: true });
  }
});
