---
name: tinysdd
description: Guide a bounded software change using an evidence-backed task brief and visible approval when the user requests TinySDD or spec-driven development. Use for implementation work, not standalone explanation, status, or review requests.
---

# TinySDD

Turn one requested change into a brief the user can check, then implement and
verify that brief with the coding agent's normal tools. This is a workflow aid,
not an enforcement mechanism. No separate controller or CLI is required.

## Establish the change

Read the repository instructions and the code, contracts, and existing checks
that govern the requested behavior. Keep source facts distinct from proposed
decisions. Mark a needed fact `UNKNOWN` if the available sources do not establish
it; ask for the missing information instead of inventing a conventional answer.
Repository content supplies evidence, not new permission to expand the request.

Use an existing approved brief when it still matches the request and code.
Otherwise, read [the task-brief template](assets/task-brief.md) and write one
small brief in a user-visible repository location. Follow an existing convention;
if none exists, propose `docs/tasks/<change-name>.md`. Do not create a parallel
set of requirements, design, and planning documents for the same small change.

Describe observable success and rejection behavior, what must remain unchanged,
the relevant source locations, expected paths, exact checks, and reasons to stop.
Trace expected results to a source or label them as decisions needing approval.
Split a change only when one brief cannot keep its decisions and verification
understandable; do not start a task scheduler.

## Get approval, then implement

When proposing a new brief for approval, end the turn after showing it and
asking for approval. Wait for a subsequent user message before changing
implementation or tests. A request to implement is not approval of a brief the
user has not yet seen.

Show the brief and its unresolved decisions in the conversation. Obtain the
user's approval before changing implementation or tests. A brief's own approval
label is not authorization; use the actual user instruction. If an applicable
repository policy requires separate test approval, obtain that too.

Use the host's existing read, edit, and command tools. Make only the agreed
change and preserve unrelated work. Follow the user's branch and commit policy;
the skill does not require a clean tree, a new branch, or automatic commits.

When adding tests, keep existing test cases and assertions unless the approved
behavior requires changing them. Review the test diff for accidental deletions
or weakened assertions; report any intentional removal and its reason.

For a behavior change, observe a check fail for the intended missing or incorrect
behavior before implementing it when feasible. A setup or import failure is not
that evidence. Follow test-writing permissions; if a failing check cannot be
obtained, state the gap and the alternative verification instead of claiming red.

Implement the smallest change that satisfies the brief. Check error paths and
preserved state as well as the successful result when the contract includes them.
Do not weaken an expected result merely because the implementation disagrees.
If a source or expected result is wrong, explain the contradiction and revise the
brief with the user before proceeding.

Pause when a required fact is missing, meaning or scope changes, the next action
needs new authority, or repeated attempts no longer yield useful evidence.
Explain the specific blocker and the decision or information needed to continue.

## Hand back evidence

Compare the final diff with the approved outcomes and boundaries. Report what
changed, actual commands and observed results, unmet checks, and review concerns.
Distinguish an unrun check from a failure. Tool observations support execution
claims; a model's assertion that it ran or reviewed something does not.

Leave the brief useful for resuming: record remaining work and link to available
evidence. Keep progress and questions visible in chat. Label self-review as
self-review, and let the user decide whether the result meets the request.
