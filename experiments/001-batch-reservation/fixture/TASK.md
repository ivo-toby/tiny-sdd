# Add atomic batch reservations

Implement `reserveBatch(stock, lines)` in `src/inventory.ts`.

Stock maps item IDs to nonnegative safe-integer quantities. Fixture callers
supply valid stock; stock validation is outside this task.

A reservation line contains an item ID in its `itemId` field and a quantity.
The existing `reserveOne` behavior is preserved.

Process batch lines in input order. On each line, reject a quantity that is not
a positive safe integer, then reject an unknown item, then reject a quantity
larger than the remaining stock for that item. The first encountered rejection
determines the error code.

Error codes are `INVALID_QUANTITY`, `UNKNOWN_ITEM`, and
`INSUFFICIENT_STOCK`. An error result contains the original stock values, with
no partial reservation.

Duplicate items consume the same running stock. Successful batches return the
fully reserved stock. An empty batch succeeds with unchanged values.

Never mutate the caller's stock or lines on success or rejection. Object
identity is not part of the contract. Preserve unrequested items and the
existing single-item API.

The module must continue to export these types and functions:

```ts
export type Stock = Readonly<Record<string, number>>;

export interface ReservationLine {
  readonly itemId: string;
  readonly quantity: number;
}

export type ReservationResult =
  | { readonly ok: true; readonly stock: Stock }
  | {
      readonly ok: false;
      readonly error:
        | "INVALID_QUANTITY"
        | "UNKNOWN_ITEM"
        | "INSUFFICIENT_STOCK";
      readonly stock: Stock;
    };

export function reserveOne(
  stock: Stock,
  line: ReservationLine,
): ReservationResult;

export function reserveBatch(
  stock: Stock,
  lines: readonly ReservationLine[],
): ReservationResult;
```

Representative expectations:

| Starting stock | Lines, in order | Expected result |
| --- | --- | --- |
| `pen: 5, pad: 2` | `pen: 2, pad: 1` | Success; `pen: 3, pad: 1` |
| `pen: 5` | `pen: 2, pen: 3` | Success; `pen: 0` |
| `pen: 5` | `pen: 3, pen: 3` | `INSUFFICIENT_STOCK`; `pen: 5` |
| `pen: 5, pad: 1` | `pen: 2, pad: 2` | `INSUFFICIENT_STOCK`; `pen: 5, pad: 1` |
| `pen: 5` | `pen: 2, pen: 0` | `INVALID_QUANTITY`; `pen: 5` |
| `pen: 5` | `pen: 2, eraser: 1` | `UNKNOWN_ITEM`; `pen: 5` |
| `pen: 5` | none | Success; `pen: 5` |

Edit scope: `src/inventory.ts` and `test/*.test.mjs` only. A task brief under
`docs/tasks/` and a local `check-output.txt` verification log are also allowed.

Run the fixture tests with:

```sh
npm test
```

This runs `node --test --experimental-test-isolation=none test/*.test.mjs`.

In this experiment environment, child-process pipes can lose command output.
Capture check output in `check-output.txt` and read that file before reporting
the result, for example `npm test > check-output.txt 2>&1`. The command's exit
status still matters. This environment note applies equally to both experiment
arms; it is not part of the TinySDD skill.
