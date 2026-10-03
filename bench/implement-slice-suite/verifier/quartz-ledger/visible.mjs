import assert from 'node:assert/strict';
import { entriesForAccount, sumEntries } from '../../../src/ledger.mjs';

const entries = [{ account: 'a', amount: 2 }, { account: 'b', amount: -1 }];
assert.equal(sumEntries(entries), 1);
assert.equal(entriesForAccount(entries, 'a').length, 1);
