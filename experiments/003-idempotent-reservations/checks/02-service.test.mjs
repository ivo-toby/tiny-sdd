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

const serviceOverride = process.env.TINYSDD_SERVICE_MODULE;
const rawServicePath = serviceOverride ?? resolve(candidateDir, 'service.ts');
if (typeof rawServicePath !== 'string' || !isAbsolute(rawServicePath)) {
  throw new Error('TINYSDD_SERVICE_MODULE must be an absolute path');
}
const servicePath = resolve(rawServicePath);
if (serviceOverride === undefined && relative(candidateDir, servicePath) !== 'service.ts') {
  throw new Error('service module escaped candidate directory');
}
const serviceInfo = await lstat(servicePath);
if (serviceInfo.isSymbolicLink() || !serviceInfo.isFile()) {
  throw new Error('candidate service module must be a regular file');
}
const { createReservationService } = await import(pathToFileURL(servicePath).href);
if (typeof createReservationService !== 'function') {
  throw new Error('candidate must export createReservationService');
}

function command(requestId, lines) {
  return { requestId, lines: lines.map(({ itemId, quantity }) => ({ itemId, quantity })) };
}

function assertResult(result, status, body) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
}

function attemptMutation(callback) {
  try {
    callback();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}

test('creates a reservation, updates current stock, and preserves caller inputs', () => {
  const initial = { pen: 5, pad: 2 };
  const request = command('r1', [{ itemId: 'pen', quantity: 2 }]);
  const service = createReservationService(initial);

  const result = service.reserve(request);

  assertResult(result, 201, { requestId: 'r1', stock: { pen: 3, pad: 2 } });
  assert.deepEqual(initial, { pen: 5, pad: 2 });
  assert.deepEqual(request, command('r1', [{ itemId: 'pen', quantity: 2 }]));
  assert.deepEqual(service.getStock(), { pen: 3, pad: 2 });
  assert.equal(typeof result.then, 'undefined');
});

test('applies duplicate lines in order and rolls back a failing batch atomically', () => {
  const service = createReservationService({ pen: 5 });

  assertResult(
    service.reserve(command('dup', [
      { itemId: 'pen', quantity: 3 },
      { itemId: 'pen', quantity: 3 },
    ])),
    409,
    { error: 'INSUFFICIENT_STOCK' },
  );
  assert.deepEqual(service.getStock(), { pen: 5 });

  assertResult(
    service.reserve(command('dup', [
      { itemId: 'pen', quantity: 2 },
      { itemId: 'pen', quantity: 3 },
    ])),
    201,
    { requestId: 'dup', stock: { pen: 0 } },
  );
});

test('does not bind unknown or insufficient requests and permits valid ID reuse', () => {
  for (const [requestId, failedLines, error] of [
    ['unknown', [{ itemId: 'eraser', quantity: 1 }], 'UNKNOWN_ITEM'],
    ['short', [{ itemId: 'pen', quantity: 6 }], 'INSUFFICIENT_STOCK'],
  ]) {
    const service = createReservationService({ pen: 5 });
    assertResult(service.reserve(command(requestId, failedLines)), 409, { error });
    assert.deepEqual(service.getStock(), { pen: 5 });
    assertResult(
      service.reserve(command(requestId, [{ itemId: 'pen', quantity: 1 }])),
      201,
      { requestId, stock: { pen: 4 } },
    );
  }
});

test('replays the original success after another request changes current stock', () => {
  const service = createReservationService({ pen: 5, pad: 2 });
  const first = service.reserve(command('r1', [{ itemId: 'pen', quantity: 2 }]));
  assertResult(first, 201, { requestId: 'r1', stock: { pen: 3, pad: 2 } });
  assertResult(
    service.reserve(command('r2', [{ itemId: 'pad', quantity: 1 }])),
    201,
    { requestId: 'r2', stock: { pen: 3, pad: 1 } },
  );

  assertResult(
    service.reserve({ requestId: 'r1', lines: [{ quantity: 2, itemId: 'pen' }] }),
    200,
    { requestId: 'r1', stock: { pen: 3, pad: 2 } },
  );
  assert.deepEqual(service.getStock(), { pen: 3, pad: 1 });
});

test('rejects changed, reordered, and split line sequences without changing state', () => {
  const service = createReservationService({ pen: 10, pad: 5 });
  const original = command('same', [
    { itemId: 'pen', quantity: 2 },
    { itemId: 'pad', quantity: 1 },
  ]);
  assertResult(service.reserve(original), 201, { requestId: 'same', stock: { pen: 8, pad: 4 } });

  for (const lines of [
    [{ itemId: 'pen', quantity: 3 }, { itemId: 'pad', quantity: 1 }],
    [{ itemId: 'pad', quantity: 1 }, { itemId: 'pen', quantity: 2 }],
    [{ itemId: 'pen', quantity: 1 }, { itemId: 'pen', quantity: 1 }, { itemId: 'pad', quantity: 1 }],
  ]) {
    assertResult(service.reserve(command('same', lines)), 409, { error: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(service.getStock(), { pen: 8, pad: 4 });
  }
  assertResult(service.reserve(original), 200, { requestId: 'same', stock: { pen: 8, pad: 4 } });
});

test('defensively copies initial stock, commands, returned bodies, and getStock results', () => {
  const initial = { pen: 5, pad: 2 };
  const service = createReservationService(initial);
  initial.pen = 0;
  initial.pad = 0;
  assert.deepEqual(service.getStock(), { pen: 5, pad: 2 });

  const request = command('def', [{ itemId: 'pen', quantity: 2 }]);
  const created = service.reserve(request);
  request.requestId = 'corrupted';
  request.lines[0].quantity = 5;
  request.lines.push({ itemId: 'pad', quantity: 1 });
  attemptMutation(() => { created.body.stock.pen = 99; });
  const observed = service.getStock();
  attemptMutation(() => {
    observed.pen = 88;
    observed.pad = 0;
  });

  assert.deepEqual(service.getStock(), { pen: 3, pad: 2 });
  const replay = service.reserve(command('def', [{ itemId: 'pen', quantity: 2 }]));
  assertResult(replay, 200, { requestId: 'def', stock: { pen: 3, pad: 2 } });
  attemptMutation(() => { replay.body.requestId = 'replay-corrupted'; });
  attemptMutation(() => { replay.body.stock.pen = 77; });
  assertResult(
    service.reserve(command('def', [{ itemId: 'pen', quantity: 2 }])),
    200,
    { requestId: 'def', stock: { pen: 3, pad: 2 } },
  );
});

test('keeps stock and request bindings independent across service instances', () => {
  const first = createReservationService({ pen: 2 });
  const second = createReservationService({ pen: 2 });

  assertResult(first.reserve(command('__proto__', [{ itemId: 'pen', quantity: 1 }])), 201, {
    requestId: '__proto__', stock: { pen: 1 },
  });
  assert.deepEqual(second.getStock(), { pen: 2 });
  assertResult(second.reserve(command('constructor', [{ itemId: 'pen', quantity: 1 }])), 201, {
    requestId: 'constructor', stock: { pen: 1 },
  });
  assert.deepEqual(first.getStock(), { pen: 1 });
  assertResult(first.reserve(command('constructor', [{ itemId: 'pen', quantity: 1 }])), 201, {
    requestId: 'constructor', stock: { pen: 0 },
  });
  assertResult(second.reserve(command('__proto__', [{ itemId: 'pen', quantity: 1 }])), 201, {
    requestId: '__proto__', stock: { pen: 0 },
  });
});

test('replays a bound request even when current stock can no longer satisfy it', () => {
  const service = createReservationService({ pen: 2 });
  assertResult(service.reserve(command('bound', [{ itemId: 'pen', quantity: 2 }])), 201, {
    requestId: 'bound', stock: { pen: 0 },
  });
  assertResult(service.reserve(command('other', [{ itemId: 'pen', quantity: 1 }])), 409, {
    error: 'INSUFFICIENT_STOCK',
  });
  assertResult(service.reserve(command('bound', [{ itemId: 'pen', quantity: 2 }])), 200, {
    requestId: 'bound', stock: { pen: 0 },
  });
  assert.deepEqual(service.getStock(), { pen: 0 });
});
