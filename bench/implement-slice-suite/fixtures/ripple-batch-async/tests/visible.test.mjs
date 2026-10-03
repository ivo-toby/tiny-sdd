import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../src/batch.mjs';

test('preserves task order', async () => {
  const result = await runBatch([
    async () => 'first',
    async () => 'second',
  ], { concurrency: 2 });
  assert.deepEqual(result, ['first', 'second']);
});
