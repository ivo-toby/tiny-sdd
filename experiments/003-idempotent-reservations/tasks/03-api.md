# Task 03: expose reservations through the app

Approval: supplied by the operator message, not by this file's label.
Source: FEATURE.md section 3 and the error/identity contracts in sections 1–2.
Read src/app.ts, src/service.ts, src/validation.ts and the existing app tests.
Prerequisites: tasks 01 and 02 passed review in this same repository.

Implement POST /reservations by connecting request parsing, validation, and the
per-app service. Preserve GET /health, GET /stock and unknown-route responses.
Verify the feature through createApp with real Request/Response values; no socket
or server process is needed or authorized.

Allowed changes: src/app.ts; new test/reservations-api.test.mjs;
docs/evidence/03-api.md; check-output.txt.
Do not edit earlier task implementations/tests or the feature specification.
Report upstream blockers for a separately scoped revision.

Observe new route tests fail for the missing route, then implement and run
npm test > check-output.txt 2>&1. Read output and retain actual exit status.
Cover the specified error distinctions and a complete create → second request →
replay → conflict → GET stock flow, including overlapping same-ID requests.

At the evidence path record self-review, actual verification and unresolved
findings. Hand back the integrated feature for operator review; do not add
endpoints, persistence, a network server, or dependencies.
