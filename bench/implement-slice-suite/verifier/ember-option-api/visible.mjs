import assert from 'node:assert/strict';
import { firstMatching } from '../../../src/first-match.mjs';

assert.strictEqual(firstMatching([undefined, 'later'], (value) => value === undefined), undefined);
assert.strictEqual(firstMatching(['later', false], (value) => value === false), false);
assert.strictEqual(firstMatching([3, 0, 8], (value) => value === 0), 0);
assert.strictEqual(firstMatching(['later', ''], (value) => value === ''), '');
assert.strictEqual(firstMatching(['later', null], (value) => value === null), null);
assert.strictEqual(firstMatching([3, 8, 10], (value) => value >= 3), 3);
assert.strictEqual(firstMatching([1, 2], (value) => value > 4), null);
