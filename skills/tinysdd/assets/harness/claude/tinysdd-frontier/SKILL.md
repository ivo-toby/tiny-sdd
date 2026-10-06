---
name: tinysdd-frontier
description: Prepare a bounded TinySDD feature through specify, research, plan and slice, then hand off a reviewed packet to an operator-selected harness.
---

# TinySDD frontier preparation

Use this project-local skill for the strong-model side of TinySDD. It prepares
one bounded feature for an implementation worker or a foreign harness. It does
not implement the feature, invent product decisions, create approvals, invoke a
provider, or replace the controller.

For a new project or runtime, load the harness-independent [setup
skill](../../../setup/SKILL.md) first. This router assumes the source
checkout, project configuration, Pi route and required sandbox have already
been discovered; it does not replace setup or readiness evidence.

Follow the phase skills in order:

1. [specify](specify/SKILL.md) writes observable requirements and clarifications.
2. [research](research/SKILL.md) retains exact cited excerpts, dependency facts
   and UNKNOWNs.
3. [plan](plan/SKILL.md) turns those excerpts into the #20 design, deltas and
   change descriptor.
4. [slice](slice/SKILL.md) creates a coherent slice DAG, protected integration
   checks and worker packets.
5. The operator approves each task through the existing CLI before a worker
   starts.
6. The operator routes the retained candidate through normal verification,
   review, apply and feature acceptance.

The [phase workflow reference](references/phase-workflow.md) is the detailed
contract. The [templates](templates/README.md) contain valid-shaped starting
points. The [artifact format](../../../../../../docs/artifact-format.md) and
the repository's parsers are authoritative when prose and a template disagree.

## Loading a phase skill

The nested phase files are ordinary project-local assets. Claude, Pi or another
harness does not discover them merely because they are below this directory.
Load this router, or pass the exact selected phase `SKILL.md` path through the
harness's explicit skill or route mechanism. Loading a phase file selects
preparation guidance; it does not grant approval or add a controller handler.
When installing a phase as a standalone skill, copy its parent directory with
the sibling `references/` and `templates/` directories intact so its relative
links continue to resolve; register the router or explicit phase route rather
than assuming nested directories become commands automatically. Those assets
are prompt guidance only: they do not include the TinySDD checkout's CLI,
scripts, parsers, schemas or docs. Keep a canonical TinySDD checkout root and
target project root available when running the recipes below.

## Preparation rules

Read AGENTS.md, the current scope, the relevant source and existing checks
before drafting. Trace real callers and data flow. Keep source facts,
operator-reviewed decisions and UNKNOWN facts visibly separate. If a source
contradicts the request or a required caller cannot be established, stop and
ask; do not patch around the contradiction.

Use the ordinary #20 layout under one changes/<change-id>/ directory:

    proposal.md
    design.md
    feature-checks.json
    deltas/<area>.json
    slices/<slice-id>/{slice.json,brief.md,context.json,checks.json}

Reuse the existing #20 schemas and validators. Do not create a second task
descriptor, approval field, phase record, feature-test role or review format.
A successful validator is preparation evidence only.

Strong preparation owns protected feature acceptance/integration tests. Small
workers own writable slice tests. Slice tests may import their module directly;
feature tests must enter through an existing real application entrypoint and
must fail when the new wiring is disconnected. Every active task protects every
feature test. Name caller wiring as an explicit integration obligation and
wiring slice.

Set implementation-file, slice-test-file and compiled-context budgets explicitly
per change or slice. File budgets are advisory sizing values, not a universal
one- or two-file rule. The #82 ordinary-create-modify runtime permits an
additional ordinary file in the disposable candidate; actual extra paths remain
visible to review. Deletion, filesystem type changes, preparation/input/protected
edits, stale evidence and arbitrary inference commands remain forbidden.

## Phase authority

The current phase CLI has a human research handler. Configure and use
phase record/status/advance only for that supported research gate. The
research-to-plan advance records phase entry; it does not approve design,
change.json or any plan artifact. Plan and slice labels, frontmatter,
successful validation, and exported bundles do not grant authority. Existing
task approval is the implement gate; existing review, apply and feature accept
remain the verification and acceptance authority.

If a requested phase handler is unsupported or unavailable, stop and report the
actual result. Do not treat a configuration label as permission. The #81 review
transition is currently an offline contract: it does not call Jev or another
provider, does not choose thresholds or routes, sends negative assessments
through the configured bounded revision path, requires independent strong review
of identical bytes after every positive assessment, and escalates on exhaustion.
Missing, uncertain, unavailable, stale or mismatched evidence cannot approve.

