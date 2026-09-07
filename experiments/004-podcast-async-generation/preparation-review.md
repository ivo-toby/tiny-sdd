# Preparation review

2026-09-05. This is a document review, not participant-code verification or
operator approval. The primary authored the contract and acceptance expectations;
a Luna-max subagent independently checked task seams against the existing source
and installed SDK. Another checked links and scope/status consistency.

## Findings and disposition

| Finding | Disposition |
| --- | --- |
| Dual JSON response wording could accidentally change the preserved publish tool. | Clarified in feature and task 03: only async generation/status change; publish stays text-only. |
| Intermediate tool list was implied, not pinned. | Listed explicitly in the feature; task 02's temporary original toolset distinguished from completed checkpoint. |
| HTTP failure witness could test continuation without checking the failed record. | Task 04 now explicitly requires the safe error, terminal status/stage and no unhandled rejection. |
| Early baseline report had become stale while verification continued. | Retained failed attempts and recorded the final direct primary run: 181/181 passed in one network-isolated execution. |
| HTTP acceptance needs a working loopback environment. | Added explicit loopback preflight. Delegated execution denied listening; direct primary execution passed real loopback download tests inside a network namespace. Agent contexts are not interchangeable. |

The reviewer found no contradiction between fresh stateless request transports,
a shared process-owned manager and the installed SDK client. Its optional SSE
GET handling tolerates the existing 405 route; no new GET endpoint or transport
format switch is required. This is source-level compatibility evidence, not an
executed integration pass.

The link/scope audit found all 44 links present at audit time resolved, task
write sets matched their seams, and no stale claim of implemented CLI or started
Qwen work. Later additions are limited to review/evidence links and clarifications.

## Remaining gates

See [baseline results](baseline-results.md) for observed build/test outcomes and
limitations. Independent A1–A10 checks and deliberate-wrong-implementation probes
are not yet implemented or executed. Pi provider/model pairing, effective
invocation limits and generated-code verification isolation are not yet frozen.
Operator approval remains pending; no participant dispatch or target-code edit.

The narrower checkpoint, unchanged queue/deadline policy and deferred publishing
are intentional proposals requiring operator review, not review findings silently
waived. Neither the review nor passing baseline tests accepts the feature.
