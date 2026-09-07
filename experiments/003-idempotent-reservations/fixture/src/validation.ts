import type { ReservationLine } from "./inventory.ts";

export interface ReservationCommand {
  readonly requestId: string;
  readonly lines: readonly ReservationLine[];
}

export type ValidationResult =
  | { readonly ok: true; readonly command: ReservationCommand }
  | { readonly ok: false; readonly error: "INVALID_REQUEST" };

export function validateReservation(_body: unknown): ValidationResult {
  throw new Error("Not implemented");
}
