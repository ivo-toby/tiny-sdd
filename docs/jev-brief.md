# TinySDD × Jev — Research, Architecture & Benchmarking Spike

## Mission

Research whether TypeSafe AI's **Jev / System One** model could provide a meaningful semantic control layer inside TinySDD.

This is **not an implementation task**.

The eventual implementation is expected to be performed separately by:

- **Qwen 3.8 / Luna Max**
- using **TinySDD itself**
- followed by an independent review using **GPT-5.6 Sol**

Your job is to resolve the architectural ambiguity first.

Specifically:

1. understand Jev deeply from primary sources;
2. understand TinySDD's actual current architecture and philosophy;
3. identify the strongest Jev-shaped semantic decisions;
4. determine where Jev should explicitly _not_ be used;
5. design an integration that preserves TinySDD's simplicity;
6. design a benchmark capable of falsifying the hypothesis;
7. produce a compact implementation-context package for the later coding model.

Do not implement the feature.

Do not optimize for producing lots of ideas.

Optimize for reaching a small number of defensible decisions.

---

# Core hypothesis

TinySDD already has explicit workflow artifacts and transitions.

A generative coding model produces things such as:

```text
context
   ↓
specification
   ↓
plan
   ↓
tasks
   ↓
implementation
   ↓
verification
   ↓
completion
```

Some transitions can be validated deterministically.

Examples:

```text
Did tests pass?
Did lint pass?
Does the file exist?
Did the command exit successfully?
Is every task checkbox complete?
```

These must remain deterministic.

Other decisions are semantic:

```text
Is the context sufficient to write a spec?

Is this requirement ambiguous?

Is this acceptance criterion actually testable?

Does the plan satisfy the spec?

Does each task correspond to a requirement?

Has implementation drifted outside scope?

Does the collected evidence actually demonstrate that
the acceptance criterion was satisfied?

Is another iteration justified?

Should this problem be escalated to a stronger model?
```

These currently require judgment.

The hypothesis is:

> Jev can provide a cheap probabilistic semantic decision layer between TinySDD stages without becoming the author of those stages.

Conceptually:

```text
Generative model
    ↓
creates artifact
    ↓
Jev
    ↓
semantic judgments
    ↓
deterministic TinySDD policy
    ↓
advance / retry / clarify / escalate
```

The important boundary is:

> **Jev judges. TinySDD decides.**

A probability from Jev must never directly mutate workflow state without deterministic policy interpreting it.

---

# Desired conceptual architecture

Investigate something resembling:

```text
       ┌──────────────────────────┐
       │ Generative coding model  │
       └────────────┬─────────────┘
                    │
                    ▼
              SDD artifact
                    │
                    ▼
       ┌──────────────────────────┐
       │ Semantic Decision Layer  │
       │          Jev             │
       └────────────┬─────────────┘
                    │
           typed probabilities
                    │
                    ▼
       ┌──────────────────────────┐
       │ TinySDD deterministic    │
       │ policy / state machine   │
       └────────────┬─────────────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
    advance       retry       escalate
```

Do not assume TinySDD needs a formal state machine if it does not currently have one.

Find the smallest natural integration seam.

---

# Primary research sources

## TinySDD

Inspect the actual repository thoroughly enough to understand current behavior:

https://github.com/ivo-toby/tiny-sdd

Focus especially on:

- workflow stages
- artifact structure
- prompts/instructions
- phase transitions
- completion criteria
- evidence handling
- retry behavior
- model interaction
- context management
- test/verification handling
- current abstractions
- CLI commands
- logging/state if present
- existing extension points

Prefer current source and tests over assumptions from documentation.

---

# Jev / TypeSafe AI

Use primary sources first:

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/patterns
- https://docs.typesafe.ai/llms.txt

Also inspect:

- https://github.com/tegersdorfer-collab/jevkit

Treat third-party code as reference material rather than authoritative behavior.

Pay particular attention to:

