# CLI workflow

Run `tinysdd --help` for the installed interface. In a source checkout use
`node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs`; run it from the target project
or select `--project /path/to/project`. Add `--json` for machine-readable output.

Controller-only setup needs no model:

```sh
tinysdd init
tinysdd task add --id validation --brief docs/tasks/validation.md --allow src/validation.ts,tests/validation.test.ts
tinysdd task approve --id validation --by operator --reason 'User approved the brief in this conversation'
tinysdd next
tinysdd task packet --id validation --json
```

Attribution and reason must reflect actual authority, not the example text.
For dependent tasks use `--depends-on validation`. State and review artifacts
live under `.tinysdd/runs/`; briefs remain user-visible project documents.

A task may cite exact source lines with `--context MANIFEST`, a JSON file under
`.tinysdd/tasks/` (format in `docs/context-compiler.md` of the TinySDD repository).
Approval binds the cited lines, not the whole file, so slices that cite one shared
spec by line range stay current when it is appended to or edited outside their
ranges. Inserting lines above a cited range shifts it and stales the slice.

Use `task add --protect src/types.ts,tests/contract.test.ts` for read-only
contract files. They must exist and cannot overlap `--allow`. The packet lists
them and the worker prompt forbids changing them; an edit is retained as a scope
violation with reason `protected contract file`, rather than prevented by file
permissions. Approval binds their content digests. Editing a protected file makes
the approval stale and therefore makes an accepted slice `stale` too: it must be
checked again against the changed contract. Acceptance needs no separate field.

To revise an open task's shape, use `task update` with `--by` and `--reason`:

```sh
tinysdd task update --id validation --allow src/validation.ts --protect tests/contract.test.ts --by operator --reason 'keep the contract fixed'
```

`--brief`, `--context`, `--checks`, `--allow`, `--protect` and `--depends-on`
validate like `task add`; omitted fields stay unchanged. Use `--context=`,
`--checks=`, `--protect=` or `--depends-on=` to clear an optional field;
`--allow` must stay nonempty. Each effective update keeps the previous shape and
any apply record in `revisions[]`, with attribution, reason and timestamp, shown
by `status --json`. It leaves recorded approvals and reviews intact; changes to
bound shape or digests make approval stale, requiring explicit reapproval.
A later review cannot attribute the revised task to an apply under its old shape.
Accepted tasks, including stale accepted tasks, cannot be updated: use
`task supersede` once acceptance is stale; supersede still refuses a current
acceptance and open dependents. Closed and superseded tasks cannot be updated
either.

Sizing warnings at `task add` and `task approve` now include a behavior-split
recommendation for cited tests with fake timers plus deferred promises or races,
or at least 8 ordering assertions. Separate the sequential core from the async
edge, each with its own test file. The thresholds are provisional and
uncalibrated, pending the talon reruns; warnings never block.

Retire a task you abandoned or re-cut instead of leaving it open. `task close`
and `task supersede` need no approval, so they work on a `stale_approval` task
that `task review --verdict blocked` cannot reach. Both are terminal: the task
gets status `closed` or `superseded`, leaves `next`, and can no longer be
approved, reviewed or dispatched. Neither retires an `accepted` task, and both
are refused while open tasks depend on it; the error lists them. A retired task
never satisfies a dependency, and a new task cannot depend on one. `supersede`
also records the successor tasks, which `status --json` shows under `closure`:

```sh
tinysdd task supersede --id broker-contract --with broker-s1,broker-s2 --by operator --reason 're-cut into slices'
tinysdd task close --id scratch --by operator --reason 'no longer needed'
```

Worker setup when config does not yet exist:

```sh
tinysdd init --worker qwen --provider titan --model titan/llamacpp/qwen3.6-35b-a3b-256k
tinysdd config show --json
tinysdd worker start --task validation --worker qwen --json
tinysdd worker status --id LAUNCH_ID --json
```

Existing config is preserved: edit it deliberately to add named workers.
Optional `.tinysdd/config.local.json` replaces entire workers by name; it does
not deep-merge partial worker fields. Inspect effective configuration before
dispatch. Copy a suitable profile into the project and set its relative path
on the selected worker when needed. Profiles do not include credentials.

