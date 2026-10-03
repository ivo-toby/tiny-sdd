import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize.mjs';

test('tokenizes ordinary words', () => {
  assert.deepEqual(tokenize('red green blue'), ['red', 'green', 'blue']);
});

test('empty input has no tokens', () => {
  assert.deepEqual(tokenize('   '), []);
});
