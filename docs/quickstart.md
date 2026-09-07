# Try TinySDD locally

This is an early local prototype. The controller does not require a model.
Spawned workers require Linux, bubblewrap and an existing Pi installation with
the exact provider/model configured. No package installation is needed for the
dependency-free CLI itself. Node24 is the development/test environment.
The first adapter expects Pi in the same installation's `bin` directory as the
Node executable running this CLI; other installation layouts are not qualified.
Workers create disposable candidate directories under `/tmp` by default. Set
`TINYSDD_TMPDIR` to an existing real directory on a volume with enough free
space when `/tmp` is small or shared; the worker removes its candidates after it
has retained the run artifacts under the project.

From this checkout:

```sh
npm test
node bin/tinysdd.mjs --help
```

Use `node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs` wherever the examples below
say `tinysdd`. `--project /path/to/project` selects the target explicitly;
otherwise commands use the current directory. No global npm/Pi setup is changed.

## Use it inside your coding agent

Load this checkout's [TinySDD skill](../skills/tinysdd/SKILL.md) into your agent
and ask it to prepare one bounded feature. The skill covers either implementation
inside that agent or delegation to a named worker. Product decisions and review
remain with you or the authority you explicitly delegate to the outer agent.

The first controller sequence is:

```sh
tinysdd init
tinysdd task add --id first-change --brief docs/tasks/first-change.md --allow src/example.mjs,test/example.test.mjs
tinysdd task approve --id first-change --by ivo --reason 'Reviewed this task brief'
tinysdd next
tinysdd task packet --id first-change --json
```

Create the brief first; the [template](../skills/tinysdd/assets/task-brief.md)
identifies its useful contents. Use actual approval attribution, not copied
example text. Allowed paths are exact files, including not-yet-created files;
no globs. Dependencies use `--depends-on first-change` on a later task.

You can implement the packet in your current agent without invoking a worker.
The controller never changes the model in that outer agent.

When a worker needs an exact API, schema, or acceptance oracle, add a reviewed
context manifest under `.tinysdd/tasks/` and pass it with `--context`. TinySDD
will compile only its declared source line ranges and record their digests; see
[the context compiler guide](context-compiler.md). Omit it for genuinely simple
tasks rather than padding prompts.

## Configure a worker

For a new project configuration:

```sh
tinysdd init --worker qwen --provider titan --model titan/llamacpp/qwen3.6-35b-a3b-256k
```

For an already initialized project, edit `.tinysdd/config.json` deliberately;
re-running init does not replace it. A configuration with two named workers:

```json
{
  "schemaVersion": 1,
  "defaultWorker": "qwen",
  "workers": {
    "qwen": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/qwen3.6-35b-a3b-256k",
      "profile": "tinysdd-profiles/qwen36.json",
      "limits": { "timeoutMs": 300000, "maxToolCalls": 40 }
    },
    "gemma": {
      "type": "pi",
      "provider": "titan",
      "model": "titan/llamacpp/gemma4-26b-a4b-256k"
    }
  }
}
```

Copy [the exploratory Titan Qwen profile](../profiles/qwen36-titan.json) into
the project's `tinysdd-profiles/qwen36.json` before using this configuration.
It controls Pi's request-level thinking flag; it is not a promise of code quality.
Other machines must use their own exact configured IDs. No fallback is automatic.

Optional worker `skills` lists project-relative SKILL.md files; `instructions`
lists additional project-relative text resources. Applicable AGENTS.md guidance
is included separately. Profiles cannot override task permissions. MCP and
arbitrary runtime extensions are not supported in this first adapter.

Optional `.tinysdd/config.local.json` replaces whole workers by name, not nested
fields. Arrays replace; null/unknown fields are errors. Credentials stay in Pi's
existing configuration/environment, not either project config file. Inspect
resolution before dispatch:

```sh
tinysdd config validate
tinysdd config show --worker qwen --json
tinysdd worker start --task first-change --worker qwen --json
# Poll the returned launch id until status is "finished":
tinysdd worker status --id LAUNCH_ID --json
```

## Controlled benchmark replay

To compare workers fairly after the live project has moved on, replay the
original approved packet against a prior worker's immutable `workspace-before`
snapshot. This is a non-applying experiment: it neither refreshes stale task
approvals nor changes task status. The replay records both its `baselineRun` and
the exact packet in `.tinysdd/runs/`.

```sh
tinysdd worker start --task first-change --worker gemma \
  --baseline-run WORKER_RUN_ID --json
```

Use a run from the same task. Do not use `--baseline-run` for a revision; use
`--base-run` only when deliberately overlaying a reviewed prior candidate.

## Review the result

The worker edits a disposable copy using read/write/edit only. Its result points
to local evidence and a patch under `.tinysdd/runs/`. It does not run tests,
apply the patch, commit, or accept its own result. Inference can reach the selected
provider; use only source you are authorized to send there. Raw event files may
contain source. Filename exclusions are not a general secret scanner.
The candidate omits `.git`, `.tinysdd`, `node_modules` and common credential files;
source symlinks are rejected. Put needed dependency interfaces in the task or
selected instruction resources rather than assuming the worker can inspect an
installed dependency tree.

Have your outer agent inspect scope violations and the diff, verify in an
appropriate credential-free disposable environment, and apply only the reviewed
patch. Preserve the observed checks and review findings in a project file. Then:

```sh
tinysdd task review --id first-change --verdict accepted --evidence docs/reviews/first-change.md --by ivo
tinysdd status
tinysdd next
```

Use `revision` or `blocked` instead of accepting an incomplete result. Caller
evidence is labeled as such; the CLI does not claim to have executed its tests.
For a revision, the next packet includes the recorded review feedback. Retain
that evidence unchanged until dispatch, or explicitly record the revised review.
Changes to a brief, accepted files, evidence or prerequisites invalidate affected
decisions. Approval labels are audit records, not authenticated identities.

Controller mutations use an exclusive lock. If a crash leaves a stale lock, the
CLI stops for manual inspection; it does not guess that another writer is safe
to remove. Do not remove a lock while its owning process is still active.

This version deliberately leaves verification/application in the outer harness.
It is suitable for controlled testing, not unsupervised production changes.
