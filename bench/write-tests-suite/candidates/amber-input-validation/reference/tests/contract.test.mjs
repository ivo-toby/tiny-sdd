import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/options.mjs';

test('C1 defaults omitted options without dropping explicit values', () => {
  let defaults;
  assert.doesNotThrow(() => { defaults = normalizeOptions(); });
  assert.deepEqual(defaults, { timeoutMs: 5000, headers: {} });
  let explicit;
  assert.doesNotThrow(() => { explicit = normalizeOptions({ timeoutMs: 1234 }); });
  assert.deepEqual(explicit, { timeoutMs: 1234, headers: {} });
});

test('C2 rejects non-integer timeout values instead of coercing them', () => {
  assert.throws(() => normalizeOptions({ timeoutMs: '1000' }), RangeError);
  assert.throws(() => normalizeOptions({ timeoutMs: 1.5 }), RangeError);
});

test('C3 enforces the inclusive timeout bounds', () => {
  assert.doesNotThrow(() => normalizeOptions({ timeoutMs: 1 }));
  assert.doesNotThrow(() => normalizeOptions({ timeoutMs: 60000 }));
  assert.throws(() => normalizeOptions({ timeoutMs: 0 }), RangeError);
  assert.throws(() => normalizeOptions({ timeoutMs: 60001 }), RangeError);
});

test('C4 canonicalizes header names while retaining their values', () => {
  const headers = Object.fromEntries([
    ['Accept', 'json'],
    ['X-Trace', ''],
    ['__proto__', 'retained'],
  ]);
  const result = normalizeOptions({ timeoutMs: 5000, headers }).headers;
  assert.deepEqual(result, Object.fromEntries([
    ['accept', 'json'],
    ['x-trace', ''],
    ['__proto__', 'retained'],
  ]));
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'retained');
});
