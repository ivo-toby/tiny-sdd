export function parseReceipt(line) {
  const [id, amount] = line.split('|');
  return { id, amountCents: Number.parseInt(amount, 10) };
}
