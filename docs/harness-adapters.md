# TinySDD foreign harness adapters

Issue #31 adds a host-managed capture boundary for operator-selected
consumers of an approved slice bundle:

- Claude Code can prepare a slice with the frontier skill and implement it with
  the explicit small-model subagent template.
- OpenCode can run the `tinysdd` skill in the operator's session and delegate
  the slice to a native OpenCode subagent pinned to an explicit small model
  (issue #153).
- Interactive Pi can consume the same packet in a begin-owned candidate with an
  operator-selected local provider and model.

Not sure whether a harness is the right tool? See
[Harness or sandboxed worker?](#harness-or-sandboxed-worker) first.

The capture module does not run any harness. It begins with the current
ready task approval, copies the source using the native worker's bounded
git-aware rules, retains the exact packet and bundle bytes, and returns a new
candidate outside the source project. Finalization reads only that candidate,
checks the source, bundle, baseline, session, and alias identities, and writes
the normal `result.json` evidence under `.tinysdd/runs/worker-*`.

## Harness or sandboxed worker?

Use the sandboxed worker (`tinysdd worker run` with a configured worker runtime)
for packet-ready slices, for batches, and for anything that should not spend
frontier tokens during implementation. There the frontier model only prepares
the packet; the small model implements inside the worker sandbox.

Use a harness (Claude Code, OpenCode, or interactive Pi) when the operator wants
to steer the implementation interactively, is trying a model before
qualification, or has no worker runtime or sandbox available. In the Claude
Code and OpenCode flows the frontier parent session stays in the loop while
the subagent works, so it keeps spending frontier tokens. None of the harness
flows add an OS sandbox; the session runs with the operator's credentials and
network.

Both paths end in the same place: a retained candidate that goes through
`task apply` and explicit `task review`. Neither produces verification or
acceptance evidence on its own.

## Prepare and begin

Use a canonical directory outside the source project for the bundle and
candidate parent. The paths below are literal placeholders; replace them with
the paths selected by the operator. The command does not execute a harness:

```text
node /absolute/tiny-sdd/scripts/export-slice.mjs \
  --project /absolute/project \
  --change changes/feature/change.json \
  --slice feature-s1 \
  --out /absolute/canonical/adapter-runs/feature-s1-bundle \
  --json

node /absolute/tiny-sdd/scripts/harness-adapter.mjs begin \
  --project /absolute/project \
  --bundle /absolute/canonical/adapter-runs/feature-s1-bundle \
  --harness claude-code \
  --model haiku \
  --candidate-parent /absolute/canonical/adapter-runs \
  --json
```

Use `--harness claude-code`, `--harness opencode`, or `--harness pi`; the value
is recorded as caller-declared metadata in `runtime.json`, `capture.json`, and
`result.json` and does not change capture or finalize behavior.

Record the returned `runId`, `candidatePath`, and `artifactDir`. The model
value is caller-declared. A requested Claude model can be overridden by a
session or provider policy; this capture implementation leaves `observedId` as
`UNKNOWN`, so a live operator must confirm the resolved model and stop on a
mismatch. There is no model or provider fallback.

The begin operation retains the exact packet at `artifactDir/packet.json` and
the complete bundle under `artifactDir/bundle/`. It does not rewrite
`.tinysdd/runs/controller.json`, approvals, task inputs, or the source project.
The candidate is disposable and owned by this run. Do not move it, replace it,
or place credentials in it.

## Claude Code

The project-local templates are in
`skills/tinysdd/assets/harness/claude/`. The `tinysdd-frontier` skill describes
how a frontier session prepares and approves a normal TinySDD packet. The
`tinysdd-slice-worker.md` file is a Claude subagent definition with `Read`,
`Write`, and `Edit` in its `tools` field and an explicit `haiku` model value.
Use a fresh, run-owned adapter parent outside both the source project and
returned candidate. After inspecting the template and choosing the exact
small-model value, create
`<adapter-parent>/.claude/agents/tinysdd-slice-worker.md` exclusively, then
start Claude from the returned candidate below that parent. An explicit
per-session agent definition option with the template bytes is also safe. Never
create the definition inside the captured candidate, overwrite an existing
`.claude`/`.pi` file, or change global Claude configuration as part of a run.

Claude's `tools` field restricts the subagent's available tools. A skill's
`allowed-tools` field only preapproves tools; it is not an isolation boundary.
The template therefore keeps the implementation subagent free of command,
shell, network, and package-manager tools. It reports unrun checks and does not
claim verification or acceptance. Use the parent conversation to ask for
missing facts. Do not route this Claude subagent through the configured Pi
worker.

For a per-session definition, pass the template body through `--agents` and
ask the frontier session to delegate to the named worker. `--agent` selects the
main session agent, so it is intentionally omitted here. This keeps the
definition out of the candidate and does not overwrite Claude configuration.
The argument array below reads the reviewed template, removes only its
frontmatter, and passes the resulting definition and exact retained inputs
without shell interpolation:

```js
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const templatePath = '/absolute/tiny-sdd/skills/tinysdd/assets/harness/claude/tinysdd-slice-worker.md';
const template = await readFile(templatePath, 'utf8');
const prompt = template.replace(/^---\n[\s\S]*?\n---\n/u, '');
const artifactDir = '/absolute/project/.tinysdd/runs/worker-harness-id';
const candidatePath = '/absolute/canonical/adapter-runs/worker-candidate';
const agents = JSON.stringify({
  'tinysdd-slice-worker': {
    description: 'Implements one approved TinySDD slice using only file tools.',
    prompt,
    tools: ['Read', 'Write', 'Edit'],
    model: 'haiku',
  },
});
spawn('claude', [
  '--agents', agents,
  '--model', 'operator-selected-frontier-model',
  '--tools', 'Read,Write,Edit,Agent',
  [
    `Read the exact approved packet at ${artifactDir}/packet.json.`,
    `Read ${artifactDir}/bundle/brief.md, ${artifactDir}/bundle/compiled-context.md when present, and ${artifactDir}/bundle/checks.json.`,
    `Use the Agent tool to delegate implementation to tinysdd-slice-worker in ${candidatePath}.`,
    'Do not edit packet, context, checks, preparation, protected, or controller files; report unrun checks.',
  ].join('\n'),
], { cwd: candidatePath, stdio: 'inherit' });
```

Replace the literal paths and parent model with the values selected by the
operator. The frontier model is the main session choice; the delegated worker
model remains the explicit `haiku` value in the definition. Start Claude in the
returned candidate directory, inspect the retained inputs, and invoke the named
subagent after the operator has approved the paths. Keep the requested worker
model and the observed model identity separate in the host capture; this
implementation records the latter as `UNKNOWN`, so the operator must confirm it
outside this result. `allowedPaths` are
expected planning paths; ordinary create/modify extras remain eligible and are
reported for host and reviewer inspection. Deletions, filesystem type changes,
protected paths, preparation inputs, and task inputs remain blocked.

## Interactive Pi

The Pi consumer skill is
`skills/tinysdd/assets/harness/pi/tinysdd-interactive-slice/SKILL.md`. Pi's
explicit CLI flags make the local model and tool surface visible. The following
JavaScript uses an argument array, so model names, paths, and packet content are
never interpolated into a shell command:

```js
import { spawn } from 'node:child_process';

const args = [
  '--no-skills',
  '--skill', '/absolute/tiny-sdd/skills/tinysdd/assets/harness/pi/tinysdd-interactive-slice/SKILL.md',
  '--no-extensions',
  '--tools', 'read,write,edit',
  '--provider', 'local-provider',
  '--model', 'local-provider/model-id',
  '--session', '/absolute/canonical/adapter-runs/worker-session.jsonl',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/packet.json',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/compiled-context.md',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/checks.json',
];

spawn('pi', args, { cwd: '/absolute/canonical/adapter-runs/worker-candidate', stdio: 'inherit' });
```

Use the retained filenames listed by `bundle.json`; the paths above are the
exporter's standard `packet.json`, `compiled-context.md`, and `checks.json`
names. If a valid bundle has no compiled context, omit that `@...` argument.
Do not pass source preparation or controller files from the candidate. Pi's
`allowedPaths` are expected planning paths; ordinary create/modify extras remain
eligible and are reported for host and reviewer inspection. Deletions,
filesystem type changes, protected paths, preparation inputs, and task inputs
remain blocked.

Replace every example path and identity with the values returned by `begin`.
Use an explicit `--provider` and matching `--model`; Pi requires the provider
flag to be paired with a model. `--no-skills` still permits the explicit skill
passed with `--skill`, and `--no-extensions` disables discovered, configured,
and built-in extensions. The skill's prompt restrictions do not promise OS
isolation, credential protection, check execution, or observed model identity.

## OpenCode

The templates are in `skills/tinysdd/assets/harness/opencode/`:
`tinysdd-slice-worker.md` defines the subagent, and `parent-opencode.json`
sets the run-owned permissions for the parent session.
The facts below come from reading the OpenCode 2.1.4 source at sst/opencode
commit `20a6cc72917586eb5314be075f96dbb21d16c480`. They were not observed in a
live OpenCode session.

The template is an OpenCode agent file. OpenCode loads agent files from
`{agent,agents}/**/*.md` under each config directory and names the agent after
the file path, so this file defines `tinysdd-slice-worker`. Its frontmatter sets
`mode: subagent`, an explicit `model`, a `steps` cap, and an ordered
`permissions` ruleset. The markdown body becomes the agent's `system` prompt.
The `model` value `local-provider/model-id` is a placeholder in OpenCode's
`provider/model` form (optionally `provider/model#variant`); replace it with the
exact small model before installing the file. TinySDD never picks it for you.

### Permissions

Each OpenCode permission rule is `{ action, resource, effect }`, with `effect`
one of `allow`, `deny`, or `ask`. `*` and `?` are wildcards in both `action` and
`resource`. The last matching rule wins, and a request that matches no rule
asks. A tool is removed from the agent's tool list when the last rule matching
its permission name has `resource: "*"` and `effect: "deny"`. Deny rules are
checked before saved "always" approvals and before plugin permission hooks, so
those cannot turn a deny into an allow. The `--auto` and `--yolo` CLI flags only
answer `ask` requests; they do not override a deny. Rules from global config
`permissions` are placed before the agent's own rules.

OpenCode's default agent rules start with `{ action: "*", resource: "*",
effect: "allow" }`. An agent or session with no extra rules therefore does
not ask before shell commands, edits, or reads outside its directory.

The subagent template starts with `{ action: "*", resource: "*", effect:
"deny" }`. It then allows only `read` and `edit`, and denies `.env`/`.env.*`
paths and OpenCode configuration again (see **Configuration writes** below).
In this OpenCode version that leaves:

| Tool | Result |
| --- | --- |
| `read`, `write`, `edit` | available inside the candidate |
| `patch` | available; see the caveat below |
| `shell`, `glob`, `grep`, `webfetch`, `websearch`, `subagent`, `skill`, `question`, `todowrite` | removed |
| CodeMode `execute`, with the `opencode_*` and MCP tools it exposes | removed |
| Any path outside the candidate (`external_directory`) | denied |

**`patch` cannot be denied separately.** The `write`, `edit`, and `patch` tools
all check the same `edit` permission, so no rule can allow `write` and `edit`
while denying `patch`. `patch` can also delete and move files. The system
prompt tells the model not to use it. If it does, finalize still reports
deletions and type changes as scope violations, and a move shows up as a
deletion plus an extra path. This is a gap in what OpenCode permissions can
express, not something the template fixes.

**Configuration writes.** OpenCode loads `.opencode/`, `.claude/`, `.agents/`,
`opencode.json`, and `opencode.jsonc` from its start directory, which is the
candidate, and reloads agent definitions when they change. A blanket `edit`
allow would let the subagent write a candidate-local definition whose rules are
appended after the original ones and can re-enable shell or external access or
change the model. Both templates therefore deny `edit` on `.*` (every
top-level dot path, in any letter case), on `opencode.json` and
`opencode.jsonc`, and on `????????.json` and `????????.jsonc`, which also
covers stem-case variants such as `OpenCode.json`. Side effects and limits:

- slices cannot edit top-level dot files such as `.gitignore` or anything
  under `.github/`;
- the `????????.json(c)` rules also deny other paths of that exact length,
  such as `src/data.json`;
- OpenCode wildcards have no character classes and are case-sensitive outside
  Windows, so an all-caps extension such as `OpenCode.JSON` is not denied. On a
  case-insensitive filesystem (default macOS APFS) OpenCode would still load
  it. Use a case-sensitive volume for the adapter parent, or check
  `opencode debug config` from the candidate after the subagent returns;
- the rules match the path the tool reports, relative to the candidate. They do
  not follow symlinks that already exist in the candidate.

TinySDD finalize reports these paths as ordinary extras; it does not block
them. Inspect every reported extra before `task apply`.

The deny-all rule overrides broader global `permissions` (for example a global
`shell` allow). The template's later `read` and `edit` allows also override any
narrower global `read` or `edit` denies. Add those denies to your copy of the
template if you need them.

### Install the definitions

Use a fresh, run-owned adapter parent outside both the source project and the
returned candidate, and pass it to `begin` as `--candidate-parent`. After
choosing the exact model, create both files exclusively (for example with
`writeFile(path, bytes, { flag: 'wx' })`):

- `<adapter-parent>/.opencode/agents/tinysdd-slice-worker.md` from
  `tinysdd-slice-worker.md`;
- `<adapter-parent>/.opencode/opencode.json` from `parent-opencode.json`.

The parent config's `permissions` apply to every agent and come after the
default agent's `*` allow. For the parent session they make
`external_directory` and `shell` ask. They allow `subagent` only for
`tinysdd-slice-worker`, so the parent cannot delegate to built-in subagents
such as `explore`, whose own rules allow shell and external access. They also deny the same configuration
writes as the subagent. For the subagent they come before its own rules, which
still decide.

Never create either file inside the candidate. Never overwrite an existing `.opencode`
directory file, `opencode.json`/`opencode.jsonc`, or global OpenCode config as
part of a run. Do not use `OPENCODE_CONFIG_DIR` for this: it replaces the
global config directory instead of adding one.

OpenCode looks for `.opencode` directories in its start directory and every
ancestor up to the filesystem root. Starting it in the candidate therefore
loads the adapter parent's definition, and it also loads any `.opencode`
config in the adapter parent's own ancestors. From the candidate, check
`opencode debug config` and `opencode debug agents` before delegating, and stop
if unexpected sources or agents appear.

### Run, delegate, and confirm the model

Start `opencode` from the returned candidate directory with the operator's
chosen frontier model as the parent. The parent loads the `tinysdd` skill,
reads `artifactDir/packet.json`, `artifactDir/bundle/compiled-context.md` when
present, and `artifactDir/bundle/checks.json`. Those files are outside the
candidate. With `parent-opencode.json` installed, OpenCode asks the operator to
approve that `external_directory` access and any shell command. Without it,
the default rules allow both silently. Approve only the retained input reads.
Do not start the parent with `--auto`, `--yolo`, or
`--dangerously-skip-permissions`, which approve every `ask` for the parent
session, including shell commands. Before delegating, confirm from
`opencode debug config` that the adapter parent's `opencode.json` is a loaded
source.

The parent then calls the `subagent` tool with `agent: "tinysdd-slice-worker"`.
Because the subagent cannot read outside the candidate, the delegation prompt
must contain the exact packet and compiled context text. It must not pass a
`model` argument.

Caveats:

- **No OS sandbox.** The session runs with the operator's credentials and
  network. OpenCode permissions are policy inside OpenCode, not isolation.
  Configured plugins and local MCP server processes are ordinary code that
  these rules do not confine.
- **Model override.** The subagent tool picks the child model in this order:
  an explicit `model` argument from the parent, then the agent's `model`, then
  the parent's model. A parent can therefore override the small model. The
  captured observed model stays `UNKNOWN`. Before finalizing, the operator must
  confirm the model that actually ran, for example from
  `opencode session export <child-session-id>` (the subagent result shows the
  child `sessionID`), and stop on a mismatch.
- **Skills.** Besides config `skill`/`skills` directories, OpenCode discovers
  skills under `~/.agents/skills` and `~/.claude/skills`, which is where
  `tinysdd setup` already installs `tinysdd`. It also reads `.agents/skills`
  and `.claude/skills` in the start directory and its ancestors. Setting
  `OPENCODE_DISABLE_CLAUDE_CODE` (or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`)
  disables the `.claude` roots; the `~/.agents` copy still loads. The template
  denies the `skill` tool, so the subagent cannot load skills itself.
