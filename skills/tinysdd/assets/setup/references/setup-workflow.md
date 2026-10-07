# TinySDD setup workflow

This reference describes the current source checkout, Pi worker and
authentication boundaries. It intentionally uses the existing CLI and worker
contracts; it does not add a setup command or another configuration format.

## 1. Choose the source checkout and CLI route

`package.json` marks TinySDD as `private: true`. There is no supported
`npm install tinysdd`, `npx tinysdd` or published package route. Use a checkout
provided by the operator or an operator-authorized Git checkout. The CLI has no
runtime dependencies or build step:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
TARGET_PROJECT=/absolute/path/to/existing-project

node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --version
```

Keep `TINYSDD_CHECKOUT` separate from `TARGET_PROJECT`. Use the absolute source
path when the current harness does not install a command named `tinysdd`. Do
not use a global link or a registry package as a substitute for this checkout.
The development suite is separate from user setup and, when run, uses
`TYPESAFE_API_KEY=stub npm test` as described by the repository instructions.

## 2. Load the skills explicitly

The skill files are project-local prompt assets. This checkout tracks relative
directory registrations for the two entrypoints in both native repository
locations:

```text
<checkout>/.agents/skills/tinysdd       -> ../../skills/tinysdd
<checkout>/.agents/skills/tinysdd-setup -> ../../skills/tinysdd/assets/setup
<checkout>/.claude/skills/tinysdd       -> ../../skills/tinysdd
<checkout>/.claude/skills/tinysdd-setup -> ../../skills/tinysdd/assets/setup
```

Start Claude or Codex from a fresh clone of this checkout to use repository
discovery. Invoke `/tinysdd-setup` in Claude or `$tinysdd-setup` in Codex, then
load `/tinysdd` or `$tinysdd`. If the entries are unavailable, start a new
session or restart the harness. The links are scoped to this checkout and do
not install skills into `TARGET_PROJECT`, a user directory or a global harness
configuration. The linked directories preserve the relative `references/` and
`assets/` beside each `SKILL.md`; nested `SKILL.md` files are supporting paths
to load through the selected skill or an explicit path.

For a harness without native repository discovery, use the direct project-local
paths and retain the relative files beside the selected entrypoint:

```text
<checkout>/skills/tinysdd/SKILL.md
<checkout>/skills/tinysdd/assets/setup/SKILL.md
<checkout>/skills/tinysdd/assets/constitution/SKILL.md
<checkout>/skills/tinysdd/assets/harness/claude/tinysdd-frontier/SKILL.md
<checkout>/skills/tinysdd/assets/harness/claude/tinysdd-frontier/specify/SKILL.md
<checkout>/skills/tinysdd/assets/harness/claude/tinysdd-frontier/research/SKILL.md
<checkout>/skills/tinysdd/assets/harness/claude/tinysdd-frontier/plan/SKILL.md
<checkout>/skills/tinysdd/assets/harness/claude/tinysdd-frontier/slice/SKILL.md
```

For a fresh project, load the setup skill and then the product skill. For a
full feature, inspect the recommended constitution files and load the
constitution skill only when the operator adopts them; then load the router
before selecting exactly one phase. The phase files use sibling
`references/` and `templates/` paths. Registering only a phase file, or
assuming that a harness discovers nested files automatically, can leave the
agent without the contract or templates that phase requires.

The Pi interactive consumer has its own explicit skill path under
`assets/harness/pi/`; it is a separate consumer workflow. Do not use the setup
skill as an implementation permission or as a replacement for an approved
TinySDD task packet.

## 3. Discover the supported runtime

Run only the non-secret checks below. These identify executable paths and
versions; they do not authenticate a provider or run model inference.

```sh
node --version
node -p 'process.execPath'

NODE_BIN_DIR="$(node -p 'require("node:path").dirname(process.execPath)')"
PI_EXECUTABLE="$NODE_BIN_DIR/pi"
if [ -x "$PI_EXECUTABLE" ]; then
  "$PI_EXECUTABLE" --version
else
  printf '%s\n' "Pi is not in the supported sibling bin directory: $PI_EXECUTABLE" >&2
