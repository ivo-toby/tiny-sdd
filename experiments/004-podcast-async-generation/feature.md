# Checkpoint contract: submit and poll generation

Approved for controlled execution through [operator delegation](approval.md);
not the complete async-generation/publishing feature or a release approval.

## Sources and existing facts

Repository and document hashes are in [baseline-inventory.md](baseline-inventory.md).
Read the target's `docs/SPEC-async-generation-publishing.md` for destination
behavior, `docs/research-async-mcp-jobs.md` for rationale and
`docs/implementation-plan-async-jobs.md` for the larger implementation plan.
This checkpoint narrows delivery scope; it does not replace those documents.

`src/index.ts` currently constructs configuration/backends, registers synchronous
tools and starts Express. Each POST gets a fresh MCP server and stateless
transport. The installed SDK is 1.29.0. `generatePodcast` and the publish handler
are reusable execution cores, but importing the entrypoint has side effects.
Generation's Zod schema and its later dual-host runtime checks are separate.
Publishing is currently registered only when a storage/feed backend is configured.
In installed SDK 1.29.0, `server/mcp.js` catches input-validation errors and
returns a tool result with `isError: true` and plain error text. The normal
`client.callTool()` path resolves that result; do not expect schema rejection
to reject the client promise or return our job-not-found JSON envelope.

## Proposed scope and preserved behavior

Implement process-local async `generate_podcast` and `get_job_status`, with
injectable execution and app/server factories. Verify real MCP submission and
polling across separate HTTP requests using deferred fake generation. Production
wiring may bind the existing core, but this experiment must never invoke it.

Preserve the generation input schema, defaults and execution core. Preserve the
existing conditional, synchronous publish tool and its response shape, including
its text-only success/error payloads and raw `PUBLIC_URL` handling. The dual
structured/text convention below applies only to the new async tools.
Preserve health, static output serving, body-size and
malformed-JSON handling, GET `/mcp` rejection, and fresh stateless transports.
No new dependencies or changes to storage/feed/audio/TTS/download cores.

**Intentional intermediate difference:** combined generation/publishing and
`EXPOSE_SEPARATE_TOOLS` are deferred. Therefore this checkpoint's tool visibility
does not satisfy the final specification. Do not release it as that feature.
At the completed checkpoint, `generate_podcast` and `get_job_status` are always
registered; `publish_podcast` is present only when its backend-bound handler is
provided. `generate_and_publish` is absent and `EXPOSE_SEPARATE_TOOLS` is not
implemented. Task 02 temporarily retains the original toolset until task 03.

## Observable contract

1. SDK/Zod schema validation happens before submission. A schema-invalid request
   creates no job and invokes no executor. Do not move the core's additional
   runtime validation into the schema or silently strengthen filename validation.
2. A valid generation submission returns immediately without awaiting execution:
   `{jobId, operation: "generate_podcast", status: "queued", stage: "queued",
   pollIntervalSeconds: 5, message}`. `jobId` is UUID v4; `message` tells callers
   to retain the ID, poll `get_job_status`, and not resubmit. Both MCP
   `structuredContent` and its single JSON text item contain the same object.
3. The acceptance response is a queued snapshot, even if work starts before the
   client receives it. The first poll may already report running or terminal.
   Jobs run once, FIFO, with at most one executor active per manager. Further
   submissions queue. Polling never invokes or retries execution.
4. `get_job_status({jobId})` validates a UUID string and returns a snapshot with
   `jobId`, `operation`, `status`, `stage`, `createdAt`, `updatedAt`; `startedAt`
   appears when running, `completedAt` when terminal. Timestamps are ISO strings.
   Generation goes queued/queued → running/generating → succeeded/completed or
   failed/failed. The clock may give equal timestamps; never require strict
   wall-clock increase. Reads do not change timestamps or extend retention.
5. Resolved generation is success under the supplied spec: retain the core's
   complete result and add `downloadUrl` using existing public-URL/filename
   composition. Do not invent a second success policy for `success: false` from
   an injected fake: the existing core resolves success or throws. A synchronous
   throw or rejected promise becomes failed with
   `error: {code: "job_execution_failed", message: "Job execution failed"}`.
   The static public message is a proposed safety choice; do not expose raw
   exception data. Catch background failures and continue to the next job.
6. Status responses use the same structured/text JSON convention. Missing or
   expired well-formed IDs return MCP `isError: true` with identical JSON payloads
   `{errorCode: "job_not_found", message: "Job not found"}`. Malformed IDs use
   the installed SDK's normal validation error; no custom error-envelope promise.
