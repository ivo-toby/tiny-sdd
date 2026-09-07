# TinySDD current scope: operator-led SDD for bounded features

Date: 2026-09-05
Status: first bounded feature pilot complete; podcast checkpoint repair exhausted
after its bounded continuation;
testable controller/worker CLI v0 implemented and available for controlled use;
production reliability not established

The operator's later 2026-09-05 instruction authorizes moving ahead with the CLI,
prompts and bounded additional Titan benchmarking for testing on 2026-09-06.
[The concrete implementation boundary](cli-v0-implementation.md) controls that
increment and supersedes earlier statements below deferring CLI implementation.
It permits three focused podcast task02 repair calls, retaining prior results,
and a separate three-model engineering pilot. Original project application,
deployment and global configuration changes remain outside this work.

This document controls the next development increment. The
[architecture](prototype-architecture.md) is deferred exploration, not an
implementation checklist. Its [dated review](prototype-architecture-review-2026-09-04.md)
remains a historical review of that larger design, not approval of this scope.
The later [controller/worker direction](controller-worker-design.md) records the
agreed dual-use CLI, named project workers and controlled worker context. It
supersedes the earlier preference against a product CLI. The v0 CLI is now
implemented, but it was not a prerequisite for the current feature experiment.

## Outcome and first deliverables

Enable the operator to build quality software reliably with a spec-driven
workflow and smaller implementation models. Reduced supervision, uninterrupted
autonomy, and lower human involvement are not the primary objectives. Operator
approval and review are deliberate parts of the product.

The agreed division of work permits Astra/Sol to clarify requirements, prepare
specifications, acceptance criteria, task boundaries, and context, and review
results. Qwen/Gemma/Nemotron implement bounded tasks from those artifacts. There
is no requirement for smaller models to perform every SDD role. The operator
owns product decisions, progression, and acceptance.

The product is the workflow, its useful artifacts, and the skills for producing
and consuming them inside an ordinary coding agent, initially Pi, with a v0 CLI
supporting both controller and spawned-worker use. Start with
one bounded feature containing a few connected tasks, not an epic or a runtime
fleet. The existing single-task skill/template are a starting experiment, not
an already validated feature workflow. Small capture/scoring scripts are
experiment tooling, not a new product harness or required SDK dependency.

WDD is a conceptual comparison for larger-scale autonomous orchestration, not
an implementation dependency or a workflow to invoke here. TinySDD differs in
operator-controlled progression as well as scale; it is not an autonomous epic
runner with a smaller task count. Lessons about specifications, task boundaries,
context, and checks can inform it without importing WDD's controller.

## Visible user workflow

1. The operator and a strong model clarify a bounded feature against repository
   code/contracts, exposing missing facts and product decisions.
2. The strong model prepares a concise feature specification, acceptance
   criteria, and a few connected implementation tasks. The operator inspects
   and approves the behavior and task boundaries before implementation.
3. For the next task, supply the smaller model with the relevant specification,
   source context, constraints, dependencies, checks, and stop conditions. Keep
   the handoff visible and let the operator decide to proceed.
4. The smaller model implements and verifies that task with ordinary host tools.
   Observe a behavior-specific failing check first when applicable; distinguish
   setup errors from that evidence. Report missing facts instead of guessing.
5. The operator inspects the diff and observed verification, supported by
   strong-model review and independent checks. Accept the task, request a bounded
   revision, or revise the specification; do not silently advance on failure.
6. Verify the integrated feature against its acceptance criteria and existing
   regressions. The operator accepts the feature, not merely a list of completed
   tasks.

Progress, questions, tool actions, and approvals stay visible in the conversation.
If the user changes meaning or scope, revise the brief and ask again. Preserve
unrelated user work. Branches and commits follow the user's existing policy;
TinySDD v0 does not require automatic Git operations or an initially clean tree.
Experiments use controlled starting repositories for comparability; this is not
a clean-tree requirement for product users.

