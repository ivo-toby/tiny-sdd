# Task 02 — injectable HTTP and MCP factories

Status: draft; approval and accepted task 01 required. Read
[feature.md](../feature.md), preserved behavior and shared factory seams, plus
`src/index.ts` and both existing tool modules. This task is extraction, not the
async tool switch.

Allowed production changes: `src/index.ts`, new
`src/server/create-app.ts`, `src/server/create-mcp-server.ts`.
Allowed tests: new `tests/server/factories.test.ts`.
Evidence: experiment-run `evidence/task-02.md`.

Move request/app construction and tool registration into the named factories.
Keep configuration, backend construction, directory creation and listening in
the entrypoint. Bind existing execution functions through closures. For this
task generation remains synchronous; the `jobs` dependency is added in task 03.
Keep publish conditional on an injected publish function and preserve its raw
public URL closure. Never execute the production entrypoint during this task.

Characterize preserved HTTP routes/errors, static serving from a private fixture,
conditional publish registration and fake publish success/error responses.
Verify importing factories neither listens nor constructs/calls real cores.
Use real SDK clients/transports where useful, bound only to `127.0.0.1:0`.
Do not freeze old generation response semantics or an exact old tool list in
these preservation tests: task 03 deliberately changes that contract.

Run focused tests, original regressions and `npm run build` in isolation. Review
the bootstrap diff against the original: no lost configuration or changed
transport defaults. Do not edit cores, schemas, package files, or existing tests.
If extraction requires broader changes, report the exact dependency and stop.
Return the patch and observed evidence for review; do not begin task 03.
