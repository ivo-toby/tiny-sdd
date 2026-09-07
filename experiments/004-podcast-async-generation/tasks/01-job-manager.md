# Task 01 — process-local generation jobs

Status: draft; actual operator approval required. No prerequisite implementation.
Read [feature.md](../feature.md), especially observable contract 2–7 and shared
job types. Inspect the existing TypeScript/test configuration before editing.

Implement the job types and manager, not MCP tools. Allowed production changes:
new `src/jobs/types.ts` and `src/jobs/job-manager.ts`. Allowed tests:
new `tests/jobs/*.test.ts`. Evidence: `evidence/task-01.md` in the experiment run,
not the source repository. No dependency or configuration changes.

Use deferred promises and an injected clock to exercise queued/running/success,
FIFO/exactly-once behavior, synchronous throw and promise rejection, queue
continuation, TTL boundaries, nonterminal retention, fresh-manager isolation,
and detached nested snapshots. See A3, A5–A8. Do not use long sleeps or real
generation. Include a positive witness that the second job actually starts
after the first, not merely that it was initially blocked.

Observe behavior-specific red evidence where feasible, then run focused tests,
the original suite and `npm run build` in the provided safe verification
environment. Missing modules/types alone are not behavior-specific red evidence.

Preserve all pre-existing files. Stop if the shared interface needs a semantic
change. Report observed checks, remaining gaps and self-review. Return for
operator/strong-model review; do not begin task 02.
