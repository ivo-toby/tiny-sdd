# TinySDD handover

**Resume here (2026-09-07):** [Readiness assessment and proposed next steps](docs/next-steps-2026-09-07.md).
The current checkout passes 44 deterministic tests and supports controlled
controller/worker use. The dated execution summaries below need reconciliation
with later work; they are not a complete account of current readiness.

**Prepared:** 2026-09-04  
**Repository:** `https://github.com/ivo-toby/tiny-sdd`  
**State at handover:** empty repository plus this handover and the transferred design proposal; no implementation exists  
**Status:** historical handover; superseded for current scope  
**Current scope:** [docs/current-scope.md](docs/current-scope.md)

**Latest execution:** [Podcast focused-repair continuation](docs/podcast-focused-repair-results-2026-09-05.md).
Task01 accepted; task02 blocked after its bounded three-call repair allowance;
tasks03/04 unrun. Global Pi configuration and original project unchanged.

**2026-09-06 local update:** [CLI implementation and Titan pilot](docs/cli-pilot-results-2026-09-06.md)
complete; see the [quickstart](docs/quickstart.md). Controller and Pi-worker
surfaces implemented, 32 deterministic tests pass. Gemma's bounded candidate
accepted after one revision; Qwen/North pilot tasks blocked with evidence retained.

## Current scope and precedence

[docs/current-scope.md](docs/current-scope.md) is the authority for the approved
2026-09-05 v0 direction and current implementation work. It takes precedence
over this 2026-09-04 handover and the historical documents linked below.

This handover is a dated snapshot from before the v0 CLI implementation.
Statements below about proposed interfaces or no implementation describe that
snapshot; see [the quickstart](docs/quickstart.md) for current CLI usage.

## Historical design references

The historical working design is [docs/small-model-sdd.md](docs/small-model-sdd.md).
Its external references were researched on 2026-09-03 and 2026-09-04 and are
collected at the end of the document.

**Historical follow-up on 2026-09-04:** the standalone implementation draft is now
[docs/prototype-architecture.md](docs/prototype-architecture.md). It is supported
by [the model evaluation plan](docs/model-evaluation-plan.md),
[pilot results](docs/model-evaluation-results-2026-09-04.md), and
[the adversarial review record](docs/prototype-architecture-review-2026-09-04.md).
No source implementation exists yet in the handover's dated snapshot. These
documents preserve historical exploration; they do not define current
requirements or implementation prerequisites.

## User intent

Design a new spec-driven development framework specifically for capable coding
models that run on consumer hardware. The target capability class is roughly
27B-35B total parameters, often sparse or MoE with about 3B-4B active
parameters, and context windows up to 128K. Examples discussed were Qwen 3.5-era
27B-35B models, North Mini Code 1.0, and Gemma 4 26B-A4B.

These models can perform a complete development workflow, but they need more
externalized reasoning support than frontier models:

- explicit requirements instead of inferred intent;
- detailed technical designs and contract research;
- small, ordered task briefs with bounded choices;
- frequent readiness, red, implementation, verification, and review checkpoints;
- precise delivery and outcome definitions;
- compact, directive prompts and a short constitution;
- deterministic state and evidence outside chat history.

The most important correction from the user is that this must be a **new
framework**. It must not become a mode, profile, wrapper, compatibility layer, or
thin renaming of Wave-Driven Development (WDD). WDD is only research evidence
about how smaller models respond to prompts, gates, task boundaries, contract
checks, and review.

## Name and identity

The settled name is **TinySDD**, expanded as **Tiny-Model Spec-Driven
Development**. “Tiny-model” describes the target model class; it does not imply
that the specifications are small. In fact, more explicit specifications are a
central premise.

- Repository: `tiny-sdd`
- Proposed CLI: `tinysdd`
- Proposed state directory: `.tinysdd/`
- Tagline: **Spec-driven development for capable models that fit on your
  machine.**

The design document has already been updated from the provisional `sm-sdd`,
`smdctl`, and `.smd/` terminology to TinySDD.

## Architectural direction already established

The proposal currently defines TinySDD as a serial checkpoint machine optimized
for one local model server and one active task. It contains five standalone
components:

1. A deterministic controller core.
2. A stage-specific prompt compiler.
3. A local model/runtime adapter.
4. A bounded repository execution environment.
5. An artifact and evidence store.

Its lifecycle covers request capture, clarification, requirements, repository
and contract research, design, acceptance design, task compilation, task
readiness, red, implementation, controller-run verification, fresh-context
review, checkpoint commits, feature acceptance, and human delivery approval.

