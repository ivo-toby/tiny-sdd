# Instruction experiments (#108)

This is an explicit, local evidence → hypothesis → paired experiment → reviewed
profile workflow. It reuses the benchmark runner and its result schema. It does
not call an analysis model, change qualification targets, approve tasks, or accept
features. Real-model effectiveness remains unverified until an operator authorizes
and runs a live discovery/control experiment.

The first implementation varies exactly one field: the existing worker profile's
`instructions` string. The same brief, context, fixture, visible tests, held-out
verifiers, runtime settings and limits are used for both arms. This supports
hypotheses about detail, structure, interfaces/callers, edge cases, context
selection and integration guidance while retaining existing task formats. It does
not yet compare different task decompositions or generated context packets.

## Discovery and proposals

First declare every challenge's `partition` (`discovery` or `control`) and
`lineage`. Related features and revisions must share one lineage and partition.
The tool rejects lineages that cross partitions; the analyst remains responsible
for identifying related features and reporting prior exposure accurately.

Use `bench instructions analyze --request analysis-request.json --out analysis.json`.
The request contains:

- `suite`: project-relative benchmark suite JSON path;
- `results`: retained benchmark invocation paths;
- `partitions`: `[{"challengeId":"...","lineage":"...","partition":"discovery"}, ...]`;
- `preparation`: `UNKNOWN` or `{model, usage, evidence}`. Usage is `UNKNOWN` or
  `{inputTokens, outputTokens, reasoningTokens, elapsedMs}` with measured integers
  or `UNKNOWN`; evidence is `UNKNOWN` or `{path, sha256}`;
- `exposureAttestation`: how discovery/control separation was maintained;
- `proposals`: an array; it may be empty for the initial evidence export.

Each proposal has `id`, exact `configDigest`, `role`, `category`, `observation`,
`hypothesis`, `before`, `after`, `expectedEffect`, `evidence`, and `experimentPlan`.
The categories are `length-detail`, `structure`, `interfaces-callers`, `edge-cases`,
`context-selection`, and `integration`. `before` must exactly match the baseline
profile instructions; `after` is one bounded replacement (maximum 8192 characters).
`evidence` contains `{path, sha256}` references to discovery case-result files,
which the initial analysis export provides.

The analyzer exports discovery prompts, patches, visible verifier logs, verifier
statuses and configuration identities, grouped by exact configuration and role.
It does not export hidden logs, hidden verifier source, control prompts, control
patches, or control answers. Feed **only this export** to the preparation agent;
do not give it the suite/results directories or a completed control report. A
subsequent hypothesis trained on control results requires a new untouched control
partition. This data boundary is not a sandbox for an analyst with wider access.

The strong agent supplies the diagnosis and exact before/after change. The tool
does not invent advice from check names. A proposal needs at least two distinct
independently checked failure observations in its evidence references; setup-only,
sparse or conflicting cited evidence produces `inconclusive`. All discovery
observations remain visible in the report, including successes, for the analyst
to assess selection bias. This minimum permits testing a hypothesis; it does not
establish that instructions caused the failures.

## Freeze and run

`bench instructions plan --request plan-request.json --out instruction-runs/pilot-1 --worker NAME`
freezes the suite bytes, both runtime profiles, exact identities and schedule.
The output directory must be new and outside the source suite. A baseline profile
must be selected explicitly through the existing worker configuration. Its current
configuration must match the proposal's discovery evidence.

The plan request contains `id`, `analysis: {path, sha256}`, `proposalId`,
`repetitions` (2–1000), `criteria`, `confounds` (explicit string array),
`preparation` (same accounting shape as above), and `exposureAttestation`.
Optionally declare `integrationChecks`, mapping each challenge id to explicit
`[{"visibility":"heldOut","checkId":"integration"}]` check selections. Each must
exist in that challenge's verifier roster. Unmapped integration is `UNKNOWN`;
check names are never guessed to mean integration coverage.
Choose criteria **before** execution:

```json
{
  "minPairsPerPartition": 20,
  "minQualityGain": 0.1,
  "maxRegressions": 0,
  "rationale": "Example only; select a sample size and tolerated regressions for this pilot."
}
```

These are experimental reporting criteria, not qualification or acceptance
thresholds. The example is not a recommendation. Repeated attempts on one task
are correlated: increase independent lineages as well as repetitions. Unknown
model/server metadata remains `UNKNOWN` in the frozen identity and must be
disclosed as a confound; equal unknown values cannot prove equal hidden settings.