- State
- Choice
- Score
- Noul
- confidence/probability semantics
- batching multiple questions over common state
- confidence-gated routing
- composite scoring
- intent routing
- speculative fan-out
- calibration
- model jaggedness / limitations
- JS/TS SDK design
- latency/cost considerations
- recommended evaluation methodology

---

# Jev mental model

Avoid treating Jev as a small chat model.

The relevant abstraction is roughly:

```text
state
+
atomic typed questions
→
probabilistic structured judgments
```

Potential primitives:

```text
Noul
  → probability of a proposition

Choice
  → probability distribution over bounded alternatives

Score
  → probability distribution over an ordered rubric
```

Jev should preferably receive the same state once and answer several independent atomic questions.

Avoid giant prompts such as:

> "Review this specification and tell me whether it is good."

Prefer decomposed judgments such as:

```text
Does every stated requirement have observable behavior?

Does the spec introduce functionality outside the user's request?

Does any requirement have more than one plausible interpretation?

Can every acceptance criterion be verified objectively?

Does this plan contradict any MUST or MUST NOT requirement?
```

Composition should happen in deterministic TinySDD policy.

---

# Candidate Jev integration points

Investigate these, but do not assume all belong in the design.

## 1. Context → Spec gate

Potential judgments:

```text
context_sufficient
material_ambiguity_present
critical_constraint_missing
requires_repository_inspection
requires_user_clarification
```

Question:

Could Jev prevent a coding model from writing a confident specification from inadequate context?

Potential action:

```text
advance
gather_more_context
clarify
escalate
```

---

## 2. Spec quality gate

Potential judgments:

```text
requirements_unambiguous
acceptance_criteria_testable
scope_is_bounded
requirements_are_internally_consistent
non_goals_are_respected
implementation_detail_leaks_into_spec
```

This is potentially one of the strongest use cases.

A generative model writes the spec.

Jev does not rewrite it.

Jev identifies semantic risk.

TinySDD policy decides whether to accept the spec or ask the author model to revise it.

---

## 3. Spec → Plan consistency

Potential judgments:

```text
plan_covers_requirement
plan_contradicts_requirement
plan_introduces_unrequested_scope
architecture_is_under_specified
```

Investigate whether these questions are atomic enough for Jev.

Avoid asking Jev to design the plan itself.

---

## 4. Plan → Task validation

Potential judgments:

```text
task_maps_to_requirement
task_is_independently_actionable
task_has_clear_completion_evidence
requirement_has_no_task
task_has_no_requirement
task_scope_is_excessive
```

Some traceability may be provable deterministically.

Do not use Jev where IDs/references can solve the problem exactly.

Use semantic judgment only where deterministic traceability is insufficient.

---

## 5. Implementation evidence gate

This is a particularly important candidate.

TinySDD should distinguish:

```text
claim
```

from:

```text
evidence
```

Example:

Generative agent says:

> "REQ-4 is complete."

That statement itself proves nothing.

Available evidence might include:

```text
test output
compiler output
changed files
generated artifacts
runtime observation
API response
snapshot
benchmark result
```

Deterministic checks establish factual evidence.

Jev could potentially answer:

> Does the supplied evidence actually demonstrate the semantic requirement?

Example:

```text
Requirement:
"The system must gracefully fall back when Jev is unavailable."

Evidence:
- fallback unit test passes
- provider timeout integration test passes
- error-path implementation diff

Jev:
Does this evidence materially demonstrate the stated requirement?
```

This could form the semantic half of **evidence-gated SDD**.

---

# Evidence-Gated SDD hypothesis

Investigate this explicitly as a potential defining TinySDD capability.

Traditional agentic SDD broadly resembles:

```text
spec
 → plan
 → tasks
 → implementation
 → agent says done
```

Evidence-gated SDD would instead resemble:

