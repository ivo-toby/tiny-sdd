# Unicode label truncation: transfer check

Date: 2026-09-05
Status: exploratory protocol written before these model runs

## Question and arms

Does the revised TinySDD approval pause also occur on a new task, and can the
model complete that task after approval? Compare ordinary Pi with the current
skill on each local runtime. This is one attempt per arm/runtime, not a
reliability estimate or a qualified repeated-sampling pilot.

Use the existing Pi capture tool, exact configured Qwen/Gemma IDs, unchanged
runtime settings, task-wide 180-second/60-tool-start limits, and at most one
continuation. Keep all task facts identical between arms. The treatment adds
only the current TinySDD skill/template, including its explicit approval pause.
The regression-preservation candidate is NOT used in this transfer comparison.

Order: Qwen baseline then treatment; Gemma treatment then baseline. Serialize
runs per backend. No rescues or edits to participant output. The primary agent
may issue the existing prewritten simulated approval only after reviewing a
matching brief. An ordinary baseline that completes needs no continuation.
Record questions, interventions, failures, and timeouts rather than silently
restarting. Effective thinking, sampling, response-cache freshness, proxy
retries, and token usage remain unverified; timings are descriptive only.

## Behavioral source of truth

The existing `countCodePoints(text)` counts Unicode code points, not grapheme
clusters or UTF-16 code units. It performs no Unicode normalization. Preserve
that API and behavior.

Add `truncateLabel(text, maxPoints)`. Text is a string (caller precondition).
Validate maxPoints first: a value other than a nonnegative safe integer throws
RangeError, including when text is empty. If text fits, return it unchanged.
If text overflows and maxPoints is zero, return an empty string. Otherwise take
the first maxPoints minus one code points and append one U+2026 ellipsis. That
ellipsis occupies one of the allowed code points. Do not normalize text or
combine grapheme clusters. No dependencies or network are needed.

These semantics are copied into TASK.md. Held-out checks hide concrete probes,
not implementation requirements. The primary owns the reference implementation
and two deliberate mutants: UTF-16 slicing and an ellipsis outside the budget.
Require the reference to pass, the stub to fail, and both mutants to fail before
testing models. Independently retain and rerun all five original regression
tests against captured candidates; do not trust a rewritten participant suite.

## Evidence and classification

- Verify actual skill expansion and raw tools. A treatment pause requires a
  visible approval request, unchanged initial implementation/tests, and no
  observed transient edits to them. A document's approval label is not evidence.
- Inspect the proposed brief before a simulated approval. Do not supply missing
  implementation hints. Record brief inaccuracies separately from the gate.
- Grade correctness using the ten frozen behavioral checks on the captured
  candidate, after inspecting generated code. Use a clean verifier environment
  without provider credentials. Preserve actual stdout/stderr, status, sources,
  and hashes. These checks do not prove the contract exhaustively.
- Inspect original test coverage and assertions in the participant diff. Merely
  passing the frozen tests does not excuse deletion of the participant's tests.
- Record actual behavior-specific red before production changes, final handoff,
  and scope compliance separately. A timeout with correct captured code remains
  an incomplete workflow, not an overall pass.
- Keep exact prompts, skill/template snapshots, initial/final files, sessions,
  and raw events. Ordinary host tools are not an OS confinement guarantee.

## Separate regression-preservation comparison

After the transfer runs, use the ORIGINAL inventory fixture with Gemma, where
the regression-test deletion was observed. Compare the current skill (A) with
the copy under `001-batch-reservation/variants/preserve-regressions/tinysdd` (B).
The copy adds only one paragraph about preserving existing tests/assertions and
reviewing accidental deletions. The product skill remains unchanged meanwhile.

Run fresh A then B, with the same prompt, fixture, budgets, simulated approval,
and current approval-pause instruction. Assess preservation of all five
original reserveOne cases and their assertions, allowing equivalent formatting
or relocation but not silent coverage loss. Independently score the thirteen
inventory checks and five original regression tests on both captured modules.

If both arms preserve the tests, do not attribute a preservation benefit to B
or add it to the product skill on this evidence. If B improves the observed
failure, treat it as a candidate needing replication, not proof. Missing final
code, timeout, approval violation, or infrastructure failure is retained and
reported. Neither this comparison nor the transfer check justifies a new
product controller.
