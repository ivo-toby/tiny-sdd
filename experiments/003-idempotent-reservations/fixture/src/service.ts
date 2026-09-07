import type { ReservationResult, Stock } from "./inventory.ts";
import type { ReservationCommand } from "./validation.ts";

type InventoryError = Extract<ReservationResult, { ok: false }>["error"];

export type ServiceResult =
  | {
      readonly status: 200 | 201;
      readonly body: { readonly requestId: string; readonly stock: Stock };
    }
  | {
      readonly status: 409;
      readonly body: { readonly error: InventoryError | "IDEMPOTENCY_CONFLICT" };
    };

export interface ReservationService {
  getStock(): Stock;
  reserve(command: ReservationCommand): ServiceResult;
}

export function createReservationService(initialStock: Stock): ReservationService {
  const ownedStock = { ...initialStock };

  return {
    getStock(): Stock {
      return { ...ownedStock };
    },

    reserve(_command: ReservationCommand): ServiceResult {
      throw new Error("Not implemented");
    },
  };
}
