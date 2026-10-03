# Try TinySDD locally

This is an early local prototype. The controller does not require a model.
Spawned workers require Linux with bubblewrap or macOS with `sandbox-exec`, and
an existing Pi installation with the exact provider/model configured. Missing
sandbox support fails closed. No package installation is needed for the
dependency-free CLI itself. Node24 is the development/test environment.
The fixed check client targets Pi 1.0.0, which requires Node >=22.19.0;
its live sandbox loading and Titan smoke still require qualification.
The first adapter expects Pi in the same installation's `bin` directory as the
Node executable running this CLI; other installation layouts are not qualified.
Workers create disposable candidate directories under `/tmp` by default. Set
`TINYSDD_TMPDIR` to an existing real directory on a volume with enough free
space when `/tmp` is small or shared; the worker removes its candidates after it
has retained the run artifacts under the project.
On macOS, the default system temporary directory is resolved through Apple's
`/var` and `/tmp` aliases; an explicit `TINYSDD_TMPDIR` must still be a real path.

The macOS adapter uses Seatbelt with read access to system libraries, the Node
executable and the installed Pi package. The candidate and temporary Pi state
are writable. The source project, original Pi state and other home files are
inaccessible, including through symlinks. Pi receives read/write/edit; process
forks and shell execution are denied. The Linux check runner is unavailable on
macOS, so a declared checks packet records that condition and runs without
`run_checks`.

macOS currently supports the `openai-completions` API with an explicit HTTP(S)
base URL. A temporary loopback relay forwards only `POST /chat/completions` for
the exact selected model to that configured URL. It retains provider credentials
in the controller, rejects other routes/models and redirects, and closes when
the run ends. Pi receives an ephemeral relay token and no provider credential
environment variables. All other network ports are denied. MLX, llama.cpp and
LM Studio servers can use their OpenAI-compatible endpoints; each deployment
still needs a live smoke run. The Linux bubblewrap path is unchanged.

`runtime.json` records `sandbox: "seatbelt"`, the executable, relay destination
and retained `sandbox.sb` profile on macOS. Linux keeps `sandbox: "bubblewrap"`.
Run the separate native escape qualification with the same Node installation:

```sh
node scripts/qualify-macos-sandbox.mjs
node scripts/qualify-macos-worker.mjs --provider litellm --model code-local
```

The escape check uses synthetic source, home/SSH and Pi-state fixtures. The model
smoke requires the exact configured provider/model and its credential environment;
it retains a synthetic project and independently checks the candidate and
unchanged source. Repeat it explicitly for each endpoint being qualified.
The ordinary test suite
uses stubs and requires no sandbox executable, network, Pi or model.

From this checkout:

```sh
npm test
node bin/tinysdd.mjs --help
```

Use `node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs` wherever the examples below
say `tinysdd`. `--project /path/to/project` selects the target explicitly;
otherwise commands use the current directory. No global npm/Pi setup is changed.

## Use it inside your coding agent

Load this checkout's [TinySDD skill](../skills/tinysdd/SKILL.md) into your agent
and ask it to prepare one bounded feature. The skill covers either implementation
inside that agent or delegation to a named worker. Product decisions and review
remain with you or the authority you explicitly delegate to the outer agent.

The first controller sequence is:

```sh
tinysdd init
tinysdd task add --id first-change --brief docs/tasks/first-change.md --allow src/example.mjs,test/example.test.mjs
tinysdd task approve --id first-change --by ivo --reason 'Reviewed this task brief'
tinysdd next
tinysdd task packet --id first-change --json
```

Create the brief first; the [template](../skills/tinysdd/assets/task-brief.md)
identifies its useful contents. Use actual approval attribution, not copied
example text. Allowed paths are exact files, including not-yet-created files;
no globs. Dependencies use `--depends-on first-change` on a later task.

Use the optional `--feature NAME` label to group slices of one feature:

```sh
tinysdd task add --id validation --feature reservations --brief docs/tasks/validation.md --allow src/validation.ts,tests/validation.test.mjs
tinysdd status --feature reservations
```

Record manual usage only when the phase, model and attribution are known. The
token fields accept nonnegative safe integers; use the named phases shown by
`tinysdd --help` and provide either `--task` or `--feature`:

```sh
tinysdd usage record --phase review --model frontier/model --input 1200 --output 400 --reasoning 80 --feature reservations
tinysdd usage report --feature reservations
```

