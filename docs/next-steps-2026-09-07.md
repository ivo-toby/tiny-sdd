# TinySDD: proposed next steps

Date: 2026-09-07
Status: resumption plan; implementation below has not been completed.

Checkpoint update: the user subsequently requested committing the current work
to `main`. The initial source/documentation/benchmark-assets checkpoint is being
recorded there; raw `experiments/runs/` captures are retained locally and ignored.
The no-commits observation below describes the readiness check before that
checkpoint. The functional and documentation follow-ups remain open.

## Starting point

TinySDD is usable for a bounded feature with a strong outer agent preparing
specifications, tasks and context, smaller models implementing, and the outer
agent verifying and reviewing results. Quality through explicit SDD artifacts
is the objective; reducing operator involvement is not. Do not use WDD.

The readiness check on 2026-09-07 found:

- All 44 deterministic tests passed with
  `TINYSDD_TMPDIR=/home/ivo/workspace npm test`.
- The CLI help works; Node 24.15.0, Pi and bubblewrap are installed locally.
- Approvals, dependency invalidation, compiled context, isolated candidates,
  revision feedback and baseline replay are implemented.
- Workers return patches and evidence. The outer agent runs verification,
  reviews, applies accepted changes and records acceptance.
- Documentation contains stale progress summaries. The repository has no
  commits yet and its implementation is untracked.
- The only bundled worker profile, `profiles/qwen36-titan.json`, explicitly
  disables thinking. It is historical experimental configuration, not the
  user's desired medium-thinking default.

This check did not run a new live-model feature or establish general reliability.

## Proposed order

1. **Make the recommended setup match the intended workflow.** Preserve the
   old non-thinking profile as historical evidence. Add an explicitly named,
   tested medium-thinking profile for the chosen exact Qwen deployment and
   update the quickstart to use it. Verify the actual Pi request configuration;
   a profile label alone is not evidence of the reasoning level. Keep direct
   model IDs for experiments so fallback cannot contaminate results.

2. **Reconcile the current documentation.** Update README, HANDOVER and
   current-scope summaries against retained run artifacts and the target
   repository. Distinguish historical failed runs from later accepted work.
   Do not infer the current Podcast-MCP completion state from old reports.
   Document one clear route from feature spec through task/context preparation,
   worker dispatch, verification, review, revision and acceptance. Link the
   existing skill and context compiler guide rather than duplicating them.

3. **Run one small real feature through the complete flow.** Prefer a bounded
   remaining Podcast-MCP task if inspection shows a suitable unfinished slice;
   otherwise select a small feature with explicit acceptance criteria. The
   outer agent prepares the spec, exact interfaces and focused context before
   dispatch. Use `worker start` and poll `worker status` so a short-lived shell
   does not terminate an active worker. Set an explicit revision allowance and
   distinguish a slow, active model from a stalled run. Verify the candidate
   in a disposable environment, review the diff and tests, then apply only
   accepted changes and run integrated regressions. Record any strong-model
   code repair separately from worker output.

4. **Turn the outcome into one measured improvement.** Attribute problems to
   the brief, missing context, runtime compatibility, model implementation or
   verification. Change the relevant prompt, skill or context rule and replay
   against a frozen baseline when comparing results. Record first-pass versus
   reviewed acceptance, revisions, tool calls, elapsed time, scope violations
   and assistance. Do not treat a small sample as a model ranking.

5. **Prepare a reproducible first checkpoint.** Review the untracked tree and
   separate product files, reusable benchmark assets and raw run captures.
   Check captures for credentials, private source and machine-specific data
   before selecting material for GitHub. Prepare an initial commit/release
   candidate with setup instructions and the recorded validation results.
   Public benchmark assets and broader project-origin documentation remain
   follow-ups; do not blindly stage or publish the entire experiments tree.

## Completion criteria for the next increment

- The recommended worker setup uses verified medium thinking.
- A user can follow the quickstart without stale profile/status guidance.
- One real feature completes the visible TinySDD flow with linked specification,
  task packets, worker evidence, independent checks and acceptance review.
- The existing deterministic suite passes after changes.
- Limitations and any operator/model assistance are recorded honestly.

The practical target is a workflow Ivo can try with confidence, not a larger
harness rewrite. Automatic patch application, additional worker adapters and
a broad benchmark/model-profile database are not prerequisites.

## Deployment detail to remember

On 2026-09-06 a custom Titan Qwen 3.8 Q4_K_S template was deployed to accommodate
multiple system messages by merging them into a leading system block. A short
request succeeded through `talon-local`. That establishes transport
compatibility only: relocating later instructions can affect chronology and
behavior. Record the deployed template revision in future experiments, and
include a realistic tool-history check before calling it qualified for general
agent use. Reconfirm live routing instead of assuming yesterday's aliases.

## Suggested resumption request

> Read docs/next-steps-2026-09-07.md and inspect the current state. Correct the
> recommended medium-thinking setup and stale documentation, then use TinySDD
> for one bounded real feature with strong-model preparation and review. Keep
> evidence of worker output and any assistance. Do not use WDD.

References: [quickstart](quickstart.md), [context compiler](context-compiler.md),
[current scope](current-scope.md), [TinySDD skill](../skills/tinysdd/SKILL.md).
