import assert from 'node:assert/strict';
import { balanceByAccount } from '../../../src/ledger.mjs';

const entries = [
  { account: 'north', amount: 12 },
  { account: 'south', amount: -3 },
  { account: 'north', amount: 5 },
  { account: 'constructor', amount: 4 },
  { account: '__proto__', amount: 6 },
  { account: 'constructor', amount: 3 },
];
assert.deepEqual(balanceByAccount(entries), Object.fromEntries([
  ['north', 17],
  ['south', -3],
  ['constructor', 7],
  ['__proto__', 6],
]));
