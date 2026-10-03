export function parseReceipt(line) {
  if (typeof line !== 'string') throw new TypeError('receipt must be a string');
  const match = /^(?<id>[^|]+)\|(?<amount>[0-9]+)$/.exec(line);
  if (!match) throw new Error('amount must be an integer in cents');
  return { id: match.groups.id, amountCents: Number(match.groups.amount) };
}
