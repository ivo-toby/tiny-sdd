import assert from 'node:assert/strict';
import { runBatch } from '../../../src/batch.mjs';

const result = await runBatch([
  async () => 'ok',
  async () => { throw new Error('bad'); },
  async () => new Promise((resolve) => setTimeout(() => resolve('late'), 30)),
], { concurrency: 2, timeoutMs: 5 });
assert.deepEqual(result.map(({ status }) => status), ['fulfilled', 'rejected', 'rejected']);
assert.equal(result[1].reason, 'bad');
assert.equal(result[2].reason, 'timeout');
