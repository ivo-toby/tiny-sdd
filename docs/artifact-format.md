# TinySDD artifact format v1 — proposal for Ivo

Status: revised #20 design approved by Ivo on 2026-10-05; implementation follows
independent review. This document alone does not complete #20.
Base inspected: main `36a6080ba8afc65b3719f050bec3284e6369d938`.
This revision follows the 2026-10-05 operator updates to #20, #28, #37 and #81
and supersedes this draft's earlier fixed two-file/all-strong-side-tests design.
Ivo's later sandbox-file-freedom decision (#82) also supersedes hard planned-file
ceilings: expected output lists and file-count budgets are advisory. The current
worker/apply runtime uses the single default `ordinary-create-modify` scope;
deletions and protected, preparation, internal, secret, dependency or filesystem
type changes remain ineligible.

A change groups requirements, design, spec deltas, feature checks and a slice
DAG. Strong preparation writes protected feature acceptance/integration tests;
small workers write implementation and their own writable slice tests. The
format describes this work and produces portable packets. It grants no task
approval, test-adequacy verdict, verification or feature acceptance.

## Work delivered by #20

Implement versioned schemas and dependency-free validators, an offline
registration-plan script, a fresh-approved-task bundle exporter, documentation
and a broker reference example. Reuse current controller/context/checks APIs;
no new controller/CLI gate or live provider loop is included. Code locations
proposed: `src/change-format.mjs`, `src/slice-bundle.mjs`,
`scripts/validate-change.mjs`, `scripts/export-slice.mjs`, focused tests and
`examples/artifact-format/`. Update quickstart and CLI workflow when implemented.

#28 implements phase transitions; #81 implements active Jev assessment, bounded
revision, independent strong review and durable observations. #20 supplies
identifiable descriptors, criteria and retained bundle bytes for those issues.
It does not claim that the current controller already enforces their new
feature-check or review requirements.

## Layout and path rules

```text
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
```

Test and application files live at their normal project paths, referenced by
the descriptors rather than copied into a new test tree. All JSON source-path
fields are project-relative, including references in nested files. Ordinary
paths cannot traverse, enter `.git`/`.tinysdd`, or use symlinks. Existing source
inputs must be regular files; only declared future outputs may be absent.
Runtime evidence lives in the controller's internal storage under its existing
path checks, separately from ordinary preparation paths. No source document
contains an approval flag that grants authority.

## Change and delta schemas

`change.json` has these exact required keys:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `id` | Existing lowercase task/feature slug convention; maps to feature label |
| `proposal`, `design` | Paths to the two Markdown documents |
| `specDeltas`, `slices` | Nonempty ordered arrays of unique descriptor paths |
| `budget` | Explicit change-wide sizing values, described below |
| `featureTests` | Nonempty unique paths to existing strong-prepared tests |
| `featureChecks` | Path to an existing checks manifest |
| `integration` | Nonempty array of named feature integration obligations |

The proposal records requested behavior and unresolved change-level questions.
The design records interfaces, real callers, test responsibilities and slicing.
A document can be a draft; registration planning is not approval. A ready slice
has no unresolved questions in its declared scope.

Each `integration` entry has exact keys `id`, `requirementIds`, `entrypoints`,
`wiringSlice`, `testPaths`, `checkIds`. IDs are unique slugs; requirement IDs
refer to requirements in the change's deltas. Entrypoints are nonempty paths to
existing real caller files, not newly invented wrappers. `wiringSlice` names a
slice in this DAG. Test paths are a nonempty subset of `featureTests`; check IDs
are a nonempty subset of parsed feature check IDs. Every feature test is
covered by at least one obligation. Every entrypoint appears in its wiring
slice's cited interfaces; the responsible slice declares the entrypoint among
its implementation outputs when it must edit that caller.

The validator can verify files, references, declarations and citations. An
independent design/code review must verify that the tests actually enter through
those callers, that requirements are covered and that disconnected new code
fails. Listing an entrypoint or naming a wiring slice is not proof of integration.

A delta has exact keys `schemaVersion: 1`, `spec`, `baseSha256`, `changes`.
Each entry has `operation` (add/modify/remove), stable requirement `id`, and
`text` (required for add/modify, absent for remove). A new spec has a null base;
an existing spec has the digest of observed base bytes. Requirement IDs must
be unique across this change's delta entries, so criteria can reference them
unambiguously. Validation checks structure, paths and base identity. Applying
spec deltas and archiving belong to #30.