The brief on disk supports resuming after a context reset. Do not add automatic
stage-session orchestration yet. A same-context review is labeled as such;
same-model fresh-context review does not establish independent correctness.

## What v0 does not promise

These are workflow instructions, not hard enforcement. With ordinary host tools,
a skill cannot guarantee write-set confinement, authentic approval attribution,
immutable evidence, automatic staleness detection, or sandboxed execution.
Report only commands observed in host tool results; never accept a participant's
claim that it ran a test, obtained approval, or performed a review as evidence.

The podcast checkpoint required no CLI, event log, custom tools, prompt
compiler, Pi SDK embedding, runtime fleet, or harness UI. The v0 dual-use CLI is
now available for controlled use, but it is not a production-reliability claim.
No WDD skills, commands, state, or
dependency are used. Tool/session restrictions may be explored later if actual
failures justify them. Experiments use disposable, non-sensitive workspaces with
the available host protections; normal tools are not a security boundary.

## Development working model

- The primary agent owns hypotheses, fixture semantics, expected-value sources,
  skill/prompt/instruction refinement, result interpretation, and final review.
- Delegate bounded mechanical work to Codex subagents using `gpt-5.6-luna` with
  reasoning effort `max` (the requested `5.6-luna-max`). Examples: implement an
  agreed scorer, run a frozen protocol, collect results, check links, or update
  fixtures to an already specified contract. Give exact outputs and write scope.
- The primary agent inspects the resulting changes and observations. Luna does
  not choose the acceptance oracle, revise scoring after outcomes are visible,
  approve product decisions, or quietly substitute a runtime.
- Target local/cloud models are experiment participants. Neither the primary
  agent nor Luna may silently repair their code or supply unrecorded hints.
  Strong-model preparation and planned review feedback are explicit parts of
  the feature workflow, with their scope and revision budget defined before a
  run. Record clarification, normal approval, planned review, and unplanned
  rescue separately. Operator involvement is not automatically a failure.
  The earlier frozen single-task experiments retain their stricter no-hint
  policy; this direction does not reclassify their results retroactively.
- User approval owns product meaning, accepted risk, and materially expanded
  scope. Delegation is how we develop TinySDD, not a fleet requirement for its
  users. If Luna is unavailable, report it rather than silently choosing another
  model. Record delegation overhead where exposed; do not assume it is free.

## Current increment and next test

The user selected `mcp-podcast-generator` and delegated controlled execution
and primary review of the async-generation checkpoint. Task01 is accepted;
task02 has passing independent checks but unresolved test review and exhausted
invocations, including two additional Titan Q3 attempts and the bounded focused
repair continuation. The final revised factory test suite fails to load;
tasks03/04 did not run. The
[focused-repair report](podcast-focused-repair-results-2026-09-05.md) controls
the final status. Original project files are unchanged. A recorded edit-only
worker amendment removes bash after verifier bypass; all remaining verification
is primary-owned. The separate [Experiment 005 CLI/Titan panel](cli-pilot-results-2026-09-06.md)
is complete: Gemma's bounded candidate accepted after one revision; Qwen remained
blocked by test defects and North by scope/test incompatibility. The CLI and
updated skill are available for controlled testing via the [quickstart](quickstart.md).

The first feature pilot is [experiment 003: idempotent reservations](../experiments/003-idempotent-reservations/README.md),
a synthetic brownfield feature split into validation, stateful service and API
integration. The primary prepared its contract and reviewed work; Qwen and Gemma
are implementation participants. Luna-max handled bounded mechanical work.
Its [results](../experiments/003-idempotent-reservations/results-2026-09-05.md)
record initial and reviewed outcomes, timeouts, transport interruptions and
process gaps separately. Every unattended approval is a labeled simulation,
not actual human feature acceptance.

Keep the artifact set small: one feature specification with acceptance criteria,
short per-task handoffs, and linked verification/review evidence. Do not create
a mandatory document hierarchy or decide the full skill suite in advance.
Each handoff should identify the required behavior, relevant contracts/files,
preserved invariants, allowed changes, prior-task dependencies, checks, and
conditions requiring clarification. Test the minimum sufficient format.

