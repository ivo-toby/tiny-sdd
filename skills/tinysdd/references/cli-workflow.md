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

Worker mode initially requires Linux, bubblewrap, Pi and the exact model in
Pi's configured models. It uses only read/write/edit tools in a disposable copy.
No generated code is run. Source files may appear in local raw events and sent
model context: use only authorized projects and providers. Excluded filenames
are a precaution, not a general detector for secrets embedded in source.

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
candidate, not the project). It follows the lineage to the first run, and refuses
with `APPLY_CONFLICT`, writing nothing, if a project file no longer matches the
state that run started from; files that already equal the candidate are recorded
as `already-applied`. It refuses another task's run, a benchmark replay, scope
violations and a run whose outcome is not `completed` (a timed-out run included),
with no override. The record shows under `applied` in `status --json`; an accepting review adds
`appliedFromRun` with `identical: false` if the files were edited after applying.
Apply is neither verification nor acceptance.

Use `revision` for a bounded repair or `blocked` for missing authority/context.
The next revision packet includes the recorded review evidence as feedback;
do not modify it silently after recording the decision.
Evidence is caller-supplied; the controller does not claim to have run its
commands. Acceptance is bound to the brief, dependencies, review evidence and
allowed file contents. Later changes can invalidate it.

Declare fixed task checks in a reviewed JSON file under `.tinysdd/tasks/` and
pass it to `task add` with `--checks PATH`. The controller validates and binds
the declaration into approval and the packet, but checks are approved only and
are not executed yet.
