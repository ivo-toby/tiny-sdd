export function parseReceipt(line) {
  if (typeof line !== 'string') throw new Error('amount input must be a receipt string');
  const match = /^(?<id>[^|]+)\|(?<amount>\d+)$/u.exec(line);
  if (!match || /^0+$/u.test(match.groups.amount)) throw new Error('amount must be a positive integer in cents');
  return { id: match.groups.id, amountCents: Number(match.groups.amount) };
}
