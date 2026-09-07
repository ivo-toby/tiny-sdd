# TinySDD prototype architecture

**Status:** historical prototype draft; deferred exploration  
**Date:** 2026-09-04  
**Scope:** standalone one-feature, one-active-task vertical slice  
**Tagline:** Spec-driven development for capable models that fit on your machine.  
**Current scope:** [current-scope.md](current-scope.md)

> Historical exploration notice: This 2026-09-04 prototype architecture is
> retained for reference. [current-scope.md](current-scope.md) is authoritative;
> this document is not an approved v0 requirement or implementation prerequisite.

## 1. Decision summary

TinySDD is an artifact compiler and guarded execution runtime for software
development. It is not a chat wrapper and it does not ask a model to remember or
infer the workflow.

The prototype will:

- run one feature branch and one task at a time;
- turn human intent into versioned requirements, research, design, acceptance,
  and task artifacts;
- compile one self-contained stage packet per fresh model call;
- expose only controller-enforced repository and check tools;
- record all authoritative observations outside model output;
- stop on unknown contracts, missing context, stale approvals, scope expansion,
  and unsupported decisions;
- test the complete mechanism against a frozen contract-fabrication benchmark.

The prototype will not include parallel agents, WDD integration, task worktrees,
cross-model scheduling, arbitrary shell access, automatic merge, or a production
fast path.

### Architectural decisions

| ID | Decision | Reason |
| --- | --- | --- |
| `ADR-P1` | Implement the prototype in TypeScript on Node.js 24. | Pi's supported SDK can create in-memory fresh sessions, select the configured models, accept custom tools, and expose event/usage data in-process. A Python controller would require both an RPC client and a separate TypeScript tool extension. Pi remains behind an adapter boundary. |
| `ADR-P2` | Store authoritative controller history as immutable event files and derive `state.json`. | A crash can be recovered by replay; every transition remains inspectable; no database migration is needed for the vertical slice. |
| `ADR-P3` | Keep meaning-bearing artifacts in Markdown or JSON and machine-generate indexes/manifests. | Humans approve readable artifacts while the controller validates references and digests without treating generated views as truth. |
| `ADR-P4` | Pass hot prompts inline. Use the Pi SDK in-process; any future CLI adapter must use an argument vector or framed standard input, never shell source. | The Pi pilot showed attachment ambiguity and shell interpolation corrupting prompts. |
| `ADR-P5` | Make model output schema validation strict, with only declared deterministic envelope normalization. | Both target runtimes can produce useful structured results, but fenced JSON occurs. Syntax envelopes may be normalized; meaning may not be repaired. |
| `ADR-P6` | Allow model mutations only through controller repository tools. | Post-hoc Git inspection detects some breaches but does not provide a safe execution boundary. |
| `ADR-P7` | Run checks as pre-approved argument vectors with `shell=false`. | Prompts, model output, paths, and check arguments must never become executable shell syntax. |
| `ADR-P8` | Include grounded repository/contract research in the first vertical slice. | Omitting it makes the contract-fabrication benchmark incapable of testing the central hypothesis. |
| `ADR-P9` | Commit approved planning artifacts before task readiness. | Readiness requires a clean tree; approved but uncommitted artifacts would otherwise conflict with that invariant. |
| `ADR-P10` | Treat the Pi CLI as one adapter, not as TinySDD's architecture. | Pi provides access to useful runtimes. The controller protocol must also support direct OpenAI-compatible endpoints and future local CLIs. |

These decisions are prototype defaults. Changing one requires a written
replacement decision and corresponding acceptance-fixture update.

## 2. Trust model

### Trusted for mechanics

- TinySDD controller code and schemas.
- The local filesystem and Git executable within their observed results.
- Controller-spawned commands identified by an approved command ID.
- Human approval entered through a controller command that is never exposed as a
  model tool.

### Untrusted or advisory

- Model prose, structured fields, and completion status.
- Model claims that it read a file, changed a path, ran a command, or received an
  approval.
- Repository text, comments, fixtures, generated files, and dependency content;
  these can contain prompt injection.
- Tool arguments until the controller validates them.
- Runtime-advertised context size until the runtime/protocol pair is qualified.
- A same-model fresh-context review as evidence of independence.

The controller can establish that an action occurred. It cannot establish that a
requirement reflects the user's intent; that remains a human approval decision.

### Assurance levels

| Level | Boundary | Prototype use |
| --- | --- | --- |
| `guarded_tools` | The model receives only TinySDD read/search/patch/check tools; every argument is validated. No arbitrary process tool exists. | Required for every write stage. |
| `os_sandbox` | Guarded tools plus an operating-system sandbox for the adapter process. | Optional hardening when available. |
| `audit_only` | A general coding CLI writes freely and TinySDD checks Git afterward. | Experiment control only; never described as sandboxed and never accepted for a TinySDD task commit. |

Network access is off for executor and reviewer stages. Contract acquisition is a
separate controller/human action whose retrieved content receives a digest and
becomes a cited source.

## 3. System components

```text
CLI / driver
    |
    v
Controller ----> Artifact store
    |                 |
    |                 v
    |            Prompt compiler
    |                 |
    v                 v
Repository tools <-> Runtime adapter <-> local/remote model endpoint
    |
    v
Git + command runner ----> Evidence store
```

