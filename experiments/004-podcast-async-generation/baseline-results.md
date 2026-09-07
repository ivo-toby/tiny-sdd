# Baseline execution result

Target: `/home/ivo/workspace/mcp-podcast-generator`

Status: **baseline passed in the primary agent's isolated execution context**.
The final complete `npm test` run passed all 181 tests across all 10 files,
exit 0, in 8.12 seconds. It used private mounts **and** a private network
namespace. Build and no-output typecheck also passed as recorded below.
No target source, tests, user documents, dependencies or configuration changed.

Earlier delegated-context failures are retained below; they were not repository
defects or proof that the primary agent lacked the same capabilities. Network
namespace creation and loopback listening both succeeded in direct primary
execution. Do not generalize permissions from one agent execution context to
another.

## Final primary-agent verification

On 2026-09-05, after the delegated attempts below, the primary directly repeated
the exact capability probe under “Capability probe”: exit 0, including
`--unshare-net`. It then ran the full “Sandboxed baseline command” below with
one additional option, `--unshare-net`, immediately after `--unshare-user`.
All other mounts, environment options and the final `npm test` command were
unchanged. Observed terminal output:

```text
Test Files  10 passed (10)
     Tests  181 passed (181)
  Start at  20:37:10
  Duration  8.12s
```

Process exit: 0. This is one complete green execution, not a sum of partial
runs. The download tests exercised real ephemeral loopback HTTP inside the
private network namespace. Remote-provider calls remained mocked; output logs
from those mocked paths are not evidence of actual TTS/storage/media calls.
The private `/tmp` contained the fixed-path fixtures; source/tests/dependencies
were read-only mounts, caches and all output were private. Target Git status
remained the same three untracked documents after this run.

The direct primary no-output compiler check used:

```text
env -i PATH=/home/ivo/.local/share/mise/installs/node/24.15.0/bin:/usr/bin:/bin NODE_ENV=test ./node_modules/.bin/tsc --noEmit
```

Working directory: the target repository. Exit 0, no diagnostics. The separate
sandboxed build success is recorded below. These checks establish the original
repository baseline only, not the new async feature or MCP integration.

## Earlier delegated-context observations (superseded baseline status)

## Capability probe

Executable discovered at `/usr/bin/bwrap`. Exact probe attempted:

```text
bwrap --unshare-user --unshare-net --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true
```

Observed result: Bubblewrap aborted before `/usr/bin/true` with:

```text
bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted
```

This was a permission failure in the delegated execution context, not a
repository or dependency failure. A narrower mount-only probe succeeded (exit 0):

```text
bwrap --unshare-user --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true
```

The private `/tmp` and `/work` mounts were therefore usable, but they do not
imply network isolation. A separate trivial Node loopback probe inside the
user namespace failed with `listen EPERM: operation not permitted
127.0.0.1`; a later host-shaped attempt in that same agent context also failed.
This does not establish that user namespaces caused the denial. Changing
`TMPDIR` or using a disposable repository
directory alone would not contain the existing tests' hard-coded absolute
`/tmp` writes.

## Sandboxed baseline command

The final test invocation used this exact Bubblewrap command. It bind-mounted
only the audited source/test/package/config inputs read-only into a private
`/work`, mounted private `/tmp` and cache paths, and did not bind the target
repository root or `.env`:

```text
bwrap --unshare-user --die-with-parent \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin --ro-bind /etc /etc --proc /proc --dev /dev \
  --tmpfs /tmp --tmpfs /home --tmpfs /work --dir /home/sandbox \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/src /work/src \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/tests /work/tests \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/node_modules /work/node_modules \
  --tmpfs /work/node_modules/.vite \
  --tmpfs /work/node_modules/.vite-temp \
  --tmpfs /work/node_modules/.cache \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/package.json /work/package.json \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/package-lock.json /work/package-lock.json \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/tsconfig.json /work/tsconfig.json \
  --ro-bind /home/ivo/workspace/mcp-podcast-generator/vitest.config.ts /work/vitest.config.ts \
  --ro-bind /home/ivo/.local/share/mise/installs/node/24.15.0 /opt/node \
  --chdir /work --clearenv \
  --setenv HOME /home/sandbox \
  --setenv PATH /opt/node/bin:/usr/bin:/bin \
  --setenv NODE_ENV test --setenv TMPDIR /tmp \
  --setenv NPM_CONFIG_CACHE /tmp/npm-cache \
  --setenv NPM_CONFIG_UPDATE_NOTIFIER false \
  --setenv NPM_CONFIG_FUND false --setenv NPM_CONFIG_AUDIT false \
  /opt/node/bin/npm test
```

