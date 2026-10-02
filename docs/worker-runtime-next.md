# Worker runtime: next iteration

Date: 2026-10-02. Status: design, with the smaller items prototyped and tested
on branch `docs/worker-findings`. Nothing in this document was observed with a
live model during this work; the live evidence is the operator's talon and
botforge runs cited below. The controller/approval model is unchanged.

Sources: the operator notes [fix-worker-runtime-findings](fix-worker-runtime-findings.md),
[fix-gitignore](fix-gitignore.md) and [fix-context-compaction](fix-context-compaction.md),
the run 4 follow-up from the same day, and the shipped Pi 0.84.4 packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), read for their
tool, extension, thinking and compaction behavior.

## Summary

- The talon broker-contract task ran four times and produced four empty patches.
  The causes were a copy crash, two settings that looked right but were not in
  effect, and, in the two runs whose settings were right, the runtime shape. A
  read/write/edit worker cannot observe a test run, so it simulates the whole
  task in one thinking response before its first write. That simulation has no
  natural bound.
- **The primary fix is `run_checks`**: a fixed tool that runs only the task's
  approved check commands against the current candidate, in a separate sandbox
  with no network, no credentials and no inference process. Pi 0.84.4 can expose
  it through exactly one explicit extension (verified in the shipped package;
  details in 3.1). It is design-only here.
- **Until then, and after, decomposition is the default path.** A slice owns one
  or two files and its own test file. TinySDD should make slicing cheap: task
  supersede/update, protected contract files, recorded dependency application,
  and a slice-DAG status. Those are designed here, not built.
- **Prototyped on this branch:** gitignore-aware worker copy; preflight for
  thinking control and the token cap; `output_limit` split into
  `raw_output_limit` / `response_token_limit`; the `no_progress` watchdog
  (`limits.firstWriteMs`); manifest validation and advisory sizing at
  `task add`; the `worker status` polling field; and run measurements (write
  calls, time to first write, cited re-reads, compactions, cumulative usage).
  All are covered by deterministic tests; none were exercised against a live
  model or real bubblewrap.
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
where they edit, run tests and fix in small turns. As TinySDD workers they have
not produced a single write on a realistically sized task.

## 2. Evidence

### 2.1 Talon broker-contract task

Task: 8 new TypeScript files and 64 controller-written vitest tests, ~19K-token
prompt including 43 KB of compiled context and ~650 cited test lines. Worker
`code-local`: Pi, LiteLLM, `openai/qwen3.8-q4s-2x128k` on Titan llama.cpp.

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

### 2.3 Comparison

The botforge repository's two TinySDD worker runs (2026-09-11, medium thinking)
also made zero writes (20 and 25 reads, one timeout). The same model alias was
productive in interactive Pi sessions in that repository: 454 messages / 366 bash
/ 109 edit / 13 write in one, and 333 messages / 251 bash / 45 edit with thinking
off in another. The differences are bash (run tests, iterate), small edits, and
a human steering in small turns.

### 2.4 What the evidence supports

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
  one of them. It is a hypothesis to test, and the plan in section 6 includes
  that test.
- **Throughput is inconsistent.** The brief for this work says ~12–15 tok/s with
  thinking. Run 4's ~35–40K tokens in ~16 minutes is about 36–40 tok/s, and the
  projected 65K cap at ~30 minutes implies about 36 tok/s. Time-based limits
  depend on which figure is right (open question 10).

## 3. Recommendations

### 3.1 Feedback loop without bash: `run_checks` (primary fix)

**Goal.** Turn unbounded mental simulation into cheap, observed feedback: edit,
check, fix in small steps. **Non-goals.** No arbitrary command, no network, no
credentials near executed code, and no change to who verifies: worker-observed
check results are never acceptance evidence.

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
captured output is capped (1 MiB stored, ~16 KiB returned). Memory and process
limits (`prlimit`, or a cgroup scope) are open question 1.

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

**When to split.** Split by default whenever the sizing report warns. The talon
signals that preceded four failures are the current calibration points:

| Signal (`task add` sizing) | Talon single task | Provisional warning above | Note |
| --- | --- | --- | --- |
| allowed files | 8 source (plus tests/types in the allow list) | 3 | interactive success came from 1–2-file increments |
| compiled context | 43 KB | 40 KiB | barely catches talon; recalibrate from slice results |
| cited test lines | ~650 | 300 | |

