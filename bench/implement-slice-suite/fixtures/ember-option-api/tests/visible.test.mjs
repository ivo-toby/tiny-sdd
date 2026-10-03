import test from 'node:test';
import assert from 'node:assert/strict';
import { firstMatching } from '../src/first-match.mjs';

test('returns the first matching value', () => {
  assert.equal(firstMatching([2, 7, 9], (value) => value > 5), 7);
});

test('returns null when nothing matches', () => {
  assert.equal(firstMatching([2, 4], (value) => value > 5), null);
});
