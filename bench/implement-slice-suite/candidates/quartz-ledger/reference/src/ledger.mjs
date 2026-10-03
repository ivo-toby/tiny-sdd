export function sumEntries(entries) {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

export function entriesForAccount(entries, account) {
  return entries.filter((entry) => entry.account === account);
}

export function balanceByAccount(entries) {
  return entries.reduce((balances, entry) => {
    balances[entry.account] = (balances[entry.account] ?? 0) + entry.amount;
    return balances;
  }, {});
}