## Slice schema, writable tests and sizing

`slice.json` has exact required keys `schemaVersion: 1`, `id`, `brief`,
`context`, `checks`, `implementationFiles`, `sliceTests`, `protect`,
`interfaces`, `dependsOn`, `budget`, `openDecisions`, `testReview`.
Slice IDs are globally unique task IDs such as `broker-s1`.

- `implementationFiles`: nonempty expected create/modify paths, including caller
  wiring where assigned. Counted separately for advisory implementation sizing;
  these are not the complete set of eligible runtime changes under #82.
- `sliceTests`: nonempty expected writable test output paths the small worker
  authors or improves. Direct imports into the slice are appropriate here.
  Count separately for advisory test sizing; additional eligible tests need no
  deviation-specific permission under #82. They are never independent acceptance
  evidence. Exact actual candidate test bytes must reach ordinary #81 review.
- `protect`: ordinary existing paths the worker must not edit. It includes all
  change-level `featureTests`, plus shared contracts where applicable. Existing
  regression tests stay protected unless explicitly assigned as writable slice
  tests; their existing expectations must be preserved and independently reviewed.
- `interfaces`: nonempty unique existing interface/caller paths, each covered
  by an exact cited excerpt in this slice's context manifest. New outputs cite
  the interfaces they consume. Review verifies coverage of every touched interface.
- `dependsOn`: known unique slice IDs; no self edge or cycle.
- `openDecisions`: explicitly empty for export readiness; otherwise export
  refuses. Prose and adequacy still need review.
- `context`: unchanged schema accepted by `parseContextManifest()` in
  `src/context-compiler.mjs`; existing facts, source-size and resource caps apply.
- `checks`: unchanged `parseChecksManifest()` schema with exactly one named
  argv check. That check explicitly names every expected `sliceTests` path as a literal
  argv operand. Commands are never shell strings. Feature checks are separate.

Expected implementation/test lists are disjoint within a slice, with no
duplicates. Their union maps to the task's expected `allow` list for packet
context and advisory sizing; it does not limit the default runtime's ordinary
create/modify candidates. Neither
list may overlap `protect`, feature
tests or preparation inputs (including change/delta/descriptors/brief/context/
checks). No worker may rewrite its specification or independent tests. Existing
path, dependency-mount overlap, sandbox and task input safeguards remain.
Reject any expected output overlapping another slice's protected contracts or
preparation inputs too; protected feature tests are never ordinary writable
outputs. Report planned cross-slice ordinary-file ownership overlaps as freshness
warnings, not a separate deviation gate. A later slice modifying an accepted
predecessor's output can stale its existing acceptance digest and block a
dependent under today's controller. Preparation should re-cut/coalesce that
work; the format cannot waive freshness or make a dependency edge an exception.
#82 must preserve applicable integrity checks while implementing eligible extra
create/modify changes. Actual changed-file inventory and candidate bytes stay
visible to normal review; neither omitted planning nor an extra file alone is
permission to bypass protection, freshness or operator acceptance. No deletion
or unrestricted command authorization is implied.
Classification as a slice-test output is declarative; review must catch attempts
to hide implementation files there. A filename convention proves no authorship.

Change `budget` has exact positive safe-integer keys `maxImplementationFiles`,
`maxSliceTestFiles`, `maxCompiledContextBytes`. Slice `budget` has those same
keys, each either null (inherit the explicit change value) or a positive safe
integer override. The resolved budget is retained in validation and bundles.
Counts above implementation/test budgets produce explicit sizing warnings, not
readiness/export refusals. The compiled-context budget remains an input-size
constraint; it cannot exceed the existing 96 KiB compiler cap. There is no
universal implementation-file ceiling of two and no hidden budget fallback.
An initial example may explicitly choose two implementation files and one slice
test file; that is a visible example configuration, not an approved policy
forced on all work. File counts, context bytes and existing behavior-split/test
complexity warnings are reported separately. Existing controller sizing warnings
remain unchanged and may still count the total expected path list.

## Protected feature checks and acceptance boundary

