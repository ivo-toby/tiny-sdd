import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../src/emitter.mjs';

test('emits to one subscriber', () => {
  const values = [];
  const emitter = createEmitter();
  emitter.subscribe((value) => values.push(value));
  emitter.emit('ready');
  assert.deepEqual(values, ['ready']);
});
