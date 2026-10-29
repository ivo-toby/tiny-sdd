# TinySDD CLI setup

The published `tinysdd` package provides one global onboarding command:

```sh
npm install --global tinysdd
tinysdd setup
```

The reviewed package is published with matching Git version tags. `setup`
refuses an unavailable or version-mismatched release; it never falls back to
`main` or another latest source. The initial tag/account bootstrap and
automatic OIDC-backed releases are described in the [release guide](releases.md).

`tinysdd setup` is global onboarding. Run it from any directory without
`--project`; it does not require or inspect a project. Use
`tinysdd init --project /path/to/project` later for project configuration. The
command performs deterministic metadata checks and installs the matching
skills bundle and the profile registry (`~/.config/tiny-sdd/registry/`) without
changing the current project. After upgrading the CLI, run `tinysdd skills
update` and `tinysdd profiles update`: they replace the installed skills and
registry with the new version's archive, where setup would report a conflict. It does not install Node,
Pi, bubblewrap, a model, or a service;
read a keychain or Pi `auth.json`; select a provider/model; or run inference.

The checks cover Node **>=22.19.0**, the Pi **1.0.0** executable beside the
Node executable running the CLI, and the supported worker sandbox:

| Host | Worker sandbox | Check runner |
| --- | --- | --- |
| Linux | `/usr/bin/bwrap` or `/bin/bwrap`, with a passing startup probe | bubblewrap plus `prlimit` and, for root callers, `setpriv` |
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

### Linux bubblewrap startup failures

On Linux, setup performs a bounded direct `bubblewrap` startup probe after it
finds the executable. The probe uses the worker's user, PID and network namespace flags,
core read-only system mounts, temporary `/tmp` and `/home` mounts, disposable
`/work` and `/pi-state` bind mounts, and the trusted no-op `/usr/bin/true`. It
does not invoke a shell, model, network request, Pi, or check runner. Setup
passes only a small fixed environment (`HOME`, `PATH`, and `LC_ALL`) and bounds
captured output. A passing probe establishes only that this startup shape works;
it does not authenticate a provider, run inference, or qualify every worker or
check-runner path.

If `bwrap` exists but the probe fails, setup keeps installing the skills and
reports the worker as not ready. The JSON result distinguishes a nonzero exit
with stderr, a silent nonzero exit, a launch error, and a timeout. It includes a
copyable reproduction command, for example:

```sh
/usr/bin/bwrap --die-with-parent --unshare-user --unshare-pid --unshare-net \
  --dev /dev --tmpfs /tmp --tmpfs /home --dir /etc \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --dir /work --dir /pi-state \
  --chdir /work --setenv HOME /home --setenv PATH /usr/bin:/bin \
  /usr/bin/true
```

Run the emitted command from the same host or container boundary as
`tinysdd setup`, then collect only the small, non-secret diagnostics that setup
uses when available:

```sh
cat /proc/self/uid_map
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true
```

These values are clues, not a diagnosis. A generic exit status or empty stderr
does not identify the policy that blocked startup. Ask the administrator who
controls that boundary to inspect the host's user-namespace, mount, and
AppArmor/audit policy and rerun the reproduction command after an approved
change. Ubuntu documents the unprivileged user-namespace restriction and
purpose-built AppArmor profiles for applications such as bubblewrap in its
[AppArmor guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
and [user-namespace restriction guide](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007).

If TinySDD runs inside a container, check the outer host and the container
runtime configuration. On an Incus host, an administrator can inspect the
container's nesting setting with this read-only command:

```sh
incus config get <container-name> security.nesting
```

Incus's `security.nesting=true` is documented for specific nested-container
cases such as Docker; it is not a universal fix for every VM or container.
Review the outer host's user-namespace and AppArmor policy as well, then rerun
the emitted probe command and `tinysdd setup` after any approved change. See
the [Incus FAQ](https://linuxcontainers.org/incus/docs/main/faq/) and the
[bubblewrap project documentation](https://github.com/containers/bubblewrap)
for the relevant environment. TinySDD does not write sysctls, AppArmor rules,
container settings, packages, or services, and it does not provide an
unsandboxed fallback.

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

Dotfiles-managed layouts are supported: `setup` and `skills update` resolve a
symlinked `~/.agents`, `~/.agents/skills`, `~/.claude/skills` or
`~/.agents/tinysdd` to its real directory, run the same conflict checks there,
and install into the resolved path (for example a GNU stow package holding
`~/.claude/skills`). The skill links above are then created inside the resolved
directory and point at the resolved bundle root. Symlinks inside the managed
bundle tree, and skill entries that are not links or point elsewhere, remain
conflicts.

After setup, start a fresh Claude or Codex session in the intended project so
it rescans the global skill directory. Invoke `/tinysdd-setup` in Claude or
`$tinysdd-setup` in Codex; the installed setup skill guides project/model setup
and your first worker trial. Load `/tinysdd` or `$tinysdd` for the product
workflow. Claude and Codex are the supported global registrations; other
harness discovery is not claimed.

For the worker route, exact Pi provider/model configuration and the
environment-referenced credential boundary, see
[the quickstart](quickstart.md) and the [setup skill](../skills/tinysdd/assets/setup/SKILL.md).
