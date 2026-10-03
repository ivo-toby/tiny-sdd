import assert from 'node:assert/strict';
import { parseReceipt } from '../../../src/receipt.mjs';

assert.throws(() => parseReceipt('r-1|12x'), /amount/u);
assert.throws(() => parseReceipt('r-1|1e3'), /amount/u);
assert.throws(() => parseReceipt('r-1|'), /amount/u);
assert.throws(() => parseReceipt(42), (error) => error instanceof TypeError && /amount/u.test(error.message));
