Fix `firstMatching(values, predicate)` in `src/first-match.mjs`.

The protected `Option` helper stores its payload in the public `val` property
and marks presence with `isSome`. Return the first matching value, or `null`
when none matches. Do not edit `src/option.mjs` or the tests.
