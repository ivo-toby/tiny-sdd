# Truncate labels by Unicode code point count

Implement `truncateLabel(text, maxPoints)` in `src/labels.ts`.

The existing `countCodePoints(text)` export returns `[...text].length`. It
counts Unicode code points, not grapheme clusters, and performs no
normalization. Preserve that function and its behavior.

`text` is a string by precondition. `maxPoints` must be a nonnegative safe
integer. For every other value, including negative numbers, fractions, `NaN`,
`Infinity`, and values greater than `Number.MAX_SAFE_INTEGER`, throw a
`RangeError`. Validate `maxPoints` even when `text` is empty.

If the code-point length of `text` is at most `maxPoints`, return the original
text unchanged. If the text is longer than the limit and `maxPoints` is zero,
return the empty string. Otherwise return the first `maxPoints - 1` Unicode
code points followed by exactly one ellipsis (`\u2026`). The ellipsis counts as
one code point toward the limit.

Combining marks count separately from their base characters. Do not normalize
or otherwise change text that fits within the limit. Preserve all existing
exports and use the existing `countCodePoints` behavior.

The module must export:

```ts
export function countCodePoints(text: string): number;
export function truncateLabel(text: string, maxPoints: number): string;
```

## Edit scope

Edit `src/labels.ts` and `test/*.test.mjs` only. A brief under
`docs/tasks/` and a local `check-output.txt` verification log are also
allowed.

Run the fixture tests with:

```sh
npm test
```

In this experiment environment, redirect test output to
`check-output.txt` and read that file before reporting the result, for
example `npm test > check-output.txt 2>&1`. The command exit status still
matters. This note applies equally to both experiment arms.
