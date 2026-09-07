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

const validationPath = resolve(candidateDir, 'validation.ts');
if (relative(candidateDir, validationPath) !== 'validation.ts') {
  throw new Error('validation module escaped candidate directory');
}
const validationInfo = await lstat(validationPath);
if (validationInfo.isSymbolicLink() || !validationInfo.isFile()) {
  throw new Error('candidate validation.ts must be a regular file');
}
const { validateReservation } = await import(pathToFileURL(validationPath).href);
if (typeof validateReservation !== 'function') {
  throw new Error('candidate must export validateReservation');
}

function validBody(requestId = 'r1', lines = [{ itemId: 'pen', quantity: 1 }]) {
  return { requestId, lines };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertInvalid(body) {
  assert.deepEqual(validateReservation(body), { ok: false, error: 'INVALID_REQUEST' });
}

function attemptMutation(callback) {
  try {
    callback();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}

test('normalizes valid input, ignores extras, and deep-copies frozen input', () => {
  const body = deepFreeze({
    requestId: 'r1',
    lines: [{ itemId: 'pen', quantity: 2, note: 'ignored' }],
    note: 'ignored',
  });

  const result = validateReservation(body);

  assert.deepEqual(result, {
    ok: true,
    command: { requestId: 'r1', lines: [{ itemId: 'pen', quantity: 2 }] },
  });
  assert.notStrictEqual(result.command.lines, body.lines);
  assert.notStrictEqual(result.command.lines[0], body.lines[0]);
  attemptMutation(() => { result.command.lines[0].quantity = 99; });
  assert.equal(body.lines[0].quantity, 2);
});

test('rejects bad top-level shapes and missing own required fields', () => {
  assertInvalid(null);
  assertInvalid([]);
  assertInvalid('request');
  assertInvalid(7);
  assertInvalid({ requestId: 'r1' });
  assertInvalid({ lines: [{ itemId: 'pen', quantity: 1 }] });

  const inherited = Object.create({ requestId: 'r1', lines: [{ itemId: 'pen', quantity: 1 }] });
  assertInvalid(inherited);
});

test('accepts request IDs at exact lengths and rejects invalid or trimmed values', () => {
  for (const requestId of ['a', 'a'.repeat(64)]) {
    const result = validateReservation(validBody(requestId));
    assert.equal(result.ok, true);
    assert.equal(result.command.requestId, requestId);
  }
  for (const requestId of [
    '',
    'a'.repeat(65),
    ' r1',
    'r1 ',
    'r 1',
    'r/1',
    'é',
    1,
  ]) {
    assertInvalid(validBody(requestId));
  }
});

test('enforces lines length from one through twenty', () => {
  assertInvalid(validBody('r1', []));
  assertInvalid(validBody('r1', Array.from({ length: 21 }, () => ({ itemId: 'pen', quantity: 1 }))));

  const one = validateReservation(validBody('one', [{ itemId: 'pen', quantity: 1 }]));
  assert.equal(one.ok, true);

  const twentyLines = Array.from({ length: 20 }, (_, index) => ({ itemId: `i${index}`, quantity: 1 }));
  const twenty = validateReservation(validBody('twenty', twentyLines));
  assert.equal(twenty.ok, true);
  assert.equal(twenty.command.lines.length, 20);
});

test('rejects invalid line shapes and missing own line fields', () => {
  for (const line of [null, [], 'line', 3, {}, { itemId: 'pen' }, { quantity: 1 }]) {
    assertInvalid(validBody('r1', [line]));
  }

  const inherited = Object.create({ itemId: 'pen', quantity: 1 });
  assertInvalid(validBody('r1', [inherited]));
});

test('enforces item ID pattern and one-to-sixty-four-character bounds', () => {
  for (const itemId of ['a', 'a'.repeat(64)]) {
    const result = validateReservation(validBody('r1', [{ itemId, quantity: 1 }]));
    assert.equal(result.ok, true);
    assert.equal(result.command.lines[0].itemId, itemId);
  }
  for (const itemId of ['', 'a'.repeat(65), ' pen', 'pen ', 'pen/id', 'é', 1]) {
    assertInvalid(validBody('r1', [{ itemId, quantity: 1 }]));
  }
});

test('accepts positive safe integer quantities and rejects every invalid quantity', () => {
  for (const quantity of [1, Number.MAX_SAFE_INTEGER]) {
    const result = validateReservation(validBody('r1', [{ itemId: 'pen', quantity }]));
    assert.equal(result.ok, true);
    assert.equal(result.command.lines[0].quantity, quantity);
  }
  for (const quantity of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    null,
  ]) {
    assertInvalid(validBody('r1', [{ itemId: 'pen', quantity }]));
  }
});

test('rejects the whole body at a later invalid line without mutating input', () => {
  const body = deepFreeze({
    requestId: 'later',
    lines: [
      { itemId: 'pen', quantity: 1 },
      { itemId: 'pad', quantity: 0 },
      { itemId: 'eraser', quantity: 1 },
    ],
    ignored: { value: true },
  });
  const before = JSON.stringify(body);

  assertInvalid(body);
  assert.equal(JSON.stringify(body), before);
});
