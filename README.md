# TinySDD

TinySDD explores operator-led, spec-driven development for bounded software
features. The operator owns product decisions, approvals, progression and final
acceptance.

A strong model may clarify requirements, prepare specifications and tasks, and
review results. Qwen, Gemma and Nemotron are target implementation runtimes for
bounded tasks. The quality and reliability goal is correct agreed behavior with
deliberate review; reducing supervision is not the objective.

## Status

This is a research prototype. Skills and artifacts are designed to work inside
an ordinary coding agent, initially Pi. The agreed
[controller/worker direction](docs/controller-worker-design.md) adds one CLI for
both skill-driven control and callable workers, with project configuration and
named workers. The dependency-free v0 CLI now implements the initial
controller/configuration and Pi-worker surfaces; see the
[quickstart](docs/quickstart.md) for its qualified usage. It remains a controlled
prototype, not a production-reliability claim.
There is no WDD dependency. Scripts under `experiments/` are measurement tools.

The [current scope](docs/current-scope.md) is authoritative. It describes the
operator-led workflow, evidence rules and boundaries for the next increment.
The [operator walkthrough](docs/operator-walkthrough.md) shows the intended
in-agent experience; [review lessons](docs/feature-review-lessons.md) capture
what the first feature pilot exposed.

## Current feature experiment

[Experiment 004](docs/podcast-titan-q3-results-2026-09-05.md) ran Qwen against
the real `mcp-podcast-generator` repository in an isolated copy. Task01's job
manager is accepted; task02's extraction passes independent checks but remains
unaccepted after incomplete test review and an exhausted repair allowance. The
[focused-repair continuation](docs/podcast-focused-repair-results-2026-09-05.md)
ended with a factory suite that fails to load; tasks03/04 did not run. The
original repository and global Pi configuration are unchanged.

The [CLI Titan pilot](docs/cli-pilot-results-2026-09-06.md) is complete. Gemma's
bounded candidate passed review after one revision; Qwen remained blocked by
incorrect tests, and North by scope violations and incompatible tests. The CLI
retained those failures and never applied or accepted worker output itself.
Start with the [quickstart](docs/quickstart.md); the deterministic suite passes
44 tests. This is a usable local prototype, not unattended production tooling.

[Experiment 003](experiments/003-idempotent-reservations/README.md) records the
completed bounded idempotent-reservation workflow pilot. Its
[protocol](experiments/003-idempotent-reservations/protocol.md) defines the
roles, limits and interpretation rules; its
[results report](experiments/003-idempotent-reservations/results-2026-09-05.md)
records three Qwen attempts and one Gemma transfer: all reviewed outputs passed
the 24 independent feature checks and nine original regressions, with review
corrections and process gaps recorded separately.

The experiment-local preparation and consumption skills are retained with the
feature artifacts:

- [tinysdd-prepare](experiments/003-idempotent-reservations/skills/tinysdd-prepare/SKILL.md)
- [tinysdd-task](experiments/003-idempotent-reservations/skills/tinysdd-task/SKILL.md)

The [product skill](skills/tinysdd/SKILL.md) now covers both CLI roles and explicit
review/revision. Frozen experimental skills remain separate; none are installed
globally.

For bounded implementation calls, the [context compiler](docs/context-compiler.md)
can bind concise implementation facts and exact source/test excerpts to a task
approval, so a small worker receives a focused, auditable packet rather than a
large undifferentiated repository context.

## Boundaries

Earlier unattended pilot approvals were explicitly simulated, not actual human
acceptance. Experiment004 used actual operator delegation to primary review.
Its remaining work needs a new task02 invocation allowance; no automatic
budget reset, model substitution or production acceptance is implied.
Finite pilot outcomes do not establish general model capability or production
reliability. Real human acceptance remains pending.
