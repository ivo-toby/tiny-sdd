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
On Linux and macOS, the ambient `TMPDIR` (or `/tmp` fallback) is resolved through
host aliases before scratch directories are created. An explicit
`TINYSDD_TMPDIR` must still resolve through a real path without symlinks.

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

## Guided setup for an existing project

For a first use, follow the harness-independent [TinySDD setup
skill](../skills/tinysdd/assets/setup/SKILL.md). It starts from the private
source checkout, loads the product and nested phase skills explicitly, checks
the supported Node/Pi installation layout and sandbox, reuses `init`, config
validation and the worker's existing Pi preflight, and provides a bounded
synthetic readiness smoke. It keeps configured route, operator-reported
backend, runtime-observed identity and unknown model properties separate.

The setup skill does not install packages, read credential stores, start
services or run live inference by itself. Authorize those actions separately;
keep credentials as environment references and inspect the retained
`runtime.json`/`result.json` evidence from the exact worker run.

From this checkout:

```sh
npm test
node bin/tinysdd.mjs --help
```

The offline decision-evaluation foundation is documented in
[docs/decision-evaluation.md](decision-evaluation.md). It compares saved
provider predictions with separately reviewed labels and never performs live
inference. Run it with explicit dataset and prediction files when those
artifacts exist:

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

For the issue #40 observation boundary, see
[docs/decision-providers.md](decision-providers.md). It replays the saved
#32 predictions for at least two provider identities in default shadow mode,
after validating all dataset evidence and bindings. It never calls a provider;
`--log-task` is required for an explicit append to the existing decision
ledger, and `--output` must name a new path:

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

Replay records retain case IDs and decision points. The saved #32 artifacts do
not bind their original typed question, so `questionSha256` remains `UNKNOWN`;
an optional `--questions` file is replay-only mapping metadata recorded as
`replayQuestionSha256` after typed value validation.

Missing model, calibration and threshold metadata stays `UNKNOWN`. Replay
records carry no enforcement action; real provider calls require a separate
operator-reviewed implementation and are outside this offline foundation.

Synthetic fixtures are useful for checking the tooling but do not count toward
the 50 real failure-triage labels required by issue #32. The current checkout
does not contain those real labels or measured provider runs; the evaluator
reports the missing evidence as `UNKNOWN`/warnings.

The offline [Laya training-data exporter](laya-training.md) prepares a
deterministic, digest-bound bundle from real human-reviewed failure-triage
cases. It verifies evidence before writing new `train.jsonl`,
`validation.jsonl`, and `test.jsonl` files, and documents a pinned, unexecuted
training and calibration recipe; it does not run Python, Laya, inference, or
training.

Use `node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs` wherever the examples below
say `tinysdd`. `--project /path/to/project` selects the target explicitly;
otherwise commands use the current directory. No global npm/Pi setup is changed.

## Use it inside your coding agent

Load this checkout's [TinySDD skill](../skills/tinysdd/SKILL.md) into your agent
and ask it to prepare one bounded feature. The skill covers either implementation
inside that agent or delegation to a named worker. Product decisions and review
remain with you or the authority you explicitly delegate to the outer agent.

## Frontier preparation skills

For a complete feature, load the [project-local frontier router](../skills/tinysdd/assets/harness/claude/tinysdd-frontier/SKILL.md). It provides
separate specify, research, plan and slice skills and reusable #20 templates.
The preparation order is:

1. Specify observable requirements, rejection and preservation behavior.
2. Research exact cited source excerpts, callers, checks, dependency accessors
   and lint facts. Mark unavailable facts UNKNOWN.
3. Plan against those retained excerpts with proposal.md, design.md, deltas and
   change.json.
4. Slice a coherent DAG with slice.json, brief.md, context.json and checks.json.

The frontier skills prepare artifacts; they do not approve them. The current
phase CLI implements only the human research handler. If it is configured, use
the real commands. These assets do not bundle the CLI, scripts or schemas; set
the TinySDD checkout and canonical target project roots once when working from
an unrelated directory:

~~~sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
~~~

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

The research-to-plan advance records phase entry only; it does not approve a
plan artifact. Unsupported or unavailable handlers stop truthfully. Existing
task approval remains the implement gate, and existing task review, apply and
feature accept remain authoritative.

Strong preparation writes protected feature integration tests through real
application entrypoints. Small workers write writable slice tests with direct
module imports. Protect every feature test in every active task. The
featureIntegration command uses typed argv and the safe host runner; a passing
direct-import slice test does not establish wiring. Implementation and
slice-test file budgets are configurable advisory warnings, and #82 allows
ordinary extra files in the disposable candidate. Deletion, protected or
preparation edits and arbitrary inference commands remain ineligible.