### 3.1 Controller

The controller is the only component allowed to:

- choose the next transition;
- create authoritative events;
- project current state;
- declare artifacts, approvals, evidence, or reviews stale;
- enable stage tools;
- accept a stage result;
- create checkpoint commits.

It is deterministic over configuration, events, artifact bytes, Git state, and
observed command results. It never decides product meaning.

### 3.2 Artifact store

The store owns atomic reads/writes, SHA-256 digests, immutable evidence blobs,
artifact versions, and dependency edges. Models return candidate artifact
content to the controller; they do not write approved artifacts directly.

### 3.3 Prompt compiler

The compiler turns one action plus exact artifact versions into a stage packet.
It calculates tokens with the qualified runtime tokenizer when available and a
conservative adapter estimator otherwise. Compilation fails rather than
truncating required content.

### 3.4 Runtime adapters

Adapters translate a stage packet and bounded tools to one runtime protocol.
They do not select stages, relax schemas, or interpret a nearly valid result.

The adapter boundary has two implementations in the design:

1. `PiSdkAdapter`, implemented first, for the model registry already available
   through Pi.
2. `OpenAICompatibleAdapter`, deferred until after the vertical slice, for
   direct local endpoints.

The Pi adapter must support write-enabled guarded tool calls for the first
end-to-end slice. A runtime can qualify for read-only artifact stages without
qualifying for task execution.

### 3.5 Repository environment

The environment canonicalizes paths, prevents symlink escape, enforces exact
phase write sets, snapshots the workspace, and exposes bounded search/read/patch
operations. It never forwards a model-authored shell command.

### 3.6 Command and evidence runner

Checks are configuration objects, not strings:

```json
{
  "id": "CHK-unit-report-client",
  "argv": ["python", "-m", "pytest", "-q", "tests/test_report_client.py"],
  "cwd": ".",
  "timeoutSeconds": 120,
  "allowedExitCodes": [0],
  "environment": {},
  "network": "disabled"
}
```

The runner uses `shell=false`, a minimal inherited environment, a bounded output
preview, and a content-addressed full-output blob. A check result binds to the
check-spec digest and exact workspace snapshot.

### 3.7 TypeScript package boundaries

```text
src/
  cli/                 # argument parsing and human presentation
  controller/          # next-action policy, transitions, reducer, invalidation
  events/              # canonical serialization, lease, append, replay
  artifacts/           # digests, atomic store, parsers, indexes, trace graph
  prompts/             # selection, budgeting, rendering, packet manifests
  repository/          # snapshots and guarded search/read/patch/status
  commands/            # approved argv runner and evidence capture
  adapters/
    adapter.ts         # runtime-neutral request/result/event contract
    pi/                # only package allowed to import Pi SDK
    openai/            # deferred implementation
  stages/              # stage-specific schemas and deterministic guards
  git/                 # branch, clean-tree, ancestry, exact-path commit support
```

Dependency direction is inward: CLI and adapters depend on controller ports;
controller depends on domain schemas and store/repository/command ports. Core
modules never import Pi SDK types. No module outside `commands/` and `git/` may
spawn a process, and both use argument arrays with `shell: false`.

## 4. On-disk layout

```text
.tinysdd/
  config.json
  constitution.md
  project/
    overview.md
    commands.json
    runtimes/<runtime-id>.json
  control/                         # controller-owned; ignored by Git
    lock/                            # atomic single-controller lease directory
    events/00000001-<event-sha256>.json
    state.json                     # disposable projection
    blobs/sha256/<digest>
  work/<feature-id>/               # tracked on the feature branch
    request.md
    answers.md
    requirements.md
    requirements.index.json        # generated
    repo-map.json
    contracts.json
    design.md
    design.index.json              # generated
    acceptance.json
    tasks.json
    tasks/T-001.md
    approvals/<kind>.json          # generated human-approval receipt
    packets/<stage-id>.manifest.json
    reviews/<review-id>.json
    evidence/<evidence-id>.json
    checkpoints/<checkpoint-id>.json
    handoff.md
  runtime/                         # transient adapter logs; ignored by Git
```

Meaning has one editable owner:

- `request.md` and `answers.md` preserve human input verbatim.
- Requirements behavior is owned by `requirements.md`.
- Read repository and contract facts are owned by `repo-map.json` and
  `contracts.json`.
- Technical choices are owned by `design.md`.
- Checks and oracle provenance are owned by `acceptance.json`.
- Task order and metadata are owned by `tasks.json`; the task's execution
  contract is owned by its brief.
- `*.index.json`, packet manifests, approvals, reviews, evidence, checkpoints,
  and handoff tables are generated or append-only records, not alternate truth.

## 5. Authoritative event log

Every event is one immutable canonical JSON file. The Linux prototype permits
one mutating controller process. It acquires the lease by atomically creating the
`control/lock/` directory and writes `owner.json` containing hostname, PID,
process start time, controller instance ID, and acquisition time.

Every TinySDD process treats the lease as mandatory even though filesystem locks
are cooperative. If the owning process is alive, a second mutating controller
fails immediately. If the process died, a recovery command verifies hostname,
PID, and process start time, atomically renames the stale directory to
`lock.abandoned-<id>/`, acquires a new lease, and replays the log. An ambiguous
remote-host or reused-PID lease requires human recovery. The operating system
releases no state on behalf of this directory lock; stale recovery is therefore
an explicit, tested operation.

