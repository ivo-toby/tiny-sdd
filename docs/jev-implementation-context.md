# TinySDD Jev Integration — Implementation Context

For: Qwen 3.8 / Luna Max, implementing via TinySDD itself. Independent review after by GPT-5.6 Sol.
Do not re-research Jev. Decisions below are settled; see [jev-architecture-decision.md](jev-architecture-decision.md) and [jev-benchmark-spec.md](jev-benchmark-spec.md) if something seems inconsistent with them (prefer them).

## Goal

Implement one semantic gate — **evidence sufficiency at task review** — plus the
benchmark harness to validate it. Nothing else.

## Selected experiment

Gate E only: when `tinysdd task review` records an `accepted` verdict, evaluate
one batched Jev call (one Noul per acceptance criterion from the approved brief,
over a curated evidence summary) and apply deterministic policy. Modes:
`off` (default, current behavior), `shadow` (log only), `enforce` (policy can
block an `accepted` verdict).

## Hypothesis

Jev Noul values separate demonstrated from undemonstrated evidence (AUC ≥ 0.75
in shadow mode), and enforcing the gate reduces accepted-but-undemonstrated
criteria without adding >25% workflow overhead. Full methodology and
falsifiers: [jev-benchmark-spec.md](jev-benchmark-spec.md).

## Non-goals

No Jev in the worker path. No Jev for deterministic facts. No spec rewriting,
retry autonomy, model routing, provider abstraction, or SDK dependency. No
spec-ambiguity enforcement (shadow logging hook only, optional, see below).

## Existing architecture anchors

- `src/controller.mjs` → `reviewTask(projectRoot, options)`: validates `verdict ∈ {accepted, revision, blocked}`, reads evidence file, records `review {verdict, by, reviewedAt, evidence, evidenceDigest, briefDigest, approvalDigest, allowedDigest}` and `acceptanceDigest`. **Insertion point**: consult the gate before writing the review, only when `verdict === 'accepted'` and mode is `enforce` (evaluate in both `shadow` and `enforce`).
- `src/controller.mjs` → `layout()` → `.tinysdd/runs/` is the state directory; decision logs go to `.tinysdd/runs/decisions/` (create on demand, JSONL, one file per run id).
- `src/config.mjs` → `validateConfigDocument` uses `assertExactKeys(['schemaVersion', 'defaultWorker', 'workers'])` and `CONFIG_SCHEMA_VERSION = 1`. Add optional top-level `semanticGate` key (see Configuration); old configs without it must keep validating unchanged.
- `src/context-compiler.mjs` → brief structure and manifest precedent: strict schemas, digests, fail-don't-truncate.
- `bin/tinysdd.mjs` → CLI arg parsing and `--json` envelope; `task review` currently takes `--id --verdict --evidence --by`.
- Tests: `tests/controller.test.mjs`, `tests/config.test.mjs` — add cases mirroring existing style (temp project fixtures, `TINYSDD_TMPDIR`).
- Benchmark harness: `bench/` (new) per benchmark spec; fixture snapshots pinned by commit.

## Proposed architecture

```text
src/jev.mjs              state builder + HTTP client (plain fetch, no deps)
src/semantic-policy.mjs  noul values + thresholds → {action, band} + JSONL logging
src/controller.mjs       reviewTask() calls policy; bin/tinysdd.mjs passes config
```

`src/jev.mjs` responsibilities:
1. `buildEvidenceState(task)`: `{task: {id, briefExcerpt}, criteria: [{id, text}], evidence: {summary}}`. Criteria = acceptance criteria extracted from the approved brief (see Open Questions Q1). Evidence = caller-curated summary (see Q2). Keep state lean; Jev degrades on large irrelevant state. No source code in state.
2. Questions: one Noul per criterion, `instructions` positive-phrased: "Does this evidence demonstrate that: `<criterion text>`?" with `criteria: {true: 'The evidence contains a concrete check or observation that would fail if this were untrue', false: 'The evidence does not address this or only asserts completion'}`. Ids `C1`…`Cn`; the model never sees ids, answers return under them.
3. `POST https://api.typesafe.ai/v1/systemone`, body `{model, state, questions}`, `Authorization: Bearer $TYPESAFE_API_KEY`. Timeout (reuse controller timeout defaults), one retry on 5xx/429 with backoff, then `judgeUnavailable`.
4. Response: `{answers: {C1: {noul}, …}}`.

`src/semantic-policy.mjs`:
- Bands from config thresholds: `noul >= acceptThreshold` → `allow`; `noul < rejectThreshold` (on any criterion) → `block`; between → `confirm` (warn). Initial placeholders: accept 0.75, reject 0.40 — **explicitly placeholders**, calibrated by benchmark shadow data before enforcement is used for real.
- `enforce`: `block` → refuse the `accepted` verdict with a typed error `SEMANTIC_GATE_REJECTED` listing criterion ids and noul values; `confirm` → record warning in the review object. The gate may only *block an acceptance*; it never advances, never rewrites, never auto-revises.
- `shadow`: identical evaluation, never blocks; `workflowAction: "ignored-shadow"`.
- Unavailable judge: behave exactly as `off`, append `semantic-judge-unavailable` record to the decision log. Never fail the review because Jev is down.
- Decision log record (JSONL, digests only, no source payloads): `{timestamp, taskId, runId?, gate: "evidence-sufficiency", mode, model, modelVersion, questionId, criterionDigest, noul, band, policyAction}`.

