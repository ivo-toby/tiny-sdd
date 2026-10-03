# Task

Write `tests/contract.test.mjs` for the existing implementation in
`src/emitter.mjs`. Use this exact import interface:

```js
import { createEmitter } from '../src/emitter.mjs';
```

`createEmitter()` returns an object with `subscribe(listener)` and `emit(value)`.
The test file is the only writable path. Do not edit the source or the visible
test.

## Acceptance criteria

| ID | Contract | Named witness |
| --- | --- | --- |
| C1 | Subscribing the same function twice invokes it once per emission. | `C1 deduplicates the same subscription` |
| C2 | An emission uses a snapshot in subscription order; removing a later listener during dispatch affects the next emission only. | `C2 dispatches a snapshot in subscription order` |
| C3 | Unsubscribing removes only its target listener and can safely be repeated. | `C3 removes only the target subscription and is idempotent` |

Use two listeners and two emissions for C2 so a live collection iteration cannot
hide behind a passing one-listener case.
