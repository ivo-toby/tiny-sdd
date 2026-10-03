import assert from 'node:assert/strict';
import { buildWindows } from '../../../src/window.mjs';

assert.deepEqual(buildWindows(7, 3), [
  { start: 0, end: 3 },
  { start: 3, end: 6 },
  { start: 6, end: 7 },
]);
assert.equal(buildWindows(7, 3).at(-1).end - buildWindows(7, 3).at(-1).start, 1);
