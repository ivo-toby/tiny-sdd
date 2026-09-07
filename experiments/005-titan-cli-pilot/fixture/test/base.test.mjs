import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';

test('get and put preserve versioning and absent result', () => {
  const store = createStore({ a: { n: 1 } });
  assert.equal(store.get('missing'), null);
  assert.deepEqual(store.get('a'), { value: { n: 1 }, version: 1 });
  assert.deepEqual(store.put('a', { n: 2 }), { value: { n: 2 }, version: 2 });
  assert.deepEqual(store.put('b', false), { value: false, version: 1 });
});

test('seed, get, put inputs and returned data are detached', () => {
  const seed = { a: { values: [1] } };
  const store = createStore(seed);
  seed.a.values.push(2);
  const first = store.get('a');
  first.value.values.push(3);
  const value = { nested: [4] };
  const result = store.put('b', value);
  value.nested.push(5);
  result.value.nested.push(6);
  assert.deepEqual(store.get('a'), { value: { values: [1] }, version: 1 });
  assert.deepEqual(store.get('b'), { value: { nested: [4] }, version: 1 });
});