The effective-settings acknowledgement integration is tracked in #109: live
benchmark entry must display and confirm each arm's actual thinking/token settings.
This #108 increment freezes those settings but does not itself implement that
acknowledgement API. Live use requires the #109 integration as well as explicit
operator authorization; the offline synthetic example remains runnable.

After that integration and explicit authorization for live inference:

```sh
node bin/tinysdd.mjs --project /absolute/project bench instructions run \
  --plan instruction-runs/pilot-1/plan.json --worker NAME
node bin/tinysdd.mjs --json --project /absolute/project bench instructions report \
  --plan instruction-runs/pilot-1/plan.json --out instruction-runs/pilot-1-report.json
```

The runner executes the full suite once per arm/repetition in AB, BA, AB, BA
order. Task order within an invocation stays fixed and is a remaining confound.
Each invocation starts fresh fixtures. Plan/suite/profile/runtime drift stops
further execution and retains the failed slot plus unrun slots. Case-level
failures continue to be retained by the existing benchmark runner. Interrupted
runs can be reported with missing pairs; rerunning the same output is refused.
Create a new plan/output deliberately rather than overwriting history. Exploratory
invocations are not added to the project's qualification evidence index.

## Interpretation and reusable guidance

Reports retain every paired outcome and report absolute A/B counts, denominators,
paired gains/regressions and missing pairs separately for discovery and control.
Success uses the existing independent visible + held-out checks and hard gates;
it never trusts a worker's success claim. Integration is reported separately
from the explicitly selected checks, with its own denominators and unknowns.
Coverage is the declared suite's responsibility: use checks that enter through
real callers.

`tested-improved` requires both partitions to meet the predeclared minimum/gain
and regression criteria without missing quality observations. A regression beyond
the declared limit takes precedence. `maxRegressions` counts distinct pairs
with either correctness or explicit integration loss, including integration loss
when correctness was already failing; overlapping losses count once. Reports
retain both component counts and the combined `regressionPairs` count. Reports recommend **consider B for the tested
configuration**, **keep A**, or **gather more evidence**. Speed/token differences
never choose the winner. Uncertainty is descriptive: per-lineage paired effects
and missingness, with no confidence interval or population-effectiveness claim.
Repair rounds are `UNKNOWN` because the runner does not measure semantic repair
cycles. Elapsed time and cumulative usage are reported only where observed;
preparation/review overhead is separate and never silently treated as zero. The
current worker schema does not count requests missing usage metadata; multi-message
cumulative totals are therefore conservatively `UNKNOWN`.

`bench instructions profile --request profile-request.json --out preparation-profiles/caller-v1.json`
creates a reviewed guidance record without changing any config. Its request is:

```json
{
  "id": "caller-guidance",
  "version": 1,
  "plan": {"path": "instruction-runs/pilot-1/plan.json", "sha256": "EXACT_PLAN_SHA256"},
  "arm": "B",
  "review": {
    "by": "reviewer",
    "reason": "Explain the limited applicability and observed regressions.",
    "evidence": {"path": "reviews/pilot-1.md", "sha256": "EXACT_REVIEW_SHA256"}
  },
  "previous": null
}
```

Before a run starts, the reviewed profile state is `proposed`. After a run,
the state comes from its report, including unsuccessful/inconclusive outcomes;
a review does not turn a null or synthetic result into effectiveness evidence.
Select the exact profile path/digest deliberately in preparation. Check its target
configuration, state, evidence and review. Record the selected guidance as a
preparation input using existing task registration. Apply its `runtimeProfile`
through deliberate worker profile selection, preserving the tested instruction
placement. Rewriting briefs/context from the guidance is a different untested
intervention. Do not copy its embedded
control report or hidden evidence into a worker prompt. A later version requires
`previous: {path, sha256}` referencing the preceding version. Revert by selecting
the earlier version or baseline A. No automatic installation, promotion or
historical rewrite occurs.

Run `node scripts/run-instruction-example.mjs --out /absolute/new-directory`
to retain a complete synthetic example, including exact requests, prompts,
patches, independently executed verifier logs, plan, report and reviewed profile.
The script refuses an existing directory and uses only the offline fake runtime.
See `tests/helpers/instruction-experiment-fixture.mjs` for the fixture contract. The fixture intentionally uses
a deterministic fake worker; independent Node checks validate the public caller
on separate greeting and checkout lineages. This proves harness behavior, not a
model preference. A real model discovery/control experiment remains required to
complete #108.
