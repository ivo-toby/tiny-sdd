import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../src/state-machine.mjs';

test('starts an idle state', () => {
  assert.deepEqual(transition({ status: 'idle', attempts: 0 }, 'start'), {
    status: 'running',
    attempts: 1,
  });
});
