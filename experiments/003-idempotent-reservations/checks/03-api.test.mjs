import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const rawCandidateDir = process.env.TINYSDD_CANDIDATE_DIR;
if (typeof rawCandidateDir !== 'string' || !isAbsolute(rawCandidateDir)) {
  throw new Error('TINYSDD_CANDIDATE_DIR must be an absolute path');
}
const candidateDir = resolve(rawCandidateDir);
const candidateInfo = await lstat(candidateDir);
if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
  throw new Error('TINYSDD_CANDIDATE_DIR must name a real directory');
}

const appPath = resolve(candidateDir, 'app.ts');
if (relative(candidateDir, appPath) !== 'app.ts') {
  throw new Error('app module escaped candidate directory');
}
const appInfo = await lstat(appPath);
if (appInfo.isSymbolicLink() || !appInfo.isFile()) {
  throw new Error('candidate app.ts must be a regular file');
}
const { createApp } = await import(pathToFileURL(appPath).href);
if (typeof createApp !== 'function') {
  throw new Error('candidate must export createApp');
}

function request(pathname, method = 'GET', body) {
  const init = { method };
  if (body !== undefined) init.body = body;
  return new Request(`http://stockroom.test${pathname}`, init);
}

async function assertJson(response, status, body) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/);
  assert.deepEqual(await response.json(), body);
}

function reservationBody(requestId, lines) {
  return JSON.stringify({ requestId, lines });
}

test('runs create, other request, replay, conflict, and GET stock flow', async () => {
  const app = createApp({ pen: 5, pad: 2 });

  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('r1', [{ itemId: 'pen', quantity: 2 }]))),
    201,
    { requestId: 'r1', stock: { pen: 3, pad: 2 } },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('r2', [{ itemId: 'pad', quantity: 1 }]))),
    201,
    { requestId: 'r2', stock: { pen: 3, pad: 1 } },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('r1', [{ itemId: 'pen', quantity: 2 }]))),
    200,
    { requestId: 'r1', stock: { pen: 3, pad: 2 } },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('r1', [{ itemId: 'pen', quantity: 1 }]))),
    409,
    { error: 'IDEMPOTENCY_CONFLICT' },
  );
  await assertJson(await app(request('/stock?view=current')), 200, {
    stock: { pen: 3, pad: 1 },
  });
  await assertJson(await app(request('/health?check=1')), 200, { ok: true });
});

test('maps invalid request to 400 without changing stock or binding its ID', async () => {
  const app = createApp({ pen: 5 });

  await assertJson(
    await app(request('/reservations', 'POST', JSON.stringify({ requestId: 'reuse', lines: [] }))),
    400,
    { error: 'INVALID_REQUEST' },
  );
  await assertJson(await app(request('/stock')), 200, { stock: { pen: 5 } });
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('reuse', [{ itemId: 'pen', quantity: 1 }]))),
    201,
    { requestId: 'reuse', stock: { pen: 4 } },
  );
});

test('maps malformed JSON to distinct 400 without changing stock or binding its ID', async () => {
  const app = createApp({ pen: 5 });

  await assertJson(await app(request('/reservations', 'POST', '{"requestId":"json"')), 400, {
    error: 'INVALID_JSON',
  });
  await assertJson(await app(request('/stock')), 200, { stock: { pen: 5 } });
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('json', [{ itemId: 'pen', quantity: 1 }]))),
    201,
    { requestId: 'json', stock: { pen: 4 } },
  );
});

test('maps unknown and insufficient business failures without binding their IDs', async () => {
  const app = createApp({ pen: 5 });

  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('unknown', [{ itemId: 'eraser', quantity: 1 }]))),
    409,
    { error: 'UNKNOWN_ITEM' },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('unknown', [{ itemId: 'pen', quantity: 1 }]))),
    201,
    { requestId: 'unknown', stock: { pen: 4 } },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('short', [{ itemId: 'pen', quantity: 6 }]))),
    409,
    { error: 'INSUFFICIENT_STOCK' },
  );
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('short', [{ itemId: 'pen', quantity: 1 }]))),
    201,
    { requestId: 'short', stock: { pen: 3 } },
  );
});

test('rejects duplicate-line overdraw atomically and allows the ID to be reused', async () => {
  const app = createApp({ pen: 5 });

  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('dup', [
      { itemId: 'pen', quantity: 3 },
      { itemId: 'pen', quantity: 3 },
    ]))),
    409,
    { error: 'INSUFFICIENT_STOCK' },
  );
  await assertJson(await app(request('/stock')), 200, { stock: { pen: 5 } });
  await assertJson(
    await app(request('/reservations', 'POST', reservationBody('dup', [{ itemId: 'pen', quantity: 2 }]))),
    201,
    { requestId: 'dup', stock: { pen: 3 } },
  );
});

test('overlapping same-ID requests produce one creation, one replay, and one debit', async () => {
  const app = createApp({ pen: 5 });
  const responses = await Promise.all([
    app(request('/reservations', 'POST', reservationBody('overlap', [{ itemId: 'pen', quantity: 2 }]))),
    app(request('/reservations', 'POST', reservationBody('overlap', [{ itemId: 'pen', quantity: 2 }]))),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 201]);
  for (const response of responses) {
    await assertJson(response, response.status, { requestId: 'overlap', stock: { pen: 3 } });
  }
  await assertJson(await app(request('/stock')), 200, { stock: { pen: 3 } });
});

test('preserves routes and query handling, and does not parse unsupported-route bodies', async () => {
  const app = createApp({ pen: 5 });

  await assertJson(await app(request('/health?check=1')), 200, { ok: true });
  await assertJson(await app(request('/stock?view=current')), 200, { stock: { pen: 5 } });
  await assertJson(await app(request('/missing?bad=json', 'POST', '{not-json')), 404, {
    error: 'NOT_FOUND',
  });
  await assertJson(await app(request('/health?bad=json', 'PUT', '{not-json')), 404, {
    error: 'NOT_FOUND',
  });
});

test('keeps app instances independent and replays property-order-insensitive JSON with extras ignored', async () => {
  const firstApp = createApp({ pen: 5 });
  const secondApp = createApp({ pen: 5 });
  const firstBody = JSON.stringify({
    lines: [{ quantity: 2, itemId: 'pen', extra: 'ignored' }],
    extra: 'ignored',
    requestId: 'independent',
  });
  const replayBody = JSON.stringify({
    requestId: 'independent',
    lines: [{ itemId: 'pen', quantity: 2 }],
    anotherExtra: true,
  });

  await assertJson(await firstApp(request('/reservations', 'POST', firstBody)), 201, {
    requestId: 'independent', stock: { pen: 3 },
  });
  await assertJson(await firstApp(request('/reservations', 'POST', replayBody)), 200, {
    requestId: 'independent', stock: { pen: 3 },
  });
  await assertJson(await secondApp(request('/reservations', 'POST', replayBody)), 201, {
    requestId: 'independent', stock: { pen: 3 },
  });
  await assertJson(await firstApp(request('/stock')), 200, { stock: { pen: 3 } });
  await assertJson(await secondApp(request('/stock')), 200, { stock: { pen: 3 } });
});
