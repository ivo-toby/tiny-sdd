import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/options.mjs';

test('C1 defaults omitted options without dropping explicit values', () => {
  assert.deepEqual(normalizeOptions(), { timeoutMs: 5000, headers: {} });
  assert.equal(normalizeOptions({ timeoutMs: 1000 }).timeoutMs, 1000);
});

test('C2 rejects non-integer timeout values instead of coercing them', () => {
  assert.throws(() => normalizeOptions({ timeoutMs: '1000' }), RangeError);
});

test('C3 enforces the inclusive timeout bounds', () => {
  assert.throws(() => normalizeOptions({ timeoutMs: 0 }), RangeError);
  assert.throws(() => normalizeOptions({ timeoutMs: 60001 }), RangeError);
});

test('C4 canonicalizes header names while retaining their values', () => {
  assert.deepEqual(normalizeOptions({ headers: { Accept: 'json', 'X-Trace': '' } }).headers, {
    accept: 'json',
    'x-trace': '',
  });
});
