# Model capability calibration results (2026-10-19)

This report records retained calibration evidence for issue #126. It is a
capability snapshot, not acceptance evidence, model qualification, or evidence
that any instruction improved a model. Each selected case was repeated three
times; those repetitions are correlated.

## Main comparison

The implement/stop-and-ask partition has eight implement-slice challenges and
one stop-and-ask challenge. Every model completed 24/24 implement-slice cases
and 3/3 stop-and-ask cases. The write-tests results below use the corrected
oracle where a final result is available.

| route | implement-slice | stop-and-ask | write-tests | primary reviewed failure signal |
| --- | ---: | ---: | ---: | --- |
| qwen3.8-q3 | 24/24 | 3/3 | 13/15 strict, 15/15 reference, 58/60 mutant kills | Birch `kind`/`n` NaN comparator witness; Dune current-listener witness |
| qwen3.8-pi | 24/24 | 3/3 | 12/15 strict, 15/15 reference, 57/60 mutant kills | Birch member-order witness; Dune listener-snapshot witness |
| thinkingcap | 24/24 | 3/3 | 10/15 strict, 15/15 reference, 55/60 mutant kills | Birch `.value` comparator witness; Dune listener-snapshot witness |

For implement and stop-and-ask, each model had 27/27 completed cases,
reference pass 27/27, 54/54 visible and held-out checks green, 24/24 syntax
checks green, and zero hard-gate violations. The stop-and-ask score remains a
separate behavior measure from implement-slice correctness.

## Actionable write-tests failure classes

The primary review read all 15 distinct retained candidate test files for each
completed write-tests result. These findings describe test-witness quality;
they do not change the canonical scores.

| model | observed classes |
| --- | --- |
| qwen3.8-pi | Birch repeat 2 does not distinguish the retained `left.value - right.value` member-order comparator. Dune repeats 2 and 3 remove an earlier or currently executing listener instead of a later not-yet-invoked listener; repeat 3 also overconstrains unsubscribe function identity. |
| thinkingcap | Birch repeats 1 and 3 omit `.value`, so the retained comparator yields `NaN`; repeat 2 uses `.value` groups that are already ascending. None distinguishes the retained member-sorting fault. Dune repeats 2 and 3 remove the currently invoked listener, so they do not exercise snapshot behavior for a later listener. |
| qwen3.8-q3 | Birch repeat 2 uses `kind`/`n` objects without `.value`, so the retained comparator yields `NaN` and preserves order. Dune repeat 1 unsubscribes the currently executing listener, which does not distinguish live-set from snapshot dispatch. |

The next controlled prompt research should target these two fixture classes:
ordering witnesses that actually change under the retained faulty behavior, and
mid-dispatch listener removal that affects a later listener. No prompt effect
is inferred from the calibration scores.

## Corrected oracle and retained rescoring

The original write-tests records were produced against the old source and are
unchanged. The corrected verifier was delivered in PR #134 at source commit
`02c661dd8f851e16235ecdf5d730b2a9f678d3b8`. Corrected qwen3.8-q3, QwenPi,
and Thinkingcap rescoring used the same source, suite, runner, and retained
candidate bytes.

For qwen3.8-q3, the corrected result is 15/15 reference passes, 13/15 strict
successes, and 58/60 mutant kills. By challenge, Amber was 3/3 strict with
18/18 kills, Birch 2/3 with 8/9, Cobalt 3/3 with 15/15, Crimson 3/3 with 9/9,
and Dune 2/3 with 8/9. The primary canonical result records all 15 attempts,
60 mutation checks, 58 kills, and 13 strict successes.

For Thinkingcap, the corrected result is 15/15 reference passes, 10/15 strict
successes, and 55/60 mutant kills. By challenge, Amber was 3/3 strict with
18/18 kills, Cobalt 3/3 with 15/15, Crimson 3/3 with 9/9, Birch 0/3 with 6/9,
and Dune 1/3 with 7/9.

For QwenPi, the corrected result is 15/15 reference passes, 12/15 strict
successes, and 57/60 mutant kills. By challenge, Amber was 3/3 strict with
18/18 kills, Birch 2/3 with 8/9, Cobalt 3/3 with 15/15, Crimson 3/3 with 9/9,
and Dune 1/3 with 7/9. The primary canonical result records all 15 attempts,
60 mutation checks, 57 kills, and 12 strict successes.

