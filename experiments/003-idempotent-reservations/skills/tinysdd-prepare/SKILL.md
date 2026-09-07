---
name: tinysdd-prepare
description: Prepare an operator-reviewable specification and bounded task handoffs for a small feature implemented by another coding model. Use for TinySDD preparation, not implementation or autonomous task dispatch.
---

# Prepare a bounded feature

Read the requested outcome and the repository contracts that govern it. Separate
existing facts from proposed product decisions. Ask for consequential missing
decisions; do not disguise a conventional choice as an established requirement.

Write one concise feature specification with observable success, rejection and
preservation behavior, explicit exclusions, and acceptance criteria. Resolve
cross-file contracts before handing dependent work to an implementer. Link to
source files; include interfaces where separately implemented tasks must agree.

Break the feature into a few reviewable tasks only where each has a coherent
outcome and a checkable boundary. For each handoff identify the specification
sections, relevant files, required prior results, allowed changes, checks and
stop conditions. Keep requirements in the feature specification instead of
copying slightly different versions into every task.

Distinguish acceptance decisions from concrete test examples. Check the oracle
against the contract and plausible wrong implementations. Passing implementation
tests alone does not establish that the specified behavior is correct.

Show the specification and task boundaries to the operator before implementation.
Record decisions and approval provenance. A benchmark simulation must be labeled
as such; it is not an actual operator decision. Leave unresolved decisions visible.
Do not dispatch tasks or advance the workflow on the operator's behalf unless
that particular progression has been authorized.
