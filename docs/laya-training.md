# Laya training-data export and recipe

TinySDD can export a checked, deterministic training-data bundle for Laya's
failure-triage choice head. The exporter is an offline data preparation tool:
it does not install Python, download a checkpoint, call a provider, run Laya,
train a model, or claim a comparison result.

The exporter consumes the versioned #32 decision dataset and an explicitly
supplied Laya choice question. It verifies every source and review-evidence
digest before creating a new output directory, then retains only real,
human-reviewed `failure-triage` cases with a nonempty `observation.checkLog`.
Synthetic cases and other decision points are counted as exclusions. A malformed
otherwise eligible case is refused. The existing `train`, `validation`, and
`test` assignments and all three #32 group keys are preserved; every retained
partition must be nonempty.

## Export

The question file is a Laya question object. Its `type` must be `choice`, and
its `criteria` keys must be exactly the four existing TinySDD labels. The
question is supplied by the operator so the exporter does not invent a policy
mapping or question wording:

```json
{
  "type": "choice",
  "instructions": "Classify the failed check log.",
  "criteria": {
    "environment": "The failure is caused by the execution environment.",
    "missing-context": "The worker lacks required context.",
    "fixable-from-log": "The failure is fixable from the log.",
    "unknown": "The log is insufficient to classify the failure."
  }
}
```

Run the exporter with project-relative paths:

```sh
node scripts/export-laya-training-data.mjs \
  --project /path/to/project \
  --dataset data/decision-dataset.json \
  --question data/failure-triage-question.json \
  --output data/laya-failure-triage-v1 \
  --json
```

The output directory must be new. It contains `train.jsonl`,
`validation.jsonl`, `test.jsonl`, and `manifest.json`. Each JSONL row follows
the pinned Laya source contract in [`train.py`](https://github.com/NandhaKishorM/laya/blob/8a6e1328cce2460a0e5aa348ad465bb1b5821cd2/laya/train.py)
at revision
[`8a6e1328cce2460a0e5aa348ad465bb1b5821cd2`](https://github.com/NandhaKishorM/laya/commit/8a6e1328cce2460a0e5aa348ad465bb1b5821cd2):

```json
{
  "state": { "checkLog": "..." },
  "questions": {
    "failure-triage": { "type": "choice", "instructions": "...", "criteria": { "...": "..." } }
  },
  "gold": {
    "failure-triage": { "probabilities": { "environment": 0, "missing-context": 0, "fixable-from-log": 1, "unknown": 0 } }
  }
}
```

The state contains the check log only. The exporter does not put labels,
reviewer names, review times, expected metadata, or full evidence payloads in
the state or manifest. Gold vectors are hard one-hot targets derived from the
reviewed label; they are not measured model probabilities or confidence values.
The manifest binds the normalized dataset and question digests, retained case
input digests, partition/group identity, output byte counts and SHA-256 values,
exclusion counts, and the pinned Laya consumer revision.

## Unexecuted training recipe

The recipe below is a plan for a later operator-run experiment. It requires an
explicit local checkpoint directory and the pinned Laya source revision above;
it must not silently download a mutable “latest” checkpoint.

```sh
CHECKPOINT_DIR=/absolute/path/to/laya-checkpoint
LAYA_SOURCE_REVISION=8a6e1328cce2460a0e5aa348ad465bb1b5821cd2
DATA_DIR=/absolute/path/to/project/data/laya-failure-triage-v1
```

1. Load the local checkpoint directory with the pinned Laya loader and read
   `train.jsonl`, `validation.jsonl`, and `test.jsonl` separately.
2. Pass only train rows to `items_from_rows(...)` and `train_model(...)` from
   the pinned `laya/train.py`. Do not use the upstream `finetune(...)` helper
   unchanged: its published implementation randomly carves calibration items
   from its input, which would break this bundle's split boundary.
3. After training, pass only validation items to
   `calibration_records(...)` and fit the result with
   `laya.calibrate.fit_temperature_map`.
4. Keep the test rows untouched until the final prediction pass. Save the
   provider predictions with #32's dataset and case-input digests, then use
   `evaluateDecisions(...)` to compare the result with the deterministic
   baseline at the operator-supplied operating threshold.

The upstream API names and the `{state, questions, gold}` schema are pinned to
the official [`train.py`](https://github.com/NandhaKishorM/laya/blob/8a6e1328cce2460a0e5aa348ad465bb1b5821cd2/laya/train.py)
and [`docs/finetune.md`](https://github.com/NandhaKishorM/laya/blob/8a6e1328cce2460a0e5aa348ad465bb1b5821cd2/docs/finetune.md)
sources. TinySDD has not run this
fine-tuning recipe, measured Apple Silicon or Linux GPU time or memory, chosen
a checkpoint, selected an operating threshold, or produced a model artifact.
Those remain operator-run experiment inputs and results.
