# The intended TinySDD experience

Status: operator walkthrough, first written after the 2026-09 feature pilot and
updated for the installed CLI and skills. A complete operator trial of this
sequence on a real feature is still open
([#110](https://github.com/ivo-toby/tiny-sdd/issues/110),
[#117](https://github.com/ivo-toby/tiny-sdd/issues/117)).

TinySDD is used from your normal coding-agent conversation. Install the CLI
with `npm install --global tinysdd` and run `tinysdd setup`. Then open a fresh
Claude Code or Codex session in the target project and run `/tinysdd-setup`
(Codex: `$tinysdd-setup`) once, and `/tinysdd` (`$tinysdd`) for feature work.
The [quickstart](quickstart.md) and [setup guide](setup.md) have the details.
The pilot's experiment-local skills under `experiments/003-idempotent-reservations/`
are historical material, not the installed workflow.

## Prepare with a strong model

Give the request to the strong model running the `tinysdd` skill. It runs the
constitution entry check, then the frontier phase skills (specify, research,
plan, slice). For example:

> Prepare this small feature for implementation by Qwen. Read the existing code
> first. Show me the behavior, decisions that need my input, acceptance criteria
> and a few bounded tasks. Do not implement or dispatch tasks yet.

The output is a short brief or, for a multi-slice feature, one
`changes/<change-id>/` directory in the [artifact format](artifact-format.md),
with a few bounded slices. It is not a mandatory stack of planning documents.
Review the product decisions and shared interfaces. Approve or revise them in
the conversation. For a tricky stateful requirement, ask for a concrete
before/action/after example and check its expected result yourself or with
strong-model review. Slices are registered with `tinysdd task add` and become
dispatchable only after `tinysdd task approve`.

## Implement one approved task

Dispatch the approved task to a configured small-model worker, or implement it
in the current harness. For example:

> I approve task 01. Dispatch it to the `local` worker and report the outcome,
> the changed files and the observed check results. Do not apply or review it
> yet, and stop after this task.

`tinysdd worker start --task ID` launches the worker (poll it with
`tinysdd worker status`); `worker run` is the foreground form. The worker works
in a sandboxed disposable copy with file read, write and edit tools and no
shell; Pi workers also get `run_checks` for the task's declared checks. It
returns a retained candidate and patch and never changes the project. Missing facts or contradictory
prerequisites come back to you rather than becoming silent scope changes. The
on-disk task and packet support a fresh conversation; the CLI records an
approval but does not authenticate who gave it.

## Review, then decide

Ask the strong model to review the candidate against the specification and
actual checks. Use the repository's existing tests, compiler and lint checks when
available, plus acceptance checks that do not merely repeat the implementer's
assumptions. Worker-visible checks are feedback, not acceptance evidence. The
[review lessons](feature-review-lessons.md) show why test names, counts and a
self-review statement are insufficient.

> Review task 01 against the approved behavior. Inspect its code and test
> expectations, confirm original tests and unrelated files are preserved, and
> distinguish observed checks from claims. Give me concrete findings. Do not
> silently repair the implementer's code or start task 02.

You then apply the candidate (`tinysdd task apply`) and record a verdict
(`tinysdd task review --verdict accepted|revision|blocked`), or revise the
specification. Only then authorize the next task. At the end, verify the
complete feature through its public interface and decide whether to accept it;
`tinysdd feature accept` runs the configured integration check first.

The pilot's two-invocation/six-minute task budget was an experimental bound,
not a product requirement. Worker limits come from the worker's profile and
configuration; choose task and review budgets openly for the repository and
feature. An incomplete handoff stays incomplete even if the retained code
passes checks.

## What remains to validate

The pilot tested consumption of a carefully prepared synthetic feature. It did
not establish repeatable strong-model preparation, operator usability, cost
savings, or production reliability. The next test should use an
operator-selected held-out feature and include the preparation conversation
itself ([#110](https://github.com/ivo-toby/tiny-sdd/issues/110)).