fi
```

The worker uses the Node executable running TinySDD and looks for Pi at
`join(dirname(process.execPath), "pi")`; it does not search `PATH`. A symlink
to an installed Pi bundle is accepted when it resolves to an executable regular
file. The worker then walks up to eight parent directories for a `package.json`
with a name and version; Linux can reach execution with a missing version, while
the macOS Seatbelt path also needs the installed package root. Treat a missing
package identity as unqualified setup evidence and stop before readiness. A Pi
that runs from `PATH` but is beside a different Node, or a separate system/user
installation, is not a qualified layout for this adapter.

If that sibling executable is missing, stop the setup flow and obtain explicit
operator authorization before changing the selected Node installation. The
current pinned Pi package is `@earendil-works/pi-coding-agent@1.0.0`; install it
into the Node root that owns the exact `process.execPath` being used by
TinySDD. Do not use an unrelated global prefix, another Node installation or a
`PATH`-only install:

```sh
NODE_EXECUTABLE="$(node -p 'process.execPath')"
NODE_BIN_DIR="$(node -p 'require("node:path").dirname(process.execPath)')"
NODE_ROOT="$(node -p 'require("node:path").dirname(require("node:path").dirname(process.execPath))')"
NPM_EXECUTABLE="$NODE_BIN_DIR/npm"
printf '%s\n' "$NODE_EXECUTABLE" "$NODE_BIN_DIR" "$NODE_ROOT"
test "$NODE_BIN_DIR" = "$NODE_ROOT/bin"
test -x "$NODE_ROOT/bin/node"
test -x "$NPM_EXECUTABLE"
"$NPM_EXECUTABLE" --version
node --input-type=module <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  throw new Error(`Node ${process.versions.node} is below the supported 22.19.0 floor`);
}
NODE
test -w "$NODE_ROOT" && test -w "$NODE_ROOT/bin"
```

If any check fails, stop and have the operator select or authorize a suitable
Node root; do not redirect the install to a separate prefix. After that
authorization, the one machine-level repair is:

```sh
"$NPM_EXECUTABLE" install --global --prefix "$NODE_ROOT" \
  '@earendil-works/pi-coding-agent@1.0.0'
```

Verify the exact layout and package identity with the same Node path before
continuing. This reads only executable/package metadata and does not create
provider or credential configuration:

```sh
PI_EXECUTABLE="$NODE_BIN_DIR/pi"
test -x "$PI_EXECUTABLE"
"$PI_EXECUTABLE" --version
node --input-type=module - "$PI_EXECUTABLE" <<'NODE'
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const executable = process.argv[2];
const info = await lstat(executable);
if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Pi path is not a file or symlink');
const resolved = await realpath(executable);
const resolvedInfo = await lstat(resolved);
if (!resolvedInfo.isFile() || (resolvedInfo.mode & 0o111) === 0) throw new Error('Pi does not resolve to an executable file');
let current = dirname(resolved);
let version = null;
for (let count = 0; count < 8; count += 1) {
  try {
    const packageJson = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
    if (packageJson.name === '@earendil-works/pi-coding-agent' && typeof packageJson.version === 'string') {
      version = packageJson.version;
      break;
    }
  } catch {}
  const parent = dirname(current);
  if (parent === current) break;
  current = parent;
}
if (version !== '1.0.0') throw new Error(`expected Pi package 1.0.0, found ${version ?? 'no package identity'}`);
console.log(JSON.stringify({ executable, resolved, package: '@earendil-works/pi-coding-agent', version }));
NODE
```

Only after this repair and verification should setup continue to the exact
provider/model entry and environment-referenced credential described below.
This repair does not choose a provider, invent a model alias or read a
credential store. If the operator does not authorize the install, report the
missing sibling executable and leave the project and Node installation alone.

The current target is Pi **1.0.0**, and its fixed check-client surface requires
Node **>=22.19.0**. The package declares Node >=22, but use the stricter
22.19.0 floor for a worker readiness attempt. The runtime records the Pi
package version by walking from the resolved executable to a nearby
`package.json`; a successful `pi --version` by itself is discovery, not a
worker observation. The current worker records this version but does not
enforce the 1.0.0 target, so stop setup when the observed package version is
different instead of treating preflight success as compatibility evidence.

The supported worker sandbox matrix is:

| Host | Worker sandbox | Required executable(s) | `run_checks` |
| --- | --- | --- | --- |
| Linux | bubblewrap | `/usr/bin/bwrap` or `/bin/bwrap` | Available only when Linux bubblewrap, `prlimit`, and (when privileged) `setpriv` are available. |
| macOS | Seatbelt | `/usr/bin/sandbox-exec` | Unavailable by design because the check runner requires Linux. |
| Other | none | unsupported | Worker refuses an unsandboxed run. |

The check runner also requires a real Node root with `bin/node`; it does not
perform `PATH` lookup. Missing sandbox or check-runner support is an explicit
capability result. Do not install a system package, start a local model server,
or alter global configuration from this skill; ask the operator for that
separate action when needed.

## 4. Inspect and initialize project configuration

Use the source CLI against the target project. These operations are
controller-only and do not call a model:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" init
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" config validate --json
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" config show --json
```

