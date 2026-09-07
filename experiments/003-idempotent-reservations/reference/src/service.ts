import { reserveBatch } from "./inventory.ts";
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

interface Binding {
  readonly lines: readonly { readonly itemId: string; readonly quantity: number }[];
  readonly stock: Stock;
}

function copyStock(stock: Stock): Record<string, number> {
  return { ...stock };
}

function copyLines(lines: ReservationCommand["lines"]): Binding["lines"] {
  return lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
}

function sameLines(
  left: Binding["lines"],
  right: ReservationCommand["lines"],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (line, index) =>
      line.itemId === right[index].itemId && line.quantity === right[index].quantity,
  );
}

export function createReservationService(initialStock: Stock): ReservationService {
  let currentStock = copyStock(initialStock);
  const bindings = new Map<string, Binding>();

  return {
    getStock(): Stock {
      return copyStock(currentStock);
    },

    reserve(command: ReservationCommand): ServiceResult {
      const binding = bindings.get(command.requestId);
      if (binding) {
        if (!sameLines(binding.lines, command.lines)) {
          return {
            status: 409,
            body: { error: "IDEMPOTENCY_CONFLICT" },
          };
        }
        return {
          status: 200,
          body: {
            requestId: command.requestId,
            stock: copyStock(binding.stock),
          },
        };
      }

      const result = reserveBatch(currentStock, command.lines);
      if (!result.ok) {
        return { status: 409, body: { error: result.error } };
      }

      currentStock = copyStock(result.stock);
      const bindingStock = copyStock(currentStock);
      bindings.set(command.requestId, {
        lines: copyLines(command.lines),
        stock: bindingStock,
      });
      return {
        status: 201,
        body: {
          requestId: command.requestId,
          stock: copyStock(bindingStock),
        },
      };
    },
  };
}
