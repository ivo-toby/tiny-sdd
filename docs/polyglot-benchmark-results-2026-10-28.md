# Polyglot benchmark results

**Date:** 2026-10-28
**Issue:** #148
**Run:** `main`, Aider polyglot at `7e0611e`, 207 oracle-checked exercises, one repeat
**Worker:** TinySDD Pi worker (Pi 1.0.0), one attempt plus one revision with the test output, tests in offline Docker

## Summary

- **Generic instructions do not make small models better.** 7 instruction candidates across 5 models were confirmed on holdout. None was kept: screen gains of 2 to 4 points disappeared or turned negative.
- **Limits matter more than instructions.** Raising the token limit and the worker timeout raised pass@1 by 2.5 to 4.8 points on every model tried.
- **The revision round is the strongest mechanism measured.** One retry with the test output adds 9 to 22 points (pass@1 to pass@2) on every model.
- **Model choice is a speed/quality trade-off.** qwen38nextflash is best (86.5% pass@1, 2.0 min per task). On Titan, muselim is strongest (84.5%) but slow (7.9 min); qwen38pi is fastest (1.6 min) at 70.0%.

The original goal was a library of profile instructions that makes each model behave better. The data says that does not work for generic behaviour. Follow-up work moves to limits, worker selection per slice (#164) and the quality of the per-slice context.

## Method

Each exercise is split once into **discovery** and **holdout**. Instruction candidates are written only from discovery failures. A candidate that beats a fresh baseline rerun on the discovery screen is confirmed once on holdout. It is kept only if pass@1 improves by more than 5 points and no language drops (veto). Holdout failures were never inspected. pass@1 is the primary metric; pass@2 is reported.

Noise between repeats is about ±3 points. Every number below is a single repeat.

## Baselines

| Model (host) | pass@1 | pass@2 | min/task |
| --- | ---: | ---: | ---: |
| qwen38nextflash (randal) | 86.5% | 97.1% | 2.0 |
| muselim (Titan, 20 min timeout) | 84.5% | 93.7% | 7.9 |
| muse (Titan) | 79.7% | 91.8% | 7.8 |
| gemma26lim (Titan, 32k tokens, 20 min) | 78.3% | 94.2% | 9 |
| gemma26 (Titan) | 75.8% | 88.4% | 6.0 |
| qwen38pi (Titan) | 70.0% | 86.5% | 1.6 |
| flint (Titan, 188 exercises, no Rust) | 69.7% | 87.8% | 6.2 |
| qwen38q3 (Titan) | 69.6% | 84.5% | 3.4 |
| qwen38q4s (Titan) | 69.1% | 87.9% | 2.7 |
| qwen36mt32 (Titan, 32k tokens) | 66.7% | 87.0% | |
| qwen36 (Titan) | 63.3% | 81.2% | 2.7 |
| north (Titan) | 52.7% | 74.9% | 9.3 |

Defaults are 16k output tokens and a 10-minute worker timeout. The `randal` route name says Qwen3.6 but serves Qwen3.8-Next-Flash.

## Looser limits

| Variant | Change | pass@1 | pass@2 | Effect |
| --- | --- | --- | --- | --- |
| muselim | timeout 10 → 20 min | 84.5% vs 79.7% | 93.7% vs 91.8% | worker timeouts 37 → 2, same speed |
| gemma26lim | 32k tokens, timeout 20 min | 78.3% vs 75.8% | 94.2% vs 88.4% | worker timeouts 3 → 0, 9 vs 6 min per task |
| qwen36mt32 | 16k → 32k tokens | 66.7% vs 63.3% | 87.0% vs 81.2% | pass@1 within noise, pass@2 clearly up |

Before the change, a limit caused 12 of 35 qwen36 discovery failures, 10 of 22 for gemma26 and 11 of 20 for muse.

## Instruction candidates on holdout

| Model | Candidate | Holdout pass@1 (candidate vs baseline) | Decision |
| --- | --- | --- | --- |
| muselim | `muse-o2-trace-edges` | 76.0% vs 81.7% (−5.8) | rejected; cpp and go drop |
| gemma26lim | `gemma26-o2-existing-api` | 76.9% vs 75.0% (+1.9) | rejected; below +5 |
| qwen36mt32 | `qwen36-o2-error-cases` | 64.4% vs 70.2% (−5.8) | rejected; java and python drop |
| qwen38pi | 2 candidates | −1.0 and +1.0 | rejected |
| qwen38nextflash | 2 candidates | +3.8 and +2.9 | rejected; go drops |

The o2 candidates were written by Opus; earlier rounds by the operating session. Candidate texts are in the run's `candidates/` directory. A set written by Haiku was withdrawn before screening.

## Escalation: fast worker first, strong worker on failure

The baselines allow a simulation without new runs. Each exercise is first given to a fast worker (attempt plus revision). Only if that fails does a strong worker get the exercise, and its own baseline result on that exercise counts. Time is the sum of both runs.

| Policy | Solved | min/task | Escalated |
| --- | ---: | ---: | ---: |
| muselim alone | 93.7% | 7.9 | |
| gemma26lim alone | 94.2% | 9.0 | |
| qwen38nextflash alone | 97.1% | 2.0 | |
| qwen38pi → muselim | 97.6% | 3.6 | 28 (13.5%) |
| qwen38pi → gemma26lim | 96.6% | 3.4 | 28 (13.5%) |
| qwen38q4s → muselim | 98.6% | 4.2 | 25 (12.1%) |
| qwen38pi → qwen38nextflash | 98.6% | 2.1 | 28 (13.5%) |

On Titan, escalating from qwen38pi to muselim solves more exercises than muselim alone in less than half the time. Two limits to this simulation: an escalated exercise gets up to four attempts instead of two, and the strong worker does not see why the fast one failed. It does use the strong worker's real result on the same hard exercises, so the correlation between "hard for one" and "hard for the other" is in the numbers. This supports #164.

## Cost

The run took 4,579 results between 2026-10-19 and 2026-10-28: about 324 task-hours on Titan and 23 on randal (sum of task durations; Titan usually ran two tasks at a time). The looser-limit variants and their candidate rounds alone took about 158 task-hours on Titan. No power measurement was taken.

## Caveats

- **Training data:** Exercism exercises are public and probably in the models' training data, and the worker may read the tests. Absolute scores are inflated; the ranking is what carries over.
- **Single repeat:** differences under about 3 points are not reliable.
- **Infrastructure:** a wrong route (207 results) and a datacenter outage on 2026-10-20 (184 results) were removed and rerun. On 2026-10-28 the muse route timed out for about an hour; 3 holdout entries ended 0/0 then. Counting all 3 as passes would still give about −2.9 points, so the decision stands.
- **Machine:** the second operating machine has 3 CPUs; the Docker test container is now capped at the CPU count instead of a fixed 4 (`bench/polyglot/lib/docker.mjs`).

## What follows for TinySDD

1. Raise the default limits in worker profiles (32k output tokens, 20-minute timeout for slow reasoning models), and report when a run stopped on a limit.
2. Keep one revision round with the check output as the default.
3. Stop generic instruction tuning. Measure the preparation skills (spec, slice, context) instead, on real repository slices with operator acceptance rather than Exercism.
4. Let the preparing model pick a worker per slice, with visible escalation (#164).

Registry cards for the limit variants are in `profiles/titan-qwen36-35b-a3b-2x128k-mt32-v1.json`, `profiles/titan-gemma4-26b-a4b-2x64k-lim-v1.json` and `profiles/titan-muse-glimmer-2x64k-lim-v1.json`. The qwen36 and qwen36mt32 profiles share a route, so `tinysdd init` reports `PROFILE_MATCH_AMBIGUOUS` until one is removed from the registry.
