# TinySDD CLI pilot — 2026-09-06

Status: bounded live panel complete; CLI available for controlled hands-on
testing. This is not a production-readiness or general model-reliability claim.

## What exists

One dependency-free Node CLI now supports both controller use inside an agent
and a named Pi worker. Project configuration, explicit task approval, dependency
staleness, revision feedback, scoped candidate capture, portable patches, and
human/JSON output are implemented. Workers do not execute tests, apply patches,
or accept their work. See the [quickstart](quickstart.md).

The product skill and worker prompt were refined around observed failures:
exact contracts, real boundary fixtures, effective cleanup, targeted revisions,
and a clear distinction between model claims and observed verification. These
are design improvements, not experimentally established causal quality gains.

The [independent skill/controller walkthrough](../experiments/runs/cli-walkthrough-unique/report.md)
exercised prepare, approve, implement, verify, accept and reopen for revision.
Its approvals were explicitly simulated; it did not invoke a participant model.

The deterministic suite passed 32/32 tests before live dispatch. Skill format
validation passed, and 33 relative documentation/skill links had no missing
targets. The package dry-run included only the 14 intended product files, not
raw experimental captures. Packaging was not publishing or global installation.
Final tests again passed 32/32; the updated skill validated, and the final
documentation audit checked 45 relative links with no missing targets.

## Fixed engineering probe

The [protocol](../experiments/005-titan-cli-pilot/protocol.md) specifies a small
atomic version-checked batch operation, two allowed files, three serial Titan
participants, and bounded revision eligibility. Models receive the same starting
code and task, with Qwen's recorded endpoint-specific non-thinking profile.
Independent checks are withheld from the worker and executed without credentials
or external network. Product source, task, prompts, checks and runner are retained
as actual frozen copies, not just hashes.

[Oracle validation](../experiments/runs/005-titan-cli-pilot/validation-report.md)
observed two baseline tests pass and eight new checks fail for missing behavior.
The reference passed all ten. Three defective references each failed their
intended check, covering aliasing, the 17-entry boundary and partial mutation.

## Retained development failures

The [first Qwen dispatch](../experiments/runs/005-titan-cli-pilot/qwen-l1M8Pq/primary-review.md)
failed with `Invalid URL`, zero reported tokens, zero tools and no changes.
This is a runner/configuration failure, not a coding score. Its frozen sources
and raw evidence are retained; the protocol permits one runner-repair rerun on
the original fixture after fixing and testing the handoff.

Diagnosis: installed Pi resolves API-key/header environment references but
passes `baseUrl` through literally. The adapter now supplies the resolved URL
and retains child-only credential references. All 32 tests passed again. The
primary ran `node experiments/005-titan-cli-pilot/mock-pi-smoke.mjs`: actual Pi
through production bubblewrap completed against a local synthetic SSE server;
endpoint path, API authorization, provider header and model header all matched.
No real inference service or global Pi configuration was used by that check.
The mock's disposable synthetic workspace was cleaned after execution.

The separate [podcast checkpoint](podcast-focused-repair-results-2026-09-05.md)
remains blocked after its final allowed repair: a factory test contains bare
prose and cannot parse. Task01 is accepted, task02 is not, tasks03/04 are unrun.
No original-project application or stronger-model code rescue was performed.

## Live observations

Provider `titan`, exact configured identifiers:

- Qwen: `titan/llamacpp/qwen3.6-35b-a3b-256k` (Q3 as reported by the operator).
- Gemma: `titan/llamacpp/gemma4-26b-a4b-256k`.
- North: `titan/llamacpp/north-mini-code-384k`.

Configured names are not independently verified weight provenance. The frozen
Pi configuration declares 262144 context tokens for these participants; North's
name alone does not establish a 384K configured context. Qwen uses the recorded
profile to disable thinking; the other two use Pi thinking off without an
additional model profile. Gemma and North received byte-identical rendered
prompts; Qwen's prompt adds its profile guidance.

| Initial coding attempt | CLI wall time / tool starts | Independent + original checks | Participant tests / review |
| --- | --- | --- | --- |
| [Qwen](../experiments/runs/005-titan-cli-pilot/qwen-lsRr6t/manifest.json) | 56.387s / 7 | 8 + 2 pass | Four failed assertions; missing required case; revision |
| [Gemma](../experiments/runs/005-titan-cli-pilot/gemma-7UIBH0/manifest.json) | 146.326s / 3 | 8 + 2 pass | One contradictory mutation assertion; revision |
| [North](../experiments/runs/005-titan-cli-pilot/north-I81JmV/primary-review.md) | 110.962s / 10 | 8 + 2 pass | Test module cannot load; two prohibited files; blocked |