7. Retain terminal records for 24 hours from completion. At age **>= 24 hours**,
   lazily remove them during submit/status access. Queued/running records are
   never age-pruned. A fresh manager contains no records. Return detached
   snapshots, including nested results, so caller mutation cannot alter storage.
8. HTTP request/transport closure does not own or cancel a job. All fresh MCP
   servers created for one app share the same process-owned manager. Two app
   instances with different managers do not share jobs.

## Shared implementation seams

These are checkpoint-local TypeScript contracts, not a public TinySDD SDK.
Use `.js` import specifiers consistent with the repository's NodeNext setup.

`src/jobs/types.ts` exports recursive JSON value/object types and these records:

```ts
type JobOperation = 'generate_podcast';
type JobStatusName = 'queued' | 'running' | 'succeeded' | 'failed';
type JobStage = 'queued' | 'generating' | 'completed' | 'failed';
type JobError = { code: string; message: string };
type JobAccepted = {
  jobId: string; operation: JobOperation; status: 'queued'; stage: 'queued';
  pollIntervalSeconds: 5; message: string;
};
type JobStatus = {
  jobId: string; operation: JobOperation; status: JobStatusName; stage: JobStage;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
  result?: JsonObject; error?: JobError;
};
type JobExecutor = () => Promise<JsonObject>;
interface JobManager {
  submit(operation: JobOperation, executor: JobExecutor): JobAccepted;
  get(jobId: string): JobStatus | undefined;
}
```

`src/jobs/job-manager.ts` exports
`createJobManager(options?: {now?: () => number; retentionMs?: number}): JobManager`.
Default clock is `Date.now`; default retention is 86,400,000 ms. Tests inject a
finite monotonic clock and nonnegative retention. Executor results must be inert
JSON objects owned by the adapter; no arbitrary class instances or resources.
Catch even an executor that throws before returning a promise. Implement only
generation's stages now; later publishing can extend these types deliberately.

`src/server/create-mcp-server.ts` exports `createMcpServer(deps): McpServer`.
Its dependencies are `generate` with the existing generation input/output types,
`publicUrl: string`, optional `publish` with existing publish input/result types,
and (added by task 03) `jobs: JobManager`. Presence of `publish` controls existing
publish registration. Core configuration stays captured in bootstrap closures.

`src/server/create-app.ts` exports
`createApp({outputDir, createServer}): Express`, where `createServer` is a
zero-argument MCP server factory called per POST. Neither factory listens,
creates directories, reads environment configuration, or constructs real
backends. Preserve production SSE/default transport options. Use the installed
SDK client to consume Streamable HTTP in tests rather than changing its format.

`src/index.ts` remains the production bootstrap: validate configuration, construct
backends, create directories, bind existing cores, instantiate **one** manager,
create the app and listen. Do not import it in fake-path tests.

## Acceptance witnesses

| ID | Required observation |
| --- | --- |
| A1 | Deferred fake stays unresolved while a valid MCP call returns queued acceptance; structured/text payloads agree. |
| A2 | Empty filename and another schema-invalid input return errors, with zero executor calls and zero manager submissions. |
| A3 | Submit A/B: distinct UUID-v4 IDs; B cannot start until A finishes; each executes once; repeat polling leaves counts unchanged. |
| A4 | Separate HTTP requests observe running then terminal A with exact output fields/URL and stable stored timestamps on repeated polls. |
| A5 | Throwing and rejecting executors produce the safe failed record; the next queued job succeeds; no unhandled rejection. |
| A6 | Known terminal exists just before TTL, disappears at boundary; long-running and queued records survive; fresh manager cannot find old ID. |
| A7 | Mutating a returned nested result or acceptance/status snapshot cannot corrupt a later read. |
| A8 | Unknown/malformed IDs follow their distinct contracts; polling never creates work. |
| A9 | Fresh request servers share jobs; a separate manager cannot see them; app and transport cleanup leave no pending listeners. |
| A10 | Existing regressions and real TypeScript build pass; factory imports are side-effect free; preserved HTTP/publish behavior still works with fakes. |

## Explicit limits / later release decisions

No combined operation, async publish, stage hooks, visibility flag, deployment,
Docker changes, persistence, retries, cancellation or native MCP Tasks.
No fake path reaches Google, remote media, S3, RSS, or real generation/publishing.

The supplied spec does not bound queue size or define a generation deadline.
Keep those policies unchanged for this controlled checkpoint, using only tiny
fixtures and two or three concurrent submissions. **TTL is not a memory bound**:
queued/running jobs may accumulate and a stuck core can block the worker.
Capacity/admission and stalled-job policy remain release decisions, not solved
requirements. Existing generation filename safety and lost-acknowledgement
recovery also remain limitations; do not claim the async wrapper fixes them.
