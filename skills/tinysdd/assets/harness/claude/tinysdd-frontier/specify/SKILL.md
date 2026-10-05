---
name: tinysdd-specify
description: Write a grounded TinySDD feature proposal with clarifications, observable requirements and explicit unknowns.
---

# TinySDD specify

Use this skill for the specify phase of the frontier workflow. It writes the
proposal for one bounded change; it does not design implementation, create
worker tasks, request a provider, or grant approval.

Start from the [proposal template](../templates/proposal.md) and keep the
shared [phase workflow reference](../references/phase-workflow.md) nearby.

Read the repository instructions, the requested behavior, relevant callers and
existing checks. Trace the current behavior before drafting. Keep source facts,
proposed decisions and UNKNOWN facts in separate sections. An UNKNOWN must say
which check or operator decision would resolve it. Do not convert a familiar
pattern or a model suggestion into a requirement.

Write one proposal at changes/<change-id>/proposal.md using the proposal
template. Give every requirement and acceptance criterion a stable slug or ID
because the delta and integration descriptors refer to those IDs. Describe:

- observable success, rejection and preserved state;
- compatibility and security boundaries;
- explicit exclusions;
- exact sources, callers and checks;
- questions whose answers would change behavior.

Ask the operator one coherent clarification batch when answers affect product
meaning, acceptance, permissions, or data preservation. Keep the unanswered
items visible; do not silently choose a default. Strong review of the proposal
is a conversation decision, not a frontmatter flag.

Finish this phase with the proposal path, source citations, unresolved
UNKNOWNs, proposed decisions and the exact checks still needed. Do not write
design.md, deltas, slice descriptors, implementation code or tests in this
phase. If the requested change is larger than a bounded feature, return to the
operator with the concrete split or scope decision required.