The pure #81 transition helper remains offline; the active `slice-tests`
commands below invoke the explicitly configured Jev provider. Negative assessments use only explicit
bounded revision policy; every positive assessment requires independent strong
review of identical bytes; exhaustion escalates. Do not invent thresholds or
routes, and do not infer #39 plan approval or #38 engagement semantics. Record
observed frontier usage through the existing canonical phases and mark missing
telemetry UNKNOWN, never zero.

The first controller sequence is:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" init
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task add --id first-change --brief docs/tasks/first-change.md --allow src/example.mjs,test/example.test.mjs
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task approve --id first-change --by ivo --reason 'Reviewed this task brief'
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" next
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task packet --id first-change --json
```

For a portable change descriptor, validate the preparation artifacts and print
the topological registration plan without changing controller state:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
CHANGE_ROOT_RELATIVE=changes/example
CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
TASK_ROOT_RELATIVE=.tinysdd/tasks
TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
SLICE_ID=s1
BRIEF_SOURCE_RELATIVE=changes/example/slices/s1/brief.md
CONTEXT_SOURCE_RELATIVE=changes/example/slices/s1/context.json
CHECKS_SOURCE_RELATIVE=changes/example/slices/s1/checks.json

node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
  --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" \
  --json
```

The plan is read-only. Read the selected slice descriptor's actual `brief`,
`context` and `checks` paths; do not derive a source folder from its ID. Before
registering each slice, copy those exact descriptor bytes to the fixed target
task paths shown by the plan, then use those paths for `task add` and approval.
For example:

```sh
mkdir -p "$TASK_ROOT"
cp "$TARGET_PROJECT/$BRIEF_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.md"
cp "$TARGET_PROJECT/$CONTEXT_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.context.json"
cp "$TARGET_PROJECT/$CHECKS_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.checks.json"
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task add --id "$SLICE_ID" --feature example \
  --brief "$TASK_ROOT_RELATIVE/$SLICE_ID.md" \
  --context "$TASK_ROOT_RELATIVE/$SLICE_ID.context.json" \
  --checks "$TASK_ROOT_RELATIVE/$SLICE_ID.checks.json" \
  --preparation specs/example.md \
  --allow src/example.mjs,tests/example.test.mjs \
  --protect tests/contract.test.mjs
```

Repeat this materialization in topological order for dependent slices. The
explicit copy preserves the approved brief, context and checks bytes; carry every
`allow`, `protect`, `preparation` and `dependsOn` value from the plan, using
`--depends-on` for dependencies. Preparation entries are immutable identity
evidence; an absent entry remains an absence check and is not added to
`--protect` until it exists. Validation does not create these controller inputs.

The format keeps protected feature tests separate from writable slice tests,
checks exact interface citations and records advisory file sizing. The plan and
bundle report the single default `runtimeScope.mode: "ordinary-create-modify"`;
expected paths and file-count budgets guide the worker but do not limit eligible
ordinary file creation or modification. Deletions, filesystem type changes,
internal or secret paths, dependency mounts, protected contracts and immutable
preparation inputs remain ineligible and are retained as review blockers.
An export requires a matching, ready, freshly approved task and writes a new
bundle outside the checkout. It never runs checks, approves, applies or accepts.
Choose an existing canonical output parent (resolve `/tmp` first on systems
where it is an alias); the exporter refuses symlinked output parents.

```sh
BUNDLE_OUT="/absolute/canonical/tmp/${SLICE_ID}-bundle"
node "$TINYSDD_CHECKOUT/scripts/export-slice.mjs" \
  --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" \
  --slice "$SLICE_ID" \
  --out "$BUNDLE_OUT" \
  --json
```

The broker fixture under `examples/artifact-format/` is a synthetic S1–S5b
reconstruction with UNKNOWN historical approval and run evidence. Its protected
feature check enters through the real fixture entrypoint; it is offline evidence
for the descriptor tooling, not a Talon, Pi, provider or foreign-harness run.

