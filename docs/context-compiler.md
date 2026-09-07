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

## Guarantees and limits

- The manifest schema is strict: only `schemaVersion`, `facts`, and `resources`
  are accepted. A resource has exactly `path`, `startLine`, `endLine`, and
  `purpose`.
- Source resources must be ordinary project files. `.git`, `.tinysdd`, symlinks,
  traversal, malformed JSON, duplicate ranges, missing files and out-of-range
  lines fail the run.
- Approval records the manifest plus the compiled source/excerpt digest. Editing
  the manifest or a selected source file makes the task's approval stale until
  it is re-approved.
- The compiled packet contains line numbers plus source and excerpt digests.
  Worker artifacts retain `compiled-context.md` and structured metadata in
  `context.json`; raw source is not copied into controller state.
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
