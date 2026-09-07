# Feature workflow experiment 003

Date: 2026-09-05. Status: v1 completed; v2 amendment below prepared before v2 calls.

## Question and authority

Can strong-model preparation, three bounded task packets and planned review
enable Qwen to deliver the integrated idempotent reservation feature correctly?
The operator's involvement is part of the workflow, not a score to minimize.
This is a feasibility test, not an estimate of reduced supervision or proof of
reliability. It does not yet compare preparation models or artifact alternatives.

The user authorized making progress while away. The primary selects only this
synthetic feature and its documented benchmark decisions; no production system
or private repository is changed. Operator approval/progression is simulated
and explicitly labeled. The user has not reviewed these feature-specific choices
or accepted the result. This tests execution with supplied artifacts, not actual
human usability of the approval experience.

## Roles, artifacts and order

The primary owns feature semantics, preparation/task skills, task decomposition,
expected-value sources, review and result interpretation. Luna-max implements
the mechanical seed, reference, frozen checks and capture utility. The primary
reviews those artifacts before their execution. Qwen alone authors scored
implementation and test changes. No strong-model patch to participant code is
permitted; corrections arrive as recorded review feedback for Qwen.

Feature source: feature.md. Preparation skill: skills/tinysdd-prepare/SKILL.md.
Consumption skill: skills/tinysdd-task/SKILL.md. The preparation skill guides this
primary-authored artifact set; it is not yet independently tested for repeatable
specification generation. Neither experimental skill replaces the current
product skill or is installed globally.

Run tasks 01 validation → 02 service → 03 API in one disposable repository. Each
task starts a fresh Pi session with the same feature specification and a named
task packet; review revisions continue that task's session. Fresh task sessions
test whether the on-disk artifacts/prior code support the handoff; there is no
automatic session controller or automatic progression. The primary invokes each
task separately after inspecting its prerequisites.

The packet's separate new-test-file convention is an intentional candidate
procedure informed by prior accidental test replacement. This workflow changes
several things from experiment 002; no individual instruction benefit may be
attributed from a comparison with that historical experiment.

## Preflight and independent checks

Before participant calls, inspect the seed/reference/checks and validate:

- The seed has nine original passing tests (five inventory, four app).
- The seed fails the relevant new checks for missing behavior, not an import or
  environment error. Each stage has eight named independent tests (24 total).
- The complete reference passes all 24 plus the original nine.
- Deliberate mutants fail: double debit on replay, replaying current rather than
  original stock, and binding failed requests. Add a partial-update mutant if
  needed to confirm atomicity coverage; retain its source before model runs.

Freeze all inputs, task/feature/skill versions, reference, checks and capture
source by digest. Keep reference/checks outside the supplied participant context
and workspace. After primary source inspection, execute frozen checks in a clean
environment without provider credentials, with Node permissions and 20-second
bounds. Run original tests from frozen copies, not rewritten participant suites.
Preserving original tests and prior-task files is independently checked by diff
and hashes; passing frozen tests does not excuse deleting the live regressions.

## Runtime and budgets

Use the existing direct Qwen Pi provider/model, through unchanged LiteLLM:
randal-mi50 / randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf.
No aliases/fallbacks, as user-confirmed. Pi 0.84.4, thinking requested off,
extensions/discovered skills/templates/context files disabled; explicit task
skill supplied. Ordinary read/write/edit/bash tools remain available. Built-in
provider behavior and effective backend settings are not fully verified.

Each task has at most two model invocations, 360 seconds cumulative captured Pi
wall time, and 60 cumulative observed tool starts. A second invocation receives
only remaining budget. Each capture retains a bounded 16 MiB prefix per stream;
truncation is a reported evidence failure, not success. Token usage/ceiling are
UNKNOWN because streaming usage is unavailable. Primary inspection time is
recorded separately where possible and excluded from captured Pi wall budgets.

