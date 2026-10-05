# Frontier phase workflow

This reference is for the strong, frontier side of TinySDD. It prepares the
ordinary #20 artifacts that a small worker or a foreign harness consumes. It is
not a second controller, an approval store, or a provider loop.

## Phase order and artifacts

Use the phases in this order. Keep one change directory and one stable set of
requirement IDs throughout the preparation:

| Phase | Frontier output | Gate or handoff |
| --- | --- | --- |
| specify | proposal.md with observable requirements, clarifications, decisions and UNKNOWN facts | operator reviews the requirements in the conversation |
| research | cited source excerpts in a context manifest and the recorded research inputs | the configured human phase record gate, when enabled |
| plan | design.md, spec deltas and a coherent change.json | plan entry is only a phase record; it is not plan artifact approval |
| tasks/slices | slice descriptors, briefs, context and checks for a DAG | read-only validate-change.mjs; then operator reviews task packets |
| implement | one freshly approved task packet or exported slice bundle | existing task approve is the implement gate |
| verify/review | observed checks, candidate review and feature integration proof | existing task review, task apply and feature accept remain authoritative |

The canonical layout is:

~~~text
specs/<area>.md
changes/<change-id>/
  change.json
  proposal.md
  design.md
  feature-checks.json
  deltas/<area>.json
  slices/<slice-id>/
    slice.json
    brief.md
    context.json
    checks.json
~~~

Use the templates in templates/README.md as starting points and docs/artifact-format.md
as the schema authority. Do not introduce another requirements file, task
descriptor, approval flag or feature-test format.

## Command roots

The phase files and templates are prompt assets; they do not bundle the
TinySDD CLI, scripts, parsers, schemas or repository docs. Run the command
recipes from any working directory after setting these roots:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT=/absolute/path/to/project
    CHANGE_ROOT_RELATIVE=changes/FEATURE
    CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
    TASK_ROOT_RELATIVE=.tinysdd/tasks
    TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
    SLICE_ID=FEATURE-s1
    BRIEF_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/brief.md
    CONTEXT_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/context.json
    CHECKS_SOURCE_RELATIVE=changes/FEATURE/slices/SLICEDIR/checks.json

`TINYSDD_CHECKOUT` supplies `bin/`, `scripts/`, schemas and docs. The canonical
`TARGET_PROJECT` owns the descriptor set and `.tinysdd/` state. Keep
`CHANGE_RELATIVE` project-relative because the validator rejects an absolute
`--change` value; all TinySDD CLI calls select `TARGET_PROJECT` explicitly. Set
the three `*_SOURCE_RELATIVE` values from the selected slice descriptor's
actual `brief`, `context` and `checks` paths; a folder need not match `SLICE_ID`.

## Evidence rules

Read the repository instructions, relevant source, callers and existing checks
before writing a proposal or design. Record three kinds of statements
separately:

- Source fact: directly supported by a file, symbol, test, configuration or
  observed command output. Include a path and line range where practical.
- Proposed decision: a choice made for this change and still subject to the
  operator's review.
- UNKNOWN: a fact that the available sources do not establish. State the
  check or operator decision needed to resolve it.

Research is a retained source selection, not a small-model summary. A context
manifest uses the existing schemaVersion, facts and resources shape. Each
resource names an exact project-relative path, line range and purpose. Compile
it with the existing parseContextManifest(), compileContext() and
contextSizeMetrics() behavior; retain the resulting excerpts and digests.
Include installed dependency versions, exact accessors and repository lint
rules when they could change an implementation. Do not cite a directory dump or
replace an excerpt with an interpretation.

The plan reads those verified excerpts. It should not restart broad repository
research. If an excerpt contradicts the requested behavior or is missing a
caller, return to research and mark the gap UNKNOWN rather than guessing.

## Phase authority

The current phase CLI implements only the human research handler:

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase record --phase research --feature FEATURE \
      --proposal "$CHANGE_ROOT_RELATIVE/proposal.md" \
      --context "$CHANGE_ROOT_RELATIVE/research.context.json" \
      --by OPERATOR --reason 'Reviewed the cited research inputs'
    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase status --feature FEATURE
    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase advance --from research --to plan --feature FEATURE \
      --by OPERATOR --reason 'Research is current and complete'

Configure it explicitly before recording a decision:

~~~json
{
  "schemaVersion": 1,
  "workers": {},
  "phaseGates": { "research": { "mode": "human" } }
}
~~~

The research artifact binds the proposal, manifest and exact compiled cited
excerpts. It becomes stale when those inputs, policy, predecessor or configured
producer qualification changes. A phase advance record enters the plan phase;
it does not approve design.md, change.json, or a
slice plan. There is no implicit frontier, deterministic or automatic handler:
if a requested mode is unsupported or unavailable, stop and report that result.

Plan and slice preparation have no new phase authority in this issue. A label,
frontmatter value, successful validator run or phase entry cannot approve an
artifact. Existing task approval, review, apply and feature acceptance retain
their current meaning.
Do not invent the #39 plan-level approval meaning or #38 engagement semantics;
those decisions remain outside this skill.