For an approved slice consumed by Claude Code or interactive Pi, follow the
[foreign harness adapter guide](harness-adapters.md). The exported bundle and
candidate parent stay outside the source project; the host-managed begin step
retains the exact packet and bundle under `.tinysdd/runs/worker-*` evidence
without changing source code, controller state or approvals. Finalize returns a
completed result through the normal `task apply` and explicit `task review`
commands. Ordinary extra files are retained for review; this API leaves model
identity caller-declared with observed identity `UNKNOWN`, usage and sandbox
`UNKNOWN`, and checks `unrun`. Offline adapter fixtures pass through apply and
synthetic review, while live harness/model/operator acceptance remains pending
(`Refs #31`).

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

When a project enables the optional phase policy in `.tinysdd/config.json`,
record the reviewed research inputs explicitly. The research gate keeps the
proposal, manifest and exact compiled cited excerpts in a bounded immutable
phase ledger; it does not run a model or infer approval for another gate:

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

Phase status always names one feature; TinySDD does not merge independent
features into an aggregate approval view.

The research-to-plan transition records entry into plan only. It is not plan
artifact approval and cannot satisfy a later research predecessor requirement.

Only the configured `human` research handler is available in this increment;
frontier, deterministic and automatic handlers report unavailable. If research
qualification is configured, its named producer must currently be qualified
for the `research` role and its current qualification record is bound to the
phase decision. Changing the proposal, manifest, cited lines, policy,
predecessor or qualification makes the decision stale. The existing task
approval remains the implement gate with its existing digest and apply/review
semantics.

A producer-only research entry is normalized to a required qualification. A
named producer with `qualification.required: false` is rejected until a phase
handler can bind that identity without implying qualification.

If `implement` appears in `phaseGates`, it is only the existing human task
approval alias. Its approval, review, apply and final-run bindings stay in the
task controller; other modes and added phase requirements are rejected.

The bounded #81 transition helper is offline only; it is distinct from the
active `slice-tests` commands below. It requires an explicit
complete `testReview` policy; a negative assessment may request revisions only
within that configured cap, while a positive assessment remains review-required
until a separately identified, caller-declared strong review covers the same
input digest. Missing policy, unknown or non-attested review, exhaustion,
uncertain results and unavailable results never approve or accept a change; no
provider or model is invoked by this interface.

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

Configure the host-run integration check before accepting a feature. The command
is typed argv, never shell text; the declared test paths must be protected feature
tests and the entrypoints must exist:

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

`feature accept` runs this command through TinySDD's bounded host check runner on
retained project and dependency bytes. Missing configuration, an unavailable
Linux sandbox, a failed or timed out check, and project/configuration drift all
refuse acceptance. A successful run retains its result, command identity,
tested bytes and dependency identities; `feature report --json` marks the proof
stale when any of those inputs changes. Every active accepted task scope must
protect the declared test paths. The retained projection accepts regular files
and directories only: symlinks (including common `node_modules/.bin` links) and
special files are refused, and each copied tree is bounded to 20,000 entries
and 512 MiB (manifest bytes are bounded to 512 KiB). macOS currently reports
the runner as unavailable.

```sh
tinysdd feature accept --feature reservations --by ivo --reason 'Reviewed the complete feature window'
tinysdd feature report --feature reservations
```

Acceptance appends an immutable report snapshot. Later imports leave that
snapshot unchanged; `feature report` marks it stale when membership or current
task freshness changes. Re-run `feature accept` to record a new window. A
deterministic synthetic talon-shaped fixture is covered by the tests; no real
historical frontier usage is claimed without supplied records.

After the feature is explicitly accepted and its integration proof is still
fresh, archive its living-spec change with the standalone script:

```sh
node "$TINYSDD_CHECKOUT/scripts/archive-change.mjs" \
  --project "$TARGET_PROJECT" \
  --change changes/reservations/change.json \
  --draft changes/reservations/merge-draft.json \
  --json
```

The change descriptor must live inside a dedicated change directory; a root-level `change.json` is rejected before staging.
The final acceptance check, archive publication and spec writes share the controller lock.
An external `--draft` is retained separately from the change directory’s default draft.

The merge draft is a local-model handoff with explicit requirement IDs, exact
UTF-8 base ranges/text and an output digest. The script validates those bytes,
retains the proposal, delta descriptors, slice DAG, acceptance event, applied
runs and integration evidence under `changes/archive/<change-id>/`, then
applies only the recorded before/after spec bytes. It never removes the source
change or run records. Repeating the command verifies the committed archive
and recovers missing spec writes; a changed draft, stale base, conflicting
current spec or stale acceptance fails without replacing unrelated prose.

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

For offline preparation of the future research phase, see the
[deterministic research selection scorer](research-scoring.md). It compares a
candidate manifest with a reviewed gold manifest through the same compiler,
without running checks, models, or services. Its synthetic examples remain
proposed and human-unreviewed until the research adapter and calibration work
are complete.

