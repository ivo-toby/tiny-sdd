Fix `retry(operation, attempts)` in `src/retry.mjs` while satisfying the
repository's `require-await` lint rule.

Retry synchronous operations up to the requested attempt count and return the
first successful value. Rethrow the last error when every attempt fails. The
function does not await anything, so it must not be declared `async`; callers
may still await its synchronous return value.