With the lease held, the controller:

1. replays and validates the current log head;
2. constructs the next event without a self-digest field;
3. serializes it as UTF-8 JSON with sorted keys, compact separators, and one
   trailing LF;
4. computes SHA-256 over those exact bytes;
5. writes and flushes a temporary file, then atomically renames it to
   `events/<sequence>-<sha256>.json` and flushes the directory;
6. deterministically projects all events and atomically replaces `state.json`;
7. releases the lease after the complete controller action.

Replay sorts by the fixed-width sequence prefix and, before reducing any event,
verifies the event schema, contiguous sequence, filename digest, exact byte
digest, and `previousEventSha256` link. The first event uses `null`. Any failure
blocks projection replacement and every mutation. `state.json` includes the last
sequence and event digest; readers replay whenever those do not match the event
directory head.

If a crash occurs:

- an event without an updated projection is recovered by validated replay;
- a blob or candidate artifact without an event is unreferenced and ignored;
- a projection can never authorize work beyond the validated event head;
- a partial temporary file is never an event and can be quarantined later;
- a broken sequence, filename digest, hash chain, or event schema blocks all
  mutations.

### Event envelope

```json
{
  "schema": "tinysdd.event.v1",
  "sequence": 42,
  "eventId": "01J...",
  "type": "task.verification_completed",
  "recordedAt": "2026-09-04T12:00:00Z",
  "actor": {"kind": "controller", "id": "tinysdd/0.1.0"},
  "featureId": "F-report-client",
  "taskId": "T-001",
  "inputs": [
    {"kind": "task_brief", "path": "tasks/T-001.md", "sha256": "..."}
  ],
  "workspace": {"head": "<git-oid>", "snapshot": "sha256:..."},
  "runtime": null,
  "data": {"evidenceIds": ["EV-004", "EV-005"]},
  "previousEventSha256": "..."
}
```

Timestamps aid diagnosis but never determine transitions. Sequence, digests, and
explicit events do.

### Actor kinds

- `human`: an interactive approval or answer. The receipt records the asserted
  display name and local OS identity; this is attribution, not cryptographic
  identity.
- `controller`: deterministic mechanics.
- `runtime`: model-produced candidate or review, always with a full fingerprint.

Model adapters are never given a tool that can create a `human` event.

## 6. Artifact graph and invalidation

Every accepted artifact version records its direct inputs:

```text
request + answers
    -> requirements
requirements
    -> repo-map + contracts
requirements + repo-map + contracts
    -> design
requirements + design + contracts
    -> acceptance
requirements + design + acceptance + repo-map
    -> tasks
tasks + selected requirement/design/check IDs
    -> task brief
task brief + exact excerpts + workspace snapshot
    -> stage packet
stage packet + tool trace + workspace snapshot
    -> stage result / review / evidence
```

On any accepted input change, the controller traverses reverse dependency edges
and emits staleness events for every dependent approval, packet, readiness
record, verification, review, and unstarted task brief.

Prototype invalidation is artifact-granular, deliberately conservative. Stable
IDs provide traceability, but partial ID-level invalidation is deferred until
whole-artifact invalidation is proven correct.

Completed task commits are historical facts and are never erased. If an upstream
artifact changes after a task commit, the task becomes `DONE_STALE`; feature
acceptance is blocked until a newly approved plan revalidates it or adds a repair
task.

### Digest rules

- Artifact approvals bind to SHA-256 of exact bytes; no newline or semantic
  canonicalization occurs.
- Generated indexes record both source digest and generator version.
- Repository citations record repository-relative path, source-blob digest,
  locator, and excerpt digest. Line numbers are presentation aids, not identity.
- External sources are stored as immutable local snapshots before citation.

## 7. Lifecycle

The controller owns the following prototype graph. The model receives only the
current action; it is never asked to infer this graph from prose.

```text
REQUEST
-> CLARIFY
-> REQUIREMENTS_DRAFT
-> REQUIREMENTS_AUDIT
-> REQUIREMENTS_APPROVAL
-> RESEARCH
-> DESIGN_ACCEPTANCE_DRAFT
-> DESIGN_AUDIT
-> DESIGN_APPROVAL
-> PLAN_DRAFT
-> PLAN_AUDIT
-> PLAN_APPROVAL
-> PLANNING_CHECKPOINT
-> TASKS
-> FEATURE_ACCEPTANCE
-> DELIVERY_APPROVAL
-> DELIVERED
```

Clarification may be a deterministic skip only when the human records that the
request already closes all questions emitted by the interviewer. Research may
record `NOT_APPLICABLE` only with a concrete reason and no required external or
shared contract surface. The contract benchmark can never skip research.

### Feature transitions