The corrected rescores used the local runner with network disabled and zero
model calls or network requests. For each completed rescore, all 75
digest-bearing verifier inputs matched their expected candidate-test digest;
all 105 visible, held-out, and syntax check records were sandbox safe. The old
Amber case-level failure in the Thinkingcap record was caused by the stale
verifier while the retained worker outcome was completed; the corrected score
uses that worker outcome and reruns the verifier against the same bytes.

## Interpretation and limits

The three routes have the same observed implement-slice and stop-and-ask score
in this calibration. Timing differences are workload observations, not a
quality ranking. The corrected write-tests results expose challenge-specific
fixture weaknesses in Birch and Dune while all reference checks remain green.

These records do not establish production reliability, qualification,
acceptance, or instruction improvement. Backend/server versions are
independently **UNKNOWN**, and the three repetitions are correlated. Any A/B
prompt claim requires a later controlled comparison with the same source,
suite, settings, role, and independent review.

## Appendix: exact identity pins

The implement/stop-and-ask records retain source commit
`57139490fb1f9418c1849c2e68c7a75bc71c5ac3`, implement suite SHA-256
`2315b812841480c2c90f319a49a82aa57fb9ed44b5e2698086a6904d7f4989f4`,
`thinking=medium` requested and wire-observed, `maxTokens=16384`, 128000-token
context, and worker limits of 12 checks, 100 tool calls, and 600000 ms.
Server-side thinking enforcement remains UNKNOWN, with the recorded
`THINKING_CONTROL_MISMATCH` acknowledgement. The shared profile hash is
`9a43bf107db659fc75fdbbd6845a18e9957b64820055560cbed1d9935d0fd361`.

| route | source-models hash | implement elapsed | stop-and-ask elapsed |
| --- | --- | ---: | ---: |
| `titan/llamacpp/qwen3.8-q3-128k` | `7d96bf2f5b0e0093c8a71ec96801de4ea171b55ff6204bd49d13e7372982d7bf` | 759.310 s total / 31.638 s mean | 43.343 s total / 14.448 s mean |
| `titan/llamacpp/qwen3.8-pi-q4km-128k` | `6dd6004e7ed0f68a7c2671d295b6a8643aa20bb1ff6862f61176c924d102d1aa` | 646.529 s total / 26.939 s mean | 28.626 s total / 9.542 s mean |
| `titan/llamacpp/thinkingcap-q4km-128k` | `f4bd3105b3729de83f8741b44318e825968f14861c9a0957ae62a0c6ec37426e` | 501.179 s total / 20.882 s mean | 28.428 s total / 9.476 s mean |

The old retained source-571 write-tests fixture suite SHA-256 is
`3d329044873392f9f3540c629cff4fc67a34cd81c8ee4ff3d02725ab9a5320c6`, and its
suite-tree SHA-256 is
`e6ed2c5affe0e0b56f236ace94aa3d44633de97407dd133452e01556e2612720`. These
old suite pins identify the fixture bytes reused by all three rescoring runs;
they are not a new source-02 benchmark suite. The corrected source deployment
archive SHA-256 is
`dba24c3134fa1e88cc418cda4439bfe2b2f8406e6d9a74aadb5e145d71530c9d`. The
corrected verifier SHA-256, expected and observed, is
`f53c4231d94e93d62109373e4143764e2275c0e33441a432ff2159e4322beff9`.
All three rescoring runs reused the retained old fixture bytes with the corrected
checker; they did not run new full benchmark model invocations.

The retained corrected rescore files are pinned by these SHA-256 values:

- `corrected-thinkingcap-write-tests-rescore.json`:
  `dcb7be70d6e7494a3700c0089d95a45315ca38bf3d3d848d1646b29715838001`;
- `corrected-qwenpi-write-tests-rescore.json`:
  `29015498e334e05f9463f27e61455e0707913735dba4d7c00335223d916d81a5`;
- `corrected-qwen38q3-write-tests-rescore.json`:
  `9bcca438e9e0c0ac4fb65cb5bc2ce5cc2b730b4c705da91dc89b3f4e0fab4541`.

The primary-review input hashes are
`f50d6218f5493229959c6f84d7fd0adf2879416ac4ff3b5bdccc5384c9bf27f3` for
Thinkingcap v2, `ff511e185660ab05a5bef82bac511a44c0928c2c570a09ec5335ddf64a851af7`
for QwenPi, and
`e74f5b849688c63570f0ec4994879cd8ef460020bd2f00ccb84c5c0b312ce5d4` for
qwen3.8-q3. The Thinkingcap v2 review supersedes the earlier review's
comparator description.
