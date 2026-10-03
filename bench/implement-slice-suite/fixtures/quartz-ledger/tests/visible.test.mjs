import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceByAccount, entriesForAccount, sumEntries } from '../src/ledger.mjs';

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

test('accumulates unrestricted account names', () => {
  assert.deepEqual(balanceByAccount([
    { account: 'constructor', amount: 4 },
    { account: '__proto__', amount: 6 },
    { account: 'constructor', amount: 3 },
  ]), Object.fromEntries([
    ['constructor', 7],
    ['__proto__', 6],
  ]));
});