| Current | Successful event | Required guards | Next |
| --- | --- | --- | --- |
| `REQUEST` | `request.captured` | immutable request bytes written | `CLARIFY` |
| `CLARIFY` | `answers.recorded` or attributed skip | no unanswered material question | `REQUIREMENTS_DRAFT` |
| `REQUIREMENTS_DRAFT` | `requirements.candidate_accepted` | schema/ID lint passes | `REQUIREMENTS_AUDIT` |
| `REQUIREMENTS_AUDIT` | `requirements.audit_passed` | no blocker/major finding | `REQUIREMENTS_APPROVAL` |
| `REQUIREMENTS_APPROVAL` | `requirements.approved` | interactive human receipt binds exact digest | `RESEARCH` |
| `RESEARCH` | `research.completed` | every required contract surface is cited, waived, or explicit unknown; required unknowns block | `DESIGN_ACCEPTANCE_DRAFT` |
| `DESIGN_ACCEPTANCE_DRAFT` | `design.candidate_accepted` | design and acceptance structural/trace lint passes | `DESIGN_AUDIT` |
| `DESIGN_AUDIT` | `design.audit_passed` | no blocker/major finding | `DESIGN_APPROVAL` |
| `DESIGN_APPROVAL` | `design.approved` | human receipt binds requirements, research, design, and acceptance digests | `PLAN_DRAFT` |
| `PLAN_DRAFT` | `plan.candidate_accepted` | one-task prototype constraints and trace lint pass | `PLAN_AUDIT` |
| `PLAN_AUDIT` | `plan.audit_passed` | no blocker/major finding | `PLAN_APPROVAL` |
| `PLAN_APPROVAL` | `plan.approved` | human receipt binds plan and every brief digest | `PLANNING_CHECKPOINT` |
| `PLANNING_CHECKPOINT` | `planning.committed` | artifact/receipt commit created; worktree clean | `TASKS` |
| `TASKS` | `all_tasks.done` | every task committed and current | `FEATURE_ACCEPTANCE` |
| `TASKS` | `task.needs_replan` | task found a new decision/contradiction, exceeded retry policy, or became stale | `PLAN_DRAFT` after invalidating plan approval, planning checkpoint authority, packets, and affected task state |
| `TASKS` | `task.needs_research` | task found an uncited repository or contract fact required by the approved design | `RESEARCH`; open a new research artifact version that supersedes the prior version, then invalidate dependent design, acceptance, plan, and task state |
| `TASKS` | `task.needs_human` | product meaning, accepted risk, or recovery authority is required | `TASKS_BLOCKED` until an attributed human decision routes to its owning artifact |
| `FEATURE_ACCEPTANCE` | `feature.acceptance_passed` | every acceptance row has current controller evidence | `DELIVERY_APPROVAL` |
| `FEATURE_ACCEPTANCE` | `feature.acceptance_failed` | failed row identifies its owning requirement/design/task | `PLAN_DRAFT` or `RESEARCH`; controller records the chosen mechanical route and invalidates dependants |
| `DELIVERY_APPROVAL` | `delivery.approved` | interactive human receipt binds handoff and branch head | `DELIVERED` |

An audit failure returns to the artifact owner, not to the next model stage. A
human rejection likewise returns with explicit comments and creates no approval.
`TASKS_BLOCKED` is not a retry loop: `next` emits only the recorded human action
needed to continue.

### Task transitions

```text
PENDING
-> READINESS
-> RED
-> IMPLEMENT
-> VERIFY
-> REVIEW
-> FIX       # at most two complete verify/review loops
-> COMMIT
-> DONE
```

| State | Advance guard | Stop/failure behavior |
| --- | --- | --- |
| `READINESS` | Controller validates packet completeness; read-only runtime reports no semantic contradiction or unknown. | Structural mismatch is a controller error. Semantic unknown returns to research/design/plan according to its owner. |
| `RED` | Approved check fails with the exact expected behavioral failure and no collection/syntax/unrelated failure. | Unexpected pass or wrong failure creates `red.needs_diagnosis`; implementation remains disabled. |
| `IMPLEMENT` | Diff stays within implementation write set; protected red files unchanged; focused check passes. | New decision/interface/file/dependency returns `NEEDS_REPLAN`; any observed scope breach invalidates the stage. |
| `VERIFY` | Every required focused, oracle, static, and regression check passes at one snapshot. | One bounded diagnosis/fix attempt; repeated failure returns to plan or human. |
| `REVIEW` | Required review level has no blocker or major finding and binds the verified snapshot. | Findings enter `FIX`; any mutation makes all verification/review evidence stale. |
| `FIX` | Full verification and review rerun successfully. | After two blocking rounds, split/re-specify, change reviewer/runtime, or request human judgment. |
| `COMMIT` | Current approvals, evidence, review, write-set check, and clean index are valid. | Commit is refused; no best-effort completion. |

The red phase may write only declared test/fixture paths. The implementation and
fix phases treat those paths as protected unless the approved finding explicitly
authorizes a test correction and returns through red again.

## 8. Stage packet protocol

The model-visible packet is generated; models and humans never edit it.

```json
{
  "schema": "tinysdd.stage_packet.v1",
  "packetId": "PKT-...",
  "stage": "task.implement",
  "action": "Make CHK-4 pass by implementing T-001 only.",
  "identity": {
    "featureId": "F-report-client",
    "taskId": "T-001",
    "attempt": 1
  },
  "authority": {
    "readRefs": ["REQ:AC-7", "DES:IF-2", "SRC:jobs-service"],
    "writePaths": ["src/projects/delete.py"],
    "protectedPaths": ["tests/test_project_delete.py"],
    "tools": ["repo.search", "repo.read", "repo.patch", "repo.status", "stage.finish"],
    "checkIds": [],
    "decisionBudget": []
  },
  "inputs": [
    {"ref": "REQ:AC-7", "sha256": "...", "included": true, "content": "..."}
  ],
  "workspace": {"head": "...", "snapshot": "sha256:..."},
  "evidence": [{"id": "EV-red", "sha256": "...", "preview": "..."}],
  "stopConditions": ["missing_source", "new_file", "new_dependency", "new_interface", "unlisted_decision"],
  "resultSchema": "tinysdd.stage_result.task_implement.v1"
}
```