Record usage only with the existing usage schema and canonical phase names:
specify, research, plan, slice, write-tests, review and rescue. Record observed
frontier counts with explicit attribution. Missing counts are UNKNOWN, never
zero or an estimate. Do not silently recount a frozen feature snapshot.

## Foreign harness handoff

Prepare and approve the normal TinySDD artifacts before a foreign harness
consumes a slice. Run the read-only validator and use every value from its
registrationPlan entry. Materialize exact descriptor bytes at the fixed
controller paths, then register dependencies in topological order:

Set these roots once before running the commands, from any working directory:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT=/absolute/path/to/project
    CHANGE_ROOT_RELATIVE=changes/feature
    CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
    TASK_ROOT_RELATIVE=.tinysdd/tasks
    TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
    SLICE_ID=SLICE_ID
    BRIEF_SOURCE_RELATIVE=changes/feature/slices/SLICEDIR/brief.md
    CONTEXT_SOURCE_RELATIVE=changes/feature/slices/SLICEDIR/context.json
    CHECKS_SOURCE_RELATIVE=changes/feature/slices/SLICEDIR/checks.json

`TINYSDD_CHECKOUT` contains the CLI, scripts and schemas. `TARGET_PROJECT` is
the canonical target checkout that owns the descriptor set and `.tinysdd/`
state. Keep `CHANGE_RELATIVE` project-relative: the validator rejects an
absolute `--change` value even when `--project` is absolute. Set the three
`*_SOURCE_RELATIVE` values from the selected slice descriptor's actual
`brief`, `context` and `checks` paths; do not derive a folder from `SLICE_ID`.

    node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --ready --json

    mkdir -p "$TASK_ROOT"
    cp "$TARGET_PROJECT/$BRIEF_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.md"
    cp "$TARGET_PROJECT/$CONTEXT_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.context.json"
    cp "$TARGET_PROJECT/$CHECKS_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.checks.json"

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" task add \
      --id "$SLICE_ID" --feature FEATURE_ID \
      --brief "$TASK_ROOT_RELATIVE/$SLICE_ID.md" \
      --context "$TASK_ROOT_RELATIVE/$SLICE_ID.context.json" \
      --checks "$TASK_ROOT_RELATIVE/$SLICE_ID.checks.json" \
      --allow PLAN_ALLOW_PATHS \
      --protect PLAN_PROTECT_PATHS \
      --preparation PLAN_PREPARATION_PATHS \
      --depends-on PLAN_DEPENDENCY_IDS

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      task approve --id "$SLICE_ID" --by OPERATOR --reason 'Reviewed the slice packet'

Copy every allow, protect, preparation and dependsOn value from the exact plan;
do not shorten or invent lists. Omit `--depends-on` when the plan entry is
empty. Export only a freshly approved task and accepted dependency closure:

    BUNDLE_OUT="/absolute/canonical/tmp/${SLICE_ID}-bundle"
    node "$TINYSDD_CHECKOUT/scripts/export-slice.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" \
      --slice "$SLICE_ID" --out "$BUNDLE_OUT" --json

The foreign harness is a consumer of the packet. It does not create a new
approval, phase gate, plan approval, verification result or acceptance event.
The host must capture the candidate, exact packet and returned evidence, then
route it through task apply and explicit task review. A model completion or
foreign-harness claim is not check evidence. Live provider, Pi, Talon and
foreign-harness acceptance remains unverified unless observed.

The Claude slice worker in ../tinysdd-slice-worker.md is an explicit small-model
subagent template. Install one reviewed copy in a fresh, run-owned adapter
parent outside both the source project and returned candidate, for example
<adapter-parent>/.claude/agents/tinysdd-slice-worker.md, using exclusive create
so an existing file is never overwritten. Start Claude from the returned
candidate below that parent, or use Claude's explicit per-session agent
definition option with the template bytes. Never create the definition inside
the captured candidate: it would become an ordinary source change.

Its tools field restricts the subagent to Read, Write and Edit; it cannot run
checks or commands. Claude may override a requested model through session or
provider policy. Record the requested value as caller-declared; this capture
implementation leaves the observed model as UNKNOWN, so the operator must
confirm the resolved model in a live run and stop on a mismatch.

Do not install or modify global Claude, Pi, provider, credential or project
configuration as part of this skill. Keep the candidate and retained run
artifacts outside the source project except for the host-managed
.tinysdd/runs/worker-* evidence directory.
