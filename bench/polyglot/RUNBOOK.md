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

Setup is already done (manifest, Docker image, oracle check). Exercises whose
reference solution fails are excluded automatically.

## Phase 1 — baseline (all models, 1 repeat)

Run `main` was initialized and both host processes were started on
2026-10-19 by the operator's setup session. Do **not** run `init` again. Only
monitor; restart a host process (see above) if `pgrep` shows it is gone and
`status` still has open entries for that host.

When `status` shows every baseline entry done: `$B report --run main` and read
`<run>/report.md`. Write a short ranking (pass@2 per model, per language) in
`<run>/NOTES.md`.

## Phase 2 — second repeat for the top models

Pick the 3 models with the highest pass@2 (or what the operator asked for in
NOTES.md). Then:

```sh
$B add-repeat --run main --models K1,K2,K3 --repeats 2
# restart the background run(s) for the hosts involved
```

## Phase 3 — proposal rounds (per top model, max 3 rounds)

For model `K`, round `r`:

1. `inject_keys "$B triage --run main --model K" JEV_API_KEY` (optional Jev labels;
   they are hints, not truth — check a few against the export).
2. `$B export --run main --model K` and read `export/K-baseline/failures.md`.
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
4. Screen: `$B plan-screen --run main --model K --candidates ID1,ID2,ID3 --seed R`
   then run the host's background process. This reruns discovery failures plus a
   sample of passes for each candidate **and** for `baseline-rerun`.
5. `$B report --run main`. In the screen section compare each candidate with
   `baseline-rerun`. Pick the best candidate only if it has more pass@2 than
   `baseline-rerun` on the screen set. If none is better, go to the next round
   with new ideas (or stop after round 3).
6. Confirm the pick once on holdout:
   `$B plan-confirm --run main --model K --candidate ID --repeats 2`, run, then
   `$B decide --run main --model K --candidate ID`.
   `keep: true` → the profile is a winner for K; stop rounds for K.
   `keep: false` → note the reasons; next round (max 3).

## Phase 4 — wrap up

`$B report --run main`, then write `<run>/SUMMARY.md`:
models ranked by baseline pass@2; for each top model the candidates tried,
screen numbers, holdout decision (paste `decide` output), and the winning
profile text if any. Mention anything unusual (harness errors, restarts,
skipped exercises). The operator decides what goes into the product.