The packet's `authority` block explains the boundary to the model; it does not
grant authority. Before invoking a runtime, the controller creates an immutable
in-memory execution capability:

```json
{
  "callId": "CALL-...",
  "packetSha256": "...",
  "startingWorkspaceSnapshot": "sha256:...",
  "readPaths": ["src/jobs/service.py"],
  "writePaths": ["src/projects/delete.py"],
  "protectedPaths": ["tests/test_project_delete.py"],
  "toolNames": ["repo.read", "repo.patch", "repo.status", "stage.finish"],
  "checkIds": [],
  "expiresAt": "..."
}
```

Custom tool closures capture this capability from the controller. The model
cannot submit, replace, or select a capability or `callId`; those fields are not
tool arguments. Every tool invocation rechecks expiry, packet digest, starting
snapshot lineage, and the capability's server-side paths/IDs. A conflict between
the explanatory packet and the capability is a controller invariant failure and
terminates the stage before any effect.

Capability expiry aborts the Pi session and signals every in-flight tool. Patch
tools recheck expiry and the starting blob immediately before their atomic
replace. Command tools spawn a dedicated process group, send termination on
abort, and force-kill it after a configured grace period. Results or SDK events
arriving after abort/disposal are retained only as late diagnostics and can
never create evidence or advance state.

### Compilation rules

1. Place action, identity, and authority first.
2. Include every required hot source. A missing reference is a compilation error,
   not a runtime judgment.
3. Label repository/external excerpts as untrusted data and retain source digest.
4. Include bounded evidence previews with references to immutable full blobs.
5. Repeat stop conditions and the result schema at the end of the rendered
   prompt.
6. Emit a tracked packet manifest containing ordered input digests, token counts,
   compiler version, runtime tokenizer/estimator, and output reserve.
7. If the packet exceeds the qualified limit, return `TASK_TOO_LARGE`; never
   silently summarize or truncate an approved source.

The starting hot-context target remains 24K tokens, with at least 25% of the
qualified served window reserved for output and tool observations. These are
experiment parameters, not invariants. Each runtime can qualify at a lower cap.

### Decision budget

The decision budget is structured and enumerated:

```json
[
  {
    "id": "DEC-T1-1",
    "question": "Use the existing sync or async helper?",
    "allowed": ["existing_sync_helper", "existing_async_helper"],
    "default": "existing_sync_helper"
  }
]
```

An empty list means no local choices. “One bounded choice” without enumerated
options is invalid.

## 9. Stage result handling

### Normalization pipeline

1. Preserve raw output as an immutable blob.
2. If the runtime used a qualified native structured-output mode, take its
   structured value.
3. Otherwise attempt an exact JSON parse.
4. If the runtime capability explicitly enables `single_json_fence`, remove one
   outer Markdown JSON fence only when no other non-whitespace text exists.
5. Validate the resulting value against the exact stage schema.
6. Reject unknown fields unless that schema opts into them.
7. On failure, return one concise schema diagnostic. A second failure ends the
   attempt as `ADAPTER_OUTPUT_INVALID`.

No normalizer may close braces, change a status, infer a field, select among
multiple objects, or translate prose into JSON.

### Common result envelope

```json
{
  "schema": "tinysdd.stage_result.v1",
  "packetId": "PKT-...",
  "status": "DONE|NEEDS_CONTEXT|NEEDS_REPLAN|BLOCKED",
  "summary": "...",
  "observedConcerns": [],
  "decisions": [],
  "requestedRefs": []
}
```

Stage-specific fields extend this envelope. `DONE` is merely a proposal. The
controller advances only after comparing the result with tool traces, artifact
schemas, workspace snapshots, and transition guards.

### Reconciliation order

For every call, the controller decides the outcome in this order:

1. adapter process/session completed within its deadline;
2. every tool call was enabled and schema-valid under the server-side execution
   capability;
3. the observed tool trace and before/after workspace snapshots contain no
   violation;
4. every controller-required command/evidence guard for the stage is satisfied;
5. the `stage.finish` value or normalized output is schema-valid;
6. the model's proposed status is compatible with observations.

Contradictory observations win. For example, `DONE` plus a failed required check
becomes `STAGE_GUARD_FAILED`; `DONE` plus an unauthorized patch becomes
`SCOPE_BREACH`; a claimed read without a corresponding tool observation is not
added to the read set. The controller never edits the model result to make it
consistent—it records both the proposal and its own outcome.

## 10. Model tool surface

### `repo.search`

- Accepts literal/regex query, repository-relative path filters, and maximum
  result count.
- Returns at most five files and thirty lines around each match by default.
- Reports total match count and truncation explicitly.
- Never searches `.git`, `.tinysdd/control`, secrets, or paths outside the
  repository.

