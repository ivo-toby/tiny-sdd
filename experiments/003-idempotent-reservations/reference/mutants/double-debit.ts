import { createReservationService as createCorrectService } from '../src/service.ts';
import type { Stock } from '../src/inventory.ts';
import type { ReservationCommand } from '../src/validation.ts';

// Deliberately wrong: every invocation gets a fresh key, so retries debit again.
export function createReservationService(stock: Stock) {
  const inner = createCorrectService(stock);
  let serial = 0;
  return {
    getStock: () => inner.getStock(),
    reserve(command: ReservationCommand) {
      const result = inner.reserve({ ...command, requestId: `mutant_${serial++}` });
      return result.status === 409 ? result : {
        ...result, body: { ...result.body, requestId: command.requestId },
      };
    },
  };
}
