# GEPA + Swift technical pilot — 19 October 2026

Status: preparation verified; no Swift or Qwen inference result yet. This report is a progress record, not evidence of a better profile.

This experiment uses [GEPA](https://github.com/gepa-ai/gepa) 0.1.4 as an external Python research tool and existing [SWE-PolyBench Verified](https://github.com/amazon-science/SWE-PolyBench) tasks. GEPA changes only the `instructions` component. Swift implements; Titan Qwen3.6-35B proposes instruction changes. Normal TinySDD users acquire no Python or GEPA dependency.

The [frozen protocol](../research/gepa-swift-pilot/2026-10-19/protocol-v2.json) fixes model settings, task allocation, feedback boundaries and a finite budget before model outcomes: at most 12 GEPA metric calls, two candidate proposals and four reflection requests. Existing published profiles and earlier research results are unchanged.

| Split | Existing task | Use |
| --- | --- | --- |
| Development | `yt-dlp__yt-dlp-5195` | First technical run; optional predeclared development extensions are `yt-dlp__yt-dlp-10390` and `yt-dlp__yt-dlp-4841` |
| Validation | `serverless__serverless-7374` | Candidate selection using scores only |
| Final | `mui__material-ui-12406` | Paired evaluation after candidate bytes are frozen; never fed to the optimizer |

These repositories are disjoint. Task selection used metadata, not Swift outcomes. The final set in this technical pilot is small: even an observed final-task win would not establish a generally superior model profile. Development success alone cannot establish transfer.

## Verified preparation

The initial yt-dlp fixture uses the pinned dataset revision and image digest recorded in the protocol. The original test command and upstream Python parser were retained. The official resolved predicate is reproduced from the pinned scoring source, rather than calling that scoring function directly. An additional completeness audit requires every declared F2P and P2P test ID to appear, because absence of a P2P failure alone does not establish complete execution.

| Independent control | Passed | Failed | Expected IDs observed | Protected test/config changes |
| --- | ---: | ---: | --- | ---: |
| Original code, empty candidate patch | 10 | 1 | 11/11 | 0 |
| Dataset reference patch | 11 | 0 | 11/11 | 0 |

Both controls ran with the candidate/test fixture mounted read-only, Docker networking disabled, all capabilities dropped and no-new-privileges enabled. Primary review independently checked complete test output, JSON reports, hashes and container policy. No model participated in these controls. The exported public base contains 1,161 files, no Git history and no reference patch.

The first read-only control attempt could not retrieve its report with `docker cp` from tmpfs and remains unavailable evidence. A new helper version retrieves the report with bounded `docker exec cat`; the two controls above are new executions, not a relabeling of the failed attempt.

Authentication and route checks also passed without inference. Both approved routes map exclusively to Titan. Swift retains medium/16,384 output/128,000 context/600 seconds/100 tool calls; Qwen reflection retains medium/16,384 output/256,000 context/600 seconds. Both retain the operator-acknowledged `THINKING_CONTROL_MISMATCH`: these settings do not prove that the backend honors medium thinking. Gateway credentials stay in host relay memory and outside the worker. No cloud or fallback is permitted.

## Measurement boundaries

This Python pilot calls normal TinySDD `runWorker` and independently evaluates its patch in the dataset container. TinySDD benchmark qualification is explicitly **NOT_RUN**: its existing check runner accepts Node or a declared mounted executable, and this pilot adds no dummy held-out check to imply Python verification. The external oracle owns the dataset result.

The optimization metric requires both a completed worker and a valid strict oracle pass. A worker token/tool/time limit is a model-result failure even if a partial patch passes tests. An unavailable harness is unknown and stops optimization. The original dataset outcome remains separate. Worker output never becomes feature acceptance.

The relay serializes Titan calls and buffers each response; this pilot therefore makes no streaming latency or direct speed-comparison claim. The backend build and actual weight identity remain unverified beyond the provider's route metadata.

The upstream repository has an MIT root license, while evaluator source headers carry CC-BY-NC-4.0 notices. Evaluation code remains external research tooling with notices preserved; it is not copied into the TinySDD product or relicensed here. Redistribution/product-use licensing remains unresolved.

## Retained identities

- Frozen protocol SHA-256: `7dc1102a6b1e060362581e5337fe852522d98d673da31ae8dd1e728b493f8df2`.
- TinySDD execution source: `ac8782e1d6749399c7ad32dd246e24899f3f2560`; archive SHA-256 `ce6b6acee78731a6bf0205f8d5638746fb428d057ec73b6e386158a2d580587f`.
- SWE-PolyBench source: `9c836c5d7f3cb991934132b77d29e6941d912a07`.
- Verified dataset revision: `b3fca77b637379f0c01ad86d18753a7ac1998b53`; CSV SHA-256 `0c8138e73c34fa29a5276b675b146b72d78ce001fcc4560d76302c908b4808a5`.
- Empty-control result SHA-256: `87cbfb7e988efd9b028100c61ed45bf3bdbb6988c1fbe68c61216a46fb9910a4`.
- Reference-control result SHA-256: `b4e0c7ad5675d7acb74884778afbe2104cdf587f379af2bb45069d03865ffc69`.

Raw evaluator artifacts are retained in the operator's research workspace, not bundled here. Publishing these hashes does not make the full raw execution evidence available in this repository. Later model results must identify the exact candidate, patch, settings and verifier artifacts before any improvement is reported.
