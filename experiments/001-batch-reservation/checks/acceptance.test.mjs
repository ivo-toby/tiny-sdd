import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const candidatePath = process.env.TINYSDD_CANDIDATE_MODULE;

if (!candidatePath) {
  throw new Error("TINYSDD_CANDIDATE_MODULE is required");
}
if (!isAbsolute(candidatePath)) {
  throw new Error("TINYSDD_CANDIDATE_MODULE must be an absolute path");
}
if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
  throw new Error("TINYSDD_CANDIDATE_MODULE must name an existing file");
}

const candidate = await import(pathToFileURL(candidatePath).href);
const { reserveBatch, reserveOne } = candidate;

if (typeof reserveBatch !== "function") {
  throw new Error("candidate must export reserveBatch");
}
if (typeof reserveOne !== "function") {
  throw new Error("candidate must export reserveOne");
}

function assertInputsUnchanged(stock, lines, expectedStock, expectedLines) {
  assert.deepStrictEqual(stock, expectedStock);
  assert.deepStrictEqual(lines, expectedLines);
}

test("reserveBatch reserves distinct items atomically", () => {
  const stock = { pen: 5, pad: 2 };
  const lines = [
    { itemId: "pen", quantity: 2 },
    { itemId: "pad", quantity: 1 },
  ];
  const originalStock = { pen: 5, pad: 2 };
  const originalLines = [
    { itemId: "pen", quantity: 2 },
    { itemId: "pad", quantity: 1 },
  ];

  const result = reserveBatch(stock, lines);

  assert.equal(result.ok, true);
  assert.deepStrictEqual(result.stock, { pen: 3, pad: 1 });
  assertInputsUnchanged(stock, lines, originalStock, originalLines);
});

test("reserveBatch accounts for duplicate items within available stock", () => {
  const stock = { pen: 5 };
  const lines = [
    { itemId: "pen", quantity: 2 },
    { itemId: "pen", quantity: 3 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, { ok: true, stock: { pen: 0 } });
  assert.deepStrictEqual(stock, { pen: 5 });
  assert.deepStrictEqual(lines, [
    { itemId: "pen", quantity: 2 },
    { itemId: "pen", quantity: 3 },
  ]);
});

test("reserveBatch rejects duplicate items that exceed the running balance", () => {
  const stock = { pen: 5 };
  const lines = [
    { itemId: "pen", quantity: 3 },
    { itemId: "pen", quantity: 3 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INSUFFICIENT_STOCK",
    stock: { pen: 5 },
  });
  assert.deepStrictEqual(stock, { pen: 5 });
  assert.deepStrictEqual(lines, [
    { itemId: "pen", quantity: 3 },
    { itemId: "pen", quantity: 3 },
  ]);
});

test("reserveBatch rolls back a midway invalid quantity", () => {
  const stock = Object.freeze({ pen: 5, pad: 1 });
  const lines = Object.freeze([
    Object.freeze({ itemId: "pen", quantity: 2 }),
    Object.freeze({ itemId: "pad", quantity: 0 }),
  ]);

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INVALID_QUANTITY",
    stock: { pen: 5, pad: 1 },
  });
  assertInputsUnchanged(
    stock,
    lines,
    { pen: 5, pad: 1 },
    [
      { itemId: "pen", quantity: 2 },
      { itemId: "pad", quantity: 0 },
    ],
  );
});

test("reserveBatch rolls back a midway unknown item", () => {
  const stock = { pen: 5, pad: 1 };
  const lines = [
    { itemId: "pen", quantity: 2 },
    { itemId: "eraser", quantity: 1 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "UNKNOWN_ITEM",
    stock: { pen: 5, pad: 1 },
  });
  assertInputsUnchanged(
    stock,
    lines,
    { pen: 5, pad: 1 },
    [
      { itemId: "pen", quantity: 2 },
      { itemId: "eraser", quantity: 1 },
    ],
  );
});

