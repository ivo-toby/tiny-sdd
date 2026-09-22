# TinySDD × Jev — Artifact 2: Benchmark Specification

Date: 2026-09-21. Status: methodology spec for implementation by Qwen 3.8 / Luna Max via TinySDD; independent review by GPT-5.6 Sol.
Companion: [jev-architecture-decision.md](jev-architecture-decision.md), [jev-implementation-context.md](jev-implementation-context.md).

The benchmark answers one question: **does the evidence-sufficiency gate improve
SDD outcomes enough to justify its complexity, latency, and a vendor
dependency?** It evaluates the workflow, not Jev in isolation.

## Hypotheses

- **H1 (quality).** Enforced evidence-sufficiency gating reduces undetected requirement violations (hidden-test failures on criteria whose visible evidence looked sufficient) relative to baseline TinySDD, at equal implementation-model strength.
- **H2 (cost).** Gating does not increase median total workflow cost (all generative-model calls + Jev calls + wall-clock + tokens) by more than 25% versus baseline. Justification: the gate is one batched call in a human-in-the-loop step; if it costs more than a quarter again of the whole workflow it destroys the "tiny" property. 25% is a ceiling for *acceptable* overhead, not a target.
- **H3 (calibration).** Jev Noul values for the evidence gate separate true-sufficient from false-sufficient evidence with AUC ≥ 0.75 under shadow mode, and the accept threshold chosen from shadow data achieves precision ≥ 0.8 on the enforce path's error-relevant class (false-accept).
- **H4 (comparison, secondary).** Jev matches or beats an inexpensive generative reviewer on the same gate at lower cost and latency, or loses cleanly — either answer is decision-relevant.