`feature-checks.json` uses the existing checks schema, allowing its existing
1–16 check limit. Every feature test appears as a literal argv operand in at
least one referenced feature check. It exercises existing application entrypoints,
including wiring from callers into the new feature. A slice's own single check
can stay focused on its writable tests; this never substitutes for the feature
checks or existing regression coverage.

The intended completed workflow requires fresh whole-feature integration and
acceptance evidence plus slice checks and reviews before the operator accepts
the feature. #28/#81 implement that additional gate and coordinate #8 eligibility.
#20 only validates and exports the declared obligations. It does not make
`acceptFeature()` enforce them, auto-accept anything, or change existing
apply-before-accept, task-review freshness or explicit feature snapshot behavior.
Until the dependent gates exist, docs must make this enforcement gap explicit.

## Test-review preparation contract for #81

`testReview` has exact keys `schemaVersion: 1`, `workflow: "slice-tests"`,
`criteria`. Criteria is a nonempty array with exact entry keys `id`,
`requirementIds`, `question`, `interfaces`, `testPaths`. IDs are unique slugs;
requirements reference this change's deltas; question is explicit nonempty
assessment text; interface and test paths are nonempty subsets of this slice's
`interfaces` and expected `sliceTests`. Every expected slice test is covered. These are
preparation criteria for assessing adequacy/correctness, not predetermined
passing answers or permission to approve. Check operands and criterion path
coverage validate the expected preparation list only. They are not an exclusive
runtime test-path set. Under #82/#81, every actual eligible candidate test and
code change is retained and assessed against the same approved requirements and
criteria; additional file paths alone require no descriptor/brief reapproval or
special deviation review. The future runner links actual file inventory to the
approved questions without treating an unpredicted test as exempt from review.
New requirements or changed assessment questions still follow normal approval
freshness; an extra ordinary output is not itself such a change.

For export readiness, the existing brief must contain one
`## Slice test review contract` section with a JSON code block exactly matching
this `testReview` object, and one `## Approved slice requirements` section with
a JSON array of the referenced requirement entries. Each requirement records
`spec`, `baseSha256`, `operation`, `id`, and `text` for add/modify (absent for
remove), matching the referenced delta exactly. All criterion requirement IDs
must be covered, without duplicate entries. Parse these bounded blocks as strict
JSON, not prose heuristics. Structural validation can report a draft mismatch;
export refuses it. Existing approval already binds the exact brief bytes, so
this adds no controller binding. Preparing or changing authoritative review
questions/requirements requires the usual brief update and fresh task approval.
#81 consumes these retained approved brief sections and approved compiled
interface excerpts. Auxiliary descriptors cannot redefine its assessment.
Editing only a descriptor after approval may change preparation provenance but
cannot replace authoritative criterion text: it either still matches or export
refuses. No format metadata is itself an approval.

The future #81 runner assesses exact candidate code/test bytes against the
approved requirements and context. Negative Jev results return actionable
feedback for bounded small-model test revision. Every positive requires an
independent strong-model review of the same bytes. Exhaustion escalates. An
unavailable, uncertain, stale or exhausted result cannot silently approve.
Exact threshold, revision limit and uncertainty/unavailability routing remain
operator decisions; #20 neither chooses defaults nor executes this loop.

Bundles provide a versioned identity object for linking later observations:
change ID, slice/task ID, descriptor-set SHA256, test-review-contract SHA256,
current approval digest, the retained authoritative brief sections and file digests. The descriptor-set digest
covers the change descriptor, all referenced deltas and slice descriptors,
proposal/design, and feature-check manifest by exact bytes. Brief/context/checks
have separately retained digests. Spec base identities and compiled excerpt
identities remain explicit. The identity is preparation provenance outside
controller approval bindings; uncited design edits cannot grant broader authority.

#81 owns durable run/lineage/revision IDs, exact assessed candidate artifacts,
questions, provider/config identity, probabilities/verdicts, thresholds, routes,
check/review evidence, timestamps, latency and measured token accounting. Link
its future records to the bundle identity rather than inventing finished runtime
records in #20. Retain every assessed revision, including negatives; absent
measurements are UNKNOWN. Hashes without retained auditable artifacts are
insufficient. Positive-only independent review cannot establish false rejection
rates or population calibration. Existing #40 replay/#41 exporter are foundations,
not live assessment or training evidence.