Normalized imports use a versioned JSON envelope with `source`, `exportId` and
stable per-record `externalRecordId` values. The entire file is validated before
anything is appended:

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

An import is a normalized contract; it does not claim that a native Pi or Claude
Code adapter was run. Missing or partial telemetry remains `UNKNOWN`, while
known subtotals and their missing-value provenance stay visible. Use the
explicit feature decision after every currently active labelled task is
accepted:

```sh
tinysdd feature accept --feature reservations --by ivo --reason 'Reviewed the complete feature window'
tinysdd feature report --feature reservations
```

Acceptance appends an immutable report snapshot. Later imports leave that
snapshot unchanged; `feature report` marks it stale when membership or current
task freshness changes. Re-run `feature accept` to record a new window. A
deterministic synthetic talon-shaped fixture is covered by the tests; no real
historical frontier usage is claimed without supplied records.

`status` renders open tasks as a dependency tree. Each task also has a global
topological `order` and sorted `dependents` in `status --json`; filtering by a
feature keeps those positions global. Accepted tasks show the applied worker
run, and closed or superseded tasks appear after the tree with their successors:

```text
broker-s1  accepted (applied from worker-…)
├─ broker-s2  ready
│  ├─ broker-s4  blocked (requires broker-s2)
│  └─ broker-s5  blocked (requires broker-s2, broker-s3, broker-s4)
└─ broker-s3  pending_approval

Closed or superseded:
broker-contract: superseded by broker-s1, broker-s2
```

You can implement the packet in your current agent without invoking a worker.
The controller never changes the model in that outer agent.

To retire a task you abandoned or re-cut, use `task close` or `task supersede`.
Neither needs an approval, so they work on a task whose approval went stale when
its brief changed. The task becomes `closed` or `superseded`, leaves `next`, and
can no longer be approved, reviewed or dispatched. They are refused for an
accepted task and while open tasks depend on it (the error lists them). A
retired task never satisfies a dependency. `supersede` records the successors,
shown under `closure` in `status --json`:

```sh
tinysdd task supersede --id broker-contract --with broker-s1,broker-s2 --by operator --reason 're-cut into slices'
```

When a worker needs an exact API, schema, or acceptance oracle, add a reviewed
context manifest under `.tinysdd/tasks/` and pass it with `--context`. TinySDD
will compile only its declared source line ranges and record their digests; see
[the context compiler guide](context-compiler.md). Omit it for genuinely simple
tasks rather than padding prompts. Approval binds the cited lines, not the whole
file, so slices that cite one shared spec by line range stay current when the
spec is appended to or edited outside their ranges. Inserting lines above a
cited range shifts it and makes the slice stale: append addenda at the end.

Use `task add --protect src/types.ts,tests/contract.test.ts` for read-only
contract files. They must exist and cannot overlap `--allow`. The packet lists
them and the worker prompt forbids changing them; an edit is retained as a scope
violation with reason `protected contract file`, rather than prevented by file
permissions. Approval binds their content digests. Editing a protected file makes
the approval stale and therefore makes an accepted slice `stale` too: it must be
checked again against the changed contract. Acceptance needs no separate field.

To revise an open task's shape, use `task update` with `--by` and `--reason`:

