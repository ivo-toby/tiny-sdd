import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
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
  const module = await import(pathToFileURL(modulePath).href);
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
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_TIMEOUT_MS = 30_000;

function generationInput(outputFilename = 'episode.mp3') {
  return {
    type: 'single',
    hosts: [{ name: 'Alex', voice: 'Charon' }],
    segments: [{ text: 'A short fixture script.' }],
    outputFilename,
  };
}

function generationResult(input) {
  return {
    success: true,
    outputPath: `/fixture/${input.outputFilename}`,
    durationSeconds: 12.5,
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = (value) => {
      if (settled) return;
      settled = true;
      resolveValue(value);
    };
    rejectPromise = (error) => {
      if (settled) return;
      settled = true;
      rejectValue(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() {
      return settled;
    },
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

async function withClient(mcpUrl, callback) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const client = new Client({ name: 'tinysdd-http-check', version: '1.0.0' });
  try {
    await bounded(client.connect(transport), 'MCP client connect');
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function callTool(harness, name, args, milliseconds = 4000) {
  return withClient(harness.mcpUrl, (client) => bounded(
    client.callTool({ name, arguments: args }),
    `${name} call`,
    milliseconds,
  ));
}

async function listTools(harness) {
  return withClient(harness.mcpUrl, (client) => bounded(
    client.listTools(),
    'tools/list call',
  ));
}

function parseDualJson(result) {
  assert.equal(result.content?.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  const textValue = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, textValue);
  return textValue;
}

function assertValidationError(result) {
  assert.equal(result.isError, true);
  assert.equal('structuredContent' in result, false);
  assert.equal(result.content?.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  assert.match(result.content[0].text, /Input validation error|Invalid arguments/);
}

function assertAccepted(result, operation) {
  const body = parseDualJson(result);
  assert.deepEqual(Object.keys(body).sort(), [
    'jobId',
    'message',
    'operation',
    'pollIntervalSeconds',
    'stage',
    'status',
  ]);
  assert.match(body.jobId, UUID_V4);
  assert.equal(body.operation, operation);
  assert.equal(body.status, 'queued');
  assert.equal(body.stage, 'queued');
  assert.equal(body.pollIntervalSeconds, 5);
  assert.equal(typeof body.message, 'string');
  assert.equal(body.message.length > 0, true);
  return body;
}

function assertNotFound(result) {
  assert.equal(result.isError, true);
  assert.deepEqual(parseDualJson(result), {
    errorCode: 'job_not_found',
    message: 'Job not found',
  });
}

function assertIsoTimestamp(value) {
  assert.equal(typeof value, 'string');
  assert.equal(Number.isNaN(Date.parse(value)), false);
  assert.equal(new Date(value).toISOString(), value);
}

async function getStatus(harness, jobId) {
  const result = await callTool(harness, 'get_job_status', { jobId });
  return { result, body: parseDualJson(result) };
}

async function waitFor(label, predicate, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`${label} did not become true within ${milliseconds}ms watchdog`);
}

async function waitForStatus(harness, jobId, status) {
  return waitFor(`${jobId} status ${status}`, async () => {
    const observed = await getStatus(harness, jobId);
    return observed.body.status === status ? observed : false;
  });
}

async function createHarness({ generate, publish, manager } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'tinysdd-podcast-http-'));
  const realManager = manager ?? createJobManager();
  let submitCalls = 0;
  let factoryCalls = 0;
  const jobs = {
    submit(operation, executor) {
      submitCalls += 1;
      return realManager.submit(operation, executor);
    },
    get(jobId) {
      return realManager.get(jobId);
    },
  };
  const generateFunction = generate ?? (async (input) => generationResult(input));
  const dependencies = {
    jobs,
    generate: generateFunction,
    publicUrl: PUBLIC_URL,
    ...(publish ? { publish } : {}),
  };
  try {
    const app = createApp({
      outputDir,
      createServer: () => {
        factoryCalls += 1;
        return createMcpServer(dependencies);
      },
    });
    const running = await listenApp(app);
    return {
      ...running,
      outputDir,
      jobs,
      manager: realManager,
      dependencies,
      get submitCalls() {
        return submitCalls;
      },
      get factoryCalls() {
        return factoryCalls;
      },
      async close() {
        await closeServer(running.server);
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeHarness(harness) {
  if (harness) await harness.close();
}

test('a deferred generation returns queued acceptance before execution resolves, with matching JSON payloads', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const gate = deferred();
  const calls = [];
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      return gate.promise.then(() => generationResult(input));
    },
  });
  try {
    const accepted = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('deferred.mp3'), 1500),
      'generate_podcast',
    );
    assert.equal(gate.settled, false);
    await waitFor('deferred executor invocation', () => calls.length === 1);
    assert.equal(gate.settled, false);
    assert.equal(accepted.jobId.length > 0, true);
  } finally {
    gate.resolve();
    await closeHarness(harness);
  }
});

test('completed checkpoint always exposes generation and status, but not combined generation/publishing', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const harness = await createHarness();
  try {
    const tools = await listTools(harness);
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'generate_podcast',
      'get_job_status',
    ]);
    assert.equal(tools.tools.some((tool) => tool.name === 'generate_and_publish'), false);
  } finally {
    await closeHarness(harness);
  }
});

