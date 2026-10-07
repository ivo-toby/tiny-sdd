# CLI workflow

Run `tinysdd --help` for the installed interface. In a source checkout use
`node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs`; run it from the target project
or select `--project /path/to/project`. Add `--json` for machine-readable output.

For a fresh existing project, start Claude or Codex from this checkout and use
the native repository registration for the harness-independent setup skill:
`/tinysdd-setup` in Claude or `$tinysdd-setup` in Codex. Then load
`/tinysdd` or `$tinysdd` for this workflow. If discovery is unavailable, start
a new session or restart the harness. These registrations are scoped to this
checkout and do not install skills into the target project. The setup skill
explains the private source-checkout route, explicit loading of the
product/router/phase skills, supported Node/Pi layouts, provider/model and
credential boundaries, reusable `init`/`config validate`/preflight, and the
bounded synthetic readiness smoke.

For the separate, offline decision-model evaluation foundation, see
[docs/decision-evaluation.md](../../../docs/decision-evaluation.md). It consumes
explicit dataset, saved-prediction, and optional metrics files; it does not call
a provider or alter controller state:

```sh
node scripts/evaluate-decisions.mjs \
  --dataset data/decision-dataset.json \
  --predictions data/predictions.json \
  --metrics data/metrics.json \
  --output data/evaluation-report.json \
  --json
```

The report output path must be new and must not overwrite the dataset,
predictions, metrics, or validated evidence files.

The dataset keeps worker observations separate from human-reviewed labels,
verifies source-file digests, rejects split-group leakage, and counts synthetic
fixtures separately from the 50 real failure-triage labels still required by
issue #32. Missing measurements remain `UNKNOWN`.

For the separate offline Laya experiment, see
[docs/laya-training.md](../../../docs/laya-training.md). Its exporter accepts
an explicit four-label choice question, retains only real reviewed failure
triage cases with nonempty check logs, preserves the #32 partitions and groups,
and writes a new digest-bound training bundle. The recipe remains unexecuted:
it does not install Python, download a checkpoint, call a provider, or claim a
trained-model result.

Issue #40 adds an offline provider observation replay. It requires two or more
saved provider identities, validates all dataset evidence and #32 bindings
before any write, and defaults to shadow mode without invoking a model:

```sh
node scripts/observe-decisions.mjs \
  --project /path/to/project \
  --dataset data/decision-dataset.json \
  --predictions data/provider-predictions.json \
  --providers data/provider-metadata.json \
  --output data/provider-observations.json \
  --log-task failure-triage \
  --json
```

Replay records retain case IDs and decision points. Because #32 predictions do
not bind their original typed question, `questionSha256` stays `UNKNOWN`; an
optional `--questions` file is validated and recorded only as
`replayQuestionSha256` mapping metadata.

`--providers` supplies model identity and explicit availability; omitted model,
calibration and threshold metadata remains `UNKNOWN`. `--output` refuses an
existing or input/evidence path. `--log-task` is the only way to append the
validated, digest-only observations to `.tinysdd/runs/decisions/`; omitting it
leaves the existing ledger and controller state unchanged. `enforce` is
unsupported until real reviewed comparisons and operator-approved thresholds
exist.

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

## Frontier preparation phases

For a full feature, load the [project-local frontier router](../assets/harness/claude/tinysdd-frontier/SKILL.md). It links
separate specify, research, plan and slice skills and their #20 templates.
When the operator adopts project principles, load the
[constitution skill](../assets/constitution/SKILL.md) before specify. Keep
`change.constitution` optional: a project file's presence alone does not adopt
it into a change.
Use the phases in that order:

1. Specify requirements, rejection and preservation behavior. Keep proposed
   decisions and UNKNOWN facts visible.
2. Research exact source excerpts, callers, checks, dependency accessors and
   lint facts in the existing context-manifest shape. Research evidence is
   retained cited bytes, never a small-model interpretation.
3. Plan against those excerpts with proposal.md, design.md, deltas and
   change.json. The plan names real entrypoints, wiring slices, protected
   feature tests, writable direct-import slice tests and advisory budgets.
