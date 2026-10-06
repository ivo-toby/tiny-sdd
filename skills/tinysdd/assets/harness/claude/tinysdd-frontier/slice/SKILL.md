---
name: tinysdd-slice
description: Compile a TinySDD #20 change into coherent validated slice packets and a protected feature integration boundary.
---

# TinySDD slice

Use this skill after the operator has reviewed the plan. It turns the #20
descriptor set into bounded packets; it does not change the controller or add a
new phase gate.

Use the [slice](../templates/slice.json), [brief](../templates/slice-brief.md),
[context](../templates/context.json) and [checks](../templates/checks.json)
templates with the shared [phase workflow reference](../references/phase-workflow.md).

If the change adopts a constitution, load
[the constitution skill](../../../../constitution/SKILL.md). Include exact context
ranges covering every line of its approved Markdown in each slice, count those
bytes in the existing budget, and pass the validator's constitution and
approval preparation entries through task registration. Keep both paths
protected and never list either as a writable delta target.

For each slice, write slice.json, brief.md, context.json and checks.json from
the templates. Use the exact schemas parsed by parseSliceDocument(),
parseContextManifest() and parseChecksManifest(). Keep the DAG acyclic and
topological. A slice should own one coherent behavior. If the context compiler
or existing sizing report identifies fake timers with deferred promises, races,
or dense ordering assertions, split the sequential core from the async edge
rather than hiding the complexity in one packet.

Keep these boundaries explicit:

- implementationFiles are expected implementation outputs, including caller
  wiring when assigned;
- sliceTests are expected writable worker tests and may import the slice module
  directly;
- featureTests are strong-prepared protected tests that enter through real
  application entrypoints;
- protect includes every feature test and shared contract/regression path for
  every active task;
- interfaces contains existing caller/contract paths cited by exact context
  excerpts;
- testReview asks how the slice tests establish requirements at those
  interfaces; it does not pre-approve test correctness.

Implementation and slice-test budgets are configurable advisory values. There is
no universal one- or two-file writable ceiling. #82 permits ordinary extra file
creation or modification in the disposable candidate; report actual extras for
review. Deletion, filesystem type changes, preparation/input/protected edits and
arbitrary commands remain forbidden.

A feature check must name every protected feature test as a literal argv
operand. It must exercise the existing entrypoint and fail when the new code is
disconnected from that caller. Direct-import slice tests cannot substitute for
this integration check. Ensure each wiring obligation names the owning slice and
cites its entrypoint.

The phase file is prompt guidance; a standalone install does not include the
TinySDD CLI, validator, exporter, schemas or repository docs. Before
registration, set these roots from any working directory:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT=/absolute/path/to/project
    CHANGE_ROOT_RELATIVE=changes/FEATURE
    CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
    TASK_ROOT_RELATIVE=.tinysdd/tasks
    TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
    SLICE_ID=SLICE_ID
    BRIEF_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/brief.md
    CONTEXT_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/context.json
    CHECKS_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/checks.json

Run the validator with the target project selected explicitly. Keep the change
argument project-relative; the validator rejects an absolute change path:

    node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --ready --json

Read the complete registrationPlan. Set the three `*_SOURCE_RELATIVE` values
from the selected slice descriptor's actual `brief`, `context` and `checks`
paths; a slice folder need not match its `id`. Materialize exact bytes at the
printed target paths. Register each dependency first and pass every
plan allow, protect, preparation and dependsOn value to task add. Do not
shorten a plan list or add an approval flag:

    mkdir -p "$TASK_ROOT"
    cp "$TARGET_PROJECT/$BRIEF_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.md"
    cp "$TARGET_PROJECT/$CONTEXT_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.context.json"
    cp "$TARGET_PROJECT/$CHECKS_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.checks.json"
    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task add \
      --id "$SLICE_ID" --feature FEATURE \
      --brief "$TASK_ROOT_RELATIVE/$SLICE_ID.md" \
      --context "$TASK_ROOT_RELATIVE/$SLICE_ID.context.json" \
      --checks "$TASK_ROOT_RELATIVE/$SLICE_ID.checks.json" \
      --allow PLAN_ALLOW --protect PLAN_PROTECT \
      --preparation PLAN_PREPARATION --depends-on PLAN_DEPENDS

Use the actual operator attribution and reason. Omit --depends-on when the plan
entry is empty. The validator is read-only. Task approval remains the existing
implement gate and must be obtained separately.

After normal task approval and accepted prerequisites, export with the checkout
exporter if a foreign harness needs a portable bundle. Export does not run
checks, apply a candidate or accept a feature:

    BUNDLE_OUT="/absolute/canonical/tmp/${SLICE_ID}-bundle"
    node "$TINYSDD_CHECKOUT/scripts/export-slice.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" \
      --slice "$SLICE_ID" --out "$BUNDLE_OUT" --json

Stop when a
required fact is missing, a plan/descriptor mismatch appears, or a requested
change alters approval, acceptance or verification meaning.
