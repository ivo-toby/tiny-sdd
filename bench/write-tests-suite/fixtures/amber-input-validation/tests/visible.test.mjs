import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/options.mjs';

test('normalizes an ordinary request option', () => {
  assert.deepEqual(normalizeOptions({ timeoutMs: 1000, headers: { accept: 'json' } }), {
    timeoutMs: 1000,
    headers: { accept: 'json' },
  });
});