If the project has no config and the operator has already selected the exact
route, creation can name the reusable worker in one call:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" init \
  --worker readiness --provider EXACT_PI_PROVIDER --model EXACT_PI_MODEL
```

`init` creates `.tinysdd/config.json` only when it is absent and preserves an
existing config. It also creates or updates `.tinysdd/.gitignore` for
`runs/`, `launches/` and `config.local.json`. It never installs Pi, downloads a
profile, calls a model or changes global harness settings.

The named worker uses `type: "pi"`, an exact `provider`, an exact `model`, and
optional project-relative profile, skill, instruction, model metadata and
limits fields. TinySDD's config has no credential or endpoint field. The
effective config can be selected with `--worker NAME`; this does not rewrite
the project config. A `.tinysdd/config.local.json` override replaces each
named worker as a whole rather than deep-merging it, so inspect the effective
result before dispatch. Preserve an existing worker and ask before changing
its route or limits.

`featureIntegration` is optional setup for later feature acceptance. Add it
only after choosing a real application entrypoint, its protected integration
test and the typed `argv` the host should execute. It is unrelated to the
synthetic readiness smoke and must not be invented just to make setup pass.

## 5. Select provider, model and authentication safely

TinySDD treats these as separate identities:

| Fact | Where it comes from | How to report it |
| --- | --- | --- |
| Configured route | `.tinysdd/config.json` worker `provider` and `model` | Caller-selected exact route; no fallback. |
| Pi route/backend | Pi `models.json` provider key, `api`, non-secret base URL and model entry | Operator configuration; do not copy secret fields into output. |
| Runtime identity | Retained `runtime.json` provider/model, Pi version and sandbox fields; platform comes from discovery or qualification facts | Observed for that run, while recognizing that caller-provided metadata is not server attestation. |
| Server identity and model quality | Provider response or independent qualification | `UNKNOWN` unless the run actually records an attested observation. |

The worker's source configuration directory defaults to
`$HOME/.config/pi/agent`; `PI_CODING_AGENT_DIR` can select another directory.
The preflight reads the selected `models.json` to require an exact provider key
and exact model `id`. It does not need the user's `auth.json`. Keep any
inspection to non-secret route metadata and file existence; do not print or
copy the file when it contains credentials.

Provider/model credentials should be referenced by environment name in Pi's
model configuration, for example `$TINYSDD_PROVIDER_KEY`. Supply the value
only through an operator-authorized secret mechanism and the process
environment of the readiness run. Never put the value in TinySDD config,
task briefs, shell arguments, chat, source, or retained artifacts. The worker
rejects shell command credential references, embedded URL credentials and
OAuth state in its temporary filtered Pi setup. It creates an empty temporary
`auth.json` and does not inherit the user's Pi auth store.

Missing or empty referenced environment values stop preflight with an
actionable error naming the missing variable. A provider 401/403 or connection
failure during inference is a separate observed authentication/transport
failure. Preserve that result and stop; do not try another provider/model or
paste a secret-bearing error into a report.

On macOS, the worker keeps the provider credential in the host controller and
uses a temporary loopback relay for the selected model's `POST
/chat/completions` route. It requires an explicit HTTP(S) base URL and rejects
redirects, other routes and model substitutions; Pi receives an ephemeral
relay token, not the provider credential. On Linux, Pi inference receives the
filtered environment needed for the selected provider inside bubblewrap, while
the separate `run_checks` sandbox receives neither the provider credential nor
network access. These are implementation boundaries, not evidence that a
selected endpoint is currently reachable or authenticated.

## 6. Use existing preflight before a readiness run

There is no separate setup preflight command. `worker start` resolves the
effective worker and calls the existing `preflightPiWorker` before it detaches
the launcher. It verifies the exact Pi provider/model entry, referenced
credential environment values, profile/runtime constraints and thinking
compatibility. A preflight failure is reported as `WORKER_PREFLIGHT_FAILED`
and should be fixed in the selected setup; do not bypass it with a different
route.

Prepare and approve the task packet first. Then use the detached command for a
real run and retain its single JSON result on stdout:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
  worker start --task TASK_ID --worker WORKER_NAME --json
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$TARGET_PROJECT" \
  worker status --id LAUNCH_ID --json
```

