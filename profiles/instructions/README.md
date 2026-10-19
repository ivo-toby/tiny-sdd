# Shareable model instruction profiles

This directory is a manually curated library of model-specific `profile.instructions`
variants. It has no catalog or automatic routing. An entry is shareable only after
an operator has reviewed the exact model, serving configuration, role, runtime
settings and A/B evidence that the entry names.

Do not add an entry for an unrun idea as if it were a result. A hypothesis may be
recorded as `proposed`, with `evidence: null` in its card, but it cannot recommend
the candidate as an improvement. Real model entries should be added after the
controlled discovery/control work described in [instruction experiments](../../docs/instruction-experiments.md).

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
built-in harness and does not replace it.

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
  result; recommendation is `gather-more`.

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
Completed cards require independent verification references and a reviewer who
vouches that the profile bytes match the recorded hashes and that the source and
evidence were checked. The card must not contain raw prompts, traces, credentials,
benchmark directories, private controls or held-out answers. Link to retained
artifacts by digest instead.

## Contributing an entry

Use a manual pull request. Before opening it:

1. Run the controlled A/B workflow with explicit discovery and control
   partitions, repetitions, criteria, model identity and effective settings.
2. Copy only the intentionally shareable baseline/candidate instruction text and
   the digest-bound evidence card into the entry directory. Keep raw prompts,
   traces, private controls and held-out material local to the experiment.
3. Validate the card with a JSON Schema 2020-12 validator and run the repository's
   documentation diff checks. No catalog or index is updated by this scaffold.
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

Copy or reference the selected profile through the existing worker's
`worker.profile` setting. For a project-local entry this is a project-relative
path, for example:

```json
{
  "workers": {
    "qwen": {
      "profile": "profiles/instructions/model/config/implement-slice/v1/candidate-profile.json"
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
