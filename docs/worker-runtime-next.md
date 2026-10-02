# Worker runtime: next iteration

Date: 2026-10-02. Status: design, with the smaller items prototyped and tested
on branch `docs/worker-findings`. Nothing in this document was observed with a
live model during this work; the live evidence is the operator's talon and
botforge runs cited below. The controller/approval model is unchanged.

Sources: the operator notes [fix-worker-runtime-findings](fix-worker-runtime-findings.md),
[fix-gitignore](fix-gitignore.md) and [fix-context-compaction](fix-context-compaction.md),
the operator's two same-day follow-ups (run 4; first successful slice), and the
shipped Pi 0.84.4 packages (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`), read for their tool, extension, thinking and
compaction behavior.

## Summary

- The talon broker-contract task ran four times and produced four empty patches.
  The causes were a copy crash, two settings that looked right but were not in
  effect, and, in the two runs whose settings were right, the runtime shape. A
  read/write/edit worker cannot observe a test run, so it simulates the whole
  task in one thinking response before its first write. That simulation has no
  natural bound.
- **First positive evidence for slicing.** Slice S1 (2 files, 6 tests, a 4-fact
  manifest) completed in 159 s with zero reads and 1,422 output tokens, and was
  accepted after controller verification. It is confounded: task size, thinking
  level and manifest size all changed together (2.5).
- **The primary fix is `run_checks`**: a fixed tool that runs only the task's
  approved check commands against the current candidate, in a separate sandbox
  with no network, no credentials and no inference process. Pi 0.84.4 can expose
  it through exactly one explicit extension (verified in the shipped package;
  details in 3.1). The operator accepted the boundary, on the condition that
  resource limits exist before first use. It is design-only here.
- **Decomposition is the default path.** Slices make the worker succeed today but
  cost controller work. The friction found while slicing talon has concrete
  fixes: `task close` / `task supersede`, `task apply` with a recorded link to
  the applied run, a slice-DAG `status`, protected contract files, and possibly
  plan-level approval (3.2).
- **Prototyped on this branch:** gitignore-aware worker copy; preflight for
  thinking control and the token cap; a per-response thinking budget configurable
  in profiles; `output_limit` split into `raw_output_limit` /
  `response_token_limit`; the `no_progress` watchdog (`limits.firstWriteMs`);
  manifest validation and advisory sizing at `task add`; the `worker status`
  polling field; a single source for the timeout cap; and run measurements
  (task shape, write calls, time to first write, cited re-reads, compactions,
  cumulative usage). All are covered by deterministic tests; none were exercised
  against a live model or real bubblewrap.
- **Not changed:** context compaction stays off. In a TinySDD run the approved
  packet is the first user message, and Pi's split-turn compaction would replace
  it with a model-written summary (3.6). Only recording is implemented.

## 1. Problem

TinySDD's worker gets a strong-model-prepared packet and implements one bounded
task with Pi's read/write/edit tools in a disposable copy. Bash was removed after
the podcast checkpoint (podcast-checkpoint-results-2026-09-05.md, "What happened")
because the model ran tests inside the inference process's network and
credential context. That reason still holds. But it left the worker no way to
learn whether its code works except reasoning about it. Small local models
(Qwen 3.8 27B Q4 on llama.cpp, 128K context) are productive interactively in Pi,
where they edit, run tests and fix in small turns. As TinySDD workers on a
realistically sized task, they produced no writes until the task was cut into
slices.

## 2. Evidence

### 2.1 Talon broker-contract task as one task

Task: 8 new TypeScript files and 64 controller-written vitest tests, ~19K-token
prompt including 43 KB of compiled context, 12 facts, and ~650 cited test lines.
Worker `code-local`: Pi, LiteLLM, `openai/qwen3.8-q4s-2x128k` on Titan llama.cpp.

| Run | Settings | Outcome | Reads | Writes |
| --- | --- | --- | --- | --- |
| 1 `launch-0e0410c9` | thinking off, 20 min | INTERNAL_ERROR before the model ran: the copy hit a symlink in gitignored `data/` (246 MB of runtime state including Codex homes) | 0 | 0 |
| 2 `…12-57-09-…a8763325` | thinking "off", but the model entry had `reasoning: false` and no `thinkingFormat`, so no toggle was sent; no `maxTokens` | `output_limit` after 9 min: one response of 16384 output tokens (15579 reasoning), stopReason `length`. runtime.json still said thinking "off" | 5 | 0 |
| 3 `…13-28-54-…d65e14a4` | thinking high, qwen-chat-template, maxTokens 65536, 20 min | `timeout`: one planning response of ~54K chars drafting every file, no write call. The profile instruction "write each file as soon as its design is clear" was ignored | 9 (package.json twice) | 0 |
| 4 `…13-49-13-…88c09bed` | same as 3, 60 min | stopped by the controller at 17 min; recorded as `interrupted` | 7 (package.json twice) | 0 |

### 2.2 Run 4 in detail

After seven reads (types.ts, error-types.ts, path-policy.ts, tsconfig.json,
package.json twice, a directory read) the model produced one thinking response.
At 17 minutes it held ~140K characters (~35–40K tokens) and no tool call. The
design was finished and the model was executing the tests in its head
("revoke #1: active -> cleanupLease ... removeCalls ['mem-1'] ✓ ..."). The
reasoning was good: a correct settle-once latch and correct ordering against the
test assertions. At that rate it would have hit the 65K output cap around minute
30, still before its first write. The controller stopped it; because the
detached launcher was killed, TinySDD kept no result envelope, only `interrupted`.

### 2.3 Comparison with interactive use

The botforge repository's two TinySDD worker runs (2026-09-11, medium thinking)
also made zero writes (20 and 25 reads, one timeout). The same model alias was
productive in interactive Pi sessions in that repository: 454 messages / 366 bash
/ 109 edit / 13 write in one, and 333 messages / 251 bash / 45 edit with thinking
off in another. The differences are bash (run tests, iterate), small edits, and
a human steering in small turns.

### 2.4 What the single-task runs support

- The model doesn't fail at reasoning. It fails at the runtime shape.
  Without observable checks it replaces execution with simulation, and the
  simulation grows with what it cannot observe: with 8 files and 64 tests it
  simulates everything before it commits to a write.
- Instructions did not change that shape (run 3's profile instruction). TinySDD's
  own compiled-context rule currently ends with "Start by planning the
  allowed-file edit" (src/worker.mjs, `buildPrompt`), which points the same way.
- Two failures were configuration that looked right but wasn't in effect. Both
  are now caught before launch (3.4).
- **Not established:** that `run_checks` fixes it. The interactive sessions differ
  in three ways at once (bash, small edits, human steering). `run_checks` restores
  one of them. It is a hypothesis to test, and section 6 includes that test.
- **Throughput depends on the model** (operator). Run 4 works out to roughly
  36–40 tok/s, while ~12–15 tok/s was quoted for thinking runs in general. Any
  time-based limit is per worker, not a global default (3.3).

### 2.5 First successful slice: S1 (broker-errors-lease)

The single task was abandoned and re-cut into five dependent slices, each owning
one or two files and its own test file: S1 errors.ts + lease.ts; S2
path-validation.ts; S3 container backend; S4 allowlist.ts; S5 lifecycle.ts +
index.ts with the broker suites. Controller-owned types.ts stays fixed across
all of them. S2–S4 are running; S5, the hardest, follows.

| | Single task (runs 2–4) | S1 |
| --- | --- | --- |
| Allowed source files | 8 | 2 |
| Tests | 64 | 6 |
| Manifest | 12 facts, both large test files cited (43 KB, ~650 test lines) | 4 facts, 4 cited ranges (types.ts, TalonError, ExecutionEnvError, the slice's test file) |
| Thinking | off-not-sent / high / high | medium + qwen-chat-template |
| maxTokens / timeout | 16384 default; 65536 / 20 and 60 min | 65536 / 15 min |
| Reads before first write | 5–9, mostly cited files | 0 |
| Outcome | output cap, timeout, stopped; 0 writes | completed in 158.8 s, 5 tool calls, 1,422 output tokens (838 reasoning), both files created, no scope violations, controller files untouched |
| Controller verification | — | clean worktree, patch applied: vitest 6/6, eslint clean, tsc clean for the module; one non-blocking review note; accepted |

The worker's visible reasoning trusted the compiled context ("The types.ts
excerpt is complete (1-129). I should be able to trust it."). Every single-task
run started by re-reading the cited files.

**Confounds.** S1 differs from the failed runs in task size, thinking level and
manifest size at once, and it is the simplest slice. It shows that a small slice
can complete; it does not show which factor matters. Two runs would separate
them: S1 at thinking high, and the full task at medium (section 4).

**Friction the split exposed** (each has a design in 3.2 or 3.7):

1. No close or supersede. `task review --verdict blocked` is refused with
   `APPROVAL_STALE` once the brief changes, so the abandoned task stays in status
   as `stale_approval` forever.
2. Dependent tasks can't be approved until prerequisites are accepted
   (`PREREQUISITES_NOT_ACCEPTED`). A split the operator approved as a whole turns
   into per-slice approval calls spread over the run.
3. No apply step. The controller applies each accepted patch by hand
   (`git apply -p1 patch.diff`; the diff has `workspace-after/` on both sides),
   and TinySDD records nothing about it.
4. The timeout cap differs by checkout: 15 minutes on `main`, 60 minutes since the
   Jev gate commit, in two separate constants.
5. A hand-synced clean worktree picked up ignored files (`data/`, `.env`,
   `.codex`, `personas/`) from a stray rsync source, and the worker copy failed on
   the same `data/` symlink before any model call. A git-aware copy makes the
   clean-worktree workaround unnecessary.
6. Shell examples using `${3:+--depends-on $3}` don't word-split in zsh.

## 3. Recommendations

### 3.1 Feedback loop without bash: `run_checks` (primary fix)

**Goal.** Turn unbounded mental simulation into cheap, observed feedback: edit,
check, fix in small steps. **Non-goals.** No arbitrary command, no network, no
credentials near executed code, and no change to who verifies: worker-observed
check results are never acceptance evidence. **Operator decision:** executing
dependency code and model-written code on the host without network or
credentials is accepted, and memory/process limits are required before first use.

**Declaration and approval.** Checks are declared per task in a strict JSON file
next to the brief, registered with `task add --checks .tinysdd/tasks/<id>.checks.json`
and bound into approval exactly like the context manifest (digest in the approval
record; editing it makes approval stale). Schema sketch:

```json
{
  "schemaVersion": 1,
  "dependencyMounts": ["node_modules"],
  "checks": [
    { "id": "slice-tests", "argv": ["node_modules/.bin/vitest", "run", "src/execution-broker/__tests__/lease.test.ts"], "timeoutMs": 120000, "criteria": ["C1", "C2"] },
    { "id": "types", "argv": ["node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"], "timeoutMs": 120000 }
  ]
}
```

`argv` is an array (never a shell string); `argv[0]` is either `node` (the
TinySDD-resolved Node binary) or a project-relative executable inside a declared
dependency mount. No environment expansion. `criteria` is optional (section 5).
Declaring checks separately keeps the brief's prose "Exact check" column
human-facing and avoids parsing commands out of Markdown.

**Pi integration (verified in the Pi 0.84.4 package, not run live).**

- `--no-extensions -e <path>` loads exactly the named extension and ignores
  discovery (README "Resource Options": "Combine `--no-*` with explicit flags to
  load exactly what you need"). TinySDD keeps `--no-extensions` and adds one
  `-e /opt/tinysdd/run-checks.mjs`, bind-mounted read-only into the inference
  sandbox from the TinySDD install.
- `pi.registerTool({ name: "run_checks", parameters, execute, executionMode })`
  registers a model-callable tool (docs/extensions.md "Custom Tools").
  `--tools read,write,edit,run_checks` allowlists it alongside the built-ins.
- `typebox` and `@earendil-works/pi-coding-agent` resolve through Pi's own
  alias/virtual-module table (dist/core/extensions/loader.js), so the extension
  needs no `node_modules`.
- `ToolDefinition.executionMode: "sequential"` (dist/core/extensions/types.d.ts)
  stops `run_checks` from running concurrently with a sibling `write`/`edit` in
  the same assistant message. Pi runs sibling tools in parallel by default. The
  exact ordering guarantee needs a smoke test.
- Re-verify on any Pi upgrade: 1.0.0 is current on npm, and 0.87.0 changed
  extension boundary events.

**Execution boundary.** The extension must not execute the check itself. It runs
inside the inference process, which holds the provider credentials (the
`TINYSDD_PI_SECRET_*` environment) and has network access. The extension is a
thin client:

```text
inference sandbox (bwrap, network, credentials)         host: TinySDD worker process
  Pi --tools read,write,edit,run_checks                   captureProcess poll (100 ms)
   └ run_checks.execute(check?)                             ├ validate: declared id? budget left?
       write /tinysdd/requests/<toolCallId>.json  ───────▶  ├ copy candidate → scratch
       poll  /tinysdd/responses/<toolCallId>.json ◀───────  ├ run argv in check sandbox (below)
                                                            ├ log checks.jsonl, bounded output
                                                            └ write response atomically
```

The request directory is bind-mounted writable and the response directory
read-only into the inference sandbox. A request carries only a declared check id
(or none for "all"), so a request forged with the `write` tool is equivalent to
calling `run_checks`: it consumes budget and is logged. A file channel was chosen
over a Unix socket because a fake Pi can drive it in deterministic tests.

**Check sandbox.** A separate bwrap invocation, never a descendant of Pi:

```text
bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind <node-root> /opt/node --dev /dev --proc /proc --tmpfs /tmp \
  --bind <scratch copy of candidate> /work \
  --ro-bind <project>/node_modules /work/node_modules \
  --chdir /work -- <argv>
```

It is spawned with an explicit minimal environment (`PATH`, `HOME=/tmp`, `CI=1`,
and `TZ`/`LANG` if declared), never `process.env`. `--unshare-all` includes the
network namespace. Its own `/proc` is safe: it shows only the sandbox's PID
namespace, which has no credentials, unlike the inference sandbox, which
deliberately has no `/proc`. Each run uses a fresh scratch copy of the candidate,
because tests may write caches or snapshots; the scratch is discarded afterwards.
The run is limited by a per-check wall-clock timeout with process-group kill, and
captured output is capped (1 MiB stored, ~16 KiB returned). Memory, process-count
and scratch-disk limits are required before first use: `prlimit` (address
space, process count) around the argv, plus a size-limited tmpfs for the scratch
copy. A cgroup scope (`systemd-run --user --scope -p MemoryMax=…`) is stronger
where the host has it. The runner refuses to start if it cannot apply the
configured limits.

**What the model sees.** Exit code, duration, run count against the budget, and
the tail of the output with an explicit truncation marker:

```text
run_checks slice-tests: FAILED (exit 1, 4.2 s). Check run 3 of 12.
--- last 60 of 2314 output lines; the controller keeps the full log ---
...
```

Start with the tail only. Add reporter-specific failing-test extraction (vitest
JSON, node:test TAP) only if runs show the tail is not enough.

**Budget.** `limits.maxCheckRuns`, default 12, maximum 20, sized for an
edit→check→fix loop. Check time counts toward the worker's `timeoutMs`. When the
budget is used up, the tool returns an error and the run continues. Checks run
one at a time.

**Logging and separation from verification.** Each request, accepted or not, is
a line in `checks.jsonl` in the run directory: request time, check id, argv
digest, digests of the allowed files as checked, exit code, signal, timeout,
duration, output digests and truncation. `result.json` gets
`workerObservedChecks: { source: "worker run_checks", acceptanceEvidence: false, runs: [...] }`.
Nothing in the controller reads this as verification. `task review` evidence
stays caller-supplied, and controller verification still happens separately on
the returned candidate.

**Contract change (measured, one change).** With `run_checks` present, replace
"report checks as unrun" with: call `run_checks` after each written or edited
file, fix what fails, and do not simulate test execution in reasoning. Drop
"Start by planning the allowed-file edit".

**Options considered.**

| Option | Verdict |
| --- | --- |
| A. Extension client → host runner → separate check sandbox | **Recommended.** The executed code never shares a process tree, network or environment with inference. |
| B. Extension spawns a nested bwrap from inside the inference sandbox | Rejected. The check would be a descendant of the credentialed process, and nested user namespaces are fragile. |
| C. Controller runs checks only between worker invocations | Keeps the loop coarse (one check per invocation). Useful as a fallback with `--base-run`, but it doesn't change the shape inside a run. |
| D. Bash with an allowlist | Rejected. Allowlisting shell strings is not a boundary, and this is the capability that was removed. |

### 3.2 Decomposition as the default path

**When to split.** Split by default whenever the sizing report warns. Talon gives
one failing and one passing calibration point:

| Signal (`task add` sizing) | Single task (failed ×4) | S1 (completed) | Provisional warning above |
| --- | --- | --- | --- |
| allowed files | 8 source (plus tests/types in the allow list) | 2 | 3 |
| compiled context | 43 KB | not recorded (4 facts, 4 ranges) | 40 KiB |
| context facts | 12 | 4 | — (reported, no threshold) |
| cited test lines | ~650 | the slice's own test file (6 tests) | 300 |

The thresholds are warnings only (3.5), and the 40 KiB context limit only just
catches 43 KB. S2–S5 add calibration points; S4 (allowlist, 39 tests) is the
direct test of the cited-test-lines threshold. From this branch on, every
`result.json` records `taskShape` (allowed files, facts, compiled bytes, cited
resources, cited lines, cited test lines), so each run pairs input size with
behavior.

**Smaller, focused manifests.** S1's worker read nothing and said it could trust
the excerpt; every single-task worker re-read 5–9 cited files. The manifest size
changed with the task size, so this is not yet attributable, but it suggests that
focused manifests matter as much as small tasks. Per slice, cite only that
slice's test file and the exact types and errors it uses. `observed.citedRereads`
measures the effect per run.

**Per-slice test convention** (now in skills/tinysdd/SKILL.md):

- one or two source files per slice, plus its own test file;
- slice tests import the slice module directly, never a barrel `index`, so they
  load before later modules exist; the barrel belongs to the last slice;
- controller-owned contract files (shared types, fixed tests) are identical in
  every slice and are not in any slice's allowed paths;
- declared checks for a slice run only that slice's test file, plus a typecheck
  that must not depend on modules from later slices.

**Applying accepted slices (`task apply`).** In plain terms: when you accept S1,
TinySDD fingerprints S1's files as they are in the project at that moment
(src/controller.mjs, `reviewTask` → `allowedDigest`). S2's worker copies the
project, so S1's code has to be in the project, and it has to be there before you
accept S1:

- apply, then accept: S1 `accepted`, S2 can be approved and run;
- accept, then apply: S1's fingerprint no longer matches, so S1 shows `stale` and
  S2 is blocked by S1. This was checked against the controller on this branch.

The check you asked for, that the project's files match the accepted digests
before a dependent run, already exists: `task packet` and `worker run` refuse a
task whose dependencies' acceptance is not current. What's missing is the apply
step itself and a record of which worker run was applied. Proposal:

- `tinysdd task apply --id S1 --run WORKER_RUN_ID --by LABEL`:
  - refuses unless the run is `completed`, scope-clean, belongs to the task, and
    its patch touches only the task's allowed paths;
  - applies the run's `patch.diff` to the project, stripping the
    `workspace-before/` / `workspace-after/` prefix (the equivalent of today's
    manual `git apply -p1`), after a `git apply --check`;
  - verifies that each allowed file now equals the run's `workspace-after` copy;
  - records `applied: { runId, patchSha256, appliedAt, by, files }` in task state.
- `task review --verdict accepted` then works as today: it binds the project's
  content. It adds `appliedFromRun: { runId, identical }`, where `identical:
  false` means the controller edited the files during review, which is allowed
  and visible.
- This changes the v0 rule that the CLI never applies a patch. The operator asked
  for the command, and it only runs when called explicitly, never automatically.
- **Rejected:** overlaying accepted dependency patches into the dependent worker's
  workspace the way `--base-run` does. The worker would see code the project might
  not contain, and acceptance binds the project.

**Close and supersede.** A re-cut task currently can't be retired: `blocked`
needs a current approval, so once its brief changes it stays `stale_approval`.

- `task close --id OLD --by LABEL --reason TEXT` (smallest fix): a terminal
  `closed` status, left out of `next`, with no approval required. Refused while
  other open tasks depend on it, and those tasks are listed.
- `task supersede --id OLD --with S1,...,S5 --by --reason`: `close` plus a
  recorded link to the successors, so the feature history shows the re-cut.

**Plan-level approval (needs an operator decision on meaning).** Today each
task's approval records the acceptance digests of its dependencies, so S5 cannot
be approved before S1–S4 are accepted. A plan approval would record, once, the
shape of every slice: brief, context and checks digests, allowed and protected
paths, dependencies. A slice whose dependencies become accepted is then treated
as approved without another call, provided its shape still matches the plan
record. Its approval is materialized with `source: "plan"` and the dependency
acceptances current at that moment. Any change to a slice's brief, context or
paths falls back to per-task approval. The meaning that changes is that the
operator approves S5 in advance against whatever S1–S4 end up being accepted as.
That is the operator's call (open question 17).

**Protected contract files: `task add --protect FILE[,FILE]`.** Talon's
`types.ts` and controller-written tests were in `--allow` because the task
predated the decision to fix them, so only a manifest fact protected them.
Proposed semantics:

- protected paths must exist and must not overlap `--allow`;
- the packet lists them, and the worker prompt marks them read-only contract;
- a change to a protected path is a scope violation with reason
  `protected contract file`;
- approval binds their digests (a changed contract makes approval stale), and
  acceptance snapshots them alongside allowed files (open question 7).

**`task update`.** `task update --id ID [--brief] [--context] [--checks]
[--allow] [--protect] [--depends-on]` validates like `add`, keeps the previous
shape in `task.revisions[]`, and lets approval go stale through the existing
shape and digest binding. Refuse it on accepted tasks; use supersede instead
(open question 5).

**Feature-level view.** `status --json` adds topological `order` and
`dependents`; human `status` renders the slice DAG:

```text
broker-s1  accepted (applied from worker-…)
├─ broker-s2  ready
├─ broker-s3  pending_approval
├─ broker-s4  blocked (requires broker-s1)
└─ broker-s5  blocked (requires broker-s2, broker-s3, broker-s4)
```

An optional `--feature NAME` label on tasks groups slices of one feature.

**Cost.** Slicing moves work to the strong model and the operator: re-cutting
briefs and tests, five approvals, applying patches in order, five reviews.
Measure that cost (section 4) rather than treating decomposition as free.

### 3.3 Incremental-work shaping

- **No-progress watchdog (implemented).** `limits.firstWriteMs`, optional, below
  `timeoutMs`: with no `write`/`edit` tool start by then, the run stops as
  `no_progress` and keeps its raw events, including partial reasoning. Throughput
  is model-dependent, so set it per worker, not as a global default. For example,
  allow cited-file reads plus one bounded planning response: at the ~36 tok/s
  implied by run 4, 8K reasoning tokens take about 4 minutes. S1's first write
  came well inside its 159 s run. A model-independent variant would stop after
  N generated tokens without a write. Pi's `usage` usually arrives only when a
  response ends (streamed usage is sent in the final chunk), so the variant has
  to count streamed `message_update` delta text, not usage. Add it if
  per-worker times prove noisy.
- **Per-response thinking budget (implemented as configuration; operator
  confirms Titan honors it).** Pi sends a reasoning cap when
  `compat.thinkingTokenBudgetField` is set, sized by `thinkingBudgets` and clamped
  to leave 1,024 answer tokens (pi-ai 0.84.4, `resolveClampedThinkingBudget`).
  Before this branch a profile could not set the field, and the budgets live in
  Pi's settings.json, which the worker replaces, so they never reached a worker.
  Profiles now accept `runtime.compat.thinkingTokenBudgetField` and
  `runtime.thinkingBudgets`. Pi's defaults are minimal 1024, low 2048, medium
  8192 and high 16384. This bounds exactly what failed in runs 2–4: one response
  consuming the whole cap. It would not have affected S1, which used 838
  reasoning tokens against a medium default of 8,192. Confirm it once on Titan by
  checking a run's `usage.reasoning` against `effectiveThinkingBudget`.
- **Thinking per phase: not yet.** Run 2 (thinking actually on, despite "off"),
  run 3 (high), run 4 (high) and botforge (medium) all failed the same way, and
  S1 succeeded at medium on a small task. Rerunning S1 at high answers whether
  the level matters on small tasks before any phase switching.
- **Prompt and contract.** Remove "Start by planning the allowed-file edit" as a
  single measured change. Evidence so far says instructions are weak levers
  compared with mechanisms.
- **Steered continuation (later experiment).** The interactive sessions had a
  human sending small turns. TinySDD could resume the same Pi session
  (`--session`, with session.jsonl retained in artifacts) through
  `worker continue --run RUN --message FILE`. The message would be a recorded
  controller artifact, counted as planned steering under current-scope rules.
  This needs session retention and a recording rule; run it after `run_checks`.
- **`worker stop` (small, needed now).** Run 4 lost its result because stopping
  meant killing the launcher. `worker stop --id LAUNCH` should signal the launcher,
  which kills the Pi process group and then finalizes normally: snapshot, patch,
  and a `result.json` with outcome `stopped`.

### 3.4 Silent-config preflight (implemented)

`piRuntimePreflight` (src/pi-environment.mjs) models when Pi's
openai-completions request actually carries a thinking parameter. The rules are
read from pi-ai 0.84.4: every branch needs `model.reasoning === true`, and per
`thinkingFormat`, "off" is sent explicitly only by qwen, qwen-chat-template, zai
and together, and by deepseek/openrouter/string-thinking unless
`thinkingLevelMap.off` is null; openai and baseten send it only when
`thinkingLevelMap.off` is a string.

- **Error, before any model call:** a thinking level was requested that Pi cannot
  send. `worker run` fails in `preparePiEnvironment`. `worker start` fails before
  detaching with `WORKER_PREFLIGHT_FAILED`, and that also catches a missing
  provider, model or credential variable early.
- **Warnings:** "off" with no off toggle (run 2); no `maxTokens`, so Pi's 16384
  default applies (run 2); thinking on without a thinking budget field (runs 3–4);
  budgets configured without the field; `maxTokens` too small to leave room for a
  budget; an auto-detected format or a level marked `unverified`.
- **runtime.json:** keeps `thinking` (the requested level) and adds
  `effectiveThinkingControl`, `effectiveThinkingReason`, `effectiveMaxTokens`,
  `maxTokensSource`, `thinkingTokenBudgetField`, `effectiveThinkingBudget` and
  `preflight.warnings`. The result envelope repeats the warnings.
- **Limit:** the rules are tied to pi-ai 0.84.4 (`PREFLIGHT_BASIS`). A Pi upgrade
  means re-reading `openai-completions.js`. Non-openai-completions APIs report
  `provider-native` and are not modelled.

### 3.5 Task sizing (implemented, advisory)

`task add` and `task approve` return `sizing: { allowedFiles, contextFacts,
compiledContextBytes, citedResources, citedLines, citedTestLines, thresholds,
warnings }`, and the CLI prints the warnings on stderr. "Cited test lines" counts
compiled-context ranges in test paths (`tests/`, `__tests__/`, `spec/`,
`*.test.*`, `*.spec.*`). Thresholds are constants (`TASK_SIZE_THRESHOLDS`) and
never block. Make them configurable, or blocking with an override, only after
slice results calibrate them (open question 8).

### 3.6 Context compaction

Facts from Pi 0.84.4 (docs/compaction.md, dist/core/agent-session.d.ts):

- auto-compaction triggers when `contextTokens > contextWindow - reserveTokens`
  (default reserve 16384, `keepRecentTokens` 20000);
- a TinySDD run is one user message followed by one long turn. When that turn
  exceeds `keepRecentTokens`, Pi makes a **split-turn** cut and summarizes the turn
  prefix, which includes the first user message, where TinySDD puts the approved
  brief and compiled context;
- the summary is generated by the same model (minutes at local throughput);
- `compaction_end` events carry the summary and token counts, so raw events keep
  them.

Risks: the worker continues from a small model's paraphrase of the approved
packet, which is not auditable against approval; a summary can drop a constraint
silently; and a `reserveTokens` below `maxTokens` invites context overflow on a
long response.

Recommendation: keep compaction off (the current default) until one of these
lands, each as a measured change:

1. **Pin the packet outside compactable history.** Move the brief and compiled
   context into the appended system prompt (never compacted) and leave a short
   user message. This is a prompt-layout change, so measure it alone.
2. **Deterministic TinySDD compaction** through the extension's
   `session_before_compact` hook (Pi ships a custom-compaction example). Elide old
   tool outputs, replacing each read or check output with
   `[elided: read src/x.ts, sha256 …; re-read if needed]`, and keep the packet
   verbatim. No model call, auditable by construction, and cheaper at local
   throughput. Preferred once the extension exists for `run_checks`.

When enabled, set `reserveTokens >= maxTokens`. Recording is already implemented:
`observed.compactions` (reason, token counts, summary digest and size), plus a
result warning whenever a compaction happened. Compaction did not cause any of
the four talon failures; each failed inside a single response. S1 needed 1,422
output tokens in total. It becomes relevant when `run_checks` loops make
contexts grow.

### 3.7 Smaller fixes and gaps

| Item | State | Notes |
| --- | --- | --- |
| Gitignore-aware copy | **Implemented** | `git ls-files -z --cached --others --exclude-standard` in a Git work tree, with the existing name, symlink and size rules on top; walk fallback for non-git projects, Git errors and immutable baseline replays. Mode in `result.workspaceCopy`. An allowed file or context resource that exists but is ignored or excluded fails clearly, as does an empty listing (a project ignored by an enclosing repository). Submodule directories are copied with the walk rules. This also removes the need for a hand-synced clean worktree: ignored files in the project directory are never copied. |
| Outcome names | **Implemented** | `raw_output_limit`, `response_token_limit`, `no_progress`; `limitDetails` (for token limits: effective `maxTokens`, its source, output and reasoning tokens). Shared list in src/outcomes.mjs. Frozen `experiments/` tooling keeps its historical names. |
| Manifest validation at add | **Implemented** | `task add` compiles the manifest (schema, ranges, budget) before mutating state. |
| `worker status` polling field | **Implemented** | `data.request.status` → `data.request.launchStatus`; poll `data.status`. Documented in the skill and quickstart. |
| Thinking budget in profiles | **Implemented** | `runtime.compat.thinkingTokenBudgetField`, `runtime.thinkingBudgets`; written to the worker's temporary Pi settings; reported by the preflight. |
| Timeout cap | **Implemented (single source)** | `MAX_TIMEOUT_MS` was declared in config.mjs and pi-environment.mjs: 15 min on `main`, 60 min since the Jev gate commit. Now one constant in config.mjs, kept at 60 min. `main` stays at 15 min until this branch merges. |
| Run measurements | **Implemented** | `taskShape`, `observed.toolCallsByName`, `writeCalls`, `firstWriteAtMs`, `reads`, `citedRereads`, `repeatedReads`, `compactions`, `cumulativeUsage`. |
| `task close` / `task supersede` | Designed (3.2) | Smallest controller fix; next after `worker stop`. |
| `task apply` + `appliedFromRun` | Designed (3.2) | Requested by the operator. |
| Slice-DAG `status`, `--feature` | Designed (3.2) | |
| `--protect`, `task update` | Designed (3.2) | Controller semantics, so the open questions come first. |
| Plan-level approval | Designed (3.2) | Changes approval meaning; operator decision first. |
| `worker stop` with `stopped` outcome | Designed (3.3) | Small; next to implement. |
| Shell portability in examples | Checked | No `${var:+…}` constructs in this repository's skill or docs. Rule for future examples: one literal flag per argument, no conditional parameter expansion. |
| Cited files in workspace as read-only | Deferred | Fix note 8 suggests it if re-reads stay high. S1 had zero; `citedRereads` measures the rest. |

## 4. Measuring single task vs slices

S1 against the single task is the first data pair; it is confounded (2.5). These
comparisons attribute the effect:

| Run | Varies | Holds fixed | Answers |
| --- | --- | --- | --- |
| S1 at thinking high | thinking level | small task, small manifest | does the level matter on a small task? |
| Full task at medium, budget = sum of the slice timeouts | task size + manifest | thinking level, total time | does size matter at the slice setting? |
| Full task at medium with a slice-sized manifest (optional) | task size only | manifest focus | separates size from manifest focus |
| S1–S5 as running | — | — | can sliced delivery complete the feature? |

All runs use the same starting commit, controller-owned `types.ts` and tests,
model alias, quantization, server, proxy and Pi version (from runtime.json).

**Per worker run** (all in result.json from this branch on): `taskShape`,
`outcome`, `observed.writeCalls`, `observed.firstWriteAtMs`,
`observed.toolCallsByName`, `reads`/`citedRereads`/`repeatedReads`,
`observed.cumulativeUsage.output` and `.reasoning`,
`processTermination.elapsedMs`, `changedPaths`, `scopeViolations`,
`limitDetails`, and preflight warnings including `effectiveThinkingBudget`.

**Per task/slice:** invocations until acceptance; review rounds (revision
verdicts); controller verification on the slice's own test file (passed/total,
lint, typecheck); review findings; whether the applied content matched the
worker run (`identical` once `task apply` exists).

**Per arm (feature level):** the integrated 64-test pass count plus typecheck on
the final project; feature accepted yes/no; total worker wall time; controller
time and strong-model effort split into preparation (including re-cutting
briefs and tests), patch application, verification and review; and interventions
by type (clarification, planned review, unplanned rescue, re-cut).

**Primary outcome:** feature accepted, with all 64 controller-run tests and
typecheck green, within at most two revisions per task. **Secondary:**
first-write rate (runs with `writeCalls > 0`), time to first write, total wall
time, total output tokens, review rounds.

**Rules fixed before running:** revision allowance per task, stop conditions, and
what counts as a rescue. Keep every attempt, including stopped and interrupted
ones. With n this small, report it as a pilot. Record the decomposition's
preparation cost separately, because sliced delivery buys its result partly
with controller work.

| Arm | Run | Task shape (files / facts / KB / test lines) | Thinking | Outcome | Reads | Writes | First write | Output / reasoning tokens | Wall time | Slice tests | Review rounds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single | run 2 | 8 / 12 / 43 / ~650 | off, not sent | response cap | 5 | 0 | — | 16384 / 15579 | 9 min | — | — |
| single | run 3 | 8 / 12 / 43 / ~650 | high | timeout | 9 | 0 | — | n/a | 20 min | — | — |
| single | run 4 | 8 / 12 / 43 / ~650 | high | stopped (interrupted) | 7 | 0 | — | ~35–40K (est.) | 17 min | — | — |
| sliced | S1 | 2 / 4 / ? / 6 tests | medium | completed | 0 | 2 files | < 159 s | 1422 / 838 | 159 s | 6/6 | 0 (one note) |

## 5. Interaction with the semantic-gate (Jev) findings

The operator's POC found no demonstrated benefit from enforcing Jev, which checks
evidence coverage, not correctness. A deterministic rule requiring one explicit
passing check per acceptance criterion likely gives similar value. The `checks`
declaration from 3.1 provides that rule's input: each declared check can name
the `C<n>` criteria it covers, so "every criterion has at least one declared
check" is checkable at `task add` without a judge. Whether acceptance should then
require recorded passing evidence per criterion is a review and acceptance
decision in the gate area, which this work leaves alone. Worker-observed
`run_checks` results must never satisfy such a rule; only controller-recorded
evidence can.

## 6. Implementation plan

`run_checks` is the primary fix and the largest item. Items 1–4 come first
because they are small and remove friction from the slice run happening now.
Each item lists the checks that close it.

0. **Done on this branch** (section 8).
1. **`worker stop`.** Acceptance: with a fake Pi sleeping, `worker stop` produces
   `result.json` with outcome `stopped`, retained `stdout.jsonl`, `workspace-after`
   and patch, and a launch status of `finished`, not `interrupted`.
2. **`task close` and `task supersede`.** Acceptance: a `stale_approval` task can be
   closed; a closed task leaves `next` and status counts; closing is refused while
   open tasks depend on it, and they are listed; supersede records its successors.
3. **`task apply` and `appliedFromRun`.** Acceptance: the patch applies to a
   fixture project and is recorded; refused for a failed or out-of-scope run, a
   run from another task, or a patch that doesn't apply; post-apply files equal
   `workspace-after`; review records `identical`; accepting before applying is
   still detectable as `stale`.
4. **Slice-DAG `status` and `--feature`.** Acceptance: topological order and tree
   rendering in a CLI test; the applied run is shown per accepted slice.
5. **`--protect` and `task update`.** Acceptance: overlap with `--allow` is
   rejected; a worker change becomes a `protected contract file` violation; a
   content change makes approval stale; update keeps `revisions[]`, invalidates
   approval and is refused on accepted tasks.
6. **`run_checks` A, declaration.** Strict `checks.json` schema validated at add;
   its digest is in approval; editing it makes approval stale; `argv[0]` is
   limited to `node` or a declared dependency mount.
7. **`run_checks` B, host check runner with resource limits.** Fixture-project
   tests, run where bwrap is installed: pass and fail are reported with bounded
   output; the check cannot reach the network (a fetch to a local listener
   fails); the environment contains only the declared keys; a write to
   `node_modules` fails; the source project is unchanged; a timeout kills the
   process group; truncation is marked; a memory or fork bomb is stopped by the
   limits; the runner refuses to start if the limits cannot be applied.
8. **`run_checks` C, Pi extension and channel.** With a fake Pi: a request gets a
   response; budget exhaustion returns a tool error and the run continues;
   unknown ids are rejected and logged; `checks.jsonl` and
   `result.workerObservedChecks` are written; acceptance code never reads them.
   Live smoke on Titan: Pi loads the extension with `--no-extensions -e`, the
   tool is listed, one round trip works, and `executionMode: "sequential"`
   orders it after a sibling write.
9. **Contract change for `run_checks`**, measured on one slice (with and without).
   Then rerun the full task with `run_checks` at slice settings: the direct test
   of the primary hypothesis.
10. **Thinking budget on Titan.** One run with `thinkingTokenBudgetField` set;
    `usage.reasoning` at or under `effectiveThinkingBudget`.
11. **Compaction**, through packet pinning or deterministic compaction (3.6).
    Acceptance: after a synthetic compaction, the packet bytes are verbatim in the
    rebuilt context (checked in the retained session file).
12. **Plan-level approval**, once the operator decides its meaning (question 17).
13. **Steered continuation experiment**, if 8–9 still show a gap to interactive use.

## 7. Open questions for the operator

Answered on 2026-10-02:

- **Check-sandbox boundary (was 1):** accepted; memory/process limits are
  required before first use (3.1, plan item 7).
- **Throughput (was 10):** model-dependent; time-based limits are set per worker
  (3.3).
- **Thinking budget (was 12):** Titan's llama.cpp and LiteLLM honor a per-request
  budget; it is now configurable in the worker profile (3.3).
- **Dependency application (was 4):** the operator asked for an apply step;
  `task apply` is the recommendation (3.2).

Still open:

2. **Where checks are declared:** a separate approved `checks.json` (recommended)
   or the brief's "Exact check" column?
3. **Should worker-observed check results** appear anywhere outside run artifacts
   (`task packet`, review tooling)? The recommendation is no.
5. **`task update` on accepted tasks:** refuse and require supersede
   (recommended), or allow with acceptance invalidation?
6. **`closed` / `superseded`:** new terminal statuses? Should dependents be
   re-pointed automatically or only listed?
7. **`--protect`:** bind protected digests into approval and acceptance?
8. **Sizing thresholds:** keep 3 files / 40 KiB / 300 cited test lines as
   provisional warnings until S2–S5 calibrate them? Configurable per project, or
   blocking with an override?
9. **Compaction:** the operator note asks to enable it. This design recommends
   holding until the packet is pinned or compaction is deterministic. Which
   route, and when?
11. **`firstWriteMs`:** stay off by default, or get a per-worker default for
    sliced tasks?
13. **Steered continuation:** do recorded controller messages into a resumed
    worker session count as planned steering under current-scope rules?
14. **Prompt sentence:** remove "Start by planning the allowed-file edit" as a
    standalone measured change?
15. **Gate tests:** five semantic-gate tests fail without `TYPESAFE_API_KEY`
    even though the judge is stubbed (the missing key short-circuits to
    "unavailable" before the stub is called). That is in the gate work, so it
    was left unchanged.
16. **Pi version:** the preflight rules and the extension surface were verified
    on 0.84.4. Which Pi version did the talon runs use (`runtime.json.piVersion`)?
17. **Plan-level approval:** may one operator approval cover a dependent slice in
    advance, activated against whatever its dependencies are accepted as, as long
    as its own brief, context and paths are unchanged?
18. **`task apply` after review edits:** if the controller fixes the applied code
    during review, should acceptance just record `identical: false` (proposed),
    or require the fix to go through a revision run?

## 8. What this branch changed, and how it was verified

| Commit | Change |
| --- | --- |
| `fix(worker): build the worker copy from git ls-files` | copy set, walk fallback, ignored-input checks |
| `fix(cli): stop worker status from echoing a stale "running"` | `launchStatus` |
| `feat(controller): validate context manifests at task add; report task size` | manifest compile at add; sizing at add/approve |
| `feat(worker): split output_limit into raw and response-token limits` | outcome split, `limitDetails`, src/outcomes.mjs |
| `feat(worker): preflight thinking control and token cap before launch` | `piRuntimePreflight`, runtime.json fields, `worker start` fail-fast |
| `feat(worker): optional no-progress watchdog (limits.firstWriteMs)` | `no_progress`, write/tool measurements |
| `feat(worker): record cited re-reads, repeated reads and compactions` | read and compaction observations |
| `feat(worker): record cumulative usage across assistant responses` | `cumulativeUsage` |
| `docs: worker runtime next iteration` | this document, skill slice convention |
| `fix(worker): refuse an empty git copy listing` | a project ignored by an enclosing repository fails clearly |
| `refactor: define worker limit caps once, in config.mjs` | single timeout/tool-call cap source |
| `feat(worker): configurable per-response thinking budget in profiles` | profile budget field and budgets, temporary settings, preflight report |
| `feat(worker): record task shape in every worker result` | `taskShape`, shared `contextSizeMetrics` |
| `docs: add first-slice evidence and decomposition friction` | this revision |

Commands run in this environment (Node 22.22.0, Linux, no bubblewrap, no Pi):

- Baseline before any change: `npm test` → 70 tests, 65 pass, 5 fail (the
  semantic-gate tests from question 15). `TYPESAFE_API_KEY=stub npm test` → 70/70.
- After this branch: `TYPESAFE_API_KEY=stub npm test` → 91/91. `npm test` without
  the key → 91 tests, 86 pass, the same 5 gate tests fail.
- Apply/accept ordering: a scratch script against src/controller.mjs showed
  accept-then-apply → S1 `stale`, S2 blocked by S1; apply-then-accept → S1
  `accepted`, S2 `pending_approval`.
- The gate files (`src/jev.mjs`, `src/semantic-policy.mjs`, `docs/jev-*`) are
  unchanged.

Not verified: any live model behavior, real bubblewrap execution of the changed
worker, and Pi behavior at runtime. Pi facts come from reading the published
0.84.4 package source and docs, with a spot check of 1.0.0.
