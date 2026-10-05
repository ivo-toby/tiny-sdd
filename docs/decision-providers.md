# Offline decision provider observations

Issue #40 adds a small provider boundary around the offline decision-evaluation
artifacts. It is an observation surface, not a policy engine: the default mode
is `shadow`, `off` never calls a provider, and `enforce` is refused until the
operator has reviewed real #32 comparisons and chosen a workflow mapping.

## Provider boundary

`observeDecision()` accepts a label-blind state projection, one typed question,
a caller-supplied provider and a requested mode. A case is projected through
`decisionCaseInput()` before it reaches a provider, so `expected`, reviewer
metadata and label evidence are not present in the provider input. The state,
question and provider metadata passed to the implementation are bounded,
detached and frozen. The observation keeps the validated provider identity even
if an implementation attempts to mutate its callback metadata.

Questions are versioned and have one of these shapes:

```json
{ "schemaVersion": 1, "id": "failure-triage", "type": "choice",
  "choices": ["environment", "missing-context", "fixable-from-log", "unknown"] }
```

```json
{ "schemaVersion": 1, "id": "relevance", "type": "score",
  "minimum": 0, "maximum": 1 }
```

```json
{ "schemaVersion": 1, "id": "review-confidence", "type": "noul" }
```

Provider identity contains `id`, a configuration SHA-256 digest, model
`id`/`version`, and explicit availability. Missing model metadata, calibration
evidence and thresholds are `UNKNOWN`; no probability is called calibrated by
this module. A response must match the supplied input and provider identity,
match the question type and bounds, and contain only finite probabilities in
`[0,1]`. Invalid, unavailable or missing providers produce one effective-off
observation with a bounded reason and no alternate provider or model call.

Successful shadow observations retain input and question digests, provider and
model identity, returned values and probabilities, and measured values supplied
by the provider. They always carry `band: "UNKNOWN"` and
`action: "no-enforcement"`. A replay timestamp is bookkeeping time, never an
inference-latency measurement.

## Replaying saved predictions

The standalone command replays saved #32 predictions without calling a model:

```sh
node scripts/observe-decisions.mjs \
  --project /path/to/project \
  --dataset data/decision-dataset.json \
  --predictions data/provider-predictions.json \
  --providers data/provider-metadata.json \
  --output data/provider-observations.json \
  --log-task failure-triage \
  --json
```

The predictions file keeps the #32 schema and may contain more than one saved
provider identity. The command requires at least two identities for an
end-to-end replay. `--providers` is optional; when omitted, provider model
metadata is `UNKNOWN` and an identity represented by a saved prediction is
treated as available saved data. A metadata file can provide model identity,
availability, calibration evidence digest and threshold evidence digest.

Before producing a report or appending a ledger, the command parses the full
dataset and predictions, verifies every dataset source and label-evidence
digest, and runs `evaluateDecisions()` to check dataset, case-input and
provider bindings. It then creates one replay record per provider and case;
each record carries the dataset digest, predictions digest, case ID,
decision-point identity and case-input digest. Saved #32 predictions do not
bind their original typed question, so replay records retain
`questionSha256: "UNKNOWN"`. An optional `--questions` file is replay-only
mapping metadata: its typed choice must contain each saved predicted label, and
its digest is retained separately as `replayQuestionSha256`; it never claims to
be the original question.
Missing saved predictions and unavailable providers are effective off with
`probabilities: "UNKNOWN"`, `band: "UNKNOWN"` and
`action: "no-enforcement"`. No expected labels, question text, observations,
evidence payloads or raw exceptions are copied into the ledger.

`--output` is the only report write and the path must be new, project-relative,
and disjoint from every input and verified evidence file. `--log-task` is the
only ledger write; it explicitly appends the validated records to the existing
`.tinysdd/runs/decisions/<task>.jsonl` file. The internal directory and final
file path are checked for symlinks before the append. Omitting both flags is
read-only. `--json` emits one JSON object on stdout and sends warnings to
stderr.

This foundation does not select a winner, claim calibration, infer latency from
replay wall time, alter labels, change controller state or acceptance, or
qualify live providers. Real reviewed labels, provider comparisons, calibrated
thresholds and live `jev`/`laya`/`llm-judge` clients remain pending.