Worker mode requires Linux with bubblewrap or macOS with `sandbox-exec`, Pi in
the same installation as the CLI's Node executable, and the exact model in Pi's
configured models. Pi 1.0.0 requires Node >=22.19.0; its fixed check-client
integration still needs live qualification. Missing sandbox support fails closed. It uses
read/write/edit tools in a disposable copy. Available declared checks add the
fixed `run_checks` client; generated code executes only in the separate Linux
check sandbox. An unavailable host records the reason and runs without the
client. Source files may appear in local raw events and sent
model context: use only authorized projects and providers. Excluded filenames
are a precaution, not a general detector for secrets embedded in source.

On macOS, Seatbelt allows writes to the candidate and temporary Pi state;
the original project, original Pi configuration and other home files are denied.
Only trusted Node/Pi code and system libraries are readable outside those copies.
The `openai-completions` API needs an explicit HTTP(S) base URL. A per-run
loopback relay forwards only the selected model's chat-completion requests to
that endpoint; provider credentials remain outside Pi, redirects and other
routes/models are rejected, and other network ports are denied. No provider or
model fallback occurs. Inspect `runtime.json` (`sandbox: "seatbelt"`) and the
retained `sandbox.sb` for the exact policy. Qualify each MLX, llama.cpp or LM
Studio endpoint with a live run; a stubbed test is not that evidence.
`node scripts/qualify-macos-sandbox.mjs` runs real Seatbelt escape checks with
synthetic fixtures separately from the offline test suite.
Use `node scripts/qualify-macos-worker.mjs --provider NAME --model EXACT_ID` for
a live smoke of one configured endpoint, with its approved credential environment.
The script retains artifacts and checks the candidate and source independently.

Use `worker start` for real model calls from an orchestrating agent. It launches
the controller in a detached process so short-lived agent shells cannot send an
unintended SIGTERM to a still-working model. `worker run` is foreground mode for
local debugging only. Poll `worker status` until `data.status` is `finished`; an
`interrupted` launch has no usable candidate result and must be recorded as such.
Read only the top-level `data.status`: `data.request` is the launch-time snapshot
and its `launchStatus` stays `running` after the worker ends.
To end a launch early, use `tinysdd worker stop --id LAUNCH_ID --json` rather than
killing the launcher. It signals the launcher, which stops Pi and finalizes the
run as usual: the result has outcome `stopped` (error code `WORKER_STOPPED`), and
the candidate, patch and raw events are kept. `stopped` is not acceptance; review
the candidate like any other failed outcome. `--wait-ms N` (0 to 600000, default
30000) bounds how long the command waits for the result. If finalizing takes
longer, `data.status` is `stopping`; keep polling `worker status` until it is
`finished`. `worker stop` signals only a process it can verify is that launch's
launcher (Linux `/proc`), and otherwise fails with `LAUNCH_NOT_OURS` without
sending a signal. Stopping an already stopping launch only waits.
Every non-completed worker result includes `candidateState`, which reports the
allowed paths changed and the sorted allowed paths left untouched. If any
allowed path changed, review the candidate before discarding it.
For a review revision, reuse a prior completed, scope-clean candidate explicitly:
`tinysdd worker start --task validation --worker qwen --base-run WORKER_RUN_ID`.
TinySDD overlays only that prior run's changed allowed files into the new
disposable workspace and records the lineage; it never changes the source project.
For a benchmark replay, an intervening `task update` that changes the approved
allow, protect, context, checks, or dependency shape is refused with
`STALE_BENCHMARK_SHAPE`; re-approve the revised task before starting a new
benchmark.

Inspect the finished result envelope and patch. Process completion is not passing
verification, and scope violations are review blockers. Use the outer harness
to verify the candidate in an appropriate isolated environment, and retain observed
test results plus review findings in a file. Apply the reviewed run to the project
with `task apply` before recording acceptance, because acceptance binds the
project's allowed-file content: accepting first makes the task `stale` and blocks
its dependents. Then record the decision explicitly:

```sh
tinysdd task apply --id validation --run WORKER_RUN_ID --by operator
tinysdd task review --id validation --verdict accepted --evidence docs/reviews/validation.md --by operator
tinysdd status
tinysdd next
```

