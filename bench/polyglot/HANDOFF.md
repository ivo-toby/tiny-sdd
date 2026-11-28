# Polyglot benchmark: handoff (updated 2026-11-28)

This file is everything a new Claude session needs to continue the polyglot
benchmark on another machine. Read it together with `RUNBOOK.md` (operating
rules and phase procedures) and `SPEC.md` (design). The operator is Ivo.

## 1. Where things stand

**Code:** finished and merged (#148, #150). The model registry (#123) is done:
- results live as `benchmarks[]` cards in `profiles/*-v1.json`;
- `tinysdd models` lists them;
- `init --model` selects the profile measured on that route.

**Run `main`** (dataset aider-polyglot `7e0611e`, 207 valid exercises, one
repeat). Baselines, pass@1 / pass@2 / minutes per task:

| Model key | Route | pass@1 | pass@2 | min/task |
|---|---|---|---|---|
| qwen38nextflash (randal) | randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf | 86.5 | 97.1 | 2.0 |
| muselim (Glimmer, 20 min timeout) | titan/llamacpp/muse-glimmer-2x64k | 84.5 | 93.7 | 7.9 |
| inkling2sq20 (2026-11-28, Pi 1.5.2) | titan/strata/inkling-2-mini-sq20-128k | 82.6 | 95.2 | 2.4 |
| muse (Glimmer) | titan/llamacpp/muse-glimmer-2x64k | 79.7 | 91.8 | 7.8 |
| gemma26lim (32k tokens, 20 min timeout) | titan/llamacpp/gemma4-26b-a4b-2x64k | 78.3 | 94.2 | 9.0 |
| gemma26 | titan/llamacpp/gemma4-26b-a4b-2x64k | 75.8 | 88.4 | 6.0 |
| qwen38pi | titan/llamacpp/qwen3.8-pi-q4km-128k | 70.0 | 86.5 | 1.6 |
| flint (partial, 188/207, no Rust) | titan/llamacpp/flint-ud-q3-256k | 69.7 | 87.8 | 6.2 |
| qwen38q3 | titan/llamacpp/qwen3.8-q3-2x64k | 69.6 | 84.5 | 3.4 |
| qwen38q4s | titan/llamacpp/qwen3.8-q4s-2x128k | 69.1 | 87.9 | 2.7 |
| qwen36mt32 (32k tokens) | titan/llamacpp/qwen3.6-35b-a3b-2x128k | 66.7 | 87.0 | 2.7 |
| qwen36 | titan/llamacpp/qwen3.6-35b-a3b-2x128k | 63.3 | 81.2 | 2.7 |
| north | titan/llamacpp/north-mini-code-2x64k | 52.7 | 74.9 | 9.3 |

Noise is about ±3 points per repeat. swift15 and thinkingcap were never run.
Results measured with different settings or Pi versions are not paired; a
score belongs to exactly the configuration in its card.

**Settings variants (2026-10-24 to 2026-10-26).** Looser limits helped more than any
instruction candidate:

| Variant | pass@1 vs original | pass@2 vs original | Effect |
|---|---|---|---|
| qwen36mt32 (maxTokens 32768) | 66.7 vs 63.3 | 87.0 vs 81.2 | response token limit failures 16 to 4 |
| gemma26lim (maxTokens 32768, 20 min) | 78.3 vs 75.8 | 94.2 vs 88.4 | worker timeouts 3 to 0 |
| muselim (20 min) | 84.5 vs 79.7 | 93.7 vs 91.8 | worker timeouts 37 to 2 |

**inkling2sq20 (2026-11-28).** Route `titan/strata/inkling-2-mini-sq20-128k`,
contextWindow 128000, maxTokens 32768, thinking medium, parallel 1, 10 minute
timeout, one repeat.
- pass@1 by language: cpp 73.1, go 66.7, java 89.7, javascript 93.8, python 94.1, rust 66.7.
- Outcomes: 197 passed, 6 compile errors, 3 without edits, 3 with failing tests, 1 scope violation.
- Harness errors stayed at 10; all of them date from the 2026-10 runs (the CPU limit fix and the muse route hang).
- Go and Rust are the weak languages.
- The run used Pi 1.5.2. The other baselines used Pi 1.0.0, and there is no inkling2sq20 run on 1.0.0. Part of the difference can come from the Pi version.
- The card is `profiles/titan-inkling2-mini-sq20-128k-v1.json`. No instruction candidates were tried for this model.

**Instruction candidates so far (Phase 3):** none was kept.
- **qwen38nextflash:** 3 rounds, 9 candidates. On holdout, pass@1 improved by +3.8 and +2.9 points. Both were rejected because the improvement was not above 5 points and Go dropped.
- **qwen38pi:** 2 rounds, 6 candidates. On holdout, pass@1 changed by −1.0 and +1.0 points. Round 3 was stopped by the operator.
- **Pattern:** small gains on the discovery screen disappeared on holdout.
- **Opus candidates, 1 round each (2026-10-26 to 2026-10-28), holdout pass@1, none kept:**

| Candidate | Variant | Holdout candidate vs baseline | Reason |
|---|---|---|---|
| qwen36-o2-error-cases | qwen36mt32 | 64.4 vs 70.2 (−5.8) | delta not above 5; java and python dropped |
| gemma26-o2-existing-api | gemma26lim | 76.9 vs 75.0 (+1.9) | delta not above 5 |
| muse-o2-trace-edges | muselim | 76.0 vs 81.7 (−5.8) | delta not above 5; cpp and go dropped |

  The screen gains were 2 to 4 exercises and vanished again. Three go/ entries
  of the muse confirm ended 0/0 during a Titan route hang on 2026-10-28; even
  counted as passes, the delta stays about −2.9, so the decision does not change.
- **qwen36-o1 (16k maxTokens):** abandoned at 71/104 holdout entries. The operator
  dropped the 88 open entries on 2026-10-30 because qwen36mt32 replaced that
  setting. The operator keeps `titan-qwen36-35b-a3b-2x128k-mt32-v1` in the registry.

**Haiku candidates withdrawn (2026-10-24):** `qwen36-r1-*`, `gemma26-r1-*` and `muse-r1-*` were written by Haiku and then withdrawn by the operator.
- Their profiles stay registered in the run, but never queue or use them.
- Profiles are immutable, so new candidates need new ids.
- The 55 `qwen36 baseline-rerun` entries from that screen (seed 1) are still in the queue, 5 of them done.

**Limit failures:** the settings matter as much as the instructions. Of the discovery first-attempt failures, these were caused by a limit:

| Model | First-attempt failures | Caused by a limit |
|---|---|---|
| qwen36 | 35 | 12 at `maxTokens` 16384 (10 of them with zero edits) |
| gemma26 | 22 | 8 at `maxTokens` and 2 at the 10-minute timeout |
| muse | 20 | 11 at the 10-minute timeout (about 23 tok/s) |

## 2. What to do next (operator decisions, 2026-10-24)

Status 2026-11-28: Step 1, Step 1b and Step 2 are done (see section 1 for the
results). The text below stays as the procedure for new models. The inkling2sq20
baseline followed the Step 1 recipe (`add-repeat`, `run --models`, `report`, `card`).

Never run two processes against Titan at once; the operator is
energy-conscious. Run each step with `--models KEY`. Do not use `--host titan`,
because that would also start the leftover entries of other models.

### Step 1: qwen36 with maxTokens 32768 (settings variant)

`qwen36mt32` in `models.json` has the same route as qwen36, with maxTokens 32768.

```sh
$B add-repeat --run main --models qwen36mt32 --repeats 1     # queues 207 baseline entries
inject_keys "nohup $B run --run main --models qwen36mt32 > $DATA/runs/main/qwen36mt32.log 2>&1 &" HOMELAB_AI_GATEWAY_API_KEY
```

When it is done:
1. Run `$B report --run main` and compare pass@1 with qwen36 in the Overview table. The two keys are not paired automatically, so judge the difference against the ±3 point noise.
2. Record the result as a new registry profile:

```sh
$B card --run main --model qwen36mt32 --into profiles/titan-qwen36-35b-a3b-2x128k-mt32-v1.json --id titan-qwen36-35b-a3b-2x128k-mt32-v1
```

Both profiles then have the same route, so `tinysdd init` reports
`PROFILE_MATCH_AMBIGUOUS` for it. Ask the operator which profile should stay in
the shared registry, and do it in a PR to the repo.

### Step 1b: gemma26 and muse with looser limits (added 2026-10-25)

Models can now set `timeoutMs` in `models.json`; the default is still 10 minutes.
- `gemma26lim`: maxTokens 32768 and timeoutMs 1200000 (20 min).
- `muselim`: timeoutMs 1200000.

Run them like Step 1, one at a time, `gemma26lim` first. Compare each with its original and record it with `card --into profiles/<new id>.json --id <new id>`. The card records the timeout too.

### Step 2: Opus-written candidates for qwen36, gemma26 and muse (1 round each, north skipped)

The running Claude session (Opus) writes the candidates itself, following
RUNBOOK Phase 3. Haiku may only analyze.

- Use ids `<model>-o1-<slug>`, for example `qwen36-o1-...`, so they never collide with the withdrawn `*-r1-*` ids.
- Use `--metric pass1` everywhere.
- For qwen36, use `--seed 1`: the already queued `baseline-rerun` entries are reused instead of duplicated.
- **Settings:** screen each model's candidates on its variant with looser limits (`qwen36mt32`, `gemma26lim`, `muselim`) when that variant is not worse than the original. That needs its own discovery export from the variant's baseline. Use ids `<model>-o2-<slug>` for these.
- **Order:** qwen36, then gemma26, then muse. One screen at a time on Titan.
- **Per model:**
  1. Export the discovery failures.
  2. Write 2–3 candidates and register them.
  3. Run `plan-screen`, then the run.
  4. Run `report`.
  5. If a candidate beats `baseline-rerun` on pass@1: `plan-confirm --repeats 1`, then the run, then `decide --metric pass1`.
  6. Record the result with `card ... --into profiles/<that model's registry profile>.json`.
- Log every transition in `$DATA/runs/main/NOTES.md`, as before.

### Rules that stay in force

- Never look at holdout failures, `cases/` of holdout exercises, or `.meta/` reference solutions.
- Never edit `bench/polyglot/` code, `src/` or the dataset during a run. If something looks broken, stop and write it in NOTES.md.
- No commits or pushes from the operating session. Registry profile updates go through a PR from a development session: open the PR, review it, then merge.
- Report only numbers read from `status`, `report` or `decide`.
- Sanity check at every check-in. These signs mean the model was not really called (a gateway or route problem), not that it is bad:
  - entries under 20 s;
  - long streaks of 0/0;
  - a whole model finished in under an hour.

## 3. Moving to another machine

**What the new machine needs:**
- Linux with Docker and bubblewrap, or macOS;
- Node ≥ 22.19;
- Pi `1.5.2` (`@earendil-works/pi-coding-agent`) beside that Node (the pin in `src/setup.mjs` after #229). The 2026-10 runs used Pi `1.0.0` and the inkling2sq20 run used `1.5.2`; a run on a new Pi version needs its own baselines before results are compared;
- network access to `https://ai-gateway.cloud.toby.nu/v1` and, for triage only, `api.typesafe.ai`.

**Keys:**
- `HOMELAB_AI_GATEWAY_API_KEY` is needed for runs.
- `JEV_API_KEY` is needed for `triage` only.
- On Ivo's machines they come from the keychain via `inject_keys` (`~/.config/zsh/debian.d/1-functions.zsh`). If that helper is missing, the operator exports them in the shell.
- Never print or write key values.

**Steps:**

1. Clone the repo and pull the latest `main` (this file, `models.json`).
2. Copy the data directory: 29 MB compressed, about 300 MB unpacked. It is not in git because it holds run outputs:

   ```sh
   # on the old machine (already created on 2026-10-24):
   #   ~/workspace/tinysdd-bench-data.tar.gz
   scp OLD:~/workspace/tinysdd-bench-data.tar.gz ~/workspace/
   tar -xzf ~/workspace/tinysdd-bench-data.tar.gz -C ~/workspace
   ```

   It contains:
   - `manifest.json` and `oracle-check.json`;
   - the dataset checkout `polyglot-benchmark/` at `7e0611e`;
   - `runs/main/`: queue, results, profiles, plans, decisions, exports, NOTES.md and SUMMARY.md.

   The default location is `~/workspace/tinysdd-bench-data`. Elsewhere, pass `--data DIR` or set `TINYSDD_BENCH_DATA`.
3. Build the test image once: `node bench/polyglot/cli.mjs image` (`tinysdd-polyglot:1`, about 3.4 GB). Do not run `import`, `oracle` or `init` again; they are done.
4. Check:

   ```sh
   cd <repo>; B='node bench/polyglot/cli.mjs'; DATA=~/workspace/tinysdd-bench-data
   pgrep -af "cli.mjs run"            # must be empty before starting anything
   $B status --run main               # expect harnessErrors 0, qwen36 baseline-rerun 5/55
   ```

5. Smoke test before a long run: start Step 1 and watch the first 3–4 entries in the log. They must take minutes, not seconds, and must not show 0/0.

## 4. Restart prompt for a new Claude session

Paste this into a new Claude Code session (Opus) in the tiny-sdd checkout on
the new machine:

> Je gaat de polyglot-benchmark van TinySDD voortzetten. Lees eerst
> `bench/polyglot/HANDOFF.md`, `bench/polyglot/RUNBOOK.md` en de laatste 40
> regels van `~/workspace/tinysdd-bench-data/runs/main/NOTES.md`. Controleer
> daarna de omgeving volgens HANDOFF §3 (pgrep, `status --run main`, Docker
> image) en meld kort wat je ziet. Start pas runs als ik dat bevestig; begin
> daarna met de stap die ik noem. Stap 1, 1b en 2 uit HANDOFF §2 zijn klaar
> (resultaten in §1). Houd je aan alle regels uit de
> RUNBOOK: nooit holdout-failures of `.meta/` bekijken, nooit twee runs
> tegelijk op Titan, sleutels alleen via `inject_keys` of de omgeving en nooit
> tonen. Log elke stap in NOTES.md, doe check-ins elke 30 minuten met de
> sanity check, en antwoord mij kort in het Nederlands.
