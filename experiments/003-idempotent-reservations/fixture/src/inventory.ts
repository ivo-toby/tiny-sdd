export type Stock = Readonly<Record<string, number>>;

export interface ReservationLine {
  readonly itemId: string;
  readonly quantity: number;
}

export type ReservationResult =
  | {
      readonly ok: true;
      readonly stock: Stock;
    }
  | {
      readonly ok: false;
      readonly error:
        | "INVALID_QUANTITY"
        | "UNKNOWN_ITEM"
        | "INSUFFICIENT_STOCK";
      readonly stock: Stock;
    };

function copyStock(stock: Stock): Record<string, number> {
  return { ...stock };
}

function invalidQuantity(quantity: number): boolean {
  return !Number.isSafeInteger(quantity) || quantity <= 0;
}

export function reserveOne(
  stock: Stock,
  line: ReservationLine,
): ReservationResult {
  if (invalidQuantity(line.quantity)) {
    return {
      ok: false,
      error: "INVALID_QUANTITY",
      stock: copyStock(stock),
    };
  }

  if (!Object.hasOwn(stock, line.itemId)) {
    return {
      ok: false,
      error: "UNKNOWN_ITEM",
      stock: copyStock(stock),
    };
  }

  if (line.quantity > stock[line.itemId]) {
    return {
      ok: false,
      error: "INSUFFICIENT_STOCK",
      stock: copyStock(stock),
    };
  }

  const nextStock = copyStock(stock);
  nextStock[line.itemId] -= line.quantity;
  return { ok: true, stock: nextStock };
}

export function reserveBatch(
  stock: Stock,
  lines: readonly ReservationLine[],
): ReservationResult {
  const nextStock = copyStock(stock);

  for (const line of lines) {
    if (invalidQuantity(line.quantity)) {
      return {
        ok: false,
        error: "INVALID_QUANTITY",
        stock: copyStock(stock),
      };
    }

    if (!Object.hasOwn(nextStock, line.itemId)) {
      return {
        ok: false,
        error: "UNKNOWN_ITEM",
        stock: copyStock(stock),
      };
    }

    if (line.quantity > nextStock[line.itemId]) {
      return {
        ok: false,
        error: "INSUFFICIENT_STOCK",
        stock: copyStock(stock),
      };
    }

    nextStock[line.itemId] -= line.quantity;
  }

  return { ok: true, stock: nextStock };
}
