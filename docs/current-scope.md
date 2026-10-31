# TinySDD current scope

Updated: 2026-10-31 (v0.14.0)
Status: CLI published on npm and usable for supervised trials; production
reliability not established.

The approved 2026-09-05 v0 scope, the development working model of that time
and the September experiments are recorded in
[scope-decision-2026-09-05.md](scope-decision-2026-09-05.md).

## Direction

TinySDD is an operator-led spec-driven workflow with quality as the primary
goal. A strong model clarifies requirements and prepares specifications,
context, acceptance criteria and bounded slices, and reviews results. A
smaller model implements one approved slice at a time in a sandboxed worker
(or the current harness implements it). The operator owns product decisions,
progression and acceptance; approval and review are deliberate parts of the
product, not overhead to remove. WDD is a conceptual comparison, not a
dependency.

## State on main (2026-10-31, v0.14.0)

The [README](../README.md) is the authority for current features and limits;
GitHub issues track open work. In short, `main` has:

- **Install and setup.** The `tinysdd` npm package (Node >= 22.19.0, no runtime
  dependencies). `tinysdd setup` installs version-matched Claude Code/Codex
  skills and the model-profile registry; after an upgrade,
  `tinysdd skills update` and `tinysdd profiles update` refresh them. Projects
  are set up from a fresh agent session with the `tinysdd-setup` skill, or
  manually with `tinysdd init`.
- **Preparation.** Constitution, specify, research, plan and slice skills for
  the outer agent; the portable change format with `tinysdd change validate`
  and `change export`; cited context manifests; several named checks per slice.
- **Controller.** `task add/update/approve/packet/apply/review/close/supersede`,
  `status` and `next`, with approval freshness, protected inputs and
  dependencies. The operator records every approval and verdict; nothing is
  accepted automatically.
- **Workers.** Pi 1.4.0 or OpenCode 2.1.4 in sandboxed disposable copies
  (bubblewrap with a relay-only network on Linux, Seatbelt on macOS), with
  per-task worker choice and suggested escalation. Registry profiles are
  selected by `init --model`; their limits are defaults that worker limits
  override.
- **Checks.** The host check runner works on Linux and macOS: Pi workers get
  `run_checks`, and `feature accept` runs the configured integration check.
  OpenCode workers do not have `run_checks` yet
  ([#182](https://github.com/ivo-toby/tiny-sdd/issues/182)). `worker stop` is
  Linux-only.
- **Evidence.** Benchmarks and qualification, usage accounting, slice-test
  assessment and phase records. Harness adapters for Claude Code, OpenCode and
  interactive Pi, research packets and the living-spec archive remain
  source-checkout scripts (`scripts/`), not installed subcommands.

Open as of this date: the end-to-end and live experiments (#110–#117) and
benchmark calibration (#33); bugs #179, #180 and #190; enhancements #182,
#187, #189 and #191; and the product decisions on engagement levels (#38) and
plan-level approval (#39). Live Pi, OpenCode, bubblewrap and Seatbelt behavior
of several recent changes is unverified; see the section 3.7 table in
[worker-runtime-next.md](worker-runtime-next.md).

## Visible user workflow

1. The operator and a strong model clarify a bounded feature against
   repository code and contracts, exposing missing facts and product
   decisions.
2. The strong model prepares a concise specification, acceptance criteria and
   a few connected slices. The operator inspects and approves the behavior and
   slice boundaries before implementation (`task add`, `task approve`).
3. Each slice is handed to the worker with its brief, cited context,
   constraints, dependencies, checks and stop conditions. The handoff stays
   visible and the operator decides to proceed.
4. The worker implements that slice in a sandboxed disposable copy with file
   tools and, where available, `run_checks` for the declared checks. It
   reports missing facts instead of guessing and never changes the project.
5. The operator inspects the candidate and independently observed checks,
   supported by strong-model review. Apply and accept the slice, request a
   bounded revision, or revise the specification; do not silently advance on
   failure.
6. Verify the integrated feature through its real entrypoints and existing
   regressions (`feature accept` runs the configured integration check). The
   operator accepts the feature, not merely a list of completed slices.

Branches and commits follow the user's own policy; TinySDD does not require
automatic Git operations or a clean tree. The brief and task files on disk
support resuming after a context reset.

## What TinySDD does not promise

- Worker output and worker-visible checks are feedback, never verification or
  acceptance evidence.
- Approvals are recorded with an operator label, not authenticated.
- Nothing is accepted automatically, and there is no silent model or provider
  fallback.
- A passing benchmark or pilot does not establish reliable delivery across
  projects. Report only commands observed in tool results; a participant's
  claim that it ran a test or obtained approval is not evidence.
