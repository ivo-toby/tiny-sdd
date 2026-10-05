# Artifact format reference fixture

This directory is a small, runnable reconstruction of the broker recut used in
the format proposal. `broker-s1` through `broker-s5b` are labeled preparation
descriptors, not historical packets: original approvals, source excerpts and
run evidence are `UNKNOWN`. The six slices use distinct expected outputs so the
fixture can be registered under the current accepted-output freshness rules;
that differs from the historical reconstruction where shared files were
reported.

From the repository root, validate the fixture with:

```text
node scripts/validate-change.mjs --change examples/artifact-format/changes/broker-recut/change.json --json
```

The feature check is offline and uses the real `src/entrypoint.mjs` caller for
all six reconstructed slices:

```text
node examples/artifact-format/tests/feature-integration.test.mjs
```

`tests/feature-wiring.test.mjs` disconnects each declared slice from that
entrypoint and reruns the protected feature test; every mutation fails. Green
isolated slice tests would not establish integration. This is a synthetic
fixture demonstration, not a Talon, Pi, provider, foreign-harness, approval or
historical rerun.

The validator is read-only. To register a slice, materialize the exact
descriptor bytes at the fixed controller paths before `task add` and approval:

```text
mkdir -p .tinysdd/tasks
cp examples/artifact-format/changes/broker-recut/slices/s1/brief.md .tinysdd/tasks/broker-s1.md
cp examples/artifact-format/changes/broker-recut/slices/s1/context.json .tinysdd/tasks/broker-s1.context.json
cp examples/artifact-format/changes/broker-recut/slices/s1/checks.json .tinysdd/tasks/broker-s1.checks.json
tinysdd task add --id broker-s1 --feature broker-recut \
  --brief .tinysdd/tasks/broker-s1.md \
  --context .tinysdd/tasks/broker-s1.context.json \
  --checks .tinysdd/tasks/broker-s1.checks.json \
  --allow examples/artifact-format/src/s1-errors.mjs,examples/artifact-format/tests/s1-errors.test.mjs \
  --protect examples/artifact-format/tests/feature-integration.test.mjs
```

Repeat the copy and registration in the topological order printed by the plan;
the explicit paths preserve byte identity. Carry every `allow`, `protect` and
`dependsOn` value from the plan; pass dependencies with `--depends-on`.

The exporter requires the selected slice task and any accepted dependencies to
be currently registered and freshly approved. Unrelated draft or missing tasks
do not block a selected slice export. It writes a new bundle outside the
checkout and never runs the feature or slice checks.