`task apply` copies the run's allowed files by content, so it works for a
`--base-run` revision too (a revision's `patch.diff` is a delta against the prior
candidate, not the project). It follows the lineage to the first run, applies only
the paths those runs recorded as changed, and refuses with `APPLY_CONFLICT`,
writing nothing, if one of those project files no longer matches the state the
lineage started from; files that already equal the candidate are recorded as
`already-applied`. It refuses another task's run, a benchmark replay, scope
violations and a run whose outcome is not `completed` (a timed-out run included),
with no override. It also refuses, with `APPLY_CHANGES_TASK_INPUT` and nothing
written, a run that would rewrite the task's own brief, context manifest or checks
manifest (possible when they are in `--allow`), since that would leave the approval
it was dispatched under stale. The record shows under `applied` in `status --json`; an
accepting review adds `appliedFromRun` with `identical: false` if any allowed
file differs from what apply left. Apply is neither verification nor acceptance.
It also refuses with `RUN_APPROVAL_MISMATCH` when the final run packet was dispatched under a different approval digest; dispatch a fresh run after re-approval.

After an apply the approval keeps binding the context the worker started from
(the cited lines of a file apply wrote are read from the first run's starting
copy), so applying does not stale it and nothing re-approves the new source. Every
other cited file, including an allowed file the run did not change and an
already-applied path, is read from the project, so editing it still stales the
approval. If a written file's run directory is deleted the approval reads stale,
and an apply that would leave it stale is refused with `APPLY_WOULD_STALE` before
anything is written. While an apply is recorded,
`task packet` and `worker run` refuse with `TASK_APPLIED`: record the review
first. Accepted and blocked reviews keep the record. A `revision` review records
`appliedFromRun` and clears it, since the next attempt builds on the applied
project; if the context cites a file apply wrote whose cited lines changed, the
approval then reads `stale_approval` and must be re-approved explicitly. Do not
start a `--base-run` revision from an already applied run: the project no longer
matches the lineage's starting state, so its apply conflicts.

Use `revision` for a bounded repair or `blocked` for missing authority/context.
The next revision packet includes the recorded review evidence as feedback;
do not modify it silently after recording the decision.
Evidence is caller-supplied; the controller does not claim to have run its
commands. Acceptance is bound to the brief, dependencies, review evidence and
allowed file contents. Later changes can invalidate it.

Replay and revision check mounts come from the live canonical project root
rather than the frozen candidate snapshot. `runtime.json.runChecks` records
their content identity and the explicit baseline comparison; a revision uses
its immediate parent run, and older artifacts without an identity compare as
`unknown`.

Declare fixed task checks in a reviewed JSON file under `.tinysdd/tasks/` and
pass it to `task add` with `--checks PATH`. The controller validates and binds
the declaration into approval and the packet. When the host runner is available,
a checks-bearing packet exposes `run_checks` with optional `checkId` (omitted
means all checks in order). It uses the separate Linux bubblewrap runner,
without network or credentials. An unavailable host records the reason and
keeps the no-check tool surface. `worker start` and `worker run` repeat the
same `run_checks unavailable: ...` warning on stderr; `--json` keeps stdout to
one JSON result. Dependency mounts cannot overlap allowed
paths. `limits.maxCheckRuns` defaults to 12 (integer 1–20), charged per individual
check. Budget exhaustion, unknown ids and runner unavailability throw tool
errors and do not end the worker. Pi 1.0.0 makes a batch containing `run_checks`
sequential in assistant source order: `[write, run_checks]` sees the write;
`[run_checks, write]` sees the earlier candidate. No sibling reordering occurs.
Keep extension discovery and built-ins disabled, loading only the read-only
check client with `read,write,edit,run_checks`. Do not enable codemode, MCP,
tool-search or llama.cpp built-ins. Check time
counts toward the worker deadline; checks are cancelled when the worker ends.

Inspect `checks.jsonl`, bounded check-output artifacts and
`result.workerObservedChecks`. The observations identify the checked input
digests and are labeled `acceptanceEvidence: false`. They are worker feedback;
independent operator verification remains required.
