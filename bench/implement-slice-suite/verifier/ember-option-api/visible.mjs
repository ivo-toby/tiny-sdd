import assert from 'node:assert/strict';
import { firstMatching } from '../../../src/first-match.mjs';

assert.equal(firstMatching([1, 2], (value) => value > 4), null);