Progress and warnings go to stderr. `worker start` performs no model call when
preflight fails. A successful preflight still proves only that the configured
request can be prepared; it does not prove authentication, sandbox startup,
worker behavior or `run_checks` availability.

## 7. Bounded synthetic readiness smoke

Use the preparation below with a disposable project outside the real source
tree. The first stage is an offline fixture and preflight probe: it does not
read a credential, contact a provider or run inference. Do not copy private
source, auth files or global agent state into the fixture. The second stage is
the live readiness attempt and requires separate operator authorization for one
inference against the exact provider/model and an approved environment
credential.

Define the fixture and exact route values before creating any files. The
synthetic base URL is deliberately unreachable; replace it and the provider
and model IDs only for a later, operator-authorized live attempt:

```sh
TINYSDD_CHECKOUT=/absolute/path/to/tiny-sdd
READY_PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/tinysdd-ready.XXXXXX")"
READY_PROVIDER=synthetic
READY_MODEL=synthetic/model
READY_BASE_URL=https://example.invalid/v1
READY_CREDENTIAL_ENV=TINYSDD_READINESS_KEY
export TINYSDD_CHECKOUT READY_PROJECT READY_PROVIDER READY_MODEL READY_BASE_URL READY_CREDENTIAL_ENV

node --input-type=module - "$READY_PROJECT" "$READY_PROVIDER" "$READY_MODEL" \
  "$READY_BASE_URL" "$READY_CREDENTIAL_ENV" <<'NODE'
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, provider, model, baseUrl, credentialEnv] = process.argv.slice(2);
if (![root, provider, model, baseUrl, credentialEnv].every(Boolean)) {
  throw new Error('fixture arguments are required');
}
await mkdir(join(root, 'tests'), { recursive: true });
await mkdir(join(root, '.tinysdd', 'tasks'), { recursive: true });
await mkdir(join(root, '.pi-agent'), { recursive: true });
await writeFile(join(root, 'README.md'), 'TINYSDD_READINESS=unset\n');
await writeFile(join(root, 'tests', 'readiness.test.mjs'), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const value = await readFile(new URL('../README.md', import.meta.url), 'utf8');
assert.equal(value, 'TINYSDD_READINESS=ready\\n');
`);
await writeFile(join(root, '.tinysdd', 'tasks', 'readiness.md'), `
Replace the marker in README.md with TINYSDD_READINESS=ready and run the
declared readiness check after editing. Do not edit the protected test or the
task inputs under .tinysdd/tasks. Ordinary-create-modify extras remain
reviewable and must be reported.
`);
await writeFile(join(root, '.tinysdd', 'tasks', 'readiness.checks.json'), `${JSON.stringify({
  schemaVersion: 1,
  dependencyMounts: [],
  checks: [{ id: 'readiness', argv: ['node', 'tests/readiness.test.mjs'], timeoutMs: 10000 }],
}, null, 2)}\n`);
await writeFile(join(root, '.pi-agent', 'models.json'), `${JSON.stringify({
  providers: {
    [provider]: {
      api: 'openai-completions',
      baseUrl,
      apiKey: `$${credentialEnv}`,
      models: [{ id: model, reasoning: false, maxTokens: 1024 }],
    },
  },
}, null, 2)}\n`);
NODE
```

The fixture keeps the credential as an environment reference and never creates
its value. Initialize the project, then write a whole-worker local override so
the bounds are in place before any worker start:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" init \
  --worker readiness --provider "$READY_PROVIDER" --model "$READY_MODEL"

node --input-type=module - "$READY_PROJECT" "$READY_PROVIDER" "$READY_MODEL" <<'NODE'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, provider, model] = process.argv.slice(2);
const localConfig = {
  defaultWorker: 'readiness',
  workers: {
    readiness: {
      type: 'pi',
      provider,
      model,
      limits: { timeoutMs: 120000, maxToolCalls: 8, maxCheckRuns: 2 },
    },
  },
};
await writeFile(join(root, '.tinysdd', 'config.local.json'), `${JSON.stringify(localConfig, null, 2)}\n`);
NODE

export PI_CODING_AGENT_DIR="$READY_PROJECT/.pi-agent"
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" \
  config validate --worker readiness --json
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" \
  task add --id readiness --brief .tinysdd/tasks/readiness.md \
  --checks .tinysdd/tasks/readiness.checks.json \
  --allow README.md --protect tests/readiness.test.mjs
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" \
  task approve --id readiness --by OPERATOR --reason 'Authorized the synthetic readiness smoke'
```

