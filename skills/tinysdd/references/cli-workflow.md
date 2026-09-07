# CLI workflow

Run `tinysdd --help` for the installed interface. In a source checkout use
`node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs`; run it from the target project
or select `--project /path/to/project`. Add `--json` for machine-readable output.

Controller-only setup needs no model:

```sh
tinysdd init
tinysdd task add --id validation --brief docs/tasks/validation.md --allow src/validation.ts,tests/validation.test.ts
tinysdd task approve --id validation --by operator --reason 'User approved the brief in this conversation'
tinysdd next
tinysdd task packet --id validation --json
```

Attribution and reason must reflect actual authority, not the example text.
For dependent tasks use `--depends-on validation`. State and review artifacts
live under `.tinysdd/runs/`; briefs remain user-visible project documents.

Worker setup when config does not yet exist:

```sh
tinysdd init --worker qwen --provider titan --model titan/llamacpp/qwen3.6-35b-a3b-256k
tinysdd config show --json
tinysdd worker start --task validation --worker qwen --json
tinysdd worker status --id LAUNCH_ID --json
```

Existing config is preserved: edit it deliberately to add named workers.
Optional `.tinysdd/config.local.json` replaces entire workers by name; it does
not deep-merge partial worker fields. Inspect effective configuration before
dispatch. Copy a suitable profile into the project and set its relative path
on the selected worker when needed. Profiles do not include credentials.

Worker mode initially requires Linux, bubblewrap, Pi and the exact model in
Pi's configured models. It uses only read/write/edit tools in a disposable copy.
No generated code is run. Source files may appear in local raw events and sent
model context: use only authorized projects and providers. Excluded filenames
are a precaution, not a general detector for secrets embedded in source.

Use `worker start` for real model calls from an orchestrating agent. It launches
the controller in a detached process so short-lived agent shells cannot send an
unintended SIGTERM to a still-working model. `worker run` is foreground mode for
local debugging only. Poll `worker status` until it returns `finished`; an
`interrupted` launch has no usable candidate result and must be recorded as such.
For a review revision, reuse a prior completed, scope-clean candidate explicitly:
`tinysdd worker start --task validation --worker qwen --base-run WORKER_RUN_ID`.
TinySDD overlays only that prior run's changed allowed files into the new
disposable workspace and records the lineage; it never changes the source project.

Inspect the finished result envelope and patch. Process completion is not passing
verification, and scope violations are review blockers. Use the outer harness
to verify the candidate in an appropriate isolated environment, apply the
reviewed patch, and retain observed test results plus review findings in a file.
Then record the decision explicitly:

```sh
tinysdd task review --id validation --verdict accepted --evidence docs/reviews/validation.md --by operator
tinysdd status
tinysdd next
```

Use `revision` for a bounded repair or `blocked` for missing authority/context.
The next revision packet includes the recorded review evidence as feedback;
do not modify it silently after recording the decision.
Evidence is caller-supplied; the controller does not claim to have run its
commands. Acceptance is bound to the brief, dependencies, review evidence and
allowed file contents. Later changes can invalidate it.
