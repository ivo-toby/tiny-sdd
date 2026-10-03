# Try TinySDD locally

This is an early local prototype. The controller does not require a model.
Spawned workers require Linux, bubblewrap and an existing Pi installation with
the exact provider/model configured. No package installation is needed for the
dependency-free CLI itself. Node24 is the development/test environment.
The first adapter expects Pi in the same installation's `bin` directory as the
Node executable running this CLI; other installation layouts are not qualified.
Workers create disposable candidate directories under `/tmp` by default. Set
`TINYSDD_TMPDIR` to an existing real directory on a volume with enough free
space when `/tmp` is small or shared; the worker removes its candidates after it
has retained the run artifacts under the project.

From this checkout:

```sh
npm test
node bin/tinysdd.mjs --help
```

Use `node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs` wherever the examples below
say `tinysdd`. `--project /path/to/project` selects the target explicitly;
otherwise commands use the current directory. No global npm/Pi setup is changed.

## Use it inside your coding agent

Load this checkout's [TinySDD skill](../skills/tinysdd/SKILL.md) into your agent
and ask it to prepare one bounded feature. The skill covers either implementation
inside that agent or delegation to a named worker. Product decisions and review
remain with you or the authority you explicitly delegate to the outer agent.

The first controller sequence is:

```sh
tinysdd init
tinysdd task add --id first-change --brief docs/tasks/first-change.md --allow src/example.mjs,test/example.test.mjs
tinysdd task approve --id first-change --by ivo --reason 'Reviewed this task brief'
tinysdd next
tinysdd task packet --id first-change --json
```

Create the brief first; the [template](../skills/tinysdd/assets/task-brief.md)
identifies its useful contents. Use actual approval attribution, not copied
example text. Allowed paths are exact files, including not-yet-created files;
no globs. Dependencies use `--depends-on first-change` on a later task.

You can implement the packet in your current agent without invoking a worker.
The controller never changes the model in that outer agent.

To retire a task you abandoned or re-cut, use `task close` or `task supersede`.
Neither needs an approval, so they work on a task whose approval went stale when
its brief changed. The task becomes `closed` or `superseded`, leaves `next`, and
can no longer be approved, reviewed or dispatched. They are refused for an
accepted task and while open tasks depend on it (the error lists them). A
retired task never satisfies a dependency. `supersede` records the successors,
shown under `closure` in `status --json`:

```sh
tinysdd task supersede --id broker-contract --with broker-s1,broker-s2 --by operator --reason 're-cut into slices'
```

When a worker needs an exact API, schema, or acceptance oracle, add a reviewed
context manifest under `.tinysdd/tasks/` and pass it with `--context`. TinySDD
will compile only its declared source line ranges and record their digests; see
[the context compiler guide](context-compiler.md). Omit it for genuinely simple
tasks rather than padding prompts.

## Configure a worker

For a new project configuration:

```sh
tinysdd init --worker qwen --provider titan --model titan/llamacpp/qwen3.6-35b-a3b-256k
```

For an already initialized project, edit `.tinysdd/config.json` deliberately;
re-running init does not replace it. A configuration with two named workers:

```json
{
  "schemaVersion": 1,
  "defaultWorker": "qwen",
  "workers": {
    "qwen": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/qwen3.6-35b-a3b-256k",
      "profile": "tinysdd-profiles/qwen36.json",
      "limits": { "timeoutMs": 300000, "maxToolCalls": 40 }
    },
    "gemma": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/gemma4-26b-a4b-256k"
    }
  }
}
```

Copy [the exploratory Titan Qwen profile](../profiles/qwen36-titan.json) into
the project's `tinysdd-profiles/qwen36.json` before using this configuration.
It controls Pi's request-level thinking flag; it is not a promise of code quality.
Other machines must use their own exact configured IDs. No fallback is automatic.

Before a launch, TinySDD compares the requested thinking level with what Pi will
actually send for that model entry (rules read from pi-ai 0.84.4). A thinking
level Pi cannot send, because the entry lacks `reasoning: true`, fails
`worker start` and `worker run` before any model call. Warnings cover `thinking: "off"`
with no off toggle (a Qwen chat template then thinks anyway), a missing
`maxTokens` (Pi's silent 16384-token response cap), and thinking without a
`compat.thinkingTokenBudgetField` (reasoning can use the whole response).
`runtime.json` records `thinking` (requested) next to `effectiveThinkingControl`,
`effectiveMaxTokens` and `maxTokensSource`.

To cap reasoning per response, set the request field and, optionally, per-level
budgets in the worker's profile. TinySDD writes the budgets into the worker's
temporary Pi settings; your global Pi settings are never inherited:

```json
"runtime": {
  "thinking": "medium",
  "reasoning": true,
  "compat": { "thinkingFormat": "qwen-chat-template", "thinkingTokenBudgetField": "thinking_budget_tokens" },
  "thinkingBudgets": { "medium": 8192, "high": 16384 }
}
```

Pi clamps the budget so that 1024 tokens of `maxTokens` stay available for the
answer. Without `thinkingBudgets`, Pi's defaults apply (minimal 1024, low 2048,
medium 8192, high 16384). `runtime.json` records the effective budget as
`effectiveThinkingBudget`. The server must honor the field; check one run's
`usage.reasoning` against it.

