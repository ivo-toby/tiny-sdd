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

Before registration, run:

    node scripts/validate-change.mjs --project /absolute/project \
      --change changes/FEATURE/change.json --ready --json

Read the complete registrationPlan. Materialize exact brief, context and checks
bytes at the printed .tinysdd/tasks paths. Register each dependency first and
pass every plan allow, protect, preparation and dependsOn value to task add.
Do not shorten a plan list or add an approval flag:

    tinysdd task add --id SLICE_ID --feature FEATURE \
      --brief .tinysdd/tasks/SLICE_ID.md \
      --context .tinysdd/tasks/SLICE_ID.context.json \
      --checks .tinysdd/tasks/SLICE_ID.checks.json \
      --allow PLAN_ALLOW --protect PLAN_PROTECT \
      --preparation PLAN_PREPARATION --depends-on PLAN_DEPENDS

Use the actual operator attribution and reason. Omit --depends-on when the plan
entry is empty. The validator is read-only. Task approval remains the existing
implement gate and must be obtained separately.

After normal task approval and accepted prerequisites, export with
scripts/export-slice.mjs if a foreign harness needs a portable bundle. Export
does not run checks, apply a candidate or accept a feature. Stop when a
required fact is missing, a plan/descriptor mismatch appears, or a requested
change alters approval, acceptance or verification meaning.