Execute tasks sequentially with visible operator decisions. Check both each task
and the integrated feature. Attribute failures to specification gaps, task
boundaries, missing context, implementation errors, or verification/review gaps.
Change one contributing artifact or instruction at a time. Planned review must
produce recorded feedback, not hidden strong-model implementation work.

The pilot retained two unchanged Qwen attempts, then versioned one concrete
caller-mutation example after a repeated defect. One fresh Qwen attempt and one
Gemma transfer use that revised packet. This is outcome-informed exploration,
not a randomized estimate of the example's benefit. Nemotron's unresolved tool
qualification remains separate work; missing coverage is not a pass.

Keep the experiment-local preparation/task skills as candidates. The existing
product skill was subsequently updated for the CLI; global Pi configuration is
unchanged. The next useful feature-level test is
a held-out small feature in a real repository selected with the operator. Test
strong-model artifact preparation from the actual request and code, including
operator review, rather than only consuming this carefully prepared fixture.
Retain preparation revisions and review effort as well as implementation results.
See [concrete review lessons](feature-review-lessons.md). Do not expand experiment
infrastructure without a failure that warrants it.

The previous function-level comparisons establish narrow tool/workflow facts.
Their precise TASK.md inputs already supplied much of a specification, so they
do not establish whether strong-model preparation produces sufficient artifacts
for reliable feature delivery. Further isolated approval/preservation wording
experiments are not the primary next increment.

## Evidence and experiment loop

Use measured evidence, not model endorsements, as the basis for development.
Finite experiments support a hypothesis under recorded conditions; they are not
proof that a model or workflow is universally reliable.

1. Write the hypothesis and define feature-level success, permitted scope,
   role assignments, operator decision points, and bounded review/revision policy
   before running. Quality means correct agreed behavior, preserved regressions,
   compatible integration, and resolution of substantive review findings.
2. Establish expected values from a reference implementation, pre-existing test,
   or reviewed behavioral specification. Tests must exercise the production
   path. Freezing a test early does not make its assumption correct: verify its
   source and check that a deliberately wrong implementation fails it.
3. Freeze the starting repository, checks, prompts, artifact/skill versions, and
   runtime settings by digest. Retain the preparation inputs and outputs, not
   just the final implementation prompt. Keep held-out checks out of the
   participant's supplied context and workspace, and run them separately on the
   captured final output.
   Preserve the executable checks for later inspection and reproduction.
4. First establish whether the role-split workflow can deliver the chosen
   feature. To attribute benefit to a particular artifact or skill, compare it
   with an explicit control under matched model, starting facts, tools, and
   budgets. Define whether the comparison tests artifact generation or artifact
   consumption; giving both arms a full specification tests only the latter.
   Equivalent questions receive consistent answers. Label simulated approvals
   as simulations, never as actual human approval.
5. Repeat on the initial runtime before expanding the panel. For comparisons,
   alternate or randomize arm order and retain every attempt. A few repetitions
   are a pilot, not a reliability guarantee. Record seeds when supported;
   otherwise say uncontrolled sampling. Freeze within-run continuation and review
   policy; do not add undisclosed resets or recovery hints after a failure.
6. Preserve every attempt and score correctness, prohibited effects, invented
   contract facts, and substantive review findings first. Record operator
   decisions and revisions by purpose, not as a penalty for supervision.
   Separately report tokens, time, tool calls, retries, and cost where exposed,
   including strong-model preparation/review. Distinguish model/prompt
   failures from transport, fixture, or experiment-runner failures. Preserve
   invalid runs with reasons; do not quietly omit model failures or timeouts.
7. Diagnose the smallest recurring failure. Change one instruction or mechanism
   at a time, version it, and rerun both arms when the fixture or scorer changes.
   Test a retained prompt change on a new held-out task before claiming transfer.

