import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";

test("GET /health returns the JSON health response", async () => {
  const app = createApp({ pen: 5, pad: 2 });

  const response = await app(
    new Request("http://stockroom.test/health", { method: "GET" }),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
  assert.deepStrictEqual(await response.json(), { ok: true });
});

test("GET /stock isolates the initial stock from later caller mutation", async () => {
  const initialStock = { pen: 5, pad: 2 };
  const app = createApp(initialStock);
  initialStock.pen = 0;
  initialStock.pad = 99;

  const response = await app(
    new Request("http://stockroom.test/stock", { method: "GET" }),
  );

  assert.equal(response.status, 200);
  assert.deepStrictEqual(await response.json(), {
    stock: { pen: 5, pad: 2 },
  });
});

test("unknown paths and methods return JSON 404 responses", async () => {
  const app = createApp({ pen: 5 });

  for (const [url, method] of [
    ["http://stockroom.test/missing", "GET"],
    ["http://stockroom.test/health", "POST"],
  ]) {
    const response = await app(new Request(url, { method }));

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
    assert.deepStrictEqual(await response.json(), { error: "NOT_FOUND" });
  }
});

test("health and stock routing ignores query strings", async () => {
  const app = createApp({ pen: 5, pad: 2 });

  const health = await app(
    new Request("http://stockroom.test/health?check=1", { method: "GET" }),
  );
  const stock = await app(
    new Request("http://stockroom.test/stock?view=current", { method: "GET" }),
  );

  assert.equal(health.status, 200);
  assert.deepStrictEqual(await health.json(), { ok: true });
  assert.equal(stock.status, 200);
  assert.deepStrictEqual(await stock.json(), {
    stock: { pen: 5, pad: 2 },
  });
});
