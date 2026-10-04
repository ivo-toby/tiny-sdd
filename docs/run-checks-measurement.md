# Measuring the check-guided worker contract

This is the reproducible protocol for issue #42. It is a protocol, not a
measurement report. No live model, Pi, Talon or benchmark result is claimed by
this document.

## Comparison

Compare the unchanged `main` baseline at
`66a4f47762afe1f067ad73aa21c98a37548353b5` with the exact changed issue #42
revision recorded by each run's `configIdentity.codeRevision`. Resolve and
retain both revisions before launching either arm. Use the same:

- worker model and quantization, provider/server and endpoint configuration;
- worker profile and effective limits (`timeoutMs`, `maxToolCalls`,
  `firstWriteMs`, and `maxCheckRuns`);
- Pi version and TinySDD runtime environment;
- suite, verifier, fixture and packet bytes;
- repetition count, revision allowance, stop conditions and operator policy.

The ordinary default suite is `bench`. The issue #23 implement-slice set must
be selected explicitly as `bench/implement-slice-suite`; do not silently
substitute one for the other. Every benchmark arm uses a declared task-check
context. Do not force `runBenchmark(runChecksDeclared: false)`: #34 rejects an
undeclared benchmark context before it creates results.

Run each revision from an isolated checkout and retain the invocation directory
before removing the checkout. Record the exact command, model/profile/server
settings, suite path, repetition and budgets in the invocation notes. The
benchmark identity and its `configDigest` must be retained with the run.

## Availability strata

Record check declaration and effective availability independently. The
declared value comes from the approved packet and identity; the effective value
comes from `runtime.json.runChecks.available` and the actual tool surface. Keep
the unavailable reason, runner provenance and `maxCheckRuns` alongside both
values. A declared but unavailable runner runs with the existing no-check prompt
and Pi tool arguments and must be analyzed as its own stratum. An available
runner adds only the named `run_checks` tool and the check-guided contract.

Compare the contract effect only between baseline and changed revisions with
the same effective availability. Compare availability effects separately; a
different host or runner cannot be attributed to the prompt contract.

## Retained measurements

Derive the following from retained artifacts for every case and repetition.
Never fill a missing observation from a claim in assistant text; write
`UNKNOWN` when the artifact does not record it.

| Measurement | Source | Recording rule |
| --- | --- | --- |
| Success observations | case result, visible/held-out verifier records, worker `outcome`, `changedPaths`, `scopeViolations` | Record the observed statuses and counts. This is measurement evidence, not task acceptance. |
| Revision rounds | retained case/run lineage and revision records | Count only retained rounds; use `UNKNOWN` when the run did not record revision history. |
| First write | worker `result.json.observed.firstWriteAtMs` | Preserve `null` when no write was observed; do not infer it from elapsed time. |
| Check runs | `checks.jsonl` and `result.workerObservedChecks.runs` | Count the retained check observations, including explicit tool errors and budget exhaustion; record `UNKNOWN` when no artifact exists. |
| Local tokens | worker `result.json.observed.cumulativeUsage` | Retain input, output, reasoning and total tokens exactly as recorded; do not estimate hidden provider usage. |

Also retain `taskShape`, `observed.writeCalls`,
`observed.toolCallsByName`, `processTermination.elapsedMs`, preflight warnings,
the full prompt and packet digests, `runtime.json`, and the complete benchmark
config identity. `workerObservedChecks` must remain labeled
`acceptanceEvidence: false`; an observed check is feedback to the worker, not
operator verification or acceptance.

## Interpretation and limits

Report the baseline and changed arms as a small pilot. Separate model and
transport failures, setup or fixture failures, unavailable checks, stopped or
timed-out candidates, and real verifier outcomes. Do not publish synthetic
success rates, token counts or timing values. State known configuration
differences and source limitations next to the affected observation, including
test-runtime or fake-Pi runs, missing server metadata, unavailable Linux
bubblewrap checks, and unrecorded revision history.

The full Talon single-task rerun remains an operator live-run step under issue
#9. This protocol does not perform that rerun or turn the contract change into
a Talon result.
