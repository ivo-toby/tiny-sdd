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
const { countCodePoints, truncateLabel } = candidate;

if (typeof countCodePoints !== "function") {
  throw new Error("candidate must export countCodePoints");
}
if (typeof truncateLabel !== "function") {
  throw new Error("candidate must export truncateLabel");
}

test("truncateLabel leaves text under the limit unchanged", () => {
  const text = "hello😀";
  assert.equal(truncateLabel(text, 7), text);
});

test("truncateLabel leaves astral text at the exact limit unchanged", () => {
  const text = "a😀b";
  assert.equal(truncateLabel(text, 3), text);
});

test("truncateLabel truncates overflowing ASCII with one ellipsis", () => {
  assert.equal(truncateLabel("abcdef", 4), "abc…");
});

test("truncateLabel counts astral code points while truncating", () => {
  assert.equal(truncateLabel("a😀bc", 3), "a😀…");
});

test("truncateLabel returns empty for overflow at limit zero", () => {
  assert.equal(truncateLabel("abc", 0), "");
  assert.equal(truncateLabel("", 0), "");
});

test("truncateLabel uses only an ellipsis at limit one when needed", () => {
  assert.equal(truncateLabel("ab", 1), "…");
  assert.equal(truncateLabel("😀", 1), "😀");
});

test("truncateLabel counts combining marks separately", () => {
  const text = "e\u0301xyz";
  assert.equal(truncateLabel(text, 3), "e\u0301…");
});

test("truncateLabel preserves non-normalized text under and at the limit", () => {
  const decomposed = "e\u0301";
  assert.notEqual(decomposed, "é");
  assert.equal(truncateLabel(decomposed, 3), decomposed);
  assert.equal(truncateLabel(decomposed, 2), decomposed);
});

test("truncateLabel rejects every invalid limit, including for empty text", () => {
  const invalidLimits = [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const maxPoints of invalidLimits) {
    assert.throws(() => truncateLabel("", maxPoints), RangeError);
    assert.throws(() => truncateLabel("abc", maxPoints), RangeError);
  }
});

test("countCodePoints preserves code point semantics", () => {
  assert.equal(countCodePoints(""), 0);
  assert.equal(countCodePoints("abc"), 3);
  assert.equal(countCodePoints("😀"), 1);
  assert.equal(countCodePoints("e\u0301"), 2);
  assert.equal(countCodePoints("a😀b"), 3);
});