## Validation and existing task registration

Strict dependency-free validators read ordinary files using existing project
path checks and reuse `compileContext()` and `parseChecksManifest()`. Reject
unknown keys/version, unsafe/duplicate paths, invalid cross-references, stale
spec bases, cycles, expected-output/protection/input overlap, missing citations
or exceeded compiled-context/resource bounds. Ordinary cross-slice expected
ownership overlaps and exceeded file-count budgets are reported warnings.
Structural validation can report open decisions; requesting an export-ready
descriptor refuses them. For the proposed implementation, use a 512 KiB
ordinary-file read ceiling (matching the context compiler's source-resource
ceiling) for descriptor/brief/check inputs and retained writable baselines.
Bound the descriptor graph to 64 slices, 64 deltas and 256 integration/criterion
entries each, and total retained output to 32 MiB; refuse before writes on excess.
These are explicit proposed v1 format resource limits, separate from configurable
implementation/test sizing. Report the exceeded limit; never silently truncate.

A pure registration-plan builder returns topological `addTask()` arguments:
`id`, `feature`, `brief`, `context`, `checks`, `allow` (implementation/test union),
`protect`, complete `preparation` identity and `dependsOn`, plus separate format
metrics. Return the explicit default metadata
`runtimeScope: { mode: "ordinary-create-modify", ordinaryCreateModify: true,
deletions: false }` beside the plan, not inside controller approval fields.
Preparation entries include truthful presence and byte identity; absent entries
are carried as absence evidence and are not blindly added to `protect`.
The offline validation script prints the plan; it does not register, update,
approve, run checks, dispatch, apply or accept. Existing `task add`/`update`
remain the mutation APIs. Dependencies must be registered first, and existing
accepted-dependency/freshness requirements remain intact. No controller state,
approval or packet schema changes are proposed for this format mapping.

The plan's `brief`, `context` and `checks` values are the fixed controller paths;
they are not writable copies created by validation. Before calling `task add`,
copy the exact bytes from the corresponding slice descriptor paths to those
planned paths, then pass the planned paths to `task add` and approve the task.
For example, a slice descriptor that names `changes/example/slices/s1/brief.md`,
`context.json` and `checks.json` is materialized as `.tinysdd/tasks/s1.md`,
`.tinysdd/tasks/s1.context.json` and `.tinysdd/tasks/s1.checks.json`. This
explicit copy keeps the packet inputs byte-identical while leaving validation
read-only. Carry every `allow`, `protect`, `preparation` and `dependsOn` value
from the plan to `task add` (using `--depends-on` for dependencies) so the
registered shape and immutable preparation evidence remain exact.

## Portable freshly approved slice bundle

The exporter validates the current descriptor set, readiness and resolved budget,
reads bounded controller state for the selected dependency closure, and then calls
`resolveTaskPacket()` for the existing registered task. Compare mapped
brief/context/checks, allow/protect/preparation and dependency IDs with the returned shape;
compare feature membership with that bounded state. Export only a matching,
currently ready, freshly approved task under its actual current runtime policy.
An unrelated task ID cannot bypass format readiness. Retain descriptor identity,
advisory test roles/file budgets, actual runtimeScope metadata and
compiled-context limit as preparation metadata, without extending existing
approval bindings. The bundle retains the complete preparation identity and
current checkout references; ordinary actual candidates remain visible to
normal review and apply.

Legacy context approvals remain compatible. First check packet
`context.compiledSha256` against current `compiled.sha256`, as the resolved
packet describes the current compiled output even for a legacy approval.
Separately compare `packet.approval.contextDigest` with `compiled.sha256` or
`compiled.legacySha256` to identify the actual approval binding; missing or
nonmatching approval digests refuse. Retain current `compiled.rendered` bytes,
their own SHA256, the actual recorded approval context digest and the comparison
that matched. Never infer modern approval binding from the current packet's
compiled digest, or label a legacy comparison digest as the current rendered hash.

