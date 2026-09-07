import {
  reserveOne,
  type Stock,
  type ReservationLine,
  type ReservationResult,
} from '../../fixture/src/inventory.ts';

export { reserveOne };

export function reserveBatch(stock: Stock, lines: readonly ReservationLine[]): ReservationResult {
  let remaining = { ...stock };
  for (const line of lines) {
    const result = reserveOne(remaining, line);
    if (!result.ok) {
      return result;
    }
    remaining = { ...result.stock };
  }
  return { ok: true, stock: remaining };
}