4. Slice the coherent DAG into slice.json, brief.md, context.json and checks.json.
   Validate with the existing read-only script before registration.

The frontier phase files prepare artifacts only. A successful validator,
frontmatter value, or phase label does not approve anything. They do not bundle
the TinySDD CLI, scripts or schemas. Set these roots when working from any
directory; `TARGET_PROJECT` owns the descriptor set and controller state:

~~~sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
~~~

The current phase CLI supports only the human research gate:

~~~sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
  phase record --phase research --feature reservations \
  --proposal changes/reservations/proposal.md \
  --context changes/reservations/research.context.json \
  --by operator --reason 'Reviewed the cited research inputs'
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
  phase status --feature reservations
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
  phase advance --from research --to plan --feature reservations \
  --by operator --reason 'Research is current and complete'
~~~

The research-to-plan advance records phase entry; it is not plan artifact
approval. Unsupported or unavailable phase handlers stop truthfully. Existing
task approval remains the implement gate. Each active task protects every
feature test. Use featureIntegration's typed argv, testPaths and entrypoints
with the existing safe host runner for final feature acceptance; direct-import
slice tests cannot substitute for a real-entrypoint integration test. The #82
ordinary-create-modify scope allows ordinary extra files, while file lists and
budgets remain advisory and deletion remains ineligible.

The pure #81 transition helper is offline; the active `slice-tests` commands
invoke only an explicitly configured Jev provider.
Negative assessments use only an explicit bounded revision policy; every
positive assessment requires independent strong review of identical bytes;
exhaustion escalates. Thresholds and uncertain/unavailable routes have no
implicit defaults. Do not infer #39 plan approval or #38 engagement semantics.
Record observed frontier usage only with the existing canonical usage phases;
missing telemetry is UNKNOWN, never zero.

For a portable change descriptor, validate the bounded preparation and print a
read-only topological registration plan:

```sh
CHANGE_ROOT_RELATIVE=changes/example
CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
TASK_ROOT_RELATIVE=.tinysdd/tasks
TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
SLICE_ID=s1
BRIEF_SOURCE_RELATIVE=changes/example/slices/s1/brief.md
CONTEXT_SOURCE_RELATIVE=changes/example/slices/s1/context.json
CHECKS_SOURCE_RELATIVE=changes/example/slices/s1/checks.json

node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
  --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --json
```

The validator only prints destination paths in the plan. Read the selected
slice descriptor's actual `brief`, `context` and `checks` paths; a source folder
need not match the slice ID. Copy those exact descriptor inputs to the fixed
target paths before `task add` and approval:

```sh
mkdir -p "$TASK_ROOT"
cp "$TARGET_PROJECT/$BRIEF_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.md"
cp "$TARGET_PROJECT/$CONTEXT_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.context.json"
cp "$TARGET_PROJECT/$CHECKS_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.checks.json"
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task add --id "$SLICE_ID" --feature example \
  --brief "$TASK_ROOT_RELATIVE/$SLICE_ID.md" --context "$TASK_ROOT_RELATIVE/$SLICE_ID.context.json" \
  --checks "$TASK_ROOT_RELATIVE/$SLICE_ID.checks.json" \
  --preparation specs/example.md \
  --allow src/example.mjs,tests/example.test.mjs --protect tests/contract.test.mjs
```

Repeat in topological order for dependencies. Copying the bytes explicitly keeps
the registered packet inputs identical to the approved descriptor files; carry
every `allow`, `protect`, `preparation` and `dependsOn` value from the plan,
using `--depends-on` for dependencies. An absent preparation entry remains an
absence check and is not added to `--protect` until it exists. The validator does
not create controller files.

The plan reports separate writable slice-test and protected feature-test roles,
advisory file sizing and the current default `runtimeScope` (ordinary
create/modify). To export a freshly
approved slice, use a new directory under an existing canonical parent; the
exporter checks packet identity and writes no project files or controller state:

```sh
BUNDLE_OUT="/absolute/canonical/tmp/${SLICE_ID}-bundle"
node "$TINYSDD_CHECKOUT/scripts/export-slice.mjs" \
  --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --slice "$SLICE_ID" \
  --out "$BUNDLE_OUT" --json
```

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

