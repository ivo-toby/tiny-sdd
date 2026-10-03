Add `balanceByAccount(entries)` to `src/ledger.mjs`.

Return a plain object whose keys are account names and whose values are the
sum of amounts for that account. Start missing accounts at zero, preserve
negative amounts, and leave the input array and entries unchanged. Keep the
existing `sumEntries` and `entriesForAccount` behavior.
