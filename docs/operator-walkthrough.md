# The intended TinySDD experience

Status: proposed operator walkthrough, informed by the first feature pilot.
Real human use of this sequence has not yet been evaluated. The candidate
skills are experiment-local and are not installed or registered globally.

TinySDD should be usable in your normal coding-agent conversation. The
experiment's capture CLI is not how you are expected to build a product.

## Prepare with a strong model

Supply the request and relevant repository to Astra/Sol, with the candidate
[preparation instructions](../experiments/003-idempotent-reservations/skills/tinysdd-prepare/SKILL.md).
For example:

> Prepare this small feature for implementation by Qwen. Read the existing code
> first. Show me the behavior, decisions that need my input, acceptance criteria
> and a few bounded tasks. Do not implement or dispatch tasks yet.

The output is one feature specification and a few short task packets, not a
mandatory stack of planning documents. Review the product decisions and shared
interfaces. Approve or revise them in the conversation. For a tricky stateful
requirement, ask for a concrete before/action/after example and check its expected
result yourself or with strong-model review.

## Implement one approved task

Use Qwen or Gemma with the approved feature, the next task packet, repository
access, and the candidate
[task instructions](../experiments/003-idempotent-reservations/skills/tinysdd-task/SKILL.md).
For example:

> I approve task 01 against FEATURE.md. Implement only its allowed changes.
> Read the referenced code and tests, verify the missing behavior before editing
> production code where applicable, then run the checks and return your diff and
> evidence. Stop after this task.

The participant uses normal read, write, edit and shell tools. The on-disk packet
supports a fresh conversation; it does not itself prove operator approval.
Missing facts or contradictory prerequisites return to you rather than becoming
silent scope changes.

## Review, then decide

Ask the strong model to review the captured diff against the specification and
actual checks. Use the repository's existing tests, compiler and lint checks when
available, plus acceptance checks that do not merely repeat the implementer's
assumptions. The [review lessons](feature-review-lessons.md) show why test names,
counts and a self-review statement are insufficient.

> Review task 01 against the approved behavior. Inspect its code and test
> expectations, confirm original tests and unrelated files are preserved, and
> distinguish observed checks from claims. Give me concrete findings. Do not
> silently repair the implementer's code or start task 02.

You accept the task, request a scoped revision, or revise the specification.
Only then authorize the next task. At the end, verify the complete feature
through its public interface and decide whether to accept it.

The pilot's two-invocation/six-minute task budget was an experimental bound,
not a proposed product requirement. Real task and review budgets should be
chosen openly for the repository and feature; an incomplete handoff stays
incomplete even if the retained code passes checks.

## What remains to validate

The pilot tested consumption of a carefully prepared synthetic feature. It did
not establish repeatable strong-model preparation, operator usability, cost
savings, or production reliability. Nemotron is a target runtime but has not
completed this feature experiment. The next test should use an operator-selected
held-out feature and include the preparation conversation itself.
