import assert from 'node:assert/strict';
import { dequeueReady } from '../../../src/job-queue.mjs';

const queue = [{ id: 'ready', state: 'ready' }];
assert.deepEqual(dequeueReady(queue), { id: 'ready', state: 'ready' });
assert.deepEqual(queue, []);
