import assert from 'node:assert/strict';
import { firstMatching } from '../../../src/first-match.mjs';

assert.strictEqual(firstMatching(['skip', undefined, 'later'], (value) => value === undefined), undefined);
assert.strictEqual(firstMatching([true, false], (value) => value === false), false);
assert.strictEqual(firstMatching([2, 0, 4], (value) => value === 0), 0);
assert.strictEqual(firstMatching(['filled', ''], (value) => value === ''), '');
assert.strictEqual(firstMatching(['text', null], (value) => value === null), null);
assert.strictEqual(firstMatching([8, 4, 12], (value) => value % 4 === 0), 8);
assert.strictEqual(firstMatching([1, 3, 5], (value) => value > 9), null);
