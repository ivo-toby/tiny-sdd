import test from 'node:test';
import assert from 'node:assert/strict';
import { dequeueReady } from '../src/job-queue.mjs';

test('skips a non-ready head job', () => {
  const queue = [
    { id: 'waiting', state: 'waiting' },
    { id: 'ready', state: 'ready' },
  ];
  assert.deepEqual(dequeueReady(queue), { id: 'ready', state: 'ready' });
  assert.deepEqual(queue, [{ id: 'waiting', state: 'waiting' }]);
});
