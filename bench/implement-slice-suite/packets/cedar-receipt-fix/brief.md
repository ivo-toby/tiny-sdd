Fix `parseReceipt(line)` in `src/receipt.mjs`.

Parse the exact format `id|amountCents`, where id is nonempty and amountCents
contains one or more decimal digits. Return `{ id, amountCents }` with a Number
amount. Reject non-string input and every malformed amount with an Error whose
message mentions `amount`; do not accept numeric prefixes or exponent notation.
