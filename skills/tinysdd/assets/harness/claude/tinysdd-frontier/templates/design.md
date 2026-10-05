# Design: <change name>

Status: draft

## Research inputs

- Proposal: <path and digest>
- Research record: <phase record ID or UNKNOWN>
- Compiled excerpts: <path and digest>
- Unresolved facts: <UNKNOWN items, or none>

The plan consumes the cited excerpts above. If a new repository fact is needed,
return to research and add an exact citation; do not fill the gap from memory.

## Interfaces and real callers

| Interface or caller | Source excerpt | Responsibility | Consumer slice |
| --- | --- | --- | --- |
| <src/entrypoint.mjs> | <context resource and lines> | <existing real entrypoint contract> | <slice ID> |

## Implementation design

- <requirement ID>: <smallest coherent implementation responsibility>.
- <requirement ID>: <error, state and compatibility behavior>.
- <caller/wiring obligation>: <which existing caller is connected and by which slice>.

## Test responsibilities

Strong preparation writes protected feature integration tests through the real
entrypoint. Small workers write writable slice tests with direct module imports.
Existing regressions and shared contracts stay protected unless explicitly
assigned.

- Feature test: <path>, protects <requirements>, enters through <entrypoint>.
- Slice test: <path>, imports <module directly>, checks <requirements>.
- Wiring test/review: <how disconnecting the caller fails the feature test>.

## Slice DAG and budgets

| Slice | Behavior | Implementation outputs | Writable slice tests | Depends on | Wiring |
| --- | --- | --- | --- | --- | --- |
| <change-s1> | <coherent behavior> | <paths> | <paths> | <IDs> | <yes/no and caller> |

Set maxImplementationFiles, maxSliceTestFiles and maxCompiledContextBytes
explicitly per change. These are advisory file sizing values; they are not a
universal file ceiling. Split async-dense tests by behavior when the validator's
sizing report recommends it.

## Integration obligations

- <integration ID>: requirements <IDs>; entrypoint <existing path>; wiring slice
  <slice ID>; protected test <path>; feature check <check ID>.

## Review and gate contract

- Every active task protects every feature test.
- A candidate is reviewed by exact bytes, including ordinary extra tests.
- A negative Jev assessment routes to a bounded revision under explicit policy.
- Every positive assessment requires independent strong review of the identical
  input digest and then operator acceptance.
- Exhaustion, unavailable, uncertain, stale or mismatched evidence escalates or
  stops according to explicit operator policy.

## Open decisions

- <decision or UNKNOWN; keep empty only when ready for operator review>.