test("reserveBatch rolls back a midway insufficient reservation", () => {
  const stock = { pen: 5, pad: 1 };
  const lines = [
    { itemId: "pen", quantity: 2 },
    { itemId: "pad", quantity: 2 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INSUFFICIENT_STOCK",
    stock: { pen: 5, pad: 1 },
  });
  assertInputsUnchanged(
    stock,
    lines,
    { pen: 5, pad: 1 },
    [
      { itemId: "pen", quantity: 2 },
      { itemId: "pad", quantity: 2 },
    ],
  );
});

test("reserveBatch accepts an empty batch with unchanged values", () => {
  const stock = { pen: 5, pad: 2 };
  const lines = [];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: true,
    stock: { pen: 5, pad: 2 },
  });
  assertInputsUnchanged(stock, lines, { pen: 5, pad: 2 }, []);
});

test("reserveBatch preserves unrelated stock items", () => {
  const stock = { pen: 5, pad: 2, pencil: 7 };
  const lines = [{ itemId: "pen", quantity: 2 }];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: true,
    stock: { pen: 3, pad: 2, pencil: 7 },
  });
  assertInputsUnchanged(stock, lines, { pen: 5, pad: 2, pencil: 7 }, [
    { itemId: "pen", quantity: 2 },
  ]);
});

test("reserveBatch checks each line in quantity, item, availability order", () => {
  assert.deepStrictEqual(
    reserveBatch(
      { pen: 5 },
      [{ itemId: "eraser", quantity: 0 }],
    ),
    { ok: false, error: "INVALID_QUANTITY", stock: { pen: 5 } },
  );
  assert.deepStrictEqual(
    reserveBatch(
      { pen: 5 },
      [{ itemId: "eraser", quantity: 1 }],
    ),
    { ok: false, error: "UNKNOWN_ITEM", stock: { pen: 5 } },
  );
  assert.deepStrictEqual(
    reserveBatch(
      { pen: 5 },
      [{ itemId: "pen", quantity: 6 }],
    ),
    { ok: false, error: "INSUFFICIENT_STOCK", stock: { pen: 5 } },
  );
});

test("reserveBatch keeps an earlier insufficiency ahead of a later invalid quantity", () => {
  const stock = { pen: 5 };
  const lines = [
    { itemId: "pen", quantity: 6 },
    { itemId: "eraser", quantity: 0 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "INSUFFICIENT_STOCK",
    stock: { pen: 5 },
  });
  assertInputsUnchanged(stock, lines, { pen: 5 }, [
    { itemId: "pen", quantity: 6 },
    { itemId: "eraser", quantity: 0 },
  ]);
});

test("reserveBatch keeps an earlier unknown item ahead of a later invalid quantity", () => {
  const stock = { pen: 5 };
  const lines = [
    { itemId: "eraser", quantity: 1 },
    { itemId: "pen", quantity: 0 },
  ];

  const result = reserveBatch(stock, lines);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "UNKNOWN_ITEM",
    stock: { pen: 5 },
  });
  assertInputsUnchanged(stock, lines, { pen: 5 }, [
    { itemId: "eraser", quantity: 1 },
    { itemId: "pen", quantity: 0 },
  ]);
});

test("reserveBatch rejects all specified invalid quantity classes", () => {
  const invalidQuantities = [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const quantity of invalidQuantities) {
    const stock = { pen: 5 };
    const lines = [{ itemId: "pen", quantity }];
    const result = reserveBatch(stock, lines);

    assert.deepStrictEqual(result, {
      ok: false,
      error: "INVALID_QUANTITY",
      stock: { pen: 5 },
    });
    assert.deepStrictEqual(stock, { pen: 5 });
    assert.deepStrictEqual(lines, [{ itemId: "pen", quantity }]);
  }
});

test("reserveOne remains compatible with the fixture API", () => {
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
