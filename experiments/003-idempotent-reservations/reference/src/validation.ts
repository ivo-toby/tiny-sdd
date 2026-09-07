import type { ReservationLine } from "./inventory.ts";

export interface ReservationCommand {
  readonly requestId: string;
  readonly lines: readonly ReservationLine[];
}

export type ValidationResult =
  | { readonly ok: true; readonly command: ReservationCommand }
  | { readonly ok: false; readonly error: "INVALID_REQUEST" };

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

function invalidRequest(): ValidationResult {
  return { ok: false, error: "INVALID_REQUEST" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateReservation(body: unknown): ValidationResult {
  if (!isObject(body) || !Object.hasOwn(body, "requestId") || !Object.hasOwn(body, "lines")) {
    return invalidRequest();
  }

  const requestId = body.requestId;
  const inputLines = body.lines;
  if (typeof requestId !== "string" || !IDENTIFIER.test(requestId)) {
    return invalidRequest();
  }
  if (!Array.isArray(inputLines) || inputLines.length < 1 || inputLines.length > 20) {
    return invalidRequest();
  }

  const lines: ReservationLine[] = [];
  for (const inputLine of inputLines) {
    if (!isObject(inputLine) || !Object.hasOwn(inputLine, "itemId") || !Object.hasOwn(inputLine, "quantity")) {
      return invalidRequest();
    }
    const itemId = inputLine.itemId;
    const quantity = inputLine.quantity;
    if (typeof itemId !== "string" || !IDENTIFIER.test(itemId)) {
      return invalidRequest();
    }
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return invalidRequest();
    }
    lines.push({ itemId, quantity });
  }

  return { ok: true, command: { requestId, lines } };
}
