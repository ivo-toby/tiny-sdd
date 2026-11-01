# Orchestrating TinySDD development

This is the runbook for the agent that orchestrates work on this repository: it
plans the issue queue, writes implementation notes, dispatches implementers,
reviews their PRs and keeps the operator informed. Implementers only need
`AGENTS.md`. The state below is a snapshot from 2026-11-01 (`main` at
`8e64b03`, v0.15.7); check GitHub before acting on it.

## Roles

- **Operator (Ivo).** Decides anything that changes what approval, acceptance or
  verification means, and says when a PR may merge. Runs the live model, Pi and
  hardware checks that agents cannot.
- **Orchestrator.** Writes the "Implementation notes for agents" section on each
  issue, dispatches one implementer per issue, reviews every PR, relays
  decisions. It does not merge without the operator's go-ahead, and it does not
  choose product meaning; it asks.
- **Implementers.** One issue per branch, following `AGENTS.md`.

## State on main

Everything in the 2026-10-03 queue has landed (task apply/close/supersede, the
check runner wired to the worker as `run_checks`, slice-DAG `status`, the
benchmark harness, usage accounting, the macOS worker #13, the format spec and
SDD skills). Since then: the profile registry (#123), the OpenCode harness kind
(#153) and worker type (#155), the Linux relay-only network (#152), the runner
interface (#154), Pi 1.4.0, per-task workers and escalation, grouped help
(#173), `change validate|export` (#175), the macOS Seatbelt check runner (#176),
profile limits as defaults (#174), multiple named checks per slice (#181), the
TypeScript typecheck advisory (#187), incomplete runs as revision bases
(#189), OpenCode `run_checks` and Seatbelt runner hardening (#182), workspace
links in dependency mounts (#195), the Pi tool-loadout check (#197), atomic
apply with `--exclude` (#198), dependent applies that extend a prerequisite
(#202) and the Git-listed feature projection (#206, reopened).
`git log` has the details.

Open PRs: none at the snapshot.

## Queue

Issues that touch `src/controller.mjs` or `bin/tinysdd.mjs` run one at a time.
Everything else can run in parallel. "Notes" means the issue has an
"Implementation notes for agents" section and can be dispatched. Check each
issue for notes and the files it touches before dispatching.

- **Bugs:** #179 (secret-path rule blocks `.env.example`), #180 (worker aborts
  on a tracked symlink), #190 (`task review` accepts a task with no applied
  run), #206 (`feature accept` and project symlinks, reopened), #209 (macOS
  `feature accept`: the `node_modules` mount breaks module resolution). #190
  changes what acceptance binds: get the operator's decision first.
- **Enhancements:** #191 (run copies under `.tinysdd/runs` break repo-wide
  tools), #201 (warn when a sibling slice can stale another's approval).
- **Experiments (operator-run, live models):** #110 to #117, #9, #33, #41.
- **Decision models:** #40; must not refactor `src/jev.mjs` or
  `src/semantic-policy.mjs` without the operator.
- **Operator decisions:** #38 (engagement levels), #39 (what plan-level
  approval means).

## Decisions already made

- **#62 apply approval:** only the final lineage run's retained packet approval
  digest must match the task's current approval. Missing/mismatched digest is
  `RUN_APPROVAL_MISMATCH` before writes; no override.
- **#36 unavailable runner:** a checks packet continues without the extension
  or tool, with explicit runtime metadata/result warning and CLI stderr warning.
  No new Seatbelt channel grants. #7/#24 config identity includes availability.
  (Superseded on macOS: #176 added the Seatbelt check runner and #197 grants
  the Pi sandbox the check channel.)

Don't relitigate these; cite them in notes when relevant.

- **Objective.** The objective is fewer frontier tokens per accepted feature;
  local compute counts as free. Slicing is the default for small workers, with
  one or two files per slice, its own test file, and direct imports.
- **#16: what context approval covers.** Approval binds the cited lines of a
  context manifest, not whole files. Approvals recorded before that change keep
  a legacy whole-file digest and stay fresh through a fallback.
- **#17: protected files.** Editing a protected file makes accepted slices
  `stale`, the same as editing a brief (option A). Acceptance gets no separate
  protected-digest field.
- **#15 `task apply`.**
  - Completed runs only: `--allow-incomplete` was rejected.
  - Apply before accept.
  - While an apply is recorded, dispatch is refused (`TASK_APPLIED`), and a
    `revision` review clears the record.
  - Only files apply wrote are pinned to the run's starting copy.
  - A run that rewrites the task's own brief, context or checks is refused
    (`APPLY_CHANGES_TASK_INPUT`).
  - An apply that would leave the approval stale is refused before writing
    (`APPLY_WOULD_STALE`).
- **#26: check runner.**
  - Checks never run as root: on Linux a root caller drops to `65534:65534`
    through `setpriv`, and without `setpriv` it refuses.
  - The process limit is the target uid's current task count plus a headroom.
  - `/work` is a size-limited tmpfs.
  - Hosts other than Linux and macOS get `CHECK_RUNNER_UNAVAILABLE`. Since
    #176, macOS runs checks under Seatbelt as the caller; Seatbelt cannot drop
    privileges, so a root caller is refused.
- **#12: benchmark replays** refuse a checks file that changed since approval
  (`STALE_BENCHMARK_CHECKS`).
- **No silent fallbacks.** No silent model fallback, no credentials near
  executed code, and worker output is never acceptance evidence. See the
  `AGENTS.md` boundaries.

## Known follow-ups without an issue yet

- **`task add` allows the task's own inputs in `--allow`.** It accepts an
  allowlist containing the task's own brief, context or checks file. Apply
  refuses such runs; rejecting the overlap at `task add` and `task update` would
  fail earlier.
- **`docs/cli-v0-implementation.md` is stale.** Lines 54, 111 and 116 predate
  `task apply` and cited-line digests.
- **Check runner as non-root.** A fork storm can still slow the user's other
  processes until the timeout. A cgroup `pids.max` would isolate it.

## Writing implementation notes

Notes are what let a cheap implementer succeed. The ones on #12, #17, #18 and
#27 are good models. Every set of notes states:

- **Setup:** read `AGENTS.md` first, the base (`main`) and the branch name.
- **Ordering:** which files it touches, whether the controller/CLI serialization
  applies, and any "start after #N".
- **Code:** every function, constant and error code by the name it has today.
  Grep for each one before writing it down. Notes that name code that doesn't
  exist cost a review round.
- **State compatibility:** new fields optional, `?? null` on both sides of any
  new approval binding, and a backward-compatibility test.
- **Tests:** concrete cases, which file, and that file's quote style. Each new
  behavior needs a test that fails with the change reverted.
- **Docs:** `docs/quickstart.md`, `skills/tinysdd/references/cli-workflow.md`,
  and only the issue's row of the section 3.7 table in
  `docs/worker-runtime-next.md`.
- **Decisions:** anything the issue leaves open. Either decide it, recorded as
  the operator's decision, or ask the operator first.

Before writing notes, check the issue's premise against the code. #16's premise
turned out to be false (the compiled context hashed whole files). Cheap
implementers follow notes literally, so a wrong premise or a wrong "mirror X"
instruction becomes a bug: #12's notes caused the missing benchmark checks-digest
check.

## Reviewing a PR

Work in a detached worktree of the PR head and check:

1. **Base and whitespace.** The branch is on current `main`
   (`git merge-base --is-ancestor origin/main HEAD`), and
   `git diff --check origin/main` is clean.
2. **The suite.** `TYPESAFE_API_KEY=stub npm test`, with exact counts. Then the
   same with:
   - `TMPDIR` pointing at a symlink to a real directory (macOS temp paths are
     symlinks). Put both the link and its target outside every git repository
     and on a path that uid 65534 can traverse:
     ```sh
     mkdir -p /var/tmp/tinysdd-real && chmod 1777 /var/tmp/tinysdd-real
     ln -sfn /var/tmp/tinysdd-real /var/tmp/tinysdd-link
     TMPDIR=/var/tmp/tinysdd-link TYPESAFE_API_KEY=stub npm test
     ```
     Inside a repository, an enclosing `.gitignore` or `.git/info/exclude` can
     hide the test projects from `git ls-files`. Under a 0700 directory, a root
     run's check runner drops to `nobody` and can't reach its scratch copy.
     Both produce dozens of false failures (an "empty worker workspace" error,
     or the whole check-runner suite failing), not product bugs;
   - macOS emulated:
     ```sh
     printf "Object.defineProperty(process, 'platform', { value: 'darwin' });\n" > /tmp/fake-darwin.mjs
     NODE_OPTIONS=--import=/tmp/fake-darwin.mjs TYPESAFE_API_KEY=stub npm test
     ```
     Expect the three Linux-only `worker stop` tests, the Linux worker network
     isolation test and the check-runner suite (no `sandbox-exec` on Linux) to
     skip. As root, the stubbed Seatbelt check-runner tests skip too.
3. **Check-runner changes on a Linux host with bubblewrap.** Also run, as an
   unprivileged user:
   ```sh
   env -i PATH=/usr/bin:/bin HOME=/tmp TMPDIR=/tmp TYPESAFE_API_KEY=stub setpriv --reuid=65534 --regid=65534 --clear-groups "$(command -v node)" --test tests/check-runner.test.mjs
   ```
   Root skips different tests than `nobody`; both runs matter. Seatbelt
   behavior can only be observed on a real macOS host; ask the operator.
4. **Reverts.** Revert the source change and confirm that the new tests fail;
   restore it and compare the files.
5. **Edge-case probes.** Use `node -e` on parsers, path validation and regexes.
   Feed regexes 512 KB of adversarial input: #57's first version took 20 s on
   `"new Promise<"` repeated.
6. **Scope.** Off-limits files are untouched (`src/jev.mjs`,
   `src/semantic-policy.mjs`, `docs/jev-*`, `experiments/`, and the
   semantic-gate code in `src/controller.mjs`), and docs are updated as
   `AGENTS.md` requires.
7. **State.** New state fields are optional, existing approvals stay fresh, and
   a backward-compatibility test exists.

Post the result as a `COMMENT` review: PRs come from the operator's account, so
approving isn't possible. Use the sections **Checked**, **Must fix** and
**Optional**. Quote measured numbers, and say what you could not verify.

When the operator says to merge, use a merge commit with the expected head SHA.

For a PR you own:
- reply on each review thread with the fixing commit, then resolve the thread;
- rebase onto `main` before re-review, using `--force-with-lease` against the
  SHA you last pushed;
- update the PR body's Verified section, because reviewers read it.

## Bugs reviews caught in this round

Look for these first. Each one reached a PR.

- **Mirroring an existing binding without its guard.** #12's benchmark packet
  did not check the checks digest against the approval.
- **A state transition that changes what a freshness check reads.** Applying a
  file the context cites; pinning files apply didn't write; a run rewriting its
  own brief or manifest.
- **"Identical" or "unchanged" checks that only look at the files the code just
  touched.**
- **Process-limit guarantees that silently don't hold.** `RLIMIT_NPROC` is not
  enforced for root, and it counts every task the uid has on the host.
- **Platform assumptions.**
  - `process.getuid` doesn't exist on Windows.
  - macOS temp paths are symlinks.
  - Node 26's default test reporter is `spec`, not TAP, so never assert on TAP
    lines without `--test-reporter=tap`.
- **Unbounded regex quantifiers before an optional closing token.**
