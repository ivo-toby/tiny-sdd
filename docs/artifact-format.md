# TinySDD artifact format v1 — proposal for Ivo

Status: proposed, awaiting Ivo's review for issue #20.
Base inspected: main `66a4f47762afe1f067ad73aa21c98a37548353b5`.

A change groups the proposal, design, spec deltas and slice DAG. Each slice uses
the existing task brief, context manifest and checks manifest. The format adds
portable preparation artifacts; existing task approval, apply, review and
feature acceptance retain their current meanings.

## Layout

```text
specs/<area>.md
changes/<change-id>/
  change.json
  proposal.md
  design.md
  deltas/<area>.json
  slices/<slice-id>/
    slice.json
    brief.md
    context.json
    checks.json
```

All JSON path fields are project-relative, including references from nested
files. This matches current task registration and citation paths. They cannot
traverse, enter .git/.tinysdd, or use symlinks. Runtime records remain in
.tinysdd; the source format never stores an approval flag that grants authority.

## Change and delta schemas

`change.json` has exact keys `schemaVersion: 1`, `id`, `proposal`,
`design`, `specDeltas` and `slices`. The last two are ordered path arrays;
proposal/design name ordinary Markdown files. IDs use the current lowercase
task/feature slug convention. Slice IDs are globally unique task IDs such as
`broker-s1`; change ID maps to the optional existing feature label.

A delta has exact keys `schemaVersion: 1`, `spec`, `baseSha256`,
`changes`. A change entry has `operation` (add/modify/remove), stable
requirement `id`, and `text` (required for add/modify, absent for remove).
A new spec has a null base; an existing spec has the digest of the observed
base bytes. IDs cannot conflict inside a delta. Validation checks structure,
paths and declared base identity. Applying deltas and archiving are #30.

The proposal records requested behavior and unresolved change-level questions.
The design records interfaces and the chosen slicing. These documents may
remain drafts while individual slices are prepared.

## Slice schema and checks

`slice.json` has exact keys `schemaVersion: 1`, `id`, `brief`,
`context`, `checks`, `allow`, `protect`, `acceptanceTests`, `dependsOn`, `budget`,
`openDecisions`. Optional extensions require a future schema version.

- `allow`: one or two exact paths written by this implementation slice.
- `protect`: distinct ordinary paths read but never changed; includes the
  strong-side acceptance tests and shared interfaces where applicable.
- `acceptanceTests`: one or more ordinary test files prepared on the strong
  side, all included in protect. Every declared test path must appear as a
  literal operand in the single check's argv. Authorship and test adequacy
  remain review responsibilities; a path declaration proves neither.
- `dependsOn`: known unique slice IDs; no self edge or cycle.
- `openDecisions`: explicitly empty for a ready slice. A nonempty list means
  preparation must continue; exporting it for implementation refuses.
- `budget`: positive `maxCompiledContextBytes` at most the existing 96 KiB
  compiler cap. Existing task sizing/behavior-split warnings remain advisory.
- `context.json`: unchanged schema accepted by `parseContextManifest()`.
- `checks.json`: unchanged schema accepted by `parseChecksManifest()`,
  with one named argv check for this packet, explicitly naming the protected
  acceptance-test files. It is never a shell string.

Every touched existing interface must have exact cited excerpts selected by the
strong side. New files cite the interfaces they consume. The validator checks
citations, bounds, budgets and declared file coverage; it cannot prove that a
human wrote sufficient tests or that no semantic ambiguity remains in prose.
The brief uses current acceptance-table and stop-condition conventions.

## Validation and task mapping

Add strict dependency-free validators in `src/change-format.mjs`, a pure
registration-plan builder and an offline `scripts/validate-change.mjs`.
Validation reads ordinary files through the existing project-path checks and
reuses `compileContext()` and `parseChecksManifest()`. It returns the DAG,
compiled digests, sizing and explicit registration arguments in topological
order, so each dependency exists before its dependent is registered. It performs no
checks, task updates, approval, dispatch, apply or acceptance.

The registration plan maps each slice to today's `addTask()` arguments:
id, feature, brief, context, checks, allow, protect and dependsOn. Existing
`task add` commands can consume this plan. Registering or changing a task
continues through existing APIs; importing a document never restores or grants
an approval. Accepted dependency requirements and stale-input detection remain
exactly as they work today.

No format metadata is added to controller approval bindings. Documents matter
to an approval when its brief/context/checks already binds those bytes or cited
lines. Merely changing uncited proposal/design prose cannot silently broaden
an implementation packet.

## Portable approved slice bundle

Add `scripts/export-slice.mjs` and a narrowly scoped exporter module.
Export requests the current change/slice descriptor and its existing registered
task. It first validates the descriptor, readiness declarations and budget,
then calls `resolveTaskPacket()` and compares the mapped brief/context/checks
paths, allowed/protected paths and dependency IDs with the resolved task shape.
Only a matching, currently ready, freshly approved task exports. Slice-format
constraints cannot be bypassed by supplying an unrelated existing task ID.
The retained manifest includes the descriptor digest, readiness declarations,
budget and acceptance-test references as preparation metadata, outside current
approval bindings. Legacy approvals remain compatible using the worker's
existing comparison: `context.compiledSha256` must equal `compiled.sha256` or
`compiled.legacySha256`. The bundle retains the current `compiled.rendered`
bytes, their own SHA256 and which digest matched. A legacy approval still binds
whole source files; its legacy comparison digest is not mislabeled as the hash
of the current rendered bytes.

An explicitly requested new output directory contains the existing
`packet.json`, exact brief, compiled-context Markdown, checks manifest and a
versioned bundle manifest with file SHA256/byte counts. It retains the current
approval record and dependency acceptance digests as recorded evidence.
Protected project files remain references into the target checkout rather than
invented writable copies.

A Claude Code or interactive Pi consumer can read the packet and compiled
context without the TinySDD CLI. It still works in a disposable copy, observes
allowed/protected paths, and returns evidence for the normal controller review.
The bundle does not approve a foreign controller, apply a patch or accept a
result. End-to-end harness adapters are #31.

Output is bounded, all source inputs are validated before writes, and an
existing output directory refuses rather than overwriting. The manifest binds
retained bytes; no credentials, global runtime configuration or hidden verifier
resources are exported.

## Reference and verification

Express the broker re-cut as S1 (errors/lease), S2 (path validation), S3
(in-memory backend), S4 (allowlist), S5a (sequential lifecycle core), and S5b
(async lifecycle edge). Shared types and strong-side test files are protected.
S5b depends on S5a; other edges must come from the actual approved broker task
records, not from a guessed dependency graph.

If the original broker packets are unavailable, label the example as a
reconstruction from the documented re-cut, with missing original approval/run
evidence explicit. Do not fabricate historical approvals or test observations.
A self-contained synthetic broker fixture may demonstrate validation/export;
it is not a new Talon measurement.

Tests cover unknown keys/version, unsafe/duplicate paths, DAG cycles/missing
dependencies, allow/protect/input overlap, missing/out-of-bounds citations,
one-check shape, budgets, declared open questions, stale/missing approval at
export, bundle byte digests, output collision and old task compatibility.
Every added behavior needs a meaningful reversal failure and exact restoration.
The normal, symlink-TMPDIR and emulated-Darwin suites must pass before merge.

## Deferred policy

#28 defines phase gates, #30 defines archive/spec-merge behavior, #38 defines
engagement levels, and #39 defines plan-level approval. This issue neither
chooses their decision authority nor makes a whole change approved merely
because one slice is approved.
