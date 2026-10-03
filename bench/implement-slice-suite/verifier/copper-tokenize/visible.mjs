import assert from 'node:assert/strict';
import { tokenize } from '../../../src/tokenize.mjs';

assert.deepEqual(tokenize('north south'), ['north', 'south']);
