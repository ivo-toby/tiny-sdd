import assert from 'node:assert/strict';
import { runBatch } from '../../../src/batch.mjs';

const result = await runBatch([async () => 'a', async () => 'b'], { concurrency: 2 });
assert.deepEqual(result, [
  { status: 'fulfilled', value: 'a' },
  { status: 'fulfilled', value: 'b' },
]);
