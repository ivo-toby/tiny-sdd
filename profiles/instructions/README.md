# Shareable model instruction profiles

This directory is a manually curated library of model-specific `profile.instructions`
variants. It has no catalog or automatic routing. An entry is shareable only after
manual review of its provenance and profile metadata. Proposed entries are
explicitly untested hypotheses. A tested recommendation requires independent
review of the exact model, serving configuration, role, runtime settings and
completed A/B evidence that it names; primary review or an inconclusive card is
not operator acceptance. Profile selection remains explicit and operator-owned.

Do not add an entry for an unrun idea as if it were a result. A hypothesis may be
recorded as `proposed`, with `evidence: null` in its card, before controlled A/B
work is complete. A tested result requires the controlled discovery/control work
described in [instruction experiments](../../docs/instruction-experiments.md),
independent review and the completed-card requirements below.

## Library entries

The library currently contains 14 evidence cards and 28 runtime profiles. Seven
proposal cards remain, including historical versions; four current model entries
await results. The qwen36, north, swift, qwenpi, thinkingcap and qwen38q3 rows
record completed exploratory pilots with inconclusive strict-control applicability;
their cards retain the measured reports and review boundaries below.

| Model | Role | Hypothesis | State |
| --- | --- | --- | --- |
| [qwen36](qwen36/titan-llamacpp-qwen3_6-35b-a3b-256k/implement-slice/v2/evidence-card.json) | implement-slice | Separate presence from payload, preserving nullish and falsy values. | inconclusive |
| [north](north/titan-llamacpp-north-mini-code-128k/implement-slice/v2/evidence-card.json) | implement-slice | Separate presence from payload, preserving nullish and falsy values. | inconclusive |
| [swift](swift/titan-llamacpp-swift15-q4km-128k/implement-slice/v2/evidence-card.json) | implement-slice | Separate presence from payload, preserving nullish and falsy values. | inconclusive |
| [qwen38q4s](qwen38q4s/titan-llamacpp-qwen3_8-q4s-128k/implement-slice/v1/evidence-card.json) | implement-slice | Separate presence from payload, preserving nullish and falsy values. | proposed |
| [muse](muse/titan-llamacpp-muse-glimmer-128k/implement-slice/v1/evidence-card.json) | implement-slice | Separate presence from payload, preserving nullish and falsy values. | proposed |
| [gemma26](gemma26/titan-llamacpp-gemma4-26b-a4b-128k/implement-slice/v1/evidence-card.json) | implement-slice | Finish after declared checks pass instead of re-deriving the solution. | proposed |
| [gemma12](gemma12/titan-llamacpp-gemma4-12b-128k/implement-slice/v1/evidence-card.json) | implement-slice | Use a brief action/check loop and stop guessing after an exact-text edit fails. | proposed |
| [qwenpi](qwenpi/titan-llamacpp-qwen3_8-pi-q4km-128k/write-tests/v2/evidence-card.json) | write-tests | Choose counterexamples that distinguish each contract invariant from plausible wrong behavior. | inconclusive |
| [thinkingcap](thinkingcap/titan-llamacpp-thinkingcap-q4km-128k/write-tests/v1/evidence-card.json) | write-tests | Choose counterexamples that distinguish each contract invariant from plausible wrong behavior. | inconclusive |
| [qwen38q3](qwen38q3/titan-llamacpp-qwen3_8-q3-128k/write-tests/v1/evidence-card.json) | write-tests | Choose counterexamples that distinguish each contract invariant from plausible wrong behavior. | inconclusive |

Qwen36 history: [v2 recovery-1](qwen36/titan-llamacpp-qwen3_6-35b-a3b-256k/implement-slice/v2/evidence-card.json) is the latest reviewed entry; [v1 proposal](qwen36/titan-llamacpp-qwen3_6-35b-a3b-256k/implement-slice/v1/evidence-card.json) remains immutable. The v2 pilot measured no quality gain on either partition: all four Ember A/B patches retained the nullish fallback. Its two historical worker-visible Ember tests and prior control-source exposure are disclosed, so the result is exploratory rather than strict blinded transfer validation.

