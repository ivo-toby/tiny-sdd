import { createReservationService as createCorrectService } from '../src/service.ts';
import type { Stock } from '../src/inventory.ts';
import type { ReservationCommand } from '../src/validation.ts';

// Deliberately wrong: a replay reports today's stock instead of its saved result.
export function createReservationService(stock: Stock) {
  const inner = createCorrectService(stock);
  return {
    getStock: () => inner.getStock(),
    reserve(command: ReservationCommand) {
      const result = inner.reserve(command);
      return result.status !== 200 ? result : {
        ...result, body: { ...result.body, stock: inner.getStock() },
      };
    },
  };
}