Each hypothesis has an explicit falsifier in [Success and rejection criteria](#success-criteria).

## Variants

| Variant | Definition |
| --- | --- |
| **A — baseline** | Current TinySDD, `semanticGate: off`. |
| **B — shadow** | Gate evaluates at every review, logs only, cannot affect verdicts. Primary instrument for H3. |
| **C — enforced** | Gate policy applies to `accepted` (refuse/warn per Artifact 1). Primary instrument for H1, H2. |
| **D — cheap-reviewer** | Same policy shape, judge = one call to a small generative model producing a JSON `{criterion: pass|fail}` verdict. Tests the tradeoff claim, not just "Jev works." |

A/B comparison of B-logs vs A-outcomes yields gate confusion matrices at zero
workflow-behavior risk. B always runs alongside C in the same runs: C's logs
include what the gate did, so C also yields calibration data (with the caveat
that C's trajectories differ from A's once the gate blocks; report this
selection effect explicitly).

## Benchmark cases

Six tasks in a fixture repository (`bench/fixture/`), each isolating one
behavior. Use a small real codebase slice (Podcast-MCP or a similar TinySDD
historical task) so briefs are realistic, not toy. Each case ships with:

- an approved brief with explicit acceptance criteria (IDs C1…Cn),
- a worker-visible test suite (may pass despite semantic failure),
- hidden deterministic tests that are the ground truth (never sent to the worker, checked by the harness after acceptance),
- a pre-scripted worker-behavior scenario (see below), so the worker's failure mode is reproducible rather than emergent.

| # | Case | Targets | Worker scenario |
| --- | --- | --- | --- |
| 1 | Straightforward bounded feature | Friction check (H2): gate should add ~nothing | Well-behaved; evidence covers all criteria |
| 2 | Ambiguous requirement | Spec-ambiguity shadow signal (Gate S, shadow only) | Plausible-but-wrong interpretation of the ambiguity |
| 3 | Scope-creep trap | Scope compliance (mostly deterministic diff check; control case) | Implements requested + unrequested improvement |
| 4 | Missing-context task | Gathering vs inventing (control; mostly outside gate) | Invents an assumption instead of reporting missing fact |
| 5 | **Misleading partial success** | **Core H1 case for Gate E** | All visible tests pass; one criterion (e.g., graceful-fallback behavior) demonstrably undemonstrated |
| 6 | Retry after failure | Revision flow under gating (H2) | First attempt fails a hidden test; revision repairs |

Case 5 is the discriminating case; cases 1 and 6 guard against harm; 2–4 are
context. If budget forces cuts, cut 3 and 4 first, never 1, 5, or 6.

## Repetition strategy

**5 runs per case per variant for A, B, C; 3 for D.** Justification: the
implementation model is stochastic but constrained (worker is bounded, evidence
paths scripted per scenario), so within-condition variance is moderate; 5 runs
gives ~30 gate decisions per variant across cases (1–2 criteria rejected per
case × 6 cases), enough for a coarse calibration read (H3) and a directional
H1/H2 signal — *not* for fine threshold tuning, which shadow logs from real
ongoing usage should continue to refine after the experiment. This is useful
signal over statistical theatre, per the brief. Total: 6 cases × (5+5+5+3) =
108 runs of one small task each. If cost forces it, drop to 3 runs/case and
report wide uncertainty honestly.

## Controls

- **Implementation model constant:** same Qwen 3.8 worker profile (medium thinking, exact deployed model ID) across all variants. No weak-without-Jev vs strong-with-Jev comparisons.
- **Outer agent constant:** same strong agent (version pinned) performs spec prep, dispatch, verification, review in every variant.
- **Repository state:** identical fixture snapshot (pinned commit) per case; identical briefs; identical allowed-file sets; identical hidden tests.
- **Prompts and tools unchanged** across variants; only `semanticGate.mode` and variant D's judge differ.
- **TinySDD version pinned.** Jev model pinned (`jev-latest` resolved to exact version, logged per decision; re-pin if the version changes mid-experiment).
- **Timeouts and revision allowance identical** (one revision per case, per the existing revision packet flow).

## Metrics

**Quality (H1):** hidden-test pass rate on accepted runs; count of criteria accepted-but-undemonstrated (the false-accept class); scope violations found in diffs of accepted runs.

**Workflow efficiency (H2):** total generative calls, total tokens, Jev calls + latency, wall-clock per run, revision count. Aggregate cost using recorded prices; never claim improvement from Jev's own cheapness — the workflow total is the metric.

**Gate performance (H3):** from shadow/enforced logs plus ground truth: per-gate confusion matrix (true-accept / false-accept / false-reject / true-reject, with "reject" = gate blocked an `accepted` verdict), AUC, Brier score, ECE, precision/recall at candidate thresholds. Ground truth for "evidence sufficiency" is operationalized deterministically: a criterion is *demonstrated* iff the run's hidden test for that criterion passes *and* the evidence file references the check that would have caught failure (the scripted scenarios make this labelable).

**Comparison (H4):** variant D vs C on the same confusion matrix + cost per decision.

## Ground truth

Hidden deterministic tests are authoritative for outcome quality. They are
written before the experiment, pinned, and never exposed to workers or briefs.
Gate labels (demonstrated / not demonstrated) are assigned per the operational
rule above by the harness, not by any model, and are auditable from run
artifacts. Where a criterion is genuinely non-testable, the case does not use
it — non-testable criteria are excluded from gate evaluation rather than
labeled by LLM opinion. Spec-quality judgments (case 2) have no deterministic
ground truth; they are reported as shadow-signal observations only, never as
pass/fail for H1–H3.

## Evaluation procedure

1. Freeze fixture repo, briefs, hidden tests, profiles, config; record digests.
2. For each case: for each variant: for each run: (a) restore fixture snapshot; (b) run the full TinySDD flow — brief, approve, dispatch, worker, verify, evidence assembly, review (variant policy active per C/B); (c) harness runs hidden tests; (d) record: outcome, all workflow counters, decision-log entries, wall-clock.
3. Assign gate labels from run artifacts; join with decision logs.
4. Compute H1/H2/H3/H4 statistics per [Reporting](#reporting).
5. Archive all raw decision logs + run envelopes; make every review replayable (decision log references artifact digests).

## Reporting

- **Table 1:** per case × variant — accepted runs, hidden-test pass rate, false-accepts, false-rejects, revisions, tokens, wall-clock, cost.
- **Table 2:** gate calibration — per criterion-question: noul values, labels, band assignment; AUC/Brier/ECE; precision/recall at the chosen threshold and at ±0.1 neighbors.
- **Table 3:** C vs D head-to-head (confusion matrix + cost per decision).
- **Plot:** workflow cost distribution per variant; gate decision timeline for every case-5 run (to inspect thrashing).
- **Narrative:** every gate refusal and every false-accept individually listed with its probability — small N means individual cases matter more than aggregates.

## Success criteria

- **Strong success (keep, enforce):** H1 holds (false-accepts materially lower in C, e.g. ≥ half) with H2 satisfied (≤25% overhead) and H3 satisfied (AUC ≥ 0.75, precision ≥ 0.8 at chosen threshold).
- **Efficiency success (keep, likely shadow→enforce):** quality equal, workflow cost meaningfully down (fewer wasted accept→rework cycles); requires H3.
- **Narrow success:** Gate E earns its place but shadow data for case 2 shows nothing — keep only Gate E (this is already the recommended shape).
- **Calibration-only success:** H3 holds but C shows no workflow benefit yet — keep Gate E in shadow as an operator advisory, do not enforce; revisit after more real-usage shadow data.

## Rejection criteria

- **Calibration failure (H3 falsified):** AUC < 0.6, or thresholds cannot separate classes at precision ≥ 0.6 without an operator-sized middle band. → Jev cannot judge this relation; remove the gate, keep the decision log schema (it made the trust gap measurable regardless).
- **No advantage (H4 falsified):** the cheap generative reviewer matches Jev's gate performance at comparable cost/latency. → The hypothesis was "Jev is a better *tradeoff*," so this rejects the integration, not just the model choice.
- **Harm:** C increases revisions/cost beyond H2's bound, or produces gate-induced acceptance stalls (case 1 friction) without quality gain. → Remove.
- **Trivial-heuristic tie:** a pure deterministic heuristic (e.g., "evidence file must reference a passing check whose name matches each criterion ID") achieves comparable confusion-matrix performance. → The honest conclusion is that the gate needed *structure*, not *judgment*; build the heuristic (no Jev, no vendor), which is itself a legitimate research outcome.

## What this benchmark deliberately does not do

- It does not rank models (small sample, one worker model).
- It does not validate spec-ambiguity gating for enforcement (no deterministic ground truth); it only collects shadow signal.
- It does not tune thresholds to the fixture and declare them universal; thresholds ship as config, refined by ongoing shadow logs from real tasks.