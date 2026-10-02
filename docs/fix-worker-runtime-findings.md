# Fix: worker runtime findings from the talon broker-contract run (2026-10-02)

Source: TinySDD controller run in `/home/ivo/workspace/talon`, task
`broker-contract` (8 new TS files, 64 controller-written vitest tests, ~19K-token
prompt incl. 43 KB compiled context). Worker `code-local` = Pi → litellm →
`openai/qwen3.8-q4s-2x128k` on titan llama.cpp. Companion docs:
`fix-gitignore.md` (copy set + status polling), `fix-context-compaction.md`.

Observed runs (all zero writes, empty patch):

| Run | Settings | Outcome |
| --- | --- | --- |
| launch-0e0410c9 | thinking off, 20 min | INTERNAL_ERROR on copy (see fix-gitignore.md) |
| worker-…12-57-09-…a8763325 | thinking "off", model `reasoning:false`, no maxTokens | `output_limit` after 9 min: 5 reads, then ONE response hit 16384 output tokens (15579 reasoning), stopReason `length` |
| worker-…13-28-54-…d65e14a4 | profile thinking high + qwen compat, maxTokens 65536, 20 min | `timeout`: 9 reads (incl. `package.json` twice), single planning response ~54K chars, drafting every file inside thinking, never called write |
| worker-…13-49-13-…88c09bed | same, 60 min | (in progress at time of writing) |

Comparison: botforge's two TinySDD worker runs (2026-09-11, medium thinking) also
ended with zero writes (20 and 25 reads, one timeout). The same `titan/code-local`
model was productive in interactive Pi sessions in that repo (e.g. 454 assistant
messages, 366 bash, 109 edit, 13 write; another 333 messages with thinking off,
251 bash, 45 edit). The difference is the runtime, not the model.

## 1. Worker has no feedback loop (architectural; highest priority)

Bash was removed after the podcast run (docs/podcast-checkpoint-results-2026-09-05.md:73)
because the worker ran tests inside the inference process's network/credential
context. Correct reason, but it left the worker with read/write/edit only, so the
only way to be correct is to reason the whole task out before the first write.
With thinking enabled, that becomes one giant planning response that hits the
output cap or the timeout. Profile instructions ("write each file as soon as its
design is clear") did not change this.

Required change: give the worker a fixed check tool, not bash.

- New Pi tool (e.g. `run_checks`), no arguments, or a selector over the brief's
  declared checks only. It runs the task's exact check commands (from the brief's
  "Exact check" column or a new `checks` field on the task) on the CURRENT
  candidate workspace in a separate bwrap sandbox: no network, no inherited env,
  no credentials, no inference process, read-only except the candidate copy,
  wall-clock and output bounds.
- Returns bounded, structured output (exit code, failing test names, truncated
  stderr). Every invocation is logged in the run artifacts.
- Worker-side results stay "worker-observed", never acceptance evidence. The
  controller still verifies independently, as now.
- Needs `node_modules` (or the equivalent) for the check sandbox: bind it read-only
  from the source project instead of copying it.
- Per-task opt-in (`--checks`), with a call budget (e.g. max 10 check runs).

This restores the edit→test→fix loop that made interactive Pi productive, without
reintroducing arbitrary command execution.

## 2. Thinking/output settings silently ineffective

- `thinking: "off"` did NOT disable thinking. The Pi model entry had
  `reasoning: false` and no `compat.thinkingFormat`, so Pi sent no toggle and
  Qwen 3.8's chat template thought by default. runtime.json still recorded
  `"thinking": "off"`, which was misleading.
- `maxTokens` absent → `metadata.maxTokens: null`, and Pi's default 16384
  per-response cap applied silently. That cap killed the run.

Required change: a preflight in `preparePiEnvironment` / `worker start` that
fails or warns (recorded in runtime.json and surfaced in `worker start` output):
- `thinking != "off"` with effective `reasoning !== true` → error (the request
  can't be honored).
- `thinking == "off"` with no effective `compat.thinkingFormat` on a model known
  to reason by default → warning "thinking may not be disabled".
- `maxTokens == null` → warning naming the default cap.
Record `effectiveThinkingControl: "sent" | "not-sent"` in runtime.json.

## 3. No-progress watchdog

The 20-minute run spent its whole budget in one response with no write. Add an
optional limit, `limits.firstWriteMs` (or `maxReasoningTokensBeforeWrite`): if no
write/edit tool call happens by then, stop with a distinct outcome
`no_progress` and keep the partial reasoning in artifacts. That saves wall time
and makes the failure mode explicit instead of a generic `timeout`.

## 4. Outcome naming: `output_limit` is ambiguous

`output_limit` is used both for the raw-event byte cap (worker.mjs:714/742) and for
the model's per-response token cap (stopReason `length`, worker.mjs:850). Split
them into `raw_output_limit` and `response_token_limit`, and include
`usage.output`, `usage.reasoning` and the effective `maxTokens` in the error
details.

## 5. Task sizing lint

This task (8 files, 64 tests, ~19K prompt tokens) is far beyond what one
read/write/edit-only invocation handles. At `task add`/`approve`, compute and
print: allowed-file count, compiled-context bytes, and the cited test-file line
count. Warn above configurable thresholds (e.g. >3 allowed source files or
>40 KB compiled context) with "consider splitting". Interactive success came from
1–2-file increments.

## 6. Protected files (controller-owned tests/types)

The controller wrote the tests and `types.ts` as the fixed contract, but the
`--allow` list had already been registered with them (the task can't be edited
after `task add`). The only guard was a manifest fact. Add:
- `task add --protect FILE[,FILE]`: the files are present in the workspace, any
  modification is a scope violation, and they're cited in the packet as read-only.
- `task update` (allow/protect/context/brief) that invalidates approval, rather
  than having to re-register.

## 7. Validate the context manifest at `task add`

`task add --context` only checks the `.json` extension (controller.mjs:60). An
invalid manifest from an earlier session was accepted and only failed at
`task approve` (CONTEXT_MANIFEST_INVALID "unknown key: task"). Run
`parseContextManifest` plus the resource range checks at `task add`.

## 8. Cited-context rereads

The talon runs re-read cited resources despite the contract text (the 13-28 run
read types.ts, error-types.ts, path-policy.ts, both test files and the brief; the
13-49 run read types.ts, error-types.ts and path-policy.ts), and the botforge
profile already instructs against it. Each reread costs context and
time. Record a `citedRereads` count in result.json so it's measurable. If it
stays high, consider placing the cited files in the workspace as read-only and
telling the worker the excerpts ARE the files.

## Out of scope here

Model choice (Q4 vs higher quant, 128K vs 256K slots) is not the root cause; the
same alias worked interactively. Revisit only after items 1–3 land.
