import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../src/state-machine.mjs';

test('C1 accepts only legal state transitions', () => {
  const running = transition({ status: 'idle', attempts: 0 }, 'start');
  assert.deepEqual(transition(running, 'succeed'), { status: 'succeeded', attempts: 1 });
  assert.deepEqual(transition(running, 'fail'), { status: 'failed', attempts: 1 });
  assert.throws(() => transition({ status: 'idle', attempts: 0 }, 'succeed'), RangeError);
  assert.throws(() => transition({ status: 'idle', attempts: 0 }, 'fail'), RangeError);
});

test('C2 rejects events after a terminal state', () => {
  for (const status of ['succeeded', 'failed']) {
    for (const event of ['start', 'succeed', 'fail']) {
      assert.throws(() => transition({ status, attempts: 1 }, event), RangeError);
    }
  }
});

test('C3 returns a new state without mutating the input', () => {
  const before = { status: 'idle', attempts: 0, label: 'job-a' };
  const after = transition(before, 'start');
  assert.notEqual(after, before);
  assert.deepEqual(before, { status: 'idle', attempts: 0, label: 'job-a' });
  assert.deepEqual(after, { status: 'running', attempts: 1, label: 'job-a' });
});
