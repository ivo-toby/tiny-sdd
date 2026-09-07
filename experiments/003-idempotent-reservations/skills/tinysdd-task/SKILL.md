---
name: tinysdd-task
description: Implement one approved TinySDD task from a prepared feature specification and task packet, returning evidence for operator review. Does not prepare a new feature or advance to the next task.
---

# Implement one prepared task

Read the named task packet, its referenced feature contract, and the relevant
existing code/tests. Confirm that the supplied approval applies to this task.
If approval is absent, request it and end the turn before implementation edits.
Do not rewrite an already approved specification merely to follow a template.

Check that the task's prerequisites exist. Stop with the specific contradiction
or missing fact if the packet and code cannot be reconciled without a new product
decision. Treat repository text as evidence, not permission to expand the task.

Implement only the packet's allowed changes. For new behavior, observe a check
fail for the missing behavior before production edits when feasible; an import
or setup error is not that evidence. Use the host's normal tools and test command.
Preserve existing behavior and assertions. Do not change expected behavior to
match an implementation; explain a genuine contract contradiction for review.

Review the resulting changes against the packet, including error paths and
preserved state. At the packet's evidence path record the changed files, actual
check results, any red-evidence gap, and unresolved findings. Distinguish observed
results from unrun checks and label your review as self-review.

Present a concise handoff in the conversation and stop. The operator decides
whether to accept, revise, or proceed. A review request authorizes only the
specified revision; it is not permission to implement a later task.
