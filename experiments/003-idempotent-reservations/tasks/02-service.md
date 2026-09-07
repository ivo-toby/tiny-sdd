# Task 02: atomic reservation service with replay

Approval: supplied by the operator message, not by this file's label.
Source: FEATURE.md section 2 and the normalized command in section 1. Read
src/service.ts, src/validation.ts and src/inventory.ts. Prerequisite: task 01
passed review; consume its interface without redefining it.

Implement createReservationService.reserve using the existing reserveBatch.
Preserve getStock behavior and isolate all mutable inputs/outputs. The service
is synchronous and owns successful request bindings for its lifetime.

Allowed changes: src/service.ts; new test/service.test.mjs;
docs/evidence/02-service.md; check-output.txt.
Do not edit validation, inventory, the app, or tests from earlier work. If an
upstream defect blocks this contract, report it for a separately scoped revision.

Observe new service tests fail for the stub, then implement. Run
npm test > check-output.txt 2>&1, read the log, and retain actual exit status.
Exercise creation, replay after other requests, conflict, rejection without key
binding, duplicate-item rollback, defensive copies, and independent instances.

Caller-ownership acceptance witness: start a fresh service with {pen:5}.
Pass a normalized command r1 with [pen:2] directly to reserve; expect creation
and stock {pen:3}. Afterwards change the caller's line quantity to 1. Submitting
that changed command must conflict; submitting a fresh r1 with the original
[pen:2] must replay the original success, with current stock still {pen:3}.
Repeat from a fresh service after mutating the caller's lines array instead of
a line object. This is separate from checking that reserve itself does not
mutate its input.

Stop for a prerequisite/interface mismatch rather than silently changing the
feature. Record self-review, observed results and gaps at the evidence path.
Hand back this task; do not begin route integration.