```text
spec
  ↓
acceptance criteria
  ↓
implementation
  ↓
evidence generation
  ↓
deterministic verification
  +
semantic evidence evaluation
  ↓
completion gate
```

Potential principle:

> No task or requirement is complete because the implementing model claims it is complete.

Completion requires evidence.

Some evidence is validated deterministically.

Some evidence-to-requirement relationships require semantic judgment.

Jev may potentially provide that semantic judgment cheaply.

Research whether this is both technically useful and conceptually consistent with TinySDD.

---

# 6. Retry / continuation decisions

Potential questions:

```text
Did this iteration materially reduce uncertainty?

Is another implementation attempt likely to be useful?

Is the failure caused by missing context rather than bad implementation?

Is the agent repeating essentially the same unsuccessful approach?

Should the workflow return to:
context?
spec?
plan?
implementation?
```

Jev may potentially support bounded loops.

Be careful not to build an elaborate autonomous-agent framework into TinySDD.

TinySDD should remain tiny.

---

# 7. Model escalation / routing

Potentially:

```text
task complexity
ambiguity
risk
architectural scope
research requirement
```

could be classified into something like:

```text
routine
normal
deep_reasoning
human_input
```

TinySDD could then select an appropriate model.

However:

Do not assume model routing belongs inside TinySDD.

It may properly remain the responsibility of the harness running TinySDD.

Research this boundary explicitly.

---

# Explicit anti-use-cases

Find places where Jev would be a mistake.

Examples likely include:

```text
test pass/fail
compiler result
file existence
exact requirement IDs
dependency ordering
JSON-schema validation
static analysis
format checking
coverage threshold
Git status
command success
```

These are deterministic.

Using probabilistic inference for deterministic facts would make the system worse.

Also identify semantic decisions where:

- ordinary embeddings are sufficient;
- a cheap normal classifier is better;
- the decision is too open-ended for Jev;
- a human must remain authoritative.

---

# Preserve TinySDD's philosophy

This matters a lot.

Do not turn TinySDD into:

```text
TinyAgentOrchestrationEnterpriseFramework™
```

Any proposal must justify its complexity.

Prefer:

```text
one small semantic decision abstraction
+
a small number of high-value gates
```

over dozens of configurable agent behaviors.

Ask:

> If Jev disappeared tomorrow, would TinySDD remain simple and fully usable?

The answer should be yes.

---

# Provider boundary

Investigate whether TinySDD should know about Jev specifically.

Possible architecture:

```text
SemanticJudge
```

with Jev as one provider.

But do not create abstraction theatre.

Only introduce an abstraction if:

- it naturally matches TinySDD's existing architecture;
- it makes benchmarking/fallback substantially easier;
- or comparison with another semantic judge is useful.

Otherwise a narrower Jev integration may be preferable.

---

# Benchmarking is a first-class requirement

Do not recommend an implementation unless we can objectively determine whether it improved TinySDD.

The benchmark should answer:

> Does adding probabilistic semantic gates improve SDD outcomes enough to justify additional complexity, latency and cost?

The benchmark must evaluate the **workflow**, not just final code.

---

# Experimental variants

At minimum design comparison between:

## A — TinySDD baseline

Current TinySDD behavior.

No Jev.

## B — Jev shadow mode

Jev evaluates semantic gates but cannot affect workflow behavior.

Record what it would have decided.

## C — Jev gated

Only the carefully selected recommended gates influence the workflow.

Potentially also evaluate:

## D — Generative reviewer baseline

Use an inexpensive conventional generative model to perform the same semantic review.

This matters.

The actual hypothesis is not:

> Jev can judge artifacts.

It is:

> Jev provides a useful quality/cost/latency/reliability tradeoff compared with existing alternatives.

---

# Hold the implementation model constant

For primary comparisons, use the **same implementation model** across variants.

For example:

```text
Qwen 3.8 baseline TinySDD
vs
Qwen 3.8 TinySDD + Jev
```

Do not compare:

