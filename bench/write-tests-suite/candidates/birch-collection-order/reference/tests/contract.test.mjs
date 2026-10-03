import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBy } from '../src/group-by.mjs';

test('C1 preserves first-seen group order', () => {
  assert.deepEqual(groupBy([
    { type: 'b', value: 3 },
    { type: 'a', value: 2 },
    { type: 'b', value: 1 },
  ], (item) => item.type).map(({ key }) => key), ['b', 'a']);
});

test('C2 preserves member order within each group', () => {
  const rows = [
    { type: 'b', value: 3 },
    { type: 'a', value: 2 },
    { type: 'b', value: 1 },
  ];
  assert.deepEqual(groupBy(rows, (item) => item.type)[0].items.map(({ value }) => value), [3, 1]);
});

test('C3 does not mutate the input collection', () => {
  const rows = [
    { type: 'b', value: 3 },
    { type: 'a', value: 2 },
    { type: 'b', value: 1 },
  ];
  const before = structuredClone(rows);
  groupBy(rows, (item) => item.type);
  assert.deepEqual(rows, before);
});
