import assert from 'node:assert/strict';
import { retry } from '../../../src/retry.mjs';

assert.equal(retry.constructor.name, 'Function');
assert.equal(retry(() => 'ok', 1), 'ok');

let calls = 0;
const lastError = new Error('last attempt');
assert.throws(() => retry(() => {
  calls += 1;
  throw lastError;
}, 3), lastError);
assert.equal(calls, 3);