```sh
tinysdd task update --id first-change --allow src/example.mjs --protect tests/contract.test.ts --by operator --reason 'keep the contract fixed'
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
edge, each with its own test file. These advisory thresholds are provisional
and uncalibrated, pending the talon reruns; warnings never block.

When a task has fixed checks, declare them in a reviewed JSON file under
`.tinysdd/tasks/` and pass it with `--checks`. TinySDD validates and binds the
declaration into approval and the worker packet. When the host check runner is
available, packets expose the fixed `run_checks` tool: an optional `checkId`
selects one declared check; omitting it runs them in declaration order. The
separate Linux bubblewrap runner executes the current candidate without network
or credentials. On an unavailable host, the packet records the reason, emits a
warning and runs without the tool. `worker start` and `worker run` repeat the
same `run_checks unavailable: ...` warning on stderr; `--json` keeps stdout to
one JSON result.

`limits.maxCheckRuns` defaults to 12 and accepts integers from 1 to 20 when the
tool is available. Each individual check consumes one run, including checks
requested by an all-checks call. Exhaustion, unknown ids and runner
unavailability throw tool errors while
the worker continues. Pi 1.0.0 executes a batch containing `run_checks`
sequentially in assistant source order: `[write, run_checks]` observes that
write; `[run_checks, write]` checks the earlier candidate. The tool does not
reorder sibling writes. Checks share
the worker wall-clock deadline and are cancelled when the worker ends. Declared
dependency mounts cannot overlap any allowed path.

`checks.jsonl` and bounded output artifacts retain host observations, including
the digests of the candidate bytes checked. `result.workerObservedChecks` labels
these as `source: "worker run_checks", acceptanceEvidence: false`. They are
feedback for the worker; the operator still verifies and accepts separately.

## Configure a worker

For a new project configuration:

```sh
tinysdd init --worker qwen --provider titan --model titan/llamacpp/qwen3.6-35b-a3b-256k
```

For an already initialized project, edit `.tinysdd/config.json` deliberately;
re-running init does not replace it. A configuration with two named workers:

```json
{
  "schemaVersion": 1,
  "defaultWorker": "qwen",
  "workers": {
    "qwen": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/qwen3.6-35b-a3b-256k",
      "profile": "tinysdd-profiles/qwen36.json",
      "limits": { "timeoutMs": 300000, "maxToolCalls": 40 }
    },
    "gemma": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/gemma4-26b-a4b-256k"
    }
  }
}
```

Copy [the exploratory Titan Qwen profile](../profiles/qwen36-titan.json) into
the project's `tinysdd-profiles/qwen36.json` before using this configuration.
It controls Pi's request-level thinking flag; it is not a promise of code quality.
Other machines must use their own exact configured IDs. No fallback is automatic.

Before a launch, TinySDD compares the requested thinking level with what Pi will
actually send for that model entry (rules read from pi-ai 0.84.4). A thinking
level Pi cannot send, because the entry lacks `reasoning: true`, fails
`worker start` and `worker run` before any model call. Warnings cover `thinking: "off"`
with no off toggle (a Qwen chat template then thinks anyway), a missing
`maxTokens` (Pi's silent 16384-token response cap), and thinking without a
`compat.thinkingTokenBudgetField` (reasoning can use the whole response).
`runtime.json` records `thinking` (requested) next to `effectiveThinkingControl`,
`effectiveMaxTokens` and `maxTokensSource`.

To cap reasoning per response, set the request field and, optionally, per-level
budgets in the worker's profile. TinySDD writes the budgets into the worker's
temporary Pi settings; your global Pi settings are never inherited:

```json
"runtime": {
  "thinking": "medium",
  "reasoning": true,
  "compat": { "thinkingFormat": "qwen-chat-template", "thinkingTokenBudgetField": "thinking_budget_tokens" },
  "thinkingBudgets": { "medium": 8192, "high": 16384 }
}
```

Pi clamps the budget so that 1024 tokens of `maxTokens` stay available for the
answer. Without `thinkingBudgets`, Pi's defaults apply (minimal 1024, low 2048,
medium 8192, high 16384). `runtime.json` records the effective budget as
`effectiveThinkingBudget`. The server must honor the field; check one run's
`usage.reasoning` against it.

Optional `limits.firstWriteMs` (below `timeoutMs`) is a no-progress watchdog:
if no `write` or `edit` tool call has started by then, the run stops with outcome
`no_progress` and keeps its raw events, including the partial reasoning. It is
off unless set. The result's `observed.toolCallsByName`, `writeCalls` and
`firstWriteAtMs` (100 ms poll granularity) show how a run spent its time.

Optional worker `skills` lists project-relative SKILL.md files; `instructions`
lists additional project-relative text resources. Applicable AGENTS.md guidance
is included separately. Profiles cannot override task permissions. MCP and
arbitrary runtime extensions are not supported in this first adapter.
`--no-extensions` suppresses extension discovery and Pi 1.0.0 built-ins;
available checks-bearing packets explicitly load only TinySDD’s read-only check
client, with `read,write,edit,run_checks` as the tool allowlist. Unavailable
hosts keep the existing no-check extension and tool arguments. Codemode, MCP,
tool-search and llama.cpp built-ins are not enabled.

Optional `.tinysdd/config.local.json` replaces whole workers by name, not nested
fields. Arrays replace; null/unknown fields are errors. Credentials stay in Pi's
existing configuration/environment, not either project config file. Inspect
resolution before dispatch:

```sh
tinysdd config validate
tinysdd config show --worker qwen --json
tinysdd worker start --task first-change --worker qwen --json
# Poll the returned launch id until data.status is "finished".
# data.request.launchStatus is the launch-time snapshot, not current state.
tinysdd worker status --id LAUNCH_ID --json
```

To end a launch early, run `tinysdd worker stop --id LAUNCH_ID --json` rather than
killing the launcher. It signals the launcher, which stops Pi and finalizes the
run as usual: the result has outcome `stopped` (error code `WORKER_STOPPED`), and
the candidate, patch and raw events are kept. `stopped` is not acceptance; review
the candidate like any other failed outcome. `--wait-ms N` (0 to 600000, default
30000) bounds how long the command waits for the result. If finalizing takes
longer, `data.status` is `stopping`; poll `worker status` until it is `finished`.
`worker stop` signals only a process it can verify is that launch's launcher
(Linux `/proc`), and otherwise fails with `LAUNCH_NOT_OURS` without sending a
signal. Stopping an already stopping launch only waits.

Every non-completed worker result includes `candidateState`: the number of
allowed paths changed and the sorted allowed paths left untouched. A non-completed
result with changed paths is a candidate for review, not a reason to discard it.

## Run an isolated benchmark

Use the benchmark command for an operator-selected suite of `implement-slice`
challenges. A suite directory contains `suite.json`, fixture snapshots, packet
resources, and verifier-only resources. The default suite path is `bench`; pass
the directory or its `suite.json` explicitly when it is elsewhere:

```sh
tinysdd bench run --worker qwen --suite bench --repeat 2 --json
```

The command creates immutable results under
`.tinysdd/bench/<suite-id>/<invocation-id>/`: one case result for every
challenge and repetition, a config identity and digest, and a summary. Each
attempt starts from a fresh fixture. Worker output is retained before visible
and held-out checks run in a separate evaluator input; held-out files never
enter the worker prompt, workspace, candidate snapshot, or a later revision.

`--repeat` is an integer from 1 to 1000. `--json` writes one result object to
stdout; progress and unavailable `run_checks` warnings go to stderr. The
benchmark records verifier unavailability separately and never turns it into a
passing check. It does not apply files, change controller task state, record
acceptance, or qualify a model.

This checkout includes the challenge data at `bench/implement-slice-suite`. It
contains nine runnable `implement-slice` challenges (two new-module, two
brownfield, two bug-fix, one async-heavy, one library-API, and one lint-rule)
plus one runnable `stop-and-ask` challenge. The tenth writes only
`questions/report.json` with named missing inputs and a nonempty question; it
must leave implementation and protected files unchanged. Run the suite with
`--suite bench/implement-slice-suite`.

## Controlled benchmark replay

To compare workers fairly after the live project has moved on, replay the
original approved packet against a prior worker's immutable `workspace-before`
snapshot. This is a non-applying experiment: it neither refreshes stale task
approvals nor changes task status. The replay records both its `baselineRun` and
the exact packet in `.tinysdd/runs/`.

```sh
tinysdd worker start --task first-change --worker gemma \
  --baseline-run WORKER_RUN_ID --json
