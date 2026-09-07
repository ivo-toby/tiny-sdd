# Verification and run protocol

Approved for controlled execution; [actual operator delegation](approval.md).
Contract: [feature.md](feature.md). Invocation state is recorded per run.

## Roles and approval

The primary strong model owns contracts, oracle expectations and review. Luna-max
handles mechanical isolation, capture and check implementation against those
expectations. Qwen is the first implementation participant via Pi and the exact
configured model ID `randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf`.
Resolve the existing Pi provider/model pairing before freezing the invocation;
do not invent aliases, fallbacks, configuration edits or another model panel.

Use the unchanged experiment-003
[preparation skill](../003-idempotent-reservations/skills/tinysdd-prepare/SKILL.md)
and [task skill](../003-idempotent-reservations/skills/tinysdd-task/SKILL.md).
Supply only applicable project guidance and selected task context. Record the
effective skill/prompt/configuration and runtime versions; keep credentials out
of copied fixtures, prompts, manifests and published captures.

The operator reviews this packet before implementation. Each task returns its
patch and evidence for strong-model review and an actual operator decision.
Neither a document status nor a model's claimed approval is authorization.
Do not silently simulate approvals. Broader unattended progression requires an
explicit delegation and a recorded boundary.

## Pre-dispatch gates

1. Verify baseline identity against the inventory; detect source/document drift.
   Use a disposable credential-free copy, preserving original source/tests and
   the user's three untracked design documents. Do not apply generated patches
   to the user's working tree during the experiment.
2. Run the existing suite, no-output typecheck and build safely. Tests use fixed
   absolute `/tmp` filenames: a new workspace or `TMPDIR` alone is insufficient.
   Require private `/tmp`, a disposable writable workspace and network isolation
   permitting only local fixtures. The final baseline verified this arrangement
   in direct primary-agent execution; delegated contexts had narrower permissions.
   Use that observed working route rather than weakening containment to match
   a worker's capabilities. Review writable mounts separately for generated code.
   Never execute fixed-path cleanup on shared host `/tmp`.
   Probe ephemeral `127.0.0.1` listen **and fetch** in the selected HTTP-test
   environment before dispatch; a successful host probe does not establish
   namespace support. Keep split-environment results separate and retain the
   failed full-suite run; do not relabel it green after a narrower retry passes.
3. Prepare independent checks for A1–A10 from the approved contract. The primary
   reviews expected values before model output exists. Checks are not yet
   implemented by this preparation packet; do not claim oracle preflight passed.
4. Validate the checks with minimal disposable good/wrong implementations or
   deliberate mutations: awaiting the fake blocks acknowledgement; per-request
   managers lose IDs; poll-resubmission changes counts; queue-on-rejection stalls;
   reference-return corrupts status; TTL based on creation removes a long job.
   Include a positive control; missing imports are not a killed behavior mutant.
   Keep oracle/probe implementations outside participant context and record them.
5. Freeze hashes of source, documents, skills, task prompts and independent
   checks; record approval and exact limits before the first Qwen invocation.

## Approved execution limits

One sequential task at a time. Per task: one initial invocation plus at most two
bounded review revisions, each capped at 15 minutes and 100 tool calls; maximum
45 minutes participant execution per task, excluding verification/review. Report
timeouts and transport failures separately and charge retries to this budget;
no automatic model substitution. Operator may explicitly approve a changed
budget or contract, recorded as a protocol revision before further execution.

Use existing experiment capture tooling where it meets these limits; verify
its behavior before invoking it, rather than assuming all knobs are enforced.
Pi needs only the named LiteLLM endpoint for model inference; model-access
credentials belong in the runtime boundary, not in the participant workspace.
Execute generated code/checks separately in the credential-free, offline
verification environment. Ordinary Pi tools are not a claimed security sandbox.
No real generation, publishing, remote-media calls or application deployment.

Participant checks and independent checks are separate. Record initial behavior
before feedback, exact review findings, permitted revision files and outcomes.
Do not silently repair participant code with a stronger model. An oracle defect
requires a versioned correction and re-evaluation; it is not a participant fail.

## Evidence and interpretation

Per task retain source diff, original-file preservation check, transcript/tool
results, actual commands/exit statuses, duration/tool use where available,
behavioral red evidence or gap, review findings, revisions and approval source.
Participant self-report is not observed verification. Build, focused tests,
full regressions and independent checks are separate reported outcomes.

Integrated acceptance requires A1–A10, resolution of substantive review findings,
and fake-only smoke verification of the **built** app/server factories. Do not
start `dist/index.js` against real configuration. Record local Node 24 versus
Docker Node 20 coverage honestly; container/production compatibility is untested.

This is one real-repository exploratory feature run, not a randomized benchmark
or proof of reliability. The source already has detailed human-authored design
documents: this evaluates refinement/decomposition and implementation, not
specification generation from a blank request. Record preparation and review
effort and classify contract gaps, implementation errors and verification gaps
separately. No model-profile benefit claim without a later matched comparison.
