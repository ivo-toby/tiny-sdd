# Regression preservation comparison — 2026-09-05

Do not promote the extra preservation paragraph. In this exploratory Gemma pair,
the current skill retained all five original regressions, while the candidate
deleted the frozen-input test despite its explicit instruction to preserve tests.
This demonstrates failure to prevent the observed problem, not that the paragraph
caused it or that the control is reliable.

## Frozen comparison

The [prewritten protocol](../002-label-truncation/protocol.md) specified fresh
inventory runs A then B after the Unicode transfer comparison. A used the current
skill; B used an [experimental copy](variants/preserve-regressions/tinysdd/SKILL.md)
adding only this paragraph:

> When adding tests, keep existing test cases and assertions unless the approved
> behavior requires changing them. Review the test diff for accidental deletions
> or weakened assertions; report any intentional removal and its reason.

The template, fixture, checks, common prompt, model/provider, runtime settings,
180-second/60-tool-start cumulative limits, and prewritten simulated approval were
otherwise unchanged. Neither the primary nor Luna repaired participant files or
added hints. Both sessions visibly paused before implementation, with source and
tests unchanged. Primary approval reviews are retained for each continuation.

Provenance layout: the inventory manifests snapshot the original inventory
protocol. The specific A/B policy above is in the Unicode protocol, already
frozen in the earlier [Unicode source snapshot](../runs/002-label-truncation/workflow-2026-09-05T10-12-52-851Z-qwen-baseline-4cd6c8e3/sources/experiments/002-label-truncation/protocol.md).
It was not separately embedded in each inventory manifest.

| Observation | Current skill A | Preservation candidate B |
| --- | --- | --- |
| Original regression cases/assertions retained | 5/5 | 4/5 |
| Independent batch checks | 13/13 pass | 13/13 pass |
| Separately rerun original regressions | 5/5 pass | 5/5 pass |
| Meaningful red before implementation | No | Yes: 7 stub failures |
| Final participant tests | 12 pass | 11 pass |
| Final handoff | Yes | Yes, but omitted deletion concern |
| Captured Pi wall / tool starts | 125.478 s / 16 | 95.504 s / 16 |

- A: [manifest](../runs/001-batch-reservation/workflow-2026-09-05T10-21-30-042Z-gemma-treatment-0156fcb9/manifest.json), [approval review](../runs/001-batch-reservation/workflow-2026-09-05T10-21-30-042Z-gemma-treatment-0156fcb9/approval-review.md), [verification](../runs/001-batch-reservation/workflow-2026-09-05T10-21-30-042Z-gemma-treatment-0156fcb9/verification-continue/result.json).
- B: [manifest](../runs/001-batch-reservation/workflow-2026-09-05T10-24-40-605Z-gemma-treatment-27eeb305/manifest.json), [approval review](../runs/001-batch-reservation/workflow-2026-09-05T10-24-40-605Z-gemma-treatment-27eeb305/approval-review.md), [verification](../runs/001-batch-reservation/workflow-2026-09-05T10-24-40-605Z-gemma-treatment-27eeb305/verification-continue/result.json).

A initially submitted an invalid edit argument, then rewrote the test file and
lost its assert/test imports. The next test run failed with `test is not defined`.
It restored those imports and obtained 12 passing tests. These are tool/setup
repairs after implementation, not behavior-specific red evidence.

B added tests before implementation and observed seven `Not implemented`
failures. Its edit replaced the fifth original test with batch tests; that case
was not relocated. The final handoff accurately says four existing tests plus
seven new ones passed, but neither explains nor justifies losing the fifth test.
Passing restored original tests in the independent verifier does not repair the
participant suite or erase its weakened regression coverage. Both briefs also
remain without final evidence updates; neither participant read the template.

## Interpretation and next boundary

The deletion repeats the [earlier failure](workflow-results-2026-09-05.md) on
this fixture. The extra paragraph did not solve it. B's successful red-first
sequence is an incidental observation, not a demonstrated benefit of a paragraph
aimed at another behavior. Do not trade off regression preservation against red
evidence or combine those dimensions into an overall pass.

Keep the current product skill unchanged and retain the rejected candidate as
experiment history. A next narrow hypothesis could place new behavior tests in
a separate file when existing test discovery supports it, keeping the original
regression file untouched. That directly targets the block-replacement failure
seen here, but needs a separate prewritten comparison; it is not a proven fix.
These results do not justify a new product CLI or custom harness.

The primary inspected both generated modules before clean-environment,
permission-limited verification against retained checks and frozen regressions.
One uncontrolled attempt per arm, unknown response-cache freshness/proxy retries,
unverified effective sampling/thinking, and unavailable token usage limit the
result to exploratory evidence. Timings exclude review delays and are not a
performance conclusion. Nemotron was not substituted or retried in this pair.

Tooling maintenance: the helper suite initially passed 14/15 because a timing
test assumed a short-lived child had exited before its output was observed.
Only that test's premise/assertions were corrected: either natural exit 0 or a
coherent SIGTERM stop is valid; exact limit/usage checks remain. The production
capture runtime was unchanged throughout these model comparisons. Five delegated
reruns and the primary's final rerun each passed 15/15. This does not establish
deterministic coverage of an already-exited child. Both skill variants pass their
structural validator; structural validity is not behavioral compliance.
