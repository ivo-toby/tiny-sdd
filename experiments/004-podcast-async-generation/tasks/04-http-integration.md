# Task 04 — cross-request fake-path verification

Status: draft; approval and accepted tasks 01–03 required. Read
[feature.md](../feature.md), [protocol.md](../protocol.md), both server factories
and prior task tests. This task verifies the integrated checkpoint; it does not
add combined publishing or new production behavior.

Allowed changes: new `tests/server/async-http.test.ts`, supporting test helpers
under `tests/server/helpers/`, and new
`docs/async-generation-checkpoint.md` in the disposable target. Evidence:
experiment-run `evidence/task-04.md`. No production or existing-test edits.
If integration exposes a production defect, report it and stop for a separately
scoped revision rather than concealing a fix inside test work.

Start the real Express factory on ephemeral loopback with one shared manager,
fresh MCP servers/transports, a private output directory and deferred fake
generation. Use installed SDK Streamable HTTP clients. No mock of MCP routing,
input validation, job manager, serialization or transport. Close all clients and
listeners and settle outstanding fakes in cleanup, including failure paths.

Prove A1–A4 and A8–A9 across separate HTTP requests: queued acknowledgement while
fake is held; running poll; second job blocked; first resolved; exact terminal
result; second starts and completes; repeated polling adds no execution; another
manager cannot see the ID. Include a failed job followed by successful work.
For that failure assert `status: "failed"`, `stage: "failed"`, the exact safe
`job_execution_failed` error, queue continuation and no unhandled rejection (A5).
Use explicit deferred gates and bounded condition polling, not timing sleeps as
the correctness oracle. Test timeouts are watchdogs, not job deadline semantics.

Document the intermediate toolset, fake-only verification, how to run checks,
what remains before full feature/release, and the absence of real provider calls.
Run focused integration, all tests and `npm run build`. Coordinator additionally
checks the built factory modules with a fake-only smoke path. Return observed
evidence; checkpoint acceptance remains an operator decision.