The test process exited `1`. Vitest reported `9 passed` files, `1 failed`
(`tests/utils/download.test.ts`), with `174 passed` and `7 failed` tests out
of `181`; duration was `40.89s`. All seven failures timed out at 5000 ms while
`startServer()` could not bind `127.0.0.1` under the unprivileged user
namespace. The other nine files passed. This is an environment-blocked suite,
not a target-code repair or a complete baseline pass.

The first trial of the same mount layout without the read-only `/etc` bind
stopped at Vitest startup with `getaddrinfo EAI_AGAIN localhost`; it is setup
failure evidence only. The final command above included `/etc` and reached the
test files.

## Sandboxed build command

The build used the same mount and environment layout, replacing the final
command with `/opt/node/bin/npm run build`:

```text
/opt/node/bin/npm run build
```

It exited `0` with the expected npm header and no compiler diagnostics. Its
`dist/` output was created only in private `/work` and was discarded with the
sandbox; the target `dist/` was not mounted writable.

The primary/root's earlier credential-cleared `tsc --noEmit` check also exited
`0`; it was not repeated in this run.

## Preservation check

After both sandbox invocations, the target was checked read-only. All ten
SHA-256 values in `baseline-inventory.md` matched exactly. Target Git status
also remained exactly:

```text
?? docs/SPEC-async-generation-publishing.md
?? docs/implementation-plan-async-jobs.md
?? docs/research-async-mcp-jobs.md
```

No target file, user document, dependency, or configuration changed. This earlier
delegated run must not be cited as network-isolated or green. The later primary
run above supplies the complete isolated baseline; neither is a production or
new MCP/server acceptance check.

## Host-only download-test attempt

Per the bounded follow-up, only the audited `tests/utils/download.test.ts` was
copied into a disposable fixture at `/tmp/podcast-download-host.ra8lbV`.
The fixture contained copies of `src/utils/download.ts`,
`src/utils/logger.ts`, the test, `vitest.config.ts`, and `package.json`; its
`node_modules/vitest` was a symlink to the existing target dependency. The
fixture had private `HOME` and `TMPDIR` directories, so test files and Vitest
cache state stayed outside the target. No target source, test, dependency,
credential, or configuration was written.

Exact invocation (host execution, no Bubblewrap):

```text
env -i PATH=/home/ivo/.local/share/mise/installs/node/24.15.0/bin:/usr/bin:/bin \
  HOME=/tmp/podcast-download-host.ra8lbV/home \
  TMPDIR=/tmp/podcast-download-host.ra8lbV/tmp NODE_ENV=test \
  /home/ivo/workspace/mcp-podcast-generator/node_modules/.bin/vitest run \
  --no-cache --root /tmp/podcast-download-host.ra8lbV \
  --config /tmp/podcast-download-host.ra8lbV/vitest.config.ts \
  tests/utils/download.test.ts
```

In this agent's managed execution sandbox the command exited `1`: one file,
seven tests, and seven failures. Each test timed out at 5000 ms while its
local HTTP server attempted to bind. A matching credential-cleared Node
loopback probe reported `listen EPERM: operation not permitted
127.0.0.1`. Therefore this is another environment-blocked observation, not a
host-green result. The parent separately observed a successful ordinary-host
loopback probe; that capability was not available in this execution context,
so the host-only suite could not be completed here.

This attempt is deliberately separate from the private-namespace result:
`174 passed + 7 failed` and this `0 passed + 7 failed` are not a single
181-test baseline execution and must not be combined into a green-suite claim.
