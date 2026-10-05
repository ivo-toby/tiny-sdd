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
filled and runnable reference, use examples/artifact-format/ and run:

    node scripts/validate-change.mjs \
      --change examples/artifact-format/changes/broker-recut/change.json \
      --ready --json

The validator is read-only. It reports advisory implementation and slice-test
budget warnings separately from readiness errors. Materialize exact brief,
context and checks bytes at the registrationPlan paths, pass every plan
allow/protect/preparation/dependsOn value to task add, and obtain normal
operator approval before exporting a slice.