Prepare a bounded, digest-bound research packet from any working directory.
The packet retains the exact proposal and eligible source bytes outside the
target project; it does not invoke a model or change project/controller state:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
RESEARCH_PACKET_OUT=/absolute/canonical/tmp/research-packet
node "$TINYSDD_CHECKOUT/scripts/research.mjs" prepare \
  --project "$TARGET_PROJECT" \
  --proposal changes/example/proposal.md \
  --out "$RESEARCH_PACKET_OUT" \
  --max-files 200 --max-source-bytes 524288 \
  --max-map-bytes 262144 --budget-bytes 24576 --json
```

Have the selected research context returned as a strict manifest with an empty
`facts` array, then validate it against the retained packet. The compiler
provides verbatim excerpts, while `purpose` remains an untrusted selection hint:

```sh
RESEARCH_RESULT_OUT=/absolute/canonical/tmp/research-result
node "$TINYSDD_CHECKOUT/scripts/research.mjs" validate \
  --project "$TARGET_PROJECT" \
  --packet "$RESEARCH_PACKET_OUT" \
  --selection "$TARGET_PROJECT/changes/example/research.selection.json" \
  --out "$RESEARCH_RESULT_OUT" --budget-bytes 24576 --json
```

The result is explicitly `draft_unapproved`; it records packet, manifest,
source, excerpt and compiled-context digests without recording a phase decision.
Omit `--gold` when no caller-supplied reference exists: precision and recall
remain `UNKNOWN`. Output directories must be new, canonical and outside the
target project and packet inputs; warnings go to stderr and `--json` writes one
JSON object to stdout. See [the bounded research workflow](research-workflow.md)
for the packet contents and selection contract.

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

`--brief`, `--context`, `--checks`, `--allow`, `--protect`, `--preparation` and
`--depends-on`
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
When the tool is available, the worker contract asks for an edit → `run_checks`
→ fix loop: run the named checks after each allowed write or edit, fix failures
within scope, and stop/report when the check budget or required information or
permission is exhausted. The handoff lists observed checks separately from
checks still unrun. This contract does not add a shell or arbitrary execution
tool; an unavailable runner keeps the existing no-check prompt and Pi tool
arguments.

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

Context compaction stays off unless a profile opts in. To enable deterministic
compaction, add this to the selected profile:

```json
{
  "schemaVersion": 1,
  "id": "qwen-compaction",
  "runtime": {
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 }
  }
}
```

`reserveTokens` must be at least the worker's effective `maxTokens`; an omitted
reserve uses that effective value. The host writes an immutable approved-packet
anchor and loads TinySDD's deterministic extension through the Linux bubblewrap
or macOS Seatbelt sandbox. It elides only paired old `read` and `run_checks`
outputs, retaining their digests and replay markers. Inspect `runtime.json` for
the compaction mode and anchor identity, then `result.json` at
`observed.compactions` for summary and extension-detail digests. Deterministic
events do not receive the model-summary warning; malformed, aborted or
oversized compactions cancel with an explicit reason.

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

Qualification dispatch uses the current worker, the current benchmark suite,
and the effective verifier and runtime facts. Set an optional project suite and
mode in `.tinysdd/config.json`:

```json
"qualification": { "mode": "warn", "suite": "bench/implement-slice-suite" }
```

The mode defaults to `warn`; `enforce` refuses an unqualified
`implement-slice` before launch, and `off` skips qualification checks. An
unavailable current suite or runtime context produces an explicit warning in
`warn` mode. Optional quantization and server metadata remain explicit
`UNKNOWN` facts when absent. A changed model endpoint, profile, verifier,
suite, check declaration, or budget produces a different digest; records for
the old digest are stale.

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

Use the benchmark command for an operator-selected suite of runnable
`implement-slice`, `stop-and-ask`, or `write-tests` challenges. A suite directory
contains `suite.json`, fixture snapshots, packet resources, and verifier-only
resources. The default suite path is `bench`; pass the directory or its
`suite.json` explicitly when it is elsewhere:

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

The write-tests challenge data is at `bench/write-tests-suite`. It contains five
contract-test challenges with a visible reference run and 20 held-out mutant
checks. The verifier reuses the submitted test bytes for every reference and
mutant evaluation, rejects empty, skipped, setup-failing and syntax-invalid
runs, and records `referencePass` plus killed over declared mutants as
measurement data only. These values are derived from the existing verifier
records; they do not change the result shape. Run it with
`--suite bench/write-tests-suite`.

### Score retained benchmark evidence

Qualification reads immutable benchmark results; it does not run Pi, checks, or
another live suite. Pass the suite explicitly so TinySDD can hash its roster and
verify every declared challenge, repetition, and visible or held-out check:

```sh
tinysdd bench qualify \
  --results .tinysdd/bench/write-tests-v1/INVOCATION \
  --suite bench/write-tests-suite \
  --target write-tests=0.8 \
  --json
