import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindows } from '../src/window.mjs';

test('builds complete windows and a short tail', () => {
  assert.deepEqual(buildWindows(7, 3), [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 7 },
  ]);
});

test('empty input has no windows', () => {
  assert.deepEqual(buildWindows(0, 4), []);
});
