import test from 'node:test';
import assert from 'node:assert/strict';
import { firstMatching } from '../src/first-match.mjs';

test('returns the first matching value, including an undefined payload', () => {
  assert.strictEqual(firstMatching([undefined, 7, 9], () => true), undefined);
  assert.strictEqual(firstMatching([2, 7, 9], (value) => value > 5), 7);
});

test('preserves false, zero, and empty string payloads', () => {
  assert.strictEqual(firstMatching([false, true], (value) => value === false), false);
  assert.strictEqual(firstMatching([0, 1], (value) => value === 0), 0);
  assert.strictEqual(firstMatching(['', 'value'], (value) => value === ''), '');
});

test('preserves a null payload', () => {
  assert.strictEqual(firstMatching([null, 'value'], (value) => value === null), null);
});

test('returns null when nothing matches', () => {
  assert.strictEqual(firstMatching([2, 4], (value) => value > 5), null);
});
