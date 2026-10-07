# TinySDD CLI setup

The published `tinysdd` package provides one global onboarding command:

```sh
npm install --global tinysdd
tinysdd setup
```

The package metadata is prepared in this repository, but the current checkout
has no npm publication or Git version tag. An operator must publish a reviewed
version and create the matching `v<version>` tag before
the command can download its archive. `setup` refuses an unavailable or
version-mismatched release; it never falls back to `main` or another latest
source.

`tinysdd setup` is global onboarding. Run it from any directory without
`--project`; it does not require or inspect a project. Use
`tinysdd init --project /path/to/project` later for project configuration. The
command performs deterministic metadata checks and installs the matching
skills bundle without changing the current project. It does not install Node,
Pi, bubblewrap, a model, or a service;
read a keychain or Pi `auth.json`; select a provider/model; or run inference.

The checks cover Node **>=22.19.0**, the Pi **1.0.0** executable beside the
Node executable running the CLI, and the supported worker sandbox:

| Host | Worker sandbox | Check runner |
| --- | --- | --- |
| Linux | `/usr/bin/bwrap` or `/bin/bwrap` | bubblewrap plus `prlimit` and, for root callers, `setpriv` |
| macOS | `/usr/bin/sandbox-exec` | unavailable; `run_checks` is Linux-only |

Setup does not install any of these prerequisites. For Node, use the [official
Node downloads](https://nodejs.org/en/download) and rerun `tinysdd setup` with
that Node executable. For Pi, install the exact package into the `bin/`
directory belonging to the selected Node installation, then verify the
supported layout:

```sh
NODE_BIN_DIR="$(node -p 'require("node:path").dirname(process.execPath)')"
NODE_ROOT="$(node -p 'require("node:path").dirname(require("node:path").dirname(process.execPath))')"
"$NODE_BIN_DIR/npm" install --global --prefix "$NODE_ROOT" \
  '@earendil-works/pi-coding-agent@1.0.0'
```

For Linux check-runner support, Debian/Ubuntu operators can install
`bubblewrap` and `util-linux` (`prlimit` and `setpriv`) with
`sudo apt install bubblewrap util-linux`; Fedora operators can use
`sudo dnf install bubblewrap util-linux`. The [bubblewrap project
documentation](https://github.com/containers/bubblewrap) and the
[util-linux manual](https://man7.org/linux/man-pages/man1/prlimit.1.html)
describe those host tools. macOS `sandbox-exec` is an operating-system
facility; TinySDD reports `run_checks` as unavailable there while the worker
Seatbelt path can remain supported.

Pi is reported separately from TinySDD model configuration. A missing Pi
executable is a missing runtime. An installed Pi with no readable
`models.json`, no provider/model entries, or malformed entries is an installed
runtime with no explicit TinySDD-usable configuration. Pi interactive built-in
models may still exist in the latter case. Model metadata discovery only checks
that TinySDD can resolve an explicit provider and model; it does not prove
credential availability, authentication, server identity, or inference.

To configure an explicit model without exposing credentials, create or edit
the selected Pi `models.json` (by default
`~/.config/pi/agent/models.json`, or under `PI_CODING_AGENT_DIR`) with the
provider, endpoint and model id chosen by the operator. A minimal metadata
shape is:

```json
{
  "providers": {
    "provider-id": {
      "api": "openai-completions",
      "baseUrl": "https://provider.example/v1",
      "models": [{ "id": "model-id" }]
    }
  }
}
```

Use the [setup workflow reference](../skills/tinysdd/assets/setup/references/setup-workflow.md)
for the exact Pi layout and provider/model boundary. Keep API keys and other
credential values in the environment references used by Pi; setup does not
read or validate them.

The versioned archive contains the complete `skills/` and `docs/` resource
tree. TinySDD installs the bundle under `~/.agents/tinysdd`, then creates these
relative skill links:

```text
~/.agents/skills/tinysdd       -> ../tinysdd/skills/tinysdd
~/.agents/skills/tinysdd-setup -> ../tinysdd/skills/tinysdd/assets/setup
~/.claude/skills/tinysdd       -> ../../.agents/tinysdd/skills/tinysdd
~/.claude/skills/tinysdd-setup -> ../../.agents/tinysdd/skills/tinysdd/assets/setup
```

The bundle root is intentional: product and phase skills contain relative
links to sibling `docs/`, `assets/`, `references/` and `templates/` files.
Existing agent configuration and unrelated skill entries remain untouched.
Repeated setup with identical release bytes is a no-op. A differing existing
managed path or link is a conflict and stops setup rather than overwriting it.

After setup, start a fresh Claude or Codex session so it rescans the global
skill directory, then invoke `/tinysdd-setup` in Claude or `$tinysdd-setup` in
Codex. Load `/tinysdd` or `$tinysdd` for the product workflow. Claude and
Codex are the supported global registrations; other harness discovery is not
claimed.

For the worker route, exact Pi provider/model configuration and the
environment-referenced credential boundary, see
[the quickstart](quickstart.md) and the [setup skill](../skills/tinysdd/assets/setup/SKILL.md).