Qwen's row is its permitted runner-repair rerun, not an undisclosed second coding
attempt. Its [feedback](../experiments/runs/005-titan-cli-pilot/qwen-lsRr6t/feedback.md)
and [Gemma's feedback](../experiments/runs/005-titan-cli-pilot/gemma-7UIBH0/feedback.md)
identify observed errors and existing contract obligations without implementation
code. North is not eligible for a revision under the frozen successful-capture
rule because its scope violations made the CLI result unsuccessful. These
different revision eligibility outcomes must not be mistaken for equal-budget
model capability rankings.

All three initial coding captures had unchanged frozen inputs and portable
patches passing apply-check. No patch was applied to their original fixture.
The retained provider configuration has `supportsUsageInStreaming:false`.
Token fields in all authoritative assistant-message events were zero despite
generated output: usable token/cost telemetry is unavailable, not zero usage.
The read-only `summarize.mjs RUN` helper aggregates those events without counting
duplicate turn-end/update events.

Qwen's [single revision](../experiments/runs/005-titan-cli-pilot/qwen-revision-vF0Xof/primary-review.md)
took 101.929s / seven tools and changed only its tests. It ended at 42/44 passing,
with two incorrect version assumptions and a passing but inadequate precedence
test. Its implementation remains green under the independent checks, but the
task is blocked. No further repair is performed.

Gemma's [single revision](../experiments/runs/005-titan-cli-pilot/gemma-revision-GG7tev/primary-review.md)
took 160.829s / five tools and changed only its tests. All 19 tests passed
(eight independent, two original, nine participant). Primary review confirmed
the requested mutation and rejection-state coverage. The bounded candidate is
accepted under delegated experiment authority, not real-user feature acceptance.
Total CLI wall time across its two attempts was 307.155s, excluding preparation,
review, verification, load differences and other overhead. Qwen's corresponding
two-attempt time was 158.316s with an unresolved result; faster is not better if
the agreed outcome is not delivered.

## Workflow lesson applied

The outer-agent skill now explicitly asks for stateful expectations to be
derived from the setup and mutations, and for within-call precedence to be
tested within one call. It also permits keeping acceptance-test design with the
stronger outer agent and assigning only implementation to the worker, with that
division recorded before dispatch. This fits the operator's intended SOTA-plus-
small-model workflow; it is not a claim that this change has been validated by
another live panel. The product worker prompt, profile and all frozen participant
inputs were left unchanged during the valid panel.

The task's phrase “ordinary JSON-compatible data” leaves unusual property
descriptors insufficiently explicit. Static review noted Gemma's `Object.keys`
validation rejects non-enumerable required fields. The frozen checks do not
qualify that case; it is a specification/coverage limitation, not an added
post-hoc score or proof of complete input-domain correctness.

## Preservation and handoff

The [final application walkthrough](../experiments/runs/005-titan-cli-pilot/gemma-applied-walkthrough/transcript.md)
used another fresh fixture: the outer caller checked and applied Gemma's initial
and revision patches, confirmed byte-identical final candidate files, and ran
the frozen verifier again (19/19 passing). It then explicitly recorded the
primary's delegated benchmark acceptance. The controller reported `accepted`
and `next:null`. This verifies the full handoff through application and recorded
acceptance without implying automatic worker application or real-feature approval.

Final inspection of all five valid coding/revision runs found current frozen
source hashes, retained frozen copies and prepared project inputs unchanged.
Worker candidates and review evidence remain separate from original fixtures.
The original podcast repository remains at
`b93a947217fe469767378b532542de8cd278cc9f`, with only the three expected untracked
user documents. All 35 source files represented in experiment004's original
baseline matched bytes and SHA-256; its other eight manifest entries are
experiment-only artifacts, not missing source files.

No Git commits/pushes, deployment, global installation or Pi configuration
changes were made. Use the [quickstart](quickstart.md) for the supported local
path. Keep the first real trial bounded and review results before application.

## Interpretation limits

This is one prepared task per model, not a reliability benchmark or model
ranking. Quantization, model loading, hardware and request settings confound
latency comparisons. Strong-model preparation/review and Luna development effort
are not fully metered; inference time is not end-to-end development cost.
Reported token usage is provider-reported, not independently measured; configured
zero prices would not establish zero operating cost. The CLI's `observed.usage`
is explicitly scoped to the final assistant message, not the whole run.
