# Exploratory workflow qualification

Date: 2026-09-05
Status: planned before these runs; not a frozen efficacy comparison

Scope: [the current TinySDD increment](../../docs/current-scope.md).
The [batch-reservation protocol](protocol.md) owns the behavioral contract and
held-out acceptance oracle. Neither changes during this qualification.

## Questions and observations

First qualify Pi's ordinary read, write, edit, and bash tools with a disposable
marker fixture. A prescribed command checks both a copied marker file and an
edited module. Success requires matching final file bytes and successful tool
events, not just a model's success message. All three exact configured model IDs
participate through the existing LiteLLM proxy. No shared configuration changes.

Then run the real batch-reservation task with the unchanged TinySDD skill. Use
Pi's explicit skill loading and persistent session options, verified against the
installed source. A second CLI invocation is experiment capture around Pi's own
conversation, not a new product controller or a skill requirement.

| Observation | Evidence required |
| --- | --- |
| Skill activation | Expanded skill instructions in the actual user-message event, plus access to its template |
| Approval pause | A source-backed brief and a visible request for approval; implementation and tests remain unchanged, including no observed transient implementation/test writes |
| Continuation | The same saved Pi session contains the first exchange and the explicitly labeled simulated approval |
| Meaningful red | Actual failing check output for the missing batch behavior before implementing it; setup/import failures do not count |
| Correctness | The unmodified held-out checks pass against the captured final candidate, with actual test counts and exit status |
| Scope and handoff | Final changed paths and raw tool actions stay within the task; test claims agree with actual observations |

The primary agent inspects the first exchange and brief before issuing the
prewritten approval. This is an exploratory intervention, not an independently
scored or fully automated trial. If the participant implements before approval,
record the workflow failure; do not repair its solution or pretend it paused.
If its brief contradicts the contract, record that and stop that attempt rather
than supplying a corrective hint.

The approval text is explicitly a simulated benchmark-user message. It does not
claim that Ivo personally reviewed a generated brief. The user has authorized
these synthetic experiments, including their test implementation.

## Boundaries and limits

- Keep the participant workspace separate from the held-out checks, references,
  and experiment artifacts. Only the treatment receives the skill and template.
- Use the same task facts and four ordinary tools for baseline and treatment.
  No unrelated skills, extensions, prompt templates, or ambient context files.
- Keep the existing skill/template and task contract unchanged during this
  qualification. Any later revision gets a new retained run, never an overwrite.
- Each workflow attempt has at most two model invocations, 180 seconds of
  cumulative captured Pi wall time, and 60 observed tool starts. Stopping uses
  the capture helper's polling; record any overshoot. Review time between
  invocations is not model runtime and is not included in that ceiling.
- The capture helper retains a bounded 16 MiB prefix per output stream. A
  truncated or malformed capture is not a successful qualification.
- Streaming token usage is disabled in the configured providers. Token usage
  and a token ceiling are therefore unavailable, not measured zeros. Requested
  thinking-off behavior is also not established by the earlier read smokes.
- Preserve every attempt, exact prompts, runtime metadata, initial sources and
  digests, phase-boundary workspace snapshots, session messages, and raw tool
  results. Do not retain credential values in shareable artifacts.
- These tools and instructions do not enforce an OS security boundary. The user
  enabled full access. Inspect model-authored code before separate verification;
  run only the synthetic task and do not pass provider credentials to its tests.

## Decision

Successful tool and conversation checks make the setup ready for a pilot; they
do not establish a benefit from TinySDD. Score behavioral correctness separately
from approval and verification workflow. If a baseline is run here, it is also
exploratory and cannot establish an improvement from one attempt per arm.

Before a frozen comparison, settle continuation rules and effective resource
controls, and establish response freshness. Unknown proxy caching or retries
remain explicit limitations. Keep backend prompt/KV caching distinct from
replayed response caching. Do not spend repetitions on a runner defect.

## Qualification-prompt revision after the first observations

The first tool-chain smokes (09:01 UTC) produced a pass for Gemma and missing
trailing newlines in Qwen's and Nemotron's copied files. Qwen attempted repairs,
temporarily introduced an invalid JavaScript string, and reached the 12-tool
limit. Nemotron stopped with a failing assertion. These are retained behavioral
failures on the original byte-copy task, not connection failures.

The next qualification prompt states both representations explicitly: copy all
37 bytes including the newline, but substitute only the 36-character UUID into
the JavaScript string. The oracle and resource limits are unchanged. Rerun all
three participants with this revised prompt; do not relabel the original runs
or infer a TinySDD benefit from this separate, uncontrolled prompt experiment.

Raw inspection also found a scorer defect: equivalent absolute paths to
`check-output.txt` must count as the same file as the relative path. Correct
that matcher before another run. It does not turn Qwen's original resource-limit
attempt into a pass; the final verification was not observed there.

## Approval-instruction revision after the first workflow observations

The original-skill Qwen attempt
`workflow-2026-09-05T09-06-26-759Z-qwen-treatment-b8272bc3` wrote a brief and then
implemented in its first exchange, without an approval message. The original
Gemma attempt paused before implementation. Both attempts retain the exact
original skill, so the following revision does not change their treatment.

Revise only the skill's approval instruction: proposing a new brief must end
the turn, and implementation must wait for a subsequent user message. An
implementation request does not approve an unseen brief. Do not change the
task contract, checks, tool budget, template, or red-check instructions.

Run fresh attempts with this revision on Qwen and Gemma to see whether the
approval pause is observed. This is exploratory refinement after inspecting
outcomes, not a confirmatory comparison. Do not claim transfer from repeating
the same task; a new held-out task remains necessary before retaining a general
effectiveness claim.
