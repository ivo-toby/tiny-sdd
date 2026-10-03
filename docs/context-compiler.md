# Context compiler

TinySDD does not ask an implementation model to rediscover every relevant
interface from a broad repository. A task may carry a small, explicit context
manifest prepared by the operator or a stronger outer agent. The controller
binds that manifest to approval; the worker compiles its exact source line
ranges into an auditable `compiled-context.md` artifact.

This is selection, not autonomous retrieval or a hidden model summary. The
manifest says what the worker should know and why. It is especially useful for
public types, validation boundaries, persistence contracts and fixed acceptance
assertions that a smaller model might otherwise overlook.

## Create a manifest

Store it under `.tinysdd/tasks/`, alongside the task brief:

```json
{
  "schemaVersion": 1,
  "facts": [
    "Generation owns outputFilename validation; do not weaken it."
  ],
  "resources": [
    {
      "path": "src/tools/generate-podcast.ts",
      "startLine": 12,
      "endLine": 82,
      "purpose": "Generation input schema and returned job contract."
    },
    {
      "path": "tests/tools/generate-and-publish.test.ts",
      "startLine": 1,
      "endLine": 120,
      "purpose": "Fixed acceptance assertions for the composed operation."
    }
  ]
}
```

Register it when adding the task:

```sh
tinysdd task add --id publish-job \
  --brief .tinysdd/tasks/publish-job.md \
  --context .tinysdd/tasks/publish-job.context.json \
  --allow src/tools/publish-job.ts,tests/tools/publish-job.test.ts
```

The manifest, its source paths, and the exact line ranges should be reviewed as
part of task approval. It is not a place to smuggle extra scope into a task.

`task add` compiles the manifest immediately, so an unknown key, a missing file,
an out-of-range line or an over-budget packet fails registration instead of
surfacing first at approval. `task add` and `task approve` also return an
advisory `sizing` report (allowed-file count, compiled-context bytes, cited test
lines, `citedFakeTimers`, `citedDeferredPromises`, `citedConcurrencyMarkers`,
`citedOrderingAssertions`, and `behaviorSplit: { recommended, reasons }`).
Only cited test-source ranges contribute to these provisional text heuristics.
Fake timers with deferred promises or concurrency markers, or at least 8
ordering assertions, recommend separating the sequential core from the async
edge into their own test files. Thresholds are provisional and uncalibrated,
pending the talon reruns; the warnings never block. The same four counts appear
in worker `result.json` under `taskShape`, outside approval digests and worker
context metadata.

## Share a spec between slices

Give every slice its own brief and cite the shared feature spec through the
slice's manifest, one range per section the slice needs, instead of sharing one
brief between slices:

```json
{
  "schemaVersion": 1,
  "facts": [],
  "resources": [
    { "path": "docs/feature-spec.md", "startLine": 12, "endLine": 40, "purpose": "Validation rules for this slice." }
  ]
}
```

Approval binds the cited lines, not the whole file (see below). Appending to the
spec, or editing outside every cited range, leaves the slices current. Editing a
cited line makes only the slices that cite it stale. Citations are positional,
so inserting lines above a cited range shifts it and makes that slice stale:
append addenda at the end of the spec rather than in the middle.

## Guarantees and limits

- The manifest schema is strict: only `schemaVersion`, `facts`, and `resources`
  are accepted. A resource has exactly `path`, `startLine`, `endLine`, and
  `purpose`.
- Source resources must be ordinary project files. `.git`, `.tinysdd`, symlinks,
  traversal, malformed JSON, duplicate ranges, missing files and out-of-range
  lines fail the run.
- Approval records the digest of the compiled text: the manifest digest, the
  facts, and each cited range with its line numbers and excerpt digest. Editing
  the manifest or a cited line makes the task's approval stale until it is
  re-approved. The whole source file is not bound: appending to it or editing
  outside every cited range keeps the approval fresh, while inserting or
  deleting lines above a cited range moves it and makes the approval stale.
- Approvals recorded before this binding changed hold the digest of an older
  rendering that also carried a whole-file `Source sha256:` line per cited file.
  They stay fresh and keep binding the whole file until the task is
  re-approved, which records the current digest.
- The compiled packet contains line numbers plus an excerpt digest per range.
  Worker artifacts retain `compiled-context.md` and structured metadata in
  `context.json`, including each cited file's whole-file `sourceSha256` for the
  record; raw source is not copied into controller state. A replayed packet that
  carries a legacy digest is marked `matchedDigest: "legacySha256"` in the
  `compiledContext` block of `context.json`.
- The rendered packet has a 96 KiB cap (the initial roughly-24K-token hot
  context ceiling). It fails rather than truncating. Narrow the ranges or split
  the task if it exceeds the budget.
- Facts are controller-provided constraints. Source excerpts are labeled
  reference data, never instructions; text in a source file cannot override the
  worker contract or approved brief.
- The worker contract tells a model not to reread cited source merely to
  rediscover injected facts. It may still inspect uncited code needed for the
  allowed edit or report a concrete contradiction.

An omitted `--context` remains valid for small tasks. Use one when a precise
interface or oracle would materially reduce rediscovery and ambiguity.
