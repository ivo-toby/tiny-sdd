# Frontier artifact templates

These files are valid-shaped starting points, not approvals. Replace every
example path, ID and requirement with values from the current repository, then
run the existing validator against the filled change directory. A template
cannot establish a product decision or make a phase current.

Use one change directory:

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

Copy the templates into that layout:

- proposal.md records behavior, rejection and preservation cases, decisions and
  UNKNOWN facts.
- design.md records interfaces, real callers, wiring responsibilities,
  integration checks and the slice DAG.
- change.json, delta.json, feature-checks.json and slice.json use the exact #20
  JSON keys. Do not add a parallel key for a phase, approval or test role.
- context.json uses the current context compiler manifest. Keep each resource's
  line range exact and explain its purpose.
- checks.json and feature-checks.json use the existing checks-manifest schema.
  Commands are argv arrays, never shell strings.
- slice-brief.md must contain the exact Slice test review contract and Approved
  slice requirements sections before export readiness.

The example values intentionally point at a hypothetical feature. They are
placeholders until the paths exist in the target repository. For a complete
filled and runnable reference, use examples/artifact-format/ from the TinySDD
checkout. Set the tooling and target roots explicitly, even when they are the
same checkout:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT="$TINYSDD_CHECKOUT"
    CHANGE_RELATIVE=examples/artifact-format/changes/broker-recut/change.json
    node "$TINYSDD_CHECKOUT/scripts/validate-change.mjs" \
      --project "$TARGET_PROJECT" --change "$CHANGE_RELATIVE" \
      --ready --json

The validator is read-only. It reports advisory implementation and slice-test
budget warnings separately from readiness errors. For another target project,
keep `TINYSDD_CHECKOUT` pointed at this checkout and set `TARGET_PROJECT` to
the canonical target root; keep `CHANGE_RELATIVE` project-relative. Materialize
exact brief, context and checks bytes at the target `registrationPlan` paths,
pass every plan allow/protect/preparation/dependsOn value to task add, and
obtain normal operator approval before exporting a slice.