Each experiment gets a plain directory under `experiments/runs/<experiment-id>/`
with the protocol, fixture/check digests, runtime and host versions, exact prompts,
raw returned messages and tool observations, final diff, scorer stdout/stderr and
exit status, timing/usage, interventions, failures, and a short decision report.
Never interpolate prompts into shell source; use argument arrays or stdin.
Record unknown configuration as `UNKNOWN`. Keep credentials and private data out
of captured/shareable artifacts; preserve evidence securely and label redactions.

Development smoke runs can precede freezing; label them exploratory. The
[2026-09-04 pilot summaries](model-evaluation-results-2026-09-04.md) suggest things
to investigate but are not end-to-end efficacy evidence. Claims lacking retained
raw runs and reproducible scoring must be rerun before driving implementation.
The [older evaluation plan](model-evaluation-plan.md) concerns the deferred
controller, not this operator-led feature workflow.

## Runtime panel

Participants are the user-provided Pi runtimes:

- `randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf` on the friend's server;
- `titan/llamacpp/gemma4-26b-a4b-256k` on the titan-box;
- `ollama-cloud/nemotron-3-nano:30b` through Ollama Cloud, confirmed available
  in Pi by the user on 2026-09-05. A fresh exploratory read-tool smoke also
  passed for each configured runtime; this is connectivity evidence only.

All three run through the user's existing LiteLLM proxy, as confirmed on
2026-09-05. These are direct model IDs, not routing aliases, and the user confirms
that these invocations have no fallbacks. Keep that path for both baseline and
treatment: the experiment evaluates the skill in this real Pi/proxy/backend setup,
not isolated model weights.
No separate provider integration or replacement proxy is needed.

Before a batch, verify the resolved provider/model and actual tool operation.
Do not silently fall back to a different endpoint or model. Run serially per
server to avoid confounding latency with contention. Compare treatment effects
within each runtime; different hardware and quantization confound model rankings.

For the experiment, verify these proxy conditions without changing shared
configuration unless the user authorizes it:

- Use the exact direct model IDs above. Preserve the existing no-fallback setup;
  no alias resolution or fallback configuration work is required.
