import assert from 'node:assert/strict';
import { retry } from '../../../src/retry.mjs';

assert.equal(await retry(() => 'ok', 1), 'ok');