The local file replaces the named worker as a whole, so it repeats the exact
provider and model. The effective limits are now a 120-second worker timeout,
eight tool calls and two check runs; inspect the JSON validation result before
starting. For the offline preflight probe, deliberately leave the referenced
credential unset and record the expected, bounded failure:

```sh
set +e
env -u "$READY_CREDENTIAL_ENV" node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" \
  --project "$READY_PROJECT" worker start --task readiness --worker readiness --json \
  >"$READY_PROJECT/preflight.json"
preflight_status=$?
set -e
test "$preflight_status" -eq 1
node --input-type=module - "$READY_PROJECT/preflight.json" <<'NODE'
import { readFile } from 'node:fs/promises';

const result = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (result.error?.code !== 'WORKER_PREFLIGHT_FAILED') {
  throw new Error(`unexpected preflight result: ${result.error?.code ?? 'missing error'}`);
}
if (!result.error.message.includes('TINYSDD_READINESS_KEY')) {
  throw new Error('preflight result did not identify the missing credential variable');
}
NODE
```

This expected failure proves that the selected model entry and environment
reference were read without attempting a model call. It is not a readiness
result. For the later live attempt, an operator must replace the synthetic
provider/model/base URL in both Pi `models.json` and the TinySDD worker route,
then supply the value of `READY_CREDENTIAL_ENV` through an approved process
environment mechanism. Never put that value in a command, task brief, source
file, chat message or retained artifact. After that authorization, start the
same approved task and poll the returned launch:

```sh
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" \
  worker start --task readiness --worker readiness --json
node "$TINYSDD_CHECKOUT/bin/tinysdd.mjs" --project "$READY_PROJECT" \
  worker status --id LAUNCH_ID --json
```

Poll with `worker status --json` until it is finished or the chosen bound
requires `worker stop`. Do not apply or accept the candidate. Inspect the
retained paths named by the result and compare these fields:

- `result.json.outcome` is `completed` and `scopeViolations` is empty.
- `result.json.changedPaths` includes `README.md`; the retained candidate's
  `README.md` is exactly `TINYSDD_READINESS=ready\n` while the source project
  remains unchanged.
- `runtime.json.provider`, `.model`, `.piVersion` and `.sandbox` record the
  configured route, discovered Pi version and selected worker sandbox.
  Node version, platform and architecture come from the discovery commands in
  section 3. A qualification record uses a different facts shape: its
  `qualificationRuntimeFacts` fields are `environment.runtimeVersion`,
  `environment.platform`, `environment.arch`, `model.provider`, `model.id`,
  `worker.settings.sandbox` and `pi.version`; those nested paths are not
  ordinary `runtime.json` paths.
- Treat the recorded route and versions as run identity, not as a
  provider-attested quality result.
- If `runtime.json.runChecks.available` is true, a retained
  `workerObservedChecks.runs` entry shows the `readiness` check with exit code
  zero. If it is false, record its exact `unavailableReason`; macOS normally
  reports that the check runner requires Linux. An unavailable check runner is
  distinct from a failed check.

This smoke observes one authenticated inference path, sandbox startup and a
bounded candidate edit only when the live stage is explicitly authorized and
actually completes. It does not establish model quality, feature correctness,
production suitability, operator acceptance, or a live Linux bubblewrap result
when run elsewhere. Preserve the artifacts for review and redact any
accidental secret before sharing them.

## 8. Failure handling and report shape

Use a short report with one row per capability:

| Capability | Discovery | Observed in smoke | Next action |
| --- | --- | --- | --- |
| CLI source | checkout path and `--version` | command executed | keep checkout pinned or ask for source access |
| Node/Pi layout | executable paths and versions | `runtime.json.piVersion` and `runtime.json.sandbox`; Node/platform from discovery or qualification facts | authorize the pinned package in the exact Node root, or fix the observed target mismatch |
| provider/model | exact configured route and Pi model entry | `runtime.json.provider`/`.model` plus inference result | fix that exact route; no fallback |
| authentication | referenced environment name only | authenticated request or exact rejection | use approved secret mechanism; never expose value |
| worker sandbox | platform binary discovery | runtime sandbox field | ask for supported Linux/macOS host or authorization to install prerequisite |
| `run_checks` | declared and host availability | pass, fail, or unavailable reason | fix the check runner or record platform limitation |

Keep failures distinct. A missing sibling Pi executable, an observed Pi target
version mismatch (the worker records but does not enforce the target), a missing
provider/model entry, missing credential variable, rejected
credential, unsupported platform, unavailable sandbox, failed worker, failed
check and unrun check each require a different next action. Do not summarize
any of them as “Pi is installed” or “the worker is ready.”
