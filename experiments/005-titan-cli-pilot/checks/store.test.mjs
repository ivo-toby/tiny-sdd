import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '/work/src/store.mjs';

const operation = (key, expectedVersion, value = { nested: [1] }) => ({ key, expectedVersion, value });
const invalid = { ok: false, error: 'invalid_batch' };

test('batch success is ordered, exact and shares put/get state', () => {
  const s = createStore({ a: 1 });
  assert.deepEqual(s.applyBatch([operation('b', 0, null), operation('a', 1, false)]), {
    ok: true, entries: [{ key: 'b', value: null, version: 1 }, { key: 'a', value: false, version: 2 }],
  });
  assert.deepEqual(s.put('a', 3), { value: 3, version: 3 });
  assert.deepEqual(s.applyBatch([operation('a', 3, 4)]), { ok: true, entries: [{ key: 'a', value: 4, version: 4 }] });
  assert.deepEqual(s.get('a'), { value: 4, version: 4 });
});

test('late conflict is atomic and returns first conflicting input position', () => {
  const s = createStore({ a: 1, b: 2, c: 3 });
  assert.deepEqual(s.applyBatch([operation('a', 1, 7), operation('c', 2), operation('b', 9)]),
    { ok: false, error: 'version_conflict', key: 'c', expectedVersion: 2, actualVersion: 1 });
  for (const [key, value] of Object.entries({ a: 1, b: 2, c: 3 })) assert.deepEqual(s.get(key), { value, version: 1 });
  assert.deepEqual(s.applyBatch([operation('new', 0), operation('b', 0)]),
    { ok: false, error: 'version_conflict', key: 'b', expectedVersion: 0, actualVersion: 1 });
  assert.equal(s.get('new'), null);
});

test('shape validation wins over earlier version conflict', () => {
  const s = createStore({ a: 1 });
  assert.deepEqual(s.applyBatch([operation('a', 999), { key: 'bad', expectedVersion: 0 }]), invalid);
  assert.deepEqual(s.get('a'), { value: 1, version: 1 });
});

test('invalid containers, entries, versions and keys preserve state', () => {
  const s = createStore({ a: 1 });
  const malformed = [null, {}, 'x', [], [null], [1], [false], [ [] ],
    [operation('', 0)], [operation('A', 0)], [operation('a.b', 0)], [operation('a'.repeat(33), 0)],
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, true].map(v => [operation('x', v)]),
    [{ key: 'x', value: 1 }], [{ expectedVersion: 0, value: 1 }], [{ ...operation('x', 0), extra: true }],
    [operation('x', 0), operation('x', 0)], Array(1)];
  for (const input of malformed) {
    assert.deepEqual(s.applyBatch(input), invalid);
    assert.deepEqual(s.get('a'), { value: 1, version: 1 });
    assert.equal(s.get('x'), null);
  }
});

test('batch length accepts16, rejects17 atomically', () => {
  const s = createStore();
  const ops = Array.from({ length: 16 }, (_, i) => operation(`k${i}`, 0, i));
  assert.deepEqual(s.applyBatch([...ops, operation('overflow', 0)]), invalid);
  for (const op of ops) assert.equal(s.get(op.key), null);
  assert.deepEqual(s.applyBatch(ops), { ok: true, entries: ops.map(op => ({ key: op.key, value: op.value, version: 1 })) });
});

test('values are detached across input/result/store and shared input references', () => {
  const s = createStore();
  const value = { nested: [1, { n: 2 }] };
  const ops = [operation('a', 0, value), operation('b', 0, value)];
  const before = structuredClone(ops);
  const result = s.applyBatch(ops);
  assert.deepEqual(ops, before);
  result.entries[0].value.nested[1].n = 9;
  assert.equal(result.entries[1].value.nested[1].n, 2);
  value.nested.push(3);
  assert.deepEqual(s.get('a'), { value: before[0].value, version: 1 });
  assert.deepEqual(s.get('b'), { value: before[1].value, version: 1 });
});

test('repeated request conflicts, failed operations consume no version', () => {
  const s = createStore();
  const ops = [operation('a', 0, 1)];
  s.applyBatch(ops);
  assert.deepEqual(s.applyBatch(ops), { ok: false, error: 'version_conflict', key: 'a', expectedVersion: 0, actualVersion: 1 });
  assert.deepEqual(s.applyBatch([operation('a', 1, 2)]), { ok: true, entries: [{ key: 'a', value: 2, version: 2 }] });
});

test('absent version, key boundary and two independent stores', () => {
  const s = createStore();
  assert.deepEqual(s.applyBatch([operation('missing', 2)]), { ok: false, error: 'version_conflict', key: 'missing', expectedVersion: 2, actualVersion: 0 });
  const key = 'a' + 'x'.repeat(31);
  assert.equal(s.applyBatch([operation(key, 0), operation('a_0-b', 0)]).ok, true);
  assert.equal(createStore().get(key), null);
});