The optional phase ledger provides the first end-to-end gate for research. Set
an explicit policy before recording it:

```json
{
  "schemaVersion": 1,
  "workers": {},
  "phaseGates": { "research": { "mode": "human" } }
}
```

```sh
tinysdd phase record --phase research --feature reservations \
  --proposal docs/research-proposal.md --context docs/research.context.json \
  --by operator --reason 'Reviewed the current research inputs'
tinysdd phase status --feature reservations
tinysdd phase advance --from research --to plan --feature reservations \
  --by operator --reason 'Research is current and complete'
```

Phase status requires an explicit feature; independent features are reported
separately and are never folded into an aggregate approval view.

The research-to-plan transition records phase entry only. It does not approve
a plan artifact or satisfy a later research predecessor requirement.

Research records retain bounded proposal and manifest references plus exact
compiled cited excerpts. The record becomes stale when cited content, inputs,
policy, configured predecessor, or named producer qualification changes.
Only the human handler is implemented; other modes report unavailable and
cannot masquerade as operator approval. Existing task approval remains the
implement-phase gate.

A producer-only research entry is normalized to required qualification; a
named producer paired with `qualification.required: false` is rejected because
this increment has no identity-only phase handler.

An optional `implement` entry in `phaseGates` names that same human task
approval gate. Task approval, review, apply and final-run bindings remain the
authority; non-human modes and added phase requirements are rejected.

The bounded #81 transition helper is also offline; the active commands below
are separate. It accepts no inferred
thresholds or routes: a complete `testReview` policy must be supplied. Negative
assessments may request revisions up to that policy's cap; positive assessments
require a separately identified, caller-declared strong review over the same
input digest and still return operator acceptance rather than automatic
acceptance. Missing, uncertain, unavailable or non-attested review states never
approve a change, and this interface does not invoke a provider or model.

For external data, use the normalized import envelope with a `source`, an
`exportId`, and a stable `externalRecordId` on every record. TinySDD validates
the complete file before appending it. This import contract is separate from
the offline [foreign harness adapter guide](../../../docs/harness-adapters.md):

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

The adapter guide covers host-managed begin/finalize for an operator-selected
Claude Code or interactive Pi session. It keeps the exported bundle and
candidate outside the source project, retains the exact packet and source-derived
baseline under host-managed `.tinysdd/runs/worker-*` evidence, and returns a
completed result through normal `task apply` followed by explicit `task review`.
Ordinary extra files remain reviewable; this API leaves model identity
caller-declared with observed identity `UNKNOWN`, usage and sandbox behavior
`UNKNOWN`, and checks `unrun`. The offline fixtures exercise both adapters
through synthetic apply and review; live
harness/model/operator acceptance remains pending (`Refs #31`).

After reviewing every active labelled task, close a feature window explicitly:

Set `featureIntegration` in `.tinysdd/config.json` first. Its `argv` array is
passed to the host check runner without a shell, and `testPaths` must identify
protected feature tests while `entrypoints` identifies real files. For example:

```json
{
  "schemaVersion": 1,
  "workers": {},
  "featureIntegration": {
    "argv": ["node", "tests/reservations-integration.mjs"],
    "testPaths": ["tests/reservations-integration.mjs"],
    "entrypoints": ["src/reservations.mjs"]
  }
}
```

`feature accept` executes the configured command on retained isolated bytes and
records its bounded result and identities in the acceptance event. It refuses
when configuration, the Linux sandbox, the check, the protected test, the
entrypoint, or any retained project/dependency bytes are unavailable or stale.
Every active accepted task scope must protect the declared test paths. Retained
project and dependency trees are regular-file-only: symlinks (including common
`node_modules/.bin` links) and special files are refused; each tree is bounded
to 20,000 entries and 512 MiB, and a manifest is bounded to 512 KiB.
Historical events without this optional proof remain readable but are reported
as ineligible; their frozen usage report is unchanged.

```sh
tinysdd feature accept --feature reservations --by operator --reason 'Reviewed the feature window'
tinysdd feature report --feature reservations
```

