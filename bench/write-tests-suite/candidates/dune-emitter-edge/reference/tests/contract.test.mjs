import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../src/emitter.mjs';

test('C1 deduplicates the same subscription', () => {
  const values = [];
  const emitter = createEmitter();
  const listener = (value) => values.push(value);
  emitter.subscribe(listener);
  emitter.subscribe(listener);
  emitter.emit('once');
  assert.deepEqual(values, ['once']);
});

test('C2 dispatches a snapshot in subscription order', () => {
  const values = [];
  const emitter = createEmitter();
  let unsubscribeB;
  emitter.subscribe((value) => {
    values.push(`a:${value}`);
    if (value === 'first') unsubscribeB();
  });
  unsubscribeB = emitter.subscribe((value) => values.push(`b:${value}`));
  emitter.emit('first');
  emitter.emit('second');
  assert.deepEqual(values, ['a:first', 'b:first', 'a:second']);
});

test('C3 removes only the target subscription and is idempotent', () => {
  const values = [];
  const emitter = createEmitter();
  const unsubscribeA = emitter.subscribe(() => values.push('a'));
  emitter.subscribe(() => values.push('b'));
  unsubscribeA();
  unsubscribeA();
  emitter.emit('value');
  assert.deepEqual(values, ['b']);
});
