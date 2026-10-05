---
name: tinysdd-plan
description: Turn reviewed TinySDD requirements and verified research excerpts into a #20 design and change descriptor.
---

# TinySDD plan

Use this skill after research is current. The plan consumes the retained,
verified excerpts; it is not permission to rediscover the repository or
invent missing facts. It writes #20 preparation artifacts and stops before task
registration or implementation.

Use the [design](../templates/design.md), [change](../templates/change.json),
[delta](../templates/delta.json) and
[feature-checks](../templates/feature-checks.json) templates with the shared
[phase workflow reference](../references/phase-workflow.md).

Read the proposal, the current research phase record or handoff, and the exact
compiled context excerpts. Start from the design and change templates. If a
plan needs a source fact outside the retained excerpts, stop and return to
research with an exact citation request.

Write design.md, one or more delta descriptors, feature-checks.json, and
change.json using the exact #20 schemas. The design must name:

- requirements, interfaces and existing real callers;
- which slice owns each implementation and caller-wiring obligation;
- protected feature acceptance/integration tests;
- writable small-worker slice tests with direct module imports;
- integration check IDs and the feature-test boundary;
- a coherent DAG, dependencies and open decisions;
- explicit per-change and per-slice advisory implementation/test budgets.

Strong preparation owns feature integration tests. A slice test is a writable
worker output and never independent feature evidence. Add a wiring slice when a
caller must be connected. The integration obligation must name the existing
entrypoint and a protected test path; a descriptor entry is not proof that the
test enters through that caller.

Use the current ordinary-create-modify runtime policy. Expected output lists and
file budgets guide sizing but do not limit ordinary extra create/modify files
per the #82 decision. Do not authorize deletion, filesystem type changes,
preparation or protected-input edits, arbitrary inference commands, or a
provider fallback. Keep protected feature tests in every active task scope.

The phase file is prompt guidance; a standalone install does not include the
TinySDD CLI, validator, schemas or repository docs. From any working directory,
set the checkout that supplies those tools and the canonical target project
that owns the descriptor set:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT=/absolute/path/to/project
    CHANGE_ROOT_RELATIVE=changes/FEATURE
    CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"

Run the read-only validator as soon as the descriptor set is coherent. Keep
`CHANGE_RELATIVE` project-relative; `--project` selects the target root:

    node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --json

Fix structural errors and missing citations. Treat expected ownership and
advisory budget warnings as explicit preparation feedback, not hidden policy.
Use --ready only when every slice brief contains the exact review-contract and
approved-requirements sections and openDecisions are empty.

A plan entry is not plan artifact approval. The current phase CLI's
research-to-plan advance records phase entry only:

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase advance --from research --to plan --feature FEATURE \
      --by OPERATOR --reason 'Research is current and complete'

Do not use that command, a successful validator, a label or a descriptor field
as task approval. Hand off the proposal, research record, descriptor paths,
validator JSON, readiness warnings, open decisions and the decisions that still
belong to the operator. Do not register tasks, export bundles or implement code
in this phase.
