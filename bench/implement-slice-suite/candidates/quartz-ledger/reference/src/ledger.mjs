export function sumEntries(entries) {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

export function entriesForAccount(entries, account) {
  return entries.filter((entry) => entry.account === account);
}

export function balanceByAccount(entries) {
  return entries.reduce((balances, entry) => {
    if (Object.hasOwn(balances, entry.account)) balances[entry.account] += entry.amount;
    else Object.defineProperty(balances, entry.account, {
      configurable: true,
      enumerable: true,
      value: entry.amount,
      writable: true,
    });
    return balances;
  }, {});
}
