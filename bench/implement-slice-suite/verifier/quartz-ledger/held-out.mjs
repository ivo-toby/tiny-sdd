import assert from 'node:assert/strict';
import { balanceByAccount } from '../../../src/ledger.mjs';

assert.deepEqual(balanceByAccount([
  { account: 'north', amount: 12 },
  { account: 'south', amount: -3 },
  { account: 'north', amount: 5 },
]), { north: 17, south: -3 });
