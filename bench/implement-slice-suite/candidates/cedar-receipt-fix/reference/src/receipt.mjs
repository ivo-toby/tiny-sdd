export function parseReceipt(line) {
  if (typeof line !== 'string') throw new Error('amount input must be a receipt string');
  const match = /^(?<id>[^|]+)\|(?<amount>[0-9]+)$/.exec(line);
  if (!match) throw new Error('amount must be an integer in cents');
  return { id: match.groups.id, amountCents: Number(match.groups.amount) };
}
