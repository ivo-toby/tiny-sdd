# Offline decision evaluation

Issue #32 adds a credential-free, offline foundation for evaluating the five
decision points in [the decision inventory](decision-inventory.md). It validates
versioned JSON, verifies source evidence, and compares saved provider predictions
with separately reviewed labels. It does not call Jev, Laya, a local model, or a
frontier model, and it does not change controller state or acceptance.

## Dataset

A dataset is a JSON object with `schemaVersion: 1`, an `id`, a `version`, and a
nonempty `cases` array. Each case has:

```json
{
  "id": "run-0001",
  "decisionPoint": "failure-triage",
  "synthetic": false,
  "source": {
    "kind": "run-log",
    "refs": [
      { "path": "evidence/run-0001.json", "sha256": "...64 lowercase hex..." }
    ]
  },
  "observation": { "checkLog": "..." },
  "expected": {
    "label": "fixable-from-log",
    "reviewedBy": "ivo",
    "reviewedAt": "2026-10-04T10:00:00.000Z",
    "evidence": [
      { "path": "evidence/review-0001.md", "sha256": "...64 lowercase hex..." }
    ]
  },
  "split": {
    "partition": "test",
    "sourceGroup": "source-run-0001",
    "featureGroup": "feature-checks",
    "runLineageGroup": "lineage-run-0001"
  }
}
```

`observation` records what a worker, check, or preparation run produced. It is
not a label. `expected` is the human-reviewed label and always records the
reviewer and UTC review time. Failure triage keeps the existing taxonomy:
`environment`, `missing-context`, `fixable-from-log`, and `unknown`. Other
decision points may use string or boolean labels, but this foundation does not
invent their policy mapping.

Every source and optional label-review evidence reference is project-relative,
must name a regular file, and must match its SHA-256 digest. Symlinked paths,
traversal, changed content, malformed JSON, and oversized evidence are refused.
`benchmark-case-result` and `benchmark-invocation` source kinds are additionally
checked with the existing benchmark parsers. A benchmark outcome or check result
does not supply a triage label; the reviewed `expected` block does.

Each case also carries three explicit group keys. A source, feature, or run
lineage group may belong to only one of `train`, `validation`, or `test`; a
cross-partition group is rejected before evaluation. Cases with
`synthetic: true` remain useful for tests but are excluded from real-label
counts. They cannot satisfy the issue's requirement for 50 real failure-triage
labels.

## Saved predictions

Providers save predictions in a separate JSON file:

```json
{
  "schemaVersion": 1,
  "datasetSha256": "...digest of the normalized dataset...",
  "predictions": [
    {
      "provider": {
        "id": "deterministic-baseline",
        "configSha256": "...64 lowercase hex..."
      },
      "caseId": "run-0001",
      "inputSha256": "...digest of decisionPoint, synthetic, source, observation...",
      "predictedLabel": "fixable-from-log",
      "probabilities": "UNKNOWN",
      "measurements": {
        "latencyMs": "UNKNOWN",
        "inputTokens": "UNKNOWN",
        "outputTokens": "UNKNOWN",
        "totalTokens": "UNKNOWN",
        "frontierTokensAvoided": "UNKNOWN"
      }
    }
  ]
}
```

The evaluator rejects an unknown case, duplicate provider/case pair, changed
dataset, or changed case input. Provider identity and configuration digest are
bound into every prediction. A provider may omit a prediction for a case, which
reduces coverage; it may not replace a previous prediction in this file.

Probabilities are a label-to-number object with values from 0 to 1. They are
not required to sum to 1 because some typed providers do not expose a
complementary probability contract. Missing probabilities, latency, tokens, or
frontier-token measurements are `UNKNOWN`, never zero. The helper
`buildBaselinePredictions()` in `src/decision-evaluation.mjs` applies the actual
`triageFailure()` and `triageReview()` functions to observations and emits
saved, clearly separate baseline predictions. It never changes labels.

## Metrics configuration and report

Threshold and label mappings are operator inputs. There is no default accept
class and no default operating threshold. Supply a metrics file when these
metrics are intended:

```json
{
  "schemaVersion": 1,
  "decisionPoints": {
    "failure-triage": {
      "positiveLabels": ["fixable-from-log"],
      "acceptLabels": ["fixable-from-log"],
      "threshold": 0.9,
      "calibrationBins": 10
    }
  }
}
```

At the configured threshold, the probability for the configured accept labels
drives `accept` versus `negative`. A missing probability is `abstain` and is
excluded from threshold confusion counts. The report gives the direct label
confusion matrix and, when configured, binary and threshold confusion counts.
It names both denominators:

- `falsePositiveRate` is false accepts divided by actual negatives.
- `falseDiscoveryRate` is false accepts divided by predicted positives.

Either rate is `UNKNOWN` when its denominator is zero. Calibration reports the
sample count, Brier score, ECE, and reliability bins only for genuine
probability observations and the configured binary label mapping. Measurements
are summarized only from observed values. The report also states total,
real, synthetic, and real failure-triage counts and warns when the 50-label
minimum is not met. Per-decision-point coverage separates saved predictions,
known labels, known probabilities, and threshold observations. It does not name
a winner, change policy, or claim that any positive prediction skips operator
review.

Confusion-matrix keys preserve label types: string labels use
`string:<JSON-encoded-label>` and boolean labels use `boolean:true` or
`boolean:false`. This keeps a boolean `true` distinct from the string `"true"`
and keeps labels such as `toString` or `__proto__` from becoming object
properties with inherited behavior.

Threshold and calibration probabilities require one string accept label with a
genuine probability observation. A list of accept labels has no implicit union
probability because provider probabilities need not be complementary; its
threshold and calibration fields remain `UNKNOWN` with a reason while explicit
discrete label confusion counts remain available. Boolean probability-map keys
are also treated as ambiguous and remain `UNKNOWN`.

## Offline command

The standalone command reads explicitly named, project-relative files. It first
validates all dataset evidence and inputs, then writes a report only when
`--output` is supplied:

```sh
node scripts/evaluate-decisions.mjs \
  --project /path/to/project \
  --dataset data/decision-dataset.json \
  --predictions data/predictions.json \
  --metrics data/metrics.json \
  --output data/evaluation-report.json \
  --json
```

`--metrics` and `--output` are optional. With `--json`, stdout contains exactly
one JSON object; warnings, including an incomplete real-label count, go to
stderr. An output path must be new and must not name the dataset, predictions,
metrics, or any validated evidence file. The command performs no inference,
network access, service startup, credential lookup, implicit ledger update, or
controller/bin integration.

This checkout contains benchmark fixtures and deterministic tests, but no
tracked archive of 50 real, human-reviewed failure-triage labels or measured
provider comparison runs. The report therefore keeps those quantities missing
until the operator supplies the corresponding evidence; synthetic fixtures are
never promoted to real measurements.