These are implemented as warnings only (3.5). The operator's re-cut (S1–S5:
errors+lease 8 tests; path-validation 13; container-backend 8; allowlist 32;
lifecycle+index with the broker suites) is the first calibration data. S4's 32
tests may exceed 300 cited lines on its own; whether S4 succeeds is a direct
threshold test.

**Per-slice test convention.** This is now in the skill (skills/tinysdd/SKILL.md):

- one or two source files per slice, plus its own test file;
- slice tests import the slice module directly, never a barrel `index`, so they
  load before later modules exist; the barrel belongs to the last slice;
- controller-owned contract files (shared types, fixed tests) are identical in
  every slice and are not in any slice's allowed paths;
- declared checks for a slice run only that slice's test file, plus a typecheck
  that must not depend on modules from later slices.

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

**Dependency application: a finding.** `task review --verdict accepted` already
binds `allowedDigest`, the digest of the project's allowed-file content at review
time, and `status` re-checks it (src/controller.mjs, `inspectTask`). Acceptance
already means "these bytes are in the project", and a dependent worker copies the
project. So the current rule is apply, then accept. Applying after acceptance
makes the acceptance stale; never applying hides the dependency from the next
slice. What's missing is a recorded link between the accepted content and the
worker run that produced it.

- **Recommended:** `task review --run RUN_ID`. It records the run and compares the
  project's allowed files with that run's `workspace-after`. It stores
  `appliedFromRun: { runId, identical, differingPaths }`; differences are reviewed
  controller edits, allowed but visible. TinySDD still never applies a patch
  itself.
- **Alternative (boundary change):** `task apply --id ID --run RUN_ID`, which runs
  `git apply --check` and then `git apply` on the project and records it. This
  changes the v0 "never apply a patch" rule, so it's open question 4.
- **Rejected:** overlaying accepted dependency patches into the worker workspace
  the way `--base-run` does. The worker would see content the project might not
  contain, and that disagrees with what acceptance binds.

**Supersede and update.** Re-cutting talon meant closing the old task with
`--verdict blocked`, which needs an evidence file, keeps the task in `next`, and
misstates what happened, and then registering and approving five tasks.

- `task supersede --id OLD --with S1,...,S5 --by LABEL --reason TEXT`: a new
  terminal status `superseded`, left out of `next` and not "blocked"; successors
  must exist; tasks that depend on OLD must be re-pointed first, and the command
  lists them.
- `task update --id ID [--brief] [--context] [--checks] [--allow] [--protect] [--depends-on]`:
  validates like `add`, keeps the previous shape in `task.revisions[]`, and lets
  approval go stale through the existing shape and digest binding. Refuse on an
  accepted task and use supersede instead (open question 5).

**Feature-level view.** `status --json` adds topological `order` and
`dependents`; human `status` renders the slice DAG:

```text
broker-s1  accepted
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
  `no_progress` and keeps its raw events, including partial reasoning. It saves
  wall time and names the failure. Guidance: set it around cited-file reads plus
  one bounded planning response, for example prefill + 8K tokens at the measured
  throughput (about 4–5 minutes at 36 tok/s, 10+ minutes at 13 tok/s). A
  token-based variant (output tokens since the last write, from `message_update`
  usage) is more robust to throughput differences; add it only if time-based
  thresholds prove noisy.
- **Per-response thinking budget (cheapest structural lever, unverified on
  Titan).** Pi sends a reasoning cap when `compat.thinkingTokenBudgetField` is set,
  clamped to leave answer room inside `maxTokens` (pi-ai 0.84.4,
  `resolveClampedThinkingBudget`). Pi's docs name `thinking_budget_tokens` for
  llama.cpp; whether Titan's build and LiteLLM honor it is untested (open question
  12). If they do, it bounds exactly what failed in runs 2–4: one response
  consuming the whole budget. The preflight warns when thinking is on without it.
- **Thinking per phase: not yet.** Run 2 (thinking actually on, despite "off"),
  run 3 (high), run 4 (high) and botforge (medium) all failed the same way. Phase
  switching treats a symptom that `run_checks` and slicing address directly.
  Revisit with slice data: the slices run at medium.
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
  an auto-detected format or a level marked `unverified`.
- **runtime.json:** keeps `thinking` (the requested level) and adds
  `effectiveThinkingControl`, `effectiveThinkingReason`, `effectiveMaxTokens`,
  `maxTokensSource`, `thinkingTokenBudgetField` and `preflight.warnings`. The
  result envelope repeats the warnings.
- **Limit:** the rules are tied to pi-ai 0.84.4 (`PREFLIGHT_BASIS`). A Pi upgrade
  means re-reading `openai-completions.js`. Non-openai-completions APIs report
  `provider-native` and are not modelled.

### 3.5 Task sizing (implemented, advisory)

`task add` and `task approve` return `sizing: { allowedFiles,
compiledContextBytes, citedTestLines, thresholds, warnings }`, and the CLI prints
the warnings on stderr. "Cited test lines" counts compiled-context ranges in test
paths (`tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`). Thresholds are
constants (`TASK_SIZE_THRESHOLDS`) and never block. Make them configurable, or
blocking with an override, only after slice results calibrate them (open
question 8).

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
the four talon failures; each failed inside a single response. It becomes
relevant when `run_checks` loops make contexts grow.

### 3.7 Smaller fixes

| Item | State | Notes |
| --- | --- | --- |
| Gitignore-aware copy | **Implemented** | `git ls-files -z --cached --others --exclude-standard` in a Git work tree, with the existing name, symlink and size rules on top; walk fallback for non-git projects, Git errors and immutable baseline replays. Mode in `result.workspaceCopy`. An allowed file or context resource that exists but is ignored or excluded fails clearly. Submodule directories are copied with the walk rules. |
| Outcome names | **Implemented** | `raw_output_limit`, `response_token_limit`, `no_progress`; `limitDetails` (for token limits: effective `maxTokens`, its source, output and reasoning tokens). Shared list in src/outcomes.mjs. Frozen `experiments/` tooling keeps its historical names. |
| Manifest validation at add | **Implemented** | `task add` compiles the manifest (schema, ranges, budget) before mutating state. |
| `worker status` polling field | **Implemented** | `data.request.status` → `data.request.launchStatus`; poll `data.status`. Documented in the skill and quickstart. |
| Run measurements | **Implemented** | `observed.toolCallsByName`, `writeCalls`, `firstWriteAtMs`, `reads`, `citedRereads`, `repeatedReads`, `compactions`, `cumulativeUsage`. |
| `--protect`, `task update`, `task supersede`, `review --run`, status DAG, `--feature` | Designed (3.2) | Controller semantics, so the open questions come first. |
| `worker stop` with `stopped` outcome | Designed (3.3) | Small; next to implement. |
| Cited files in workspace as read-only | Deferred | Fix note 8 suggests it if re-reads stay high. `citedRereads` now measures it; decide from data. |

## 4. Measuring single task vs slices

The operator is running the five-slice re-cut now. A comparison that can
attribute an effect to decomposition needs a few things fixed in advance.

**Arms.** A: the original single task (8 files, 64 tests). B: slices S1–S5. Both
use the same starting commit, controller-owned `types.ts` and tests, model alias,
quantization, server, proxy and Pi version (from runtime.json).

**Confound to remove.** B runs at thinking medium and 30 min per slice; A ran at
high and 20/60 min. Run A at least once at B's settings: medium, with a budget
equal to B's total (5 × 30 = 150 min) and the same `firstWriteMs` if B uses one.
Label any other A runs "as-run".

**Per worker run** (all now in result.json): `outcome`, `observed.writeCalls`,
`observed.firstWriteAtMs`, `observed.toolCallsByName`, `reads`/`citedRereads`/
`repeatedReads`, `observed.cumulativeUsage.output` and `.reasoning`,
`processTermination.elapsedMs`, `changedPaths`, `scopeViolations`,
`limitDetails`, and preflight warnings.

**Per task/slice:** invocations until acceptance; review rounds (revision
verdicts); controller verification on the slice's own test file (passed/total,
typecheck); defects found in review; whether the accepted content matched the
worker run (identical or controller-edited).

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
ones. Run at least two repetitions per arm, alternating order. With n this small,
report it as a pilot. Record the decomposition's preparation cost separately,
because B buys its result partly with controller work.

Report template:

| Arm | Run | Outcome | Writes | First write | Tool calls (r/w/e) | Output / reasoning tokens | Wall time | Slice tests | Review rounds | Interventions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

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

Ordered for the slice comparison running now, then the primary fix. Each item
lists the checks that close it.

0. **Done on this branch:** copy set, preflight, outcome split, watchdog, manifest
   validation and sizing, status field, run measurements (section 8).
1. **`worker stop`.** Acceptance: with a fake Pi sleeping, `worker stop` produces
   `result.json` with outcome `stopped`, retained `stdout.jsonl`, `workspace-after`
   and patch, and a launch status of `finished`, not `interrupted`.
2. **Decomposition ergonomics.** (a) `task supersede`: the old task leaves `next`,
   with a `superseded` status and recorded successors; it is rejected while
   dependents still point at it. (b) `task update`: the old shape goes to
   `revisions[]` and the approval goes stale; it is refused on accepted tasks.
   (c) `--protect`: overlap with `--allow` is rejected; a worker change becomes a
   `protected contract file` violation; a content change makes approval stale.
   (d) `task review --run`: records identical/differing paths against
   `workspace-after`. (e) status DAG: topological order and tree rendering in a
   CLI test.
3. **`run_checks` A, declaration.** Strict `checks.json` schema validated at add;
   its digest is in approval; editing it makes approval stale; `argv[0]` is
   limited to `node` or a declared dependency mount.
4. **`run_checks` B, host check runner.** Fixture-project tests, run where bwrap
   is installed: pass and fail are reported with bounded output; the check cannot
   reach the network (a fetch to a local listener fails); the environment contains
   only the declared keys; a write to `node_modules` fails; the source project is
   unchanged; a timeout kills the process group; truncation is marked.
5. **`run_checks` C, Pi extension and channel.** With a fake Pi: a request gets a
   response; budget exhaustion returns a tool error and the run continues;
   unknown ids are rejected and logged; `checks.jsonl` and
   `result.workerObservedChecks` are written; acceptance code never reads them.
   Live smoke on Titan: Pi loads the extension with `--no-extensions -e`, the
   tool is listed, one round trip works, and `executionMode: "sequential"`
   orders it after a sibling write.
6. **Contract change for `run_checks`**, measured on one slice (with and without).
7. **Thinking budget on Titan.** A smoke run with `thinkingTokenBudgetField` set
   and `usage.reasoning` at or under the budget, or a recorded "not honored".
8. **Compaction**, through packet pinning or deterministic compaction (3.6).
   Acceptance: after a synthetic compaction, the packet bytes are verbatim in the
   rebuilt context (checked in the retained session file).
9. **Steered continuation experiment**, if 5–6 still show a gap to interactive use.

## 7. Open questions for the operator

1. **Check-sandbox boundary.** `run_checks` executes dependency code
   (`node_modules`) and model-written code on the host, without network or
   credentials. Is that acceptable, and are memory/process limits (`prlimit` or
   a cgroup scope) required before first use?
2. **Where checks are declared:** a separate approved `checks.json` (recommended)
   or the brief's "Exact check" column?
3. **Should worker-observed check results** appear anywhere outside run artifacts
   (`task packet`, review tooling)? The recommendation is no.
4. **Dependency application:** verify-only `task review --run` (recommended), or
   an explicit `task apply` that changes the v0 "never apply" boundary?
5. **`task update` on accepted tasks:** refuse and require supersede
   (recommended), or allow with acceptance invalidation?
6. **`superseded`:** a new terminal status? Should dependents be re-pointed
   automatically or only listed?
7. **`--protect`:** bind protected digests into approval and acceptance?
8. **Sizing thresholds:** keep 3 files / 40 KiB / 300 cited test lines as
   provisional warnings? Configurable per project, or blocking with an override?
9. **Compaction:** the operator note asks to enable it. This design recommends
   holding until the packet is pinned or compaction is deterministic. Which
   route, and when?
10. **Throughput:** 12–15 tok/s or ~36 tok/s (run 4)? Watchdog defaults depend
    on it.
11. **`firstWriteMs`:** stay off by default, or get a default for sliced tasks?
12. **Thinking budget:** can Titan's llama.cpp build and LiteLLM be checked for a
    per-request thinking budget before we rely on it?
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

Commands run in this environment (Node 22.22.0, Linux, no bubblewrap, no Pi):

- Baseline before any change: `npm test` → 70 tests, 65 pass, 5 fail (the
  semantic-gate tests from question 15). `TYPESAFE_API_KEY=stub npm test` → 70/70.
- After this branch: `TYPESAFE_API_KEY=stub npm test` → 88/88. `npm test` without
  the key → 88 tests, 83 pass, the same 5 gate tests fail.
- The gate files (`src/jev.mjs`, `src/semantic-policy.mjs`, `docs/jev-*`) are
  unchanged.

Not verified: any live model behavior, real bubblewrap execution of the changed
worker, and Pi behavior at runtime. Pi facts come from reading the published
0.84.4 package source and docs, with a spot check of 1.0.0.