## Jev gates to implement

### Gate 1: Evidence sufficiency (the only one)

- **State:** task id, verbatim acceptance-criterion texts, evidence summary (test names + outcomes + checks run).
- **Atomic questions:** one Noul per criterion as above. No Score, no Choice, no multi-part questions (two conditions = two Nouls).
- **Primitive:** Noul, batched, one call per review.
- **Policy:** `allow ≥ 0.75 / block < 0.40 / else confirm-warn` (placeholders; calibrate from shadow data).
- **Shadow behavior:** log only.
- **Enforced behavior:** blocks `accepted` when any criterion is below reject threshold; confirms warn otherwise.
- **Fallback:** judge unavailable → off-behavior + log; never fail-closed.

## Deterministic boundaries

Untouched and must stay untouched: test/lint/exit-code/file-existence
verification, dependency ordering, digest chains, approval freshness, worker
isolation, revision evidence staleness (`STALE_REVIEW_EVIDENCE`), operator
attribution. The gate reads what already exists (brief + evidence file) and
only constrains `verdict === 'accepted'`. `mode: off` must produce behavior
identical to today (verify with the existing 44-test suite unchanged and green).

## Configuration

Add optional top-level key to the existing config document (keep
`CONFIG_SCHEMA_VERSION = 1`; optional key with validated shape):

```json
"semanticGate": {
  "mode": "off|shadow|enforce",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest",
  "thresholds": { "accept": 0.75, "reject": 0.40 }
}
```

Absent key ⇒ `off`. Validate: `mode` enum, endpoint URL, thresholds in (0,1) with reject < accept. API key from `TYPESAFE_API_KEY` env only — never stored in config. CLI: no new flags required for review (config-driven); optional `--json` surface of gate results on review for the harness.

## Observability

Decision JSONL under `.tinysdd/runs/decisions/<taskId>.jsonl`. Include the fields
listed above plus `artifactDigests` (evidence digest, brief digest) so benchmark
runs replay. Log band decisions even in `off`-adjacent paths only when mode is
shadow/enforce. Do not log state payloads.

## Benchmark harness

`bench/` implements [jev-benchmark-spec.md](jev-benchmark-spec.md): fixture repo + 6 scripted cases (case 5 is the discriminating one), hidden tests per case, variant runner (A/B/C, D optional), decision-log join + label assignment, report generator producing the three tables. The harness calls the controller API; it is a separate entry point (`bench/run.mjs`), not CLI surface.

## Required fixtures

- `bench/fixture/`: small project snapshot with per-case briefs carrying explicit criteria C1…Cn, worker-visible tests, hidden tests (deterministic, pinned).
- Per-case worker scenario scripts (well-behaved / partial-success / etc.) so runs are reproducible.
- Profile: existing medium-thinking Qwen 3.8 profile, exact model ID pinned.

## Acceptance criteria

1. All 44 existing tests pass unchanged with `semanticGate` absent (off).
2. New tests: config validation (absent/invalid key), policy bands, shadow never blocks, enforce blocks below reject threshold, judge-unavailable → off-behavior + log, decision JSONL schema.
3. `task review` in enforce mode with a stubbed judge (injectible fetch) demonstrates: block → `SEMANTIC_GATE_REJECTED`, allow → `accepted` recorded with gate record, confirm → warning in review.
4. Bench harness produces Table 1/2/3 from a recorded run set without manual steps.
5. No new runtime dependencies; Node 24; `npm test` green.

## Explicitly deferred

Spec-ambiguity gate enforcement; OpenRouter fallback endpoint; multiple judge
providers; threshold auto-tuning from logs; worker-side gate; revision-quality
gate; model routing.

## Decisions already made

One gate only; placement in `reviewTask()`; Noul-per-criterion batched; enforce
blocks only `accepted`; off/shadow/enforce with default off; plain fetch, zero
deps; thresholds from benchmark, not hardcoded truths; off-behavior fallback;
no SDK, no abstraction layer; decision log digests only.

## Open implementation questions

1. **Criterion extraction:** are acceptance criteria already structurally identifiable in the brief (IDs like C1/REQ-4, or a checklist section)? If not, extend the brief template minimally (a `## Acceptance criteria` section with stable IDs) — this is a contract change operators must know about. Decide from the actual brief format in the fixture repo.
2. **Evidence summary format:** define the exact evidence-file section the gate reads (e.g., a required `## Checks` list of `name: pass|fail` lines) so the caller's curation is checkable rather than free prose. Keep backward compatible: absence of the section ⇒ gate emits `confirm` (warn), not `block`.
3. **Config schema:** confirm adding optional `semanticGate` to `validateConfigDocument`'s `assertExactKeys` doesn't invalidate existing project configs in tests; if cleaner, bump schema version with an explicit migration note — prefer not to.
4. **Where the gate is invoked in `reviewTask()`** so that `mutateState` isn't held open during the HTTP call (fetch first, then mutate; decide against calling inside the state mutation callback).
5. **`publicTask()` surface:** whether review objects should expose `gate: {mode, decisions: [...] }` digests in `--json` output for the harness, or whether the harness reads the JSONL directly (prefer the latter; smaller API).