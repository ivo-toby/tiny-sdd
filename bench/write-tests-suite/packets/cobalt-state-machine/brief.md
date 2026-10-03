# Task

Write `tests/contract.test.mjs` for the existing implementation in
`src/state-machine.mjs`. Use this exact import interface:

```js
import { transition } from '../src/state-machine.mjs';
```

`transition(state, event)` returns a new state object. The test file is the
only writable path. Do not edit the source or the visible test.

## Acceptance criteria

| ID | Contract | Named witness |
| --- | --- | --- |
| C1 | Only `idle -> running` on `start`, `running -> succeeded` on `succeed`, and `running -> failed` on `fail` are legal. | `C1 accepts only legal state transitions` |
| C2 | `succeeded` and `failed` are terminal; every event from either state throws `RangeError`. | `C2 rejects events after a terminal state` |
| C3 | A legal transition returns a new object and leaves the input state unchanged while preserving extra fields. | `C3 returns a new state without mutating the input` |

Keep the illegal-transition assertions tied to the corresponding state and
event. Do not accept a plausible but invalid transition.
