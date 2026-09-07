# Experiment 001: atomic batch reservations

Status: draft; not frozen or run

Scope authority: [current scope](../../docs/current-scope.md).
Treatment candidate: [TinySDD skill](../../skills/tinysdd/SKILL.md) and its
[task-brief template](../../skills/tinysdd/assets/task-brief.md).

## Question

Does a source-backed task brief with visible approval reduce incorrect batch
reservation behavior or human repair, compared with ordinary Pi given the same
task and repository facts?

This first fixture is a synthetic brownfield repository, not evidence from an
existing production project. It provides a small working single-item reservation
module and asks the participant to add batch reservations. It targets partial
updates after rejection and duplicate-item accounting. A successful pilot only
qualifies this experiment path; it does not establish general skill efficacy.

## Behavior and expected-value source

The user authorized proceeding with the fixture and checks on 2026-09-05 and
explicitly set aside the code-style skill for this task. The source of truth is
this behavioral specification, copied into participant-visible `TASK.md`. The primary
agent owns its meaning; delegated fixture/check implementation must not invent
additional acceptance requirements.

- Stock maps item IDs to nonnegative safe-integer quantities. Fixture callers
  supply valid stock; stock validation is outside this task.
- A reservation line contains an item ID and a quantity. The existing
  `reserveOne` behavior is preserved.
- Add `reserveBatch(stock, lines)`. Process lines in input order. On each line,
  reject a quantity that is not a positive safe integer, then reject an unknown
  item, then reject a quantity larger than the remaining stock for that item.
  The first encountered rejection determines the error code.
- Error codes are `INVALID_QUANTITY`, `UNKNOWN_ITEM`, and `INSUFFICIENT_STOCK`.
  An error result contains the original stock values, with no partial reservation.
- Duplicate items consume the same running stock. Successful batches return the
  fully reserved stock. An empty batch succeeds with unchanged values.
- Never mutate the caller's stock or lines on success or rejection. Object
  identity is not part of the contract. Preserve unrequested items and the
  existing single-item API.

Result shape: a discriminated union of `{ ok: true, stock }` and
`{ ok: false, error, stock }`. Concrete TypeScript exports and exact verification
commands will be frozen with the fixture, not invented during a scored run.

Representative expectations, independent of participant output:

| Starting stock | Lines, in order | Expected result |
| --- | --- | --- |
| pen: 5, pad: 2 | pen: 2, pad: 1 | Success; pen: 3, pad: 1 |
| pen: 5 | pen: 2, pen: 3 | Success; pen: 0 |
| pen: 5 | pen: 3, pen: 3 | `INSUFFICIENT_STOCK`; pen: 5 |
| pen: 5, pad: 1 | pen: 2, pad: 2 | `INSUFFICIENT_STOCK`; pen: 5, pad: 1 |
| pen: 5 | pen: 2, pen: 0 | `INVALID_QUANTITY`; pen: 5 |
| pen: 5 | pen: 2, eraser: 1 | `UNKNOWN_ITEM`; pen: 5 |
| pen: 5 | none | Success; pen: 5 |

Use dependency-free Node 24 `node:test` integration checks calling the exported
TypeScript module through Node's native type stripping; this is not static type
checking. No package downloads or live services are needed for fixture checks.
Check both returned state and unchanged inputs. A known-correct implementation
must pass the scorer; deliberately wrong
partial-update and duplicate-accounting implementations must fail it.

## Comparison

Both arms receive identical starting code, task facts, ordinary Pi tools, and
task-wide resource ceilings. Disable unrelated extensions, skills, templates,
and ambient context files using options verified against the installed Pi.

An earlier restricted session dropped subprocess pipe output. Both arms receive
the same instruction to redirect check output to a workspace log and read it.
Capture scripts use regular-file descriptors. Node tests run without
child-process test isolation so their actual subtests and failures are
observable. These are environment qualifications, not proposed skill
improvements; the earlier pipe observation is historical rather than a current
runtime blocker.

- Baseline: ordinary Pi, no TinySDD instructions or template.
- Treatment: the same Pi setup plus the versioned TinySDD skill/template.

The skill is the only planned treatment difference. Prompt loading and skill
activation must be observed in an exploratory tool-use run before freezing.
Run each attempt in a separate disposable workspace and fresh session. Keep
acceptance-check source outside participant workspaces and supplied context;
run the held-out checks separately against the captured final module. Hold out
concrete cases, not behavioral requirements needed to implement the task.

