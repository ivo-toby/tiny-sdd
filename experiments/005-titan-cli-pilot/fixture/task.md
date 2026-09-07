# Atomic version-checked batches

Extend the existing synchronous `createStore(seed)` object with
`applyBatch(operations)`. Preserve the current get/put behavior and original
tests. Change only `src/store.mjs` and add `test/batch.test.mjs`. No dependencies,
services, timers, globals or file I/O. This is one implementation task; do not
change this brief or baseline tests. The caller has approved this bounded pilot.

An operation is an ordinary object with own fields `key`, `expectedVersion`,
`value`, and no additional enumerable own string fields. Inputs/values are
JSON-compatible ordinary data; cycles, getters, class instances and resource
exhaustion are out of scope. Do not mutate inputs.

- `operations` must be a nonempty array with at most 16 entries.
- `key` must be a string matching `/^[a-z][a-z0-9_-]{0,31}$/`; duplicate keys
  within one batch are invalid.
- `expectedVersion` must be a nonnegative safe integer; zero means the key
  must be absent. `value` is required and may be null, false or nested JSON data.
- Validate the entire batch's shape and duplicates BEFORE checking versions.
  Any invalid shape returns exactly `{ok:false,error:"invalid_batch"}`, never
  throws for these malformed inputs, and leaves all entries/versions unchanged.
- Once shape is valid, compare every expectedVersion to the current store
  version (zero for absent), without changing state. Return the FIRST conflicting
  operation in input order as exactly
  `{ok:false,error:"version_conflict",key,expectedVersion,actualVersion}`.
  Any conflict leaves the whole store unchanged, including earlier operations.
- With all versions matched, apply every operation once in input order, with
  new version `expectedVersion + 1`, and return exactly
  `{ok:true,entries:[{key,value,version},...]}` in input order.
- Stored values and returned values must be detached from input values and each
  other. Mutating the result or later mutating an input cannot change stored
  data. Batch writes and existing put/get use the SAME state/version sequence.
- No idempotency cache: submitting the same expected versions twice conflicts
  the second time. Failed calls must not consume versions or create entries.

Write focused Node built-in tests in `test/batch.test.mjs`. Use exact result
assertions and check preserved state on rejection. Include a late conflict,
shape-invalid after an earlier version conflict, duplicate keys, boundary length
16/17, and nested mutation. Import the real module, not a test-only copy.

The edit-only worker cannot run commands. The caller will run
`node --test test/*.test.mjs` and independent checks in isolation. Report unrun
checks honestly and hand back changed files plus unresolved concerns. Do not
claim acceptance or perform another task.
