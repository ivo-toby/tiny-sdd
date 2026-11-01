# Try TinySDD locally

This is an early local prototype. The controller does not require a model.
Spawned workers require Linux with bubblewrap or macOS with `sandbox-exec`, and
an existing Pi installation with the exact provider/model configured (or the
pinned OpenCode version, see [OpenCode worker](#opencode-worker)). Missing
sandbox support fails closed. TinySDD is published on npm as the
dependency-free `tinysdd` CLI: install it with `npm install --global tinysdd`,
then run `tinysdd setup` ([guided setup](#guided-setup-for-an-existing-project)).
[Releases](releases.md) describes how versions are published.
CI runs the test suite on Node 22.19.0 and Node 24.
The fixed check client targets Pi 1.4.0, an exact pin (1.0.0 is refused),
which requires Node >=22.19.0; its live sandbox loading and Titan smoke still
require qualification.
The first adapter expects Pi in the same installation's `bin` directory as the
Node executable running this CLI; other installation layouts are not qualified.
Workers create disposable candidate directories under `$TMPDIR` (or `/tmp`) by
default. Set `TINYSDD_TMPDIR` to an existing real directory on a volume with
enough free space when `/tmp` is small or shared; the worker removes its candidates after it
has retained the run artifacts under the project.
On Linux and macOS, the ambient `TMPDIR` (or `/tmp` fallback) is resolved through
host aliases before scratch directories are created. An explicit
`TINYSDD_TMPDIR` must still resolve through a real path without symlinks.

The macOS adapter uses Seatbelt with read access to system libraries, the Node
executable and the installed Pi package. The candidate and temporary Pi state
are writable. The source project, original Pi state and other home files are
inaccessible, including through symlinks. Pi receives read/write/edit; process
forks and shell execution are denied. Declared checks run outside that sandbox
in TinySDD's separate Seatbelt check runner (no network, only a scratch copy of
the candidate writable), so a checks-bearing packet gets `run_checks` and
`feature accept` can run its integration check; results record
`sandbox.runner: "seatbelt"`. The macOS check runner refuses a root caller,
because Seatbelt cannot drop privileges. Live Seatbelt enforcement of checks has
not been observed on a Mac yet. See [setup](setup.md#check-runner-on-macos) for
how the macOS check runner differs from the Linux one.

macOS currently supports the `openai-completions` API with an explicit HTTP(S)
base URL. A temporary loopback relay forwards only `POST /chat/completions` for
the exact selected model to that configured URL. It retains provider credentials
in the controller, rejects other routes/models and redirects, and closes when
the run ends. Pi receives an ephemeral relay token and no provider credential
environment variables. All other network ports are denied. MLX, llama.cpp and
LM Studio servers can use their OpenAI-compatible endpoints; each deployment
still needs a live smoke run.

The Linux bubblewrap worker has no host network. It runs in its own network
namespace (`--unshare-net`) with only loopback, and DNS, hosts and CA files are
not mounted. The same per-run relay runs on the host, listening only on a Unix
socket in a run-owned directory that is mounted read-only into the sandbox. A
fixed TinySDD launcher starts a loopback forwarder (`127.0.0.1:41434` inside
the sandbox) to that socket, then runs Pi with its usual arguments and exit
status. Pi's temporary `models.json` points at the forwarder with the per-run
relay token; provider credentials and `TINYSDD_PI_SECRET_*` values stay on the
host. On both platforms, compatibility settings Pi would derive from the
provider's URL (for example `max_tokens` and the thinking format for a DeepSeek
endpoint) are written into that `models.json` explicitly unless already set. The relay supports only the `openai-completions` API, so a Linux worker
whose provider uses another API now fails before Pi starts, naming the API; there
is no fallback to host networking. The Node executable must be next to `pi` in
the Pi installation's `bin/` directory.

`runtime.json` records `sandbox: "seatbelt"`, the executable, relay destination
and retained `sandbox.sb` profile on macOS. Linux keeps `sandbox: "bubblewrap"` and records the in-sandbox relay address as
`inferenceDestination`.
Run the separate native escape qualification with the same Node installation,
from a source checkout (`scripts/` is not part of the npm package; the same
holds for every `node scripts/...` command in this guide):

```sh
node scripts/qualify-macos-sandbox.mjs
node scripts/qualify-macos-worker.mjs --provider litellm --model code-local
```

The escape check uses synthetic source, home/SSH and Pi-state fixtures. The model
smoke requires the exact configured provider/model and its credential environment;
it retains a synthetic project and independently checks the candidate and
unchanged source. Repeat it explicitly for each endpoint being qualified.
The ordinary test suite
uses stubs and requires no sandbox executable, network, Pi or model.

## Guided setup for an existing project

For global onboarding from a published release, run setup from any directory;
it does not require a project:

```sh
npm install --global tinysdd
tinysdd setup
```

`setup` downloads the matching versioned Git archive (tag `v<version>`),
validates its package and resource tree, checks Node/Pi/sandbox/model metadata,
installs the complete skills bundle for Claude and Codex, and installs the
shared profile registry into `~/.config/tiny-sdd/registry/` (see
[choosing a registry entry](#choosing-a-registry-entry)). It refuses an
unavailable release instead of falling back to an unpinned branch. It does not
install prerequisites, read credentials, start services or run inference.
Repeatable setup preserves identical files and refuses conflicting paths. A
symlinked skills directory (`~/.claude/skills`, `~/.agents/skills`) or bundle
root (`~/.agents/tinysdd`) is resolved to its real path, so dotfiles-managed
layouts work. See the [setup guide](setup.md) for the global layout and release
prerequisite.

To upgrade, install the new CLI and replace both installed copies with that
release's; re-running `setup` instead fails with `SETUP_CONFLICT` once the
installed files differ:

```sh
npm install --global tinysdd@latest
tinysdd skills update
tinysdd profiles update
```

Your own profiles in `~/.config/tiny-sdd/profiles/` are not touched. See
[upgrading](setup.md#upgrading) in the setup guide.

On Linux, setup also runs a bounded direct bubblewrap startup probe using the
worker's user/PID/network namespace and core mount shape with `/usr/bin/true`. A passing
probe covers sandbox startup only; it does not prove provider authentication,
inference, Pi startup, or full check-runner execution. If bubblewrap is present
but startup is blocked, setup still installs the skills, marks worker readiness
false, and reports a status-specific next step plus a reproduction command in
human and `--json` output. Run that command from the same host or container,
inspect `/proc/self/uid_map` and (when present)
`/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, and ask the owner of
that boundary to review the user-namespace, mount, and AppArmor policy. Do not
disable global restrictions or use an unsandboxed fallback; the longer
[Linux guidance](setup.md#linux-bubblewrap-startup-failures) explains the
conditional container/Incus and Ubuntu/AppArmor cases.

After a successful global setup, start a fresh Claude or Codex session in the
intended project so it rescans the global skill directory. Invoke
`/tinysdd-setup` in Claude or `$tinysdd-setup` in Codex; the installed setup
skill guides project/model setup and your first worker trial. Then load
`/tinysdd` or `$tinysdd` for the product workflow. If either skill is
unavailable, start a new session or restart the harness.

For a source checkout instead of the global installation, start Claude or Codex
from this checkout. A fresh clone registers the setup and product skills in the
native `.claude/skills/` and `.agents/skills/` locations. These registrations
are scoped to this checkout; they do not install skills into the target project.
The `tinysdd-setup` registration points to `skills/tinysdd/assets/setup` and the
`tinysdd` registration points to `skills/tinysdd`, preserving their relative
supporting resources. Use the setup/product skill links to load the frontier
router and selected phase. Codex may list nested skills reached through the
product link; use the explicit path when another harness does not list one.

The harness-independent [TinySDD setup skill](../skills/tinysdd/assets/setup/SKILL.md)
can be loaded from the global bundle or source checkout. It checks the
supported Node/Pi installation layout and sandbox, reuses `init`, config
validation and the worker's existing Pi preflight, and provides a bounded
synthetic readiness smoke. It keeps configured route,
operator-reported backend, runtime-observed identity and unknown model
properties separate.

Before asking which change to implement or specify, run the constitution entry
check for the target project. Honor an explicitly selected Markdown/approval
pair, including custom paths; otherwise inspect the recommended
`specs/constitution.md` and `specs/constitution.approval.json` files only as
candidates. Use `validateConstitution` or the existing read-only validator where
available, and report valid, missing, unapproved, malformed, mismatched/stale
or unavailable state with the exact paths. If the pair is missing, offer to
load the [constitution skill](../skills/tinysdd/assets/constitution/SKILL.md)
and create it together, then wait for the operator's create-or-skip choice. For
an invalid pair, offer repair or re-ratification or an explicit skip and wait.
Carry an explicit skip through nested skills for the same target project and
pair without repeating the offer. A different project, reference or changed
evidence requires a fresh check. A skip declines optional adoption only; it
cannot erase an existing change reference or bypass its validator. A valid pair
found at the defaults remains optional until the operator explicitly adopts it;
creating or discovering files alone does not change existing task authority or
adopt them into a change.

The setup command does not install prerequisites, read credential stores, start
services or run live inference by itself. Authorize those actions separately;
keep credentials as environment references and inspect the retained
`runtime.json`/`result.json` evidence from the exact worker run.

From this checkout:

```sh
TYPESAFE_API_KEY=stub npm test
node bin/tinysdd.mjs --help
```

The suite stubs the semantic-gate judge; without `TYPESAFE_API_KEY` set, five
semantic-gate tests fail before the stub is called.

`tinysdd --help` lists the commands grouped by phase with one-line
descriptions and the normal flow (`setup → init → task add → task approve →
worker start → worker status → task apply → task review`). Every command has
its own help with usage, flag meanings and defaults, and an example:
`tinysdd worker stop --help` or `tinysdd help worker stop`.

The offline decision-evaluation foundation is documented in
[docs/decision-evaluation.md](decision-evaluation.md). It compares saved
provider predictions with separately reviewed labels and never performs live
inference. Run it with explicit dataset and prediction files when those
artifacts exist:

```sh
node scripts/evaluate-decisions.mjs \
  --dataset data/decision-dataset.json \
  --predictions data/predictions.json \
  --metrics data/metrics.json \
  --output data/evaluation-report.json \
  --json
```

The report output path must be new and must not overwrite the dataset,
predictions, metrics, or validated evidence files.

For the issue #40 observation boundary, see
[docs/decision-providers.md](decision-providers.md). It replays the saved
#32 predictions for at least two provider identities in default shadow mode,
after validating all dataset evidence and bindings. It never calls a provider;
`--log-task` is required for an explicit append to the existing decision
ledger, and `--output` must name a new path:

```sh
node scripts/observe-decisions.mjs \
  --project /path/to/project \
  --dataset data/decision-dataset.json \
  --predictions data/provider-predictions.json \
  --providers data/provider-metadata.json \
  --output data/provider-observations.json \
  --log-task failure-triage \
  --json
```

Replay records retain case IDs and decision points. The saved #32 artifacts do
not bind their original typed question, so `questionSha256` remains `UNKNOWN`;
an optional `--questions` file is replay-only mapping metadata recorded as
`replayQuestionSha256` after typed value validation.

Missing model, calibration and threshold metadata stays `UNKNOWN`. Replay
records carry no enforcement action; real provider calls require a separate
operator-reviewed implementation and are outside this offline foundation.

Synthetic fixtures are useful for checking the tooling but do not count toward
the 50 real failure-triage labels required by issue #32. The current checkout
does not contain those real labels or measured provider runs; the evaluator
reports the missing evidence as `UNKNOWN`/warnings.

The offline [Laya training-data exporter](laya-training.md) prepares a
deterministic, digest-bound bundle from real human-reviewed failure-triage
cases. It verifies evidence before writing new `train.jsonl`,
`validation.jsonl`, and `test.jsonl` files, and documents a pinned, unexecuted
training and calibration recipe; it does not run Python, Laya, inference, or
training.

The examples below use the global `tinysdd` command. From a source checkout
without the global installation, use
`node /absolute/path/to/tiny-sdd/bin/tinysdd.mjs` wherever they say `tinysdd`;
that changes no global npm/Pi setup. `--project /path/to/project` selects the
target explicitly; otherwise commands use the current directory.

## Use it inside your coding agent

From a session started in the target project after global setup (or in this
checkout), invoke `/tinysdd` in Claude or
`$tinysdd` in Codex and ask it to prepare one bounded feature. The skill covers
either implementation inside that agent or delegation to a named worker.
Product decisions and review remain with you or the authority you explicitly
delegate to the outer agent. If native discovery is unavailable, start a new
session or restart the harness, then use the direct
[TinySDD skill path](../skills/tinysdd/SKILL.md).

## Frontier preparation skills

For a complete feature, load the [project-local frontier router](../skills/tinysdd/assets/harness/claude/tinysdd-frontier/SKILL.md). It provides
separate specify, research, plan and slice skills and reusable #20 templates.
Before phase preparation, complete the constitution entry check above. The
preparation order is:

1. Specify observable requirements, rejection and preservation behavior.
2. Research exact cited source excerpts, callers, checks, dependency accessors
   and lint facts. Mark unavailable facts UNKNOWN.
3. Plan against those retained excerpts with proposal.md, design.md, deltas and
   change.json.
4. Slice a coherent DAG with slice.json, brief.md, context.json and checks.json.

The frontier skills prepare artifacts; they do not approve them. The current
phase CLI implements only the human research handler. If it is configured, use
the real commands. These assets do not bundle the CLI, scripts or schemas; set
the canonical target project root once when working from an unrelated
directory (the `tinysdd` command comes from the installed CLI):

~~~sh
TARGET_PROJECT=/absolute/path/to/project
~~~

~~~sh
tinysdd --project "$TARGET_PROJECT" \
  phase record --phase research --feature reservations \
  --proposal changes/reservations/proposal.md \
  --context changes/reservations/research.context.json \
  --by operator --reason 'Reviewed the cited research inputs'
tinysdd --project "$TARGET_PROJECT" \
  phase status --feature reservations
tinysdd --project "$TARGET_PROJECT" \
  phase advance --from research --to plan --feature reservations \
  --by operator --reason 'Research is current and complete'
~~~

The research-to-plan advance records phase entry only; it does not approve a
plan artifact. Unsupported or unavailable handlers stop truthfully. Existing
task approval remains the implement gate, and existing task review, apply and
feature accept remain authoritative.

Strong preparation writes protected feature integration tests through real
application entrypoints. Small workers write writable slice tests with direct
module imports. Protect every feature test in every active task. The
featureIntegration command uses typed argv and the safe host runner; a passing
direct-import slice test does not establish wiring. Implementation and
slice-test file budgets are configurable advisory warnings, and #82 allows
ordinary extra files in the disposable candidate. Deletion, protected or
preparation edits and arbitrary inference commands remain ineligible.

The pure #81 transition helper remains offline; the active `slice-tests`
commands below invoke the explicitly configured Jev provider. Negative assessments use only explicit
bounded revision policy; every positive assessment requires independent strong
review of identical bytes; exhaustion escalates. Do not invent thresholds or
routes, and do not infer #39 plan approval or #38 engagement semantics. Record
observed frontier usage through the existing canonical phases and mark missing
telemetry UNKNOWN, never zero.

The first controller sequence is:

```sh
tinysdd --project "$TARGET_PROJECT" init
tinysdd --project "$TARGET_PROJECT" task add --id first-change --brief docs/tasks/first-change.md --allow src/example.mjs,test/example.test.mjs
tinysdd --project "$TARGET_PROJECT" task approve --id first-change --by ivo --reason 'Reviewed this task brief'
tinysdd --project "$TARGET_PROJECT" next
tinysdd --project "$TARGET_PROJECT" task packet --id first-change --json
```

For a portable change descriptor, validate the preparation artifacts and print
the topological registration plan without changing controller state:

```sh
TARGET_PROJECT=/absolute/path/to/project
CHANGE_ROOT_RELATIVE=changes/example
CHANGE_RELATIVE="$CHANGE_ROOT_RELATIVE/change.json"
TASK_ROOT_RELATIVE=.tinysdd/tasks
TASK_ROOT="$TARGET_PROJECT/$TASK_ROOT_RELATIVE"
SLICE_ID=s1
BRIEF_SOURCE_RELATIVE=changes/example/slices/s1/brief.md
CONTEXT_SOURCE_RELATIVE=changes/example/slices/s1/context.json
CHECKS_SOURCE_RELATIVE=changes/example/slices/s1/checks.json

tinysdd --project "$TARGET_PROJECT" change validate \
  --change "$CHANGE_RELATIVE" \
  --json
```

With `--json` the CLI prints the standard `{ ok, data }` envelope, so the plan
is at `.data.registrationPlan` and the readiness issues at `.data.readiness`.
Add `--ready` to fail unless the change is export-ready. The plan is read-only.
Read the selected slice descriptor's actual `brief`,
`context` and `checks` paths; do not derive a source folder from its ID. Before
registering each slice, copy those exact descriptor bytes to the fixed target
task paths shown by the plan, then use those paths for `task add` and approval.
For example:

```sh
mkdir -p "$TASK_ROOT"
cp "$TARGET_PROJECT/$BRIEF_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.md"
cp "$TARGET_PROJECT/$CONTEXT_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.context.json"
cp "$TARGET_PROJECT/$CHECKS_SOURCE_RELATIVE" "$TASK_ROOT/$SLICE_ID.checks.json"
tinysdd --project "$TARGET_PROJECT" task add --id "$SLICE_ID" --feature example \
  --brief "$TASK_ROOT_RELATIVE/$SLICE_ID.md" \
  --context "$TASK_ROOT_RELATIVE/$SLICE_ID.context.json" \
  --checks "$TASK_ROOT_RELATIVE/$SLICE_ID.checks.json" \
  --preparation specs/example.md \
  --allow src/example.mjs,tests/example.test.mjs \
  --protect tests/contract.test.mjs
```

Repeat this materialization in topological order for dependent slices. The
explicit copy preserves the approved brief, context and checks bytes; carry every
`allow`, `protect`, `preparation` and `dependsOn` value from the plan, using
`--depends-on` for dependencies (plan `preparation` entries are objects: pass
their `path` values), and its optional `worker`/`workerReason` with `--worker`
and `--worker-reason`. Preparation entries are immutable identity
evidence; an absent entry remains an absence check and is not added to
`--protect` until it exists. Validation does not create these controller inputs.

The format keeps protected feature tests separate from writable slice tests,
checks exact interface citations and records advisory file sizing. The plan and
bundle report the single default `runtimeScope.mode: "ordinary-create-modify"`;
expected paths and file-count budgets guide the worker but do not limit eligible
ordinary file creation or modification. Deletions, filesystem type changes,
internal or secret paths, dependency mounts, protected contracts and immutable
preparation inputs remain ineligible and are retained as review blockers.
An export requires a matching, ready, freshly approved task and writes a new
bundle outside the checkout. It never runs checks, approves, applies or accepts.
Choose an existing canonical output parent (resolve `/tmp` first on systems
where it is an alias); the exporter refuses symlinked output parents.

```sh
BUNDLE_OUT="/absolute/canonical/tmp/${SLICE_ID}-bundle"
tinysdd --project "$TARGET_PROJECT" change export \
  --change "$CHANGE_RELATIVE" \
  --slice "$SLICE_ID" \
  --out "$BUNDLE_OUT" \
  --json
```

The broker fixture under `examples/artifact-format/` is a synthetic S1–S5b
reconstruction with UNKNOWN historical approval and run evidence. Its protected
feature check enters through the real fixture entrypoint; it is offline evidence
for the descriptor tooling, not a Talon, Pi, provider or foreign-harness run.

For an approved slice consumed by Claude Code, OpenCode or interactive Pi, follow the
[foreign harness adapter guide](harness-adapters.md). The exported bundle and
candidate parent stay outside the source project; the host-managed begin step
retains the exact packet and bundle under `.tinysdd/runs/worker-*` evidence
without changing source code, controller state or approvals. Finalize returns a
completed result through the normal `task apply` and explicit `task review`
commands. Ordinary extra files are retained for review; this API leaves model
identity caller-declared with observed identity `UNKNOWN`, usage and sandbox
`UNKNOWN`, and checks `unrun`. Offline adapter fixtures pass through apply and
synthetic review, while live harness/model/operator acceptance remains pending
(`Refs #31`).

Create the brief first; the [template](../skills/tinysdd/assets/task-brief.md)
identifies its useful contents. Use actual approval attribution, not copied
example text. Allowed paths are exact files, including not-yet-created files;
no globs. Dependencies use `--depends-on first-change` on a later task.

Use the optional `--feature NAME` label to group slices of one feature:

```sh
tinysdd task add --id validation --feature reservations --brief docs/tasks/validation.md --allow src/validation.ts,tests/validation.test.mjs
tinysdd status --feature reservations
```

Record manual usage only when the phase, model and attribution are known. The
token fields accept nonnegative safe integers; use the named phases shown by
`tinysdd usage record --help` (or `tinysdd --help`) and provide either `--task` or `--feature`:

```sh
tinysdd usage record --phase review --model frontier/model --input 1200 --output 400 --reasoning 80 --feature reservations
tinysdd usage report --feature reservations
```

When a project enables the optional phase policy in `.tinysdd/config.json`,
record the reviewed research inputs explicitly. The research gate keeps the
proposal, manifest and exact compiled cited excerpts in a bounded immutable
phase ledger; it does not run a model or infer approval for another gate:

```json
{
  "schemaVersion": 1,
  "workers": {},
  "phaseGates": { "research": { "mode": "human" } }
}
```

```sh
tinysdd phase record --phase research --feature reservations \
  --proposal docs/research-proposal.md --context docs/research.context.json \
  --by operator --reason 'Reviewed the current research inputs'
tinysdd phase status --feature reservations
tinysdd phase advance --from research --to plan --feature reservations \
  --by operator --reason 'Research is current and complete'
```

Phase status always names one feature; TinySDD does not merge independent
features into an aggregate approval view.

The research-to-plan transition records entry into plan only. It is not plan
artifact approval and cannot satisfy a later research predecessor requirement.

Only the configured `human` research handler is available in this increment;
frontier, deterministic and automatic handlers report unavailable. If research
qualification is configured, its named producer must currently be qualified
for the `research` role and its current qualification record is bound to the
phase decision. Changing the proposal, manifest, cited lines, policy,
predecessor or qualification makes the decision stale. The existing task
approval remains the implement gate with its existing digest and apply/review
semantics.

A producer-only research entry is normalized to a required qualification. A
named producer with `qualification.required: false` is rejected until a phase
handler can bind that identity without implying qualification.

If `implement` appears in `phaseGates`, it is only the existing human task
approval alias. Its approval, review, apply and final-run bindings stay in the
task controller; other modes and added phase requirements are rejected.

The bounded #81 transition helper is offline only; it is distinct from the
active `slice-tests` commands below. It requires an explicit
complete `testReview` policy; a negative assessment may request revisions only
within that configured cap, while a positive assessment remains review-required
until a separately identified, caller-declared strong review covers the same
input digest. Missing policy, unknown or non-attested review, exhaustion,
uncertain results and unavailable results never approve or accept a change; no
provider or model is invoked by this interface.

Normalized imports use a versioned JSON envelope with `source`, `exportId` and
stable per-record `externalRecordId` values. The entire file is validated before
anything is appended:

```json
{
  "schemaVersion": 1,
  "type": "usage-import",
  "source": "synthetic-talon",
  "exportId": "export-1",
  "records": [
    {
      "externalRecordId": "record-1",
      "phase": "review",
      "model": "frontier/model",
      "feature": "broker",
      "input": 7,
      "output": 3
    }
  ]
}
```

```sh
tinysdd usage import --file usage-export.json
```

An import is a normalized contract; it does not claim that a native Pi or Claude
Code adapter was run. Missing or partial telemetry remains `UNKNOWN`, while
known subtotals and their missing-value provenance stay visible. Use the
explicit feature decision after every currently active labelled task is
accepted:

Configure the host-run integration check before accepting a feature. The command
is typed argv, never shell text; the declared test paths must be protected feature
tests and the entrypoints must exist:

```json
{
  "schemaVersion": 1,
  "workers": {},
  "featureIntegration": {
    "argv": ["node", "tests/reservations-integration.mjs"],
    "testPaths": ["tests/reservations-integration.mjs"],
    "entrypoints": ["src/reservations.mjs"]
  }
}
```

`feature accept` runs this command through TinySDD's bounded host check runner on
retained project and dependency bytes (bubblewrap on Linux, Seatbelt on macOS).
Missing configuration, an unavailable check runner, a failed or timed out
check, and project/configuration drift all
refuse acceptance. A successful run retains its result, command identity,
tested bytes and dependency identities; `feature report --json` marks the proof
stale when any of those inputs changes. Every active accepted task scope must
protect the declared test paths.

The retained projection copies what the worker copy sees: in a Git work tree,
tracked plus untracked-but-not-ignored files (`git ls-files --cached --others
--exclude-standard`), so ignored state such as `.claude/worktrees/` or
`.worktrees/` never enters it; outside Git it walks the tree. `.git`,
`.tinysdd`, secret-looking names and dependency mounts are left out. A relative
symlink that stays inside the project (`AGENTS.md -> CLAUDE.md`, npm workspace
and `node_modules/.bin` links in a dependency mount) is retained as the same
link and its target text is part of the identity; an absolute link, one that
leaves the project, or one with `..` after a name (`a/../b`) is refused with
`FEATURE_INTEGRATION_UNSAFE_INPUT`, as are special files. The project tree is
bounded to 20,000 entries, each dependency mount to 250,000 entries, each tree
to 512 MiB, and a manifest to 512 KiB. A proof recorded before the Git-listed
projection keeps its whole-tree walk when its freshness is checked.

When features need different tests, give each its own command under
`features`; a feature without an entry uses the top-level command, and the
top-level command may be omitted when every feature has an entry:

```json
"featureIntegration": {
  "features": {
    "report-core": {
      "manifest": "changes/report-core/feature-checks.json",
      "checkId": "report-feature",
      "testPaths": ["tests/integration/report.feature.test.ts"],
      "entrypoints": ["src/services/report-service.ts"]
    }
  }
}
```

Each entry takes the same fields as the top-level command (`argv` or
`manifest`/`checkId`, `timeoutMs`, `dependencyMounts`, `testPaths`,
`entrypoints`, `docker`); only that feature's tasks must protect its
`testPaths`. Dependency mounts are copied as they are, including package files
with secret-like names (`dockerode/lib/secret.js`); project source keeps the
secret-name filter.

By default the host check runner has no network and grants no sockets. A
feature test that needs Docker (for example testcontainers) declares it on its
entry:

```json
"004-report-core": {
  "argv": ["node", "node_modules/vitest/vitest.mjs", "run", "tests/integration/workspace-report.feature.test.ts"],
  "dependencyMounts": ["node_modules"],
  "testPaths": ["tests/integration/workspace-report.feature.test.ts"],
  "entrypoints": ["src/services/workspace-service.ts"],
  "timeoutMs": 300000,
  "docker": { "socket": "/var/run/docker.sock" }
}
```

**Trade-off:** a check with Docker access can start containers, and through
the Docker API that is host-level access (it can mount host directories or run
privileged containers). Declare `docker` only for feature tests you trust as
much as your own shell. Only the `feature accept` check gets this access;
worker sandboxes and `run_checks` never do. An entry without `docker` runs
exactly as before.

With `docker` declared:

- the socket must exist and be a unix socket when `feature accept` starts,
  otherwise it refuses with `FEATURE_INTEGRATION_DOCKER_SOCKET` (is Docker
  running?). A symlinked socket such as OrbStack's
  `/var/run/docker.sock -> ~/.orbstack/run/docker.sock` is resolved;
- the check gets `DOCKER_HOST=unix://<socket>`,
  `TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1` (published ports are reached on
  IPv4 loopback without a name lookup) and
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=<daemonSocket>`, the daemon-side path
  Ryuk mounts. `daemonSocket` defaults to `/var/run/docker.sock`, which is right
  for Docker Desktop, OrbStack, Colima and rootful Linux; set it for rootless
  Docker. Ryuk stays enabled so containers are removed if the check is killed;
- `HOME` is an empty scratch directory: no `~/.docker` config, credentials or
  `.testcontainers.properties` reach the check, so images come from public
  registries anonymously (pull private images beforehand);
- on macOS (Seatbelt) the check may connect to the declared socket (and the
  paths it resolves to), open TCP connections to `localhost` only, and look up
  its own user (testcontainers calls `os.userInfo()`). No other network;
- on Linux (bubblewrap) the socket is bound at `/run/tinysdd/docker.sock` and
  the check keeps the host network namespace, because published ports live on
  the host's loopback and bubblewrap cannot narrow a shared namespace to
  loopback. That is full network access, on top of what the socket already
  grants. The check also gets a passwd and group entry for its own uid;
- the declaration is part of the proof's command identity, so adding, removing
  or changing it makes an earlier proof stale, and the proof records
  `dockerAccess.granted` with the socket the runner bound.

Runner limits to know about when a feature test uses vitest:

- the dependency mount is read-only, and vite bundles a `vitest.config.*` into
  `node_modules/.vite-temp`; pass `--configLoader runner` (vitest 3.1+) when the
  project has a vitest or vite config file;
- on Linux the check runs under an 8 GiB address-space limit, which V8's
  WebAssembly guard regions exceed (`WebAssembly.instantiate(): Out of
  memory`). Add `--disable-wasm-trap-handler` after `node` in `argv` and run the
  workers as forks with the same flag (`pool: 'forks'`,
  `poolOptions.forks.execArgv: ['--disable-wasm-trap-handler']`). macOS does not
  apply that limit.

The Linux sandbox has a fixed `/etc/hosts` with only `localhost`, so test
runners that resolve `localhost` start. On macOS a workspace link inside a
dependency mount resolves next to the retained mount rather than into the
candidate, so a check that imports a workspace package through `node_modules`
may not find it.

```sh
tinysdd feature accept --feature reservations --by ivo --reason 'Reviewed the complete feature window'
tinysdd feature report --feature reservations
```

Acceptance appends an immutable report snapshot. Later imports leave that
snapshot unchanged; `feature report` marks it stale when membership or current
task freshness changes. Re-run `feature accept` to record a new window. A
deterministic synthetic talon-shaped fixture is covered by the tests; no real
historical frontier usage is claimed without supplied records.

After the feature is explicitly accepted and its integration proof is still
fresh, archive its living-spec change with the standalone script:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
node "$TINYSDD_CHECKOUT/scripts/archive-change.mjs" \
  --project "$TARGET_PROJECT" \
  --change changes/reservations/change.json \
  --draft changes/reservations/merge-draft.json \
  --json
```

The change descriptor must live inside a dedicated change directory; a root-level `change.json` is rejected before staging.
The final acceptance check, archive publication and spec writes share the controller lock.
An external `--draft` is retained separately from the change directory’s default draft.

The merge draft is a local-model handoff with explicit requirement IDs, exact
UTF-8 base ranges/text and an output digest. The script validates those bytes,
retains the proposal, delta descriptors, slice DAG, acceptance event, applied
runs and integration evidence under `changes/archive/<change-id>/`, then
applies only the recorded before/after spec bytes. It never removes the source
change or run records. Repeating the command verifies the committed archive
and recovers missing spec writes; a changed draft, stale base, conflicting
current spec or stale acceptance fails without replacing unrelated prose.

`status` renders open tasks as a dependency tree. Each task also has a global
topological `order` and sorted `dependents` in `status --json`; filtering by a
feature keeps those positions global. Accepted tasks show the applied worker
run, and closed or superseded tasks appear after the tree with their successors:

```text
broker-s1  accepted (applied from worker-…)
├─ broker-s2  ready
│  ├─ broker-s4  blocked (requires broker-s2)
│  └─ broker-s5  blocked (requires broker-s2, broker-s3, broker-s4)
└─ broker-s3  pending_approval

Closed or superseded:
broker-contract: superseded by broker-s1, broker-s2
```

You can implement the packet in your current agent without invoking a worker.
The controller never changes the model in that outer agent.

To retire a task you abandoned or re-cut, use `task close` or `task supersede`.
Neither needs an approval, so they work on a task whose approval went stale when
its brief changed. The task becomes `closed` or `superseded`, leaves `next`, and
can no longer be approved, reviewed or dispatched. They are refused for an
accepted task and while open tasks depend on it (the error lists them). A
retired task never satisfies a dependency. `supersede` records the successors,
shown under `closure` in `status --json`:

```sh
tinysdd task supersede --id broker-contract --with broker-s1,broker-s2 --by operator --reason 're-cut into slices'
```

When a worker needs an exact API, schema, or acceptance oracle, add a reviewed
context manifest under `.tinysdd/tasks/` and pass it with `--context`. TinySDD
will compile only its declared source line ranges and record their digests; see
[the context compiler guide](context-compiler.md). Omit it for genuinely simple
tasks rather than padding prompts. Approval binds the cited lines, not the whole
file, so slices that cite one shared spec by line range stay current when the
spec is appended to or edited outside their ranges. Inserting lines above a
cited range shifts it and makes the slice stale: append addenda at the end.

For offline preparation of the future research phase, see the
[deterministic research selection scorer](research-scoring.md). It compares a
candidate manifest with a reviewed gold manifest through the same compiler,
without running checks, models, or services. Its synthetic examples remain
proposed and human-unreviewed until the research adapter and calibration work
are complete.

Prepare a bounded, digest-bound research packet from any working directory.
The packet retains the exact proposal and eligible source bytes outside the
target project; it does not invoke a model or change project/controller state:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/project
RESEARCH_PACKET_OUT=/absolute/canonical/tmp/research-packet
node "$TINYSDD_CHECKOUT/scripts/research.mjs" prepare \
  --project "$TARGET_PROJECT" \
  --proposal changes/example/proposal.md \
  --out "$RESEARCH_PACKET_OUT" \
  --max-files 200 --max-source-bytes 524288 \
  --max-map-bytes 262144 --budget-bytes 24576 --json
```

Have the selected research context returned as a strict manifest with an empty
`facts` array, then validate it against the retained packet. The compiler
provides verbatim excerpts, while `purpose` remains an untrusted selection hint:

```sh
RESEARCH_RESULT_OUT=/absolute/canonical/tmp/research-result
node "$TINYSDD_CHECKOUT/scripts/research.mjs" validate \
  --project "$TARGET_PROJECT" \
  --packet "$RESEARCH_PACKET_OUT" \
  --selection "$TARGET_PROJECT/changes/example/research.selection.json" \
  --out "$RESEARCH_RESULT_OUT" --budget-bytes 24576 --json
```

The result is explicitly `draft_unapproved`; it records packet, manifest,
source, excerpt and compiled-context digests without recording a phase decision.
Omit `--gold` when no caller-supplied reference exists: precision and recall
remain `UNKNOWN`. Output directories must be new, canonical and outside the
target project and packet inputs; warnings go to stderr and `--json` writes one
JSON object to stdout. See [the bounded research workflow](research-workflow.md)
for the packet contents and selection contract.

Use `task add --protect src/types.ts,tests/contract.test.ts` for read-only
contract files. They must exist and cannot overlap `--allow`. The packet lists
them and the worker prompt forbids changing them; an edit is retained as a scope
violation with reason `protected contract file`, rather than prevented by file
permissions. Approval binds their content digests. Editing a protected file makes
the approval stale and therefore makes an accepted slice `stale` too: it must be
checked again against the changed contract. Acceptance needs no separate field.

To revise an open task's shape, use `task update` with `--by` and `--reason`:

```sh
tinysdd task update --id first-change --allow src/example.mjs --protect tests/contract.test.ts --by operator --reason 'keep the contract fixed'
```

`--brief`, `--context`, `--checks`, `--allow`, `--protect`, `--preparation` and
`--depends-on`
validate like `task add`; omitted fields stay unchanged. Use `--context=`,
`--checks=`, `--protect=` or `--depends-on=` to clear an optional field;
`--allow` must stay nonempty. Each effective update keeps the previous shape and
any apply record in `revisions[]`, with attribution, reason and timestamp, shown
by `status --json`. It leaves recorded approvals and reviews intact; changes to
bound shape or digests make approval stale, requiring explicit reapproval.
A later review cannot attribute the revised task to an apply under its old shape.
Accepted tasks, including stale accepted tasks, cannot be updated: use
`task supersede` once acceptance is stale; supersede still refuses a current
acceptance and open dependents. Closed and superseded tasks cannot be updated
either.

Sizing warnings at `task add` and `task approve` now include a behavior-split
recommendation for cited tests with fake timers plus deferred promises or races,
or at least 8 ordering assertions. Separate the sequential core from the async
edge, each with its own test file. These advisory thresholds are provisional
and uncalibrated, pending the talon reruns; warnings never block.

When a task has fixed checks, declare them in a reviewed JSON file under
`.tinysdd/tasks/` and pass it with `--checks`. TinySDD validates and binds the
declaration into approval and the worker packet:

```json
{
  "schemaVersion": 1,
  "dependencyMounts": ["node_modules"],
  "checks": [
    { "id": "test", "argv": ["node", "--test", "tests/example.test.mjs"], "timeoutMs": 120000 },
    { "id": "lint", "argv": ["node_modules/.bin/eslint", "src/example.mjs"] }
  ]
}
```

A manifest declares 1 to 16 checks with unique ids. `argv` is typed argv,
never shell text; `argv[0]` is `node` or a project-relative executable inside a
declared dependency mount (at most 8 mounts). `timeoutMs` defaults to 120000
and accepts 1000 to 600000. When the host check runner is
available, packets expose the fixed `run_checks` tool: an optional `checkId`
selects one declared check; omitting it runs them in declaration order. The
separate host sandbox runner (bubblewrap on Linux, Seatbelt via `sandbox-exec`
on macOS) executes the current candidate without network
or credentials. On an unavailable host, the packet records the reason, emits a
warning and runs without the tool. `worker start` and `worker run` repeat the
same `run_checks unavailable: ...` warning on stderr; `--json` keeps stdout to
one JSON result.

`limits.maxCheckRuns` defaults to 12 and accepts integers from 1 to 20 when the
tool is available. Each individual check consumes one run, including checks
requested by an all-checks call, so size the budget for the number of declared
checks (a slice declaring `test`, `lint` and `typecheck` spends 3 runs per
all-checks call). Exhaustion, unknown ids and runner
unavailability throw tool errors while
the worker continues. Pi 1.4.0 executes a batch containing `run_checks`
sequentially in assistant source order: `[write, run_checks]` observes that
write; `[run_checks, write]` checks the earlier candidate. The tool does not
reorder sibling writes. Checks share
the worker wall-clock deadline and are cancelled when the worker ends. Declared
dependency mounts cannot overlap any allowed path. Each mount is fingerprinted
before launch (up to 250,000 entries and 512 MiB of file content). Symlinks may
point anywhere inside the project, so npm workspace links such as
`node_modules/@scope/pkg -> ../../packages/pkg` are recorded by their target.
When a mount cannot be fingerprinted (a symlink that leaves the project, a
limit exceeded, a special file), the run starts without `run_checks` and
`runtime.json.runChecks.reason` starts with `dependency mount identity
unavailable:`.

Pi 1.4.0 silently drops an unregistered name from `--tools`, so the worker
checks the tool list Pi announces before the first turn against
`runtime.json.capabilities.tools`. When a contract tool such as `run_checks` is
missing, the worker stops Pi and the run fails with the warning `Pi did not
declare run_checks to the model; the run was stopped and failed.`
`result.json.observed.toolLoadout` records `expected`, `announced` and
`missing`. Under Seatbelt the profile grants the check channel: the client and
its `responses` directory read-only, its `requests` directory writable.

When neither the worker's `limits` nor its profile's measured `limits` set
`timeoutMs` and `maxToolCalls`, each worker gets 600000 ms (10 minutes) and 100
tool calls. Explicit values remain bounded by the existing 3600000 ms and
10000-call caps; `firstWriteMs` remains opt-in. See
[model registry profiles](#model-registry-profiles) for how profile limits
become defaults.

`checks.jsonl` and bounded output artifacts retain host observations, including
the digests of the candidate bytes checked. `result.workerObservedChecks` labels
these as `source: "worker run_checks", acceptanceEvidence: false`. They are
feedback for the worker; the operator still verifies and accepts separately.
When the tool is available, the worker contract asks for an edit → `run_checks`
→ fix loop: run the named checks after each allowed write or edit, fix failures
within scope, and stop/report when the check budget or required information or
permission is exhausted. The handoff lists observed checks separately from
checks still unrun. A slice's checks file may declare several named checks
(for example `test` and `lint`), each with its own argv and timeout; the prompt
lists each declared check by id, and `run_checks`, `checks.jsonl`,
`workerObservedChecks` and review evidence report every result by id. For a
TypeScript/Vue/Svelte slice, declare a typecheck check (`tsc --noEmit` or the
repository equivalent) alongside the test and lint checks: test runners such as
Vitest and tsx strip types, so a green test run does not prove the slice
compiles. `change validate` warns when a slice writes typed files and no
declared check runs a typecheck; `task add`, `task update` and `task approve`
warn for the same condition on a task's allowed files (only when a checks file
is declared). This contract does not add a shell or arbitrary execution
tool; an unavailable runner keeps the existing no-check prompt and Pi tool
arguments.

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
      "limits": { "timeoutMs": 600000, "maxToolCalls": 100 }
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
Profile `instructions` may be an explicitly empty string when the baseline needs
to preserve an empty instruction value; non-string values remain invalid.
Other machines must use their own exact configured IDs. No fallback is automatic.

### OpenCode worker

`"type": "opencode"` runs the worker through OpenCode 2.1.4 (the pinned
version). The provider comes from an OpenCode config file that you name
explicitly with an absolute `opencodeConfig` path. TinySDD reads only the named
provider and model from that file:

```json
{
  "workers": {
    "oc": {
      "type": "opencode",
      "provider": "titan",
      "model": "gemma4-26b-a4b-256k",
      "opencodeConfig": "/home/you/.config/opencode/opencode.json",
      "limits": { "timeoutMs": 600000, "maxToolCalls": 100 }
    }
  }
}
```

The provider must use `@ai-sdk/openai-compatible` (`npm`, or `package` in the
native form), an `options.baseURL` (or `settings.baseURL`) and an
`{env:NAME}` API key reference, or no key. The relay sends that key as
`Authorization: Bearer`. A literal key, another package, or any header other
than `User-Agent` (which is ignored with a warning) is refused before the run
starts; the refusal names the header and never shows its value. On Linux the
OpenCode sandbox gets its own procfs, which the OpenCode binary needs; the Pi
sandbox still has none, and the new procfs lists only sandbox processes. The worker's OpenCode configuration
comes only from TinySDD: no project, global, managed or wellknown OpenCode
configuration is read. The run is headless (`--standalone`, `--format json`),
allows only read and edit, and has automatic compaction off. Declared checks
add a local TinySDD plugin that provides `run_checks`. It is the only plugin
the config names; it is mounted read-only and talks to the same host check
channel as Pi's. The permissions get exactly one more rule,
`{ "action": "run_checks", "resource": "*", "effect": "allow" }`, after the
`*` deny. OpenCode starts the tool calls of one step concurrently and gives
no ordering, so a check first waits 100 ms and then until no write call of its
own message is in flight, also one that started after it; checks run one at a
time. This narrows the race but does not guarantee it; the check record's
candidate digests show which bytes were checked. `runtime.json.runnerFacts`
records the permission rules and plugin the run actually got. `run_checks`
calls count toward `maxToolCalls`. The plugin was exercised with OpenCode 2.1.4
run from source (not the release binary), inside bubblewrap with the worker's
mounts and a scripted model: OpenCode loaded it, offered only `read`, `write`,
`edit` and `run_checks`, and without the allow rule refused `run_checks`. It is
unverified against a live model and on macOS.

### Model registry profiles

Profiles in `profiles/` named after a host and route (for example
`titan-gemma4-26b-a4b-2x64k-v1.json`) are registry entries (#123). Each one
records one exact configuration and its measured results:

- `status`: `proposed`, `baseline`, `tested-improved` or `tested-inconclusive`;
- `model`: `route`, `family`, `quantization`, `server` (`id`, `version`),
  `contextWindow`, `parallel`, `note`;
- `limits` (`timeoutMs`, `maxToolCalls`, `maxCheckRuns`, `firstWriteMs`) and
  `responseBudget.maxTokens`: the settings it was measured with;
- `benchmarks[]`: aggregate cards (suite, date, settings, pass@1, pass@2,
  minutes per task, per-language rates, and a keep/reject decision for tested
  candidates). Cards never hold prompts, traces or test output.

All registry fields are optional and strictly validated; older profiles stay
valid.

**The profile is the configuration.** For each worker run TinySDD applies the
selected profile:

- `model.contextWindow` and `responseBudget.maxTokens` replace the Pi entry's
  values in the worker's temporary Pi state. Your own Pi `models.json` is not
  changed; when its values differ, preflight shows a warning. Make sure the
  server really serves that context window.
- `limits` are the measured settings and become defaults, not a binding
  configuration (#174). A worker's explicit `limits` win, without
  `PROFILE_LIMIT_CONFLICT`. `config show` records both values per limit under
  `provenance.workers.<name>.limitProvenance` (and the selected worker's
  `limitProvenance`) as `{ measured, effective, source }` with source `profile`
  or `worker`; the run's `runtime.json` records the same. A run with other
  limits than the measured ones is therefore visibly not the benchmarked
  configuration, which the qualification digest covers. The
  `firstWriteMs < timeoutMs` invariant still applies to the merged limits and
  still fails with `PROFILE_LIMIT_CONFLICT`. Because the qualification digest
  covers the effective limits, raising a limit in `enforce` qualification mode
  makes the worker no longer qualified (`MODEL_NOT_QUALIFIED`) until it is
  re-qualified.
- `model.route` must equal `worker.model`; otherwise the run fails before any
  model call.

Select a profile by path or by id:

```json
"workers": { "gemma": { "type": "pi", "provider": "litellm", "model": "titan/llamacpp/gemma4-26b-a4b-2x64k", "profile": "titan-gemma4-26b-a4b-2x64k-v1" } }
```

An id is looked up, most specific first, in `.tinysdd/profiles/`,
`~/.config/tiny-sdd/profiles/` (your own), `~/.config/tiny-sdd/registry/` and the
profiles shipped with TinySDD. `TINYSDD_CONFIG_DIR` (or `XDG_CONFIG_HOME`)
moves the `~/.config/tiny-sdd` part. The same id with different content in two
places fails with `PROFILE_AMBIGUOUS`; an unknown id fails with
`PROFILE_NOT_FOUND`. There is no fallback. After a CLI upgrade, the registry
installed from the old release can differ from the profiles shipped with the
new CLI; `tinysdd profiles update` resolves that `PROFILE_AMBIGUOUS`.

To use another profile for one command, pass `--profile ID|PATH` to `config
show`, `worker run`, `worker start`, `worker settings` or `bench run`. The
result's `provenance.workers.<name>.profile` shows where the profile came from
and whether config or the argument selected it.

`status` and `benchmarks[]` are not part of the profile identity, so adding
benchmark evidence keeps existing qualification records current. Changing a
setting or the instructions does change it.

#### Choosing a registry entry

`tinysdd setup` installs the shared registry into `~/.config/tiny-sdd/registry/`.
After upgrading the CLI, run `tinysdd profiles update` (and `tinysdd skills
update`) to replace it with the new release's copy; your own profiles are not
touched. `tinysdd models [--route MODEL]` lists every profile TinySDD can
select, with its status, location, context window, `maxTokens` and the newest
whole-suite baseline numbers (pass@1, pass@2, minutes per task). It warns when
the installed registry is from another CLI version.

`tinysdd init --worker NAME --provider ID --model MODEL` selects the profile
measured on exactly that route:

- one match: written to `workers.NAME.profile`;
- several: `PROFILE_MATCH_AMBIGUOUS`, nothing is written; rerun with
  `--profile ID`;
- none: the worker is written without a profile and `init` says so.

`init --profile ID|PATH` selects one explicitly; a profile measured on another
route fails with `PROFILE_ROUTE_MISMATCH`. To change the profile later, edit
`workers.NAME.profile` in `.tinysdd/config.json`.

For a model without a registry entry, `tinysdd profiles new` asks for the
route, id, context window, parallel slots, `maxTokens`, timeout, thinking,
family, quantization and server (empty skips a question), and writes a
`proposed` profile to `~/.config/tiny-sdd/profiles/<id>.json`. Flags such as
`--route`, `--max-tokens` and `--timeout-ms` answer questions without a
terminal. Add instructions to its `instructions` field yourself. Contribute a
benchmarked profile to the shared registry with a PR to the repository's
`profiles/`.

Before a launch, TinySDD compares the requested thinking level with what Pi will
actually send for that model entry (rules read from pi-ai 1.4.0; the thinking-budget,
clamp and OpenAI/DeepSeek request code is unchanged from pi-ai 1.0.0). A thinking
level Pi cannot send, because the entry lacks `reasoning: true`, fails
`worker start` and `worker run` before any model call. Warnings cover `thinking: "off"`
with no off toggle (a Qwen chat template then thinks anyway), a missing
`maxTokens` (Pi's silent 16384-token response cap), and thinking without a
`compat.thinkingTokenBudgetField` (reasoning can use the whole response).
`runtime.json` records `thinking` (requested) next to `effectiveThinkingControl`,
`effectiveMaxTokens` and `maxTokensSource`.

To cap reasoning per response, set the request field and, optionally, per-level
budgets in the worker's profile. TinySDD writes the budgets into the worker's
temporary Pi settings; your global Pi settings are never inherited:

```json
"runtime": {
  "thinking": "medium",
  "reasoning": true,
  "compat": { "thinkingFormat": "qwen-chat-template", "thinkingTokenBudgetField": "thinking_budget_tokens" },
  "thinkingBudgets": { "medium": 8192, "high": 16384 }
}
```

Pi clamps the budget so that 1024 tokens of `maxTokens` stay available for the
answer. Without `thinkingBudgets`, Pi's defaults apply (minimal 1024, low 2048,
medium 8192, high 16384). `runtime.json` records the effective budget as
`effectiveThinkingBudget`. The server must honor the field; check one run's
`usage.reasoning` against it.

Context compaction stays off unless a profile opts in. To enable deterministic
compaction, add this to the selected profile:

```json
{
  "schemaVersion": 1,
  "id": "qwen-compaction",
  "runtime": {
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 }
  }
}
```

`reserveTokens` must be at least the worker's effective `maxTokens`; an omitted
reserve uses that effective value. In Pi 1.4.0 it only sets when automatic
compaction starts; summary budgets no longer depend on it, and the deterministic
path makes no model call. The host writes an immutable approved-packet
anchor and loads TinySDD's deterministic extension through the Linux bubblewrap
or macOS Seatbelt sandbox. It elides only paired old `read` and `run_checks`
outputs, retaining their digests and replay markers. Inspect `runtime.json` for
the compaction mode and anchor identity, then `result.json` at
`observed.compactions` for summary and extension-detail digests. Deterministic
events do not receive the model-summary warning; malformed, aborted or
oversized compactions cancel with an explicit reason.

Optional `limits.firstWriteMs` (below `timeoutMs`) is a no-progress watchdog:
if no `write` or `edit` tool call has started by then, the run stops with outcome
`no_progress` and keeps its raw events, including the partial reasoning. It is
off unless set. The result's `observed.toolCallsByName`, `writeCalls` and
`firstWriteAtMs` (100 ms poll granularity) show how a run spent its time.

Optional worker `skills` lists project-relative SKILL.md files; `instructions`
lists additional project-relative text resources. Applicable AGENTS.md guidance
is included separately. Profiles cannot override task permissions. MCP and
arbitrary runtime extensions are not supported in this first adapter.
Every worker launch passes `--offline`, `--no-extensions`, `--no-mcp`,
`--no-skills`, `--no-prompt-templates`, `--no-context-files` and `--no-approve`,
so Pi 1.4.0 does not discover extensions, MCP servers, skills, prompt templates
or context files, and ignores trust-gated project-local configuration. `--no-extensions` also suppresses
the built-in extensions; `--no-mcp` is an explicit guard against MCP servers.
Available checks-bearing packets explicitly load only TinySDD’s read-only check
client, with `read,write,edit,run_checks` as the tool allowlist. Unavailable
hosts keep the existing no-check extension and tool arguments. Codemode, MCP,
tool-search and llama.cpp built-ins are not enabled.

Optional `.tinysdd/config.local.json` replaces whole workers by name, not nested
fields. Arrays replace; null/unknown fields are errors. Credentials stay in Pi's
existing configuration/environment, not either project config file. Inspect
resolution before dispatch:

```sh
tinysdd config validate
tinysdd config show --worker qwen --json
tinysdd worker start --task first-change --worker qwen --json
# Poll the returned launch id while data.status is "running" or "stopping".
# data.request.launchStatus is the launch-time snapshot, not current state.
tinysdd worker status --id LAUNCH_ID --json
```

`data.status` is `running`, `stopping` (a stop was requested), `finished` or
`interrupted` (the launcher exited without writing a result). A `finished`
launch carries the launch result in `data.result`: `{ ok: true, data }`, or
`{ ok: false, error, data }` for a failed outcome or scope violation, with the
run's outcome at `data.result.data.outcome`.

### Worker per task and escalation

A task can name the worker that should run it, chosen by the preparing model:

```sh
tinysdd task add --id parser --brief docs/tasks/parser.md --allow src/parser.ts \
  --worker strong --worker-reason 'three interfaces, async edge cases'
```

A slice descriptor carries the same choice as optional `worker` and
`workerReason` fields, and the registration plan passes them on. The worker is
part of what the operator approves: changing it with `task update --worker`
makes the approval stale. `--worker=` clears it.

`worker run` and `worker start` pick the worker in this order: an explicit
`--worker`, then the task's worker, then `defaultWorker`. The run's
`result.json` and `runtime.json` record the choice as `workerSelection`
(`workerName`, `source` of `option`, `task` or `default`, and the reason).

Optional `workerTiers` in the config lists configured workers from fast to
strong; an undefined name is a `CONFIG_INVALID` error:

```json
{ "workerTiers": ["fast", "strong"] }
```

When a run of a listed worker other than the last ends with any outcome other
than `completed`, the `worker run` result (and the `worker status` launch
result) includes an `escalation` suggestion with the next tier and the command
to run it. TinySDD never starts that run itself. The operator, or an
orchestrating agent after the operator agrees, runs it with
`--escalated-from RUN_ID`, and the new run records the failed run under
`workerSelection.escalatedFrom`.

Qualification dispatch uses the current worker, the current benchmark suite,
and the effective verifier and runtime facts. Set an optional project suite and
mode in `.tinysdd/config.json`:

```json
"qualification": { "mode": "warn", "suite": "bench/implement-slice-suite" }
```

The mode defaults to `warn`; `enforce` refuses an unqualified
`implement-slice` before launch, and `off` skips qualification checks. An
unavailable current suite or runtime context produces an explicit warning in
`warn` mode. Optional quantization and server metadata remain explicit
`UNKNOWN` facts when absent. A changed model endpoint, profile, verifier,
suite, check declaration, or budget produces a different digest; records for
the old digest are stale. A qualification is also compared with the run's
`run_checks` availability and reason. Records made while `run_checks` was
unavailable, on macOS before the Seatbelt check runner or for any OpenCode
worker, no longer match once checks are available: `warn` reports the run as
unqualified and `enforce` refuses it. Qualify such a worker again.

To end a launch early, run `tinysdd worker stop --id LAUNCH_ID --json` rather than
killing the launcher. It signals the launcher, which stops Pi and finalizes the
run as usual: the result has outcome `stopped` (error code `WORKER_STOPPED`), and
the candidate, patch and raw events are kept. `stopped` is not acceptance; review
the candidate like any other failed outcome. `--wait-ms N` (0 to 600000, default
30000) bounds how long the command waits for the result. If finalizing takes
longer, `data.status` is `stopping`; poll `worker status` until it is `finished`.
`worker stop` signals only a process it can verify is that launch's launcher
(Linux `/proc`), and otherwise fails with `LAUNCH_NOT_OURS` without sending a
signal. Outside Linux (including macOS) it fails with `UNSUPPORTED_PLATFORM`
while the launch is still running, because there is no `/proc` to verify the
launcher; the run then ends at its own limits. Stopping an already stopping
launch only waits; a launch that already finished or was interrupted is
reported as such.

Every non-completed worker result includes `candidateState`: the number of
allowed paths changed and the sorted allowed paths left untouched. A non-completed
result with changed paths is a candidate for review, not a reason to discard it.
A scope-clean `timeout` or `tool_limit` run can be the `--base-run` of a
revision, so the next worker finishes the retained candidate instead of starting
over. Its retained evidence is verified the same way as a completed base, and
the revision records the incomplete outcome in `result.baseRun.outcome` (and on
the matching `baseRun.chain` entry). `apply` still refuses the incomplete run
itself; only a completed revision built on it applies. Other outcomes
(`failed`, `stopped`, `no_progress`, output-limit stops) are not valid bases.

## Run an isolated benchmark

Use the benchmark command for an operator-selected suite of runnable
`implement-slice`, `stop-and-ask`, or `write-tests` challenges. A suite directory
contains `suite.json`, fixture snapshots, packet resources, and verifier-only
resources. Without `--suite`, `bench run` uses `qualification.suite` when it is
configured and otherwise `bench`, relative to the project; pass the directory
or its `suite.json` explicitly when it is elsewhere:

```sh
tinysdd worker settings --worker qwen --entry-kind real --json
# After the operator reviews the report and confirms its settingsDigest:
tinysdd bench run --worker qwen --suite bench --repeat 2 --entry-kind real \
  --confirm-settings CONFIRMED_SETTINGS_DIGEST --json
```

Before live readiness or benchmarking, show the effective settings and obtain
operator confirmation. Use the operator's real Pi entry; the setup fixture's
`reasoning: false` and `maxTokens: 1024` are offline placeholders. `worker
settings` reports the entry kind (operator-declared), model-file path,
reasoning/map, requested/default/effective thinking, cap and sources, and context
window without credentials. `THINKING_CONTROL_MISMATCH` needs explicit operator
acknowledgement via `--ack-finding THINKING_CONTROL_MISMATCH` on `bench run`.
A missing/stale settings digest or missing required acknowledgement stops that
CLI benchmark before inference. Ordinary worker commands retain their current
contract; setup enforces confirmation through its skill workflow. Do not
script automatic digest confirmation. Reinspect and reconfirm settings changes.

The report separates `requestedThinking` from Pi's `effectiveThinking` after
level clamping. In Pi 1.4.0, `thinkingLevelMap.off: null` can clamp `off` to
`minimal`, enabling reasoning; this requires the named mismatch acknowledgement.
OpenAI-format `off` needs both a string off mapping and reasoning-effort support
to send a value. Unsupported non-off requests still fail preflight rather than
silently accepting a clamped level. `sent` predicts request construction only,
not server compliance. The basis names checked Pi 1.4.0 clamping/OpenAI/DeepSeek
rules; other format predictions are legacy and auto-detection stays unverified.
`maxTokens` is the configured response ceiling. Pi can lower the cap for an
individual request based on remaining context; this report is not an observation
of the wire request or the server response.

Optional `--observed-reasoning-tokens N` on inspection/benchmark reports a
configuration advisory when that operator-supplied count meets/exceeds the
response cap; there is no universal low-token refusal threshold. `bench qualify`
reports `response_token_limit` attempts as configuration-limited while retaining
their actual checks, failures, denominator and qualification result. These stops
alone do not establish model capability. Known `worker.modelMetadata.quantization`
and `.server.id`/`.version` can be supplied in config; profile digests are derived
from configured profiles. Absent metadata stays `UNKNOWN`. See the
[setup reference](../skills/tinysdd/assets/setup/references/setup-workflow.md) for the confirmation and metadata procedure.

The command creates immutable results under
`.tinysdd/bench/<suite-id>/<invocation-id>/`: one case result for every
challenge and repetition, a config identity and digest, and a summary. Each
attempt starts from a fresh fixture. Worker output is retained before visible
and held-out checks run in a separate evaluator input; held-out files never
enter the worker prompt, workspace, candidate snapshot, or a later revision.

`--repeat` is an integer from 1 to 1000. `--json` writes one result object to
stdout; progress and unavailable `run_checks` warnings go to stderr. The
benchmark records verifier unavailability separately and never turns it into a
passing check. It does not apply files, change controller task state, record
acceptance, or qualify a model.

The suites below ship in the source repository, not in the npm package.
This checkout includes the challenge data at `bench/implement-slice-suite`. It
contains nine runnable `implement-slice` challenges (two new-module, two
brownfield, two bug-fix, one async-heavy, one library-API, and one lint-rule)
plus one runnable `stop-and-ask` challenge. The tenth writes only
`questions/report.json` with named missing inputs and a nonempty question; it
must leave implementation and protected files unchanged. The current corrected
version runs Opal's worker check against the protected fixture test and covers
Cedar's valid zero amount in both visible and independent checks; its
positive-only audit mutant fails the independent zero-boundary check.
Ember's library-API challenge now covers present `undefined`, `false`, `0`, an
empty string and `null`, first-match order and no match in protected and
independent checks. Its corrected reference branches on `isSome`, while the
retained nullish-fallback mutant fails the named independent `held-out-value`
check. The earlier Ember pilot used the old oracle; affected challenge and
suite identities are versioned and digest-bound, so historical results remain
comparable only within their original identity. Run the suite with
`--suite bench/implement-slice-suite`.

The write-tests challenge data is at `bench/write-tests-suite`. It contains five
contract-test challenges with a visible reference run and 20 held-out mutant
checks. The verifier reuses the submitted test bytes for every reference and
mutant evaluation, rejects empty, skipped, setup-failing and syntax-invalid
runs, and records `referencePass` plus killed over declared mutants as
measurement data only. These values are derived from the existing verifier
records; they do not change the result shape. Run it with
`--suite bench/write-tests-suite`.
The `2026-10-19.1` suite version recognizes named child witnesses from nested Node
`describe`/`it` tests by their own indented TAP diagnostic blocks; sibling or
parent diagnostics do not satisfy a witness, and evaluator or setup failures
remain invalid.

### Score retained benchmark evidence

Qualification reads immutable benchmark results; it does not run Pi, checks, or
another live suite. Pass the suite explicitly so TinySDD can hash its roster and
verify every declared challenge, repetition, and visible or held-out check:

```sh
tinysdd bench qualify \
  --results .tinysdd/bench/write-tests-v1/INVOCATION \
  --suite bench/write-tests-suite \
  --target write-tests=0.8 \
  --json
```

`--suite` is optional: it uses `qualification.suite` when configured and
otherwise `bench`. The first `--results` path anchors the historical digest;
all retained invocations for that exact digest and suite are pooled, including
later failures. A repeated invocation is deduplicated by its immutable ID and
hash. `bench qualify` may create or refresh a record from this offline evidence;
worker dispatch only refreshes an existing exact record and never bootstraps one
from raw benchmark output.

The default target is `0.8` for each role, provisional until #33 calibrates it,
and can be overridden with repeated `--target ROLE=NUMBER` values. Scores use
the two-sided 95% Wilson interval
with z `1.959963984540054`: `qualified` requires lower bound >= target,
`not qualified` requires upper bound < target, and all other results are
`insufficient evidence`. The record retains n, passes, both bounds, confidence,
target, method, invocation and case hashes, the suite roster, and both
best-case counters. `passesToQualify` and `failuresToRuleOut` are minimum extra
consecutive passes or failures under the corresponding best-case bound; they are
not predictions. Repeated cases are pooled as a correlated, provisional
approximation, so the interval is evidence for this retained run rather than
an independence claim.

Qualification scoring is independent of task apply and acceptance: a retained
timeout may count as a statistical case pass when all visible and held-out
checks pass with no hard-gate violation; the raw outcome and task rules remain
unchanged.

Worker `runtime.json` and `result.json` retain the qualification digest and
record path, status, mode, reason, changed identity fields, and warnings. The
same warning is returned by `worker start` and written to stderr by the direct
worker command; JSON mode keeps stdout to one object.

Qualification records are stored under `.tinysdd/qualifications/` with a
dedicated lock and profile sidecar. A repeated exact invocation input is ignored
once and reported as a duplicate; the same attempt ID from different invocation
IDs remains distinct evidence. Rescore a saved record offline without rerunning
anything:

```sh
tinysdd bench rescore \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --target write-tests=0.9
tinysdd bench qualification show \
  --record .tinysdd/qualifications/CONFIG_DIGEST.json \
  --suite bench/write-tests-suite --worker qwen
```

`show` reports current identity applicability separately from the historical
qualification status. A profile or any other config identity change makes the
record stale; unavailable identity fields remain `UNKNOWN` and are not treated
as a completeness or eligibility gate. Qualification is evidence only and does
not authorize dispatch or acceptance.

### Incomplete benchmark evidence

A settings or runtime drift can stop an invocation between cases. The runner
retains every declared visible and held-out check as either its executed record
or an explicit `not_run` record, so qualification can
read the retained invocation and expose the incomplete case. `not_run` checks
never count as passes: qualification cannot qualify from them. The reader
still requires exact challenge/repetition coverage, check IDs, definition
digests, config identity and artifact hashes; edited or missing roster records
are rejected.

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
If `task update` changes the approved allow, protect, context, checks, or
dependency shape, benchmark replay refuses with `STALE_BENCHMARK_SHAPE` instead
of silently replaying a different packet. Re-approve the revised task before
starting a new benchmark.
For a replay with available checks, dependency mounts are resolved from the
live canonical project root and recorded with a content identity. The replay's
`runtime.json.runChecks.baselineComparison` reports `identical`, `different` or
`unknown`; older baseline artifacts without that identity remain `unknown`.
For a `--base-run` revision, the comparison uses the immediate parent run's
recorded identity; an older parent without that identity remains `unknown`.

## Review the result

The worker edits a disposable copy using read/write/edit. Available declared
checks add the fixed `run_checks` client. Its check results are worker feedback
and point to local evidence and a patch under `.tinysdd/runs/`; the operator
still owns independent verification. The worker does not apply the patch,
commit, or accept its own result. Inference can reach the selected
provider; use only source you are authorized to send there. Raw event files may
contain source. Filename exclusions are not a general secret scanner.
The candidate omits `.git`, `.tinysdd`, `node_modules` and common credential files;
source symlinks are rejected. In a Git work tree the copy set is
`git ls-files --cached --others --exclude-standard`, so gitignored files (runtime
state, build output, local agent homes) are left out while new untracked source
is kept; outside Git the whole tree is walked. `workspaceCopy.mode` in the result
records which was used. An allowed file or context excerpt that exists but is
gitignored fails the run instead of producing an unappliable patch.
Run workers from the project itself or from a real `git worktree`, never from a
hand-synced copy: the copy set comes from Git, so ignored files in the project
directory never reach the worker, and a synced copy only adds ways to break the
`.git` link or pick up stray files. `.tinysdd/` is always left out of the copy,
whether it is committed, untracked or ignored. Put needed dependency interfaces in the task or
selected instruction resources rather than assuming the worker can inspect an
installed dependency tree.

Have your outer agent inspect the complete actual candidate inventory and any
boundary violations, then verify the diff in an appropriate credential-free
disposable environment. Apply the reviewed run to the project before recording
acceptance: acceptance binds the planned and actual candidate files, so accepting
first and applying later makes the task `stale` and blocks its dependents.
Preserve the observed checks and review findings in a project file. Then:

```sh
tinysdd task apply --id first-change --run WORKER_RUN_ID --by ivo
tinysdd task review --id first-change --verdict accepted --evidence docs/reviews/first-change.md --by ivo
tinysdd status
tinysdd next
```

For a manually inspected ordinary file that was created or changed outside the
planned paths, include its actual path in the review evidence:

```sh
tinysdd task review --id first-change --verdict accepted \
  --evidence docs/reviews/first-change.md --by ivo \
  --candidate-paths src/manual-extra.mjs
```

The controller unions these paths with the planned and already applied paths,
records their current content identity, and marks the acceptance stale if one
of them changes later.

`task apply` copies every retained eligible actual file by content, not by patch,
so it also works for a `--base-run` revision, whose `patch.diff` is a delta against
the prior candidate. It follows the revision lineage back to the first run and
applies only the complete paths and before/after identities those runs recorded.
It refuses with `APPLY_CONFLICT`, writing nothing, when one of those project files
no longer matches the state the lineage started from. A file that already equals
the candidate (for example applied by hand) is recorded as `already-applied`. It
refuses missing or tampered snapshot/inventory proof, protected or otherwise
ineligible changes, a run of another task, a benchmark replay, a run with scope
violations and a run whose outcome is not `completed` (a timed-out one included),
with no override. It also refuses, with `APPLY_CHANGES_TASK_INPUT` and nothing
written, a run that would rewrite the task's own brief, context manifest, checks
manifest or preparation input: the approval they were dispatched under would go
stale. The run is recorded under `applied` in `status --json`, and an accepting
review adds `appliedFromRun`, with `identical: false` when any planned or actual
candidate file differs from what apply left. Applying is not verification or
acceptance.
It also refuses with `RUN_APPROVAL_MISMATCH` when the final run packet was dispatched under a different approval digest; dispatch a fresh run after re-approval.

Apply is all or nothing: if anything fails after the first file is written,
including saving the controller state, apply restores the files it wrote and
removes the files and directories it created before it reports the error. An
extra (not allowed) path in a revision candidate is applied and shown to the next
review like one in a first run. To leave a stray extra path out, name it with
`--exclude`; it is not written, not reviewed and listed under `applied.excluded`:

```sh
tinysdd task apply --id first-change --run WORKER_RUN_ID --by ivo \
  --exclude changes/004-feature-core/.keep-check-trigger
```

`--exclude` refuses a path the lineage did not change (`APPLY_EXCLUDE_UNKNOWN`)
and an allowed path of the task (`APPLY_EXCLUDE_ALLOWED`), writing nothing. It
does not lift the refusal of a deletion or other ineligible change.

After an apply the approval keeps binding the context the worker started from:
the cited lines of a file apply wrote are read from the first run's starting copy,
so applying does not make the approval stale, and nothing re-approves the new
source. Every other cited file, including an allowed file the run did not change
and a path that was already applied, is read from the project, so editing it still
makes the approval stale. If a written file's run directory is gone the approval
reads stale, and an apply that would leave the approval stale is refused with
`APPLY_WOULD_STALE` before anything is written. While an apply is
recorded, `task packet` and `worker run` refuse with `TASK_APPLIED`; record the
review first. An accepted or blocked review keeps the apply record. A `revision`
review records `appliedFromRun` and clears the apply record, because the next
attempt builds on the applied project; if the context cites a file apply wrote
whose cited lines changed, the approval then reads `stale_approval` and you re-approve
it explicitly. A later run made with `--base-run` of an already applied run
conflicts, because the project no longer matches the lineage's starting state;
dispatch the next attempt from the applied project instead.

Several slices often grow one file: one creates a service, the next depends on it
and adds a function. Applying a dependent that rewrites a candidate file of an
accepted prerequisite (direct or transitive) keeps that prerequisite accepted and
records the dependent's run, paths and the resulting file identity under
`review.extendedBy`. The acceptance digest does not change, so the dependent's
approval stays fresh and its own review can accept. The prerequisite then matches
either the bytes it was accepted with or what the last such apply left; any other
edit to those files still makes it `stale` and blocks the chain. Applying a task
that is not a dependent still stales an accepted task whose files it rewrites;
`task apply` lists it under `staled` with a warning on stderr. To recover, re-run
that task's checks and record `task review --verdict accepted` again, then
`task approve` each task that depends on it, because their approvals bound the old
acceptance.

Use `revision` or `blocked` instead of accepting an incomplete result. Caller
evidence is labeled as such; the CLI does not claim to have executed its tests.
For a revision, the next packet includes the recorded review feedback. Retain
that evidence unchanged until dispatch, or explicitly record the revised review.
Changes to a brief, accepted files, evidence or prerequisites invalidate affected
decisions. Approval labels are audit records, not authenticated identities.

Controller mutations use an exclusive lock. If a crash leaves a stale lock, the
CLI stops for manual inspection; it does not guess that another writer is safe
to remove. Do not remove a lock while its owning process is still active.

This version deliberately leaves verification in the outer harness; the CLI
copies a run into the project only when you call `task apply`.
It is suitable for controlled testing, not unsupervised production changes.

### Retained slice-test review measurements

`tinysdd --json slice-tests report --feature NAME` reconstructs the retained
#81 assessment and strong-review records. It reports positive-review coverage
and disagreement with explicit denominators, unreviewed negatives, revisions,
escalations and measured Jev usage. Missing measurements remain `UNKNOWN`.
Replay measurements are retained separately and do not count as live inference.
Whole-slice reviews do not establish criterion labels or population calibration.
This report reads evidence; it does not run a provider, approve tests, or accept
a task or feature. The active controller flow is described below.

### Active slice-test review

Configure `testReview` explicitly before using this flow: `positiveThreshold`,
`negativeThreshold` (lower than the positive boundary), `revisionLimit`,
`uncertainRoute: "escalation"`, and `unavailableRoute` (`revision`, `escalation`,
or `unavailable`). There are no numerical defaults. Every criterion at or above
the positive boundary yields a positive assessment; any criterion below the
negative boundary yields a negative assessment; other results escalate.
Projects without an active `testReview` policy retain their existing controller
behavior. A legacy policy without `negativeThreshold` remains valid but does not
activate the slice-test workflow.

1. Run an approved worker candidate, retaining its exact final packet and lineage.
2. Call `slice-tests assess --id ID --run RUN --change changes/CHANGE/change.json
   --implementer MODEL_ID --producer JEV_ID --provider-config config/jev.json
   --credential-env JEV_TOKEN` (as one command). The provider file uses the
   #40 adapter's explicit id, endpoint, model and configSha256 contract; the
   credential travels only through the transport. It is not a command argument,
   retained artifact or worker input. Provider failures retain a failure event.
3. Inspect `slice-tests status --id ID`. A negative verdict permits
   `worker run --task ID --base-run RUN` within the retained revision cap.
   Reassess that returned candidate. Failed/incomplete attempts spend their
   reserved slot; restarting does not reset the cap. A pending interrupted
   assessment requires operator inspection rather than a duplicate invocation.
4. For positive or escalated assessments, run `slice-tests check --id ID
   --event EVENT_ID`. This independently executes the approved slice checks
   against retained candidate bytes, using the safe host runner and frozen
   dependency mounts. These commands do not execute inside the inference sandbox.
5. Have a separately identified strong reviewer inspect the exact retained
   envelope and write evidence. Record it with `slice-tests review --id ID
   --event CHECK_EVENT_ID --input-digest SHA256 --reviewer MODEL_ID
   --strength strong --attested true --verdict accepted --evidence PATH`.
   This records the caller's attestation; it does not invoke or verify that
   reviewer's model execution. Optional measured frontier usage can be supplied
   through `reviewSliceTests`'s `reviewUsage`; absent fields are UNKNOWN.
6. Explicitly `task apply`, then `task review --verdict accepted`, then
   `feature accept`. Strong test review does not accept a task or feature.
   Feature acceptance still executes protected tests through the declared real
   entrypoints. A failed feature check requires operator-requested task revision;
   the applied project becomes its revision base, within the same retained cap.
   Operator revision publication is committed after the controller transition;
   repeat the same revision review after a publication failure to repair its
   retained event and immutable record. An uncommitted intent cannot publish a
   workflow transition.

Changed candidate, approval, policy, retained lineage or strong-review evidence
invalidates use of the reviewed candidate. Accepted tasks retain a review binding;
changed policy or evidence makes that acceptance stale. Old review records remain
valid under their original controller contract. No provider/model fallback exists.

Inputs and immutable event files live under `.tinysdd/runs/slice-test-review/`;
`events.jsonl` reconstructs the workflow and `slice-tests report` its metrics.
`slice-tests dataset --partition train|validation|test [--feature NAME]` emits
reviewed cases in the #32 schema, with immutable evidence references and whole
feature/lineage grouping. Unreviewed negatives are excluded, injected transports
and runners are synthetic, and whole-slice labels do not label each criterion.
The export requires an explicit partition and existing reviews. Reported
calibration, direct-strong comparison and total feature cost remain UNKNOWN
without the corresponding measurements. Live model evaluation remains unverified.
