import assert from 'node:assert/strict';
import { appendUnique } from '../../../src/playlist.mjs';

const original = [{ id: 'a' }];
const result = appendUnique(original, [{ id: 'a' }, { id: 'b' }, { id: 'b' }]);
assert.deepEqual(result, [{ id: 'a' }, { id: 'b' }]);
assert.deepEqual(original, [{ id: 'a' }]);
assert.notEqual(result, original);
