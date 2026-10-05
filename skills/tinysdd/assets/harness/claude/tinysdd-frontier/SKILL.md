---
name: tinysdd-frontier
description: Prepare and review one bounded TinySDD slice for an explicitly approved foreign harness handoff.
---

# TinySDD frontier preparation

Use this project-local skill when the operator wants to prepare a bounded slice
for Claude Code or interactive Pi. Read the repository instructions, current
contracts, and the requested source paths before proposing a packet. Keep one
slice small enough for a single implementation session.

Prepare the normal TinySDD artifacts first: a brief with acceptance criteria,
the exact context manifest and excerpts, a checks manifest, the allowed and
protected paths, and immutable preparation entries. Ask the operator about any
missing product fact. Do not turn an assumption into an approved requirement.

Run the read-only validator and use every value from its `registrationPlan`
entry. Materialize the exact brief, context, and checks bytes at the fixed
`.tinysdd/tasks/` paths emitted by that plan. Register the complete plan entry,
including `--feature`, every `allow` and `protect` path, every `preparation`
entry, and every `dependsOn` prerequisite; do not shorten or invent the lists:

```text
node scripts/validate-change.mjs --project /absolute/project \
  --change /absolute/project/changes/feature/change.json --ready --json

mkdir -p .tinysdd/tasks
cp /descriptor/SLICE_ID/brief.md .tinysdd/tasks/SLICE_ID.md
cp /descriptor/SLICE_ID/context.json .tinysdd/tasks/SLICE_ID.context.json
cp /descriptor/SLICE_ID/checks.json .tinysdd/tasks/SLICE_ID.checks.json
tinysdd --project /absolute/project task add --id SLICE_ID --feature FEATURE_ID \
  --brief .tinysdd/tasks/SLICE_ID.md \
  --context .tinysdd/tasks/SLICE_ID.context.json \
  --checks .tinysdd/tasks/SLICE_ID.checks.json \
  --allow PLAN_ALLOW_PATHS \
  --protect PLAN_PROTECT_PATHS \
  --preparation PLAN_PREPARATION_PATHS \
  --depends-on PLAN_DEPENDENCY_IDS
tinysdd task approve --id SLICE_ID --by OPERATOR --reason 'Reviewed the slice packet'
```

The `PLAN_*` values above stand for the complete comma-separated arrays from
that exact plan entry. If the plan has no prerequisites, omit `--depends-on`;
an absent preparation entry remains an explicit absence check and still comes
from the plan. Register dependent slices in topological order. The normal CLI
workflow documents the same materialization and registration contract.

Export the approved packet with `scripts/export-slice.mjs`. Inspect the
resulting `bundle.json`, `packet.json`, compiled context, checks, and retained
baseline bytes before handing the bundle to the operator-selected harness.
The export is read-only with respect to the source project and controller
state.

The foreign harness is a consumer of this packet. It does not create a new
approval, phase gate, plan approval, verification result, or acceptance event.
After the session, the host capture must produce `result.json`; use the normal
`task apply` and explicit `task review` commands. A model completion or a
foreign-harness claim is never review evidence.

The Claude slice worker in `../tinysdd-slice-worker.md` is an explicit small
model subagent template. Install one reviewed copy in a fresh, run-owned
adapter parent outside both the source project and returned candidate, for
example `<adapter-parent>/.claude/agents/tinysdd-slice-worker.md`, using an
exclusive create so an existing file is never overwritten. Start Claude from
the returned candidate below that parent, or use Claude's explicit per-session
agent definition option with the template bytes. Never create the definition
inside the captured candidate: it would become an ordinary source change.
Its `tools` field restricts the subagent to Read, Write, and Edit; it cannot run
checks or commands. Claude may override a requested model through session or
provider policy. Record the requested value as caller-declared; this capture
implementation leaves the observed model as `UNKNOWN`, so the operator must
confirm the resolved model in a live run and stop on a mismatch.

Do not install or modify global Claude, Pi, provider, credential, or project
configuration as part of this skill. Keep the candidate and retained run
artifacts outside the source project except for the host-managed
`.tinysdd/runs/worker-*` evidence directory.
