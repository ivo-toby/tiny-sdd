# Deterministic research selection scoring

`src/research-scoring.mjs` is a preparation helper for the future research
benchmark. It compares a candidate context manifest with a reviewed gold
manifest using the same `parseContextManifest()` and `compileContext()` path as
ordinary TinySDD packets. It is offline and deterministic: it reads source
files, never executes checks, starts no model or service, and does not change
controller state.

## Inputs

Call `scoreResearchSelection()` with an explicit project root, both manifests,
and a positive compiled-context byte budget no larger than the compiler's
96 KiB ceiling:

```js
import { scoreResearchSelection } from '../src/research-scoring.mjs';

const result = await scoreResearchSelection({
  projectRoot: '/path/to/project',
  goldManifest: { path: 'gold.json', text: goldText, sha256: goldDigest },
  candidateManifest: { path: 'candidate.json', text: candidateText, sha256: candidateDigest },
  budgetBytes: 24 * 1024,
});
```

Manifest objects may also be supplied as raw JSON strings or parsed
`{ schemaVersion, facts, resources }` values. Gold is compiled first. Invalid
gold refuses evaluation, while invalid candidate JSON/schema, paths, symlinks,
line ranges, source files, or compiler-size inputs produce an explicit
candidate hard-gate observation.

## Measurements

For valid inputs, each file's inclusive line ranges are merged before counting.
The result reports `goldLines`, `candidateLines`, `intersectionLines`,
`precision`, `recall`, and the compiled UTF-8 byte counts. `precision` is the
intersection divided by candidate lines; `recall` is the intersection divided
by gold lines. A zero denominator is `UNKNOWN` with a reason. The caller
budget gates candidate compiled bytes; an oversized gold manifest remains a
distinct reference observation and does not fail an otherwise in-budget
candidate. An oversized candidate gives `status: "hard_gate_failed"`; no
range is truncated or discarded to improve a score.

`facts` and `purpose` text is retained only as manifest context. It is not a
semantic-truth judgment and cannot approve a manifest, task, model, or
benchmark. The research adapter, human-reviewed gold set, calibration, and
qualification threshold remain separate work.

The synthetic examples under `bench/research-scoring-fixtures/` are labeled
`proposed-unreviewed-human`. They illustrate intended interface selections for
later review; they are not human labels, a 50-example dataset, or a calibrated
benchmark.
