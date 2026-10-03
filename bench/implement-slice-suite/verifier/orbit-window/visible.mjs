import assert from 'node:assert/strict';
import { buildWindows } from '../../../src/window.mjs';

assert.deepEqual(buildWindows(6, 3).map(({ start }) => start), [0, 3]);
