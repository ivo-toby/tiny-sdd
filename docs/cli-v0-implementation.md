# Testable CLI increment

2026-09-05: operator authorized implementation and bounded Titan benchmarking
for hands-on testing on 2026-09-06. This narrows the agreed controller/worker
direction into an initial local CLI, not a production-readiness claim.

## Delivery boundary

One dependency-free Node ESM CLI, runnable as `node bin/tinysdd.mjs`, with an npm
bin entry. Human-readable output by default, one JSON result on stdout with
`--json`; progress goes to stderr. No automatic commits, patch application,
package installation, global configuration edits, external messages or WDD.

Controller mode operates inside the caller's harness. Worker mode dispatches
exactly one approved task through Pi in a disposable workspace, retaining its
result for the caller to verify and accept. Completion never means acceptance.
No worker bash or arbitrary extensions in this initial adapter. MCP is deferred.

## Config contract

`.tinysdd/config.json`: schemaVersion1, optional defaultWorker, workers map.
Each named worker: `type:"pi"`, exact `provider`, exact `model`, optional
`profile` (project-relative JSON path), `skills` (project-relative SKILL.md
paths), `instructions` (project-relative text paths), `limits` with timeoutMs
(default300000, max900000), maxToolCalls(default40,max100).
No credentials or endpoint configuration in this schema; Pi supplies connection
data. No guessed aliases or fallback. Unknown adapter types fail explicitly.

Optional config.local.json overrides only defaultWorker and named workers.
Workers are replaced WHOLE by name, not recursively merged. Arrays replace;
null and unknown keys are errors. All effective workers are validated. Explicit
`--worker` selects a name; it does not rewrite config. Profiles contain
schemaVersion1, id, optional instructions string, optional runtime object with
thinking (`off|minimal|low|medium|high`), reasoning boolean and compat object
(only thinkingFormat and supportsDeveloperRole allowed). Descriptive evidence
and limitations arrays of strings are optional. Profile is guidance/settings,
never permission or a replacement for repository instructions.

## Controller interface and evidence

- `init [--worker NAME --provider ID --model ID]`: create config only if absent,
  preserve existing files, create `.tinysdd/.gitignore` ignoring runs/ and
  config.local.json. Controller-only init needs no model. Noninteractive defaults
  work for either human or agent; no hidden model calls.
- `config show|validate`: validated effective config plus file provenance.
- `task add --id ID --brief PATH [--context PATH] [--depends-on ID,ID] --allow PATH[,PATH]`:
  register a project-relative Markdown brief and exact allowed file paths.
  Briefs and optional context manifests may live only under `.tinysdd/tasks/`;
  review evidence may live only under `.tinysdd/reviews/`. Other controller state
  remains inaccessible. A context manifest is strict JSON declaring concise facts
  plus exact source line ranges; its digest is bound to approval and it is
  compiled with source/excerpt digests before a worker runs.
  Task IDs/names use safe lowercase letters/digits/hyphen/underscore only.
  Brief is prepared by human/outer agent, not generated implicitly by CLI.
- `task approve --id ID --by LABEL --reason TEXT`: record caller attribution,
  brief digest and current dependency acceptances. Attribution is a caller claim,
  not authenticated identity. Approval does not survive brief/dependency changes.
- `status`, `next`: expose blocked prerequisites, stale approvals, next pending
  approval, or ready task. Never execute or automatically advance.
- `task packet --id ID`: approved task with resolved brief text/digest, optional
  context manifest text/digest, allowed
  paths, dependencies, and caller approval. Fail if prerequisite not accepted,
  approval stale or already accepted. Include latest revision review's evidence
  text/path/digest when present; refuse silently changed review evidence. Worker
  uses this same packet contract, including the review constraints.
- `task review --id ID --verdict accepted|revision|blocked --evidence PATH
  --by LABEL`: record external review attribution and evidence file digest.
  Acceptance requires current approval, accepted prerequisites and nonempty
  evidence. Evidence is caller-supplied, never converted into CLI-observed tests.
  Revision makes task ready under existing current approval; blocked requires
  renewed approval. Acceptance digest binds approval, evidence and allowed file
  content (missing files represented explicitly). File/evidence/brief changes
  invalidate acceptance and dependent approvals. No automatic repair.

Store controller state at `.tinysdd/runs/controller.json`, schemaVersion1.
Use a short exclusive lock for mutations and atomic rename; reject concurrent
mutation rather than corrupting state. Preserve malformed state for diagnosis.
Refuse symlinked state/config paths. No arbitrary command execution in controller.
Stale locks fail clearly and remain for manual inspection; no racy automatic
lock-directory reclamation in this first increment.

## Worker interface

`worker run --task ID [--worker NAME]`: resolve packet/config, require Pi and
Linux bubblewrap, and fail closed if isolation is unavailable. First release
is Linux-only for worker execution; controller is portable Node.

The adapter API accepts `{projectRoot, packet, worker, profile}` and returns a
schemaVersion1 result envelope: runId, taskId, outcome
(`completed|failed|timeout|tool_limit|output_limit`), model identity, observed
process/assistant termination, changed paths, scope violations, artifact paths,
and separately labeled model claims. It never records acceptance or invokes
checks under inference credentials. Preserve raw events locally; warn they can
contain source code. Copy excludes .git, .tinysdd, node_modules, .env*, credential
files and symlinks; this is not a general secret detector. Explicitly selected
instructions/skills and applicable AGENTS.md are recorded by digest and supplied
alongside the brief. A declared context manifest yields a separate, bounded
compiled implementation-context artifact; it contains only approved facts and
exact selected source lines, labeled as reference data rather than instructions.
It fails on invalid or oversized context instead of silently truncating. Keep
Pi's built-in tool guidance and append worker contract.

Only a disposable candidate copy is writable by Pi; source project and runtime
credential files are not exposed. Use temporary Pi state, filtered credential
references, read/write/edit tools, no extensions or global skill inheritance.
Inference networking is available; generated code is never executed by worker.
Record candidate changes and a patch, including out-of-scope changes as violations
rather than silently discarding them. Never apply a patch to the original.
The candidate root uses `TINYSDD_TMPDIR`, then `TMPDIR`, then `/tmp`; it must be
an existing real directory. This makes the worker usable where `/tmp` is a small
shared mount without changing project configuration.

Outer harness reviews/applies a patch using its ordinary tools and executes
verification in its appropriate environment, then calls task review explicitly.
This initial boundary is deliberately visible; automatic code execution and
automatic patch application are not hidden conveniences in v0.

## Verification and benchmark bounds

Test config merges, stale approvals/dependency propagation, traversal/symlinks,
state locking, clean JSON output, subprocess failure classification, write-scope
reporting, and no automatic acceptance. Include a runnable controller example
and a live Pi smoke, clearly separate from deterministic tests.

Podcast successor permits three additional focused task02 repair invocations,
with primary verification between them; task03/04 retain three each. Benchmark
at most three configured Titan model IDs on a common fresh-copy bounded task,
one initial call and at most one fixed feedback revision each. Run serially on
Titan. Preserve failures; label this a small engineering pilot, not a ranking
or causal proof of prompt benefit. Do not spend the whole increment on retries:
after those bounds, retain blockers and deliver the CLI independently.
