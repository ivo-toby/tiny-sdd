import assert from "node:assert/strict";
import test from "node:test";

import { countCodePoints } from "../src/labels.ts";

test("countCodePoints counts an empty string as zero", () => {
  assert.equal(countCodePoints(""), 0);
});

test("countCodePoints counts ASCII code points", () => {
  assert.equal(countCodePoints("abc"), 3);
});

test("countCodePoints counts one astral emoji as one code point", () => {
  assert.equal(countCodePoints("😀"), 1);
});

test("countCodePoints counts combining marks separately", () => {
  assert.equal(countCodePoints("e\u0301"), 2);
});

test("countCodePoints counts text around an astral emoji", () => {
  assert.equal(countCodePoints("a😀b"), 3);
});
