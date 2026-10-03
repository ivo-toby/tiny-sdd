# Task

Write `tests/contract.test.mjs` for the existing implementation in
`src/group-by.mjs`. Use this exact import interface:

```js
import { groupBy } from '../src/group-by.mjs';
```

`groupBy(items, keyOf)` returns groups with `key` and `items` fields. The test
file is the only writable path. Do not edit the source or the visible test.

## Acceptance criteria

| ID | Contract | Named witness |
| --- | --- | --- |
| C1 | Groups are ordered by the first occurrence of each key. | `C1 preserves first-seen group order` |
| C2 | Members retain their original order inside each group. | `C2 preserves member order within each group` |
| C3 | Calling `groupBy` does not mutate the input collection. | `C3 does not mutate the input collection` |

Use repeated keys and an intentionally non-sorted member order so each witness
tests its own invariant.
