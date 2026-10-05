export function createLedger() {
  let balance = 0;
  return {
    append(amount) {
      if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('amount');
      balance += amount;
      return balance;
    },
    balance: () => balance,
  };
}