```

`--suite` is optional: it uses `qualification.suite` when configured and
otherwise `bench`. The first `--results` path anchors the historical digest;
all retained invocations for that exact digest and suite are pooled, including
later failures. A repeated invocation is deduplicated by its immutable ID and
hash. `bench qualify` may create or refresh a record from this offline evidence;
worker dispatch only refreshes an existing exact record and never bootstraps one
from raw benchmark output.

The default target is `0.8` for each role, provisional until #33 calibrates it,
and can be overridden with repeated `--target ROLE=NUMBER` values. Scores use
the two-sided 95% Wilson interval
with z `1.959963984540054`: `qualified` requires lower bound >= target,
`not qualified` requires upper bound < target, and all other results are
`insufficient evidence`. The record retains n, passes, both bounds, confidence,
target, method, invocation and case hashes, the suite roster, and both
best-case counters. `passesToQualify` and `failuresToRuleOut` are minimum extra
consecutive passes or failures under the corresponding best-case bound; they are
not predictions. Repeated cases are pooled as a correlated, provisional
approximation, so the interval is evidence for this retained run rather than
an independence claim.

Qualification scoring is independent of task apply and acceptance: a retained
timeout may count as a statistical case pass when all visible and held-out
checks pass with no hard-gate violation; the raw outcome and task rules remain
unchanged.

Worker `runtime.json` and `result.json` retain the qualification digest and
record path, status, mode, reason, changed identity fields, and warnings. The
same warning is returned by `worker start` and written to stderr by the direct
worker command; JSON mode keeps stdout to one object.

Qualification records are stored under `.tinysdd/qualifications/` with a
dedicated lock and profile sidecar. A repeated exact invocation input is ignored
once and reported as a duplicate; the same attempt ID from different invocation
IDs remains distinct evidence. Rescore a saved record offline without rerunning
anything:

```sh
tinysdd bench rescore \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --target write-tests=0.9
tinysdd bench qualification show \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --suite bench/write-tests-suite --worker qwen
```

`show` reports current identity applicability separately from the historical
qualification status. A profile or any other config identity change makes the
record stale; unavailable identity fields remain `UNKNOWN` and are not treated
as a completeness or eligibility gate. Qualification is evidence only and does
not authorize dispatch or acceptance.

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

Have your outer agent inspect the complete actual candidate inventory and any
boundary violations, then verify the diff in an appropriate credential-free
disposable environment. Apply the reviewed run to the project before recording
acceptance: acceptance binds the planned and actual candidate files, so accepting
first and applying later makes the task `stale` and blocks its dependents.
Preserve the observed checks and review findings in a project file. Then:

```sh
tinysdd task apply --id first-change --run WORKER_RUN_ID --by ivo
tinysdd task review --id first-change --verdict accepted --evidence docs/reviews/first-change.md --by ivo
tinysdd status
tinysdd next
```

For a manually inspected ordinary file that was created or changed outside the
planned paths, include its actual path in the review evidence:

```sh
tinysdd task review --id first-change --verdict accepted \
  --evidence docs/reviews/first-change.md --by ivo \
  --candidate-paths src/manual-extra.mjs