The acceptance event freezes report numbers and run references. Later usage is
visible only after an explicit re-acceptance; current membership or task
freshness changes mark the frozen snapshot stale while preserving its numbers.
Unknown or partial observations remain `UNKNOWN` with their provenance.

Archive a living-spec change only after this explicit acceptance remains fresh:

```sh
node scripts/archive-change.mjs --project /path/to/project \
  --change changes/example/change.json \
  --draft changes/example/merge-draft.json --json
```

The change descriptor must live inside a dedicated change directory; a root-level `change.json` is rejected before staging.
The final acceptance check, archive publication and spec writes share the controller lock.
An external `--draft` is retained separately from the change directory’s default draft.

`merge-draft.json` is a local-model handoff. Its mappings bind each stable
requirement ID to exact UTF-8 base ranges/text and an output digest; the host
performs the merge mechanically and preserves untouched prose. The committed
archive retains the source change tree, before/after specs, feature acceptance
and integration/run evidence. Repeating the command verifies those retained
bytes and can recover missing spec writes, while a stale acceptance, changed
draft/base, conflicting current spec or redirected archive record is refused.

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
Ambient `TMPDIR` (or the `/tmp` fallback) is resolved through host aliases on
Linux and macOS before disposable scratch directories are created. An explicit
`TINYSDD_TMPDIR` remains strict: its path and parents must resolve without
symlinks.

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

The offline [research selection scorer](../../../docs/research-scoring.md) is a
preparation helper for the research phase. It compiles a candidate and a gold
context manifest through the ordinary context compiler, reports merged
line-overlap precision/recall and compiled-byte budget observations, and
records invalid citations as hard-gate observations. It does not run checks,
invoke a model, accept a task, or qualify a role; its synthetic examples are
proposed and human-unreviewed.

Issue #29 adds a bounded packet and selection handoff around that compiler.
Run it from any directory with explicit checkout, target and new output paths:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
RESEARCH_PACKET_OUT=/absolute/canonical/tmp/research-packet
node "$TINYSDD_CHECKOUT/scripts/research.mjs" prepare \
  --project "$TARGET_PROJECT" --proposal changes/example/proposal.md \
  --out "$RESEARCH_PACKET_OUT" \
  --max-files 200 --max-source-bytes 524288 \
  --max-map-bytes 262144 --budget-bytes 24576 --json
```

The preparation command retains exact proposal/source bytes and emits a
selection-only prompt. A caller-selected model or harness may return a strict
context manifest, but the command itself invokes no provider, model, service or
source code. The returned manifest must have `facts: []`; each `purpose` is an
untrusted selection hint.

```sh
RESEARCH_RESULT_OUT=/absolute/canonical/tmp/research-result
node "$TINYSDD_CHECKOUT/scripts/research.mjs" validate \
  --project "$TARGET_PROJECT" --packet "$RESEARCH_PACKET_OUT" \
  --selection "$TARGET_PROJECT/changes/example/research.selection.json" \
  --out "$RESEARCH_RESULT_OUT" --budget-bytes 24576 --json
```

Validation rechecks proposal and cited source identities, compiles verbatim
excerpts through `compileContext()`, and writes a `draft_unapproved` report
without changing phase/state/approval artifacts. `--gold PATH` is optional and
uses the offline scorer; without it, precision and recall are `UNKNOWN`, and a
caller-supplied gold manifest has no implied human-review or calibration status.
Output paths must be fresh canonical directories outside the target, packet and
selection inputs. Warnings go to stderr; `--json` emits exactly one JSON object.
The complete packet contract is in
[docs/research-workflow.md](../../../docs/research-workflow.md).

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
TinySDD overlays every retained eligible actual change from that prior run into
the new disposable workspace and records the lineage; it never changes the
source project. The run must retain complete before/after identities and full
snapshot inventories; missing or tampered proof is refused.
For a benchmark replay, an intervening `task update` that changes the approved
allow, protect, context, checks, or dependency shape is refused with
`STALE_BENCHMARK_SHAPE`; re-approve the revised task before starting a new
benchmark.

Inspect the finished result envelope, complete actual candidate inventory and
patch. Process completion is not passing verification, and boundary violations
are review blockers. Use the outer harness to verify the candidate in an
appropriate isolated environment, and retain observed test results plus review
findings in a file. Apply the reviewed run to the project with `task apply` before
recording acceptance, because acceptance binds planned and actual candidate
content: accepting first makes the task `stale` and blocks its dependents. Then
record the decision explicitly:

```sh
tinysdd task apply --id validation --run WORKER_RUN_ID --by operator
tinysdd task review --id validation --verdict accepted --evidence docs/reviews/validation.md --by operator
tinysdd status
tinysdd next
```

When the operator accepts a manually inspected ordinary file outside the
planned paths, include every such actual path in the review:

```sh
tinysdd task review --id validation --verdict accepted \
  --evidence docs/reviews/validation.md --by operator \
  --candidate-paths src/manual-extra.mjs
