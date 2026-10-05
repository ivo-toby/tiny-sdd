---
name: tinysdd-research
description: Collect exact, verified source excerpts and dependency facts for a TinySDD feature without broad-context interpretation.
---

# TinySDD research

Use this skill after the proposal is reviewed. Research supplies the plan with
auditable source excerpts. It does not rewrite requirements, choose an
implementation, approve a plan, or invoke a model or provider.

Use the [context manifest template](../templates/context.json) and the shared
[phase workflow reference](../references/phase-workflow.md); preserve this
directory layout when installing the phase skill in another harness. This file
is prompt guidance only: a standalone install does not include the TinySDD CLI,
phase handler, schemas or repository docs. Keep the checkout and target roots
from the phase workflow reference available for the human gate.

Read the proposal and repository instructions first. Inspect only the source,
callers, tests, configuration and dependency metadata needed to answer the
proposal's questions. Record each result as a source fact with an exact path
and line range. Record unresolved claims as UNKNOWN. A research artifact must
make it possible for another agent to verify the same bytes; prose summaries
without citations are not research evidence.

Create the existing context-manifest shape:

~~~json
{
  "schemaVersion": 1,
  "facts": [
    "Source fact stated with its path and exact symbol."
  ],
  "resources": [
    {
      "path": "src/entrypoint.mjs",
      "startLine": 1,
      "endLine": 40,
      "purpose": "Real caller contract needed by the plan."
    }
  ]
}
~~~

Keep resources narrow. Include exact interface/caller excerpts, fixed
acceptance assertions, relevant error/state contracts, installed dependency
versions and accessors, and lint rules that could affect the worker. Use
parseContextManifest(), compileContext() and contextSizeMetrics() from
src/context-compiler.mjs or the existing task/phase validator to check the
manifest. Retain the compiled excerpts and their digests. Do not cite a
directory listing, copy an entire file when a range is enough, or replace an
excerpt with your interpretation.

If the project enables the optional research phase policy, set the TinySDD
checkout and canonical target project roots from any working directory. Put the
reviewed proposal and manifest in the target paths passed to the human gate:

    TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
    TARGET_PROJECT=/absolute/path/to/project

    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase record --phase research --feature FEATURE \
      --proposal changes/FEATURE/proposal.md \
      --context changes/FEATURE/research.context.json \
      --by OPERATOR --reason 'Reviewed the cited research inputs'
    node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
      phase status --feature FEATURE

Only the configured human research handler is implemented. A frontier,
deterministic or automatic mode reports unavailable; stop with that observed
result. The record becomes stale when cited inputs, policy, predecessor or
producer qualification changes. A phase record is evidence of the research
decision only. It does not approve the plan or a task.

Hand off the manifest path, compiled excerpt path/digest, source facts,
UNKNOWNs, dependency/lint facts, commands and actual output. Do not write
design.md, change.json, slice descriptors or implementation code here. If a
required caller or contract cannot be cited, return to specify or ask the
operator rather than guessing.
