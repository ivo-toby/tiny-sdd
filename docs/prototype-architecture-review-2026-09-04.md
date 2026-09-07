# TinySDD prototype architecture review

**Status:** historical review record; not a current-scope approval  
**Date:** 2026-09-04  
**Reviewed artifact:** `prototype-architecture.md` draft  
**Reviewers:** fresh Qwen3.6-35B-A3B and Gemma 4 26B-A4B calls through Pi  
**Current scope:** [current-scope.md](current-scope.md)

> Historical-review notice: This is a dated review of the 2026-09-04 prototype
> architecture draft. It is not a re-review of the current scope and does not
> approve v0 requirements. See [current-scope.md](current-scope.md) for the
> current authority.

These are model-produced counterexamples, not independent proof or human
approval. Each accepted finding below was checked against the architecture before
the document was changed.

## Disposition

| Finding | Disposition | Design change |
| --- | --- | --- |
| Tool authority appeared in the model-visible packet without an explicitly separate enforcement object. | Accepted. | Added a controller-owned in-memory execution capability captured by tool closures. The model can neither provide nor select it. |
| A model `DONE` result could contradict observed tool/check state. | Already stated, strengthened. | Added a fixed reconciliation order in which capability checks, tool traces, workspace snapshots, and controller evidence precede the proposed model status. |
| Event replay did not specify exact sequence/hash-chain validation. | Accepted. | Defined canonical event bytes, filename digest, previous-event link, validated replay, directory flush, and projection-head checks. Removed the self-referential event digest field. |
| The controller lease did not define acquisition or stale recovery. | Accepted. | Defined an atomic Linux lock-directory lease with hostname, PID, process start time, controller ID, explicit stale recovery, and ambiguous-lease blocking. |
| Task failures had no explicit feature-state transition back to planning/research/human ownership. | Accepted. | Added `task.needs_replan`, `task.needs_research`, `task.needs_human`, `TASKS_BLOCKED`, and failed feature-acceptance routes. |
| The control/treatment benchmark boundary was not fully repeated in the architecture. | Partly accepted. | The evaluation plan already defined it; the architecture now states a total-effect comparison contract and requires ablations before attributing causality to one mechanism. |
| The prototype should remove its one-task constraint because schemas can represent multiple tasks. | Rejected. | Representational capacity is not implementation cost. One task deliberately removes scheduling, cross-task invalidation, and interface-evolution behavior from the first executable slice. |

## Added acceptance coverage

- Model-visible authority changes cannot alter the controller-side execution
  capability.
- A `DONE` result plus a failed required check remains blocked.
- Middle-event corruption, gaps, reordered events, filename/digest mismatch, and
  broken hash links block replay.
- A killed controller lease can be recovered only when ownership is
  unambiguously stale; two live controllers cannot mutate concurrently.
- A task requiring re-plan cannot drift into feature acceptance.
- Benchmark records make model, starting repository, prompt digests, ceilings,
  tools, and checks explicit for control and treatment.

## Runtime behavior during review

Gemma returned raw schema-valid JSON. Qwen returned one fenced JSON value. This
matches the pilot observation that structured semantics can be useful while text
serialization still needs strict adapter handling. The architecture's preferred
Pi path now uses a terminating `stage.finish` custom tool with stage-specific
TypeBox parameters, reducing reliance on free-text JSON.

## Regression review after revision

Both runtimes returned `APPROVE`. Gemma reported no remaining findings. Qwen
reported three minor edge cases, all accepted:

- the pinned Pi SDK now requires a contract test proving that fresh sessions
  receive distinct closure-bound controller capabilities;
- capability expiry now aborts the session, signals in-flight tools, terminates
  command process groups, rechecks before atomic writes, and discards late events
  from authoritative evidence;
- returning from a task to research now explicitly creates a new research
  version that supersedes the prior one before dependent artifacts are
  invalidated.

Qwen again wrapped its JSON in one Markdown fence; Gemma returned raw JSON.
