# Experiment 003: idempotent reservations

This directory contains a bounded, synthetic workflow experiment for the
idempotent batch-reservation feature. It is not a production requirement, a
deployed service, or evidence of actual human acceptance. Results are recorded
in the [results report](results-2026-09-05.md), with behavior, review and process
outcomes distinguished. Finite pilot results do not establish general reliability.

## Artifact map

- `feature.md` is the primary feature contract and decision-provenance record.
- `tasks/01-validation.md`, `tasks/02-service.md`, and `tasks/03-api.md` are
  the ordered task packets. Each packet has a separate implementation scope.
- `skills/tinysdd-prepare/` and `skills/tinysdd-task/` contain experimental
  workflow skills used by the prepared run. They are not installed globally
  and do not replace the current product skill.
- `fixture/` is the disposable participant seed: inventory, seeded GET routes,
  nine original tests, and intentional validation/service stubs.
- `reference/` contains standalone working reference modules and deliberately
  incorrect variants. It is retained outside the participant workspace.
- `checks/` contains independent eight-test holdouts for each task stage. It is
  retained outside the participant workspace.
- `protocol.md` defines the exploratory question, roles, limits, review policy,
  and interpretation boundaries.
- `validate-fixture.mjs` is the preflight validator. `run-task.mjs` is the
  manual task-session runner, and `verify-stage.mjs` is the bounded artifact
  verifier. These are measurement tools, not product code.
- `../runs/003-idempotent-reservations/` receives retained snapshots, digests,
  and phase outputs; manifests and ordinary filesystem files remain writable
  during a run.

## Version boundary

The first two retained Qwen runs use the original v1 inputs; their retained
workspace snapshots, source snapshots and manifests remain under
`../runs/003-idempotent-reservations/`. After the recurring service
caller-ownership finding, the primary amended `protocol.md` for one v2 Qwen
attempt and one separately labeled Gemma transfer.
The v2 participant-visible change is confined to the Task 02 packet: it adds a
concrete caller-mutation acceptance witness. The protocol amendment is
experiment metadata, not supplied model context.

The feature contract, shared types, Tasks 01 and 03, fixture, reference,
independent checks, capture/runtime settings, review and budget policy, and
both experimental skills remain unchanged. Keep v1 and v2 results separate;
this README does not compare models or claim an efficacy effect.

## Preflight and review

Before any participant invocation, inspect `feature.md`, the relevant task
packet, fixture, checks, reference, and runner sources. Freeze or retain their
source snapshots and hashes. The primary reviewer must inspect the verifier and
the supplied workspace/source snapshots before executing a stage verification.

The fixture preflight utility and its CLI should also be inspected before it is
run:

```text
sed -n '1,360p' experiments/003-idempotent-reservations/validate-fixture.mjs
node experiments/003-idempotent-reservations/validate-fixture.mjs
```

The no-argument preflight creates a new retained validation run under
`experiments/runs/003-idempotent-reservations/` and records public, reference,
stub, and mutant checks. Review that output before adding or approving any task
brief execution.

The workflow is manual: initialize once, run one named task, inspect its
workspace/session and evidence, and explicitly invoke the next task only after
review. It never auto-advances tasks or interprets approval. Simulated approval
text is workflow input, not actual human approval.

## Manual task workflow

`run-task.mjs` provides these interfaces:

```text
node run-task.mjs init <qwen|gemma|nemotron>
node run-task.mjs run <absolute-run-dir> <01-validation|02-service|03-api> [absolute-feedback-file]
```

`init` creates a fresh disposable workspace and snapshots the feature, task
packets, experimental skills, fixture, checks, reference, protocol, runner,
and capture libraries. `run` executes one packet in its recorded Pi session.
An optional feedback file is valid only for a later invocation of that same
task/session; it is not an additional approval.

Each task allows at most two invocations, with cumulative limits of 360 seconds
captured Pi wall time and 60 observed tool starts. The second invocation uses
only the remaining budget. Task order and progression remain operator-driven.

All run-directory and feedback-file arguments must be absolute paths. The
runner refuses invalid participants/tasks, changed source snapshots, changed
sessions, exhausted budgets, and feedback on a first invocation. The utility
does not initiate package installation or Git changes. Participant prompts
prohibit task network use, but normal host tools are not a security boundary;
Pi model calls use the existing configured proxy.

## Stage verification

After source inspection, `verify-stage.mjs` consumes the retained workspace
snapshot and retained frozen-experiment-source snapshot, not a live participant
workspace or live source tree:

```text
node verify-stage.mjs <absolute-workspace-snapshot> <absolute-frozen-experiment-source-dir> <1|2|3> <absolute-new-output-dir>
```

The workspace snapshot must contain the candidate `src/` tree. The frozen source
directory must contain `checks/` and `fixture/test/app.test.mjs` plus
`fixture/test/inventory.test.mjs`. Every supplied input and source file must be
a regular non-symlink file; the output directory must be new and outside the
inputs. The verifier copies all candidate source files and both original tests
into `frozen-regressions`, snapshots/hashes itself, and retains hashes and
copied-byte checks.

Stage `1`, `2`, or `3` runs frozen checks `01` through that stage, eight tests
per check, with only `TINYSDD_CANDIDATE_DIR` set. It never selects a mutant or
uses a module override. It then runs the copied original app and inventory
tests directly with TAP, expecting four and five tests respectively. Each
child uses the absolute Node executable, clean `PATH=/usr/bin:/bin`, closed
stdin, regular stdout/stderr files, shell disabled, and a 20-second kill bound.
`result.json` retains commands, environments, statuses, signals, timeout state,
TAP counts, output paths, hashes, and the overall pass decision. Failed checks
still retain their output; no score is inferred here.

The following is an illustrative placeholder only, not a live command sequence:

```text
RUN=/absolute/path/to/experiments/runs/003-idempotent-reservations/task-PLACEHOLDER
node experiments/003-idempotent-reservations/run-task.mjs run "$RUN" 01-validation
node experiments/003-idempotent-reservations/run-task.mjs run "$RUN" 01-validation /absolute/path/to/review-PLACEHOLDER.md
node experiments/003-idempotent-reservations/verify-stage.mjs /absolute/path/to/workspace-snapshot-PLACEHOLDER /absolute/path/to/frozen-source-PLACEHOLDER 1 /absolute/path/to/new-output-PLACEHOLDER
```

Consult the linked results report for reviewed outcomes and limitations. The
manual utility also accepts Nemotron as a configured participant, but this
protocol does not authorize a Nemotron feature run; its earlier tool
qualification remains unresolved.
