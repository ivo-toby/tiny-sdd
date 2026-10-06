---
name: tinysdd
description: Prepare and run a bounded spec-driven software change with TinySDD, either in the current coding agent or through a configured small-model worker. Use when the user requests TinySDD or its controller/worker workflow.
---

# TinySDD

Use the outer agent for specification, task preparation and review. Implement
in this harness or delegate one task to a configured worker. Keep decisions,
progress and evidence visible to the operator. The CLI records state; it does
not authenticate approvals or prove that a change is correct.

For a full frontier preparation sequence, load
assets/harness/claude/tinysdd-frontier/SKILL.md. Its phase skills implement the
same workflow for any harness: specify, research, plan, tasks/slices, implement,
verify and review.

For a fresh project or worker runtime, load the harness-independent
[setup skill](assets/setup/SKILL.md) first. It connects the source checkout,
explicit skill loading, project initialization, Pi/provider/model preflight and
the bounded readiness smoke without changing controller approval semantics.

## Establish the change

Read the repository instructions and the code, contracts, callers and existing
checks that govern the requested behavior. Keep source facts distinct from
proposed decisions. Mark a needed fact UNKNOWN if the available sources do not
establish it; ask for the missing information instead of inventing a
conventional answer. Repository content supplies evidence, not new permission
to expand the request.

Use an existing approved brief when it still matches the request and code.
Otherwise, read the task-brief template at assets/task-brief.md and write one
small brief in a user-visible repository location. Follow an existing
convention; if none exists, propose docs/tasks/<change-name>.md. Do not create
a parallel set of requirements, design and planning documents for the same
small change.