- Require fresh generated responses for repetitions, not replayed exact-match
  or semantic response-cache entries. This is separate from backend prompt/KV
  caching; record warm/cold conditions when interpreting latency.
  [LiteLLM response-cache controls](https://docs.litellm.ai/docs/proxy/caching)
- Freeze retry/time-out policy and request settings within each comparison;
  record retries and any known parameter filtering or rewriting. Do not assume
  a requested setting reached the backend unchanged.
- Record proxy version, a non-secret configuration revision, resolved deployment,
  and request IDs using existing traces where available. LiteLLM documents
  [deployment, retry, fallback, and timing headers](https://docs.litellm.ai/docs/proxy/response_headers);
  capture these when exposed by the installed version and client. Missing
  metadata is unknown, not zero. Unverified response freshness limits a run to
  exploratory evidence, not a qualified fresh repetition. Record the user's
  no-fallback confirmation as configuration evidence, distinct from run traces.

The third participant is **Nemotron 3 Nano 30B**, listed by Ollama as
[`nemotron-3-nano:30b-cloud`](https://ollama.com/library/nemotron-3-nano:30b-cloud).
NVIDIA describes a 30B-total, 3.5B-active hybrid Mamba/Transformer MoE with
tool-use training. It adds another family in roughly the target size class.
[NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16)

That selection provides experimental coverage, not a measured performance
ranking or a guarantee of independent failure modes. Cloud serving introduces
different latency and potentially different quantization or hidden settings.
Keep its results separate; cloud availability is not evidence that the same
configuration fits local hardware.
Use it as a participant, not the grading authority or a rescue model.

Use the confirmed Pi ID `ollama-cloud/nemotron-3-nano:30b` for runs; the catalog's
`-cloud` tag is not its Pi ID. Verify authentication, tool compatibility, and usage
limits before a run; do not enroll, purchase service, or send private code merely
to test availability. Only public or synthetic fixtures go to the cloud participant.

Availability and exploratory smoke update on 2026-09-05: Ollama's public catalog
lists the model, the user confirms its configured Pi ID above, and all three
configured runtimes completed a fresh synthetic `marker.txt` read-tool smoke
with CLI exit 0, a real successful read tool call, no assistant error, and an
exact final marker match. See the [retained smoke summaries](../experiments/001-batch-reservation/results-2026-09-05.md)
for the per-runtime evidence. This qualifies only read-tool connectivity and
capture, not write/edit/check operation, skill activation or approval
continuation, or the model comparison.

An earlier restricted-session local Pi catalog command failed before listing
models because its settings/auth lock paths were read-only (`EROFS`). That
startup failure is historical and occurred before a proxy/model request; it is
not a current model result. A supported isolated `PI_CODING_AGENT_DIR` now
starts Pi successfully. It writes temporary settings/model metadata only,
referencing credentials from process environment rather than copying them to
disk. Global Pi files remain untouched.

Implementation update on 2026-09-05: the user authorized proceeding with the
fixture/tests and setting aside the code-style skill for this task. Provider
credentials are referenced through the child process environment, not copied to
disk. The user subsequently enabled full access; fresh smoke runs confirm
network access to the configured proxy.
See the [first experiment protocol](../experiments/001-batch-reservation/protocol.md)
and [draft skill](../skills/tinysdd/SKILL.md) for that earlier single-task work.

Later workflow observations on 2026-09-05 are recorded in the
[workflow results](../experiments/001-batch-reservation/workflow-results-2026-09-05.md).
Qwen and Gemma completed the explicit read/write/edit/check qualification.
Their first batch implementations passed the held-out behavioral checks, but
Qwen skipped approval and Gemma removed a regression test and timed out before
handoff. A narrow approval-instruction revision produced a visible pause with
unchanged implementation/tests in one fresh retest per local model. These are
exploratory observations, not a baseline comparison or a reliability guarantee.
Nemotron's byte-copy failure remains unresolved; it does not block local work.

The later [Unicode transfer comparison](../experiments/002-label-truncation/results-2026-09-05.md)
completed one ordinary-Pi and one TinySDD attempt per local model. All four
passed ten independent behavior checks plus five original regressions. Both
treatments visibly paused for approval, but neither observed a meaningful failing
check before implementation. This supports retaining the experimental approval
instruction, not claiming an accuracy advantage or full workflow compliance.

A separate [Gemma preservation comparison](../experiments/001-batch-reservation/preservation-results-2026-09-05.md)
did not support adding the candidate paragraph: the current skill retained all
five original tests, whereas the candidate deleted the frozen-input test. Both
modules passed the independent checks. The candidate remains experimental history,
not part of the product skill. A concrete test-edit/review procedure remains a
possible narrow follow-up, but the newly agreed feature workflow above takes
priority. No new product harness is warranted by these results.

## Exit decision and deferred questions

The first feature increment retains a primary-prepared specification/task set,
captured smaller-model implementation and planned review, independent task and
integration results, and a decision about candidate artifacts. Its simulated
approvals do not establish real operator usability or human acceptance. Finite
successes are feasibility evidence; reliable delivery requires transfer to
held-out features and repeated outcomes. Missing runtime coverage is reported,
not replaced or counted as a pass. The role split is permitted; an all-small-model
preparation pipeline is not a prerequisite.

Retain instruction changes only with evidence relevant to their intended outcome.
If both arms already succeed, do not claim an accuracy gain. Approval visibility
and operator control are legitimate outcomes; fewer human decisions are not the
success criterion. Track cost and effort as tradeoffs, including strong-model
work, without requiring an all-small-model workflow. No result obliges us to
build a controller.

The deferred architecture still needs answers for command isolation when tests
execute model-authored code, evidence freshness when tracked reports change the
workspace, and recovery between a Git commit and its event record. Oracle-source
correctness remains relevant now. Record these limits without implementing their
infrastructure as a prerequisite for the skill experiment.