## #20 plan and slice contract

change.json must use the exact keys from the #20 parser. Its integration
obligations name the requirement IDs, existing real entrypoints, wiring slice,
protected feature test paths and feature-check IDs. The validator checks the
references; a review must also prove that the test enters through the named
caller and that disconnected wiring fails.

Every slice has the exact slice.json keys from #20:

- implementationFiles are expected implementation outputs, including caller
  wiring when the slice owns it.
- sliceTests are expected tests written or improved by the small worker. They
  may import the slice module directly and are never independent acceptance
  evidence.
- protect includes every change-level feature test and any shared contract or
  regression file that the worker must not edit.
- interfaces are existing callers or contracts, each cited by an exact context
  excerpt.
- dependsOn forms a topologically valid DAG.
- testReview contains questions about the slice tests, interfaces and
  requirements. It does not pre-approve an answer.

Strong preparation writes the protected feature acceptance/integration tests.
Small workers write their own writable slice tests. Keep those roles separate in
the descriptors and review the exact candidate bytes, including additional
ordinary tests. Feature tests must enter through existing application
entrypoints. Add an explicit wiring slice when a caller must be connected; a
name in entrypoints is not proof that the wiring works.

Choose implementation and slice-test budgets per change and per slice as
positive safe integers. They are advisory sizing warnings. There is no universal
one- or two-file ceiling, and #82 permits ordinary extra file creation or
modification in the disposable candidate. The worker still cannot delete files,
change filesystem types, edit preparation or protected inputs, bypass freshness,
or use arbitrary commands in the inference sandbox. Report actual extra paths
to the reviewer.

Run the existing validator before registration:

    node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --ready --json

Treat readiness errors as blockers. Treat expected-file ownership or advisory
budget warnings as preparation feedback, then resolve them or carry them into
the operator review. The validator prints destination paths, not source
descriptor paths; read the selected slice descriptor to set the three source
variables above. Materialize the exact descriptor bytes at the target paths
printed in the registrationPlan. Copy every allow, protect, preparation and
dependsOn value from that plan into task add, in topological order. Do not
shorten the lists by hand:

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

Export only after the selected task and its accepted dependencies are freshly
approved:

    BUNDLE_OUT=/absolute/canonical/tmp/FEATURE-s1-bundle
    node "$TINYSDD_CHECKOUT/scripts/export-slice.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" --slice FEATURE-s1 \
      --out "$BUNDLE_OUT" --json

The validator and exporter are read-only with respect to source code and
controller approval. They do not run slice or feature tests.

## Protected feature acceptance

Configure the existing host integration guard with typed argv and explicit
paths. The feature tests must be protected in every active accepted task:

~~~json
{
  "schemaVersion": 1,
  "workers": {},
  "featureIntegration": {
    "argv": ["node", "tests/feature-integration.test.mjs"],
    "testPaths": ["tests/feature-integration.test.mjs"],
    "entrypoints": ["src/entrypoint.mjs"],
    "dependencyMounts": []
  }
}
~~~

feature accept passes this configured command through the existing safe Linux
host runner against retained project and dependency bytes. It refuses missing,
failed, timed-out, stale or unavailable integration evidence; a human saying
that the feature passed is not a substitute. Symlinks and special files in
retained trees are refused. macOS currently reports the runner unavailable.

The command must exercise the real entrypoint and fail when the feature is
disconnected from that entrypoint. A green direct-import slice test does not
establish this integration boundary.

## #81 review transition

The current transition helper is an offline contract, not an active provider
loop. It does not call Jev or any other provider. Configure every policy value
explicitly; do not invent a threshold, revision cap or uncertain/unavailable
default. The required path is:

1. a Jev assessment rejects the exact candidate bytes;
2. the small worker gets a bounded test revision under the configured policy;
3. every positive assessment receives an independent strong review over the
   identical input digest;
4. an exhausted revision allowance escalates to the configured operator route.

Missing, uncertain, unavailable, stale, non-attested or mismatched-review
inputs do not approve anything. Even a positive independent review returns an
operator-acceptance route; it never auto-accepts a task or feature. Preserve all
candidate revisions and label synthetic or caller-declared evidence as such.

## Usage and handoff

Use the existing usage ledger and CLI. Its canonical phase names are
specify, research, plan, slice, write-tests, review and rescue. Record an
observed frontier row only when model identity, attribution and nonnegative
token counts are known:

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      usage record --phase plan --model frontier/model \
      --input INPUT --output OUTPUT --reasoning REASONING --feature FEATURE

Import external records only through the validated usage-import envelope with
source, exportId and a stable externalRecordId. Missing telemetry is UNKNOWN,
never zero or an estimate. Do not rename the canonical phases or silently
recount a frozen feature snapshot; if an activity has no matching phase, report
it as unknown in the handoff.

At every handoff include the exact artifact paths, current digests or retained
phase record, commands actually run and their counts, warnings, unsupported or
unavailable gates, unrun checks, and open decisions. State that live Pi,
provider, Talon and foreign-harness acceptance is unverified unless those runs
were actually observed.
