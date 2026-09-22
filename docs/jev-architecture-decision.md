# TinySDD × Jev — Artifact 1: Architecture Decision

Date: 2026-09-21. Status: recommendation from research spike (no code written).
Companion artifacts: [jev-benchmark-spec.md](jev-benchmark-spec.md), [jev-implementation-context.md](jev-implementation-context.md).

## Problem

The weakness TinySDD actually has is not missing intelligence anywhere in the
pipeline. It is one specific trust gap: **acceptance of a task rests on a
verdict plus an evidence file that the controller records but cannot evaluate.**

Concretely:

- `reviewTask()` (`src/controller.mjs`) accepts `--verdict accepted|revision|blocked --evidence PATH --by LABEL`, digests the evidence file, and computes an `acceptanceDigest`. It never reads the evidence for meaning.
- The controller's own docs say: "Evidence is caller-supplied; the controller does not claim to have run its commands." Acceptance is bound to the *existence and digest* of evidence, never to whether the evidence demonstrates the acceptance criteria.
- The worker is a small model in a disposable read/write/edit workspace. Process completion is explicitly "not passing verification." The entire quality guarantee of TinySDD therefore hangs on the outer agent's review being honest and thorough — and the benchmark history (`experiments/probes/Q5-required-read.txt`, `Q2-missing-contract.txt`) shows small models produce plausible-but-incomplete evidence.

Every other proposed Jev gate either duplicates an existing human checkpoint or
touches deterministic ground. The evidence-sufficiency gap is the one place
where a semantic judgment is load-bearing, currently unguarded, and not already
covered by operator approval.

## Current architecture (only what matters)

- `bin/tinysdd.mjs` — CLI: `init`, `task add|approve|packet|review`, `worker run|start|status`, `config show|validate`, `status`, `next`.
- `src/controller.mjs` — single source of truth in `.tinysdd/runs/controller.json`; task states derived from approval freshness, dependencies, and `review.verdict` (`accepted`/`revision`/`blocked`, plus derived `accepted`/`stale`/`blocked`). `reviewTask()` is the acceptance boundary and records `evidenceDigest`, `briefDigest`, `approvalDigest`, `allowedDigest`.
- `src/context-compiler.mjs` — operator-curated manifest (`schemaVersion`/`facts`/`resources`) compiled into the worker packet; strict schema, 96 KiB cap, digests recorded at approval.
- `src/worker.mjs`, `src/pi-environment.mjs` — disposable worker, read/write/edit only, no command execution; caller runs verification.
- Review evidence feeds the next revision packet verbatim ("do not modify it silently after recording the decision").
- Zero runtime dependencies; Node 24; everything is plain ESM with strict schemas and atomic writes.

Two properties any integration must preserve: **deterministic transitions stay
deterministic** (tests, lint, file existence, exit codes, checkboxes) and
**the controller records, it does not authenticate** — operator approval is the
authority, and attribution must reflect actual authority.

## Jev capabilities that matter

From primary sources (docs.typesafe.ai: primitives, confidence, jaggedness;
`tegersdorfer-collab/jevkit` as reference):

1. **Noul** — P(yes) for a single proposition, 0–1, no separate confidence. The natural primitive for "does this evidence demonstrate this criterion?" One Noul per acceptance criterion, batched over one state.
2. **Batching** — one request carries `state` + many atomic questions; questions evaluate in parallel and in isolation; state is billed once. A task with six acceptance criteria is one call, not six.
3. **Structured state** — state can be a JSON object; instructions/criteria can be structured (`what`/`not_for`/`examples`, dot-references into state). Jev reads literally, so criteria must state exact conditions — a good fit for acceptance criteria, which are already written to be exact.
4. **Calibration behavior** — near-deterministic across repeats (σ ≈ 0.01), but values near 0.5 flip; confidence derives from distribution peakedness; thresholds must be set per gate with cost asymmetry in mind, and model version shifts bands (`Decision.model` logged in jevkit for this reason).
5. **Known jaggedness** — no counting, no arithmetic, no generation, no indirection, degraded by large irrelevant state, no injection defense, P(A)+P(¬A) ≠ 1. All of these are avoidable in the evidence gate: state is a small curated object, questions are positive and literal, composition is code.

## Deterministic / semantic / generative boundary