```text
weak model without Jev
vs
strong model with Jev
```

because the result becomes uninterpretable.

Control:

- model
- model parameters where possible
- repository starting state
- task prompt
- available tools
- time/iteration limits
- TinySDD version

---

# Repeated runs

Coding agents are stochastic.

Do not draw conclusions from one run.

Research a realistic repetition count given cost and time.

A small initial benchmark might use something like:

```text
5–10 benchmark tasks
×
3–5 runs
×
baseline / shadow / gated
```

but determine the appropriate design rather than blindly adopting these numbers.

The benchmark should prioritize useful signal over statistical theatre.

---

# Benchmark task design

Design a compact benchmark suite containing qualitatively different tasks.

Prefer tasks that exercise SDD itself rather than raw coding ability.

Candidate categories:

## 1. Straightforward bounded feature

Clear requirements.

Little ambiguity.

Expected result:

Jev should add almost no value or friction.

This detects unnecessary gating.

## 2. Ambiguous requirement

Prompt contains a meaningful ambiguity.

Expected result:

A strong workflow should detect the ambiguity before implementation.

## 3. Scope-creep trap

Task strongly tempts the coding model to "improve" unrelated architecture.

Expected result:

TinySDD should stay within scope.

## 4. Missing-context task

Correct implementation requires repository information not initially present.

Expected result:

Workflow should gather evidence rather than invent assumptions.

## 5. Misleading partial success

Implementation passes obvious tests but fails part of the semantic requirement.

This is especially important for testing evidence gates.

## 6. Contradictory requirement/plan scenario

The generated plan or candidate task set conflicts with an explicit requirement.

## 7. Retry-loop scenario

Initial implementation attempt fails.

Measure whether Jev helps classify the next useful action rather than causing pointless retries.

Use real or derived historical TinySDD tasks where practical.

Synthetic cases are acceptable when they deliberately isolate one behavior.

---

# Benchmark dimensions

Do not reduce the benchmark to one score too early.

Measure separate dimensions.

## Outcome quality

Examples:

```text
acceptance criteria satisfied
tests pass
hidden tests pass
functional correctness
review defects
requirement coverage
scope compliance
```

Prefer deterministic ground truth where possible.

---

## Spec quality

Potential measures:

```text
missing requirements
ambiguity
testability
scope creep
internal contradictions
requirements subsequently revised
```

Where scoring requires human or LLM judgment, keep the evaluator independent from the implementation run.

---

## Plan/task quality

Measure:

```text
requirements with no implementation task
tasks with no requirement
unnecessary tasks
incorrect dependency assumptions
task churn
```

Use deterministic traceability where possible.

---

## Workflow efficiency

Measure:

```text
number of generative-model calls
tokens
wall-clock latency
Jev calls
Jev latency
estimated cost
iterations
retries
tool calls
context size
```

Do not claim improvement simply because Jev itself is cheap.

Measure the entire workflow.

---

## Gate behavior

For every Jev decision record:

```text
state
question
answer
probability/distribution
policy decision
eventual ground truth where available
```

Then evaluate:

```text
true positive
true negative
false positive
false negative
```

according to the gate semantics.

---

# Calibration

Calibration must be treated explicitly.

Do not invent:

```text
confidence > 0.8 → advance
```

and call it done.

Use shadow-mode results to determine threshold behavior.

Investigate appropriate metrics such as:

```text
Brier score
calibration curve
expected calibration error
precision/recall at candidate thresholds
```

The metric should reflect the cost asymmetry of each gate.

For example:

A false "ready to implement" decision may be significantly more expensive than an unnecessary additional clarification pass.

Conversely, an overly cautious gate can make TinySDD unbearably slow.

Thresholds may therefore differ by gate.

---

# False-positive / false-negative cost matrix

For each proposed gate, explicitly document:

```text
What happens if Jev incorrectly allows progression?

What happens if Jev incorrectly blocks progression?
```

Example:

### Spec ambiguity

