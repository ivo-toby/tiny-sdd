import test from 'node:test';
import assert from 'node:assert/strict';
import { entriesForAccount, sumEntries } from '../src/ledger.mjs';

const entries = [
  { account: 'north', amount: 12 },
  { account: 'south', amount: -3 },
  { account: 'north', amount: 5 },
];

test('keeps sum behavior', () => {
  assert.equal(sumEntries(entries), 14);
});

test('filters entries by account', () => {
  assert.deepEqual(entriesForAccount(entries, 'north'), [entries[0], entries[2]]);
});