QwenPi history: [v2 blind3](qwenpi/titan-llamacpp-qwen3_8-pi-q4km-128k/write-tests/v2/evidence-card.json) is the latest reviewed entry; [v1 recovery-1](qwenpi/titan-llamacpp-qwen3_8-pi-q4km-128k/write-tests/v1/evidence-card.json) remains immutable. The v2 card preserves raw `0/4` control-wrapper outcomes separately from its unavailable semantic control comparison, so wrapper failures are not scored as semantic quality failures. Follow-up checker repair and validation is tracked in [#140](https://github.com/ivo-toby/tiny-sdd/issues/140).

North history: [v2 recovered pilot](north/titan-llamacpp-north-mini-code-128k/implement-slice/v2/evidence-card.json) is the latest reviewed entry; [v1 proposal](north/titan-llamacpp-north-mini-code-128k/implement-slice/v1/evidence-card.json) remains immutable. The raw comparison state is `regressed` with recommendation `keep A`; the published card is `inconclusive` with `gather-more` because prior control exposure makes this an exploratory comparison. The baseline is retained. Finite oracle coverage follow-ups are tracked in [#145](https://github.com/ivo-toby/tiny-sdd/issues/145) and [#141](https://github.com/ivo-toby/tiny-sdd/issues/141).

Swift history: [v2 exploratory pilot](swift/titan-llamacpp-swift15-q4km-128k/implement-slice/v2/evidence-card.json) is the latest reviewed entry; [v1 proposal](swift/titan-llamacpp-swift15-q4km-128k/implement-slice/v1/evidence-card.json) remains immutable. The raw comparison improved recorded discovery quality from 2/4 to 4/4 and aggregate quality from 12/14 to 14/14, while both control partitions were already 10/10, so the predeclared control-gain criterion was not met; the raw state remains `no-improvement` with recommendation `keep A`, and the baseline is retained. The published card is `inconclusive` with `gather-more` because prior control-source exposure prevents a strict blinded transfer claim. A corrected posthoc probe found a valid array-backed-store contract gap; oracle coverage and fresh independent controls are tracked in [#146](https://github.com/ivo-toby/tiny-sdd/issues/146) and [#126](https://github.com/ivo-toby/tiny-sdd/issues/126).

## Entry layout

Use one directory for one exact identity:

```text
profiles/instructions/<model-key>/<configuration-key>/<role>/v<version>/
  baseline-profile.json
  candidate-profile.json       # optional for a proposed entry
  evidence-card.json
```

`<model-key>` and `<configuration-key>` are stable, path-safe encodings of the
exact values recorded in the card. They must not silently combine model versions,
quantizations, servers, thinking settings or token limits. The card remains the
source of the unencoded identity and contains the SHA-256 reference for every
profile, settings report, suite and source record. Keep version changes in a new
directory; do not replace an earlier entry in place.

`baseline-profile.json` is required. A completed comparison also requires
`candidate-profile.json`. Both are ordinary worker profile documents. Keep their
top-level shape to the existing runtime profile fields:

```json
{
  "schemaVersion": 1,
  "id": "exact-profile-id",
  "runtime": {},
  "instructions": "Shareable instruction text"
}
```

Use the runtime fields supported by the current worker profile schema. Do not put
evidence-card metadata, state, hashes or review notes into these profile files.
The instruction text is the deliberately selected public content. The worker
appends it to the built-in system prompt; selecting a profile preserves the
built-in harness and does not replace it. Empty baseline instructions require
the profile validation fix from #135 (present on the current main branch).

`evidence-card.json` must validate against the local
[evidence-card schema](./evidence-card.schema.json). It records the exact
before/after instruction hashes, not the instruction text. Profile, settings,
source and suite references contain a project-relative path and a lowercase
SHA-256 digest. Hash the exact UTF-8 `instructions` string for
`promptHashes.before` and `promptHashes.after`; do not hash a reformatted copy or
silently normalize whitespace.

The card uses exactly these states:

- `proposed`: a hypothesis awaiting a controlled experiment; `evidence` may be
  `null`, and the recommendation is `keep-baseline` or `gather-more`.
- `tested-improved`: both discovery and control partitions have complete,
  independently checked A/B evidence that meets the predeclared criteria;
  recommendation is `consider-candidate` for the recorded configuration.
- `no-improvement`: the completed comparison does not meet the improvement
  criterion; recommendation is `keep-baseline`.
- `regressed`: the comparison exceeds the declared regression budget or has a
  measured regression; recommendation is `keep-baseline`.
- `inconclusive`: missing, unavailable or conflicting evidence prevents a safe
  result; record the missing-data reason and use `gather-more`. Independent
  verification may be `unverified` or `UNKNOWN` when the evidence was not
  independently checked.

Every completed card retains discovery and control partition summaries with
scheduled, complete and missing pairs, A/B counts, gains, regressions,
repetitions and explicit missing-data reasons. Reviewers must check the arithmetic
(`complete + missing = scheduled`, A/B totals and partition assignments) because
JSON Schema cannot prove those relationships. Use `UNKNOWN` for unavailable
metadata or measurements; never write zero to mean unknown. A disabled setting
may use the schema's explicit `null` where applicable.

The `synthetic` flag is mandatory. Synthetic cards are harness evidence only and
may be `proposed` or `inconclusive`; they never establish model effectiveness or
become `tested-improved`, `no-improvement` or `regressed` recommendations.
Cards claiming a tested result require independent verification references and a
reviewer who vouches that the profile bytes match the recorded hashes and that
the source and evidence were checked. An `inconclusive` card records only the
byte/source checks that actually happened and keeps unavailable verification as
`unverified` or `UNKNOWN`; do not fabricate a verified result. The card must not
contain raw prompts, traces, credentials, benchmark directories, private controls
or held-out answers. Link to retained artifacts by digest instead.

The published profiles and evidence exports are audit summaries, not a
self-contained replay package. Exact replay requires access to the frozen inputs,
including retained private held-out controls and raw artifacts, plus a matching
runtime and model. Community reproduction on new controls is a new experiment;
it does not inherit this evidence.

## Contributing an entry

Use a manual pull request. Before opening it:

1. For a `proposed` entry, record the hypothesis and exact prepared identity;
   finished A/B work is not required. For a tested state, run the controlled A/B
   workflow with explicit discovery and control partitions, repetitions,
   criteria, model identity and effective settings.
2. Copy only the intentionally shareable baseline/candidate instruction text and
   the digest-bound evidence card into the entry directory. Keep raw prompts,
   traces, private controls and held-out material local to the experiment.
3. Validate the card with a JSON Schema 2020-12 validator and run the repository's
   documentation diff checks. Update the manual table deliberately when entries
   change; there is no automatic catalog or routing.
4. Ask an independent reviewer to check the exact profile bytes, every referenced
   digest, the source/suite/settings identity, role applicability, missing-data
   accounting and limitations. The reviewer records references in the card.
5. In the pull request, explain the tested configuration, why the baseline is
   retained or the candidate is considered, and how to roll back. Do not claim a
   universal prompt or silently generalize across serving configurations.

## Selecting and rolling back

Selection is explicit and operator-owned. Read the card before selecting a
candidate and require an exact match for model ID/version, quantization, server,
requested thinking, token/context limits, suite/source identity and worker role.
`tested-improved` applies only to that recorded configuration. A different
quantization, server, context limit or thinking setting requires a new experiment;
it does not inherit the recommendation.

After reviewing the card and matching its recorded profile SHA-256, copy the
selected runtime-profile JSON from this library into a fresh path in the target
project, such as `preparation-profiles/qwen36-v1.json`. Profile paths resolve
against the target project; the library path is documentation source material
and is not installed automatically. Set that copied profile on an existing
fully configured worker's `worker.profile` setting. Configuration overlays
replace a worker as a whole, so retain its `type`, `provider` and `model`. For
example:

```json
{
  "workers": {
    "qwen": {
      "type": "pi",
      "provider": "litellm",
      "model": "titan/llamacpp/qwen3.6-35b-a3b-256k",
      "profile": "preparation-profiles/qwen36-v1.json"
    }
  }
}
```

Then inspect the resolved profile and settings before any live run:

```sh
tinysdd config show --worker qwen --json
tinysdd worker settings --worker qwen --entry-kind real --json
```

Use the [CLI workflow reference](../../skills/tinysdd/references/cli-workflow.md)
and [experiment guide](../../docs/instruction-experiments.md) for the exact
confirmation and benchmark commands. To roll back, select the baseline profile
or the preceding reviewed version explicitly, recheck its settings digest, and
rerun the required offline or live checks. No profile is installed, activated,
promoted or routed automatically.
