# Task 01: normalize a reservation request

Approval: supplied by the operator message, not by this file's label.
Source: FEATURE.md section 1. Read src/validation.ts and the ReservationLine type
in src/inventory.ts. The feature's other sections establish consumers, not work
authorized in this task. No prior implementation task is required.

Implement validateReservation and its exported contract. The app and service are
not yet expected to support reservations. Do not implement them early.

Allowed changes: src/validation.ts; new test/validation.test.mjs;
docs/evidence/01-validation.md; check-output.txt.
Existing fixture tests and src/inventory.ts remain untouched. A separate new test
file fits this repository's existing discovery; do not replace its regressions.

Observe new validation tests fail for the stub behavior, then implement and run
npm test > check-output.txt 2>&1. Read the log and retain actual exit status.
Cover valid normalized copies, rejected shape/bounds, and no coercion/mutation.

Stop for a contract contradiction or an unavailable required interface. End with
the evidence path and handoff; do not start task 02. Record self-review and any
unrun checks or red-evidence gap in the evidence document.
