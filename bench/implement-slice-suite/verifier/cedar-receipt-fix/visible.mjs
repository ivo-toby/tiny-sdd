import assert from 'node:assert/strict';
import { parseReceipt } from '../../../src/receipt.mjs';

assert.deepEqual(parseReceipt('r-1|90'), { id: 'r-1', amountCents: 90 });
assert.deepEqual(parseReceipt('r-0|0'), { id: 'r-0', amountCents: 0 });