### `repo.read`

- Accepts a canonical repository-relative path and bounded line or byte range.
- Rejects absolute paths, `..`, NUL bytes, symlinks escaping the repository,
  control state, and configured secret patterns.
- Defaults to 200 lines and records path, blob digest, and observed range.

### `repo.patch`

- Accepts one unified diff for one authorized path.
- Revalidates authorization and starting blob digest immediately before apply.
- Applies atomically or not at all.
- Returns applied hunks, post-write digest, and concise diff statistics.
- Cannot create a path unless the exact new path is declared.

### `repo.status`

- Returns HEAD, workspace snapshot, changed paths, per-path line counts, and any
  scope violation.
- Does not return an unbounded diff.

### `check.run`

- Accepts only a check ID enabled for the stage.
- The controller resolves the immutable command spec and runs it with no shell.
- Returns exit status, duration, truncation flag, and bounded output preview.
- Stores the complete observation as controller evidence.

### `stage.finish`

- Accepts only the stage result schema.
- Ends the call; it cannot approve artifacts, evidence, review, or delivery.

Invalid arguments get one concise correction. Repeated invalidity terminates the
call without advancing state.

## 11. Runtime protocol and fingerprint

A runtime fingerprint contains:

```json
{
  "adapter": {"kind": "pi_sdk", "version": "0.84.4", "protocol": "v1"},
  "provider": "randal-mi50",
  "model": "randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf",
  "weightsRevision": "UNKNOWN",
  "quantization": "Q5_K_XL",
  "endpointRevision": "UNKNOWN",
  "chatTemplate": "UNKNOWN",
  "toolParser": "UNKNOWN",
  "reasoningMode": "configured-default",
  "sampling": "provider-configured",
  "contextLimit": 262144,
  "outputLimit": 16384,
  "normalizations": ["single_json_fence"],
  "qualificationDigest": "sha256:..."
}
```

Unknown fingerprint fields remain `UNKNOWN`; they do not acquire guessed values.
A runtime is identified by the entire fingerprint, not the model label.

### Pi SDK adapter requirements

- Pin `@earendil-works/pi-coding-agent` and record its exact version.
- Create every stage with `SessionManager.inMemory()` and dispose it after the
  call; never continue a prior session.
- Construct a resource loader that supplies only TinySDD's system prompt and
  explicitly empty ambient extensions, skills, prompt templates, and context
  files.
- Inline the compiled hot prompt. Do not use attachment expansion for the action
  packet.
- Set `noTools: "builtin"` and pass only stage-specific TinySDD `customTools`.
  Pi's general `bash`, `read`, `edit`, and `write` tools never enter a treatment
  call.
- Implement `stage.finish` as a stage-specific terminating custom tool. Its
  TypeBox parameter schema is the result schema, giving structured arguments
  before any text-envelope fallback is considered.
- Capture Pi session events, raw assistant messages, thinking/tool usage metadata
  exposed by the SDK, cancellation, timeout, model resolution, and package
  version as adapter observations.
- Bind each custom tool closure to the controller-side execution capability; no
  authority field is accepted from the model.
- Abort and dispose the session on deadline or invariant failure. A late SDK
  event from a disposed call cannot affect controller state.

The pinned Pi SDK's `defineTool`/`customTools` contract must be verified by an
adapter test that captures two different capability closures in two fresh
sessions and proves neither session can invoke the other's authority. A Pi
upgrade invalidates that qualification.

The Pi SDK dependency is confined to `adapters/pi`. Core controller, artifact,
repository, command, and schema modules import only the adapter interface.

### OpenAI-compatible adapter requirements

- Record base endpoint identity without persisting credentials.
- Prefer native JSON Schema output when supported and qualified.
- Implement the tool loop in the controller so arguments are validated before
  effects.
- Set explicit context/output limits and timeouts; provider defaults are part of
  the fingerprint if they cannot be overridden.

## 12. Research and contract provenance

Every required operation has four surfaces:

1. request;
2. response;
3. authentication/authorization;
4. errors and state effects.

`contracts.json` records each surface as either a cited fact or an explicit
unknown:

```json
{
  "id": "EXT-1",
  "operation": "submit report",
  "surfaces": {
    "request": {"status": "CITED", "shape": {}, "citations": ["CIT-1"]},
    "response": {"status": "UNKNOWN", "reason": "source not read"},
    "auth": {"status": "CITED", "shape": {}, "citations": ["CIT-2"]},
    "errorsState": {"status": "UNKNOWN", "reason": "source not read"}
  }
}
```

A design reference to an `UNKNOWN` required surface is structurally invalid
unless a human waiver names the risk owner and an acceptance check capable of
detecting an incorrect assumption. The contract-fabrication benchmark permits
no such waiver.

## 13. Acceptance and oracle provenance

Each acceptance row is frozen before implementation and records:

- requirement/AC IDs;
- observable;
- exact check ID or human procedure;
- expected result;
- oracle source and digest;
- authoring relation to the executor;
- stage(s) where it must run.

Oracle relation is explicit:

