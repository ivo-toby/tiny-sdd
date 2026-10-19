# Randal model capability results (2026-10-19)

Related issue: [#126](https://github.com/ivo-toby/tiny-sdd/issues/126) (Refs #126). This report is a calibration result and does not close the instruction study.

## Scope and interpretation

This run measured the configured Randal route on the normal calibration fixtures for the `implement-slice` and `write-tests` roles. It is not an instruction A/B comparison, model qualification, operator acceptance, or automatic activation record.

The configured route alias was `randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf`. The operator-reported backend label was `Qwen3.8NextFlash` after a CPU-to-GPU correction, but backend version and GPU residency remain independently UNKNOWN. The run therefore does not support a CPU/GPU causal comparison, a pure throughput claim, or a claim that the reported backend label was independently verified.

The implementation and write-tests repetitions were run with the reviewed source02 harness and these requested bounded settings: medium thinking, 16,384 maximum output tokens, 256,000-token context, 600,000 ms timeout, 100 tool calls, 12 check runs, and fallback disabled. `THINKING_CONTROL_MISMATCH` was the acknowledged required-finding marker; server enforcement was not independently verified. Repetitions are correlated samples.

Worker attempts and elapsed times are execution records, not LLM API-call counts.

## Results

### Implement-slice

There were 27 scheduled cases: 24 `implement-slice` cases and 3 `stop-and-ask` cases. The retained operational records report:

| Group | Cases | Visible outcome records | Held-out outcome records | Worker elapsed |
| --- | ---: | ---: | ---: | ---: |
| Implement-slice | 24 | 24/24 | 24/24 | 996,271 ms |
| Stop-and-ask | 3 | 3/3 | 3/3 | 87,412 ms |
| **Total** | **27** | **27/27** | **27/27** | **1,083,683 ms** |

These are source-harness and independent-check summaries. They are not a correctness score for every implementation, and the stop-and-ask decision checks are reported separately from code checks.

### Write-tests

There were 15 generated test cases across five challenges, with three correlated repetitions per challenge. The generated tests passed the reference implementation in 15/15 cases. They killed 57/60 retained mutants, and 12/15 cases met the strict success rule.

| Challenge | Strict success | Reference pass | Mutant kills | Worker elapsed |
| --- | ---: | ---: | ---: | ---: |
| Amber | 3/3 | 3/3 | 18/18 | 243,864 ms |
| Birch | 0/3 | 3/3 | 6/9 | 215,474 ms |
| Cobalt | 3/3 | 3/3 | 15/15 | 250,672 ms |
| Crimson | 3/3 | 3/3 | 9/9 | 277,145 ms |
| Dune | 3/3 | 3/3 | 9/9 | 264,497 ms |
| **Total** | **12/15** | **15/15** | **57/60** | **1,251,652 ms** |

The 15 visible check groups passed. Held-out checks passed 57/60 and failed 3/60. The retained primary review verified 15 syntax checks, 75 verifier output hashes, and 75 verifier sandbox records; the recorded sandbox policy was network `none` with nested user namespaces `disabled`.

## Independent review findings

The primary review read all 15 generated contract-test files, their briefs and contexts, and the retained Birch member-sorting mutant. The review found that all three Birch tests use `k`/`v` payloads while the faulty mutant compares `.value`; the missing property produces `NaN`, so the tests do not distinguish that mutant. In addition, the third repetition's `v` values are already ascending within each group. This is a mutation-coverage limitation, not evidence that the model's other test behavior is correct.

The Dune tests exercise removal of a later listener during snapshot dispatch across current and next emissions and do not assert unsubscribe-function identity. No identity overconstraint was found there. The generated Crimson tests assert immediate starts; broader scheduling equivalence was not tested.

The review leaves one untested, generic instruction hypothesis: construct an order-sensitive witness whose output demonstrably changes under a plausible wrong ordering, and inspect the values the implementation actually compares instead of assuming that any scrambled input is sufficient. This is not A/B-validated and does not authorize activation or prescribe a hidden field or answer.

A separate posthoc Cedar coverage probe associated with [issue #141](https://github.com/ivo-toby/tiny-sdd/issues/141) (probe SHA-256 `0f6cd6d0aa74c2b8c71eb7d89208d23a3eaa48b2e91f61fd8c8ee8447fb8390b`) passed the reference and repetitions 1 and 2, but failed repetition 3 for the empty-id malformed-input error-wording check. It is retained as a coverage finding only. It does not rewrite the frozen 24/24 implementation outcome records or establish correctness for other untested edges.

The implementation review retained 24/24 implement-slice and 3/3 stop-and-ask outcome records, with no hard-gate violations and no raw-score rewrite. The review did not treat those counts as universal correctness evidence.

## Validation record

The following are path-elided forms of the completed-role auditor commands; the external research-root and output paths are omitted:

```text
node <research-root>/randal-completed-role-collector-audit-v3.mjs audit implement <external-audit-output.json>
node <research-root>/randal-completed-role-collector-audit-v3.mjs audit write-tests <external-audit-output.json>
```

The implement audit covered 27 cases: 27/27 completed, 27/27 visible checks passed, and 27/27 held-out checks passed. The write-tests audit covered 15 cases: 12 completed and 3 failed under the strict outcome rule, with 15/15 visible checks passed and 57/60 held-out checks passed. The retained audit output digests are `de4b5e1cb68ddd606db02cee732056f533949b2e969ea362a5de67fbca043ea4` (implement) and `645a123614031d277c6be391744542c3b744e8d9860c79a02b8ddba1929dd9e7` (write-tests).

The following are path-elided forms of the primary syntax commands:

```text
node --check <each retained changed src/*.mjs>; sanitized environment; syntax only, no candidate execution
node --check <each retained tests/contract.test.mjs>; sanitized environment; syntax only
```

They passed 24/24 implementation source files and 15/15 generated contract-test files. The syntax-review record digests are `45394423e99dafb91de7b011bf80037d55ab820bb14cbd16a600abc5e924320c` and `f3d21707e41104d72f25c2a3bdbc627a319994da96a15d9e1d54be09b18e9b45`, respectively.

## Identity and retention pins

The run used source revision `02c661dd8f851e16235ecdf5d730b2a9f678d3b8`, with source `src` tree digest `eb8dcf1e1f3837dd2c4211ad7bccd02cce9ded53eff9812096cde02f60648e08`. The revision was supplied explicitly by the reviewed helper and externally byte-bound to the source02 tree; it was not discovered from runtime Git state.

| Artifact | Identity digest |
| --- | --- |
| Implement prepared suite | `8d9c73cc8741dc1b59d5ec9f0877497c7ebe4c065031a790246f4cb4996b7e78` |
| Implement prepared bench tree | `a394c70ce7ce8307ebf246134d09396ce8f00e757b15ba0c828982b0fd11de8f` |
| Implement source suite tree | `ead7fd01c648fb62e97aa0465404c870a2c774759c6e7ea7fdb2bfbc98841ce7` |
| Write-tests prepared suite | `471bcd20db856f34680ed11fdfd790b20c745592ab47a9305696606a44f98c52` |
| Write-tests prepared bench tree | `a1e33b4700144f7c48c76f08c66f65f0f66cc37d097534c964f3017ccfa8cc34` |
| Write-tests source suite tree | `1317140633f0fbb775257e34c30e93b04f7a4df481736db9e4fec94070ab8c83` |
| Implement retained archive tree | `7627dc5d8ccaa0a00624938d926fd43c2329214cc0a47a9bae08fe8b841bb95b` |
| Write-tests retained archive tree | `0645ffcc2d3d9f84355e473564824830661d5badb93a7286184af5b2e333e958` |
| Implement metadata inventory | `cae101f61d52c173af5085897339af0268d8688e9534ff6747d3029dc8b14a37` |
| Write-tests metadata inventory v2 | `053c54bc5cf41f070b5c84f4c35abeec8f454951096bf09dde46f42e8fd9b7b9` |
| Reviewed helper | `2db2ab6cc17d17738f9a759ab590b4234701f37bef00e252418000337ce7bdf1` |
| Reviewed execution plan | `7b1445deb383e48d4be3844127fa6a5903c665078fb68786b6fc5bbdb0ca851e` |
| Guard manifest | `8948fcbb986413fbacdd4ad8b488aced8af96b1ee61e2dfaa752b01bcb59d88b` |
| Scheduling amendment | `634b7a044f8d7540d2db02ae665e0b3557610f2d260850574ff11b04a275f3dd` |
| Raw profile file | `6e1e8c56a3e9a88566bfead52309443955b804c996f391c74bf5394390bdaa85` |
| Canonical profile digest | `647b4b179151cc041cf33c60307c67ad1317aa9a49a34ad3b7e26d1bf3dd9262` |
| Prepared settings | `07a9adee59bd9e52fb8cda5780071e58b8a3a4772c64f2e61ad05c3302b70825` |
| Prepared settings digest | `4cdb0584c4754435c9b33ecb016eb6140ecf69262b64c239ba731d8fbde4ba50` |
| Implement invocation `configDigest` | `7128d12e95e444376e523cffc5b125e9653b3f3a2f602cb3ee0a1ef8770977aa` |
| Write-tests invocation `configDigest` | `7da8aa87ff1d462a1a3db492a4c63aa99ea30dff2016582e33587ef0c0eaac37` |

The v2 write-tests inventory reports 458 retained archive files, 30 retained test-file references (15 generated contract tests plus 15 retained visible tests), and 75 verifier references. The archive tree digest remains the frozen `0645ff...` value above; the v2 inventory corrects metadata only and does not alter retained evidence.

Primary review artifacts are retained as `randal-implement-primary-independent-review-v1.json` (SHA-256 `2e009866c8986ac6b694126d2d54f70be09c222b197974d8b524da13e3b773a6`), `randal-implement-primary-syntax-review.json` (SHA-256 `45394423e99dafb91de7b011bf80037d55ab820bb14cbd16a600abc5e924320c`), and `randal-write-tests-primary-independent-review-v1.json` (SHA-256 `b3ae4caa21b40717c1bae5f33813caac7465728104abc0106d97480b7e24f27a`). The write-tests raw role audit is pinned by SHA-256 `645a123614031d277c6be391744542c3b744e8d9860c79a02b8ddba1929dd9e7`.

## Limits and disposition

Randal and North used distinct configured backend hostnames, but that does not establish physical hardware independence or exclude shared gateway contention. The operator-reported GPU correction is not independently verified. Timings are observed worker elapsed times under this run configuration, not a throughput benchmark.

The results do not authorize qualification, acceptance, automatic promotion, or an instruction recommendation. Existing raw evidence remains locally retained; this report is a sanitized summary of the reviewed calibration record.
