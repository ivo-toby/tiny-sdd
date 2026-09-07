# Podcast checkpoint: partial result, not feature acceptance

2026-09-05. Qwen completed an accepted job-manager task. Server extraction
passes independent checks, but its test review is unfinished and the task's
invocation budget is exhausted. Async tool wiring and HTTP integration did
not run. No patch was applied to mcp-podcast-generator.

## Observed outcome

| Task | Decision | Observed verification |
| --- | --- | --- |
| 01: job manager | Accepted after two test/evidence revisions | Build; 181 original +27 new tests; 8 independent job checks |
| 02: factories | Blocked, not accepted | Saved extraction passes build; 224 workspace tests; 8 job +2 factory checks, but review findings remain |
| 03: async tools | Not run | None |
| 04: HTTP integration | Not run | None |

The operator explicitly delegated progression and review to the primary agent.
These are actual delegated decisions, not simulated approval or personal human
inspection of every artifact. This is still only the controlled fake-generation
checkpoint, not combined publishing, a production release, or a completed
product feature.

Exact model: randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf through Pi
0.84.4 and the existing LiteLLM proxy. No model substitution or applicable
fallback occurred. Root ran verification with Node24.15.0; Docker/Node20
compatibility and real providers remain untested.

## Retained evidence

The [accepted task01 patch](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/accepted-job-manager.patch) contains only
the manager, job types and their tests. Its
[metadata](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/accepted-job-manager-patch-metadata.json) records source
hashes and successful apply-check against a disposable baseline copy.
It has not been applied to the original repository.

- [Run manifest](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/manifest.json): frozen inputs, actual prompts,
  invocation records, source snapshots and delegated decisions.
- [Task01 observations](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/task-01-observations.md) and
  [acceptance](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/review-01-inv3.md).
- [Task02 observations](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/task-02-observations.md),
  [unresolved review](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/review-02-inv2.md), and
  [final blocked decision](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/review-02-inv3.md).
- [Execution amendment](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/execution-amendment.md):
  restricted edit-only participant with primary-owned verification.
- [Preflight review](../experiments/runs/004-podcast-async-generation/qwen-2026-09-05T19-05-03-078Z-d1839e18/preflight-review.md): positive reference and six
  deliberately wrong behaviors were checked before participant output existed.

Preflight's 18 reference checks are not 18 passing participant integration
checks. The participant reached only the job/factory stages. The earlier
setup-only run retained a verifier discovery-path defect, corrected before
any model invocation; it is not a model failure or a discarded implementation.

## What happened

Task01's initial invocation reached the 15-minute limit. Its saved production
code nevertheless passed all independent job checks. Two planned revisions
fixed regression-test witnesses: true synchronous throw versus async rejection,
queued continuation after rejection, TTL boundary, detached acceptance mutation,
and event-loop observation for unhandled rejections. No stronger model repaired
the participant's production code or tests. The primary supplied recorded
review feedback, and Qwen made the changes.

Task02's first invocation ended in an upstream HTTP502, despite Pi exiting0.
The partial patch had an incorrect Express return type and an out-of-scope
PublishResult re-export. Qwen corrected both in invocation2; the publish core
is restored byte-for-byte. However, it repeatedly ran direct typechecks and
focused Vitest commands instead of the required credential-free verifier.
The primary stopped that invocation on repetition. Direct tests used injected
fakes, but ran with the inference process's network/credential context and
must not be described as isolated verification. No real generation/publishing
or credential access was observed in reviewed calls.

Before invocation3, the primary documented a safety amendment: remove bash
entirely from the worker, leaving read/write/edit, and execute checks only
after handoff in the separate verifier. This changes the experimental tool
condition; it is not silently treated as the original frozen workflow.
That invocation timed out upstream after 120.9 seconds, before any tool action.
The amendment therefore has no successful participant outcome yet.

Task02 still needs its final bounded test/evidence correction: remove tests
that freeze synchronous generation response semantics, genuinely assert
conditional publish visibility and its text-only payloads, add static-file
and body-limit witnesses, and strengthen cleanup. Green counts did not resolve
those review findings. The final feedback is retained, but was not acted on.

Six invocation processes consumed 48m28s wall time and 191 observed tool starts.
This includes upstream waiting and interrupted attempts, not just generation.
It excludes preparation, independent verification and primary review. Task01
used 27m20s/93 tools; task02 used 21m08s/98 tools. No reliable token/cost comparison
is claimed from incomplete provider usage reporting.

## Lessons supported by this run

1. Strong-model preparation plus smaller-model implementation produced one
   reviewed, useful component in a real repository. It has not yet delivered
   the whole controlled feature, much less established general reliability.
2. Test quality was the dominant review issue. A test named for an invariant
   often did not contain the necessary positive witness. Explicit review of
   assertions remains necessary even when all tests pass.
3. Instructions alone did not keep generated-code execution separate from
   inference credentials. The restriction must exist in available capabilities,
   not only skill wording. The edit-only continuation is an experiment-local
   response, not a new product CLI or a proven final worker architecture.
4. A process exit0/capture label of completed is not a successful Pi handoff:
   inspect the terminal assistant stopReason and error. Both upstream failures
   would otherwise be misclassified. Primary review caught them; the capture
   classifier itself is not fixed by this report.
5. No behavior-specific pre-implementation red evidence was captured. The
   delivered result is not evidence of successful test-first workflow adherence.

These observations do not isolate the benefit of SDD, skills, task size,
review, or any model profile. There is no matched control or repeated
full-feature sample here. Detailed source specifications already existed.
Keep this as an exploratory partial run, with safety adaptation and failures
visible, rather than a benchmark win.

## Resume boundary

Original project remains at b93a947217fe469767378b532542de8cd278cc9f,
with the same three untracked user design documents. Accepted task01 is
available independently; the current disposable workspace also contains the
unaccepted extraction and tests. No full-checkpoint patch is authorized.

Resume requires explicit additional task02 invocation allowance and an
available exact model endpoint. Retain the edit-only restriction, final
review feedback, source snapshots and all previous attempts. Do not reset the
manifest, silently substitute Gemma/Nemotron, or proceed to task03 on the basis
of green checks alone. Keep frozen experiment files unchanged so the retained
run can verify its inputs. Current status documentation lives outside that
frozen input set.