| Relation | Meaning | Can be sole task oracle? |
| --- | --- | --- |
| `executor_derived` | Created from or after seeing the implementation output. | No |
| `preimplementation_frozen` | Authored and digested before executor access. | Yes for ordinary-risk tasks |
| `different_runtime` | Authored by a different qualified runtime without implementation output. | Yes, but not equivalent to external truth |
| `human_approved` | Expected behavior/value explicitly approved by a human. | Yes |
| `external_reference` | Derived from a cited standard/reference system/fixture. | Yes |
| `preexisting_repository` | Existed at the feature base commit. | Yes |

The controller computes timing and actor relations from events. A model cannot
self-label its test independent.

## 14. Git and workspace protocol

1. `tinysdd new` requires a clean repository and creates or verifies one feature
   branch. It never stashes or discards user changes.
2. Artifact drafting may make the feature branch dirty.
3. After plan approval, the controller writes approval receipts and creates one
   planning checkpoint commit containing approved artifacts and generated
   indexes/manifests.
4. Every task begins from the clean planning/task checkpoint.
5. Before each write-enabled call, the controller records HEAD plus a complete
   digest manifest of tracked and untracked non-ignored repository paths.
6. Repository tools prevent unauthorized paths. After the call, a full snapshot
   is still compared as defense in depth.
7. A task checkpoint commit contains task code, tests, tracked evidence/review
   records, and the task checkpoint manifest. Its message includes the task ID.
8. Controller events and transient logs remain outside Git to avoid a recursive
   “commit recorded by an event that itself needs another commit” problem.
9. Feature acceptance verifies that every planned task checkpoint is an ancestor
   of the current feature head and that no unknown task commit is substituted.

Automatic rollback is intentionally absent from the prototype. Guarded tools
should prevent a scope breach. If snapshot defense detects one, the controller
blocks and shows the exact changed paths; the human chooses whether to restore
the controller-created stage changes. TinySDD never destroys pre-existing user
work.

## 15. Human approval protocol

Approval commands require an interactive terminal and are not callable through
model tools. The human sees:

- artifact paths and digests;
- a compact diff from the previously approved version, if any;
- unresolved unknowns/waivers;
- audit findings and their disposition;
- downstream items that approval will invalidate.

The generated receipt records exact input digests, asserted name, local OS user,
time, and controller version. It proves what local command was recorded, not the
legal identity of the person. Cryptographic signatures and remote approvals are
future extensions.

## 16. Failure policy

| Failure | Required response |
| --- | --- |
| Missing/oversized prompt input | Compiler stops with `NEEDS_CONTEXT` or `TASK_TOO_LARGE`; split or revise sources. |
| Output invalid once | Return one compact schema diagnostic in a fresh correction turn. |
| Output invalid twice | Record `ADAPTER_OUTPUT_INVALID`; retry only as a new bounded attempt. |
| Tool call invalid twice | End the call; no transition. |
| Required contract unknown | Return to research or obtain explicit waiver; never fill it in design. |
| Unexpected red pass/wrong failure | Diagnose test/task definition before implementation. |
| Scope breach | Block, preserve exact diff/evidence, require human recovery decision. |
| New decision or repository contradiction | Return to owning artifact and invalidate dependants. |
| Check failure | One evidence-scoped diagnosis/fix attempt, then re-plan or ask human. |
| Review blocker/major | Fix then rerun all checks and review; maximum two rounds. |
| Runtime fingerprint changes | Re-qualify affected roles and invalidate model judgments/packets, not unchanged controller command evidence. |
| Controller event corruption | Read-only recovery mode; no model call or write may proceed. |

Retries always create a new attempt ID and packet digest. They never append the
whole failed conversation to the next prompt.

## 17. Prototype CLI

The human-facing surface stays small:

```text
tinysdd init
tinysdd new <feature-id> --request <file|->
tinysdd next
tinysdd run                 # executes one model/controller action from next
tinysdd approve <requirements|design|plan|delivery>
tinysdd answer              # records verbatim clarification answers
tinysdd inspect <packet|event|evidence|review> <id>
tinysdd status
```

Specialized stage verbs may exist for tests and debugging, but the normal driver
uses `next` and `run`. `next` is pure and read-only: it returns one action or one
blocker from projected state.

## 18. Prototype cut line

### Included

- project initialization and exact command configuration;
- event log, projection, digests, dependency invalidation, and approval receipts;
- request through plan approval for one task;
- repository and four-surface contract research;
- acceptance/oracle provenance frozen before implementation;
- prompt compiler and tracked packet manifest;
- Pi SDK adapter with in-memory sessions, controller-bound custom tools, and a
  terminating structured result tool;
- readiness, red, implement, verify, R0 review, checkpoint commit;
- feature acceptance and human delivery approval;
- frozen end-to-end contract benchmark.

### Deferred

- multiple tasks in one feature (the schemas permit them; the prototype rejects
  more than one);
- R1 runtime selection and automatic R2 routing;
- direct OpenAI-compatible and generic headless CLI adapters;
- cryptographic human identity;
- automatic rollback;
- arbitrary shell escape hatch;
- networked contract research performed by the model;
- ID-level partial invalidation;
- production fast-path execution;
- migration, deployment, and pull-request automation.

The prototype records whether a feature would qualify for a future fast path but
always executes the full path. That gathers overhead data without creating a
second correctness path before the first is proven.

## 19. Verification strategy

### Benchmark comparison contract

The primary benchmark is a total-effect comparison of the complete workflows:

- Control: fresh ordinary Pi session, same resolved runtime, starting repository,
  inline user request, context/output ceilings, and functional ability to read,
  search, edit, and request checks. It receives Pi's ordinary coding-agent
  instructions and no TinySDD artifacts, stop schema, stage boundaries,
  pre-frozen acceptance matrix, or write-set authority.
- Treatment: fresh Pi SDK session per TinySDD stage, the same starting repository
  and resolved runtime, guarded equivalents of the required repository/check
  operations, and the full approved artifact/checkpoint chain.

The primary result measures the framework as a bundle; tool and prompt surfaces
are intentionally part of that bundle. It must not claim which mechanism caused
the difference. Frozen ablations then replace or remove one TinySDD mechanism at
a time while leaving the rest of the treatment unchanged. The benchmark record
lists every invocation, enabled tool, prompt digest, ceiling, and check so the
comparison cannot drift silently.

### Controller tests

- transition table property tests: no event can skip a gate;
- event replay and crash-point tests around blob, event, and projection writes;
- middle-event corruption, filename/digest mismatch, reordered/gapped sequence,
  and broken previous-digest link all block replay before projection replacement;
- a killed controller's verified stale lease can be recovered, while two live
  controllers cannot both mutate and an ambiguous lease cannot be stolen;
- transitive invalidation tests for every artifact type;
- approval digest drift tests;
- path traversal, symlink escape, NUL, absolute path, and write-set tests;
- model-visible authority tampering cannot alter the controller-side execution
  capability;
- two Pi sessions receive distinct closure-bound capabilities; expiry cancels
  in-flight tool/process work and late SDK events cannot become evidence;
- subprocess tests proving `shell=false` and exact argument preservation;
- output normalization tests accepting only one declared envelope;
- evidence freshness tests across every mutation;
- a `DONE` result with a failed required check remains blocked and records both
  the proposal and controller outcome;
- Git ancestry and clean-tree tests.

### Adapter contract tests

- strict schema output and one bounded correction;
- fresh context/no ambient instruction leakage;
- missing-contract and missing-read stops;
- tool argument validation and bounded outputs;
- runtime fingerprint drift;
- cancellation and timeout behavior.

### End-to-end tests

1. Happy-path one-task feature.
2. Missing contract blocks before design.
3. Artifact edit invalidates approvals and packets.
4. Unexpected red pass blocks implementation.
5. Unauthorized patch is rejected before mutation.
6. Later mutation stales verification/review.
7. Contract benchmark compares ordinary Pi control and TinySDD treatment.

The benchmark protocol and pilot runtime observations live in
[model-evaluation-plan.md](model-evaluation-plan.md) and
[model-evaluation-results-2026-09-04.md](model-evaluation-results-2026-09-04.md).

## 20. Acceptance criteria for the prototype

- `PAC-1`: Replaying a valid event directory produces byte-identical projected
  state; an invalid sequence/hash blocks mutations.
- `PAC-2`: No model response can create an approval, command observation,
  workspace mutation record, review level, or state transition without a
  corresponding controller observation/event.
- `PAC-3`: Changing any approved artifact invalidates all transitively dependent
  approvals, packets, evidence, reviews, and pending briefs before `next` permits
  work.
- `PAC-4`: A stage cannot read outside allowed repository surfaces or write an
  undeclared path through the guarded tool interface.
- `PAC-5`: Every command is executed from an approved argument vector with
  `shell=false`, timeout, captured exit status, and evidence bound to the exact
  workspace snapshot.
- `PAC-6`: Prompt compilation fails if any required source is absent or if the
  packet exceeds the qualified budget; it never silently truncates.
- `PAC-7`: Required request, response, auth, and error/state surfaces cannot enter
  design as known facts without source digests and citations.
- `PAC-8`: Implementation cannot begin until an independent-enough oracle is
  frozen and every AC maps to a check.
- `PAC-9`: Red, verification, and R0 review bind to the same code lineage; any
  mutation stales downstream evidence.
- `PAC-10`: A clean planning checkpoint and exactly one accepted task checkpoint
  lead to feature acceptance and an explicit human delivery decision.
- `PAC-11`: Three fresh repetitions per target runtime complete the frozen
  contract benchmark with raw artifacts and deterministic scores preserved.
- `PAC-12`: The result report compares correctness, fabrication, scope, tokens,
  elapsed time, and intervention cost without treating extra treatment budget as
  a correctness-free win.

## 21. Remaining decisions before implementation

1. Confirm TypeScript on Node.js 24 and the in-process Pi SDK adapter. The design
   keeps Pi behind an interface, but the prototype intentionally depends on its
   configured model/runtime catalog and custom-tool implementation.
2. Choose schema dependencies. The default recommendation is TypeBox for the
   shared TypeScript/tool definitions plus its compiled value checks; add Ajv
   only if standards-complete JSON Schema behavior is required by a concrete
   artifact.
3. Decide whether tracked evidence contains full command output or only metadata
   plus a digest of controller-local blobs. The default recommendation is
   metadata plus bounded preview; full logs may contain secrets or large output.
4. Freeze the contract benchmark fixture and scorer before adapting prompts to
   either target runtime.

No source scaffold should be created until these four decisions and this draft's
acceptance criteria are approved.