False negative:

```text
Jev says clear
but spec is ambiguous
→ implementation may go down wrong path
```

False positive:

```text
Jev says ambiguous
but spec is actually clear
→ unnecessary retry / wasted tokens
```

This should influence threshold policy.

---

# Benchmark outcome categories

Define possible conclusions before testing.

For example:

### Strong success

Jev gating materially improves correctness / requirement adherence while adding modest overhead.

### Efficiency success

Quality remains equivalent but expensive model calls, retries or total token consumption fall substantially.

### Narrow success

Only one gate—for example evidence-to-requirement validation—provides useful signal.

Keep that gate and reject the rest.

### No benefit

Jev tracks simpler heuristics / normal reviewers without meaningful cost or quality advantage.

### Harm

Semantic gates create unnecessary blocking, loops, latency or confidence-related failures.

In that case, do not integrate them.

---

# Shadow mode first

Unless there is a compelling architectural reason otherwise, recommend an initial architecture that supports:

```text
mode = off
mode = shadow
mode = enforce
```

Shadow mode should produce structured evaluation traces.

Example:

```json
{
  "phase": "spec",
  "gate": "requirements_unambiguous",
  "decision": false,
  "probability": 0.73,
  "workflowAction": "ignored-shadow",
  "runId": "...",
  "artifact": "..."
}
```

Determine the actual appropriate schema from TinySDD's architecture.

---

# Observability

Design enough observability to answer:

```text
Which gate fired?

What state did it see?

What question was asked?

What probability was returned?

What policy decision resulted?

What happened afterward?
```

Avoid logging excessive source-code/context payloads unnecessarily.

Prefer hashes/references where practical.

Make benchmark traces replayable.

---

# Determinism boundary

Produce an explicit table with three categories:

```text
DETERMINISTIC
SEMANTIC / JEV CANDIDATE
GENERATIVE
```

For example:

| Decision                                       | Owner            |
| ---------------------------------------------- | ---------------- |
| Test command succeeded                         | deterministic    |
| Acceptance criterion semantically demonstrated | Jev candidate    |
| Rewrite implementation                         | generative model |
| File exists                                    | deterministic    |
| Spec contains meaningful ambiguity             | Jev candidate    |
| Generate corrected specification               | generative model |

This boundary is one of the most important deliverables.

---

# Adversarial research questions

Actively attempt to invalidate the whole idea.

Answer:

1. Could a 1–3B classifier perform these decisions just as well?
2. Could a cheap generative model do them well enough?
3. Are embeddings/rerankers sufficient for any proposed gate?
4. Does Jev confidence actually correlate with correctness?
5. Does adding gates cause workflow thrashing?
6. Does semantic review duplicate work the coding model already performs?
7. Does Jev need so much state that its latency/cost advantage disappears?
8. Do the gates improve weak models but add nothing to strong ones?
9. Does Jev create hidden vendor dependency?
10. Does semantic gating violate TinySDD's "tiny" philosophy?
11. Is the best design simply a benchmark/evidence framework without Jev?
12. Would deterministic structured requirements eliminate some proposed Jev decisions entirely?

The research is successful even if the recommendation is:

> Don't integrate Jev.

---

# Research output

Produce **three concise artifacts**, not one giant document.

---

# Artifact 1 — Architecture Decision

Target:

**1500–2500 words maximum**

Structure:

## Problem

What TinySDD weakness are we actually attempting to address?

## Current architecture

Only relevant current TinySDD architecture.

Reference concrete files/modules.

## Jev capabilities that matter

No generic System One essay.

## Deterministic / semantic / generative boundary

Explicit classification.

## Candidate gates

Maximum **3–5**.

For each:

```text
Current behavior:
State:
Atomic Jev questions:
Primitive:
Deterministic consumer:
Failure modes:
Expected benefit:
Benchmarkability:
Complexity:
```

## Recommended initial integration

Choose **at most 1–2 gates**.