Backend response freshness, proxy retries, effective sampling/thinking and warm
cache conditions remain UNKNOWN. Repeats are separate captured attempts, not
qualified independent samples. Serialize calls per backend and never retry an
attempt silently.

## Planned review and revision policy

After each task, the primary inspects raw tool results, source and test diff,
artifact updates, original/prior-task preservation, and relevant independent
checks. Record task review in the run directory. Distinguish:

- substantive correctness/integration/scope problems;
- lost tests or false verification claims;
- missing red evidence, incomplete handoff or other process gaps.

One planned revision is allowed per task within its remaining budget. Feedback
may cite a violated feature clause and the observed mismatch, but must not
provide implementation patches, reference source, or hidden test code. Scope
remains the task packet. Report additional coaching as unplanned assistance.
Do not demand a retrospective red run after a correct implementation simply to
manufacture evidence of the original sequence. Record the gap as an observation.

Advance only when substantive checks/scope/preservation pass. A process-only gap
may be recorded as a conditional task acceptance without pretending compliance.
If substantive findings remain after the one revision, stop this feature attempt
and retain it as incomplete. A discovered upstream defect at a later task ends
that attempt rather than silently broadening downstream edit permission. A
specification/oracle defect is an invalid experiment requiring a separately
versioned correction; preserve its failed evidence.

All final feature checks and the nine frozen originals run after task 03. Record
both first-pass and reviewed outcomes, review revisions and unresolved findings.
The primary's same-context review is not independent model consensus; the frozen
behavioral checks provide a separate finite correctness signal.

## Repetition and decision

Start with one exploratory Qwen feature attempt. If it completes without needing
a specification or tool change, run up to two further fresh Qwen attempts using
the same frozen artifact versions and review policy. Preserve every result.
If attempts expose a recurring substantive failure, diagnose and version one
targeted change before a new series; do not keep sampling until something passes.

Only after repeated useful Qwen outcomes, time permitting, perform one labeled
Gemma transfer attempt under the same contract and policy. Nemotron's unresolved
tool-qualification issue is separate; do not substitute it or expand into proxy
changes during this feature experiment.

Primary outcomes: agreed behavior, atomic/idempotent integration, preservation,
and substantive review findings resolved within the recorded policy. Report
process compliance, operator decision points, cost/time/tools and artifact gaps
separately. Do not claim a skill advantage without a matched comparison, reliable
product delivery from one feature, or validation of real operator usability from
simulated approvals. Decide which artifacts are usable candidates and what the
next discriminating test should be; no result requires a new product harness.

## V2 amendment: concrete caller-ownership acceptance witness

Prepared after two retained v1 Qwen attempts on 2026-09-05. Both initial service
submissions retained caller-owned lines despite the explicit defensive-copy
requirement. Both were corrected through the planned review path. Stop the
unchanged v1 series; its recorded successes and qualifications are not relabeled.

The only participant-visible artifact change is one acceptance witness added
to task 02: reserve r1 with [pen:2] from {pen:5}, mutate the caller's line, require
conflict for the changed request and original-snapshot replay for a fresh
original request, then repeat for caller-array mutation. It distinguishes
non-mutation by reserve from isolation against later caller mutation. It does
not give implementation code or change the feature's existing behavior.

Feature, shared types, tasks 01/03, both skills, fixture, reference, independent
checks, capture utility, runtime settings and per-task review/budget policy stay
unchanged. This protocol amendment is experiment metadata, not supplied model
context. Snapshot the new task and protocol hashes; retain all older sources.

Run one fresh Qwen feature attempt. Score initial service ownership behavior
and whether its own tests exercise the witness, alongside final reviewed feature
quality. If useful and time permits, run one labeled Gemma full-feature transfer
with the same v2 artifacts and policy. Stop on unresolved substantive findings
or recurring v2 ownership failure; do not add further silent repetitions or
expand into Nemotron/proxy configuration work.

This is an outcome-informed exploratory candidate, not randomized causal
evidence or a reliability estimate. V1 and v2 results must be shown separately.
