import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerEntry } from '../src/entrypoint.mjs';

test('real broker entrypoint wires every reconstructed lifecycle slice', async () => {
  assert.deepEqual(await brokerEntry('lease', 'held'), {
    invalidLease: 'invalid lease',
    path: 'lease',
    allowed: true,
    backend: 'held',
    sequential: 'held',
    asynchronous: { key: 'lease', value: 'held' },
  });
  await assert.rejects(() => brokerEntry('../escape', 'held'), /unsafe broker path/);
  await assert.rejects(() => brokerEntry('other', 'held', ['lease']), /not allowlisted/);
});