```

Use a run from the same task. Do not use `--baseline-run` for a revision; use
`--base-run` only when deliberately overlaying a reviewed prior candidate.
If `task update` changes the approved allow, protect, context, checks, or
dependency shape, benchmark replay refuses with `STALE_BENCHMARK_SHAPE` instead
of silently replaying a different packet. Re-approve the revised task before
starting a new benchmark.
For a replay with available checks, dependency mounts are resolved from the
live canonical project root and recorded with a content identity. The replay's
`runtime.json.runChecks.baselineComparison` reports `identical`, `different` or
`unknown`; older baseline artifacts without that identity remain `unknown`.
For a `--base-run` revision, the comparison uses the immediate parent run's
recorded identity; an older parent without that identity remains `unknown`.

## Review the result

The worker edits a disposable copy using read/write/edit. Available declared
checks add the fixed `run_checks` client. Its check results are worker feedback
and point to local evidence and a patch under `.tinysdd/runs/`; the operator
still owns independent verification. The worker does not apply the patch,
commit, or accept its own result. Inference can reach the selected
provider; use only source you are authorized to send there. Raw event files may
contain source. Filename exclusions are not a general secret scanner.
The candidate omits `.git`, `.tinysdd`, `node_modules` and common credential files;
source symlinks are rejected. In a Git work tree the copy set is
`git ls-files --cached --others --exclude-standard`, so gitignored files (runtime
state, build output, local agent homes) are left out while new untracked source
is kept; outside Git the whole tree is walked. `workspaceCopy.mode` in the result
records which was used. An allowed file or context excerpt that exists but is
gitignored fails the run instead of producing an unappliable patch.
Run workers from the project itself or from a real `git worktree`, never from a
hand-synced copy: the copy set comes from Git, so ignored files in the project
directory never reach the worker, and a synced copy only adds ways to break the
`.git` link or pick up stray files. `.tinysdd/` is always left out of the copy,
whether it is committed, untracked or ignored. Put needed dependency interfaces in the task or
selected instruction resources rather than assuming the worker can inspect an
installed dependency tree.

Have your outer agent inspect scope violations and the diff and verify in an
appropriate credential-free disposable environment. Then apply the reviewed run
to the project before recording acceptance: acceptance binds the allowed files'
content, so accepting first and applying later makes the task `stale` and blocks
its dependents. Preserve the observed checks and review findings in a project
file. Then:

```sh
tinysdd task apply --id first-change --run WORKER_RUN_ID --by ivo
tinysdd task review --id first-change --verdict accepted --evidence docs/reviews/first-change.md --by ivo
tinysdd status
tinysdd next
```

`task apply` copies the run's allowed files by content, not by patch, so it also
works for a `--base-run` revision, whose `patch.diff` is a delta against the prior
candidate. It follows the revision lineage back to the first run and applies only
the paths those runs recorded as changed. It refuses with `APPLY_CONFLICT`,
writing nothing, when one of those project files no longer matches the state the
lineage started from. A file that already equals the candidate (for example
applied by hand) is recorded as `already-applied`. It refuses a run of another
task, a benchmark replay, a run with scope violations and a run whose outcome is
not `completed` (a timed-out one included), with no override. It also refuses,
with `APPLY_CHANGES_TASK_INPUT` and nothing written, a run that would rewrite the
task's own brief, context manifest or checks manifest when those are in `--allow`:
the approval they were dispatched under would go stale. The run is recorded
under `applied` in `status --json`, and an accepting review adds `appliedFromRun`,
with `identical: false` when any allowed file differs from what apply left, not
only the files the run changed. Applying is not verification or acceptance.
It also refuses with `RUN_APPROVAL_MISMATCH` when the final run packet was dispatched under a different approval digest; dispatch a fresh run after re-approval.

After an apply the approval keeps binding the context the worker started from:
the cited lines of a file apply wrote are read from the first run's starting copy,
so applying does not make the approval stale, and nothing re-approves the new
source. Every other cited file, including an allowed file the run did not change
and a path that was already applied, is read from the project, so editing it still
makes the approval stale. If a written file's run directory is gone the approval
reads stale, and an apply that would leave the approval stale is refused with
`APPLY_WOULD_STALE` before anything is written. While an apply is
recorded, `task packet` and `worker run` refuse with `TASK_APPLIED`; record the
review first. An accepted or blocked review keeps the apply record. A `revision`
review records `appliedFromRun` and clears the apply record, because the next
attempt builds on the applied project; if the context cites a file apply wrote
whose cited lines changed, the approval then reads `stale_approval` and you re-approve
it explicitly. A later run made with `--base-run` of an already applied run
conflicts, because the project no longer matches the lineage's starting state;
dispatch the next attempt from the applied project instead.

Use `revision` or `blocked` instead of accepting an incomplete result. Caller
evidence is labeled as such; the CLI does not claim to have executed its tests.
For a revision, the next packet includes the recorded review feedback. Retain
that evidence unchanged until dispatch, or explicitly record the revised review.
Changes to a brief, accepted files, evidence or prerequisites invalidate affected
decisions. Approval labels are audit records, not authenticated identities.

Controller mutations use an exclusive lock. If a crash leaves a stale lock, the
CLI stops for manual inspection; it does not guess that another writer is safe
to remove. Do not remove a lock while its owning process is still active.

This version deliberately leaves verification in the outer harness; the CLI
copies a run into the project only when you call `task apply`.
It is suitable for controlled testing, not unsupervised production changes.
