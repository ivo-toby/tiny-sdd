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

The exporter additionally requires six currently registered and freshly
approved controller tasks. It writes a new bundle outside the checkout and
never runs the feature or slice checks.