An explicitly requested new output directory holds `packet.json`, exact brief,
compiled-context Markdown, exact slice checks, versioned bundle manifest and
bounded preparation descriptors/documents/feature-check manifest needed to
audit the recorded identity. Retained bytes have SHA256 and byte counts. Include
current approval and dependency acceptance digests as recorded evidence. Existing
protected source/test files remain digest-bound references into the target
checkout, not invented writable copies. The manifest also records an export-time
checkout-reference snapshot for every implementation output, writable slice test,
protected file and compiled-context source path: regular-file existence/absence,
SHA256 and byte count, using `snapshotProjectFiles()` semantics. Missing markers
are permitted only for declared future writable outputs. These are observed
baseline identities, not new approval bindings. A foreign consumer verifies them,
including absence markers, before work; changed uncited writable-file bytes must
not pass unnoticed. Retain bounded baseline bytes for existing writable outputs
in the bundle so later assessed revisions can be audited. Candidate bytes and
per-revision evidence still belong to #81/run records.

A non-TinySDD harness can read these artifacts without the CLI, work in a
disposable checkout with the exact inputs/protected-file identities and declared
actual runtime policy, and return
code, tests and evidence for controller review. Consumer instructions require
checking referenced bytes before work; the bundle is not a self-contained copy
of the project. #31 supplies end-to-end harness adapters. A bundle never approves
a foreign controller, applies a patch or accepts results.

Validate all source inputs and output-path collisions before writing. Use a new
output directory and exclusive file creation; never overwrite or write inside
source/input/protected paths, including aliases. No credentials, global runtime
configuration or hidden verifier resources are exported. Validation/export runs
no project commands and starts no service or inference.

## Reference example and implementation verification

Express the documented broker re-cut as S1 (errors/lease), S2 (path validation),
S3 (in-memory backend), S4 (allowlist), S5a (sequential lifecycle core), S5b
(async lifecycle edge). Show writable worker slice-test paths separately from
protected strong-prepared feature tests, explicit budgets, exact interface
excerpts and a named real-entrypoint wiring obligation. Add a wiring slice if
the historical re-cut lacks one, clearly labeling it as proposed new work rather
than claiming it existed. S5b depends on S5a; other historical edges require
actual records rather than a guessed graph. If historical slices share writable
files, registration can still succeed, but explain that later edits can stale
accepted predecessors and block dependencies under current accepted-output
freshness. Emit a planning warning rather than a registration refusal. The
runnable synthetic example uses distinct ownership and clearly labels its re-cut
differences. Do not quietly alter historical evidence.

Missing original broker packets, source excerpts, approvals or run evidence
are marked UNKNOWN. A reconstruction is labeled as such. A self-contained
synthetic fixture can demonstrate validation/export, test-role separation and
that disconnected code fails its actual-entrypoint feature test. That is offline
fixture verification, not a historical Talon rerun, human adequacy approval,
live Jev measurement or observed non-TinySDD harness run.

Implementation tests cover exact schemas/paths/DAG/cross-references, configurable
advisory implementation/test counts versus hard context bounds, current-runtime
policy labeling with no legacy reinterpretation, cited interface coverage,
protected feature tests, writable-test check operands, feature wiring/check references and open
questions; approved-brief/descriptor requirement and review-contract mismatches,
stale/missing approvals, descriptor/task mismatch, legacy approvals,
retained-byte and checkout-baseline digests/absence markers, output collisions
and old task compatibility. Each new behavior needs a meaningful reversal failure and exact source restoration.
Run the normal, symlink-TMPDIR and emulated-Darwin suites, report actual counts,
and exercise offline scripts/bundle reads. No lint/build exists in this repo.
Live providers, Pi, training and foreign-harness execution remain unverified
unless separately authorized and actually observed.

## Decisions and dependencies still open

Ivo approved this revised #20 design after the complete workflow review;
implementation is authorized, subject to the existing independent PR review gates.
The example budgets are proposed explicit values, not universal limits.
#81 threshold, revision cap and uncertain/unavailable routing remain undecided;
they do not block #20's passive descriptors or authorize an active loop.
#82 supplies the current default ordinary create/modify runtime and complete
actual-candidate evidence. There is no task opt-in, legacy transition or special
deviation gate; normal review, approval freshness and operator acceptance remain
the authority for applying and accepting a candidate.
#28 owns phase gates and enforcing the revised feature-check prerequisite;
#30 spec merge/archive, #38 engagement levels, #39 plan-level approval. None is
silently implemented here. Live #40/provider work and #32/#8 evidence contracts
must be coordinated for #81; current offline foundations do not complete them.
