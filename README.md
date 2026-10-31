# TinySDD

Spec-driven development for small implementation models, with quality as the
primary goal. A strong coding agent prepares specifications, context and
acceptance tests; a smaller model implements bounded tasks; you review and
accept the result.

TinySDD provides a Node.js CLI, coding-agent skills and retained execution
records. The CLI manages setup, tasks, sandboxed workers, checks and evidence.
The outer coding agent handles requirements, design and review. There is no
WDD dependency and no automatic feature acceptance.

[Get started](#installation-and-first-use) · [Workflow](#building-a-feature) ·
[CLI reference](#cli-reference) · [Limitations](#current-state)

## Current state

The CLI is [published on npm](https://www.npmjs.com/package/tinysdd).
This README describes the current `main` branch. Check `tinysdd --version` and the
[published releases](https://github.com/ivo-toby/tiny-sdd/releases) when using an
older installation.

TinySDD is usable for supervised trials. It remains experimental: passing tests
or a small model pilot does not establish reliable delivery across projects.

| Area | Available now | Remaining limits |
| --- | --- | --- |
| Onboarding | Global CLI, prerequisite checks, Linux sandbox startup probe, explicit Pi model discovery, version-matched Claude/Codex skill installation | Setup does not install prerequisites, authenticate models or run inference. |
| SDD preparation | Constitution entry check; specify, research, plan and slice skills; portable change artifacts and cited context | The skills guide the outer agent. They are not an automatic end-to-end planner. |
| Workers | Pi or OpenCode execution in disposable sandboxed copies; protected inputs; retained candidates, patches, checks and usage | Pi is pinned to **1.4.0**, OpenCode to **2.1.4**. Linux provides the check runner for Pi; macOS does not, and OpenCode workers do not have `run_checks` yet. |
| Review and acceptance | Explicit task approval, candidate application, review and feature integration checks; living-spec archive tooling | The operator owns decisions. `feature accept` requires a configured integration command and fresh evidence. |
| Slice-test assessment | Configured Jev assessment, bounded revisions, independent checks and a recorded strong review | Strong-model review is externally performed and attested. Live comparative evaluation remains open. |
| Benchmarks | Retained runs, independent visible/held-out verification, qualification and effective-settings confirmation | Coverage and fixture quality still need calibration. A benchmark score is not a guarantee of correct code. |
| Model registry | Profiles in `profiles/` per exact model configuration (route, context, `maxTokens`, timeout, thinking) with aggregate polyglot benchmark results ([#123](https://github.com/ivo-toby/tiny-sdd/issues/123)); developer benchmark in `bench/polyglot` (not shipped in the npm package) | Worker runs apply the profile's context window, `maxTokens` and limits; the server must actually serve that configuration. `setup` installs the registry, `init --model` selects the matching profile, `tinysdd models` lists them and `tinysdd profiles new` creates a local one. |

Other open work includes [registry profile selection and updates](https://github.com/ivo-toby/tiny-sdd/issues/123),
[full workflow experiments](https://github.com/ivo-toby/tiny-sdd/issues/110),
[benchmark oracle fixes](https://github.com/ivo-toby/tiny-sdd/issues/120) and
[incomplete-result reporting](https://github.com/ivo-toby/tiny-sdd/issues/124).
The dated experiment reports are historical evidence, not a current model ranking.

## Installation and first use

Prerequisites:

- **Node.js >= 22.19.0**.
- **Pi 1.4.0** (`@earendil-works/pi-coding-agent`, exact pin; 1.0.0 is refused), installed beside the Node
  executable used by TinySDD, with an explicit provider/model in Pi's `models.json`.
- Or, for an OpenCode worker: **OpenCode 2.1.4** (exact pin), a single binary at
  `~/.opencode/bin/opencode`, and an OpenCode config file that defines the provider.
  See [OpenCode workers](#opencode-workers).
- **Linux:** bubblewrap and util-linux, with working user namespaces. In an
  LXC/Incus container, host/container policy can prevent sandbox startup even
  when bubblewrap is installed.
- **macOS:** `/usr/bin/sandbox-exec` for worker isolation. The host `run_checks`
  tool is unavailable, and `worker stop` requires Linux `/proc`.

```sh
npm install --global tinysdd
tinysdd --version
tinysdd setup
```

Setup downloads the matching release's skills and documentation, installs them
under `~/.agents/tinysdd`, and registers `tinysdd` and `tinysdd-setup` in
`~/.agents/skills` and `~/.claude/skills`. It runs globally: do not pass
`--project`. Existing conflicting files are reported rather than overwritten.
See the [setup guide](docs/setup.md) for exact prerequisite installation,
Pi model configuration and container troubleshooting.

Then open a **fresh coding-agent session in your target project**:

| Agent | First project setup | Feature work |
| --- | --- | --- |
| Claude Code | `/tinysdd-setup` | `/tinysdd` |
| Codex | `$tinysdd-setup` | `$tinysdd` |

The setup skill guides project initialization, worker selection, effective model
settings and an authorized first worker trial. The product skill checks the
constitution before choosing a change: create/adopt one, repair a stale one, or
explicitly skip optional adoption. An existing change's constitution reference
cannot be bypassed by skipping.

If you prefer manual initialization, replace the provider/model placeholders
with exact IDs from your Pi configuration:

```sh
cd /path/to/your-project
tinysdd init --worker local --provider PROVIDER_ID --model MODEL_ID
tinysdd config validate --worker local
tinysdd worker settings --worker local --entry-kind real
```

Initialization creates project configuration; it does not configure Pi or prove
that inference works. Read the settings report before running a model. A requested
thinking level may not be transmitted by Pi or honored by the server.

## Building a feature

1. **Specify:** agree on observable behavior, constraints and acceptance criteria
   with the strong agent.
2. **Research and plan:** inspect the existing code and callers, retain cited
   context, and design the change and its integration points.
3. **Slice:** create coherent tasks with dependencies, expected files, protected
   feature tests and declared checks. File budgets are advisory, not a universal
   two-file limit.
4. **Approve and implement:** approve each task's current inputs and run a named
   worker. The worker writes implementation code and its own slice tests in a
   disposable copy. It can create or modify additional ordinary files, but cannot
   alter protected tests or preparation inputs.
5. **Verify and review:** independently inspect the candidate and execute checks.
   If the optional slice-test review policy is active, complete its assessment,
   independent checks and strong-review requirements as well.
6. **Apply and accept:** explicitly apply the reviewed candidate, record task
   acceptance, then accept the feature after its configured integration checks.
   Archive accepted changes into living specs through the separate archive tool.

Worker-visible checks are feedback, not final acceptance evidence. A successful
slice is not proof that a feature is wired into the application; integration
tests must exercise real entrypoints.

See the [quickstart](docs/quickstart.md),
[CLI workflow reference](skills/tinysdd/references/cli-workflow.md) and
[artifact format](docs/artifact-format.md) for configuration and file schemas.

## Configuration and defaults

Project configuration lives in `.tinysdd/config.json`; machine-specific overrides
belong in `.tinysdd/config.local.json`. Named workers select a Pi or OpenCode provider/model,
an optional runtime profile, instructions, skills and limits. Keep credentials
in the supported environment references rather than project files.

| Worker setting | Default | Supported range |
| --- | --- | --- |
| `limits.timeoutMs` | `600000` (10 minutes) | 1–3600000 ms |
| `limits.maxToolCalls` | `100` | 1–10000 |
| `limits.maxCheckRuns` | `12` | 1–20 |
| `limits.firstWriteMs` | Disabled | Positive, below `timeoutMs` |

Thinking, output-token limits and context limits come from Pi/model/profile
configuration; the runtime timeout does not set them. Use `worker settings` to
inspect their effective values. Live benchmarks require confirmation of the
current settings digest and any named findings. Ordinary worker runs do not add
that benchmark confirmation step.

### OpenCode workers

For environments that allow OpenCode but not Pi, a worker can use
`type: "opencode"`. TinySDD then builds the whole OpenCode configuration itself.
No project, global, system/MDM or wellknown OpenCode configuration from the host
reaches the worker. Only read and edit tools are allowed; shell, web, subagents
and paths outside the candidate are denied.

```json
"workers": {
  "oc": {
    "type": "opencode",
    "provider": "titan",
    "model": "titan/llamacpp/qwen3.8-pi-q4km-128k",
    "opencodeConfig": "/home/me/.config/opencode/tinysdd-providers.json"
  }
}
```

The named file is read on the host for that one provider and model. The provider
must use `@ai-sdk/openai-compatible` with `options.baseURL`, and `options.apiKey`
must be an `{env:NAME}` reference. A `User-Agent` header is ignored; other
headers are refused. The worker itself only sees the inference relay and a
per-run token. On Linux the OpenCode sandbox gets its own `/proc`, which the
binary needs; Pi workers do not. OpenCode runs record their own runner identity,
so they never reuse a Pi qualification. See
[the quickstart](docs/quickstart.md#opencode-worker) for details.

Feature acceptance requires `featureIntegration` in the project configuration:
a typed command, protected test paths and the supported host check runner. The
optional `testReview` policy configures slice-test assessment thresholds, revision
limits and escalation behavior explicitly. See the
[configuration examples](docs/quickstart.md#configure-a-worker) and
[active slice-test review flow](docs/quickstart.md#active-slice-test-review).

## CLI reference

Use `tinysdd --help` for the installed version. In the signatures below,
`[ ... ]` means optional, `a|b` means choose one, and uppercase names are
placeholders. Quote values containing spaces. List options accept comma-separated
values; they may also be repeated. Paths stored in task/configuration artifacts
are project-relative unless their schema says otherwise.

### Global options

| Option | Meaning |
| --- | --- |
| `--help`, `-h` | Print help without executing a command. |
| `--version`, `-v` | Print the installed CLI version. |
| `--project PATH` | Select the target project; defaults to the current directory. Not accepted with `setup`. |
| `--json` | Emit one JSON result on stdout; progress/warnings go to stderr. |

Command options accept both `--name value` and `--name=value`. The global
`--project` option also supports both forms.

### Setup, configuration and status

```text
tinysdd setup
tinysdd init [--worker NAME --provider ID --model ID]
tinysdd config show|validate [--worker NAME]
tinysdd status [--feature NAME]
tinysdd next
```

`status` shows the task/dependency state. `next` reports eligible work; it does
not dispatch or approve tasks.

### Task lifecycle

```text
tinysdd task add --id ID --brief PATH --allow FILE[,FILE] [--context PATH] [--checks PATH] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]] [--feature NAME]
tinysdd task update --id ID --by LABEL --reason TEXT [--brief PATH] [--context PATH] [--checks PATH] [--allow FILE[,FILE]] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]]
tinysdd task approve --id ID --by LABEL --reason TEXT
tinysdd task packet --id ID
tinysdd task apply --id ID --run RUN_ID --by LABEL
tinysdd task review --id ID --verdict accepted|revision|blocked --evidence PATH --by LABEL [--candidate-paths FILE[,FILE]]
tinysdd task close --id ID --by LABEL --reason TEXT
tinysdd task supersede --id ID --with ID[,ID] --by LABEL --reason TEXT
```

- `--allow` records expected output files; it is not an exclusive write allowlist.
  `--protect` binds files that must remain unchanged.
- `--brief`, `--context`, `--checks` and `--preparation` identify the approved
  task inputs. Bound changes require fresh approval.
- `--by` and `--reason` record attribution and intent; labels do not authenticate
  the operator or grant permission.
- Review the isolated candidate before `task apply`. Apply before recording
  `task review --verdict accepted`, which binds the applied project files.
- Closed/superseded tasks leave the active queue. Retirement is refused while
  open tasks depend on them.

### Worker execution and settings

```text
tinysdd worker settings --worker NAME --entry-kind real|synthetic [--observed-reasoning-tokens N]
tinysdd worker run --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
tinysdd worker start --task ID [--worker NAME] [--base-run RUN_ID] [--baseline-run RUN_ID]
tinysdd worker status --id LAUNCH_ID
tinysdd worker stop --id LAUNCH_ID [--wait-ms N]
```

`run` waits for completion. `start` detaches the worker from the caller's shell;
use it for long model calls from a coding agent and poll with `status`.
`--base-run` continues from a retained candidate; `--baseline-run` uses an
immutable baseline for controlled replay. These are distinct operations with
freshness/identity checks, not permission to reuse arbitrary output.
`stop` preserves evidence and finalizes a stopped run; it is Linux-only.

### Benchmarks and qualification

```text
tinysdd bench run --worker NAME [--suite PATH] [--repeat K] --entry-kind real|synthetic --confirm-settings DIGEST [--ack-finding CODE] [--observed-reasoning-tokens N]
tinysdd bench qualify --results PATH[,PATH] [--suite PATH] [--worker NAME] [--target ROLE=NUMBER,...]
tinysdd bench rescore --record PATH [--target ROLE=NUMBER,...]
tinysdd bench qualification show --record PATH [--suite PATH] [--worker NAME]
```

`--confirm-settings` is the digest you reviewed from `worker settings`.
`--ack-finding` is a list of findings you explicitly acknowledge, such as
`THINKING_CONTROL_MISMATCH`; do not blindly copy acknowledgements.
`qualify` scores retained evidence; `rescore` changes the scoring target without
rerunning inference. Qualification is bound to the recorded configuration, not
just a model name. See [benchmark usage](docs/quickstart.md#run-an-isolated-benchmark).

### Feature acceptance and phase records

```text
tinysdd feature report --feature NAME
tinysdd feature accept --feature NAME --by LABEL --reason TEXT
tinysdd phase record|research [--phase research] --feature NAME --proposal PATH --context PATH --by LABEL --reason TEXT [--predecessor ID] [--worker NAME]
tinysdd phase status --feature NAME [--worker NAME]
tinysdd phase advance --from research --to plan --feature NAME --by LABEL --reason TEXT [--record ID] [--worker NAME]
```

`feature accept` executes the configured integration check before recording
acceptance. The phase CLI currently supports the **human research handler** and
research-to-plan transition only; advancing records entry into planning, not
approval of a design or slice plan.

### Slice-test assessment and strong review

```text
tinysdd slice-tests assess --id ID --run RUN --change PATH --implementer ID --producer ID --provider-config PATH --credential-env NAME
tinysdd slice-tests status --id ID
tinysdd slice-tests check --id ID --event EVENT
tinysdd slice-tests review --id ID --event EVENT --input-digest SHA --reviewer ID --strength strong --attested true --verdict accepted|rejected --evidence PATH
tinysdd slice-tests report [--feature NAME]
tinysdd slice-tests dataset --partition train|validation|test [--feature NAME]
```

`--credential-env` names an environment variable; it does not take a secret value.
`assess` invokes the configured assessment provider. `check` independently runs
the retained candidate's declared checks. `review` records external strong-review
attestation for the exact input digest; it does not invoke a strong model.
Reports and dataset exports do not approve or accept work.

### Strong-model usage accounting

```text
tinysdd usage record --phase PHASE --model MODEL --input N --output N [--reasoning N] [--cache-read N] [--cache-write N] [--total N] [--task ID] [--feature NAME]
tinysdd usage import --file PATH
tinysdd usage report --feature NAME
```

Phases: `specify`, `research`, `plan`, `slice`, `write-tests`, `review`, `rescue`.
Record measured usage only; missing telemetry remains unknown. Worker runs also
retain duration, tool activity, check outcomes and available provider token usage.

## Source-checkout tools

Some workflows remain repository scripts rather than installed `tinysdd`
subcommands. Run them from a clone; `scripts/`, benchmark fixtures and tests are
not shipped in the npm package.

| Script | Purpose |
| --- | --- |
| `tinysdd change validate --change PATH [--ready] [--json]` | Validate portable change/slice artifacts and print the registration plan (installed subcommand). |
| `tinysdd change export --change PATH --slice ID --out DIR [--json]` | Export a prepared slice bundle (installed subcommand). |
| `node scripts/research.mjs --help` | Prepare bounded research packets and validate selections. |
| `node scripts/harness-adapter.mjs --help` | Begin/finalize retained Claude Code, OpenCode or interactive Pi runs. |
| `node scripts/archive-change.mjs --help` | Archive a freshly accepted change and merge its living specs. |

See the [artifact format](docs/artifact-format.md),
[research packets](docs/research-workflow.md),
[harness adapters](docs/harness-adapters.md) and
[living specs](docs/artifact-format.md#living-spec-merge-drafts-and-archives-30) for their contracts.

## Development and evidence

The CLI uses Node.js ESM with **no runtime dependencies and no build step**.
From a checkout:

```sh
TYPESAFE_API_KEY=stub npm test
node bin/tinysdd.mjs --help
```

Tests use fake runtimes and require no model, Pi, sandbox executable or network.
They establish software behavior, not live-model quality. CI checks the supported
Node versions; [the release workflow](docs/releases.md) versions and publishes
the npm package after its release checks.

A clone also provides repository-local registrations under `.claude/skills` and
`.agents/skills`. Start a fresh agent session in the clone to discover them;
global `setup` is what makes the skills available from other projects.

Historical measurements are retained under `experiments/` and dated result
reports, including the [bounded feature pilot](experiments/003-idempotent-reservations/README.md)
and [early CLI pilot](docs/cli-pilot-results-2026-09-06.md). Their outcomes belong
to those exact fixtures, model configurations and review conditions. Current
benchmark work must retain unsuccessful runs and distinguish fixture failures
from model failures.
