# Task 03 — asynchronous generation and status adapters

Status: draft; approval and accepted tasks 01–02 required. Read
[feature.md](../feature.md), all observable behavior and factory interfaces,
the accepted job manager, server factory and generation schema/output types.

Allowed production changes: `src/server/create-mcp-server.ts`, `src/index.ts`,
optional new adapter modules `src/tools/async-generation.ts` and
`src/tools/job-status.ts`. Allowed tests: new `tests/server/async-tools.test.ts`.
Evidence: experiment-run `evidence/task-03.md`.

Inject `jobs` into the MCP factory; create one manager in bootstrap outside the
per-request server callback. Replace generation's awaited result with validated
submission and add `get_job_status`. Bind the injected generator inside the
submitted closure; its resolution gains the existing download URL. Implement
matching structured/text JSON responses and the specified not-found error.
This serialization change applies only to generation acceptance and job status;
publish retains its existing text-only success/error shape.
Update generation's description to submission/polling, removing the old advice
to wait minutes for the tool call. Preserve publish behavior and input schemas.

Exercise registration/validation through the real installed SDK with fake
dependencies (in-memory linked transports are sufficient here). Check A1–A5
and A8: acknowledgement before fake completion, schema rejection before submit,
state/result/error payloads, no polling side effects. Capture a submit spy for
invalid-input assertions; zero executor calls alone cannot prove no job exists.

Do not change accepted job-manager semantics or existing tests to fit the adapter.
Run focused checks, prior task checks, original regressions and build in isolation.
Stop for contradictions or broader required edits. Return observed evidence and
self-review; do not begin HTTP integration or claim full-feature acceptance.