```

The controller unions these paths with the planned and already applied paths,
records their current content identity, and marks the acceptance stale if one
of them changes later.

`task apply` copies every retained eligible actual file by content, not by patch,
so it also works for a `--base-run` revision, whose `patch.diff` is a delta against
the prior candidate. It follows the revision lineage back to the first run and
applies only the complete paths and before/after identities those runs recorded.
It refuses with `APPLY_CONFLICT`, writing nothing, when one of those project files
no longer matches the state the lineage started from. A file that already equals
the candidate (for example applied by hand) is recorded as `already-applied`. It
refuses missing or tampered snapshot/inventory proof, protected or otherwise
ineligible changes, a run of another task, a benchmark replay, a run with scope
violations and a run whose outcome is not `completed` (a timed-out one included),
with no override. It also refuses, with `APPLY_CHANGES_TASK_INPUT` and nothing
written, a run that would rewrite the task's own brief, context manifest, checks
manifest or preparation input: the approval they were dispatched under would go
stale. The run is recorded under `applied` in `status --json`, and an accepting
review adds `appliedFromRun`, with `identical: false` when any planned or actual
candidate file differs from what apply left. Applying is not verification or
acceptance.
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

### Retained slice-test review measurements

`tinysdd --json slice-tests report --feature NAME` reconstructs the retained
#81 assessment and strong-review records. It reports positive-review coverage
and disagreement with explicit denominators, unreviewed negatives, revisions,
escalations and measured Jev usage. Missing measurements remain `UNKNOWN`.
Replay measurements are retained separately and do not count as live inference.
Whole-slice reviews do not establish criterion labels or population calibration.
This report reads evidence; it does not run a provider, approve tests, or accept
a task or feature. The active controller flow is described below.

### Active slice-test review

Configure `testReview` explicitly before using this flow: `positiveThreshold`,
`negativeThreshold` (lower than the positive boundary), `revisionLimit`,
`uncertainRoute: "escalation"`, and `unavailableRoute` (`revision`, `escalation`,
or `unavailable`). There are no numerical defaults. Every criterion at or above
the positive boundary yields a positive assessment; any criterion below the
negative boundary yields a negative assessment; other results escalate.
Projects without an active `testReview` policy retain their existing controller
behavior. A legacy policy without `negativeThreshold` remains valid but does not
activate the slice-test workflow.

1. Run an approved worker candidate, retaining its exact final packet and lineage.
2. Call `slice-tests assess --id ID --run RUN --change changes/CHANGE/change.json
   --implementer MODEL_ID --producer JEV_ID --provider-config config/jev.json
   --credential-env JEV_TOKEN` (as one command). The provider file uses the
   #40 adapter's explicit id, endpoint, model and configSha256 contract; the
   credential travels only through the transport. It is not a command argument,
   retained artifact or worker input. Provider failures retain a failure event.
3. Inspect `slice-tests status --id ID`. A negative verdict permits
   `worker run --task ID --base-run RUN` within the retained revision cap.
   Reassess that returned candidate. Failed/incomplete attempts spend their
   reserved slot; restarting does not reset the cap. A pending interrupted
   assessment requires operator inspection rather than a duplicate invocation.
4. For positive or escalated assessments, run `slice-tests check --id ID
   --event EVENT_ID`. This independently executes the approved slice checks
   against retained candidate bytes, using the safe host runner and frozen
   dependency mounts. These commands do not execute inside the inference sandbox.
5. Have a separately identified strong reviewer inspect the exact retained
   envelope and write evidence. Record it with `slice-tests review --id ID
   --event CHECK_EVENT_ID --input-digest SHA256 --reviewer MODEL_ID
   --strength strong --attested true --verdict accepted --evidence PATH`.
   This records the caller's attestation; it does not invoke or verify that
   reviewer's model execution. Optional measured frontier usage can be supplied
   through `reviewSliceTests`'s `reviewUsage`; absent fields are UNKNOWN.
6. Explicitly `task apply`, then `task review --verdict accepted`, then
   `feature accept`. Strong test review does not accept a task or feature.
   Feature acceptance still executes protected tests through the declared real
   entrypoints. A failed feature check requires operator-requested task revision;
   the applied project becomes its revision base, within the same retained cap.
   Operator revision publication is committed after the controller transition;
   repeat the same revision review after a publication failure to repair its
   retained event and immutable record. An uncommitted intent cannot publish a
   workflow transition.

Changed candidate, approval, policy, retained lineage or strong-review evidence
invalidates use of the reviewed candidate. Accepted tasks retain a review binding;
changed policy or evidence makes that acceptance stale. Old review records remain
valid under their original controller contract. No provider/model fallback exists.

Inputs and immutable event files live under `.tinysdd/runs/slice-test-review/`;
`events.jsonl` reconstructs the workflow and `slice-tests report` its metrics.
`slice-tests dataset --partition train|validation|test [--feature NAME]` emits
reviewed cases in the #32 schema, with immutable evidence references and whole
feature/lineage grouping. Unreviewed negatives are excluded, injected transports
and runners are synthetic, and whole-slice labels do not label each criterion.
The export requires an explicit partition and existing reviews. Reported
calibration, direct-strong comparison and total feature cost remain UNKNOWN
without the corresponding measurements. Live model evaluation remains unverified.
