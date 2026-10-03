import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBy } from '../src/group-by.mjs';

test('groups a short collection', () => {
  assert.deepEqual(groupBy([{ type: 'a', value: 1 }, { type: 'b', value: 2 }], (item) => item.type), [
    { key: 'a', items: [{ type: 'a', value: 1 }] },
    { key: 'b', items: [{ type: 'b', value: 2 }] },
  ]);
});