test('schema-invalid generation never submits a job or invokes the generator', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const calls = [];
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      return Promise.resolve(generationResult(input));
    },
  });
  try {
    assertValidationError(await callTool(harness, 'generate_podcast', generationInput(''), 1500));
    assertValidationError(await callTool(
      harness,
      'generate_podcast',
      { ...generationInput('bad-type.mp3'), type: 'triple' },
      1500,
    ));
    assert.equal(harness.submitCalls, 0);
    assert.equal(calls.length, 0);
  } finally {
    await closeHarness(harness);
  }
});

test('two submissions use distinct UUID-v4 IDs, execute FIFO once, and polling is read-only', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const gateA = deferred();
  const gateB = deferred();
  const calls = [];
  const gates = new Map([
    ['queue-a.mp3', gateA],
    ['queue-b.mp3', gateB],
  ]);
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      return gates.get(input.outputFilename).promise.then(() => generationResult(input));
    },
  });
  try {
    const acceptedA = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('queue-a.mp3')),
      'generate_podcast',
    );
    const acceptedB = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('queue-b.mp3')),
      'generate_podcast',
    );
    assert.notEqual(acceptedA.jobId, acceptedB.jobId);
    await waitFor('first queued executor invocation', () => calls.length === 1);
    assert.equal(calls[0].outputFilename, 'queue-a.mp3');
    assert.equal(gateA.settled, false);
    assert.equal(gateB.settled, false);

    const runningA = await getStatus(harness, acceptedA.jobId);
    assert.equal(runningA.body.status, 'running');
    assert.equal(runningA.body.stage, 'generating');
    const queuedB = await getStatus(harness, acceptedB.jobId);
    assert.equal(queuedB.body.status, 'queued');
    assert.equal(queuedB.body.stage, 'queued');

    const countBeforePolls = calls.length;
    await getStatus(harness, acceptedA.jobId);
    await getStatus(harness, acceptedA.jobId);
    await getStatus(harness, acceptedB.jobId);
    assert.equal(calls.length, countBeforePolls);

    gateA.resolve();
    await waitFor('second queued executor invocation', () => calls.length === 2);
    assert.equal(calls[1].outputFilename, 'queue-b.mp3');
    const runningB = await getStatus(harness, acceptedB.jobId);
    assert.equal(runningB.body.status, 'running');
    assert.equal(runningB.body.stage, 'generating');

    gateB.resolve();
    await waitForStatus(harness, acceptedA.jobId, 'succeeded');
    await waitForStatus(harness, acceptedB.jobId, 'succeeded');
    const terminalCallCount = calls.length;
    await getStatus(harness, acceptedA.jobId);
    await getStatus(harness, acceptedB.jobId);
    assert.equal(calls.length, terminalCallCount);
    assert.equal(calls.length, 2);
    assert.equal(harness.submitCalls, 2);
  } finally {
    gateA.resolve();
    gateB.resolve();
    await closeHarness(harness);
  }
});

test('separate HTTP status requests observe running then exact terminal output with stable timestamps', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const gate = deferred();
  const calls = [];
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      return gate.promise.then(() => generationResult(input));
    },
  });
  try {
    const accepted = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('exact-output.mp3')),
      'generate_podcast',
    );
    await waitFor('exact-output executor invocation', () => calls.length === 1);
    const running = await getStatus(harness, accepted.jobId);
    assert.equal(running.body.jobId, accepted.jobId);
    assert.equal(running.body.operation, 'generate_podcast');
    assert.equal(running.body.status, 'running');
    assert.equal(running.body.stage, 'generating');
    assertIsoTimestamp(running.body.createdAt);
    assertIsoTimestamp(running.body.updatedAt);
    assertIsoTimestamp(running.body.startedAt);
    assert.equal(running.body.completedAt, undefined);
    assert.equal(running.body.result, undefined);
    assert.equal(running.body.error, undefined);

    gate.resolve();
    const terminal = await waitForStatus(harness, accepted.jobId, 'succeeded');
    assert.deepEqual(terminal.body.result, {
      success: true,
      outputPath: '/fixture/exact-output.mp3',
      durationSeconds: 12.5,
      downloadUrl: `${PUBLIC_URL}/output/exact-output.mp3`,
    });
    assert.equal(terminal.body.status, 'succeeded');
    assert.equal(terminal.body.stage, 'completed');
    assertIsoTimestamp(terminal.body.createdAt);
    assertIsoTimestamp(terminal.body.updatedAt);
    assertIsoTimestamp(terminal.body.startedAt);
    assertIsoTimestamp(terminal.body.completedAt);

    const repeated = await getStatus(harness, accepted.jobId);
    assert.deepEqual(repeated.body, terminal.body);
    assert.equal(calls.length, 1);
    assert.equal(harness.factoryCalls >= 6, true);
  } finally {
    gate.resolve();
    await closeHarness(harness);
  }
});

