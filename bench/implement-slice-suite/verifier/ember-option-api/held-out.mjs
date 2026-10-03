import assert from 'node:assert/strict';
import { firstMatching } from '../../../src/first-match.mjs';

assert.equal(firstMatching([1, 7, 9], (value) => value > 4), 7);