Do not propose implementing everything.

## Proposed architecture

Smallest viable design.

## Explicit non-goals

Keep TinySDD tiny.

## Risks

Especially calibration and workflow thrashing.

## Decision log

Record decisions another model should not need to rediscover.

---

# Artifact 2 — Benchmark Specification

Target:

**1500–2500 words maximum**

This should be sufficiently precise that the implementation model can build the benchmark without inventing methodology.

Include:

## Hypotheses

Explicit falsifiable hypotheses.

Example format:

```text
H1:
Jev-assisted semantic gating reduces requirement violations
relative to baseline TinySDD.

H2:
Jev-assisted gating does not increase median workflow cost
by more than X.

H3:
Jev probabilities are sufficiently calibrated to define
stable advancement thresholds.
```

Do not choose arbitrary X values without justification.

## Variants

```text
baseline
shadow
enforced
cheap-reviewer comparison if practical
```

## Benchmark cases

Define categories and fixture strategy.

## Repetition strategy

Explain why.

## Controls

Model, tools, repository state, prompts, etc.

## Metrics

Separate:

```text
quality
workflow efficiency
gate performance
calibration
cost
latency
```

## Ground truth

Explain how correctness is established.

Prefer deterministic hidden tests where possible.

## Evaluation procedure

Step-by-step reproducible benchmark flow.

## Reporting

Define required tables/plots/statistics.

## Success criteria

Specify what would make Jev worth keeping.

## Rejection criteria

Specify what evidence should make us remove/abandon it.

---

# Artifact 3 — Implementation Context Packet

Target:

**800–1500 words maximum**

This is specifically for:

```text
Qwen 3.8 / Luna Max
+
TinySDD
```

It must contain only implementation-relevant context.

Use:

```markdown
# TinySDD Jev Integration — Implementation Context

## Goal

...

## Selected experiment

...

## Hypothesis

...

## Non-goals

...

## Existing architecture anchors

- path → purpose
- path → purpose

## Proposed architecture

...

## Jev gates to implement

### Gate 1

State:
Atomic questions:
Primitive:
Policy:
Shadow behavior:
Enforced behavior:
Fallback:

## Deterministic boundaries

...

## Configuration

off / shadow / enforce

## Observability

...

## Benchmark harness

...

## Required fixtures

...

## Acceptance criteria

...

## Explicitly deferred

...

## Decisions already made

...

## Open implementation questions

Only questions that genuinely require repository-level
implementation judgment.
```

The implementation agent should **not need to research Jev architecture again**.

---

# Context compression requirement

Do broad research.

Produce narrow output.

Do not preserve:

- dead ends
- generic SDD explanations
- generic Jev marketing
- long source summaries
- obvious repository facts
- speculative future features

Do preserve:

- non-obvious architectural conclusions
- exact integration seams
- rejected alternatives and why they were rejected
- benchmark methodology
- failure modes
- deterministic boundaries
- confidence/calibration assumptions
- concrete source paths

The final implementation packet should make the coding work feel almost mechanical.

---

# Implementation sequencing assumption

Assume the likely future sequence is:

```text
Muse Spark 1.3
    ↓
research + architecture + benchmark design
    ↓
human review
    ↓
Qwen 3.8 / Luna Max
    ↓
TinySDD-driven implementation
    ↓
benchmark execution
    ↓
GPT-5.6 Sol
    ↓
independent architectural/code/benchmark review
```

Do not optimize your research around any specific weakness of those models.

Create clear durable artifacts instead.

---

# Final required answers

End the research with explicit answers to these five questions:

### 1.

What is the smallest Jev integration that could materially improve TinySDD?

### 2.

Which single gate is the strongest initial candidate?

### 3.

What result would falsify the Jev hypothesis?

### 4.

What benchmark can demonstrate that result credibly?

### 5.

If the experiment succeeds, what should we **still not build**?

Keep the answers concise.
