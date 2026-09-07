# Stockroom: idempotent batch reservation API

Status: synthetic benchmark specification, primary-prepared; not human product acceptance.

## Outcome and decision provenance

An API caller can retry a successful reservation without consuming stock twice.
Reusing the same request ID for a different reservation is rejected. A failed
reservation must not leave partial stock changes or bind the request ID.

This is a bounded, synthetic stockroom application, not a production inventory
system. The user authorized autonomous experimental progress while away. The
primary selected the following benchmark product decisions; they are not claims
about requirements supplied by the user. All role approvals during unattended
runs are explicitly simulated. Final operator acceptance remains pending.

Existing behavior comes from the inventory fixture's reserveOne/reserveBatch
contract and the seeded GET /health and GET /stock routes. New decisions here
cover HTTP-like routing, validation, request identity, replay and error mapping.

## Repository and feature boundary

The seed is a dependency-free Node/TypeScript app with a Request/Response handler,
an in-memory service, and the established atomic inventory functions. Tests call
the real handler and service without opening a socket. This exercises application
integration, not a deployed HTTP server or transport behavior.

- Preserve src/inventory.ts and all original tests.
- Extend src/validation.ts, src/service.ts and src/app.ts in three ordered tasks.
- Add tests in test/*.test.mjs. Keep source contracts and test discovery stable.
- No packages, network calls, Git changes, database, authentication, server setup,
  expiry, cross-process persistence, order cancellation, or multi-tenant behavior.
- No stock validation: initial stock has own string keys with nonnegative safe
  integer values, as in the existing inventory contract. Quantities are numbers.

## 1. Request validation

POST /reservations accepts a JSON object with requestId and lines. The validator
also accepts unknown values for checking at its direct function boundary. Inputs
are inert data without accessors or executable behavior; inherited fields do not
satisfy required fields. Both required fields must be own properties. Unknown
fields are ignored.

- requestId: string matching /^[A-Za-z0-9_-]{1,64}$/ exactly; no trimming/coercion.
- lines: array of 1 through 20 elements, in order.
- Each line: non-null non-array object with own itemId and quantity fields.
- itemId: the same string pattern as requestId; quantity: positive safe integer.
- Reject the whole request if any part is invalid. Never mutate the input.
- Return a new normalized command retaining only requestId and each item's
  itemId/quantity. Neither the returned lines array nor its objects alias input.

The shared interface in src/validation.ts is:

```ts
import type { ReservationLine } from './inventory.ts';
export interface ReservationCommand {
  readonly requestId: string;
  readonly lines: readonly ReservationLine[];
}
export type ValidationResult =
  | { readonly ok: true; readonly command: ReservationCommand }
  | { readonly ok: false; readonly error: 'INVALID_REQUEST' };
export function validateReservation(body: unknown): ValidationResult;
```

## 2. Reservation service and identity

createReservationService(initialStock) owns an independent copy of initial stock
and an initially empty, per-instance map of successful request IDs. Its reserve
method receives a valid normalized ReservationCommand (validation is a caller
precondition). The service API is synchronous; do not introduce I/O or awaits.

The identity of a reservation is the ordered sequence of itemId/quantity pairs.
Changing order, splitting a line, or changing a quantity is a different request.
Extra JSON fields and object property order are not part of identity. Duplicate
items remain separate ordered lines and consume the same running stock.

For an ID not bound to a success:

- Use reserveBatch to apply all lines atomically against current stock.
- Success replaces current stock, binds the ID to the normalized line sequence
  and a stock snapshot at that moment, and returns status 201.
- Business rejection returns status 409 with the inventory error code; neither
  stock nor the ID map changes. The ID may subsequently be used with other lines.

For an ID already bound to a success:

- The identical line sequence returns status 200 and the original success body,
  even if subsequent reservations have changed current stock. Do not debit again.
- Any different sequence returns 409 / IDEMPOTENCY_CONFLICT, before trying any
  inventory operation. Current stock and the original binding remain unchanged.

No caller may corrupt service state or future replay by mutating initialStock,
the command, a returned body/stock snapshot, or a getStock result. Return defensive
copies; do not mutate caller inputs on success, rejection, replay, or conflict.

The shared interface in src/service.ts is:

```ts
import type { Stock, ReservationResult } from './inventory.ts';
import type { ReservationCommand } from './validation.ts';
type InventoryError = Extract<ReservationResult, { ok: false }>['error'];
export type ServiceResult =
  | { readonly status: 200 | 201;
      readonly body: { readonly requestId: string; readonly stock: Stock } }
  | { readonly status: 409;
      readonly body: { readonly error: InventoryError | 'IDEMPOTENCY_CONFLICT' } };
export interface ReservationService {
  getStock(): Stock;
  reserve(command: ReservationCommand): ServiceResult;
}
export function createReservationService(initialStock: Stock): ReservationService;
```

## 3. Application boundary

createApp(initialStock) creates exactly one service for that app instance and
returns (request: Request) => Promise<Response>. Match method and URL pathname;
query strings do not alter routing. All replies are JSON with Content-Type
application/json (a charset parameter is permitted).

| Request | Response |
| --- | --- |
| GET /health | 200, {"ok":true}, unchanged |
| GET /stock | 200, {"stock": currentStock}, including earlier successful reservations |
| POST /reservations with malformed JSON | 400, {"error":"INVALID_JSON"} |
| POST /reservations with invalid request shape/values | 400, {"error":"INVALID_REQUEST"} |
| POST /reservations with a valid command | service status and body exactly |
| Any other method/path | 404, {"error":"NOT_FOUND"}, unchanged |

JSON parsing is attempted without requiring a Content-Type request header.
Unknown routes must not attempt to parse request bodies. Do not conflate JSON
parse errors with validation or business failures. Separate app instances do
not share stock or bindings. Two overlapping handler calls with the same valid
request must produce one creation and one replay, not two stock debits.

## Acceptance and examples

Start with {pen: 5, pad: 2}. ID r1 with [pen:2] creates a reservation, returns
201 / {requestId:'r1',stock:{pen:3,pad:2}}, and updates GET /stock. ID r2 with
[pad:1] leaves current stock {pen:3,pad:1}. Retrying r1 with [pen:2] returns 200
with its original {pen:3,pad:2} snapshot; current stock remains {pen:3,pad:1}.
Retrying r1 with [pen:1] returns IDEMPOTENCY_CONFLICT without changes.

From {pen:5}, an unbound ID bad with [pen:3, pen:3] returns INSUFFICIENT_STOCK
and leaves {pen:5}. Reuse bad with [pen:1] must create successfully. A valid
unknown item returns UNKNOWN_ITEM. Invalid input, malformed JSON, business
rejection, and idempotency conflict are distinct outcomes.

Checks must cover normalization/rejection, atomic state and identity behavior,
defensive copies, HTTP-to-service integration, and preservation of the seeded
inventory/routes. Independent tests and deliberately wrong reference variants
are retained outside the participant workspace. Passing tests is finite evidence,
not exhaustive correctness or a security claim.
