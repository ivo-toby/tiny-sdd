import test from 'node:test';
import assert from 'node:assert/strict';
import { settleTasks } from '../src/settle.mjs';

test('C1 records fulfillment and rejection without rejecting the batch', async () => {
  const error = new Error('boom');
  assert.deepEqual(await settleTasks([() => 3, () => Promise.reject(error)]), [
    { status: 'fulfilled', value: 3 },
    { status: 'rejected', reason: error },
  ]);
});

test('C2 keeps results in declaration order when completion order differs', async () => {
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  const pending = settleTasks([() => first, () => second]);
  resolveSecond('second');
  resolveFirst('first');
  assert.deepEqual(await pending, [
    { status: 'fulfilled', value: 'first' },
    { status: 'fulfilled', value: 'second' },
  ]);
});

test('C3 starts every task before awaiting settlement', async () => {
  const started = [];
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  const pending = settleTasks([
    () => { started.push('first'); return first; },
    () => { started.push('second'); return second; },
  ]);
  assert.deepEqual(started, ['first', 'second']);
  resolveFirst(1);
  resolveSecond(2);
  await pending;
});
