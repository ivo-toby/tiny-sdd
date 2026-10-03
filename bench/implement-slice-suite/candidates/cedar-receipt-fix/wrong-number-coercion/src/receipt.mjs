export function parseReceipt(line) {
  const [id, amount] = String(line).split('|');
  const amountCents = Number(amount);
  if (!Number.isFinite(amountCents)) throw new Error('amount must be an integer in cents');
  return { id, amountCents };
}
