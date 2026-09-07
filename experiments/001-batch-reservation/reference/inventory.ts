import {
  reserveOne,
  type Stock,
  type ReservationLine,
  type ReservationResult,
} from '../fixture/src/inventory.ts';

export { reserveOne };

export function reserveBatch(stock: Stock, lines: readonly ReservationLine[]): ReservationResult {
  let remaining = { ...stock };
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      return { ok: false, error: 'INVALID_QUANTITY', stock };
    }
    if (!Object.hasOwn(remaining, line.itemId)) {
      return { ok: false, error: 'UNKNOWN_ITEM', stock };
    }
    if (line.quantity > remaining[line.itemId]) {
      return { ok: false, error: 'INSUFFICIENT_STOCK', stock };
    }
    remaining = { ...remaining, [line.itemId]: remaining[line.itemId] - line.quantity };
  }
  return { ok: true, stock: remaining };
}
