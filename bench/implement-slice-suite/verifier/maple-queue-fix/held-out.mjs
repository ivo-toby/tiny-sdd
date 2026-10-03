import assert from 'node:assert/strict';
import { dequeueReady } from '../../../src/job-queue.mjs';

const queue = [{ id: 'cancelled', state: 'cancelled' }];
assert.equal(dequeueReady(queue), null);
assert.deepEqual(queue, [{ id: 'cancelled', state: 'cancelled' }]);