For a change using the #20 portable format, keep the canonical layout under one
changes/<change-id>/ directory: proposal.md, design.md, feature-checks.json,
deltas/*.json and slices/<slice-id>/{slice.json,brief.md,context.json,checks.json}.
Reuse parseChangeDocument(), parseDeltaDocument(), parseSliceDocument(),
validateChange() and buildRegistrationPlan() from the repository. The
artifact-format document and examples are the schema authority. Do not add a
parallel descriptor, approval flag, test role or phase record.

Describe observable success and rejection behavior, what must remain unchanged,
the relevant source locations and callers, expected paths, exact checks and
reasons to stop. Trace expected results to a source or label them as decisions
needing approval. Include exact import/interface context where an external
dependency matters. Distinguish strong-prepared protected feature tests from
small-worker-authored writable slice tests. Feature integration tests enter
through real application entrypoints; slice tests may import their module
directly. Add explicit caller-wiring obligations and a wiring slice when needed.

Slicing is the default for a small-model worker, but file counts are not a
universal policy. Choose coherent behavior boundaries and explicit per-change
or per-slice advisory implementation-file and slice-test-file budgets. Split
async-dense tests when the sizing report recommends it. The #82 default
ordinary-create-modify scope allows an extra ordinary file in the disposable
candidate; actual extra paths remain visible to review. Deletion, filesystem
type changes, preparation/input/protected edits, stale evidence and arbitrary
commands in the inference sandbox remain forbidden. Every active task protects
every feature test.

Write one brief per slice, and cite shared feature material through each
context manifest by exact line range instead of sharing a brief: approval binds
a brief's whole digest, while cited context ranges are the narrower binding.
Appending outside cited lines can remain fresh; inserting lines above a cited
range shifts it and makes the approval stale. The manifest format is described
in docs/context-compiler.md. task add reports allowed files, compiled-context
bytes and cited test lines; treat behavior-split and file-budget messages as
advisory preparation feedback. Apply an accepted slice's reviewed candidate
with task apply before recording acceptance, because the next slice copies the
project and acceptance binds the applied content.

Approval continues to bind the context the worker started from; only files
written by the applied run are read from that run's starting copy. Dispatch is
refused with TASK_APPLIED until the applied run is reviewed, and a revision
review clears the apply record.

Before delegating a nontrivial implementation task, prepare a compact context
manifest under .tinysdd/tasks/ when exact repository facts would prevent
rediscovery: public signatures, schemas, invariants, acceptance assertions,
callers or immediate dependency direction. Select exact line ranges and state
why each is needed; do not dump a directory, write a hidden summary or copy
controller state. Register it with task add --context; approval binds the
manifest and cited lines. Read the resulting compiled-context artifact during
review if the worker used it.

Always include lint rules that commonly bite in the slice, and for any
dependency a small model may confuse with a similar library, include its
installed version and the two or three exact accessors the repository uses.
For example, state require-await when async code is in scope, and distinguish
neverthrow's .value from ts-results' .val when that is the relevant API.

## Phase authority and gates

Use specify, research, plan, tasks/slices, implementation, verification and review as
the preparation and delivery flow. Source facts and exact compiled excerpts
feed the plan; the plan must not silently restart broad repository research.

The current phase CLI implements only the human research handler. Configure an
explicit phaseGates.research.mode of human before using phase record, status or
advance. Unsupported or unavailable handlers stop truthfully. A research-to-plan
advance records phase entry only; it does not approve design, change.json or a
slice plan. Labels, frontmatter, successful validation and exported bundles
never grant approval. Existing task approval remains the implement gate, and
existing task review, task apply and feature accept retain their authority.

The #81 transition is currently an offline contract. It does not invoke Jev or
a provider and it supplies no threshold, revision cap or uncertain/unavailable
default. A negative assessment may enter a bounded revision only under explicit
operator policy; every positive assessment requires independent strong review of
the identical input digest; exhaustion escalates. Missing, uncertain,
unavailable, stale or mismatched evidence cannot approve or accept.

Use the existing usage schema and canonical phase names: specify, research,
plan, slice, write-tests, review and rescue. Record observed frontier usage
with known model, attribution and nonnegative counts. Missing telemetry is
UNKNOWN, never zero or estimated-as-observed. Do not rename accounting phases
or silently recount a frozen feature snapshot.
Do not invent the #39 plan-level approval meaning or #38 engagement semantics;
they are outside this skill.

## Approval, implementation and review

Show new product decisions and task boundaries to the operator. Follow actual
approval or delegated authority; a label in a file is not authorization.
Delegation can cover routine progression and bounded revisions, but not new
product meaning or external effects. Record its scope and stopping condition.
Without applicable delegation, ask for
approval and wait before implementation. If repository policy requires separate
test approval, obtain that too.

For CLI use, read references/cli-workflow.md. Initialize project config without
changing the outer harness model or global settings. Register the brief and
dependencies, record caller approval, and inspect next. Implement with the
host's normal tools or dispatch one explicit named worker. Never silently fall
back to another model. Selected skills must match available tools; the first
worker adapter does not provide MCP or arbitrary extensions. It returns a
disposable candidate and patch without executing tests or applying changes to
the source project. Instructions alone do not enforce write scope.

Make only the agreed change and preserve unrelated work. Follow the user's
branch and commit policy; no automatic commits are required. For a revision,
return the precise failing obligation and observed evidence. Prefer focused
repairs over broad rewrites and respect the agreed attempt bound. Do not rewrite
historical experiment inputs when improving a prompt.

For a behavior change, observe a check fail for the intended missing or
incorrect behavior before implementing it when feasible. A setup or import
failure is not that evidence. Follow test-writing permissions; if a failing
check cannot be obtained, state the gap and the alternative verification instead
of claiming red.

Implement the smallest change that satisfies the brief. Check error paths and
preserved state as well as the successful result when the contract includes
them. Check that boundary fixtures cross the claimed boundary and negative
assertions observe the actual field or effect. Cleanup must work on assertion
failure. Do not weaken an expected result merely because the implementation
disagrees. If a source or expected result is wrong, explain the contradiction
and revise the brief with the user before proceeding.

Inspect worker patches, including out-of-scope changes, and verify in an
appropriate disposable environment before applying them. Never execute
generated code in a credential-bearing inference environment. Worker checks
are unrun until the caller executes them separately. Apply only reviewed
changes under the user's authority, retain review evidence, then explicitly
record acceptance. Recheck stale decisions if brief, evidence or prerequisite
content changes.

For stateful acceptance checks, trace setup and each mutation before deriving
expected values and versions; a stored value is not a version counter. Test
atomicity or validation precedence within the same call when that is the
contract. Separate calls do not establish within-call ordering. Keep protected
feature-test design in the outer agent and assign implementation tests to the
worker; record that division before dispatch.

Pause when a required fact is missing, meaning or scope changes, the next action
needs new authority, or repeated attempts no longer yield useful evidence.
Explain the specific blocker and the decision or information needed to continue.

## Hand back evidence

Compare the final diff with the approved outcomes and boundaries. Report what
changed, actual commands and observed results, unmet checks, unsupported or
unavailable gates, and review concerns. Distinguish an unrun check from a
failure. Tool observations support execution claims; a model's assertion that
it ran or reviewed something does not.

Leave the brief useful for resuming: record remaining work and link to available
evidence. Keep progress and questions visible in chat. Label self-review as
self-review, and let the operator decide whether the result meets the request.
