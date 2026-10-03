# TinySDD implement-slice challenge suite

This suite contains the nine executable phase-1 `implement-slice` challenges
for issue #23. Each repetition starts with the fixture under `fixtures/`; the
reference and deliberately wrong candidates under `candidates/` are audit
inputs and are never copied into a worker workspace.

The strict challenge manifests contain only the benchmark schema fields. The
candidate mapping and audit expectations live in `challenge-audit.json`.
Verifier manifests and their scripts are under `verifier/`; held-out scripts
are never packet resources and are overlaid only into the independent
evaluator copy by the benchmark runner.

The tenth `stop-and-ask` challenge is intentionally absent. The v1 runner has
no approved adapter for question output, so adding one would change the
acceptance meaning still reserved for the operator.
