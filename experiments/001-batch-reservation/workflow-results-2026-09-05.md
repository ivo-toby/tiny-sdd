# Exploratory workflow results — 2026-09-05

These are historical exploratory tool-chain and workflow observations, not a
frozen comparison or efficacy result. At this checkpoint no baseline
implementation workflow had been run. The later [Unicode transfer comparison](../002-label-truncation/results-2026-09-05.md)
includes ordinary Pi baselines. A later [preservation comparison](preservation-results-2026-09-05.md)
tests the proposed regression instruction separately. Streaming token usage is
unavailable, so token values remain UNKNOWN.

## Ordinary tool-chain smoke

### v1 — 09:01

The oracle required preserving the copied file's trailing newline while putting
only the UUID in a JavaScript string. The original prompt asked for exact bytes
but did not spell out the 37-byte versus 36-character distinction.

| Participant | Observation | Evidence |
| --- | --- | --- |
| Gemma | Passed the complete read/write/edit/bash check. All four tools succeeded, the verifier succeeded, final files were correct, and the reply was `TOOL_CHECK_PASS`. | [summary](../runs/001-batch-reservation/smoke-2026-09-05T09-01-20.400Z-gemma-tools-80ef7d65/summary.json), [raw events](../runs/001-batch-reservation/smoke-2026-09-05T09-01-20.400Z-gemma-tools-80ef7d65/pi/stdout.jsonl) |
| Qwen | Wrote the copy without its newline, then inserted a newline into the JavaScript string. It repaired the final files, but reached the 12-tool bound before a successful verification. The stored summary says `capture-or-process-failure`; the raw capture shows the actual bounded model attempt was a `tool_limit` failure. | [summary](../runs/001-batch-reservation/smoke-2026-09-05T09-01-19.245Z-qwen-tools-ab63ee0e/summary.json), [raw events](../runs/001-batch-reservation/smoke-2026-09-05T09-01-19.245Z-qwen-tools-ab63ee0e/pi/stdout.jsonl) |
| Nemotron | Wrote the 36-byte copy and 36-character string, then the verifier failed; it stopped without a successful verifier run or correct final files. | [summary](../runs/001-batch-reservation/smoke-2026-09-05T09-01-21.617Z-nemotron-tools-9f7bccf8/summary.json), [raw events](../runs/001-batch-reservation/smoke-2026-09-05T09-01-21.617Z-nemotron-tools-9f7bccf8/pi/stdout.jsonl) |

The Qwen and Nemotron outcomes are model-attempt failures under a bounded
check, not evidence of a capture outage. The Qwen summary classification is
retained as raw history but should not replace the raw `tool_limit` observation.

### v2 — 09:04

The prompt made the 37-byte copy versus 36-character JavaScript-string
distinction explicit.

- [Qwen passed](../runs/001-batch-reservation/smoke-2026-09-05T09-04-07.498Z-qwen-tools-27da4163/summary.json): nine tool calls, all four required tools, verifier success, correct files, and `TOOL_CHECK_PASS`.
- [Gemma passed](../runs/001-batch-reservation/smoke-2026-09-05T09-04-08.633Z-gemma-tools-ca19454b/summary.json): six tool calls, all four required tools, verifier success, correct files, and `TOOL_CHECK_PASS`.
- [Nemotron reached the 12-tool bound](../runs/001-batch-reservation/smoke-2026-09-05T09-04-09.804Z-nemotron-tools-dcf82dad/summary.json) without producing the required newline distinction or a successful verification.

Both local runs passed v2; Gemma also passed v1. These single, uncontrolled runs
do not establish that the prompt change caused an improvement. Nemotron
repeated the newline failure. A read-only inspection of the installed Pi
OpenAI-completions parser, argument validation, and write tool found no trimming
of valid JSON string values; local synthetic parsing preserved a newline.
Without the raw HTTP response, model output cannot be distinguished from an
upstream backend/proxy rewrite. No proxy configuration was changed.

A scorer correction accepts equivalent absolute paths for `check-output.txt`;
that does not change the unrelated Qwen v1 failure.

## Original-skill workflow attempts

These were treatment attempts only; they do not provide a baseline or a skill
benefit estimate.

### Qwen treatment — 09:06

The [manifest](../runs/001-batch-reservation/workflow-2026-09-05T09-06-26-759Z-qwen-treatment-b8272bc3/manifest.json)
records expanded skill instructions, but no template read. Qwen created a
brief and then edited `src/inventory.ts` and `test/inventory.test.mjs` in the
same first exchange, before approval. There was no meaningful red evidence
before implementation: the initial public tests covered only `reserveOne`;
later import failures are not meaningful batch red evidence.

