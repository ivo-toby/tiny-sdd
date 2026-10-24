# Polyglot benchmark runbook (for the executing Claude session)

You run the failure-driven model-profile benchmark from issue #148. The code
is finished; you **operate** it. Your one creative job is writing candidate
instructions from discovery failures. Tests decide everything else.

## Hard rules

1. **Never look at holdout failures.** Do not open `cases/` for holdout
   exercises, do not read holdout results to write instructions. Use only
   `export` output (discovery-only by construction) and `report.md` numbers.
2. **Never open `.meta/` in the dataset** (reference solutions).
3. **Do not edit** anything under `bench/polyglot/` (code, models.json),
   the dataset, or `src/`. If the harness looks broken, stop the run and
   write what you saw in `<run>/NOTES.md` for the operator.
4. Profiles are immutable. A new idea gets a new profile id.
5. No git commits or pushes. No other models or providers than `models.json`.
6. Report only numbers you read from `status`, `report` or `decide` output.

## Environment

Every command that talks to Titan/randal or Jev needs keys from the keychain:

```sh
cd /home/ivo/workspace/tiny-sdd
source ~/.config/zsh/debian.d/1-functions.zsh
B='node bench/polyglot/cli.mjs'
inject_keys "$B status --run main" HOMELAB_AI_GATEWAY_API_KEY JEV_API_KEY
```

**Before starting anything, check what is already running:**
`pgrep -af "cli.mjs run"`. Never start a second process for a host that
already has one.

Long runs go in the background with a log, one process per host (Titan and
randal are different machines, so they run at the same time):

```sh
inject_keys "nohup $B run --run main --host titan  > /home/ivo/workspace/tinysdd-bench-data/runs/main/titan.log 2>&1 &" HOMELAB_AI_GATEWAY_API_KEY
inject_keys "nohup $B run --run main --host randal > /home/ivo/workspace/tinysdd-bench-data/runs/main/randal.log 2>&1 &" HOMELAB_AI_GATEWAY_API_KEY
```

Check progress with `$B status --run main` and `tail` of the logs. A run is
resumable: if a process stops, start it again with the same command. A run
stops by itself after 3 entries in a row hit infrastructure errors
(`harness-errors.jsonl`); check that Titan/randal are up, then restart.
Do not start two processes for the same host.

**Sanity check every check-in.** Look at the last ~20 lines of each host log.
Report `ATTENTION` (do not "fix" it yourself) when a model finishes entries
much faster than usual (under ~20 s each), shows 0/0 on many entries in a row,
or completes a whole model in under an hour. That pattern means the model was
never really called (wrong route, gateway error), not that it is bad.

Setup is already done (manifest, Docker image, oracle check). Exercises whose
reference solution fails are excluded automatically.

## Plan (operator decision, 2026-10-20 — fixed before any candidate results)

- **Primary metric is pass@1** (passes on the first attempt). Always pass
  `--metric pass1` to `plan-screen` and `decide`. pass@2 is reported but does
  not decide (it is near the ceiling: 85–97%).
- **Confirm on 1 holdout repeat:** `plan-confirm ... --repeats 1`. Phase 2
  (second baseline repeat) is skipped for now.
- **Status (updated 2026-10-24 by the operator):**
  1. Baselines are done for qwen38nextflash, gemma26, muse, qwen38pi,
     qwen38q4s, qwen38q3, qwen36 and north (207/207 each) and flint (stopped by
     the operator at 188/207, no Rust). swift15 and thinkingcap are not run.
  2. Phase 3 done: qwen38nextflash (3 rounds) and qwen38pi (2 rounds), no keep.
  3. Every result is recorded in the registry profiles in `profiles/` with
     `card` (see Phase 3 step 6 and Phase 4).
  4. **Paused.** Do not start runs until the operator asks. Planned next:
     qwen36 with maxTokens 32768 as a settings variant (model key
     `qwen36mt32`), then Opus-written candidates for qwen36, gemma26 and muse
     (north skipped). Exact steps, the machine move and a restart prompt are in
     `HANDOFF.md`.
- Log each transition in NOTES.md.

## Phase 1 — baseline (all models, 1 repeat)

Run `main` was initialized and both host processes were started on
2026-10-19 by the operator's setup session. Do **not** run `init` again. Only
monitor; restart a host process (see above) if `pgrep` shows it is gone and
`status` still has open entries for that host — except during the planned
Titan pause in the Plan above.

## Phase 3 — proposal rounds (per model, max 3 rounds)

For model `K`, round `R` (1, 2 or 3):

1. `inject_keys "$B triage --run main --model K" JEV_API_KEY` (optional Jev labels;
   they are hints, not truth — check a few against the export).
2. `$B export --run main --model K` and read `export/K-baseline/failures.md`.
   Focus on first-attempt failures (pass@1 is the metric): what made the first
   attempt fail even when the second one passed?
3. Group the failures by cause (Jev labels and `features` help). For the 2–3
   biggest groups, write one candidate instruction each, as a plain text file:
   - general behavior, not about any specific exercise; no code;
   - short (aim for < 800 characters), imperative, testable;
   - examples: "Before editing, read the test file and list every function,
     class and method it calls with exact names and argument order; implement
     exactly those." / "Handle every error case the instructions mention by
     raising/returning exactly what the tests expect."
   Save as `<run>/candidates/K-rR-<slug>.txt` and register:
   `$B profile --run main --id K-rR-<slug> --file <that file> --note "<group it targets>"`
4. Screen: `$B plan-screen --run main --model K --candidates ID1,ID2,ID3 --seed R --metric pass1`
   then start the run for that model (see Plan for which command). This
   reruns discovery first-attempt failures plus a sample of passes for each
   candidate **and** for `baseline-rerun`.
5. When the screen entries are done: `$B report --run main`. In "Candidate vs
   baseline" compare each candidate with `baseline-rerun` on **pass@1**. Pick
   the best candidate only if its pass@1 is higher than `baseline-rerun`'s. If
   none is better, start the next round with new ideas (stop after round 3).
6. Confirm the pick once on holdout:
   `$B plan-confirm --run main --model K --candidate ID --repeats 1`, run, then
   `$B decide --run main --model K --candidate ID --metric pass1`.
   `keep: true` → winner for K; stop rounds for K.
   Then record the result in the registry:
   `$B card --run main --model K --profile ID --metric pass1 --into profiles/<K's registry profile>.json`.
   `keep: false` → note the reasons; next round (max 3).

## Phase 4 — wrap up

`$B report --run main`, then write `<run>/SUMMARY.md`:
models ranked by baseline pass@1 and pass@2 (and a `card --into` per model to
update its registry profile); for each optimized model the
candidates tried, screen numbers, holdout decision (paste `decide` output), and
the winning profile text if any. Mention anything unusual (harness errors,
restarts, skipped exercises). The operator decides what goes into the product.