Continuity lives in versioned artifacts rather than a long conversation. Each
model call has one responsibility, selected source material, an output schema, a
decision budget, tool limits, and explicit stop conditions. Nominal 128K context
is treated as a ceiling rather than a target; the initial hot-context budget in
the proposal is 24K with reserved output/tool capacity.

The baseline must work with only one installed model. Same-model review uses a
fresh context and is explicitly not described as independent. Riskier work can
escalate to a different local checkpoint or a human reviewer.

## Explicit non-dependencies

Do not import WDD's architecture merely because its experiments informed the
design. TinySDD intentionally has no requirement for:

- `wddctl` or `.wdd/`;
- WDD skills, state, or artifact compatibility;
- epics or waves;
- conflict-domain scheduling or parallel admission;
- controller/worker fleets;
- per-task worktrees or per-task pull requests;
- WDD reconciliation or delivery machinery.

The intended baseline is one feature branch, an ordered task queue, checkpoint
commits, and one final feature handoff. TinySDD should be implementable in a
repository whose users have never installed or heard of WDD.

## What was learned from WDD

Only the transferable findings should carry forward:

- deterministic verification gates mattered more than model tier;
- ambiguity moved to whatever external-contract surface remained ungated;
- smaller models followed explicit mechanical steps better than prose-only
  workflow descriptions;
- model claims about tests, fixes, reviews, or commands are not evidence;
- models may derive golden test values from their own incorrect output;
- adversarial artifact review catches expensive mistakes before coding;
- skipping a review layer allows semantic defects to escape;
- short, focused task prompts with exact files and outcomes outperform broad
  autonomy.

The proposal also incorporates primary-source lessons from GitHub Spec Kit,
Kiro, Anthropic, SWE-agent, long-context research, and official model cards. See
the design document for claims and links.

## Important design constraints

- Human approval is required where product meaning or materially different
  outcomes are at stake.
- Unknown facts must remain explicit `UNKNOWN` values; the model must not fill
  gaps with plausible inventions.
- Requirements, design elements, acceptance criteria, tasks, checks, and
  evidence need stable traceability.
- The controller—not the model—records state transitions, command results,
  evidence, and approval bindings.
- Downstream approvals and reviews become stale when their inputs change.
- Tests must be capable of disagreeing with the implementation and identify the
  provenance of expected values.
- Tasks should arrive implementation-ready with no unresolved architectural
  decisions and only a tightly bounded local decision budget.
- Repeated failure should cause task splitting, re-specification, runtime
  switching, or human escalation rather than unbounded retries.
- A measured fast path is needed for low-risk, already-well-specified work so
  framework ceremony does not dominate trivial changes.

## Proposed first experiment

The document recommends a deliberately narrow vertical slice:

```text
REQUEST -> CLARIFY -> REQUIREMENTS -> REQUIREMENTS_AUDIT
-> HUMAN_APPROVAL -> REPOSITORY/CONTRACT_RESEARCH
-> DESIGN/ACCEPTANCE -> DESIGN_AUDIT -> HUMAN_APPROVAL
-> ONE_TASK_PLAN -> PLAN_AUDIT -> HUMAN_APPROVAL
-> PLANNING_CHECKPOINT -> READINESS -> RED -> IMPLEMENT
-> VERIFY -> R0_REVIEW -> CHECKPOINT_COMMIT -> FEATURE_ACCEPTANCE
-> HUMAN_DELIVERY_APPROVAL
```

It should initially use one qualified local runtime, one feature branch, bounded
repository tools, artifact digests, dependency invalidation, write-set
enforcement, and controller-run checks. Grounded contract research is part of
the slice; without it the first contract-fabrication benchmark cannot test the
central hypothesis. This is a proposal, not an instruction to begin
implementation without confirming the next scope with the user.

## Repository provenance and current work

The design originated on branch `arch/spec-small-models` in
`https://github.com/ivo-toby/wdd`. It was moved here when the standalone
repository was created. The link previously added to the WDD README was removed,
so that repository is left without a dangling reference.

No source code, package structure, language choice, dependency selection, or
release plan has been committed for TinySDD. The design's CLI and artifact names
are architectural proposals, not an existing compatibility surface.

## Suggested opening for the next session

1. Read this handover and the complete design document.
2. Confirm the requested next outcome with the user before scaffolding code.
3. Preserve the standalone boundary and TinySDD identity.
4. If implementation is requested, first turn the vertical slice into an
   approved implementation specification: language/runtime, schemas, state
   transitions, prompt adapter protocol, sandbox boundary, tests, and acceptance
   fixtures.
5. Keep research claims tied to their existing primary-source links and clearly
   label new inferences.