The primary inspection found the final candidate to be a pure module. A
separate clean-environment, Node-permissions-directory oracle run passed all
13 held-out checks with CLI exit 0 ([acceptance output](../runs/001-batch-reservation/workflow-2026-09-05T09-06-26-759Z-qwen-treatment-b8272bc3/verification/acceptance.stdout.txt),
[workspace diff](../runs/001-batch-reservation/workflow-2026-09-05T09-06-26-759Z-qwen-treatment-b8272bc3/verification/workspace.diff)).
The retained candidate passes these behavioral checks; that is not complete
contract coverage, workflow compliance, or a treatment-benefit estimate.

### Gemma treatment — 09:06

The [manifest](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/manifest.json)
shows a proper first-exchange pause with original fixture files unchanged. The
template was not read. The [primary approval review](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/approval-review.md)
records a stale expectation that the existing tests should fail; that is not
meaningful red evidence. After the prewritten simulated approval, the same
saved Pi session contained the user approval and the continuation reached the
implementation edits, but ended at the task-wide captured timeout: manifest
status `runtime_failure`, `timeout`, exit 143, 9 continuation starts, 16 total
starts, and 180,508 ms captured wall time, with no final handoff. The first
post-approval test run had 8 failures from the unimplemented stub; after the
implementation it reported 12 passing tests. The final test edit also removed
the original frozen-input `reserveOne` regression test, reducing the original
public regression count from 5 to 4. This is an unrequested test regression,
even though the separate retained oracle output passed 13/13 ([acceptance
output](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/verification/acceptance.stdout.txt),
[workspace diff](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/verification/workspace.diff)).
The primary review found the retained final module pure; this behavioral result
still does not erase the unrequested test regression or make the workflow a
pass. The [start capture](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/phases/start/capture/stdout.jsonl)
and [continuation capture](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/phases/continue/capture/stdout.jsonl)
retain the raw tool chain. Behavioral correctness of the retained candidate is
separate from workflow compliance.

Independent frozen-regression reruns also passed the original five
`reserveOne` tests for [Qwen](../runs/001-batch-reservation/workflow-2026-09-05T09-06-26-759Z-qwen-treatment-b8272bc3/verification/frozen-regression-result.json)
and [Gemma](../runs/001-batch-reservation/workflow-2026-09-05T09-06-28-189Z-gemma-treatment-5fca37ad/verification/frozen-regression-result.json),
both with exit 0. Those runs copied the frozen tests into separate verification
directories; they did not repair either participant's captured test suite.
Thus Gemma's deletion weakened regression coverage without a detected
`reserveOne` behavior regression in these checks.

### Revised-skill gate retests — partial observations

After tightening the approval instruction so a new brief must end the turn and
wait for a subsequent message, both fresh treatment starts paused with original
fixture files unchanged:

- [Qwen, 09:11](../runs/001-batch-reservation/workflow-2026-09-05T09-11-32-203Z-qwen-treatment-cd98476b/manifest.json): 9 tool starts, read the copied template, then wrote a brief ending with approval pending. Its brief contains inaccurate source line numbers for the stub; this was recorded, not repaired.
- [Gemma, 09:13](../runs/001-batch-reservation/workflow-2026-09-05T09-13-54-430Z-gemma-treatment-3c3a68a3/manifest.json): 6 tool starts, wrote a brief ending with an approval request, but did not read the copied template.

Neither retest has a continuation yet. These are narrow pause observations,
not workflow passes or causal evidence. The revised-skill results remain open.

## Status and limits

- All results above are exploratory. There is no baseline workflow, no
  baseline-versus-treatment comparison, and no efficacy claim.
- A later tightening of the TinySDD approval instruction is being retested;
  only the narrow first-exchange observations above are recorded so far, not
  continuation outcomes or a workflow pass.
- Provider streaming usage is disabled; token consumption and a token ceiling
  were not measured.
- Retained raw captures, manifests, phase snapshots, and reviews remain the
  source of truth for each attempt.
- The helper suites still pass 15/15 tests, and the revised skill passes its
  structural validator. Local documentation links and all four workflow runs'
  initial source-snapshot hashes were checked successfully.
- Next, check the revised pause on a new task and address preservation of
  existing regression tests as a separate instruction experiment. Effective
  thinking, proxy caching/retries, and a practical completion budget still need
  qualification before a frozen baseline-versus-treatment pilot.
