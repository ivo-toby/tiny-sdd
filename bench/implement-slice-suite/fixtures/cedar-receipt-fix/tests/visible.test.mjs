import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../src/receipt.mjs';

test('parses an integer amount in cents', () => {
  assert.deepEqual(parseReceipt('r-7|1250'), { id: 'r-7', amountCents: 1250 });
});

test('rejects a malformed receipt', () => {
  assert.throws(() => parseReceipt('r-7|12x'), /amount/u);
});
