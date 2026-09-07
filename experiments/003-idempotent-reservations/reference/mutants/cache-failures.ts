import { createReservationService as createCorrectService } from '../src/service.ts';
import type { ServiceResult } from '../src/service.ts';
import type { Stock } from '../src/inventory.ts';
import type { ReservationCommand } from '../src/validation.ts';

// Deliberately wrong: a rejected attempt permanently binds its request ID.
export function createReservationService(stock: Stock) {
  const inner = createCorrectService(stock);
  const failures = new Map<string, ServiceResult>();
  return {
    getStock: () => inner.getStock(),
    reserve(command: ReservationCommand) {
      const cached = failures.get(command.requestId);
      if (cached) return cached;
      const result = inner.reserve(command);
      if (result.status === 409) failures.set(command.requestId, result);
      return result;
    },
  };
}