| Decision | Owner |
| --- | --- |
| Test command succeeded, lint passed, file exists, exit code, checkbox complete | Deterministic (unchanged) |
| Requirement-to-task traceability via IDs, dependency ordering, schema validity, digests | Deterministic (unchanged — Jev is *worse* than IDs here) |
| Does this evidence materially demonstrate acceptance criterion X? | **Jev candidate (the one gate)** |
| Is the spec ambiguous / is a criterion testable? | Jev candidate, but see rejection below |
| Rewrite spec, repair implementation, decide what to build | Generative model (outer agent / worker) |

Explicitly rejected as Jev territory, with reasons:

- **Context→spec gate (candidate 1).** In TinySDD the spec/brief is written by a strong outer agent and the *operator approves it deliberately* before dispatch. Jev would duplicate a human approval checkpoint that is the operator's authority by design. Shadow-mode data can be collected later for free if we log it; do not gate on it.
- **Plan/task validation (candidate 4).** Most of it (task maps to requirement, requirement has a task) is solvable exactly by ID references in the brief — the brief itself says use IDs where they suffice. The remainder is covered by review.
- **Retry/continuation (candidate 6).** Requires comparing iterations (a state-Jev cannot see) and risks building an autonomy loop. TinySDD's revision path is operator-controlled by design.
- **Model escalation/routing (candidate 7).** Belongs to the harness, not TinySDD. TinySDD profiles already carry this.
- **Everything deterministic** (test outcomes, file existence, counting criteria covered, JSON validity). Using probability for facts makes the system strictly worse (jaggedness: counting/arithmetic are Jev's worst modes).

## Candidate gates (final set)

Three candidates survived screening; one is recommended for implementation.

### Gate E — Evidence sufficiency (recommended, the only enforced gate)

- **Current behavior:** `reviewTask()` records any nonempty evidence file with an `accepted` verdict; nothing checks the evidence says anything about the criteria.
- **State:** lean object per task — task id, the acceptance criteria from the approved brief (quoted verbatim), and the caller-curated evidence summary (test names + outcomes, checks run, artifacts produced). Filtered in code; no full source dumps (jaggedness #5).
- **Atomic questions:** one Noul per acceptance criterion: "Does this evidence demonstrate that: `<criterion text>`?" Positive phrasing, literal criteria, `criteria: {true: …, false: …}` where the boundary is subtle.
- **Primitive:** Noul, batched, one call per task review.
- **Deterministic consumer:** `reviewTask()` policy — `noul ≥ HIGH` → `accepted` permitted; `noul < LOW` on any criterion → `accepted` refused (must be `revision` or an explicit `--force-semantic-override` recorded in the review); middle band → warning recorded in the review, operator decides. Exact thresholds set by shadow calibration (Artifact 2), not invented.
- **Failure modes:** Jev unavailable → fail closed is wrong here; default to *off-behavior* (behave as today) and record `semantic-judge-unavailable` in the review, because TinySDD must stay usable without Jev ("if Jev disappeared tomorrow…"). Model literalness → mitigated by quoting exact criterion text. Near-0.5 flip → middle band routes to operator, which is the existing workflow anyway.
- **Expected benefit:** catches the "misleading partial success" class — evidence that passes obvious checks while a criterion is undemonstrated — which is exactly probe Q2/Q5 behavior in small models.
- **Benchmarkability:** direct. Shadow logs give labels; hidden tests give ground truth; case #5 of the benchmark suite targets it.
- **Complexity:** one new module (`src/jev.mjs`, plain `fetch`, no SDK), one config block, one policy branch in `reviewTask()`, one decision log. Small.

### Gate S — Spec ambiguity (shadow only, optional)

- **Current behavior:** operator approves the brief; ambiguity is caught by humans.
- **Questions:** one Noul per requirement: "Does this requirement have more than one plausible implementation interpretation?" plus "Is this acceptance criterion verifiable objectively?"
- **Why not enforced:** duplicates operator approval; risk of blocking a human-approved workflow on a probability; value unproven.
- **Use:** run in shadow during the benchmark to answer "does Jev see ambiguity the operator missed?" Keep only if shadow data shows real signal.

### Gate R — Revision-quality (rejected)

"Does this revision evidence show material progress?" is temporal (needs state from prior runs Jev can't see in one state) and duplicates the operator's verdict choice. Rejected.

## Recommended initial integration

**One gate: evidence sufficiency, enforced at `task review`, shadow-validated
first.** Nothing else. If the benchmark shows the narrow-success outcome, Gate S
may be added as shadow-only advisory later; do not implement it now.

## Proposed architecture (smallest viable)

```text
src/jev.mjs            — buildRequest(task, criteria, evidence) → POST /v1/systemone
                         plain fetch, TYPESAFE_API_KEY from env, timeout, one retry
src/semantic-policy.mjs — noul values + thresholds → {allow, warn, block, log}
controller.mjs         — reviewTask() consults policy when mode != off;
                         appends decision record under .tinysdd/runs/decisions/
```

- Config: `semanticGate: { mode: "off" | "shadow" | "enforce", model: "jev-latest", thresholds: { accept: n, confirm: n } }` in the existing `config` schema, default `off`. `off` must produce byte-identical current behavior.
- Mode semantics: `shadow` = evaluate, log, never block; `enforce` = policy applies to `accepted` only (it can *downgrade or refuse an acceptance*, never auto-advance anything).
- The Jev call is a leaf module with one HTTP endpoint; no provider abstraction ("SemanticJudge" interface) — the brief's anti-abstraction-theatre rule applies and no second judge exists.
- Decision log record: `{runId, taskId, gate, questionId, criterionDigest, noul, thresholdBand, policyAction, model, mode, timestamp}`. No source payloads — digests only, mirroring existing controller practice.

## Explicit non-goals

- No Jev in the worker path, worker prompt, or worker packet.
- No Jev for any deterministic fact (tests, files, exit codes, counting).
- No spec generation, rewriting, or summarization by Jev (it cannot generate).
- No autonomous retry loops, no "did iteration reduce uncertainty" autonomy.
- No model routing/escalation inside TinySDD.
- No multi-provider judge abstraction, no SDK dependency, no new runtime deps beyond zero (plain `fetch`).
- No threshold invented without shadow calibration.
- If Jev disappears tomorrow: `mode: off` default, TinySDD fully functional, review flow unchanged.

## Risks

- **Calibration is the real risk.** Jev's Noul near 0.5 flips between repeats; a threshold at 0.6 on a genuinely borderline criterion produces nondeterministic gating. Mitigation: wide middle band routed to the operator (who already decides), thresholds derived from shadow Brier/ECE data, model version pinned in config and logged per decision.
- **Workflow thrashing.** An over-strict gate turns acceptance into revision ping-pong. Mitigation: the gate can only refuse `accepted`; it cannot force new iterations beyond the operator's existing revision path, and every refusal is logged with its probability for benchmark review.
- **False-accept cost > false-block cost.** A wrong `accepted` poisons the acceptance digest chain; a false block costs one operator glance. Thresholds must therefore be asymmetric (high accept bar), and the benchmark must report both error types separately.
- **Vendor dependency.** One module, one endpoint, config-level; removal is deleting the mode. Document the OpenRouter fallback endpoint (`/api/alpha/decisions`) as the escape hatch, but do not implement it until needed.
- **Latency in review.** One batched call per review (~sub-second class per jaggedness docs); acceptable in a human-in-the-loop step. Measure it in the benchmark anyway.

## Decision log

1. **One gate, not five.** Only the evidence-sufficiency gate addresses a real, uncovered, load-bearing decision in the actual TinySDD flow.
2. **Gate placement: `reviewTask()`.** It is the existing trust boundary where evidence meets acceptance; no new state machine needed.
3. **Noul per acceptance criterion, batched; no Score, no Choice.** Atomic judgments composed in deterministic policy — matches both the Jev mental model and TinySDD's strict-schema style.
4. **Enforce can only block `accepted`.** The gate never advances work on its own authority; it constrains the weakest existing trust point. "Jev judges, TinySDD decides" is preserved by construction.
5. **`off/shadow/enforce` modes, default off.** Shadow mode is the calibration instrument and the benchmark variant B for free.
6. **Plain `fetch`, zero deps, no SDK, no abstraction layer.** Matches repo philosophy; SDK adds nothing `fetch` doesn't.
7. **Spec-ambiguity gate deferred to shadow-only data collection.** Duplicates operator approval; decide with data, not now.
8. **Thresholds come from the benchmark, not this document.** Initial bands (≈0.75 accept / 0.40 refuse, middle = operator) are placeholders explicitly marked for calibration.
9. **Fallback behavior is off-behavior, not fail-closed.** A judge outage must not brick the workflow; it must be visible in the log.