# Task

Write `tests/contract.test.mjs` for the existing implementation in
`src/options.mjs`. Use this exact import interface:

```js
import { normalizeOptions } from '../src/options.mjs';
```

The test file is the only writable path. Do not edit the source or the visible
test.

## Acceptance criteria

| ID | Contract | Named witness |
| --- | --- | --- |
| C1 | Omitted options use `timeoutMs: 5000` and `headers: {}`; explicit values are preserved. | `C1 defaults omitted options without dropping explicit values` |
| C2 | `timeoutMs` must be an integer; numeric strings are rejected with `RangeError`. | `C2 rejects non-integer timeout values instead of coercing them` |
| C3 | `timeoutMs` is inclusive from 1 through 60000. | `C3 enforces the inclusive timeout bounds` |
| C4 | Header names are lowercased while values, including an empty string, are retained. | `C4 canonicalizes header names while retaining their values` |

Keep each witness as a substantive assertion about its named invariant. Do not
add tests outside this contract.