Prewrite any clarification answers and benchmark approval messages. Label
automated approvals as simulated, not human approvals. Permit the same facts
and continuation budget in either arm; count clarification and approval turns
separately. Neither the primary agent nor Luna may rescue a scored solution.
Resolve unsupported questions by the frozen stop policy, not ad hoc hints.

Before starting scored runs, record numeric time, token/output, tool-call, and
continuation ceilings and how they are measured. These values remain pending
write/edit/check qualification, skill activation and approval continuation, and
the frozen comparison; this draft is not an executable protocol.

## Evidence and decisions

Use the three exact direct Pi model IDs in the current scope through the existing
LiteLLM proxy. The user confirms no fallbacks. First qualify ordinary tool use and
capture on an accessible local runtime. Then freeze the protocol and run three
fresh attempts per arm per accessible runtime, alternating arm order.

Retain the fixture, skill, template, prompt, scorer, and configuration digests;
actual runtime identity and exposed settings; raw messages and tool results;
final diff; scorer output and exit status; wall time, exposed usage, retries,
interventions, and termination reason. Store runs under
`experiments/runs/001-batch-reservation/<run-id>/`. Do not capture credentials.
Unobserved values remain `UNKNOWN`.

Report every attempt, including failures and infrastructure-invalid runs. Score
behavioral correctness and scope violations separately from whether the skill's
workflow was followed. A brief's existence or a model's `DONE` is not a pass.
Attribute no benefit if both arms succeed equally; record the effort difference.
Refine only from observed failures, then check any retained improvement on a new
held-out task before claiming transfer. No controller is a required next step.

## Current readiness

- Draft skill and template exist; structural validation passed.
- Fixture and check implementation were authorized on 2026-09-05; the code-style
  skill is set aside for this task, not deleted or globally changed.
- A Luna-max read-only diagnostic found all three configured model IDs in Pi
  0.84.4. `pi auth check --no-refresh --model
  'randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf' --json` returned
  `{"status":"ready","provider":"randal-mi50","authType":"api_key"}`.
  This checks configured credentials, not connectivity or inference.
- An earlier restricted-session startup check was blocked by read-only
  settings/auth lock paths under `/home/ivo/.config/pi/agent`; source inspection
  found no CLI read-only mode for ordinary model runs. `--offline` and
  `--no-session` did not remove those locks. That failure is historical. A
  supported isolated `PI_CODING_AGENT_DIR` now starts Pi successfully, writing
  temporary settings/model metadata only and referencing credentials from
  process environment. Global Pi files remain untouched.
- An initial tool-smoke attempt returned empty captured streams; a trivial
  subprocess reproduced the same pipe-capture failure. The attempt is retained
  under `experiments/runs/001-batch-reservation/smoke-2026-09-05T07-39-51.546Z-qwen-8ca69f2c/`
  as infrastructure-invalid, not a model failure. Whether it reached inference
  is unobserved. File-descriptor capture subsequently passed subprocess checks.
- A subsequent captured Qwen attempt emitted `Connection error.` with no tool
  calls. A direct read-only diagnostic returned `EPERM` on `connect` to the
  common LiteLLM endpoint. This was a historical sandbox network restriction,
  not an OS ownership issue, missing proxy setting, or model failure.
- Fresh exploratory read-tool smokes now pass for Qwen, Gemma, and Nemotron:
  [Qwen](../runs/001-batch-reservation/smoke-2026-09-05T08-44-34.810Z-qwen-3be9bd4b/summary.json),
  [Gemma](../runs/001-batch-reservation/smoke-2026-09-05T08-45-02.173Z-gemma-a38bd08c/summary.json),
  and [Nemotron](../runs/001-batch-reservation/smoke-2026-09-05T08-45-03.293Z-nemotron-e768118b/summary.json).
  Each has CLI exit 0, a real successful read, no assistant error, and an exact
  fresh-marker match. Gemma also performed a successful `ls marker.txt` before
  the read. These runs qualify read-tool connectivity only.
- See [the setup results](results-2026-09-05.md) for verified oracle checks and
  the later [workflow results](workflow-results-2026-09-05.md) for actual coding
  and approval-pause observations. Qwen/Gemma tool chains are qualified;
  Nemotron's byte-copy check remains unsuccessful. The local workflow attempts
  exposed approval, regression-test preservation, and completion failures.
  A narrow approval-wording revision is under exploratory evaluation.
- A frozen baseline comparison, fresh-response qualification, transfer to a
  new task, and a general efficacy conclusion remain pending. Do not count the
  exploratory coding or revised-pause observations as completed scored trials.
