# Agent instructions for tiny-sdd

TinySDD is an operator-led spec-driven development workflow for small (20–30B)
implementation models. A strong model prepares specs, slices and context; a small
model implements one bounded slice in a sandboxed disposable copy; the operator
approves and accepts. Start with `README.md`, `docs/current-scope.md` and
`docs/worker-runtime-next.md`. Work is tracked in GitHub issues (epics #2–#6).

## Setup and tests

- Node ≥ 22, ESM (`.mjs`), **no dependencies**. There is nothing to install.
- Run the suite with `TYPESAFE_API_KEY=stub npm test`. All tests must pass.
  Without that variable, 5 semantic-gate tests fail because the missing key
  short-circuits before the stubbed judge is called; that is not your bug.
- Run one file with `TYPESAFE_API_KEY=stub node --test tests/<file>.test.mjs`.
- Tests must not need network access, Pi, bubblewrap or a model. Worker tests use
  the fake Pi runtime in `tests/worker.test.mjs` (`runtime: { test: true, ... }`,
  enabled by `TINYSDD_WORKER_TEST=1` in that file's setup); CLI tests exec
  `bin/tinysdd.mjs` as a subprocess.

## Conventions

- **Quotes:** match the file. `src/worker.mjs`, `src/pi-environment.mjs` and
  `tests/worker.test.mjs` use double quotes; `src/controller.mjs`, `bin/`,
  `src/config.mjs`, `src/fs-utils.mjs` and the other tests use single quotes.
- **Errors:**
  - controller and CLI: `tinyError(CODE, message, details)` from
    `src/fs-utils.mjs`, with an UPPER_SNAKE code;
  - worker: `WorkerError`; Pi environment: `PiEnvironmentError`.
- **CLI output:** `--json` prints exactly one JSON object on stdout; progress and
  warnings go to stderr. Human output stays short.
- **Comments:** few, and only to explain why. No new top-level dependencies, no
  build step.
- **Controller state** (`.tinysdd/runs/controller.json`, `schemaVersion: 1`):
  - new fields must be optional, and existing state files must stay valid;
  - existing approvals must stay fresh unless the issue says the change is meant
    to invalidate them;
  - add a backward-compatibility test whenever you touch state, approval or
    packet shapes.
- **Docs:** when behavior changes, update `docs/quickstart.md` and
  `skills/tinysdd/references/cli-workflow.md`. In `docs/worker-runtime-next.md`,
  update only the issue's row in the section 3.7 table unless the issue says
  otherwise.

## Boundaries (non-negotiable)

- No arbitrary command execution inside the worker's inference sandbox; no
  credentials near code that is executed.
- Worker output is never verification or acceptance evidence. The controller
  records operator decisions; it never accepts on its own.
- No silent model or provider fallback.
- Workers never modify the source project; nothing applies patches unless an
  issue explicitly specifies that command.

## Off-limits unless the issue explicitly says otherwise

- `src/jev.mjs`, `src/semantic-policy.mjs`, `docs/jev-*`, and the semantic-gate
  code in `src/controller.mjs` (`semanticGateDecision` and the gate section at
  the top of `reviewTask`). This is the operator's in-progress work.
- `experiments/` (frozen measurement tools and run records) and dated result
  reports such as `docs/*-results-*.md`.

## Workflow

- One issue per branch: `feat/<issue-number>-<slug>`, based on `main`.
- Issues that touch `src/controller.mjs` or `bin/tinysdd.mjs` are done one at a
  time. Rebase on `main` before opening the PR.
- The PR title ends with `(#N)`. The body has these sections:
  - **Why**;
  - **What**;
  - **Verified:** the exact commands and test counts you ran;
  - **Not verified:** for example live Pi/bubblewrap behavior;
  - `Closes #N`.
- Keep commits small and focused, with messages that explain why.
- Stay inside the issue's scope. If the issue is ambiguous, contradicts the code,
  or needs a product decision (anything that changes what approval, acceptance
  or verification means), stop and ask in the issue or PR instead of choosing.
- Prefer a test that fails without your change (check it by temporarily reverting
  the change) for every behavior you add.

## Evidence

Report only test results you actually ran, with exact counts. Never claim
live-model, Pi or bubblewrap behavior you did not observe; say it is unverified.