```

Candidate paths are unioned with planned and applied paths, and their content
identity is retained; editing one later makes the acceptance stale.

`task apply` copies every retained eligible actual file by content, so it works for
a `--base-run` revision too (a revision's `patch.diff` is a delta against the
prior candidate, not the project). It follows the lineage to the first run,
validates complete snapshot and before/after identity evidence, and applies only
the paths those runs recorded as changed. It refuses with `APPLY_CONFLICT`,
writing nothing, if one of those project files no longer matches the state the
lineage started from; files that already equal the candidate are recorded as
`already-applied`. It refuses missing or tampered evidence, protected or other
ineligible changes, another task's run, a benchmark replay, boundary violations
and a run whose outcome is not `completed` (a timed-out run included), with no
override. It also refuses, with `APPLY_CHANGES_TASK_INPUT` and nothing written, a
run that would rewrite the task's own brief, context manifest, checks manifest or
preparation input, since that would leave the approval it was dispatched under
stale. The record shows under `applied` in `status --json`; an accepting review
adds `appliedFromRun` with `identical: false` if any planned or actual candidate
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
an edit → `run_checks` → fix loop after each eligible ordinary file write or edit.
Failures are fixed only within the approved task boundaries; the worker stops and reports when the
declared budget or required information or permission is exhausted, and names
observed checks separately from checks still unrun. An unavailable client keeps
the existing no-check prompt and Pi tool arguments.

For retained #81 test-review measurements, use `tinysdd --json slice-tests report`
with optional `--feature NAME`. Keep the reported denominators and `UNKNOWN`s:
unreviewed negatives are not false-rejection labels, replay latency is not live
inference, and whole-slice reviews do not label every individual criterion.
Reporting does not invoke a provider or grant acceptance. The active review and
revision controller flow is still follow-up work.

For active review, configure explicit `testReview` positive/negative boundaries,
revision limit, `uncertainRoute: "escalation"` and an unavailable route. Follow
`slice-tests assess` → `slice-tests check` → `slice-tests review`, identifying
implementer, assessor and independent strong reviewer separately. Every positive
requires passing independent checks and a strong-review attestation for the exact
retained input digest. The review command records an external review; it does not
invoke the strong model. Negative assessments feed bounded `worker run --base-run`
revisions. Explicit revision after apply uses the applied project as its base.
Pending/incomplete attempts cannot reset the budget. Use `slice-tests status` to
inspect the retained route. No automatic task/feature acceptance follows.
Operator revision publication follows the controller transition and retains a
retryable intent until its ledger event and immutable record are both present;
repeat the same revision review after a publication failure. An intent from an
uncommitted controller transition remains inert.

`task apply` and `task review --verdict accepted` enforce fresh test review when
an active `testReview` policy with `negativeThreshold` is configured; `feature
accept` additionally runs the configured protected integration tests through real
entrypoints. Old projects without this active policy retain their existing
approval contract. Review, policy and code changes
invalidate the new review binding. `slice-tests dataset --partition test` exports
reviewed #32 cases with immutable evidence and feature/lineage grouping; choose
train/validation/test explicitly. Synthetic inputs stay labeled, unavailable
measurements stay UNKNOWN, and no savings or quality improvement is established
by the offline suite. See the quickstart's active review sequence for arguments.
