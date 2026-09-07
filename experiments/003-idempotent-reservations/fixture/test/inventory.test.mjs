import assert from "node:assert/strict";
import test from "node:test";

import { reserveOne } from "../src/inventory.ts";

test("reserveOne reserves a line and preserves unrelated stock", () => {
  const stock = { pen: 5, pad: 2 };
  const line = { itemId: "pen", quantity: 2 };

  const result = reserveOne(stock, line);

  assert.deepStrictEqual(result, {
    ok: true,
    stock: { pen: 3, pad: 2 },
  });
  assert.deepStrictEqual(stock, { pen: 5, pad: 2 });
  assert.deepStrictEqual(line, { itemId: "pen", quantity: 2 });
});

test("reserveOne rejects a non-positive quantity", () => {
  const stock = { pen: 5 };
  const line = { itemId: "pen", quantity: 0 };

  const result = reserveOne(stock, line);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INVALID_QUANTITY",
    stock: { pen: 5 },
  });
  assert.deepStrictEqual(stock, { pen: 5 });
  assert.deepStrictEqual(line, { itemId: "pen", quantity: 0 });
});

test("reserveOne rejects an unknown item", () => {
  const stock = { pen: 5 };
  const line = { itemId: "eraser", quantity: 1 };

  const result = reserveOne(stock, line);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "UNKNOWN_ITEM",
    stock: { pen: 5 },
  });
  assert.deepStrictEqual(stock, { pen: 5 });
  assert.deepStrictEqual(line, { itemId: "eraser", quantity: 1 });
});

test("reserveOne rejects a quantity larger than available stock", () => {
  const stock = { pen: 5 };
  const line = { itemId: "pen", quantity: 6 };

  const result = reserveOne(stock, line);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INSUFFICIENT_STOCK",
    stock: { pen: 5 },
  });
  assert.deepStrictEqual(stock, { pen: 5 });
  assert.deepStrictEqual(line, { itemId: "pen", quantity: 6 });
});

test("reserveOne works with frozen caller inputs", () => {
  const stock = Object.freeze({ pen: 5, pad: 2 });
  const line = Object.freeze({ itemId: "pad", quantity: 1 });

  const result = reserveOne(stock, line);

  assert.deepStrictEqual(result, {
    ok: true,
    stock: { pen: 5, pad: 1 },
  });
  assert.deepStrictEqual(stock, { pen: 5, pad: 2 });
  assert.deepStrictEqual(line, { itemId: "pad", quantity: 1 });
});
