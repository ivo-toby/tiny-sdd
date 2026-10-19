# Model capability calibration results (2026-10-19)

This report records the retained calibration evidence for issue #126. It is a
capability snapshot, not acceptance evidence, model qualification, or evidence
that any instruction improved a model. Each selected case was repeated three
times; those repetitions are correlated.

## Scope and identities

The implement/stop-and-ask partition used eight implement-slice challenges and
one stop-and-ask challenge. Each model therefore has 24 implement-slice cases,
three stop-and-ask cases, and 27 cases total. The records were collected with
`thinking=medium`, `maxTokens=16384`, a 128000-token context, and worker limits
of 12 checks, 100 tool calls, and 600000 ms. The backend/server version is
independently **UNKNOWN** for every route.

| model route | implement source-models hash | profile hash | implement elapsed (24 cases) | stop-and-ask elapsed (3 cases) |
| --- | --- | --- | ---: | ---: |
| `titan/llamacpp/qwen3.8-q3-128k` | `7d96bf2f5b0e0093c8a71ec96801de4ea171b55ff6204bd49d13e7372982d7bf` | `9a43bf107db659fc75fdbbd6845a18e9957b64820055560cbed1d9935d0fd361` | 759.310 s total / 31.638 s mean | 43.343 s total / 14.448 s mean |
| `titan/llamacpp/qwen3.8-pi-q4km-128k` | `6dd6004e7ed0f68a7c2671d295b6a8643aa20bb1ff6862f61176c924d102d1aa` | `9a43bf107db659fc75fdbbd6845a18e9957b64820055560cbed1d9935d0fd361` | 646.529 s total / 26.939 s mean | 28.626 s total / 9.542 s mean |
| `titan/llamacpp/thinkingcap-q4km-128k` | `f4bd3105b3729de83f8741b44318e825968f14861c9a0957ae62a0c6ec37426e` | `9a43bf107db659fc75fdbbd6845a18e9957b64820055560cbed1d9935d0fd361` | 501.179 s total / 20.882 s mean | 28.428 s total / 9.476 s mean |

The implement/stop-and-ask records retain source commit
`57139490fb1f9418c1849c2e68c7a75bc71c5ac3` and implement suite SHA-256
`2315b812841480c2c90f319a49a82aa57fb9ed44b5e2698086a6904d7f4989f4`.
The original records remain unchanged.

## Calibrated implement and stop-and-ask results

| route | implement-slice | stop-and-ask | completed cases | reference pass | visible + held-out checks | syntax checks | hard-gate violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen3.8-q3 | 24/24 | 3/3 | 27/27 | 27/27 | 54/54 | 24/24 | 0 |
| qwen3.8-pi | 24/24 | 3/3 | 27/27 | 27/27 | 54/54 | 24/24 | 0 |
| thinkingcap | 24/24 | 3/3 | 27/27 | 27/27 | 54/54 | 24/24 | 0 |

The stop-and-ask result is kept separate from implement-slice correctness. The
observed timing differences are workload measurements, not a quality ranking.
No model-specific correctness failure was observed in this partition. The next
research step is to finish the independent write-tests runs and compare their
failure modes under the corrected oracle rather than infer a prompt benefit
from this green partition.

## Corrected write-tests oracle and retained rescore

The original write-tests records were produced against source commit `571...`
and are retained as historical records. The verifier correction was delivered
in PR #134 at source commit
`02c661dd8f851e16235ecdf5d730b2a9f678d3b8`. The corrected rescore used the
following identities:

- source deployment archive SHA-256:
  `dba24c3134fa1e88cc418cda4439bfe2b2f8406e6d9a74aadb5e145d71530c9d`;
- write-tests suite SHA-256:
  `3d329044873392f9f3540c629cff4fc67a34cd81c8ee4ff3d02725ab9a5320c6`;
- suite-tree SHA-256:
  `e6ed2c5affe0e0b56f236ace94aa3d44633de97407dd133452e01556e2612720`;
- corrected verifier SHA-256, expected and observed:
  `f53c4231d94e93d62109373e4143764e2275c0e33441a432ff2159e4322beff9`.

The retained rescore ran with the local runner available, network disabled,
and zero model calls or network requests. All 75 digest-bearing verifier
inputs matched their expected candidate-test digest, and all 75 were sandbox
safe. These checks establish byte and runner identity for the rescore; they do
not turn the rescore into acceptance evidence.

Only the corrected Thinkingcap result is final in this report:

| route | cases | reference pass | strict successes | mutant kills |
| --- | ---: | ---: | ---: | ---: |
| thinkingcap | 15/15 | 15/15 | 10/15 | 55/60 |

The corrected Thinkingcap result was stable by challenge for the three
repetitions: Amber 3/3 strict with 18/18 mutant kills, Cobalt 3/3 with 15/15,
and Crimson 3/3 with 9/9. Birch was 0/3 with 6/9 kills, and Dune was 1/3
with 7/9 kills. The old Amber case-level failure was caused by the stale
verifier while the retained worker outcome was completed; the corrected score
uses the worker outcome and reruns the verifier against the same candidate
bytes.

Final write-tests results remain pending for:

- qwen3.8-q3: pending final write-tests run;
- qwen3.8-pi: pending primary confirmation of the corrected rescore.

No original write-tests score is substituted for either pending result.

## Interpretation and next research

All three routes completed the implement-slice and stop-and-ask calibration
partition with the same observed score. The corrected Thinkingcap write-tests
result shows a narrower, challenge-specific weakness in Birch and Dune while
the reference and syntax checks remain green. This motivates a controlled
write-tests comparison focused on ordering and edge-case assertions after the
remaining corrected rescoring completes.

The three repetitions are correlated, backend versions are unknown, and the
calibration does not establish production reliability, qualification,
acceptance, or instruction improvement. Any A/B prompt claim requires a later
controlled comparison with the same source, suite, settings, role, and
independent review.
