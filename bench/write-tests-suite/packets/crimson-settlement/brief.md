# Task

Write `tests/contract.test.mjs` for the existing implementation in
`src/settle.mjs`. Use this exact import interface:

```js
import { settleTasks } from '../src/settle.mjs';
```

`settleTasks(tasks)` accepts zero-argument task functions and returns a promise
of settlement records. The test file is the only writable path. Do not edit the
source or the visible test.

## Acceptance criteria

| ID | Contract | Named witness |
| --- | --- | --- |
| C1 | Fulfilled and rejected tasks become `fulfilled`/`rejected` records; one rejection does not reject the batch. | `C1 records fulfillment and rejection without rejecting the batch` |
| C2 | Result records stay in declaration order even when promises settle in another order. | `C2 keeps results in declaration order when completion order differs` |
| C3 | Every task starts before settlement is awaited, so independent tasks can run concurrently. | `C3 starts every task before awaiting settlement` |

Use deferred promises or equivalent deterministic control for C2 and C3. Do not
use timers or network access.
