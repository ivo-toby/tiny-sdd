# Benchmark schema contract

Phase 1 of issue #7 defines dependency-free, offline-validatable benchmark
artifacts. The schemas are implemented by `src/benchmark-schema.mjs` and
`src/benchmark-results.mjs`; this document records the contract that later
runner and CLI work must preserve.

## Identity and digest rules

Suite, challenge, config-identity, case-result, summary, and invocation
artifacts carry schema version `1`. Config identity is canonicalized before it
is hashed. Canonical JSON sorts object keys recursively, preserves array order,
and is hashed as UTF-8 SHA-256 using the existing `digestJson` helper.

`UNKNOWN` means that a value was not observed or supplied. A known disabled
setting uses its schema value: for example, `worker.limits.firstWriteMs: null`
is distinct from `UNKNOWN`. Config identity records a reason for every
`UNKNOWN` field in `missing` and rejects fields outside the identity contract.

The identity includes model and server information, worker profile and limits,
Pi and TinySDD revisions, suite and verifier digests, check-runner availability
and budget, and runtime environment. Config input is strict: unknown keys are
rejected instead of being dropped. Metadata cannot contain credentials,
credential-shaped server URLs, cycles, or prototype keys.

## Suite and challenge

A suite names an ordered set of content references under `challenges/` and may
set a repeat count. A challenge names one fixture, packet, and verifier
definition. Roles are `implement-slice`, `research`, `write-tests`,
`stop-and-ask`, and `judge`; Phase 1 records all of them, while the later runner
may execute only `implement-slice`.

Packet paths are project-relative and cannot enter `.git/` or `.tinysdd/`.
`allowedPaths` and `protectedPaths` must not overlap. An `implement-slice`
packet must allow at least one path.

## Results and provenance

A case result binds its suite id, suite version, and suite content digest to
config identity. Packet, profile, provenance, invocation-worker, and result
artifact digests must agree with the same identity and execution condition.
Results contain observations and verifier records only; acceptance,
qualification, and scoring policy do not belong to these schemas.

Verifier statuses are `passed`, `failed`, `unavailable`, and `not_run`.
`passed` requires successful process evidence and a known sandbox, duration,
and output. `failed` requires a non-zero exit, signal, or timeout.
`unavailable` cannot contain green execution evidence. `not_run` requires
unknown execution and output evidence. Path changes use only `created`,
`modified`, `deleted`, or `type_changed`.

Summaries require category counts to add to `scheduled` and exactly one unique
case-result reference per scheduled attempt. Invocation case-result references
are also unique. These validators do not execute checks, inspect live models,
start services, or apply worker output to a source project.

## Runner contract

Phase 2 and phase 3 provide the measurement runner behind
`tinysdd bench run --worker NAME [--suite PATH] [--repeat K]`. The default suite
path is the project-relative `bench` directory; `--suite` may name that
directory or its `suite.json`. The CLI resolves the named worker and its
profile through the effective project configuration, then calls the normal
`runWorker()` path for each challenge and repetition. Only `implement-slice`
roles have a runner adapter in v1; the schema continues to record the other
approved role tags for later issues.

The runner copies every worker attempt into the benchmark result directory
before removing its disposable fixture. It stores the worker result, prompt,
stdout/stderr, before/after workspace snapshots, candidate files and snapshots,
runtime metadata, patch, packet, and verifier output references with digests.
It then evaluates a retained candidate in a separate evaluator directory.
Visible and held-out verifier resources are overlaid only under the reserved
verifier root after collision, symlink, and dependency-overlap checks. Held-out
resources are loaded and hashed on the host; they are never part of the worker
packet, prompt, fixture, candidate evidence, or a later revision input.

The config identity binds the effective worker/provider/model and runtime
settings, profile and TinySDD revisions, suite and verifier bytes, checker
availability and limits, and environment identifiers. A changed suite,
verifier, dependency tree, model setting, checker limit, or TinySDD revision
therefore produces a different digest. A mutation detected between attempts
leaves the attempt inspectable as `setup_error` and skips verifier execution.

On macOS or when the Linux check runner is unavailable, verifier records retain
`unavailable` observations and the CLI warns on stderr. Unavailable checks are
never reported as passed. The runner has no repair, scoring, qualification,
approval, acceptance, apply, or source-project mutation path.