test('failed execution stores a safe error, continues to the next queued job, and emits no unhandled rejection', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const gateB = deferred();
  const calls = [];
  let unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      if (input.outputFilename === 'failure.mp3') {
        throw new Error('secret executor details must not escape');
      }
      return gateB.promise.then(() => generationResult(input));
    },
  });
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const failedAccepted = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('failure.mp3')),
      'generate_podcast',
    );
    const nextAccepted = assertAccepted(
      await callTool(harness, 'generate_podcast', generationInput('after-failure.mp3')),
      'generate_podcast',
    );
    const failed = await waitForStatus(harness, failedAccepted.jobId, 'failed');
    assert.equal(failed.body.status, 'failed');
    assert.equal(failed.body.stage, 'failed');
    assert.deepEqual(failed.body.error, {
      code: 'job_execution_failed',
      message: 'Job execution failed',
    });
    assert.equal(failed.body.result, undefined);

    await waitFor('next job starts after failure', () => calls.length === 2);
    assert.equal(calls[1].outputFilename, 'after-failure.mp3');
    const nextRunning = await getStatus(harness, nextAccepted.jobId);
    assert.equal(nextRunning.body.status, 'running');
    gateB.resolve();
    const nextSucceeded = await waitForStatus(harness, nextAccepted.jobId, 'succeeded');
    assert.deepEqual(nextSucceeded.body.result, {
      success: true,
      outputPath: '/fixture/after-failure.mp3',
      durationSeconds: 12.5,
      downloadUrl: `${PUBLIC_URL}/output/after-failure.mp3`,
    });

    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  } finally {
    gateB.resolve();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    process.off('unhandledRejection', onUnhandledRejection);
    await closeHarness(harness);
  }
  assert.deepEqual(unhandled, []);
});

test('unknown, malformed, and missing job IDs follow distinct status contracts without creating work', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const calls = [];
  const harness = await createHarness({
    generate(input) {
      calls.push(input);
      return Promise.resolve(generationResult(input));
    },
  });
  try {
    const unknown = await callTool(harness, 'get_job_status', { jobId: crypto.randomUUID() });
    assertNotFound(unknown);
    assertValidationError(await callTool(harness, 'get_job_status', { jobId: 'not-a-uuid' }));
    assertValidationError(await callTool(harness, 'get_job_status', {}));
    assert.equal(harness.submitCalls, 0);
    assert.equal(calls.length, 0);
  } finally {
    await closeHarness(harness);
  }
});

test('fresh stateless request servers share one manager, while a separate app manager cannot see the job', { timeout: CHECK_TIMEOUT_MS }, async () => {
  const gate = deferred();
  const calls = [];
  let first;
  let second;
  try {
    first = await createHarness({
      generate(input) {
        calls.push(input);
        return gate.promise.then(() => generationResult(input));
      },
    });
    second = await createHarness({
      generate(input) {
        return Promise.resolve(generationResult(input));
      },
    });
    const accepted = assertAccepted(
      await callTool(first, 'generate_podcast', generationInput('isolated.mp3')),
      'generate_podcast',
    );
    await waitFor('isolated executor invocation', () => calls.length === 1);

    const sameAppStatus = await getStatus(first, accepted.jobId);
    assert.equal(sameAppStatus.body.jobId, accepted.jobId);
    assert.equal(sameAppStatus.body.status, 'running');

    const separateAppStatus = await callTool(second, 'get_job_status', { jobId: accepted.jobId });
    assertNotFound(separateAppStatus);
    assert.equal(first.factoryCalls >= 4, true);
    assert.equal(second.factoryCalls >= 2, true);
  } finally {
    gate.resolve();
    await closeHarness(first);
    await closeHarness(second);
  }
});
