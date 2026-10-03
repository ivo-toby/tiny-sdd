# TinySDD implement-slice challenge suite

This suite contains the nine phase-1 `implement-slice` challenges and the
approved tenth `stop-and-ask` challenge for issue #23. Each repetition starts
with the fixture under `fixtures/`; the reference and deliberately wrong
candidates under `candidates/` are audit inputs and are never copied into a
worker workspace.

The strict challenge manifests contain only the benchmark schema fields. The
candidate mapping and audit expectations live in `challenge-audit.json`.
Verifier manifests and their scripts are under `verifier/`; held-out scripts
are never packet resources and are overlaid only into the independent
evaluator copy by the benchmark runner.

The `stop-and-ask` challenge writes only `questions/report.json`, whose exact
fields are `missingInputs` and `question`. Its verifier requires the known
missing input names, a nonempty question, and no invented values; implementation
and protected-file edits remain violations. Its role has a dedicated
`requiredPatchAbsent: false` observation because no implementation patch is
expected.