Optional `limits.firstWriteMs` (below `timeoutMs`) is a no-progress watchdog:
if no `write` or `edit` tool call has started by then, the run stops with outcome
`no_progress` and keeps its raw events, including the partial reasoning. It is
off unless set. The result's `observed.toolCallsByName`, `writeCalls` and
`firstWriteAtMs` (100 ms poll granularity) show how a run spent its time.

Optional worker `skills` lists project-relative SKILL.md files; `instructions`
lists additional project-relative text resources. Applicable AGENTS.md guidance
is included separately. Profiles cannot override task permissions. MCP and
arbitrary runtime extensions are not supported in this first adapter.

Optional `.tinysdd/config.local.json` replaces whole workers by name, not nested
fields. Arrays replace; null/unknown fields are errors. Credentials stay in Pi's
existing configuration/environment, not either project config file. Inspect
resolution before dispatch:

```sh
tinysdd config validate
tinysdd config show --worker qwen --json
tinysdd worker start --task first-change --worker qwen --json
# Poll the returned launch id until data.status is "finished".
# data.request.launchStatus is the launch-time snapshot, not current state.
tinysdd worker status --id LAUNCH_ID --json
```

To end a launch early, run `tinysdd worker stop --id LAUNCH_ID --json` rather than
killing the launcher. It signals the launcher, which stops Pi and finalizes the
run as usual: the result has outcome `stopped` (error code `WORKER_STOPPED`), and
the candidate, patch and raw events are kept. `stopped` is not acceptance; review
the candidate like any other failed outcome. `--wait-ms N` (0 to 600000, default
30000) bounds how long the command waits for the result. If finalizing takes
longer, `data.status` is `stopping`; poll `worker status` until it is `finished`.
`worker stop` signals only a process it can verify is that launch's launcher
(Linux `/proc`), and otherwise fails with `LAUNCH_NOT_OURS` without sending a
signal. Stopping an already stopping launch only waits.

## Controlled benchmark replay

To compare workers fairly after the live project has moved on, replay the
original approved packet against a prior worker's immutable `workspace-before`
snapshot. This is a non-applying experiment: it neither refreshes stale task
approvals nor changes task status. The replay records both its `baselineRun` and
the exact packet in `.tinysdd/runs/`.

```sh
tinysdd worker start --task first-change --worker gemma \
  --baseline-run WORKER_RUN_ID --json
```

Use a run from the same task. Do not use `--baseline-run` for a revision; use
`--base-run` only when deliberately overlaying a reviewed prior candidate.

## Review the result

The worker edits a disposable copy using read/write/edit only. Its result points
to local evidence and a patch under `.tinysdd/runs/`. It does not run tests,
apply the patch, commit, or accept its own result. Inference can reach the selected
provider; use only source you are authorized to send there. Raw event files may
contain source. Filename exclusions are not a general secret scanner.
The candidate omits `.git`, `.tinysdd`, `node_modules` and common credential files;
source symlinks are rejected. In a Git work tree the copy set is
`git ls-files --cached --others --exclude-standard`, so gitignored files (runtime
state, build output, local agent homes) are left out while new untracked source
is kept; outside Git the whole tree is walked. `workspaceCopy.mode` in the result
records which was used. An allowed file or context excerpt that exists but is
gitignored fails the run instead of producing an unappliable patch.
Run workers from the project itself or from a real `git worktree`, never from a
hand-synced copy: the copy set comes from Git, so ignored files in the project
directory never reach the worker, and a synced copy only adds ways to break the
`.git` link or pick up stray files. `.tinysdd/` is always left out of the copy,
whether it is committed, untracked or ignored. Put needed dependency interfaces in the task or
selected instruction resources rather than assuming the worker can inspect an
installed dependency tree.

Have your outer agent inspect scope violations and the diff, verify in an
appropriate credential-free disposable environment, and apply only the reviewed
patch. Preserve the observed checks and review findings in a project file. Then:

```sh
tinysdd task review --id first-change --verdict accepted --evidence docs/reviews/first-change.md --by ivo
tinysdd status
tinysdd next
```

Use `revision` or `blocked` instead of accepting an incomplete result. Caller
evidence is labeled as such; the CLI does not claim to have executed its tests.
For a revision, the next packet includes the recorded review feedback. Retain
that evidence unchanged until dispatch, or explicitly record the revised review.
Changes to a brief, accepted files, evidence or prerequisites invalidate affected
decisions. Approval labels are audit records, not authenticated identities.

Controller mutations use an exclusive lock. If a crash leaves a stale lock, the
CLI stops for manual inspection; it does not guess that another writer is safe
to remove. Do not remove a lock while its owning process is still active.

This version deliberately leaves verification/application in the outer harness.
It is suitable for controlled testing, not unsupervised production changes.