- **Nesting.** OpenCode allows one level of subagents by default
  (`experimental.subagent_depth`), and the template denies `subagent` anyway.

Finalization is the same as for the other harnesses; the `opencode` harness
value recorded at begin carries through to `result.json`.

## Finalize, apply, and review

After the operator declares the session complete or interrupted, finalize with
an explicit boolean. A completion declaration is caller metadata, not evidence:

```text
node /absolute/tiny-sdd/scripts/harness-adapter.mjs finalize \
  --project /absolute/project \
  --run worker-harness-id \
  --completed true \
  --claim 'Unverified foreign-harness completion claim.' \
  --json
```

Use `--completed false` for an interrupted or failed session. Such a result is
retained for inspection and cannot be applied. Finalization never runs checks,
arbitrary commands, a model, or a service; existing fixed `git ls-files`
inventory may run during the bounded source copy. Usage, sandbox behavior,
process termination, and observed model identity remain `UNKNOWN` in this
implementation; foreign output is never verification evidence. `runtime.json`
records the begin-time session as open; finalization records the caller's
completion declaration separately and does not infer process termination.

Route a completed, scope-clean result through the ordinary controller path:

```text
node /absolute/tiny-sdd/bin/tinysdd.mjs --project /absolute/project \
  task apply --id feature-s1 --run worker-harness-id --by operator
node /absolute/tiny-sdd/bin/tinysdd.mjs --project /absolute/project \
  task review --id feature-s1 --verdict accepted \
  --by reviewer --evidence .tinysdd/reviews/feature-s1.md
```

Reapproval, source drift, changed bundle bytes, changed baseline or alias
behavior, candidate relocation, symlinks, deletions, type changes, protected or
input edits, and dependency mounts remain visible blockers. The adapter never
adds an approval override, verification shortcut, acceptance event, or
qualification claim.

The offline fixtures cover one synthetic Talon-style packet for each adapter
(`claude-code`, `opencode`, and `pi`), an ordinary edit plus ordinary extra,
normal apply, and explicit fixture review. Real Claude Code, OpenCode, and Pi
model execution, Talon implementation, OS isolation, and operator acceptance
remain unverified. `Refs #31`, `Refs #153`.

Primary references checked for the templates and recipes:

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Pi CLI](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/cli.md)
- [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
- [OpenCode source](https://github.com/sst/opencode/tree/20a6cc72917586eb5314be075f96dbb21d16c480) (`packages/core/src/config/plugin/agent.ts`, `packages/core/src/permission.ts`, `packages/core/src/tool.ts`, `packages/core/src/tool/plugin/subagent.ts`, `packages/core/src/config/discovery.ts`)
