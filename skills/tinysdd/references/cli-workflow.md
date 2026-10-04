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

Use the optional `--feature NAME` label to group slices, then filter the view
with `status --feature NAME`. Human `status` draws open tasks as a dependency
tree; `status --json` includes each task's global topological `order` and sorted
non-retired `dependents`, so filtering does not renumber the graph. Accepted
tasks include their applied worker run, while closed and superseded tasks are
listed after the tree with their successors:

```text
broker-s1  accepted (applied from worker-…)
├─ broker-s2  ready
│  ├─ broker-s4  blocked (requires broker-s2)
│  └─ broker-s5  blocked (requires broker-s2, broker-s3, broker-s4)
└─ broker-s3  pending_approval
```

Record a manually observed usage row with explicit phase, model and feature or
task attribution. Counts are nonnegative safe integers and missing telemetry is
never converted to zero:

```sh
tinysdd usage record --phase review --model frontier/model --input 1200 --output 400 --feature reservations
tinysdd usage report --feature reservations
```

For external data, use the normalized import envelope with a `source`, an
`exportId`, and a stable `externalRecordId` on every record. TinySDD validates
the complete file before appending it; this contract does not claim a native
Pi or Claude Code adapter:

```json
{
  "schemaVersion": 1,
  "type": "usage-import",
  "source": "synthetic-talon",
  "exportId": "export-1",
  "records": [
    {
      "externalRecordId": "record-1",
      "phase": "review",
      "model": "frontier/model",
      "feature": "broker",
      "input": 7,
      "output": 3
    }
  ]
}
```

```sh
tinysdd usage import --file usage-export.json
```

After reviewing every active labelled task, close a feature window explicitly:

```sh
tinysdd feature accept --feature reservations --by operator --reason 'Reviewed the feature window'
tinysdd feature report --feature reservations
```

The acceptance event freezes report numbers and run references. Later usage is
visible only after an explicit re-acceptance; current membership or task
freshness changes mark the frozen snapshot stale while preserving its numbers.
Unknown or partial observations remain `UNKNOWN` with their provenance.

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

Context compaction is default-off. A selected profile can opt into the
model-free deterministic hook with `runtime.compaction.enabled: true`:

```json
{
  "schemaVersion": 1,
  "id": "compact-worker",
  "runtime": {
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 }
  }
}
```

`reserveTokens` must be at least effective `maxTokens`; omitting it derives the
effective value. The host stages a read-only approved-packet anchor and wrapper
for both bubblewrap and Seatbelt, independent of `run_checks`. Only paired old
`read` and `run_checks` results are replaced by bounded digest and replay-marker
text. `runtime.json.compaction` records the choice and anchor identity, while
`result.json.observed.compactions` records summary/detail digests. A deterministic
event has no model-written-summary warning. Refusal and cancellation reasons
remain explicit in the extension result.

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

Run an operator-selected benchmark suite with the serial CLI lane:

```sh
tinysdd bench run --worker qwen --suite bench --repeat 2 --json
```

`--suite` accepts a project-relative suite directory or its `suite.json`; when
omitted it defaults to `bench`. Runnable roles are `implement-slice`,
`stop-and-ask`, and `write-tests`.
Every challenge and repetition gets a fresh fixture and a retained case result
under `.tinysdd/bench/<suite-id>/<invocation-id>/`. The worker runs through the
normal disposable path, then visible and held-out checks run against a separate
candidate copy. Held-out resources do not enter the prompt, worker workspace,
candidate snapshots, or future revision inputs.

`--repeat` must be an integer from 1 through 1000. With `--json`, stdout is one
JSON result object; progress and `run_checks` availability warnings are written
to stderr. The command records measurement artifacts only. It never applies a
candidate, mutates controller task state, accepts a task, or qualifies a model.

The repository's fixture suite is `bench/implement-slice-suite`. It runs nine
`implement-slice` challenge classes plus one `stop-and-ask` challenge, with
references and deliberately wrong candidates audited outside the worker
fixtures. The stop-and-ask case writes only `questions/report.json` with named
missing inputs and a nonempty question, while implementation and protected
files remain untouched.

The write-tests suite at `bench/write-tests-suite` runs five contract-test
challenges. Its visible check evaluates the submitted bytes against the
reference source; each held-out check evaluates the same bytes against one of
20 mutant sources in a separate evaluator copy. Valid TAP failures of the
mapped named witness count as measurement kills, while empty, skipped,
syntax/import, setup, timeout, process, and unavailable runs do not. The
reference pass and killed/declared count are derived from existing records;
they never qualify a worker or accept a task.

Score retained results with the qualification lane:

```sh
tinysdd bench qualify \
  --results .tinysdd/bench/write-tests-v1/INVOCATION \
  --suite bench/write-tests-suite \
  --target write-tests=0.8 --json
```

`--suite` is optional when the project has `qualification.suite`; otherwise it
defaults to `bench`. The first `--results` path anchors the historical digest,
then `bench qualify` reads every retained invocation for that exact digest and
suite, including later failures. It reads the suite, challenge files,
verifier manifests, invocation manifests, summaries, and all case results. It
hash-checks those files, validates the declared challenge x repetition roster
and exact visible/held-out check IDs and definition hashes, then stores the
record in `.tinysdd/qualifications/`. It performs no worker, inference,
service, or live check execution. Repeating the same invocation input is
deduplicated by its retained invocation identity; an `attemptId` may repeat in
different invocation IDs and is pooled with that provenance. Dispatch refreshes
an existing exact record from this full retained pool and never creates one
from raw evidence.

Worker dispatch qualification uses the current worker, suite, verifier,
runtime, endpoint fingerprint, check declaration, and budget. Configure
`qualification.mode` as `warn` (the default), `enforce`, or `off`; enforce
refuses an unqualified `implement-slice` before launch. Runtime and result
artifacts retain the digest, record path, status, reason, changed identity
fields, mode, and warnings.

Each role defaults to target `0.8`, provisional until #33 calibrates it; use
repeated `--target ROLE=NUMBER` values for per-role overrides. Results use the
two-sided 95% Wilson interval with
z `1.959963984540054`: lower bound >= target is `qualified`, upper bound <
target is `not qualified`, and the remaining interval is `insufficient
evidence`. The record keeps n, passes, bounds, confidence, target, method,
source hashes, the suite/check roster, and both `passesToQualify` and
`failuresToRuleOut` counters. These counters are minimum extra consecutive
passes or failures under the best-case bound, not predictions. Repeated cases
are pooled as a correlated, provisional approximation.

Qualification scoring is independent of task apply and acceptance: a retained
timeout may count as a statistical case pass when all visible and held-out
checks pass with no hard-gate violation; the raw outcome and task rules remain
unchanged.

Rescore a stored record without rerunning evidence:

```sh
tinysdd bench rescore \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --target write-tests=0.9
tinysdd bench qualification show \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --suite bench/write-tests-suite --worker qwen
```

Omitted rescore targets retain each role's saved target. `show` reports current
full config identity applicability separately from historical role status;
profile, suite, verifier, runtime, or other identity changes make a record
stale. `UNKNOWN` availability fields remain distinct from known-disabled
configuration and are not converted into an eligibility or completeness gate.
Qualification is evidence only; dispatch and enforcement remain separate.

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
independent operator verification remains required. When the client is
available, the worker contract makes the named host tool explicit and directs
an edit → `run_checks` → fix loop after each allowed write or edit. Failures are
fixed only within the approved scope; the worker stops and reports when the
declared budget or required information or permission is exhausted, and names
observed checks separately from checks still unrun. An unavailable client keeps
the existing no-check prompt and Pi tool arguments.
