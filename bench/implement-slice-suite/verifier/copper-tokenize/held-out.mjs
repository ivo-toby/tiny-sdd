import assert from 'node:assert/strict';
import { tokenize } from '../../../src/tokenize.mjs';

assert.deepEqual(tokenize('north\tsouth  east'), ['north', 'south', 'east']);
assert.throws(() => tokenize(42), TypeError);
